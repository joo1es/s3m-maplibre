/**
 * 地理坐标适配器（宿主无关）
 *
 * S3M 顶点是数据集局部 ENU 米制坐标，最终要落到宿主的「世界坐标」体系里
 * （MapLibre 的 Web 墨卡托归一化坐标、纯 three 场景的局部坐标……）。
 * 这个文件只定义接口与默认实现，不依赖任何宿主：
 *
 *   - `GeoAdapter`       —— 宿主需要提供的两个转换函数
 *   - `mercatorFromLngLat` / `lngLatFromMercator` —— 标准 Web 墨卡托换算（WGS84 椭球）
 *   - `worldFromLngLat` / `lngLatFromWorld` —— 带兜底的封装：
 *       有 adapter 用 adapter（自动适配 MapLibre v5+ 任意 CRS / 自定义投影），
 *       没有就平滑回退到标准 Web 墨卡托。
 *   - `enuToLngLat` / `lngLatToEnu` —— WGS84 椭球高精度局部坐标互转
 *
 * MapLibre / Mapbox 的 adapter 实现见 s3m-maplibre 包的 MapLibreGeoAdapter.ts。
 */

/** WGS84 椭球长半轴 a（米） */
export const WGS84_A = 6378137.0;
/** WGS84 椭球扁率 f */
export const WGS84_F = 1 / 298.257223563;
/** WGS84 椭球短半轴 b（米） */
export const WGS84_B = WGS84_A * (1 - WGS84_F);
/** WGS84 椭球第一偏心率平方 e² = 2f - f² ≈ 0.0066943799901413165 */
export const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;

/** 保持向下兼容：EARTH_RADIUS 对应 WGS84 长半轴 */
export const EARTH_RADIUS = WGS84_A;

/**
 * 卯酉圈曲率半径 N(φ) = a / √(1 - e² sin²φ)（米）
 */
export function primeVerticalRadius(latRad: number): number {
  const sin = Math.sin(latRad);
  return WGS84_A / Math.sqrt(1 - WGS84_E2 * sin * sin);
}

/**
 * 子午圈曲率半径 M(φ) = a(1 - e²) / (1 - e² sin²φ)^(3/2)（米）
 */
export function meridianRadius(latRad: number): number {
  const sin = Math.sin(latRad);
  const w2 = 1 - WGS84_E2 * sin * sin;
  return (WGS84_A * (1 - WGS84_E2)) / (w2 * Math.sqrt(w2));
}

/**
 * 局部 ENU 米坐标 (east, north) → 经纬度 [lon, lat] (度)
 * 基于 WGS84 椭球中点曲率半径反解，在 100 km 范围内误差 < 1 cm。
 */
export function enuToLngLat(
  anchorLon: number,
  anchorLat: number,
  east: number,
  north: number
): [number, number] {
  const lat0 = (anchorLat * Math.PI) / 180;
  const M0 = meridianRadius(lat0);
  // 中点迭代一步：在数百公里尺度即可将纬度子午线积分误差压到亚毫米
  const dLatApprox = north / M0;
  const latMid = lat0 + dLatApprox * 0.5;
  const M_mid = meridianRadius(latMid);
  const latRad = lat0 + north / M_mid;

  const N_lat = primeVerticalRadius(latRad);
  const cosLat = Math.cos(latRad);
  const dLon = Math.abs(cosLat) < 1e-12 ? 0 : east / (N_lat * cosLat);

  return [anchorLon + (dLon * 180) / Math.PI, (latRad * 180) / Math.PI];
}

/**
 * 经纬度 (lon, lat) → 局部 ENU 米坐标 [east, north]
 * enuToLngLat 的逆运算。
 */
