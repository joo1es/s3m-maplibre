/**
 * 全球大尺度精确 Web 墨卡托烘焙（issue #15）。
 *
 * ## 背景与原理
 *
 * S3M 场景通常只有一个切平面：`_enuMatrix` 用场景锚点纬度的常量 `meterInMercator`
 * 把整个场景缩放进 Web 墨卡托。但在跨度超过几十公里的全球或大区域场景中，
 * 墨卡托投影比例随纬度变化（k = 1 / cos(φ)）。
 * 即使有 `perTilePlacement`（issue #12）按瓦片重置了原点与缩放，瓦片内部仍然存在
 * 线性切平面与真实墨卡托投影之间的微小残差。
 *
 * 烘焙方案：
 * 1. 预先或在组装瓦片几何时，逐顶点计算其精确的 Web 墨卡托坐标；
 * 2. 减去瓦片中心的精确墨卡托坐标，得到相对于瓦片中心的相对偏移量 `aMercatorOffset`（float32）；
 * 3. 为什么是相对偏移：
 *    Web 墨卡托全局坐标在 0..1 之间，若直接用 float32（24 位尾数）存储绝对坐标，
 *    分辨率约为 40000000 / 2^24 ≈ 2.38 米；
 *    若改为相对瓦片中心（瓦片半径通常 <= 100 km），float32 尾数精度可达：
 *    100000 / 2^24 ≈ 0.0059 米（小于 6 毫米），常规 2 km 瓦片下更是达到 0.1 毫米以内。
 * 4. 着色器重构：
 *    顶点着色器在局部对象空间中还原出抵消瓦片尺度与中心平移后的坐标：
 *    `transformed = uTilePivot + vec3(aMercatorOffset.x, -aMercatorOffset.y, aMercatorOffset.z) * uInvTileScale;`
 *    其中 `uInvTileScale = 1 / (sScene * k) = 1 / sTile`。
 *    经过瓦片矩阵变换与 `_enuMatrix` 缩放平移后，刚好恒等于真实的世界墨卡托坐标，误差 < 1 cm。
 */

import {
  EARTH_RADIUS,
  enuToLngLat as geoEnuToLngLat,
  mercatorFromLngLat,
} from '../render/GeoAdapter.js';

/** 超过此半径（米）的瓦片在未指定参数时自动开启墨卡托烘焙（25 km） */
export const AUTO_BAKE_RADIUS_THRESHOLD = 25000;

export interface TileAnchorLike {
  lon: number;
  lat: number;
  height?: number;
}

export interface TileCenterLike {
  x: number;
  y: number;
  z?: number;
}

/**
 * 局部 ENU 偏移（东, 北 米）→ 经纬度（对接 GeoAdapter 的 WGS84 高精度模型）。
 */
export function enuToLngLat(anchor: TileAnchorLike, east: number, north: number): [number, number] {
  return geoEnuToLngLat(anchor.lon, anchor.lat, east, north);
}

/**
 * 逐顶点计算 Web 墨卡托相对于瓦片中心的偏移量。
 *
 * @param positions 顶点位置数组（x, y, z...）
 * @param vertexCount 顶点数
 * @param tileAnchor 数据集/瓦片地理锚点
 * @param tileCenter 瓦片中心在数据集局部 ENU 中的位置（米）
 * @param stride 每个顶点的分量数（默认为 3）
 * @param target 可选的复用 Float32Array
 * @returns 长度为 vertexCount * 3 的 Float32Array，存 [dx, dy, dz, ...]
 */
export function bakeMercatorOffsets(
  positions: ArrayLike<number>,
  vertexCount: number,
  tileAnchor: TileAnchorLike,
  tileCenter: TileCenterLike,
  stride = 3,
  target?: Float32Array
): Float32Array {
  const out = target && target.length >= vertexCount * 3 ? target : new Float32Array(vertexCount * 3);

  const centerAlt = (tileAnchor.height ?? 0) + (tileCenter.z ?? 0);
  const [centerLon, centerLat] = enuToLngLat(tileAnchor, tileCenter.x, tileCenter.y);
  const cMerc = mercatorFromLngLat(centerLon, centerLat, centerAlt);

  for (let i = 0; i < vertexCount; i++) {
    const idx = i * stride;
    const vx = positions[idx];
    const vy = positions[idx + 1];
    const vz = positions[idx + 2] ?? 0;

    const vAlt = (tileAnchor.height ?? 0) + vz;
    const [vLon, vLat] = enuToLngLat(tileAnchor, vx, vy);
    const vMerc = mercatorFromLngLat(vLon, vLat, vAlt);

    out[i * 3 + 0] = vMerc.x - cMerc.x;
    out[i * 3 + 1] = vMerc.y - cMerc.y;
    out[i * 3 + 2] = vMerc.z - cMerc.z;
  }

  return out;
}
