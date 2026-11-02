/**
 * 瓦片级放置（issue #12）。
 *
 * ## 问题
 *
 * 场景只有一个切平面：`_enuMatrix` 用**场景锚点纬度**的常量 `meterInMercator`
 * 把整个场景缩放进 Web 墨卡托。但墨卡托的比例 `s(φ) = 1/(2πR·cos φ)` 随纬度变化，
 * 所以距锚点 `d` 处的真实尺度是 `s(φ₀ + Δφ)`，相对误差约 `tan φ₀ · Δφ / 2`。
 *
 * 北纬 40° 实测：20 km 处 0.26%（约 26 m），200 km 处 2.8%（约 2.8 km）。
 * 数据集**原点**是精确的（`layoutDataset` 用精确墨卡托差除以常量 s，两者互逆），
 * 错的是数据集**内部**每一个顶点——它们被同一个常量缩放，于是整块模型被整体
 * 放大/缩小，误差随离锚点的距离线性累积。
 *
 * ## 做法
 *
 * 每块瓦片用自己的中心纬度算尺度，并把它的几何绕自己的中心缩放：
 *
 * ```
 * A(v) = position + k · (v - pivot)          k = s(瓦片中心) / s(场景锚点)
 * ```
 *
 * 其中 `position` 是瓦片中心在**数据集局部 ENU**（即 `entry.root` 坐标系）里的位置，
 * 用精确墨卡托反解得到；`pivot` 是中心在数据集 ENU 里的坐标（`node.sphere.center`）。
 *
 * 渲染时 `_enuMatrix` 依旧作用在整个场景上，于是合成结果是：
 *
 * ```
 * mercator = sceneAnchor + s_scene · D · (A(v) + datasetOffset)
 *          = merc(w_c) + s_tile · D · (v - c)
 * ```
 *
 * 中心精确落位，周边顶点按**自己的**尺度缩放——误差从「全场景累积」降到
 * 「半个瓦片内累积」（瓦片跨 2 km 时约 0.5 m）。
 *
 * ## 不做什么
 *
 * 场景 ENU 仍然是**一个平面**，所以这只把误差按瓦片重新分摊，不是彻底消除：
 * 要彻底消除得逐顶点烘焙精确墨卡托（issue #15）。同理
 * `_sceneFromLngLat` / `_lngLatFromScene`（拾取、量算）仍然用常量 s，
 * 在本模式下它们的反解误差保持在修复前的量级——这是已知遗留，见 issue #15。
 */
import { worldFromLngLat, type GeoAdapter } from './GeoAdapter';

/* ------------------------------------------------------------ ENU → 经纬度 */

const R_SPHERE = 6378137;
const DEG = Math.PI / 180;

/**
 * 局部 ENU 偏移（东, 北 米）→ 经纬度。
 *
 * 用**球面**模型，与 `GeoAdapter.mercatorFromLngLat` 的口径严格一致：
 * `meterInMercator = 1/(2πR·cos φ)` 只有在「1 米 = 1/R 弧度」的球面假设下才让
 * x 与 y 同时精确（Web 墨卡托本身就是球面投影，x = (lon+180)/360）。混用椭球的
 * 子午圈/卯酉圈半径会引入 R/N ≈ 0.14% 的系统性错配，反而更差。
 *
 * 这里也**不能**用「乘锚点尺度的常量换成墨卡托增量」那一套线性近似：本函数要跨越的
 * 正是「锚点 → 瓦片」的整个距离，线性化的累积误差与被修正的 bug 同量级
 * （20 km 处实测 50–80 m），修了等于没修。
 *
 * 椭球与球面的 0.14% 系统残差（2 km 处约 2.8 m）是**既有**问题，影响面覆盖放置、
 * 拾取、量算，不属于本函数职责。
 */
function enuToLngLat(anchor: DatasetAnchorLike, east: number, north: number): [number, number] {
  const latRad = anchor.lat * DEG + north / R_SPHERE;
  const cosLat = Math.cos(latRad);
  const dLon = Math.abs(cosLat) < 1e-12 ? 0 : east / (R_SPHERE * cosLat);
  return [anchor.lon + dLon / DEG, latRad / DEG];
}

/** 归一化世界坐标 + 米尺度（`DatasetManager.sceneAnchor` 的形状） */
export interface SceneAnchorLike {
  x: number;
  y: number;
  z: number;
  meterInMercator: number;
  altitude?: number;
}

/** 数据集锚点（`Anchor` 的形状：经纬度 + 椭球高） */
export interface DatasetAnchorLike {
  lon: number;
  lat: number;
  height: number;
}

export interface TilePlacementInput {
  /** 瓦片中心在数据集局部 ENU 中的位置（米），即 `node.sphere.center` */
  center: { x: number; y: number; z: number };
  /** 数据集锚点 */
  datasetAnchor: DatasetAnchorLike;
  /** 场景锚点 */
  sceneAnchor: SceneAnchorLike;
  /** 数据集相对场景锚点的偏移（场景 ENU 米），即 `entry.offset` */
  datasetOffset: readonly [number, number, number];
  /** 宿主的坐标适配器；`null` = 标准 Web 墨卡托兜底 */
  geo: GeoAdapter | null;
}

export interface TilePlacement {
  /** 变换枢轴，数据集局部 ENU（米） */
  pivot: readonly [number, number, number];
  /** 枢轴落到的位置，**数据集局部** ENU（米）——父级 `entry.root` 会再加回 `datasetOffset` */
  position: readonly [number, number, number];
  /** 相对缩放 `s_tile / s_scene` */
  scale: number;
}

/**
 * 算一块瓦片的放置参数。
 *
 * 拿不到可用锚点时返回 `null`，调用方应保持瓦片原状（矩阵不动）——这保证
 * 「数据不完整」时的表现与不开本功能时一致，而不是把瓦片甩到别处去。
 */
export function computeTilePlacement(input: TilePlacementInput): TilePlacement | null {
  const { center, datasetAnchor, sceneAnchor, datasetOffset, geo } = input;

  const sScene = sceneAnchor.meterInMercator;
  if (!Number.isFinite(sScene) || sScene <= 0) return null;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) return null;

  // 1) 瓦片中心 → 经纬度。
  //    走大地线反解，不用「锚点尺度 × 常量」的线性近似 —— 后者在本函数要跨越的距离
  //    （锚点 → 瓦片）上累积误差可达 50–80 m，与被修正的 bug 同量级。
  const [lng, lat] = enuToLngLat(datasetAnchor, center.x, center.y);

  // 2) 中心处的精确墨卡托位置 + 该处的真实尺度
  const altitude = datasetAnchor.height + center.z;
  const tMerc = worldFromLngLat(geo, lng, lat, altitude);
  const sTile = tMerc.meterInMercator;
  if (!Number.isFinite(sTile) || sTile <= 0) return null;

  // 3) 精确的场景 ENU 位置（与 `_enuMatrix` 互逆），再扣掉父级的偏移
  const position: [number, number, number] = [
    (tMerc.x - sceneAnchor.x) / sScene - datasetOffset[0],
    -(tMerc.y - sceneAnchor.y) / sScene - datasetOffset[1],
    (tMerc.z - sceneAnchor.z) / sScene - datasetOffset[2],
  ];

  return {
    pivot: [center.x, center.y, center.z],
    position,
    scale: sTile / sScene,
  };
}
