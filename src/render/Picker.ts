/**
 * 单体级 GPU picking
 *
 * 思路：把「物体编号 + batchId」编码成 RGBA 渲染到离屏目标，点击时读那一个像素。
 * 相比射线求交，代价与三角面数无关——30 万面和 3 千面一样快，且天然只命中
 * 最前面的可见面（深度测试在 GPU 上完成了）。
 *
 * 编码约定（每个通道一个字节）：
 *   R,G = 物体编号 + 1
 *   B,A = batchId + 1        （+1 是为了让「什么都没点到」全 0）
 *
 * 渲染目标只有 size×size 个像素，靠平移 viewport 把「点击点那一格」挪到目标里：
 * viewport 原点设成 (0 - px, 0 - (h-1-py))、尺寸仍是整块画布，于是光栅化结果和全屏
 * 那一趟逐像素一致，只是只有一个像素落在目标上。原来那句「每次点击全屏渲染一趟」
 * 的代价（移动端尤其明显）就没了。
 */
import * as THREE from 'three';

const PICK_VERT = /* glsl */ `
  attribute float aBatchId;
  #ifdef USE_INSTANCING
    // 实例化：单体粒度在实例上，顶点属性里没有可用的 batchId
    attribute float aInstanceBatchId;
    attribute float aInstanceIndex;
  #endif
  uniform float uObjectId;
  uniform sampler2D uBatchTex;
  uniform float uBatchTexWidth;
  uniform int uBatchTexActive;
  uniform float uSelBatch;
  uniform float uSelWhole;
  uniform float uSelElevation;
  varying float vBatch;

  void main() {
    float s3mBatch;
    #ifdef USE_INSTANCING
      s3mBatch = aInstanceBatchId;
      // 编码「实例序号」而不是控制位：CPU 侧要靠它拿到实例矩阵（描边 / 中心点）
      vBatch = aInstanceIndex;
    #else
      s3mBatch = aBatchId;
      vBatch = aBatchId;
    #endif

    // 单体状态（抬高 / 隐藏）必须和主着色器用同一份数据、同一套算法：
    // 抬高只发生在顶点着色器里，拾取这一趟如果还按原始坐标画，抬起来的楼就点不中。
    vec3 p = position;
    if ( uBatchTexActive > 0 && s3mBatch >= 0.0 ) {
      vec4 state = texture2D( uBatchTex, vec2( ( s3mBatch + 0.5 ) / uBatchTexWidth, 0.5 ) );
      if ( state.a < -0.5 ) {
        p = vec3( 0.0 );
      } else if ( state.a > 0.0 ) {
        p.z += state.a;
      }
    }

    // 选中单体自身的拔高（selectElevation）
    float sel = max( step( 0.0, uSelBatch ) * step( abs( s3mBatch - uSelBatch ), 0.5 ), uSelWhole );
    p.z += sel * uSelElevation;

    #ifdef USE_INSTANCING
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( p, 1.0 );
    #else
      gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
    #endif
  }
`;

const PICK_FRAG = /* glsl */ `
  uniform float uObjectId;
  varying float vBatch;
  void main() {
    float o = uObjectId + 1.0;
    float b = vBatch + 1.0;
    gl_FragColor = vec4(
      mod( o, 256.0 ) / 255.0,
      floor( o / 256.0 ) / 255.0,
      mod( b, 256.0 ) / 255.0,
      floor( b / 256.0 ) / 255.0
    );
  }
`;

export interface PickHit {
  /** 由 S3MLayer 分配的网格编号 */
  objectId: number;
  /** 非实例化几何：单体 batchId；实例化几何这里是 -1（改看 instanceIndex） */
  batchId: number;
  /** 实例化几何命中到第几个实例（非实例化为 undefined） */
  instanceIndex?: number;
}

/** S3MLayer 挂到 mesh.userData 上的字段，拾取时会读它 */
interface PickUserData {
  pickId?: number;
  pickMaterial?: THREE.Material;
  [key: string]: unknown;
}

/** 没有单体状态纹理时用的占位（全 0 = 不隐藏、不抬高） */
const DUMMY_STATE_TEX = (() => {
  const tex = new THREE.DataTexture(new Float32Array([-1, -1, -1, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
})();

function createPickMaterial(objectId: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uObjectId: { value: objectId },
      uBatchTex: { value: DUMMY_STATE_TEX },
      uBatchTexWidth: { value: 1 },
      uBatchTexActive: { value: 0 },
      uSelBatch: { value: -1 },
      uSelWhole: { value: 0 },
      uSelElevation: { value: 0 },
    },
    vertexShader: PICK_VERT,
    fragmentShader: PICK_FRAG,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  });
}

export class Picker {
  readonly renderer: THREE.WebGLRenderer;
  /** 拾取用的渲染目标边长（像素），默认 1 —— 只要点击点那一格 */
  readonly size: number;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly buf = new Uint8Array(4);

  constructor(renderer: THREE.WebGLRenderer, options: { size?: number } = {}) {
    this.renderer = renderer;
    this.size = Math.max(1, Math.floor(options.size ?? 1));
  }