export function lngLatToEnu(
  anchorLon: number,
  anchorLat: number,
  lon: number,
  lat: number
): [number, number] {
  const lat0 = (anchorLat * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const latMid = (lat0 + lat1) * 0.5;
  const north = (lat1 - lat0) * meridianRadius(latMid);

  const N_lat = primeVerticalRadius(lat1);
  const cosLat = Math.cos(lat1);
  const dLon = ((lon - anchorLon) * Math.PI) / 180;
  const east = dLon * N_lat * cosLat;

  return [east, north];
}

/** 坐标转换结果类型 */
export interface WorldCoordinateResult {
  x: number;
  y: number;
  z: number;
  /** 东向：1 米 = 多少世界单位 (Web Mercator 东西向尺度 1 / (2π N cosφ)) */
  meterInMercatorEast: number;
  /** 北向：1 米 = 多少世界单位 (Web Mercator 南北向尺度 1 / (2π M cosφ)) */
  meterInMercatorNorth: number;
  /** 竖向（高程）：1 米 = 多少世界单位（当前取东向尺度 meterInMercatorEast，以保持局部长方体水平与竖直比例） */
  meterInMercatorUp: number;
  /** 兼容旧代码：等同于 meterInMercatorEast。注意：从原先的正球近似更新为更精准的 WGS84 椭球东向尺度 */
  meterInMercator: number;
  altitude: number;
}

/** 宿主地理坐标系能力：S3M 渲染层用到的就只有这两个方向 */
export interface GeoAdapter {
  /** 经纬度 + 高程 → 归一化世界坐标，并给出「1 米 = 多少世界单位」（含各向异性 East / North） */
  worldFromLngLat(
    lng: number,
    lat: number,
    altitude?: number
  ): WorldCoordinateResult;
  /** 归一化世界坐标 → 经纬度 [lng, lat] */
  lngLatFromWorld(x: number, y: number): [number, number];
}

/** 经纬度 → 墨卡托归一化坐标（世界为 1×1）—— 默认墨卡托兜底（WGS84 椭球曲率半径与各向异性尺度） */
export function mercatorFromLngLat(
  lon: number,
  lat: number,
  altitude = 0
): WorldCoordinateResult {
  const latRad = (lat * Math.PI) / 180;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const safeCosLat = Math.max(Math.abs(cosLat), 1e-12);

  const x = (180 + lon) / 360;
  const y = 0.5 - (0.25 * Math.log((1 + sinLat) / (1 - sinLat))) / Math.PI;

  const N = primeVerticalRadius(latRad);
  const M = meridianRadius(latRad);

  const meterInMercatorEast = 1 / (2 * Math.PI * N * safeCosLat);
  const meterInMercatorNorth = 1 / (2 * Math.PI * M * safeCosLat);
  const meterInMercatorUp = meterInMercatorEast;

  return {
    x,
    y,
    z: altitude * meterInMercatorUp,
    meterInMercatorEast,
    meterInMercatorNorth,
    meterInMercatorUp,
    meterInMercator: meterInMercatorEast,
    altitude,
  };
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
): WorldCoordinateResult {
  if (adapter) {
    const res = adapter.worldFromLngLat(lon, lat, altitude);
    const east = res.meterInMercatorEast ?? res.meterInMercator;
    const north = res.meterInMercatorNorth ?? res.meterInMercator ?? east;
    const up = res.meterInMercatorUp ?? east;
    const legacy = res.meterInMercator ?? east;
    return {
      x: res.x,
      y: res.y,
      z: res.z,
      meterInMercatorEast: east,
      meterInMercatorNorth: north,
      meterInMercatorUp: up,
      meterInMercator: legacy,
      altitude: res.altitude,
    };
  }
  return mercatorFromLngLat(lon, lat, altitude);
}

/**
 * 归一化世界坐标 → 经纬度 [lng, lat]
 */
export function lngLatFromWorld(adapter: GeoAdapter | null, x: number, y: number): [number, number] {
  if (adapter) return adapter.lngLatFromWorld(x, y);
  return lngLatFromMercator(x, y);
}
