/**
 * 逐顶点烘焙精确 Web 墨卡托（Issue #15）。
 *
 * 背景：
 * 传统单锚点切平面使用常量 s = meterInMercator 缩放整个场景。
 * 但 Web 墨卡托在纬度方向不是线性的（比例随纬度变化），大跨度单瓦片（几公里到几百公里）
 * 内部由于顶点相对距离失真，在相机倾斜、平移推拉时会产生视差游动（呼吸效应）。
 *
 * 做法：
 * 在 decode / 几何组装阶段，为每个顶点烘焙相对瓦片墨卡托原点的精确墨卡托坐标（f32）。
 * 相对瓦片原点存储保证在 100km 尺度下的量化误差 < 1cm（远优于全局 f32 的米级抖动）。
 */
import { mercatorFromLngLat, EARTH_RADIUS } from '../render/GeoAdapter.js';

const R = EARTH_RADIUS;
const DEG = Math.PI / 180;

/** 自动启用 Web 墨卡托烘焙的半径阈值（米）：根节点或瓦片半径大于 25 km 时自动开启 */
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

export interface BakedMercatorResult {
  tileMercOrigin: { x: number; y: number; z: number };
  offsets: Float32Array;
}

/**
 * 局部 ENU 米坐标 → 经纬度（球面模型，与 mercatorFromLngLat 一致）
 */
export function enuToLngLat(
  anchorLon: number,
  anchorLat: number,
  east: number,
  north: number
): [number, number] {
  const latRad = anchorLat * DEG + north / R;
  const cosLat = Math.cos(latRad);
  const dLon = Math.abs(cosLat) < 1e-12 ? 0 : east / (R * cosLat);
  return [anchorLon + dLon / DEG, latRad / DEG];
}

/**
 * 逐顶点烘焙精确墨卡托偏移
 */
export function bakeMercatorOffsets(
  positions: ArrayLike<number>,
  vertexCount: number,
  anchor: TileAnchorLike,
  tileCenter?: TileCenterLike | null,
  matrix?: ArrayLike<number> | null
): BakedMercatorResult {
  // 瓦片原点墨卡托坐标（以中心为基准）
  const cx = tileCenter?.x ?? 0;
  const cy = tileCenter?.y ?? 0;
  const cz = tileCenter?.z ?? 0;
  const ah = anchor.height ?? 0;
  const [tileLon, tileLat] = enuToLngLat(anchor.lon, anchor.lat, cx, cy);
  const tileMerc = mercatorFromLngLat(tileLon, tileLat, ah + cz);

  const offsets = new Float32Array(vertexCount * 3);

  for (let i = 0; i < vertexCount; i++) {
    let vx = positions[i * 3]!;
    let vy = positions[i * 3 + 1]!;
    let vz = positions[i * 3 + 2]!;

    if (matrix) {
      const x = matrix[0]! * vx + matrix[4]! * vy + matrix[8]! * vz + matrix[12]!;
      const y = matrix[1]! * vx + matrix[5]! * vy + matrix[9]! * vz + matrix[13]!;
      const z = matrix[2]! * vx + matrix[6]! * vy + matrix[10]! * vz + matrix[14]!;
      vx = x;
      vy = y;
      vz = z;
    }

    const [vLon, vLat] = enuToLngLat(anchor.lon, anchor.lat, vx, vy);
    const vMerc = mercatorFromLngLat(vLon, vLat, ah + vz);

    offsets[i * 3] = vMerc.x - tileMerc.x;
    offsets[i * 3 + 1] = vMerc.y - tileMerc.y;
    offsets[i * 3 + 2] = vMerc.z - tileMerc.z;
  }

  return {
    tileMercOrigin: { x: tileMerc.x, y: tileMerc.y, z: tileMerc.z },
    offsets,
  };
}

/**
 * 墨卡托空间法线适配：
 * 由于墨卡托 Y 轴朝南（与 ENU 北向相反），且墨卡托为保角投影，
 * 法向量在墨卡托参考系下仅需对 Y 分量取反并归一化。
 */
export function bakeMercatorNormals(
  normals: ArrayLike<number>,
  vertexCount: number
): Float32Array {
  const out = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const nx = normals[i * 3]!;
    const ny = -normals[i * 3 + 1]!;
    const nz = normals[i * 3 + 2]!;
    const len = Math.hypot(nx, ny, nz) || 1;
    out[i * 3] = nx / len;
    out[i * 3 + 1] = ny / len;
    out[i * 3 + 2] = nz / len;
  }
  return out;
}
