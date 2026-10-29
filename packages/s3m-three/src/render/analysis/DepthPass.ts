/**
 * 分析用的离屏深度采集（P1 的 GPU 部分）。
 *
 * 这里只干一件事：把场景渲染成「一张能回读的深度图」，判断逻辑全在
 * `analysis/skyline.ts` 与 `analysis/viewshed.ts` 里（纯数学、有单测）。
 * 这样 GPU 侧出错只可能是「图不对」（demo 里一眼看得出），
 * 而不会把归约逻辑一起搅进去。
 *
 * 两个采集器：
 * - `captureSkylineDepth`：用当前相机视角渲染一次，给天际线用（three 的 RGBADepthPacking）；
 * - `captureRadialCube`：从观察点朝 6 个方向各渲染一次，存「到观察点的距离」，
 *   给 360° 可视域用。
 *
 * 三条硬约束（都是踩过的坑）：
 * 1. **必须 `resetState()`**：MapLibre 在上一次 draw 之后改过 GL 状态，
 *    three 的缓存还停在上一次自己的 render 上，不重置会出现深度测试失效。
 * 2. **清屏成白色**：`packDepthToRGBA(1)` 返回全白，清屏也用白，
 *    于是「背景」和「远平面」解包后都是 1.0，背景判定只需一个阈值。
 * 3. **回读是行倒序的**：WebGL 的 `readPixels` 原点在左下，这里翻成正序再交出去。
 */
import * as THREE from 'three';
import type { Vec3 } from '../../analysis/measure.js';

export interface DepthCaptureContext {
  renderer: () => THREE.WebGLRenderer | null;
  scene: () => THREE.Scene | null;
  camera: () => THREE.Camera | null;
}

/**
 * 参与深度采集的**额外几何**（分析代理）。
 *
 * 用途：分析只看得见 S3M 场景里的东西。要让 MapLibre 的 MVT 建筑 / 地形也参与
 * 遮挡，外围得自己把它们挤出成几何，通过这个参数临时挂进场景 —— 只在这一趟
 * 深度渲染里存在，**不进主渲染、不影响画面**，渲染完立刻摘掉。
 *
 * 注意：
 * - 传进来的对象不要已经有 parent（会被临时 add 到 viewer 的场景上再移除）；
 * - 代理几何的材质会被 `overrideMaterial` 覆盖，所以给什么材质都行；
 * - 代理和 MapLibre 实际画出来的可能有细微偏差（表达式插值、terrain 抬升等），
 *   这是「复制一份几何」这条路固有的代价。
 */
export interface DepthCaptureInclude {
  include?: readonly THREE.Object3D[];
}

/** 临时把代理几何挂进场景，返回「摘掉」的函数 */
function attachProxy(scene: THREE.Scene, include?: readonly THREE.Object3D[]): () => void {
  if (!include?.length) return () => {};
  const added = include.filter((o) => o && !o.parent);
  for (const o of added) scene.add(o);
  return () => {
    for (const o of added) scene.remove(o);
  };
}

/* ------------------------------------------------------------------ 渲染器状态 */

interface RendererState {
  target: THREE.WebGLRenderTarget | null;
  toneMapping: THREE.ToneMapping;
  colorSpace: THREE.ColorSpace;
  autoClear: boolean;
  clearColor: THREE.Color;
  clearAlpha: number;
}

function saveState(r: THREE.WebGLRenderer): RendererState {
  return {
    target: r.getRenderTarget(),
    toneMapping: r.toneMapping,
    colorSpace: r.outputColorSpace,
    autoClear: r.autoClear,
    clearColor: r.getClearColor(new THREE.Color()),
    clearAlpha: r.getClearAlpha(),
  };
}

function restoreState(r: THREE.WebGLRenderer, s: RendererState): void {
  r.setRenderTarget(s.target);
  r.toneMapping = s.toneMapping;
  r.outputColorSpace = s.colorSpace;
  r.autoClear = s.autoClear;
  r.setClearColor(s.clearColor, s.clearAlpha);
}

/** 回读并把像素翻成正序（行 0 = 画面顶部） */
function readFlipped(r: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, width: number, height: number): Uint8Array {
  const raw = new Uint8Array(width * height * 4);
  r.readRenderTargetPixels(rt, 0, 0, width, height, raw);
  const out = new Uint8Array(raw.length);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    out.set(raw.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes), y * rowBytes);
  }
  return out;
}

function makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
}

/* ------------------------------------------------------------------ 天际线 */

export interface SkylineCapture {
  rgba: Uint8Array;
  width: number;
  height: number;
  inverseViewProj: Float32Array;
  cameraPos: Vec3;
}

/**
 * 用当前相机渲染一张深度图（RGBADepthPacking）。
 *
 * @param width 采集分辨率。精度由它决定：1280 宽 ≈ 0.28°/列；320 宽 ≈ 1.1°/列。
 */
