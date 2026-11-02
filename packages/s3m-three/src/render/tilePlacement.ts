/**
 * 瓦片级放置（issue #12 / #17）。
 *
 * ## 问题
 *
 * 场景只有一个切平面：`_enuMatrix` 用**场景锚点纬度**的常量 `meterInMercator`
 * 把整个场景缩放进 Web 墨卡托。但墨卡托的比例 `s(φ) = 1/(2πN·cos φ)` 随纬度变化，
 * 且 WGS84 椭球下东西向 (N) 与南北向 (M) 曲率半径存在各向异性偏差（赤道 0.67%，中纬度约 0.4%）。
 * 所以距锚点 `d` 处的真实尺度是 `s(φ₀ + Δφ)`，相对误差随距离累积。
 *
 * 数据集**原点**是精确的（`layoutDataset` 用精确墨卡托差除以常量 s，两者互逆），
 * 错的是数据集**内部**每一个顶点——它们被同一个常量缩放，于是整块模型被整体
 * 放大/缩小，误差随离锚点的距离线性累积。
 *
 * ## 做法
 *
 * 每块瓦片用自己的中心经纬度算东西向与南北向尺度，并把它的几何绕自己的中心各向异性缩放：
 *
 * ```
 * A(v) = position + K · (v - pivot)
 * K = diag(sEast_tile / sEast_scene, sNorth_tile / sNorth_scene, sEast_tile / sEast_scene)
 * ```
 *
 * 其中 `position` 是瓦片中心在**数据集局部 ENU**（即 `entry.root` 坐标系）里的位置，
 * 用精确墨卡托反解得到；`pivot` 是中心在数据集 ENU 里的坐标（`node.sphere.center`）。
 *
 * 渲染时 `_enuMatrix` 依旧作用在整个场景上，于是合成结果是中心精确落位，周边顶点按自己的尺度缩放。
 */
import { worldFromLngLat, enuToLngLat, type GeoAdapter } from './GeoAdapter.js';

/** 归一化世界坐标 + 米尺度（`DatasetManager.sceneAnchor` 的形状） */
export interface SceneAnchorLike {
  x: number;
  y: number;
  z: number;
  meterInMercatorEast?: number;
  meterInMercatorNorth?: number;
  meterInMercatorUp?: number;
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
  /** 兼容旧代码：等同于 scaleEast */
  scale: number;
  /** 东向相对缩放 `sEast_tile / sEast_scene` */
  scaleEast: number;
  /** 北向相对缩放 `sNorth_tile / sNorth_scene` */
  scaleNorth: number;
  /** 逐瓦片逆尺度 (1 / sTileEast, 1 / sTileNorth, 1 / sTileUp)，供烘焙着色器抵消各向异性缩放 */
  invTileScale?: readonly [number, number, number];
}

/**
 * 算一块瓦片的放置参数。
 *
 * 拿不到可用锚点时返回 `null`，调用方应保持瓦片原状（矩阵不动）——这保证
 * 「数据不完整」时的表现与不开本功能时一致，而不是把瓦片甩到别处去。
 */
export function computeTilePlacement(input: TilePlacementInput): TilePlacement | null {
  const { center, datasetAnchor, sceneAnchor, datasetOffset, geo } = input;

  const sSceneEast = sceneAnchor.meterInMercatorEast ?? sceneAnchor.meterInMercator;
  const sSceneNorth = sceneAnchor.meterInMercatorNorth ?? sceneAnchor.meterInMercator;
  if (!Number.isFinite(sSceneEast) || sSceneEast <= 0 || !Number.isFinite(sSceneNorth) || sSceneNorth <= 0) return null;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) return null;

  // 1) 瓦片中心 → 经纬度（高精度 WGS84 椭球反解）
  const [lng, lat] = enuToLngLat(datasetAnchor.lon, datasetAnchor.lat, center.x, center.y);

  // 2) 中心处的精确墨卡托位置 + 该处的真实尺度
  const altitude = datasetAnchor.height + center.z;
  const tMerc = worldFromLngLat(geo, lng, lat, altitude);
  const sTileEast = tMerc.meterInMercatorEast ?? tMerc.meterInMercator;
  const sTileNorth = tMerc.meterInMercatorNorth ?? tMerc.meterInMercator;
  if (!Number.isFinite(sTileEast) || sTileEast <= 0 || !Number.isFinite(sTileNorth) || sTileNorth <= 0) return null;

  // 3) 精确的场景 ENU 位置（与 `_enuMatrix` 互逆），再扣掉父级的偏移
  const position: [number, number, number] = [
    (tMerc.x - sceneAnchor.x) / sSceneEast - datasetOffset[0],
    -(tMerc.y - sceneAnchor.y) / sSceneNorth - datasetOffset[1],
    (tMerc.z - sceneAnchor.z) / sSceneEast - datasetOffset[2],
  ];

  const scaleEast = sTileEast / sSceneEast;
  const scaleNorth = sTileNorth / sSceneNorth;
  const sTileUp = (tMerc as any).meterInMercatorUp ?? sTileEast;

  return {
    pivot: [center.x, center.y, center.z],
    position,
    scale: scaleEast,
    scaleEast,
    scaleNorth,
    invTileScale: [1.0 / sTileEast, 1.0 / sTileNorth, 1.0 / sTileUp],
  };
}
