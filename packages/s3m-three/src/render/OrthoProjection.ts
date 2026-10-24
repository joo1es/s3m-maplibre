import * as THREE from 'three';

/**
 * 投影模式。
 *
 * `'perspective'` —— 默认。直接用 MapLibre 每帧给的 MVP，和底图严格对齐。
 * `'orthographic'` —— 本层改用正交投影重画。视图矩阵不是猜的：MapLibre ≥5 的
 *   custom layer 输入把 `projectionMatrix`（view→clip）和
 *   `modelViewProjectionMatrix`（world→clip）分开给，于是
 *       V = P⁻¹ × MVP
 *   可以精确解出来，再按当前相机距离铺一个正交视锥。pan / zoom / pitch /
 *   rotate 全部作用在 MapLibre 的 transform 上，手感与透视一致；拾取、选中
 *   描边、状态纹理都读同一个相机，自动跟随。
 *
 * 正交只覆盖「本层」。MapLibre 自己投影的内容——底图瓦片、地形、DOM Marker /
 * 弹窗——仍是透视，和正交层对不齐，错位量级 ≈ 楼高 / 相机距（城市尺度几十到
 * 上百像素）。要用正交，App 需要自行把这些层退出，这是产品决策而非技术限制。
 */
export type ProjectionMode = 'perspective' | 'orthographic';

/** render() 入参里与本模块相关的字段 */
export interface OrthoInput {
  /** view→clip 的透视投影矩阵。拿不到就解不出视图矩阵，正交无从谈起 */
  projectionMatrix?: ArrayLike<number> | null;
  /** world→clip 的 MVP（= projectionMatrix × 视图矩阵） */
  mvp: ArrayLike<number>;
  /** 相机到近裁剪面的距离（米） */
  nearZ?: number | null;
  /** 相机到远裁剪面的距离（米） */
  farZ?: number | null;
}

export interface OrthoParams {
  /** 相机到目标的距离（米）。正交半高 = distance × tan(fov/2) */
  distance: number;
  /** 垂直视场角（弧度） */
  fov: number;
  /** 画布宽高比 */
  aspect: number;
}

export interface OrthoMVP {
  /** world→clip 的正交 MVP，直接赋给 camera.projectionMatrix */
  matrix: THREE.Matrix4;
  /** 解出来的 world→view（测试 / 调试用） */
  view: THREE.Matrix4;
}

const EPS = 1e-4;

function closeTo(a: THREE.Matrix4, b: ArrayLike<number>): boolean {
  const e = a.elements;
  for (let i = 0; i < 16; i++) {
    const scale = Math.max(1, Math.abs(e[i]), Math.abs(b[i]));
    if (Math.abs(e[i] - b[i]) > EPS * scale) return false;
  }
  return true;
}

/**
 * 反推出来的「投影之后那一串」必须是仿射变换：底行 [0,0,0,1]。
 *
 * 为什么不是刚体：MapLibre 的 MVP 是 `投影矩阵 · 后面一串`，而那一串里焊了
 * y 翻转（墨卡托 y 朝南）、相机平移、姿态旋转、以及 `scale(1,1,pixelPerMeter)`
 * 这种非均匀缩放——全部合法，但显然不刚体。真正要拦的是「两个输入矩阵不同源」：
 * 那时 P⁻¹×MVP 会带投影分量（底行出现非零项），画面看着正常但整体错位。
 */
function isAffine(v: THREE.Matrix4): boolean {
  const e = v.elements;
  let scale = 1;
  for (let i = 0; i < 16; i++) {
    const a = Math.abs(e[i]);
    if (a > scale) scale = a;
  }
  const tol = 1e-6 * scale;
  return (
    Math.abs(e[3]) < tol && Math.abs(e[7]) < tol && Math.abs(e[11]) < tol && Math.abs(e[15] - 1) < tol
  );
}

/**
 * 校验拿到的投影矩阵和本帧 fov 对得上。标准透视的 `m[5] = 1/tan(fov/2)`
 * （列主序 elements[5]），与宽高比无关，所以只查这一项。
 * 不同源的两个矩阵有时仍能凑出仿射结果（比如只换了 fov 的透视矩阵），
 * 靠这一道拦。
 */
function matchesFov(p: THREE.Matrix4, fov: number): boolean {
  if (!(fov > 0)) return false;
  return Math.abs(p.elements[5] * Math.tan(fov / 2) - 1) < 1e-3;
}

/**
 * 从 render() 入参取 view→clip 投影矩阵。
 * MapLibre ≥5 是对象形态（顶层或 defaultProjectionData 里）；v4 只给一个
 * 合并矩阵数组，取不到，返回 null。
 */