export function captureSkylineDepth(
  ctx: DepthCaptureContext,
  width: number,
  height: number,
  include?: readonly THREE.Object3D[]
): SkylineCapture | null {
  const r = ctx.renderer();
  const scene = ctx.scene();
  const camera = ctx.camera();
  if (!r || !scene || !camera) return null;

  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const rt = makeTarget(w, h);
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

  const prevOverride = scene.overrideMaterial;
  const state = saveState(r);
  const detach = attachProxy(scene, include);
  let rgba: Uint8Array | null = null;

  try {
    r.resetState();
    r.setRenderTarget(rt);
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.autoClear = true;
    r.setClearColor(0xffffff, 1);
    r.clear();

    scene.overrideMaterial = depthMat;
    camera.updateMatrixWorld();
    r.render(scene, camera);
    rgba = readFlipped(r, rt, w, h);
  } finally {
    detach();
    scene.overrideMaterial = prevOverride;
    restoreState(r, state);
    depthMat.dispose();
    rt.dispose();
  }

  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const inv = new Float32Array(vp.clone().invert().elements);
  const pos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);

  return { rgba, width: w, height: h, inverseViewProj: inv, cameraPos: [pos.x, pos.y, pos.z] };
}

/* ------------------------------------------------------------------ 360° 可视域 */

/**
 * 6 个面的朝向。**与 `analysis/viewshed.ts` 的采样器约定必须逐字一致**，
 * 否则可视域会镜像到错误的一侧（而且看起来还挺像真的）。
 *
 * 约定：`right = forward × up`；采样器里 `u = dot(dir, right) / dot(dir, forward)`，
 * `v = dot(dir, up) / dot(dir, forward)`，像素 = `((u + 1) / 2 * size, (v + 1) / 2 * size)`。
 */
export const CUBE_FACES: readonly { forward: Vec3; up: Vec3 }[] = [
  { forward: [1, 0, 0], up: [0, -1, 0] },
  { forward: [-1, 0, 0], up: [0, -1, 0] },
  { forward: [0, 1, 0], up: [0, 0, 1] },
  { forward: [0, -1, 0], up: [0, 0, -1] },
  { forward: [0, 0, 1], up: [0, -1, 0] },
  { forward: [0, 0, -1], up: [0, -1, 0] },
];

/** 按上面的约定造 6 台 90° 相机；抽出来是为了能脱离 WebGL 单测朝向 */
export function buildCubeCameras(origin: Vec3, near: number, far: number): THREE.PerspectiveCamera[] {
  return CUBE_FACES.map(({ forward, up }) => {
    const cam = new THREE.PerspectiveCamera(90, 1, near, far);
    cam.up.set(up[0], up[1], up[2]);
    cam.position.set(origin[0], origin[1], origin[2]);
    cam.lookAt(origin[0] + forward[0], origin[1] + forward[1], origin[2] + forward[2]);
    cam.updateMatrixWorld(true);
    return cam;
  });
}

/**
 * 从观察点朝 6 个方向渲染「到观察点的距离」，归一化到 [0,1] 后按
 * three 的 `packDepthToRGBA` 打包。
 *
 * ⚠️ 用 `overrideMaterial` 换材质，**实例化网格（InstancedMesh）不会被正确变换** ——
 * 简化着色器不处理 `instanceMatrix`。点云 / 树木这类实例化内容不参与遮挡。
 */
export function captureRadialCube(
  ctx: DepthCaptureContext,
  origin: Vec3,
  size: number,
  maxDist: number,
  include?: readonly THREE.Object3D[]
): Uint8Array[] | null {
  const r = ctx.renderer();
  const scene = ctx.scene();
  if (!r || !scene) return null;

  const s = Math.max(8, Math.floor(size));
  const rt = makeTarget(s, s);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uOrigin: { value: new THREE.Vector3(origin[0], origin[1], origin[2]) },
      uMaxDist: { value: maxDist },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4( position, 1.0 );
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <packing>
      uniform vec3 uOrigin;
      uniform float uMaxDist;
      varying vec3 vWorld;
      void main() {
        float d = clamp( length( vWorld - uOrigin ) / uMaxDist, 0.0, 1.0 );
        gl_FragColor = packDepthToRGBA( d );
      }
    `,
  });

  const prevOverride = scene.overrideMaterial;
  const state = saveState(r);
  const detach = attachProxy(scene, include);
  const cameras = buildCubeCameras(origin, 0.1, maxDist);
  const faces: Uint8Array[] = [];

  try {
    r.resetState();
    r.setRenderTarget(rt);
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.autoClear = true;
    r.setClearColor(0xffffff, 1); // 白 = 该方向没有几何（与 pack(1) 一致）
    scene.overrideMaterial = mat;

    for (const cam of cameras) {
      r.clear();
      r.render(scene, cam);
      faces.push(readFlipped(r, rt, s, s));
    }
  } finally {
    detach();
    scene.overrideMaterial = prevOverride;
    restoreState(r, state);
    mat.dispose();
    rt.dispose();
  }

  return faces;
}
