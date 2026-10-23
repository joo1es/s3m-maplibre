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
 */
import * as THREE from 'three';

const PICK_VERT = /* glsl */ `
  attribute float aBatchId;
  uniform float uObjectId;
  varying float vBatch;
  void main() {
    vBatch = aBatchId;
    #ifdef USE_INSTANCING
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
    #else
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
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
  /** 单体编号，-1 表示该几何没有单体化信息 */
  batchId: number;
}

/** S3MLayer 挂到 mesh.userData 上的字段，拾取时会读它 */
interface PickUserData {
  pickId?: number;
  pickMaterial?: THREE.Material;
  [key: string]: unknown;
}

function createPickMaterial(objectId: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uObjectId: { value: objectId } },
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
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly buf = new Uint8Array(4);

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  private _ensureTarget(w: number, h: number): THREE.WebGLRenderTarget {
    if (this.target && this.target.width === w && this.target.height === h) return this.target;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(w, h, {
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

    const target = this._ensureTarget(w, h);

    // ---- 保存渲染器状态
    const prevTarget = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    const prevColorSpace = renderer.outputColorSpace;
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();

    // ---- 换材质
    const swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const ud = mesh.userData as PickUserData;
      if (ud.pickId === undefined) return;
      if (!ud.pickMaterial) ud.pickMaterial = createPickMaterial(ud.pickId);
      swapped.push([mesh, mesh.material]);
      mesh.material = ud.pickMaterial;
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

      // WebGL 的 y 轴朝上，读取时要翻过来
      renderer.readRenderTargetPixels(target, px, h - 1 - py, 1, 1, this.buf);

      const r = this.buf[0];
      const g = this.buf[1];
      const b = this.buf[2];
      const a = this.buf[3];
      const objectId = r + g * 256 - 1;
      const batchId = b + a * 256 - 1;
      if (objectId >= 0) hit = { objectId, batchId };
    } finally {
      for (const [mesh, mat] of swapped) mesh.material = mat;
      for (const o of hidden) o.visible = true;
      renderer.setRenderTarget(prevTarget);
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
