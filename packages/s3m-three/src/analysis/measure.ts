/**
 * 量算：距离 / 折线长 / 面积 / 高差。
 *
 * 全部是纯函数，输入输出都是**场景 ENU 米制坐标**（three 世界坐标），
 * 不依赖 three、不依赖 WebGL，可以直接单测。
 *
 * 经纬度 ↔ ENU 的换算在 `S3MViewer` 里做（需要 `sceneAnchor` 与 `GeoAdapter`），
 * 这一层只管算数 —— 这样投影口径变化不会污染数学。
 */

/** 场景 ENU 米制坐标（three 世界坐标） */
export type Vec3 = [number, number, number];

/** 经纬度 + 绝对高程（米） */
export interface LngLatAlt {
  lng: number;
  lat: number;
  /** 绝对高程（米），不是相对场景锚点的高度 */
  altitude: number;
}

export function distance3D(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 水平距离（忽略高程差）—— 规划类口径常用 */
export function distanceHorizontal(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** 高差（有符号：b 比 a 高为正） */
export function heightDifference(a: Vec3, b: Vec3): number {
  return b[2] - a[2];
}

/** 折线长度（逐段求和）；点少于 2 个返回 0 */
export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance3D(points[i - 1], points[i]);
  return total;
}

/** 折线水平投影长度 */
export function polylineLengthHorizontal(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceHorizontal(points[i - 1], points[i]);
  return total;
}

/** 多边形周长（首尾自动闭合，不要重复传首点） */
export function polygonPerimeter(points: readonly Vec3[]): number {
  if (points.length < 2) return 0;
  return polylineLength(points) + distance3D(points[points.length - 1], points[0]);
}

/**
 * 多边形面积（Newell 法）。
 *
 * 对**共面**点给出真实面积；对起伏/不共面的点给出「投影到最佳拟合平面」的面积，
 * 这也是绝大多数量算工具的口径。要水平投影面积用 `polygonAreaHorizontal`。
 *
 * 与点的绕向无关（取向量模长），所以不用担心用户顺时针还是逆时针点。
 */
export function polygonArea(points: readonly Vec3[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

/**
 * 水平投影面积（鞋带公式，忽略高程）。
 *
 * 与 `polygonArea` 的区别：一个坡面上的矩形，`polygonArea` 给坡面真实面积，
 * 这里给它在水平面上的投影面积。建筑面积/用地面积按后者算。
 */
export function polygonAreaHorizontal(points: readonly Vec3[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

/** 量算结果：一次给全三种口径，避免调用方自己再算一遍 */
export interface MeasureResult {
  /** 三维直线距离（米） */
  distance3D: number;
  /** 水平距离（米） */
  distanceHorizontal: number;
  /** 高差（米，有符号） */
  heightDiff: number;
}

export function measureSegment(a: Vec3, b: Vec3): MeasureResult {
  return {
    distance3D: distance3D(a, b),
    distanceHorizontal: distanceHorizontal(a, b),
    heightDiff: heightDifference(a, b),
  };
}
