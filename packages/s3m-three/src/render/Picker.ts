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
import { createSplatPickMaterial } from './SplatMaterial.js';

const PICK_VERT = /* glsl */ `
  attribute float aBatchId;
  #ifdef USE_INSTANCING
    // 实例化：单体粒度在实例上，顶点属性里没有可用的 batchId
    attribute float aInstanceBatchId;
    attribute float aInstanceIndex;
  #endif
  uniform float uObjectId;
  uniform sampler2D uBatchTex;
  uniform sampler2D uBatchTex2;
  uniform float uBatchMix;
  uniform float uBatchTexWidth;
  uniform int uBatchTexActive;
  uniform sampler2D uPathTex;
  uniform float uPathCount;
  uniform float uPathTime;
  uniform int uPathTexActive;
  uniform float uSelBatch;
  uniform float uSelWhole;
  uniform float uSelElevation;
  varying float vBatch;

  /** 交叉淡化期间也要读「屏幕上正在显示的那份」，否则过渡中点到的是旧位置 */
  vec4 s3mPickSample( vec2 uv ) {
    vec4 a = texture2D( uBatchTex, uv );
    if ( uBatchMix <= 0.0001 ) return a;
    return mix( a, texture2D( uBatchTex2, uv ), uBatchMix );
  }

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

    // 单体状态必须和主着色器用同一份数据、同一套算法：位移 / 旋转 / 隐藏 / GPU 路径
    // 全都只发生在顶点着色器里，拾取这一趟如果还按原始坐标画，动过的楼就点不中。
    // 状态纹理共 6 行，行序与 StyleMaterial 的 VERT_SETUP 严格一一对应。
    vec3 p = position;
    mat3 rot = mat3( 1.0 );
    vec3 pivot = vec3( 0.0 );
    vec3 offset = vec3( 0.0 );
    bool hidden = false;

    if ( uBatchTexActive > 0 && s3mBatch >= 0.0 ) {
      float u = ( s3mBatch + 0.5 ) / uBatchTexWidth;
      // Row 0：rgb = 配色，a = 抬高 / < -0.5 表示隐藏
      vec4 state = s3mPickSample( vec2( u, 0.08333333 ) );
      if ( state.a < -0.5 ) {
        hidden = true;
      } else {
        // Row 1：平移（z 已包含抬高）
        vec4 r1 = s3mPickSample( vec2( u, 0.25 ) );
        offset = r1.xyz;
        if ( offset.z == 0.0 && state.a > 0.0 ) offset.z = state.a;

        // Row 2/3/4：3x3 姿态矩阵（列优先）+ 轴心
        vec4 r2 = s3mPickSample( vec2( u, 0.41666667 ) );
        vec4 r3 = s3mPickSample( vec2( u, 0.58333333 ) );
        vec4 r4 = s3mPickSample( vec2( u, 0.75 ) );
        rot = mat3(
          vec3( r2.x, r3.x, r4.x ),
          vec3( r2.y, r3.y, r4.y ),
          vec3( r2.z, r3.z, r4.z )
        );
        pivot = vec3( r2.w, r3.w, r4.w );

        // Row 5：GPU 路径动画，与主着色器逐行对齐（含 loop / pingpong / clamp 与自动朝向）
        if ( uPathTexActive > 0 && uPathCount > 0.0 ) {
          vec4 r5 = s3mPickSample( vec2( u, 0.91666667 ) );
          float pathId = r5.x;
          float speed = r5.y;
          float phase = r5.z;
          float mode = r5.w;
          if ( pathId >= 0.0 && mode > 0.5 ) {
            float t = phase + uPathTime * speed;
            bool autoHeading = true;
            if ( mode >= 4.0 ) {
              autoHeading = false;
              mode -= 3.0;
            }
            if ( mode < 1.5 ) {
              t = fract( t );
            } else if ( mode < 2.5 ) {
              t = clamp( t, 0.0, 1.0 );
            } else {
              t = mod( t, 2.0 );
              t = ( t > 1.0 ) ? ( 2.0 - t ) : t;
            }
            vec4 pathSample = texture2D(
              uPathTex,
              vec2( ( t * 255.0 + 0.5 ) / 256.0, ( pathId + 0.5 ) / uPathCount )
            );
            if ( autoHeading ) {
              float c = cos( pathSample.w );
              float s = sin( pathSample.w );
              // 列优先：(c, s) 是第 0 列 → 绕 Z 转 +yaw，与 StyleMaterial / EdgeLines 逐位一致
              rot = mat3( c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0 ) * rot;
            }
            offset += pathSample.xyz;
          }
        }
      }
    }

    if ( hidden ) {
      p = vec3( 0.0 );
    } else {
      p = rot * ( p - pivot ) + pivot + offset;
    }

    // 选中单体自身的拔高（selectElevation）
    float sel = max( step( 0.0, uSelBatch ) * step( abs( s3mBatch - uSelBatch ), 0.5 ), uSelWhole );
    p.z += sel * uSelElevation;

    #ifdef USE_INSTANCING
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( p, 1.0 );
    #else
      gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
    #endif
    // 点云也用这条着色器：不写 gl_PointSize 时光栅化出来只有 1px，
    // 跟显示尺寸（2px）不匹配，点云会很难点中。对 Mesh 图元这行被忽略。
    gl_PointSize = 2.0;
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
  /** 高斯泼溅实例网格：拾取要走专用材质，见 SplatMaterial.createSplatPickMaterial */
  isGaussianSplat?: boolean;
  [key: string]: unknown;
}

/** 没有单体状态纹理时用的占位（全 0 = 不隐藏、不平移） */
const DUMMY_STATE_TEX = (() => {
  const tex = new THREE.DataTexture(new Float32Array([-1, -1, -1, 0, 0, 0, 0, 0]), 1, 2, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
})();

/** 没有 GPU 路径库时用的占位（1x1 全 0，采样出来 pathId = 0 但 uPathTexActive = 0 会跳过） */
const DUMMY_PATH_TEX = (() => {
  const tex = new THREE.DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
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
      uBatchTex2: { value: DUMMY_STATE_TEX },
      uBatchMix: { value: 0 },
      uBatchTexWidth: { value: 1 },
      uBatchTexActive: { value: 0 },
      uPathTex: { value: DUMMY_PATH_TEX },
      uPathCount: { value: 1 },
      uPathTime: { value: 0 },
      uPathTexActive: { value: 0 },
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

/** 点云是 THREE.Points 不是 Mesh，拾取链路要放行 */
function isPointsObject(o: THREE.Object3D): o is THREE.Points {
  return (o as unknown as THREE.Points).isPoints === true;
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
    const swapped: Array<[THREE.Object3D, THREE.Material | THREE.Material[]]> = [];
    /** 这次拾取里哪些网格是实例化的（它们的 vBatch 编码的是实例序号） */
    const instancedPickIds = new Set<number>();
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      // 点云是 THREE.Points，同样要参与拾取
      if (!mesh.isMesh && !isPointsObject(mesh)) return;
      const ud = mesh.userData as PickUserData;
      if (ud.pickId === undefined) return;
      // 泼溅走自己的拾取材质：通用拾取着色器只读 position，不知道 iCenter，
      // 交给它每个高斯都会塌在原点，点哪儿都没反应。见 SplatMaterial 里那段注释。
      const isSplat = ud.isGaussianSplat === true;
      if (!ud.pickMaterial) {
        ud.pickMaterial = isSplat ? createSplatPickMaterial(ud.pickId) : createPickMaterial(ud.pickId);
      }
      // 泼溅**不登记为实例化单体**：它的实例号在 geoRef.pickInfo 里查不到（没有
      // instanceMatrix 那套单体表），报成 instanceIndex 只会让上层 `_instanceFeature`
      // 返回 null 把结果丢掉。泼溅整块瓦片当一个单体，命中点交给 splatRaycast。
      if (!isSplat && (mesh as THREE.InstancedMesh).isInstancedMesh) instancedPickIds.add(ud.pickId);
      const prev = mesh.material;
      const pm = ud.pickMaterial as THREE.ShaderMaterial;
      // 泼溅没有单体状态纹理 / GPU 路径那一套 uniform，直接跳过抄写
      if (isSplat) {
        swapped.push([mesh, prev]);
        mesh.material = pm;
        return;
      }
      // 把当前的「单体状态纹理」抄给拾取材质：抬高 / 平移 / 姿态 / GPU 路径都是逐单体
      // 写在里面的，抄的是同一个纹理与同一批 uniform 对象，主材质那边更新后这里自动跟着变。
      const src = (Array.isArray(prev) ? prev[0] : prev) as THREE.Material & {
        userData?: Record<string, THREE.IUniform>;
        uniforms?: Record<string, THREE.IUniform>;
      };
      const batchTex = src?.userData?.uBatchTex;
      if (batchTex) {
        pm.uniforms.uBatchTex.value = batchTex.value;
        pm.uniforms.uBatchTex2.value = src?.userData?.uBatchTex2?.value ?? batchTex.value;
        pm.uniforms.uBatchTexWidth.value = (src?.userData?.uBatchTexWidth?.value as number) ?? 1;
        pm.uniforms.uBatchTexActive.value = (src?.userData?.uBatchTexActive?.value as number) ?? 0;
      } else {
        pm.uniforms.uBatchTex.value = DUMMY_STATE_TEX;
        pm.uniforms.uBatchTex2.value = DUMMY_STATE_TEX;
        pm.uniforms.uBatchTexWidth.value = 1;
        pm.uniforms.uBatchTexActive.value = 0;
      }
      // 交叉淡化与 GPU 路径的 uniform 是共享对象（挂在材质 userData 上），
      // 抄引用即可，不需要每帧同步数值
      pm.uniforms.uBatchMix.value = (src?.userData?.uBatchMix?.value as number) ?? 0;
      pm.uniforms.uPathTex.value = src?.userData?.uPathTex?.value ?? DUMMY_PATH_TEX;
      pm.uniforms.uPathCount.value = (src?.userData?.uPathCount?.value as number) ?? 1;
      pm.uniforms.uPathTime.value = (src?.userData?.uPathTime?.value as number) ?? 0;
      pm.uniforms.uPathTexActive.value = (src?.userData?.uPathTexActive?.value as number) ?? 0;
      // 选中那栋自身的拔高也要算，否则选中后再点它会点空
      pm.uniforms.uSelBatch.value = (src?.userData?.uSelBatch?.value as number) ?? -1;
      pm.uniforms.uSelWhole.value = (src?.userData?.uSelWhole?.value as number) ?? 0;
      pm.uniforms.uSelElevation.value =
        (src?.userData?.uSelElevation?.value as number) ??
        (src?.uniforms?.uSelElevation?.value as number) ??
        0;

      swapped.push([mesh, prev]);
      mesh.material = pm;
    });
    // 描边 / 棱线不参与拾取
    const hidden: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh.isMesh || isPointsObject(mesh)) && (mesh.userData as PickUserData).pickId === undefined) {
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
      for (const [obj, mat] of swapped) (obj as THREE.Mesh).material = mat;
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