  private _ensureTarget(size: number): THREE.WebGLRenderTarget {
    if (this.target && this.target.width === size && this.target.height === size) return this.target;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    // 关掉色彩空间转换，否则 ACES / sRGB 会把编码好的 ID 洗掉
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return this.target;
  }

  /**
   * @param clientX 相对 canvas 左上角的 CSS 像素
   * @param clientY 同上
   */
  pick(scene: THREE.Scene, camera: THREE.Camera, clientX: number, clientY: number): PickHit | null {
    const renderer = this.renderer;
    const canvas = renderer.domElement;
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return null;

    const px = Math.floor((clientX / canvas.clientWidth) * w);
    const py = Math.floor((clientY / canvas.clientHeight) * h);
    if (px < 0 || py < 0 || px >= w || py >= h) return null;

    const target = this._ensureTarget(this.size);

    // 点击点落在整块画布的第几行（WebGL 的 y 轴朝上）
    const ygl = h - 1 - py;
    // 目标里我们读的那一格（size 为偶数时取偏左上那格）
    const cx = Math.floor(this.size / 2);
    const cy = Math.floor(this.size / 2);
    // viewport 尺寸仍是整块画布、原点平移，把 (px, ygl) 挪到目标的 (cx, cy)
    target.viewport.set(cx - px, cy - ygl, w, h);

    // ---- 保存渲染器状态
    const prevTarget = renderer.getRenderTarget();
    const prevViewport = renderer.getViewport(new THREE.Vector4());
    const prevTone = renderer.toneMapping;
    const prevColorSpace = renderer.outputColorSpace;
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();

    // ---- 换材质
    const swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    /** 这次拾取里哪些网格是实例化的（它们的 vBatch 编码的是实例序号） */
    const instancedPickIds = new Set<number>();
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const ud = mesh.userData as PickUserData;
      if (ud.pickId === undefined) return;
      if (!ud.pickMaterial) ud.pickMaterial = createPickMaterial(ud.pickId);
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) instancedPickIds.add(ud.pickId);

      // 把当前的「单体状态纹理」抄给拾取材质：抬高量是逐单体写在里面的，
      // 抄的是同一个纹理对象，主材质那边更新后这里自动跟着变。
      const prev = mesh.material;
      const pm = ud.pickMaterial as THREE.ShaderMaterial;
      const src = (Array.isArray(prev) ? prev[0] : prev) as THREE.Material & {
        userData?: Record<string, THREE.IUniform>;
      };
      const batchTex = src?.userData?.uBatchTex;
      if (batchTex) {
        pm.uniforms.uBatchTex.value = batchTex.value;
        pm.uniforms.uBatchTexWidth.value = (src?.userData?.uBatchTexWidth?.value as number) ?? 1;
        pm.uniforms.uBatchTexActive.value = (src?.userData?.uBatchTexActive?.value as number) ?? 0;
      } else {
        pm.uniforms.uBatchTex.value = DUMMY_STATE_TEX;
        pm.uniforms.uBatchTexWidth.value = 1;
        pm.uniforms.uBatchTexActive.value = 0;
      }
      // 选中那栋自身的拔高也要算，否则选中后再点它会点空
      pm.uniforms.uSelBatch.value = (src?.userData?.uSelBatch?.value as number) ?? -1;
      pm.uniforms.uSelWhole.value = (src?.userData?.uSelWhole?.value as number) ?? 0;
      // uSelElevation 是共享 uniform，挂在材质 uniforms 上而不是 userData
      pm.uniforms.uSelElevation.value =
        ((src as THREE.ShaderMaterial | undefined)?.uniforms?.uSelElevation?.value as number) ?? 0;

      swapped.push([mesh, prev]);
      mesh.material = pm;
    });
    // 描边 / 棱线不参与拾取
    const hidden: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.userData as PickUserData).pickId === undefined) {
        hidden.push(mesh);
        mesh.visible = false;
      }
    });

    let hit: PickHit | null = null;
    try {
      // 关键：拾取是在「正常渲染帧」之外另开的一趟渲染，
      // MapLibre / Mapbox 在上一次 draw 之后可能已经改过 GL 状态（深度测试、scissor 等），
      // 而 three 的状态缓存还停留在自己的上一次 render。
      // 不重置就会出现深度测试失效 → 命中的是「最后画的」而不是「最前面的」。
      renderer.resetState();

      renderer.setRenderTarget(target);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);

      renderer.readRenderTargetPixels(target, cx, cy, 1, 1, this.buf);

      const r = this.buf[0];
      const g = this.buf[1];
      const b = this.buf[2];
      const a = this.buf[3];
      const objectId = r + g * 256 - 1;
      const rawId = b + a * 256 - 1;
      if (objectId >= 0) {
        hit = instancedPickIds.has(objectId)
          ? { objectId, batchId: -1, instanceIndex: Math.max(0, rawId) }
          : { objectId, batchId: rawId };
      }
    } finally {
      for (const [mesh, mat] of swapped) mesh.material = mat;
      for (const o of hidden) o.visible = true;
      renderer.setRenderTarget(prevTarget);
      renderer.setViewport(prevViewport);
      renderer.toneMapping = prevTone;
      renderer.outputColorSpace = prevColorSpace;
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.resetState();
    }

    return hit;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
  }
}
