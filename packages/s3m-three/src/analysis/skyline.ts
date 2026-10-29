/**
 * 天际线：从一张「从相机看出去」的深度图，按列抽出天际线曲线。
 *
 * 为什么是「按列」：天际线在屏幕上就是每列最上面那个几何像素的轮廓。
 * 所以不需要额外的几何体 —— 一次深度 pass + 一次逐列扫描就够了，
 * 结果直接是一串（方位角，仰角），画成 2D 曲线比生成 3D 多边形便宜得多。
 *
 * 只做数学，不碰 WebGL：深度图由 `render/analysis/DepthPass` 产出。
 */
import { azimuthElevation, pixelToNdc, unpackRGBADepth, unprojectNdc } from './depth.js';
import type { Vec3 } from './measure.js';

export interface SkylineArgs {
  /** RGBA8 深度图（three 的 RGBADepthPacking） */
  rgba: ArrayLike<number>;
  width: number;
  height: number;
  /** 视图投影矩阵的逆（列主序，与 `THREE.Matrix4.elements` 同序） */
  inverseViewProj: ArrayLike<number>;
  /** 相机在场景 ENU 里的位置 */
  cameraPos: Vec3;
  /**
   * 背景判定阈值：深度 >= 它的像素视为天空（默认 0.9999）。
   * 用 0.9999 而不是 1：远处地平线可能因为精度落在 0.99999 上。
   */
  skyDepth?: number;
  /** 每隔多少列取一次（默认 1，即逐列） */
  step?: number;
}

export interface SkylineResult {
  /** 方位角（度，0 = 正北，顺时针），长度 = ceil(width / step) */
  azimuths: Float32Array;
  /** 对应列的仰角（度，0 = 水平） */
  elevations: Float32Array;
  /** 整条天际线的最大仰角（度） */
  maxElevation: number;
  /** 最小仰角（度）；全是天空时为 0 */
  minElevation: number;
  /** 没有几何、直通天空的列占比（0~1）—— 开敞度的最粗口径 */
  openRatio: number;
  /**
   * 每列天际线在**屏幕上的位置**（归一化 0~1，左上角为原点），
   * 布局是 `[x0, y0, x1, y1, …]`，长度 = `cols * 2`。
   *
   * 这是画「地图上的天际线」最直接的输入：深度图本来就是屏幕空间的东西，
   * 换算成角度只是为了给人看，换算回去还会多一次投影误差。
   * 归一化是为了让调用方按自己的画布尺寸缩放（捕获分辨率可以比画布小）。
   */
  screen: Float32Array;
  /**
   * 每列是否有几何（1 = 有，0 = 纯天空）。
   *
   * 画线时要在这里断开：把纯天空的列也连进去，线会横穿天空，
   * 看起来像天际线突然掉到画面底部。
   */
  hasGeometry: Uint8Array;
}

/**
 * 逐列取「最上面的几何像素」，反投影成世界坐标后换算成仰角，
 * 同时记下该像素的归一化屏幕位置（给「在地图上描线」用）。
 *
 * 没有几何的列记 0°（地平线）并计入 `openRatio`，而不是记 -90°：
 * 天际线曲线在地平线处收口，画图时不会突然掉到画面底部。
 */
export function skylineFromDepth(args: SkylineArgs): SkylineResult {
  const { rgba, width, height, inverseViewProj, cameraPos } = args;
  const skyDepth = args.skyDepth ?? 0.9999;
  const step = Math.max(1, Math.floor(args.step ?? 1));
  const cols = Math.ceil(width / step);

  const azimuths = new Float32Array(cols);
  const elevations = new Float32Array(cols);
  const screen = new Float32Array(cols * 2);
  const hasGeometry = new Uint8Array(cols);
  let maxElevation = -90;
  let minElevation = 90;
  let open = 0;

  for (let c = 0; c < cols; c++) {
    const x = Math.min(width - 1, c * step);
    let found = false;
    for (let y = 0; y < height; y++) {
      const off = (y * width + x) * 4;
      const depth = unpackRGBADepth(rgba, off);
      if (depth >= skyDepth) continue;

      const [ndcX, ndcY] = pixelToNdc(x, y, width, height);
      const p = unprojectNdc(ndcX, ndcY, depth, inverseViewProj);
      const { azimuth, elevation } = azimuthElevation(cameraPos, p);
      azimuths[c] = azimuth;
      elevations[c] = elevation;
      // 像素中心归一化：与捕获图同尺度，调用方乘自己的画布尺寸即可
      screen[c * 2] = (x + 0.5) / width;
      screen[c * 2 + 1] = (y + 0.5) / height;
      hasGeometry[c] = 1;
      if (elevation > maxElevation) maxElevation = elevation;
      if (elevation < minElevation) minElevation = elevation;
      found = true;
      break;
    }
    if (!found) {
      // 这一列没有几何：天际线落在水平线上
      open++;
      azimuths[c] = 0;
      elevations[c] = 0;
      screen[c * 2] = (x + 0.5) / width;
      screen[c * 2 + 1] = 1; // 贴到画面底部，画线时按 hasGeometry 断开
      hasGeometry[c] = 0;
      if (0 > maxElevation) maxElevation = 0;
      if (0 < minElevation) minElevation = 0;
    }
  }

  return {
    azimuths,
    elevations,
    maxElevation,
    minElevation,
    openRatio: cols > 0 ? open / cols : 0,
    screen,
    hasGeometry,
  };
}
