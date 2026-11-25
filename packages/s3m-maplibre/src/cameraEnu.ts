/**
 * 从 MapLibre 的 `transform` 反算相机在数据集 ENU 中的位置。
 *
 * 为什么需要这个文件：maplibre-gl 5.x **没有** `map.getFreeCameraOptions()`
 * （d.ts 与运行时都搜不到），旧代码 `map.getFreeCameraOptions?.()?.position`
 * 永远拿到 undefined，于是 `camEnu` 恒为 `[0,0,0]` —— 所有瓦片的距离都变成
 * 「这块瓦片离数据集原点多远」，与相机彻底脱钩。表现就是拉远不回收、缩到哪都在
 * 请求子瓦片、材质永远不还给 GPU。
 *
 * 改用 `transform` 的公开字段反算。几何关系（俯视示意，bearing = 0 朝北）：
 *
 *           相机
 *            │  D = cameraToCenterDistance × metersPerPixel
 *            │
 *         ╭──┴──╮  ← D·sin(pitch) 水平后退
 *         │     │
 *         中心点  （相机看向这里，视线俯角 = pitch）
 *
 * 相机在中心点的**反向**：bearing = 0 时相机在南侧，所以 north 取减。
 */

/** 赤道周长（Web Mercator 的基准，与 transform.worldSize 同源） */
const EARTH_CIRCUMFERENCE = 40075016.686;

export interface CameraEnuInput {
  /** 地图中心在数据集 ENU 中的位置（米） */
  centerEnu: readonly [number, number, number];
  /** `transform.cameraToCenterDistance`，单位是屏幕像素 */
  cameraToCenterDistance: number;
  /** `transform.worldSize`，单位是屏幕像素（512 × 2^zoom） */
  worldSize: number;
  /** 中心点纬度（弧度），决定墨卡托的米/像素尺度 */
  latRad: number;
  /** 俯仰角（弧度） */
  pitchRad: number;
  /** 方位角（弧度），0 = 朝北 */
  bearingRad: number;
}

/**
 * 返回 `[east, north, up]`（米，相对数据集锚点）。
 *
 * 任何一项非法都退化成"相机就在中心点正上方 0 米"，不会抛错也不会产生 NaN ——
 * 这个函数每帧都会跑，崩一次就是整帧丢失。
 */
export function cameraEnuFromDistance(p: CameraEnuInput): [number, number, number] {
  const cx = p.centerEnu[0];
  const cy = p.centerEnu[1];
  const cz = p.centerEnu[2];

  // 米/像素：世界像素高度越大地图越"贴近"，单位像素对应的地面距离越小
  const metersPerPixel =
    Number.isFinite(p.worldSize) && p.worldSize > 0
      ? (EARTH_CIRCUMFERENCE * Math.cos(p.latRad)) / p.worldSize
      : 0;
  const distance =
    Number.isFinite(p.cameraToCenterDistance) && p.cameraToCenterDistance > 0
      ? p.cameraToCenterDistance * metersPerPixel
      : 0;

  const horiz = distance * Math.sin(p.pitchRad);

  return [
    cx - horiz * Math.sin(p.bearingRad),
    cy - horiz * Math.cos(p.bearingRad),
    cz + distance * Math.cos(p.pitchRad),
  ];
}

/** `map.transform` 里我们用到的那几个字段（MapLibre 5 全都有，且是公开 getter） */
export interface MapTransformLike {
  cameraToCenterDistance?: number;
  worldSize?: number;
  center?: { lng: number; lat: number };
  /** 度 */
  pitch?: number;
  /** 度 */
  bearing?: number;
}

export interface ResolveCameraEnuInput {
  transform: MapTransformLike | undefined;
  /** 场景锚点的世界坐标（与 `transform.center` 同一套墨卡托） */
  anchor: { x: number; y: number; altitude?: number };
  /** 1 米对应的墨卡托东向 / 北向单位数 */
  sEast: number;
  sNorth: number;
  /** 宿主的经纬度 → 世界坐标（拿不到就退回标准 Web Mercator 公式） */
  worldFromLngLat?: (lng: number, lat: number, altitude?: number) => { x: number; y: number };
}

/**
 * 从宿主状态解析出相机 ENU。拿不到必要字段时返回 `null`，由调用方退回原点。
 *
 * 分成独立函数是为了可测：`S3MLayer.render` 里那一段依赖 gl、帧矩阵、DOM，
 * 没法直接单测；而"接线有没有真的取到 transform"恰恰是最容易再退回原点的地方
 * （旧代码就是这么静默失效的：`getFreeCameraOptions` 不存在 → undefined → 全零）。
 */
export function resolveCameraEnu(p: ResolveCameraEnuInput): [number, number, number] | null {
  const t = p.transform;
  const c = t?.center;
  const ccd = t?.cameraToCenterDistance;
  const ws = t?.worldSize;
  if (
    !c ||
    typeof c.lng !== 'number' ||
    typeof c.lat !== 'number' ||
    typeof ccd !== 'number' ||
    !Number.isFinite(ccd) ||
    typeof ws !== 'number' ||
    !Number.isFinite(ws) ||
    ws <= 0 ||
    !Number.isFinite(p.sEast) ||
    p.sEast === 0 ||
    !Number.isFinite(p.sNorth) ||
    p.sNorth === 0
  ) {
    return null;
  }

  const latRad = (c.lat * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  const world = p.worldFromLngLat?.(c.lng, c.lat, p.anchor.altitude ?? 0);
  const mx = world && Number.isFinite(world.x) ? world.x : (c.lng + 180) / 360;
  const my =
    world && Number.isFinite(world.y)
      ? world.y
      : (1 - Math.log(Math.tan(latRad) + 1 / cosLat) / Math.PI) / 2;

  return cameraEnuFromDistance({
    centerEnu: [(mx - p.anchor.x) / p.sEast, -(my - p.anchor.y) / p.sNorth, 0],
    cameraToCenterDistance: ccd,
    worldSize: ws,
    latRad,
    pitchRad: (((t.pitch ?? 0) as number) * Math.PI) / 180,
    bearingRad: (((t.bearing ?? 0) as number) * Math.PI) / 180,
  });
}
