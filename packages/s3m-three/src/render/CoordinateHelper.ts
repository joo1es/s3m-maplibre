/**
 * 坐标系与宿主地图适配工具
 *
 * 负责：
 * 1. 经纬度 <-> Web 墨卡托归一化坐标转换
 * 2. 宿主地图（MapLibre / Mapbox）的 WorldCoordinateHelper 适配（支持自定义投影、平面直角坐标系等）
 * 3. 宿主事件与能力抽象接口
 */

export const EARTH_RADIUS = 6378137;
export const DEFAULT_FOV = 0.6435011087932844; // MapLibre 默认垂直视场角

export interface WorldCoordinateHelperLike {
  name?: string;
  worldFromLngLat(lng: number, lat: number, altitude?: number): { x: number; y: number; z?: number };
  lngLatFromWorld(x: number, y: number): { lng: number; lat: number } | [number, number];
  metersPerWorldUnit?(x: number, y: number): number;
}

/** 宿主地图上我们真正用到的能力，MapLibre / Mapbox 的交集 */
export interface MapLike {
  getCanvas(): HTMLCanvasElement;
  triggerRepaint(): void;
  on(type: string, listener: (e: MapMouseEventLike) => void): unknown;
  off(type: string, listener: (e: MapMouseEventLike) => void): unknown;
  getBearing?(): number;
  getFreeCameraOptions?(): { position?: { x: number; y: number; z: number } | null } | null;
  /** 注意 fov 在 MapLibre v5 起是「度」，v4 / Mapbox 是「弧度」；弧度用 fovInRadians */
  transform?: {
    fov?: number;
    fovInRadians?: number;
    cameraToCenterDistance?: number;
    worldCoordinateHelper?: unknown;
    projection?: { worldCoordinateHelper?: unknown };
  };
  getProjection?(): unknown;
}

export interface MapMouseEventLike {
  originalEvent?: { clientX: number; clientY: number };
  point?: { x: number; y: number };
}

/**
 * 从宿主地图中提取 WorldCoordinateHelper（自动适配 MapLibre v5+ CRS 体系与自定义投影）
 */
export function extractWorldCoordinateHelper(map: unknown): WorldCoordinateHelperLike | null {
  const m = map as {
    transform?: {
      worldCoordinateHelper?: unknown;
      projection?: { worldCoordinateHelper?: unknown };
    };
    painter?: {
      transform?: {
        worldCoordinateHelper?: unknown;
      };
    };
    getProjection?(): { worldCoordinateHelper?: unknown } | unknown;
  };

  const helper = (
    m?.transform?.worldCoordinateHelper ??
    m?.transform?.projection?.worldCoordinateHelper ??
    m?.painter?.transform?.worldCoordinateHelper ??
    (typeof m?.getProjection === 'function' ? (m.getProjection() as any)?.worldCoordinateHelper : null) ??
    null
  ) as WorldCoordinateHelperLike | null;

  if (helper && typeof helper.worldFromLngLat === 'function' && typeof helper.lngLatFromWorld === 'function') {
    return helper;
  }
  return null;
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
 * 优先使用宿主 map 的 WorldCoordinateHelper（自动适配 MapLibre v5+ 任意 CRS），
 * 若宿主未就绪或为老版本则平滑回退至标准 Web 墨卡托。
 */
export function worldFromLngLat(
  map: MapLike | null,
  lon: number,
  lat: number,
  altitude = 0
): { x: number; y: number; z: number; meterInMercator: number; altitude: number } {
  const helper = extractWorldCoordinateHelper(map);
  if (helper) {
    const coord = helper.worldFromLngLat(lon, lat, altitude);
    let s = 0;
    if (typeof helper.metersPerWorldUnit === 'function') {
      const mpw = helper.metersPerWorldUnit(coord.x, coord.y);
      if (Number.isFinite(mpw) && mpw > 0) s = 1 / mpw;
    }
    if (s === 0) {
      const c1 = helper.worldFromLngLat(lon, lat, altitude + 1);
      const dz = Math.abs((c1.z ?? 0) - (coord.z ?? 0));
      s = dz > 0 ? dz : mercatorFromLngLat(lon, lat, altitude).meterInMercator;
    }
    return {
      x: coord.x,
      y: coord.y,
      z: coord.z ?? altitude * s,
      meterInMercator: s,
      altitude,
    };
  }
  return mercatorFromLngLat(lon, lat, altitude);
}

/**
 * 归一化世界坐标 → 经纬度 [lng, lat]
 */
export function lngLatFromWorld(map: MapLike | null, x: number, y: number): [number, number] {
  const helper = extractWorldCoordinateHelper(map);
  if (helper) {
    const res = helper.lngLatFromWorld(x, y);
    if (Array.isArray(res)) return [res[0], res[1]];
    if (res && typeof res.lng === 'number' && typeof res.lat === 'number') {
      return [res.lng, res.lat];
    }
  }
  return lngLatFromMercator(x, y);
}
