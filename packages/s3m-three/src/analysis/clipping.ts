/**
 * 裁剪 / 剖切的纯数学部分：把「平面 / Box / 十字」三种交互输入翻译成一组半空间。
 *
 * 与 three 的 `THREE.Plane` 同构（`normal` 单位化，`constant = -normal·point`），
 * 判据是 three 的口径：`normal·p + constant >= 0` 的片元**保留**，否则丢弃。
 * 所以这里的法线一律朝「保留侧」。
 *
 * 不依赖 three，`S3MViewer.setClipping` 再把结果转成 `THREE.Plane` 挂到
 * `renderer.clippingPlanes`（每个图层一个 renderer，天然图层级）。
 *
 * 已知边界：
 * - 半空间求交只能表达**凸**区域，凹多边形要多组并集（three 的 clippingPlanes
 *   是「全部满足才保留」，做不到并集），见 `docs/API.md` 的说明；
 * - 不做封口：剖切后看到的是背面/空壳，封口要靠 stencil 或背面重绘，不在这一层。
 */
import type { Vec3 } from './measure.js';

/** 与 `THREE.Plane` 同构：`normal` 必须单位化 */
export interface PlaneLike {
  normal: Vec3;
  constant: number;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-9) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** 过一个点、法线指向**保留侧**的平面 */
export function planeFromPointNormal(normal: Vec3, point: Vec3): PlaneLike {
  const n = normalize(normal);
  return { normal: n, constant: -dot(n, point) };
}

/** 点是否在保留侧（含边界）；用于调试与单测 */
export function isPointKept(planes: readonly PlaneLike[], p: Vec3): boolean {
  for (const pl of planes) {
    if (dot(pl.normal, p) + pl.constant < 0) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ 输入形态 */

/** 平面裁剪：法线指向保留的一侧，切掉另一侧 */
export interface ClipPlaneOptions {
  type: 'plane';
  /** 指向保留侧的法线（不必单位化） */
  normal: Vec3;
  /** 平面过的一个点 */
  point: Vec3;
}

/** Box 裁剪：保留盒内的部分 */
export interface ClipBoxOptions {
  type: 'box';
  /** 对角点（顺序无所谓，内部会取 min/max） */
  a: Vec3;
  b: Vec3;
}

/**
 * 十字剖切：用两个竖直面切掉一个象限，露出两个互相垂直的剖面。
 *
 * `keepX` / `keepY` 指保留哪个方向：`1` 保留 +x 侧，`-1` 保留 -x 侧。
 * 加 `horizontal: true` 再多一个水平面，变成「切掉一个角」的三面剖切。
 */
export interface ClipCrossOptions {
  type: 'cross';
  center: Vec3;
  keepX: 1 | -1;
  keepY: 1 | -1;
  /** 是否再叠一个水平面（在 center.z 处切掉上方），默认 false */
  horizontal?: boolean;
  /** 水平面保留哪一侧：`1` 保留上方，`-1` 保留下方，默认 -1 */
  keepZ?: 1 | -1;
}

export type ClipOptions = ClipPlaneOptions | ClipBoxOptions | ClipCrossOptions;

/* ------------------------------------------------------------------ 生成 */

export function planeClipping(opt: Omit<ClipPlaneOptions, 'type'>): PlaneLike[] {
  return [planeFromPointNormal(opt.normal, opt.point)];
}

export function boxClipping(opt: Omit<ClipBoxOptions, 'type'>): PlaneLike[] {
  const min: Vec3 = [
    Math.min(opt.a[0], opt.b[0]),
    Math.min(opt.a[1], opt.b[1]),
    Math.min(opt.a[2], opt.b[2]),
  ];
  const max: Vec3 = [
    Math.max(opt.a[0], opt.b[0]),
    Math.max(opt.a[1], opt.b[1]),
    Math.max(opt.a[2], opt.b[2]),
  ];
  // 六个面，法线一律朝盒内 —— 六个半空间求交就是「盒内」
  return [
    { normal: [1, 0, 0], constant: -min[0] },
    { normal: [-1, 0, 0], constant: max[0] },
    { normal: [0, 1, 0], constant: -min[1] },
    { normal: [0, -1, 0], constant: max[1] },
    { normal: [0, 0, 1], constant: -min[2] },
    { normal: [0, 0, -1], constant: max[2] },
  ];
}

export function crossClipping(opt: Omit<ClipCrossOptions, 'type'>): PlaneLike[] {
  const planes: PlaneLike[] = [
    planeFromPointNormal([opt.keepX, 0, 0], opt.center),
    planeFromPointNormal([0, opt.keepY, 0], opt.center),
  ];
  if (opt.horizontal) {
    planes.push(planeFromPointNormal([0, 0, opt.keepZ ?? -1], opt.center));
  }
  return planes;
}

/** 统一入口：把交互输入翻成半空间列表 */
export function buildClipPlanes(opt: ClipOptions): PlaneLike[] {
  switch (opt.type) {
    case 'plane':
      return planeClipping(opt);
    case 'box':
      return boxClipping(opt);
    case 'cross':
      return crossClipping(opt);
  }
}
