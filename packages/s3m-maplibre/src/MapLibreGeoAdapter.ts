/**
 * MapLibre / Mapbox 宿主适配
 *
 * 把宿主地图的「世界坐标」能力包装成 s3m-three 的 `GeoAdapter` 接口：
 * 1. 从 map.transform / painter / getProjection 里提取 WorldCoordinateHelper
 *    （自动适配 MapLibre v5+ CRS 体系与自定义投影、平面直角坐标系）；
 * 2. 提不到就回退到标准 Web 墨卡托（MapLibre v4 / Mapbox 的世界坐标就是墨卡托）。
 *
 * 这里只放 MapLibre 相关的东西：鸭子类型的 MapLike、鼠标事件、helper 提取。
 * 纯 three 宿主不需要这个文件 —— 直接用 GeoAdapter 的墨卡托兜底，
 * 或自己实现一个 GeoAdapter 即可。
 */
import type { GeoAdapter } from 's3m-three';

/** MapLibre 默认垂直视场角（弧度） */
export const DEFAULT_FOV = 0.6435011087932844;

/** 宿主地图 WorldCoordinateHelper 用到的子集（MapLibre v5+ / Mapbox） */
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
  /** 上下文恢复后用于把自定义图层重新加回地图（MapLibre / Mapbox 都有） */
  getLayer?(id: string): unknown;
  addLayer?(layer: unknown): unknown;
  removeLayer?(id: string): unknown;
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

/**
 * 把宿主地图包装成 s3m-three 的 GeoAdapter。
 * 拿不到 WorldCoordinateHelper 时返回 null，由渲染层回退到标准 Web 墨卡托。
 */
export function createMapLibreGeoAdapter(map: MapLike | null): GeoAdapter | null {
  const helper = extractWorldCoordinateHelper(map);
  if (!helper) return null;
  return {
    worldFromLngLat(lng: number, lat: number, altitude = 0) {
      const coord = helper.worldFromLngLat(lng, lat, altitude);
      let s = 0;
      if (typeof helper.metersPerWorldUnit === 'function') {
        const mpw = helper.metersPerWorldUnit(coord.x, coord.y);
        if (Number.isFinite(mpw) && mpw > 0) s = 1 / mpw;
      }
      if (s === 0) {
        // 用 +1 米的差分反推尺度；z 不动（某些 CRS 的 z 不是米）就退回墨卡托近似
        const c1 = helper.worldFromLngLat(lng, lat, altitude + 1);
        const dz = Math.abs((c1.z ?? 0) - (coord.z ?? 0));
        const sinLat = Math.sin((lat * Math.PI) / 180);
        s = dz > 0 ? dz : 1 / (2 * Math.PI * 6378137) / Math.cos((lat * Math.PI) / 180);
      }
      return {
        x: coord.x,
        y: coord.y,
        z: coord.z ?? altitude * s,
        meterInMercator: s,
        altitude,
      };
    },
    lngLatFromWorld(x: number, y: number): [number, number] {
      const res = helper.lngLatFromWorld(x, y);
      if (Array.isArray(res)) return [res[0], res[1]];
      if (res && typeof res.lng === 'number' && typeof res.lat === 'number') {
        return [res.lng, res.lat];
      }
      return [0, 0];
    },
  };
}