export function extractProjectionMatrix(arg: unknown): ArrayLike<number> | null {
  if (!arg || typeof arg !== 'object') return null;
  const o = arg as {
    defaultProjectionData?: { projectionMatrix?: ArrayLike<number> | null };
    projectionMatrix?: ArrayLike<number> | null;
  };
  return o.defaultProjectionData?.projectionMatrix ?? o.projectionMatrix ?? null;
}

/** 从 render() 入参取 nearZ / farZ（顶层优先，其次 defaultProjectionData） */
export function extractNearFar(arg: unknown): { nearZ: number | null; farZ: number | null } {
  const none = { nearZ: null, farZ: null };
  if (!arg || typeof arg !== 'object') return none;
  const o = arg as Record<string, unknown>;
  const dpd = o.defaultProjectionData as Record<string, unknown> | undefined;
  const pick = (key: string): number | null => {
    const a = o[key];
    if (typeof a === 'number' && Number.isFinite(a)) return a;
    const b = dpd?.[key];
    return typeof b === 'number' && Number.isFinite(b) ? b : null;
  };
  return { nearZ: pick('nearZ'), farZ: pick('farZ') };
}

/**
 * 取本帧垂直视场角（弧度）。
 *
 * 优先用 render() 入参自带的 `fov`——MapLibre ≥5 直接给弧度，且就是本帧 MVP
 * 实际用的值。其次才退回 `transform.fovInRadians`。
 *
 * 注意**不能直接用 `transform.fov`**：MapLibre v5 起它变成「度」（v4 与
 * Mapbox GL 才是「弧度」），当弧度用会让 tan(fov/2) 差出 20% 以上。
 */
export function extractFovRadians(arg: unknown, fallback?: number | null): number | null {
  if (arg && typeof arg === 'object') {
    const fov = (arg as { fov?: unknown }).fov;
    if (typeof fov === 'number' && Number.isFinite(fov) && fov > 0) return fov;
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) return fallback;
  return null;
}

/**
 * 由 MapLibre 的透视投影反推「投影之后那一串」，换成同视角的正交投影。
 *
 * MapLibre ≥5 的 custom layer 输入把 `projectionMatrix`（view→clip）和
 * `modelViewProjectionMatrix`（world→clip）分开给。注意后者的完整形态是
 *   MVP = P · A
 * 其中 A 是投影之后的一串仿射变换——y 翻转、相机平移、姿态旋转、
 * `scale(1,1,pixelPerMeter)`、高程平移（见 Transform 里 MVP 的装配顺序）。
 * 于是 A = P⁻¹ × MVP 可以精确解出来，再把 P 换成同视角的正交：
 *   正交 MVP = P_ortho · A
 *
 * 半高取「目标深度处透视视锥的半高」：`distance × tan(fov/2)`。这样正交与
 * 透视在目标平面上逐点重合，zoom 改相机距离 → 距离减半 = 半高减半 = 放大
 * 一倍，语义和透视完全一致。
 *
 * 返回 null 表示正交不可用（没有独立投影矩阵 / fov 对不上 / 两个矩阵不同源），
 * 调用方应保持透视并记一次告警。
 */
export function buildOrthoMVP(input: OrthoInput, params: OrthoParams): OrthoMVP | null {
  const p = input.projectionMatrix;
  if (!p || p.length < 16) return null;

  const pMat = new THREE.Matrix4().fromArray(Array.from(p));
  const mvp = new THREE.Matrix4().fromArray(Array.from(input.mvp));
  if (pMat.determinant() === 0) return null;
  // 投影矩阵必须和本帧 fov 对得上，否则两个输入矩阵不同源
  if (!matchesFov(pMat, params.fov)) return null;

  const view = pMat.clone().invert().multiply(mvp);
  // 数值健全性：P × (P⁻¹ × MVP) 必须还原 MVP（NaN / 溢出会在这里现形）
  if (!closeTo(pMat.clone().multiply(view), Array.from(input.mvp))) return null;
  // 同源性：反推结果必须是仿射变换（带投影分量说明两个矩阵不同源）
  if (!isAffine(view)) return null;
  // fov 校验：输入的投影矩阵必须与本帧要求的 fov 一致
  if (!matchesFov(pMat, params.fov)) return null;

  const { distance, fov, aspect } = params;
  if (!(distance > 0) || !(fov > 0) || !(aspect > 0)) return null;

  const halfH = distance * Math.tan(fov / 2);
  const halfW = halfH * aspect;

  // 裁剪面沿用 MapLibre 给的， clipping 行为和透视一致；缺失时用兜底值
  let near = input.nearZ != null && input.nearZ > 0 ? input.nearZ : 1;
  let far = input.farZ != null && input.farZ > near ? input.farZ : distance * 4 + 1000;
  if (!(far > near)) far = near + 1000;

  const ortho = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, near, far);
  ortho.updateProjectionMatrix();
  return { matrix: ortho.projectionMatrix.clone().multiply(view), view };
}
