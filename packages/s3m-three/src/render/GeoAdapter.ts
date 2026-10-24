/**
 * 地理坐标适配器（宿主无关）
 *
 * S3M 顶点是数据集局部 ENU 米制坐标，最终要落到宿主的「世界坐标」体系里
 * （MapLibre 的 Web 墨卡托归一化坐标、纯 three 场景的局部坐标……）。
 * 这个文件只定义接口与默认实现，不依赖任何宿主：
 *
 *   - `GeoAdapter`       —— 宿主需要提供的两个转换函数
 *   - `mercatorFromLngLat` / `lngLatFromMercator` —— 标准 Web 墨卡托换算
 *   - `worldFromLngLat` / `lngLatFromWorld` —— 带兜底的封装：
 *       有 adapter 用 adapter（自动适配 MapLibre v5+ 任意 CRS / 自定义投影），
 *       没有就平滑回退到标准 Web 墨卡托。
 *
 * MapLibre / Mapbox 的 adapter 实现见 s3m-maplibre 包的 MapLibreGeoAdapter.ts。
 */

export const EARTH_RADIUS = 6378137;

/** 宿主地理坐标系能力：S3M 渲染层用到的就只有这两个方向 */
export interface GeoAdapter {
  /** 经纬度 + 高程 → 归一化世界坐标，并给出「1 米 = 多少世界单位」 */
  worldFromLngLat(
    lng: number,
    lat: number,
    altitude?: number
  ): { x: number; y: number; z: number; meterInMercator: number; altitude: number };
  /** 归一化世界坐标 → 经纬度 [lng, lat] */
  lngLatFromWorld(x: number, y: number): [number, number];
}

/** 经纬度 → 墨卡托归一化坐标（世界为 1×1）—— 默认墨卡托兜底 */
export function mercatorFromLngLat(
  lon: number,
  lat: number,
  altitude = 0
): { x: number; y: number; z: number; meterInMercator: number; altitude: number } {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const x = (180 + lon) / 360;
  const y = 0.5 - (0.25 * Math.log((1 + sinLat) / (1 - sinLat))) / Math.PI;
  const meterInMercator = 1 / (2 * Math.PI * EARTH_RADIUS) / Math.cos((lat * Math.PI) / 180);
  return { x, y, z: altitude * meterInMercator, meterInMercator, altitude };
}

/** 墨卡托归一化坐标 → 经纬度 —— 默认墨卡托兜底 */
export function lngLatFromMercator(x: number, y: number): [number, number] {
  const lon = x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * 经纬度 + 高程 → 归一化世界坐标与尺度换算。
 * 优先使用宿主 adapter（自动适配 MapLibre v5+ 任意 CRS），
 * 若宿主未就绪或为老版本则平滑回退至标准 Web 墨卡托。
 */
export function worldFromLngLat(
  adapter: GeoAdapter | null,
  lon: number,
  lat: number,
  altitude = 0
): { x: number; y: number; z: number; meterInMercator: number; altitude: number } {
  if (adapter) return adapter.worldFromLngLat(lon, lat, altitude);
  return mercatorFromLngLat(lon, lat, altitude);
}

/**
 * 归一化世界坐标 → 经纬度 [lng, lat]
 */
export function lngLatFromWorld(adapter: GeoAdapter | null, x: number, y: number): [number, number] {
  if (adapter) return adapter.lngLatFromWorld(x, y);
  return lngLatFromMercator(x, y);
}
