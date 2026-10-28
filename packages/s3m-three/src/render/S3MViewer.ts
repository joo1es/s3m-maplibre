/**
 * S3M × three 场景查看器（宿主无关渲染内核）
 *
 * 这是 s3m-three 的核心：把 S3M 瓦片渲染进一个普通的 three 场景，
 * 不依赖 MapLibre / Mapbox 或任何地图宿主。坐标链路：
 *
 *   S3M 顶点（数据集局部 ENU，米）
 *     → 数据集 Group 偏移：把各数据集锚点对齐到「场景锚点」
 *     → L 矩阵：ENU → 世界坐标（由宿主通过 GeoAdapter 定义）
 *     → 宿主的 world→clip 矩阵（每帧由宿主喂进来）
 *
 * 关键点：three 场景原点固定在**场景锚点**（第一个数据集的位置），
 * 所有顶点只保留「相对锚点的米」，避免 float32 在大坐标下的抖动（RTC 思路）。
 * 多数据集叠加时，每个数据集一个 Group，用 position 承担锚点差。
 *
 * 与宿主的全部接触点只有三个，都是注入式的：
 *   - `onRequestRepaint`  宿主需要重画的信号（MapLibre 就是 triggerRepaint）
 *   - `getBearing`        地图朝向，用来让灯光跟着视角走（可选）
 *   - `GeoAdapter`        经纬度 ↔ 世界坐标（见 GeoAdapter.ts，有墨卡托兜底）
 *
 * MapLibre / Mapbox 的胶水层在 s3m-maplibre 包的 S3MLayer.ts。
 */
import * as THREE from 'three';
import { S3MTileset, usableGeoBounds } from '../tileset/S3MTileset.js';
import type { BuildTileFn, TileNode } from '../tileset/S3MTileset.js';
import { authFetch, type AuthenticateFn } from '../core/AuthFetch.js';
import { sortSplatMesh } from './SplatSorter.js';
import { splatCenterBounds } from './SplatMaterial.js';
import { setSplatViewport } from './GeometryBuilder.js';
import { setMaxAnisotropy, setAnisotropyCap, setCompressedTexturesSupported, setTextureOffThreadDecode, setMaxTextureSize as setTextureSizeCap, setSrgbTextureDecode } from './TextureFactory.js';
import { getMaterialQuality, setMaterialQuality, setColorPipeline } from './StyleMaterial.js';
import { resolveLightingPreset, type LightingPreset } from './lightingPreset.js';
import { decodeTextureWithWorker } from '../worker/S3MWorkerClient.js';
import {
  STYLE,
  STYLE_LABELS,
  SELECT_MODE,
  DEFAULT_STYLE,
  createSharedUniforms,
  createStyledMaterial,
  createOutlineMaterial,
  resolveEdgeModes,
  sameEdgeModes,
  restoreBaseBlendState,
} from './StyleMaterial.js';
import type {
  OutlineMaterial,
  OutlineStyleUniforms,
  StyledMaterial,
  StyledMaterialOptions,
  StyleMode,
  SelectMode,
  S3MStyle,
  EdgeModes,
  EdgesOption,
  MaterialQuality,
} from './StyleMaterial.js';
import { applyPointCloudStyle, isOwnedPointCloudMaterial } from './PointCloudMaterial.js';
import type { DegradationKind, UnsupportedPolicy } from '../core/degradations.js';
import { Picker } from './Picker.js';
import { GpuEdgePass } from './GpuEdgePass.js';
import { Animator } from '../anim/Animator.js';
import type { Channel, TransitionOptions } from '../anim/Animator.js';
import { Path } from '../anim/Path.js';
import type { EasingFn, EasingName } from '../anim/easing.js';
import type { LineSharedUniforms, ThickLineMaterial, ThickLineStyleUniforms } from './EdgeLines.js';
import { GPUPathManager } from './GPUPathManager.js';
import type { GPUPathOptions } from './FeatureStyleManager.js';
import {
  buildFeatureEdgeSegments,
  buildPositionBatchMap,
  buildThickLineGeometry,
  createLineSharedUniforms,
  createThickLineMaterial,
  positionQuantKey,
} from './EdgeLines.js';
import { mergeVerticesByPosition } from './MergeVertices.js';
import {
  resolveFeature,
  measureSegments,
  buildAttributes,
  buildInstanceLookup,
  pickEntryId,
  DEFAULT_FLOOR_HEIGHT,
} from '../core/FeatureInfo.js';
import type { InstanceFeature } from '../core/FeatureInfo.js';
import { AttributeQuery } from '../core/AttributeQuery.js';
import type { AttributeQueryOptions, AttributeRow } from '../core/AttributeQuery.js';
import type {
  Anchor,
  FeatureAttributes,
  GeoPackageEntry,
  ParsedTile,
  PickSegment,
  SegmentBox,
  Stats,
  StyleUniforms,
} from '../core/types.js';

import { lngLatFromWorld, type GeoAdapter } from './GeoAdapter.js';

import {
  DatasetManager,
  type DatasetAlignment,
  type S3MDatasetOptions,
  type S3MDatasetEntry,
} from './DatasetManager.js';

import {
  FeatureStyleManager,
  type FeatureStyle,
  type ColorByFieldOptions,
  type ThematicLegendEntry,
  type ThematicResult,
  type BatchConflict,
  type BatchAudit,
  type FieldFilterOptions,
  type FieldFilterResult,
  type FieldElevationOptions,
  type FieldElevationResult,
  type S3MFilter,
  resolveRotationMatrix,
  extractEulerAngles,
} from './FeatureStyleManager.js';

import {
  GroundManager,
  type GroundMode,
  type GroundOptions,
} from './GroundManager.js';

export type {
  DatasetAlignment,
  S3MDatasetOptions,
  S3MDatasetEntry,
} from './DatasetManager.js';

export type {
  FeatureStyle,
  ColorByFieldOptions,
  ThematicLegendEntry,
  ThematicResult,
  BatchConflict,
  BatchAudit,
  FieldFilterOptions,
  FieldFilterResult,
  FieldElevationOptions,
  FieldElevationResult,
  S3MFilter,
} from './FeatureStyleManager.js';

export type {
  GroundMode,
  GroundOptions,
} from './GroundManager.js';

export { GroundManager, DatasetManager, FeatureStyleManager };

const MAX_PICK_ID = 65534;

export interface PickResult extends FeatureAttributes {
  datasetId: string;
  datasetName: string;
  /** 网格编号 */
  objectId: number;
  /** 单体控制位（顶点区间型 = batchId，实例化型 = 状态纹理下标），-1 表示没有单体化信息 */
  batchId: number;
  /** 实例化几何命中的实例序号；非实例化为 undefined */
  instanceIndex?: number;
  skeletonName: string;
  /** 单体中心经纬度，拿不到时为 null */
  centerLngLat: [number, number] | null;
  /** 命中点三维场景坐标 [x, y, z]（米，场景 ENU） */
  point?: [number, number, number] | null;
  /** 命中点经纬度 [lng, lat] */
  lngLat?: [number, number] | null;
  /** 命中点高程（米） */
  altitude?: number | null;
  mesh: THREE.Mesh;
}

export interface LightOptions {
  /** 环境光强度，默认 0.4 */
  ambientIntensity?: number;
  /** 环境光颜色，十六进制或 CSS 颜色字符串，默认 0xffffff */
  ambientColor?: number | string;
  /** 半球光天空强度，默认 0.8 */
  hemisphereIntensity?: number;
  /** 半球光天空颜色，默认 0xffffff */
  hemisphereColor?: number | string;
  /** 半球光地面颜色，默认 0xb6c0cb */
  hemisphereGroundColor?: number | string;
  /** 主平行光强度，默认 1.0 */
  keyLightIntensity?: number;
  /** 主平行光强度别名（兼容写法） */
  mainIntensity?: number;
  /** 主平行光颜色，默认 0xffffff */
  keyLightColor?: number | string;
  /** 主平行光颜色别名（兼容写法） */
  mainColor?: number | string;
  /** 补光强度，默认 0.35 */
  fillLightIntensity?: number;
  /** 补光颜色，默认 0xffffff */
  fillLightColor?: number | string;
  /**
   * 光照朝向模式：
   * - 'headlamp': 默认头灯模式（随相机 bearing 旋转，受光面始终面向镜头）
   * - 'fixed': 固定世界坐标方位角（如太阳光模拟）
   */
  mode?: 'headlamp' | 'fixed';
  /** 方位角（度，0~360），固定模式下以正北为 0 顺时针，头灯模式下为相机相对偏角，默认 150 */
  azimuth?: number;
  /** 太阳/光源仰角（度，0~90），默认 50 */
  altitude?: number;
}

export interface S3MViewerOptions {
  /**
   * 光照预设：
   * - `'default'`（默认）：现有 PBR 打光，亮部线性总量 ≈ 2.55；
   * - `'supermap'`：对齐 iClient3D 观感（暗部 0.46 / 亮部 2.44），远处不发灰、饱和度更高。
   *   只改光源，不动材质与色调映射；`light` 里的显式字段仍然优先生效。
   */
  lightingPreset?: LightingPreset;
  /** 光照参数配置（强度、颜色、朝向模式、太阳方位角/仰角等） */
  light?: LightOptions;
  /**
   * 三角面材质深度偏移（共面摩尔纹 / 重合面归属的人工定序）。
   * 例：factor -1 / units -2 把配置材质的片元深度略微拉近。
   * 这是 mesh 粒度开关，见 BuildTileOptions.polygonOffset 的说明。
   */
  polygonOffset?: { factor: number; units: number };
  /**
   * 色调映射模式（默认 THREE.NoToneMapping，避免 ACESFilmic 压暗中暗部及导致底图与建筑色彩失真；
   * 可传入 THREE.ACESFilmicToneMapping、THREE.LinearToneMapping、THREE.ReinhardToneMapping 等）
   */
  toneMapping?: THREE.ToneMapping;
  /** 色调映射曝光度，默认 1.0 */
  toneMappingExposure?: number;
  /** 全局总驻留瓦片上限（多数据集多图层共享预算），在所有可见数据集之间动态均衡分配，彻底防止爆显存 */
  totalMaxTiles?: number;
  /** 单数据集简写 */
  configUrl?: string;
  /** 多数据集 */
  datasets?: S3MDatasetOptions[];
  style?: Partial<S3MStyle>;
  /** 3D 物理地表面 / 基坑开挖配置 */
  ground?: GroundOptions;
  pickable?: boolean;
  /** 每个数据集最多驻留瓦片 */
  maxTiles?: number;
  /** 每个数据集并发请求数 */
  maxConcurrent?: number;
  /**
   * 图层级默认的降级处置策略（默认 `'warn'`），数据集可用 `unsupported` 单独覆盖。
   * 见 `S3MTilesetOptions.unsupported`。
   */
  unsupported?: UnsupportedPolicy;
  /** 是否用 Web Worker 解析经典 .s3mb 瓦片（默认开，崩溃自动降级主线程），见 S3MTilesetOptions.useWorker */
  useWorker?: boolean;
  /** LOD 切换范围缩放系数（默认 1.0），> 1 更倾向保留粗模，< 1 提前换细模 */
  lodRangeScale?: number;
  /**
   * LOD 判定用屏幕高度时的「设备像素比上限」（默认不限制，行为与旧版一致）。
   *
   * LOD 的屏幕空间误差按 `canvasHeight` 物理像素算（与官方 `calcPixFromCam` 同口径），
   * 于是 3x DPR 的手机上判定高度是 2556 而不是 852，细化层数与瓦片数都会远多于桌面。
   * 传 2 表示「按 CSS 高度 × 2 截断」，砍掉 3x 屏的超采样余量；传 `Infinity` = 不截断。
   *
   * 代价：截断会把每块瓦片的屏幕投影放大同样倍数，几何误差与纹理密度同步变差，
   * 所以默认不启用，由接入方按设备档位自行决定。运行时可用 `setLodPixelRatioCap()` 调整。
   */
  lodPixelRatioCap?: number;
  /**
   * 每个数据集驻留三角形总数的软上限（默认不限制）。
   * 见 `S3MTilesetOptions.maxTriangles`：瓦片数管不住的场景（精模、大面片）用这条刹车。
   */
  maxTriangles?: number;
  /**
   * 纹理缓存条数上限（默认 128）。一条对应一张已解码的瓦片纹理，
   * 1024² 的 RGBA 一张约 4MB，128 条就是 512MB 显存 —— 低端设备建议 32~48。
   * 与 `maxTextureSize` 配合使用：后者降单张尺寸，这条降张数。
   */
  maxImageCache?: number;
  /**
   * 各向异性过滤上限（默认不封顶，取 GPU 报的最大值，通常 16）。
   * 移动端封到 4 或 8 肉眼通常无差，采样成本明显下降。只影响**之后创建**的纹理。
   */
  anisotropyCap?: number;
  /**
   * 纹理长边像素上限（默认不限制）。
   * 非图集的 RGBA / WebP 纹理会按 2× 盒式滤波逐次减半到上限内；DXT 压缩直传与
   * 图集（UV 已重映射）不受影响。手机上 1024 与 2048 肉眼几乎无差，显存差 4 倍。
   */
  maxTextureSize?: number;
  /**
   * 光照模型（默认 `'pbr'`）。
   *
   * - `'pbr'`：`MeshStandardMaterial`，GGX + 环境球谐，质感最好也最贵
   * - `'lambert'`：`MeshLambertMaterial`，只保留漫反射 + 平行光，片元开销约省一半；
   *   白模 / 纯色 / 按高度着色这类不需要高光的模式肉眼差别很小
   *
   * 模块级全局状态：同页多个图层会互相覆盖，后创建的那个决定全局。
   * 只影响**之后创建**的材质 —— 已加载的瓦片要重新加载才会换。
   */
  materialQuality?: 'pbr' | 'lambert';
  /** 自定义瓦片构建器（测试 / 服务端渲染时注入） */
  buildTile?: BuildTileFn | null;
  /**
   * 可选：业务属性查询配置（iServer 数据服务）。
   * 配上之后才能用 `colorByField()` 按业务字段着色 —— 属性值不在 S3M 瓦片里，只能去数据服务查。
   */
  attributes?: AttributeQueryOptions;
  /** 宿主请求重画的信号。MapLibre 传 `() => map.triggerRepaint()`；纯 three 宿主传自己的渲染循环 */
  onRequestRepaint?: () => void;
  /** 地图朝向（弧度），用于让灯光跟着视角走。不传则灯光方向固定 */
  getBearing?: () => number;
  /**
   * 鉴权适配函数（全局默认，数据集可用自己的 `authenticate` 覆盖）。
   * 内核主线程发出的全部请求（配置 scp / 瓦片 / 子图集 / 棱线缓存 / 属性查询）
   * 发出前都过一遍，可改写 URL（加 `?token=`）或附加请求头。
   * 不传 = 行为与旧版完全一致。见 `AuthenticateFn`。
   */
  authenticate?: AuthenticateFn;
  onStats?: (stats: Stats) => void;
  onReady?: (entry: S3MDatasetEntry) => void;
  onPick?: (result: PickResult | null) => void;
  onError?: (error: unknown) => void;
  /**
   * 首次出现瓦片后自动预热另一种 `shading` 变体（默认开）。
   *
   * `flat` / `smooth` 是编译期变体，不预热的话第一次 `setStyle({ shading })` 会同步
   * 编译着色器、卡一帧。预热在首帧之后异步做，期间跳一两帧渲染，肉眼不可见。
   */
  prewarmShading?: boolean;
}

/* ------------------------------------------------------------------ 内部类型 */

interface PickableRef {
  datasetId: string;
  mesh: THREE.Mesh;
  tile: ParsedTile;
  skeletonName: string;
}

interface MeshUserData {
  pickId?: number;
  datasetId?: string;
  skeletonName?: string;
  geoRef?: GeoPackageEntry;
  tileRef?: ParsedTile;
  primitiveType?: number;
  /** 点云对象（THREE.Points）：不吃面着色，也没有棱可描 */
  isPointCloud?: boolean;
  /** CPU 端现算的棱线对象（等宽线 Mesh） */
  edges?: THREE.Object3D | null;
  /** 背面外扩轮廓壳（edges 含 'hull' 时挂上） */
  edgeHull?: THREE.Mesh | null;
  /** 数据自带棱线包（此时不再用 EdgesGeometry 现算） */
  nativeEdges?: boolean;
  /** 数据本身有没有棱线包（不受 forceCpuEdges 影响，用来运行中切换时重算 nativeEdges） */
  nativeEdgesRaw?: boolean;
  /** 数据自带的棱线对象本身 */
  isEdgeLines?: boolean;
  /** CPU 现算的等宽棱线（与 isEdgeLines 区分，便于刷新样式） */
  isThickEdge?: boolean;
  /** 背面外扩轮廓壳（edges 含 'hull' 时挂上） */
  isEdgeHull?: boolean;
  /** 选中单体的棱线对象 */
  isSelectionEdge?: boolean;
  /** 该网格正在淡入时占用的动画通道 key，瓦片淘汰时要回收 */
  tileFadeKey?: string;
  pickMaterial?: THREE.Material;
  [key: string]: unknown;
}

function styledMaterialOf(mesh: THREE.Mesh): StyledMaterial | null {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const styled = m as StyledMaterial | undefined;
  return styled?.userData?.isStyled ? styled : null;
}

/** 点云是 THREE.Points 不是 Mesh，样式 / 拾取 / 卸载链路都靠这个判定放行 */
function isPointCloudObject(o: THREE.Object3D): o is THREE.Points {
  return (o as unknown as THREE.Points).isPoints === true;
}

/**
 * 全局透明度钳到 [0, 1]，**允许到 0**。
 *
 * 以前这里有个 0.05 下限，本意是「别让整层彻底看不见、又还在挡东西」。但那个问题
 * 真正的来源不是透明度，而是「透明物体仍然写深度」：全透明还写深度就会在底图上挖洞。
 * 现在到 0 时 `renderFrame()` 直接跳过绘制（不写颜色也不写深度），语义就干净了。
 */
function clampOpacity(v: number | null | undefined): number {
  const n = v ?? 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 低于这个透明度就当作完全不可见：跳过绘制，避免全透明物体写深度 */
const OPACITY_EPS = 1e-3;

/* ------------------------------------------------------------------ 可动画的样式键 */

/**
 * 能逐帧插值的标量样式键。
 *
 * 判据：写一次只是「改一个 uniform 或一个字段」，不重建几何、不换 program。
 * `mode` / `shading` / `edges` 不在此列——它们是结构变更，只能编排不能插值。
 */
const STYLE_SCALAR_KEYS = [
  'opacity',
  'floorHeight',
  'selectOpacity',
  'selectEmissive',
  'selectElevation',
  'dimFactor',
  'texMix',
  'roofThreshold',
  'ambientGain',
  'metalness',
  'roughness',
  'edgeWidth',
  'edgeOpacity',
  'edgeOffset',
  'edgeHullWidth',
  'outlineWidth',
] as const;

/** 能逐帧插值的颜色键（在线性空间插值，与 shader 消费端一致） */
const STYLE_COLOR_KEYS = ['colorA', 'colorB', 'colorC', 'selectColor', 'edgeColor'] as const;

/** 可动画的单体属性 */
const FEATURE_PROPS = ['translation', 'elevation', 'opacity', 'color', 'rotation'] as const;
type FeatureProp = (typeof FEATURE_PROPS)[number];

/** 单体沿折线运动的参数 */
export interface PathFollowOptions {
  /** 走完全程的时长（毫秒）。不传则按 speed 或默认 2000ms 推算 */
  duration?: number;
  /** 线速度（米/秒）。给了 duration 就以 duration 为准 */
  speed?: number;
  /** 是否循环 */
  loop?: boolean;
  /** 是否把折线首尾相连 */
  closed?: boolean;
  /** 缓动曲线：作用在**已走距离**上，默认 linear（恒速） */
  easing?: EasingName | EasingFn;
  /** 路径整体偏移（米），相当于路径原点 */
  offset?: [number, number, number];
  /** 单次走完（非循环）时回调 */
  onComplete?: () => void;
}

/* ------------------------------------------------------------------ 图层 */

export class S3MViewer {
  readonly options: S3MViewerOptions;
  readonly pickable: boolean;
  onStats: (stats: Stats) => void;
  onReady: (entry: S3MDatasetEntry) => void;
  onPick: (result: PickResult | null) => void;
  onError: (error: unknown) => void;

  /** 宿主地理坐标适配器；mount 前由宿主注入，null = 标准 Web 墨卡托兜底 */
  geo: GeoAdapter | null = null;
  /** 宿主画布与 WebGL 上下文，mount() 时绑定 */
  canvas: HTMLCanvasElement | null = null;
  renderer: THREE.WebGLRenderer | null = null;
  scene: THREE.Scene | null = null;
  camera: THREE.Camera | null = null;
  picker: Picker | null = null;

  readonly uniforms: StyleUniforms;
  /** 当前**显示**的样式（动画推进中会逐帧变） */
  style: S3MStyle;
  /** 用户想要的样式（getStyle 返回它，动画目标以它为准） */
  private _styleTarget: S3MStyle;
  readonly outlineMaterial: OutlineMaterial;

  /** 等宽线共享的分辨率 uniform（全局棱线 + 选中棱线共用） */
  readonly lineShared: LineSharedUniforms;
  /** 全局棱线材质（外观 uniform 的持有者，逐网格棱线材质共享它的对象） */
  readonly edgeMaterial: ThickLineMaterial;
  /** 选中棱线材质（同上，选中棱线的逐网格材质共享它的对象） */
  readonly selectionEdgeMaterial: ThickLineMaterial;
  /** 全局棱线的外观 uniform：逐网格棱线材质直接复用这些对象 */
  private readonly _edgeStyleUniforms: ThickLineStyleUniforms;
  /** 选中棱线的外观 uniform */
  private readonly _selEdgeStyleUniforms: ThickLineStyleUniforms;
  /** 全局外扩轮廓的外观 uniform：逐网格轮廓壳共享这些对象 */
  private readonly _hullStyleUniforms: OutlineStyleUniforms;

  /** 3D 物理地表面 / 基坑开挖管理器 */
  readonly groundManager: GroundManager;
  /** 多数据集生命周期与锚点管理器 */
  private readonly _datasetManager = new DatasetManager();
  /** 单体样式、专题着色与状态纹理管理器 */
  private readonly _featureStyleManager: FeatureStyleManager;
  /** GPU 路径动画管理器 */
  readonly gpuPathManager: GPUPathManager = new GPUPathManager();
  private _customPathTime = false;

  /** 兼容 datasets 映射表暴露 */
  get datasets(): Map<string, S3MDatasetEntry> {
    return this._datasetManager.datasets;
  }

  /** 场景主锚点（ENU 原点对应的世界坐标） */
  get sceneAnchor(): { x: number; y: number; z: number; meterInMercator: number; altitude?: number } | null {
    return this._datasetManager.sceneAnchor;
  }
  set sceneAnchor(val: { x: number; y: number; z: number; meterInMercator: number; altitude?: number } | null) {
    this._datasetManager.sceneAnchor = val;
  }

  private readonly _pickables = new Map<number, PickableRef>();
  private _pickSeq = 0;
  private readonly _freePickIds: number[] = [];
  /** SMID → 包含它的网格。改单个单体样式时只重算这几块，不用全量扫 */
  private readonly _smidMeshes = new Map<number, Set<THREE.Mesh>>();
  /** 每块网格的世界高度范围，用来增量维护 uHeightMin / uHeightMax */
  private readonly _meshHeight = new Map<THREE.Mesh, { min: number; max: number }>();
  private _heightMin = Infinity;
  private _heightMax = -Infinity;
  private readonly _boxScratch = new THREE.Box3();
  private _selection: PickResult | null = null;
  private _selectedMeshes: THREE.Object3D[] = [];
  private _outlineMesh: THREE.Mesh | null = null;
  private _outlineMeshes: THREE.Mesh[] = [];
  private _selectionEdges: THREE.Mesh | null = null;
  private _selectionEdgeMeshes: THREE.Mesh[] = [];
  private _edgesEnabled = false;
  /** 当前生效的棱线画法（line / offset / hull / gpu），决定要不要建 / 拆哪种装饰 */
  private _edgeModes: EdgeModes = resolveEdgeModes(false);
  /** GPU 描边后处理（深度 + 法线），只在 edges 含 'gpu' 时按帧执行 */
  private _gpuEdge: GpuEdgePass | null = null;
  /** 给 GPU 描边传色用的临时 Color，避免每帧 new */
  private readonly _gpuEdgeColor = new THREE.Color();
  /** 瓦片淡入通道的自增序号（不用 pickId：pickId 会被回收复用） */
  private _tileFadeSeq = 0;
  /** setMode 编排的代次，用来作废被新调用顶掉的旧编排 */
  private _modeGen = 0;
  /** `shading` 另一种变体是否已预热（每个 viewer 只做一次） */
  private _shadingPrewarmed = false;
  /** 是否允许自动预热（选项 `prewarmShading`，默认开） */
  private _prewarmShadingEnabled = true;
  /** 预热进行中：期间跳过渲染，避免把「翻转后的变体」画到屏幕上 */
  private _prewarming = false;
  /** 路径运动的规格表：通道 key → 路径 + 偏移 */
  private readonly _pathSpecs = new Map<string, { path: Path; offset: [number, number, number] }>();
  /** 路径采样临时对象，避免每帧 new */
  private readonly _pathScratch = new Float32Array(3);
  /** 求切线用的第二个采样点（包围盒换算 GPU 路径朝向时用） */
  private readonly _pathScratch2 = new Float32Array(3);
  /** 预制棱线缓存（Crease Cache）：从外部 source-creases 载入的全局统一 LineSegments，性能最高、视觉最干净 */
  private _creaseLines: THREE.LineSegments | null = null;
  /** 数据自带的棱线对象（LineSegments），改棱线颜色时只刷这些，不再全场景 traverse */
  private readonly _nativeEdgeLines = new Set<THREE.LineSegments>();
  /** 点云对象集合：透明度动画时只刷它们，避免每帧遍历全部 pickables */
  private readonly _pointClouds = new Set<THREE.Points>();
  /** 泼溅排序状态：相机不动且没有新瓦片时，排序结果可以直接复用 */
  private readonly _lastSplatSortView = new THREE.Matrix4();
  private _splatsSorted = false;
  /** 当前材质是否处于 transparent 状态，用来避免逐帧重复切换 program */
  private _opacityTransparent = false;

  /**
   * 统一动画调度器。
   *
   * 所有「有过渡」的样式 / 单体 / 棱线变更都经由它推进；公开 API 只写目标值，
   * 真正的逐帧写入由注册在这里的通道完成。
   */
  readonly animator = new Animator();

  /** 业务属性查询（可选，配了 `attributes` 才有） */
  attributeQuery: AttributeQuery | null = null;

  private readonly _enuMatrix = new THREE.Matrix4();
  /** 每帧复用：MVP 来自宿主，不要每帧 new（高频分配会带来 GC 抖动） */
  private readonly _frameMvp = new THREE.Matrix4();
  /** 颜色换算用的临时对象，避免每帧 new */
  private readonly _colorScratch = new THREE.Color();
  private _needsRepaint = true;
  private _frame = 0;
  private readonly _fps = { value: 0, last: 0 };
  private _ambientLight!: THREE.AmbientLight;
  private _hemiLight!: THREE.HemisphereLight;
  private _keyLight!: THREE.DirectionalLight;
  private _fillLight!: THREE.DirectionalLight;
  /** 环境贴图的 PMREM 渲染目标（setEnvironment 建的，unmount 时释放） */
  private _envRT: THREE.WebGLRenderTarget | null = null;
  private readonly _lightOptions: Required<Omit<LightOptions, 'mainIntensity' | 'mainColor'>> = {
    ambientIntensity: 0.4,
    ambientColor: 0xffffff,
    hemisphereIntensity: 0.8,
    hemisphereColor: 0xffffff,
    hemisphereGroundColor: 0xb6c0cb,
    keyLightIntensity: 1.0,
    keyLightColor: 0xffffff,
    fillLightIntensity: 0.35,
    fillLightColor: 0xffffff,
    mode: 'headlamp',
    azimuth: 150,
    altitude: 50,
  };

  private readonly _datasetQueue: S3MDatasetOptions[];

  /** 宿主重画信号与地图朝向，构造时注入 */
  private _onRequestRepaint: () => void = () => {};
  private _getBearing: (() => number) | undefined;
  /** 鉴权适配（全局默认），构造时注入 */
  private readonly _authenticate: AuthenticateFn | undefined;
  private _lodRangeScale = 1.0;
  /** 图层级降级策略，数据集可覆盖，见 `S3MViewerOptions.unsupported` */
  private readonly _unsupported: UnsupportedPolicy;
  /** LOD 判定屏幕高度的 DPR 上限。Infinity = 不截断（默认，行为同旧版） */
  private _lodPixelRatioCap = Infinity;

  /** 宿主请求重画（MapLibre 传 triggerRepaint，纯 three 宿主传自己的渲染循环） */
  private _requestRepaint(): void {
    this._onRequestRepaint();
  }

  triggerRepaint(): void {
    this._requestRepaint();
  }

  constructor(options: S3MViewerOptions = {}) {
    this.options = options;
    this.pickable = options.pickable !== false;
    this._lodRangeScale = options.lodRangeScale ?? 1.0;
    this._unsupported = options.unsupported ?? 'warn';
    this._lodPixelRatioCap = options.lodPixelRatioCap ?? Infinity;
    setTextureSizeCap(options.maxTextureSize ?? Infinity);
    setMaterialQuality(options.materialQuality ?? 'pbr');
    if (options.lightingPreset && options.lightingPreset !== 'default') {
      Object.assign(this._lightOptions, resolveLightingPreset(options.lightingPreset));
      this._applyColorPipeline(options.lightingPreset);
    }
    if (options.light) {
      Object.assign(this._lightOptions, options.light);
    }
    if (options.totalMaxTiles) {
      this._datasetManager.totalMaxTiles = options.totalMaxTiles;
    }
    this._onRequestRepaint = options.onRequestRepaint ?? (() => {});
    this._getBearing = options.getBearing;
    this._authenticate = options.authenticate;
    this.onStats = options.onStats ?? (() => {});
    this.onReady = options.onReady ?? (() => {});
    this.onPick = options.onPick ?? (() => {});
    this.onError = options.onError ?? ((e) => console.warn('[s3m]', e));
    this._prewarmShadingEnabled = options.prewarmShading !== false;

    this.groundManager = new GroundManager(options.ground);
    if (!this.scene) {
      this.scene = new THREE.Scene();
      this.scene.add(this.groundManager.group);
      this._addLights();
    }
    this._featureStyleManager = new FeatureStyleManager(
      () => this.style.floorHeight,
      () => this._requestRepaint(),
      () => {
        if (this._selection) this._syncSelectionStyle();
      },
      () => this.getAllMeshes(),
      (mesh) => this._applyOverridesToMesh(mesh),
      // 图层自身是否半透明：全局透明度改走 uOpacity 后，材质 opacity 不再代表它
      () => this._opacityTransparent
    );

    this.uniforms = createSharedUniforms();
    // 纹理解码优先派给共享解析 Worker（崩溃自动回主线程，见 decodeTextureWithWorker）
    setTextureOffThreadDecode(decodeTextureWithWorker);    this.style = { ...DEFAULT_STYLE, ...(options.style ?? {}) };
    this._styleTarget = { ...this.style };
    this._opacityTransparent = (this.style.opacity ?? 1) < 0.999;
    this._applyStyleUniforms();
    this._registerAnimChannels();
    // 动画启动必须把按需驱动的帧循环踢起来：MapLibre 空闲时不渲染，
    // 不踢的话动画「卡住不动」，直到别的什么碰巧触发了重绘
    this.animator.onActive = () => this._requestRepaint();
    this.outlineMaterial = createOutlineMaterial(this.uniforms);

    this.lineShared = createLineSharedUniforms();
    // 棱线外观 uniform：全局棱线材质与逐网格棱线材质**共用同一批对象**，
    // _syncEdgeStyle 改一次，所有棱线（含淡入乘子）同时生效，保持 O(1)。
    this._edgeStyleUniforms = {
      uColor: { value: new THREE.Color(this.style.edgeColor) },
      uWidth: { value: Math.max(0.1, this.style.edgeWidth ?? 1.5) },
      uOpacity: { value: 0.6 },
      uOffset: { value: this.style.edgeOffset ?? 0.15 },
    };
    this.edgeMaterial = createThickLineMaterial(this.lineShared, {}, this._edgeStyleUniforms);
    this._selEdgeStyleUniforms = {
      uColor: { value: new THREE.Color(this.style.outlineColor ?? this.style.selectColor) },
      uWidth: { value: Math.max(0.1, this.style.outlineWidthPx ?? 3) },
      uOpacity: { value: 1 },
      uElevation: { value: this.style.selectElevation ?? 0 },
    };
    this.selectionEdgeMaterial = createThickLineMaterial(this.lineShared, {}, this._selEdgeStyleUniforms);
    // 全局外扩轮廓的外观 uniform：逐网格轮廓壳复用这几个对象，改一次全场景生效
    this._hullStyleUniforms = {
      uColor: { value: new THREE.Color(this.style.edgeColor) },
      uWidth: { value: Math.max(0, this.style.edgeHullWidth ?? 0.9) },
      uOpacity: { value: 0.6 },
    };

    // 关键：style.edges 是个开关，但构造函数从没据此启用过棱线，导致
    // `style: { edges: true }` 形同虚设、_edgesEnabled 永远是 false。
    // 这里按 style 实际值调一次 setEdges，让开关真正生效（与 setEdges 后来的手工调用一致）。
    this.setEdges(this.style.edges);

    // 初始化图层整体不透明度：确保共享 uniform uOpacity、材质混合开关与棱线外观与初始 style.opacity 严格一致
    this._applyOpacity();

    this._fps.last = performance.now();
    this._datasetQueue = this._normalizeDatasets(options);
    if (options.attributes)
      this.attributeQuery = new AttributeQuery({
        ...options.attributes,
        authenticate: options.attributes.authenticate ?? this._authenticate,
      });
  }

  /* ---------------------------------------------------------------- 生命周期 */

  /**
   * 绑定宿主画布与 WebGL 上下文，建场景并启动数据集队列。
   * MapLibre 宿主由 S3MLayer 在 onAdd 里调用；纯 three 宿主直接传自己的 canvas / gl。
   */
  /** 创建并配置一个绑定到给定 gl 上下文的 three renderer（mount 与上下文恢复共用） */
  private _createRenderer(canvas: HTMLCanvasElement, gl: WebGLRenderingContext | WebGL2RenderingContext): THREE.WebGLRenderer {    const r = new THREE.WebGLRenderer({
      canvas,
      context: gl as WebGLRenderingContext,
      antialias: true,
    });
    r.autoClear = false;
    r.setPixelRatio(1);
    // 允许外部传入色调映射模式，默认使用 THREE.NoToneMapping 还原真实材质与底图通透度，避免 ACESFilmic 压暗阴影与偏色
    r.toneMapping = this.options.toneMapping !== undefined ? this.options.toneMapping : THREE.NoToneMapping;
    r.toneMappingExposure = this.options.toneMappingExposure ?? 1.0;
    return r;
  }

  /** 按 GL 能力开/关 DXT 压缩直传：两个 s3tc 扩展都要在（srgb 缺了贴图会发白失配） */
  private _syncTextureCapabilities(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const s3tc = !!gl.getExtension('WEBGL_compressed_texture_s3tc');
    const s3tcSrgb = !!gl.getExtension('WEBGL_compressed_texture_s3tc_srgb');
    setCompressedTexturesSupported(s3tc && s3tcSrgb);
  }

  mount(canvas: HTMLCanvasElement, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.canvas = canvas;

    this.renderer = this._createRenderer(canvas, gl);
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy(), this.options.anisotropyCap ?? Infinity);
    this._syncTextureCapabilities(gl);

    this.scene = new THREE.Scene();
    this.scene.add(this.groundManager.group);
    this._addLights();

    this.camera = new THREE.Camera();
    this.camera.matrixAutoUpdate = false;

    this.picker = new Picker(this.renderer);

    this._applyStyleUniforms();
    for (const ds of this._datasetQueue) void this.addDataset(ds).catch((e) => this.onError(e));

    this._recomputeAnchors();
  }

  /**
   * WebGL 上下文恢复后原地换新 renderer，保留已经加载好的场景与瓦片。
   *
   * MapLibre 在 `webglcontextlost` 时会销毁 style 并丢弃自定义图层（自定义图层
   * 无法序列化进 style，所以恢复后不会自动加回）。但自定义图层的 `onRemove` 不会被
   * 调用，因此我们的 scene / 几何体 / 材质 / 纹理 / 已加载瓦片都还在内存里。
   *
   * three 的 GPU 状态是按 renderer 实例缓存的，所以只需把 renderer / picker 换成
   * 绑在新 gl 上的新实例，下一帧渲染时 three 会自动把现存的几何体、材质、纹理
   * 重新上传到新上下文 —— 不需要重建场景，也不需要重新拉瓦片。
   */
  restoreContext(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!this.canvas) {
      // 理论不会走到：没 mount 过就没有上下文可恢复
      console.warn('[s3m] restoreContext 调用过早（尚未 mount），按首次挂载处理');
      return;
    }
    try {
      // 旧上下文已失效，dispose 可能抛错，忽略即可
      this.renderer?.dispose?.();
    } catch {
      /* noop */
    }
    this.renderer = this._createRenderer(this.canvas, gl);
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy(), this.options.anisotropyCap ?? Infinity);
    this._syncTextureCapabilities(gl);
    this.picker?.dispose();
    this.picker = new Picker(this.renderer);
    // GPU 描边的 RT / 材质绑定在旧上下文上，整体丢弃，下一帧按需重建
    this._gpuEdge?.dispose();
    this._gpuEdge = null;
    // 共享 uniform / 材质引用不变，three 重新编译着色器时会自然接管；
    // 这里只确保下一帧尽快驱动一次渲染。
    this._requestRepaint();
  }

  /** 解绑场景并释放全部 GPU 资源。对应 MapLibre 图层的 onRemove()。 */
  unmount(): void {
    for (const id of [...this.datasets.keys()]) this.removeDataset(id);
    this.clearCreases();
    this.groundManager.dispose();
    this.picker?.dispose();
    this.picker = null;
    this._envRT?.dispose();
    this._envRT = null;
    this.outlineMaterial.dispose();
    this._gpuEdge?.dispose();
    this._gpuEdge = null;
    this.edgeMaterial.dispose();
    this.selectionEdgeMaterial.dispose();
    this.scene?.clear();
    this._selectedMeshes = [];
    this._outlineMeshes = [];
    this._selectionEdgeMeshes = [];
    this._outlineMesh = null;
    this._selectionEdges = null;
    this._smidMeshes.clear();
    this._meshHeight.clear();
    // 场景已经清空，还挂着的动画通道（瓦片淡入 / 单体位移）不能再对着死对象写
    this.animator.clear();
    this.animator.unregisterPrefix('tile.');
    this.animator.unregisterPrefix('feature.');
    this._pathSpecs.clear();
    this._heightMin = Infinity;
    this._heightMax = -Infinity;
    this.renderer?.dispose?.();
    this.renderer = null;
    this.canvas = null;
  }

  private _createLights(): void {
    this._ambientLight = new THREE.AmbientLight(this._lightOptions.ambientColor as any, this._lightOptions.ambientIntensity);
    this._hemiLight = new THREE.HemisphereLight(
      this._lightOptions.hemisphereColor as any,
      this._lightOptions.hemisphereGroundColor as any,
      this._lightOptions.hemisphereIntensity
    );
    this._keyLight = new THREE.DirectionalLight(this._lightOptions.keyLightColor as any, this._lightOptions.keyLightIntensity);
    this._fillLight = new THREE.DirectionalLight(this._lightOptions.fillLightColor as any, this._lightOptions.fillLightIntensity);
    this._updateLights();
  }

  private _addLights(): void {
    if (!this.scene) return;
    if (!this._ambientLight) this._createLights();
    this.scene.add(this._ambientLight, this._hemiLight, this._keyLight, this._fillLight);
  }

  private _applyLightOptions(): void {
    if (this._ambientLight) {
      this._ambientLight.intensity = this._lightOptions.ambientIntensity;
      this._ambientLight.color.set(this._lightOptions.ambientColor as any);
    }
    if (this._hemiLight) {
      this._hemiLight.intensity = this._lightOptions.hemisphereIntensity;
      this._hemiLight.color.set(this._lightOptions.hemisphereColor as any);
      this._hemiLight.groundColor.set(this._lightOptions.hemisphereGroundColor as any);
    }
    if (this._keyLight) {
      this._keyLight.intensity = this._lightOptions.keyLightIntensity;
      this._keyLight.color.set(this._lightOptions.keyLightColor as any);
    }
    if (this._fillLight) {
      this._fillLight.intensity = this._lightOptions.fillLightIntensity;
      this._fillLight.color.set(this._lightOptions.fillLightColor as any);
    }
  }

  /**
   * 运行时切换光照预设：覆盖四个强度，颜色/朝向保持不变。
   * 之后再调 `setLight({...})` 仍然可以逐项微调。
   */
  /**
   * supermap 完整版 = 光照强度 + 颜色管线一起切：
   * direct 管线下纹理不做 sRGB 解码、片元按官方常数 Lambert 直乘（见 lightingPreset.ts）。
   * 两个都是模块级全局态，只影响之后创建的材质 / 纹理 —— 已加载瓦片要重载才换。
   */
  private _applyColorPipeline(preset: LightingPreset): void {
    const direct = preset === 'supermap';
    setColorPipeline(direct ? 'direct' : 'linear');
    setSrgbTextureDecode(!direct);
    // 官方不开各向异性：远处直接采高 mip 平均成纯色（"灰色滤镜"的一部分）。
    // 我们默认 Infinity（倾斜摄影立面清晰度优先），supermap 模式必须收回。
    setAnisotropyCap(direct ? 1 : Infinity);
  }

  setLightingPreset(preset: LightingPreset): void {
    Object.assign(this._lightOptions, resolveLightingPreset(preset));
    this._applyColorPipeline(preset);
    this.options.lightingPreset = preset;
    this._applyLightOptions();
    this._updateLights();
    this._needsRepaint = true;
    this.triggerRepaint();
  }

  /**
   * 动态设置光照配置
   */
  setLight(options: Partial<LightOptions>): void {
    const normalized: Partial<LightOptions> = { ...options };
    if (normalized.mainColor !== undefined && normalized.keyLightColor === undefined) {
      normalized.keyLightColor = normalized.mainColor;
    }
    if (normalized.mainIntensity !== undefined && normalized.keyLightIntensity === undefined) {
      normalized.keyLightIntensity = normalized.mainIntensity;
    }
    Object.assign(this._lightOptions, normalized);
    this._applyLightOptions();
    this._updateLights();
    this._needsRepaint = true;
    this.triggerRepaint();
  }

  /**
   * 获取当前光照配置快照
   */
  getLight(): LightOptions {
    return { ...this._lightOptions };
  }

  /**
   * 动态设置色调映射模式与曝光度
   */
  setToneMapping(toneMapping: THREE.ToneMapping, exposure = 1.0): void {
    this.options.toneMapping = toneMapping;
    this.options.toneMappingExposure = exposure;
    if (this.renderer) {
      this.renderer.toneMapping = toneMapping;
      this.renderer.toneMappingExposure = exposure;
      this._needsRepaint = true;
      this.triggerRepaint();
    }
  }

  /**
   * 获取当前色调映射模式与曝光度
   */
  getToneMapping(): { toneMapping: THREE.ToneMapping; toneMappingExposure: number } {
    return {
      toneMapping: this.renderer ? this.renderer.toneMapping : (this.options.toneMapping ?? THREE.NoToneMapping),
      toneMappingExposure: this.renderer ? this.renderer.toneMappingExposure : (this.options.toneMappingExposure ?? 1.0),
    };
  }

  /**
   * 更新光照位置与方向：
   * - 'headlamp': 随地图方位角 bearing 旋转，主光始终在镜头上方，受光面面向镜头；
   * - 'fixed': 固定世界方位角（如模拟恒定日光）。
   */
  private _updateLights(): void {
    if (!this._keyLight || !this._fillLight) return;
    const bearing = this._lightOptions.mode === 'fixed' ? 0 : (((this._getBearing?.() ?? 0) * Math.PI) / 180);
    const place = (light: THREE.DirectionalLight | null, azOffsetDeg: number, elevDeg: number): void => {
      if (!light) return;
      const az = bearing + (azOffsetDeg * Math.PI) / 180;
      const el = (elevDeg * Math.PI) / 180;
      const c = Math.cos(el);
      light.position.set(Math.sin(az) * c, Math.cos(az) * c, Math.sin(el)).multiplyScalar(1000);
    };
    place(this._keyLight, this._lightOptions.azimuth, this._lightOptions.altitude);
    place(this._fillLight, this._lightOptions.azimuth + 65, Math.max(10, this._lightOptions.altitude - 20));
    // direct 管线的官方 Lambert 用主光方向（共享 uniform，所有材质同步生效）
    if (this.uniforms?.uSunDirection && this._keyLight) {
      (this.uniforms.uSunDirection.value as THREE.Vector3).copy(this._keyLight.position).normalize();
    }
  }

  /* ---------------------------------------------------------------- 数据集 */

  private _normalizeDatasets(options: S3MViewerOptions): S3MDatasetOptions[] {
    if (Array.isArray(options.datasets))
      return options.datasets
        .filter((d) => !!d?.configUrl)
        .map((d) => ({ ...d, polygonOffset: d.polygonOffset ?? options.polygonOffset }));
    if (options.configUrl)
      return [{ id: 'default', name: '默认数据集', configUrl: options.configUrl, useWorker: options.useWorker, polygonOffset: options.polygonOffset }];
    return [];
  }

  /** 追加一个数据集。图层 addLayer 之前调用会抛错。 */
  async addDataset(ds: S3MDatasetOptions): Promise<S3MDatasetEntry> {
    if (!this.scene) throw new Error('[s3m] 图层尚未 addLayer，不能添加数据集');
    // 图层级默认值：数据集自己指定了就用自己的，见 `S3MViewerOptions.unsupported`
    const merged: S3MDatasetOptions = { ...ds, unsupported: ds.unsupported ?? this._unsupported };
    const entry = await this._datasetManager.addDataset(
      merged,
      this.scene,
      this.geo,
      this.uniforms,
      this._lodRangeScale,
      this.options.buildTile,
      this.options.maxTiles ?? 64,
      this.options.maxConcurrent ?? 4,
      {
        onTile: (node, e) => {
          this._registerTile(node, e);
          this.onStats(this.stats);
          this._needsRepaint = true;
          this._requestRepaint();
        },
        onTileRemoved: (node, e) => {
          this._unregisterTile(node, e);
          this.onStats(this.stats);
          this._needsRepaint = true;
          this._requestRepaint();
        },
        onStats: () => {
          this.onStats(this.stats);
          this._requestRepaint();
        },
        onError: (e) => {
          this.onError(e);
          this.onStats(this.stats);
        },
        onReady: (e) => {
          this.onReady(e);
          this._refreshAllHeights();
          if (!this.groundManager.excavationBounds) {
            this.groundManager.autoFitExcavation(this.datasets.values());
          }
        },
        triggerRepaint: () => {
          this._requestRepaint();
        },
      },
      this.options.maxTriangles ?? Infinity,
      this.options.maxImageCache ?? 128,
      this._authenticate
    );
    return entry;
  }

  /**
   * 归一化世界坐标 → 经纬度 [lng, lat]
   */
  private _lngLatFromWorld(x: number, y: number): [number, number] {
    return lngLatFromWorld(this.geo, x, y);
  }

  /** 当地图 CRS 投影切换或宿主 map 挂载后，重新计算场景锚点与各数据集 offset */
  recomputeAnchors(): void {
    this._datasetManager.recomputeAnchors(this.geo);
    this._refreshAllHeights();
    this._requestRepaint();
  }

  private _recomputeAnchors(): void {
    this.recomputeAnchors();
  }

  /**
   * 获取指定数据集的应用层附加垂直偏移（米，不含 align 基准）。
   * 若不传 id，默认获取第一个（或默认）数据集的偏移。
   */
  getDatasetHeight(id?: string): number {
    return this._datasetManager.getDatasetHeight(id);
  }

  /**
   * 设置指定数据集的应用层附加垂直偏移（米），正数抬升，负数下降。
   *
   * 语义为「在当前 align 基准之上再抬升多少米」：贴地（把模型抬到真实地面高程）
   * 不会破坏 align='top' 等对齐语义。
   */
  setDatasetHeight(idOrHeight: string | number, heightOffset?: number): void {
    let id: string;
    let h: number;
    if (typeof idOrHeight === 'number') {
      id = this.datasets.keys().next().value ?? '';
      h = idOrHeight;
    } else {
      id = idOrHeight;
      h = heightOffset ?? 0;
    }
    this._datasetManager.setDatasetHeight(id, h, this.geo);
    this._syncGroundHeight();
    this._refreshAllHeights();
    this._requestRepaint();
  }

  /**
   * 物理地表网格的高度跟随「主数据集的应用层抬升量」，
   * 保证贴地后地表覆盖 / 地下透视的物理关系与被抬升的模型一致。
   * `ground.trackHeight = false` 时不跟随：地表钉在当前高度，
   * 高程调整只动模型不动切割面。
   */
  private _syncGroundHeight(): void {
    if (!this.groundManager.trackHeight) return;
    const primaryId = this.datasets.keys().next().value;
    if (!primaryId) return;
    const userOffset = this._datasetManager.getDatasetHeight(primaryId);
    this.groundManager.setGroundHeight(userOffset);
  }

  /**
   * 动态设置指定数据集的垂直对齐基准（'origin' | 'bottom' | 'top' | 'center'）。
   */
  setDatasetAlign(idOrAlign: string | DatasetAlignment, align?: DatasetAlignment): void {
    let id: string;
    let a: DatasetAlignment;
    if (align === undefined && (idOrAlign === 'origin' || idOrAlign === 'bottom' || idOrAlign === 'top' || idOrAlign === 'center')) {
      id = this.datasets.keys().next().value ?? '';
      a = idOrAlign;
    } else {
      id = idOrAlign as string;
      a = align ?? 'origin';
    }
    this._datasetManager.setDatasetAlign(id, a, this.geo);
    this._refreshAllHeights();
    this._requestRepaint();
  }

  /** @internal 语义高度对齐计算代理，供内部与测试使用 */
  _computeAlignOffset(tileset: S3MTileset | any, align?: DatasetAlignment): number {
    return this._datasetManager.computeAlignOffset(tileset, align);
  }

  /** 按语义对齐方式（'top' | 'bottom' | 'center'）和数据源高度范围计算基准高度偏移 */
  computeAlignOffset(tileset: S3MTileset | null, align?: DatasetAlignment): number {
    return this._datasetManager.computeAlignOffset(tileset, align);
  }

  /* ---------------------------------------------------------------- 单体自定义样式 & 过滤 */

  /**
   * 为指定单体（SMID）设置独立自定义样式（颜色、拔高、透明度）。
   */
  setFeatureStyle(smid: number, style: FeatureStyle): void {
    this._featureStyleManager.setFeatureStyle(smid, style, this._meshesOf([smid]));
  }

  /** 批量为多个单体设置样式 */
  setFeaturesStyle(smids: number[], style: FeatureStyle): void {
    this._featureStyleManager.setFeaturesStyle(smids, style, this._meshesOf(smids));
  }

  /**
   * 把单体平移到新位置（米，场景 ENU 坐标的增量）。
   *
   * 平移写进状态纹理第 2 行，所以拾取、选中描边、棱线都会自动跟随——
   * 但**视锥剔除不会**：three 用的是几何原始包围球，移出包围球后整块瓦片会被剔掉。
   * 所以这里顺手把「有位移」的网格关掉 frustumCulled，归零时再恢复。
   */
  moveFeature(
    smid: number,
    translation: [number, number, number],
    transition?: TransitionOptions
  ): void {
    const key = this._ensureFeatureChannel(smid, 'translation');
    this.animator.to(key, translation, transition);
  }

  /** 让单体沿某个轴移动的便捷写法（单位米） */
  moveFeatureBy(
    smid: number,
    delta: [number, number, number],
    transition?: TransitionOptions
  ): void {
    const cur = this._featureStyleManager.getFeatureStyle(smid)?.translation ?? [0, 0, 0];
    this.moveFeature(smid, [cur[0] + delta[0], cur[1] + delta[1], cur[2] + delta[2]], transition);
  }

  /**
   * 让单体进行刚体姿态旋转（在 GPU 顶点着色器中以 pivot 轴心进行 3x3 矩阵旋转变换）。
   *
   * @param smid 单体 SMID
   * @param rotation 旋转弧度或姿态：数字（绕 Z 轴 yaw 弧度）| [rx, ry, rz] 欧拉角 | [x,y,z,w] 四元数 | Euler/Quaternion/Matrix
   * @param pivot 旋转中心轴心点 [px, py, pz]（局部坐标，默认 [0, 0, 0]）
   * @param transition 动画过渡参数
   */
  rotateFeature(
    smid: number,
    rotation:
      | number
      | [number, number, number]
      | [number, number, number, number]
      | THREE.Euler
      | THREE.Quaternion
      | THREE.Matrix3
      | THREE.Matrix4,
    pivot?: [number, number, number],
    transition?: TransitionOptions
  ): void {
    const cur = this._featureStyleManager.getFeatureStyle(smid) ?? {};
    if (pivot) {
      this._featureStyleManager.setFeatureStyle(smid, { ...cur, pivot }, this._meshesOf([smid]));
    }
    const targetEuler = extractEulerAngles(rotation);
    const key = this._ensureFeatureChannel(smid, 'rotation');
    this.animator.to(key, targetEuler, transition);
  }

  /** 让单体增量旋转的便捷写法 */
  rotateFeatureBy(
    smid: number,
    deltaRotation: number | [number, number, number],
    pivot?: [number, number, number],
    transition?: TransitionOptions
  ): void {
    const curEuler = extractEulerAngles(this._featureStyleManager.getFeatureStyle(smid)?.rotation);
    const d = typeof deltaRotation === 'number' ? [0, 0, deltaRotation] : deltaRotation;
    this.rotateFeature(
      smid,
      [curEuler[0] + d[0], curEuler[1] + d[1], curEuler[2] + d[2]],
      pivot,
      transition
    );
  }

  /**
   * 双纹理 GPU 交叉淡化（跨状态 / 专题图平滑过渡）。
   *
   * 采用双纹理 (uBatchTex + uBatchTex2 + uBatchMix) 硬件混合，
   * 即使几千上万栋建筑全量切换配色/高度/显隐/姿态，也无需在 CPU 逐单体创建通道，
   * 由 GPU 顶点与片元着色器以 60FPS 零成本硬件插值完成过渡。
   */
  crossFadeStyles(
    targetStyles: Map<number, FeatureStyle> | Record<string | number, FeatureStyle>,
    transition?: TransitionOptions
  ): void {
    const targetMap =
      targetStyles instanceof Map
        ? targetStyles
        : new Map(Object.entries(targetStyles).map(([k, v]) => [Number(k), v]));

    const meshes = this.getAllMeshes();
    this._featureStyleManager.prepareCrossFade(targetMap, meshes);

    const key = 'batch.mix';
    if (!this.animator.has(key)) {
      this.animator.register(key, {
        dim: 1,
        read: (out) => {
          out[0] = this.uniforms.uBatchMix?.value ?? 0;
        },
        write: (v) => {
          if (this.uniforms.uBatchMix) {
            this.uniforms.uBatchMix.value = v[0];
          }
          this.triggerRepaint();
        },
      });
    }

    const duration = transition?.duration ?? 0;
    const wantAnim = duration > 0 || !!transition?.spring;
    if (!wantAnim) {
      if (this.animator.has(key)) this.animator.cancel(key);
      if (this.uniforms.uBatchMix) this.uniforms.uBatchMix.value = 0;
      this._featureStyleManager.commitCrossFade(targetMap, meshes);
      this.triggerRepaint();
      transition?.onComplete?.();
      return;
    }

    if (this.uniforms.uBatchMix) this.uniforms.uBatchMix.value = 0;
    this.animator.to(key, 1, {
      ...transition,
      onComplete: () => {
        if (this.uniforms.uBatchMix) this.uniforms.uBatchMix.value = 0;
        this._featureStyleManager.commitCrossFade(targetMap, meshes);
        this.triggerRepaint();
        transition?.onComplete?.();
      },
    });
  }

  /**
   * 让单体沿折线运动。
   *
   * 路径先做**弧长参数化**（见 anim/Path.ts）：缓动作用在「已走距离」上，而不是
   * 顶点索引上，所以顶点疏密不均也不会忽快忽慢。
   *
   * 实现上没有引入新的 track 类型——把「进度 0→1」当成一条普通补间，通道的 write
   * 把进度映射成弧长再查表得位置。这样打断、循环、缓动、预算全部复用现有调度器。
   *
   * 注意：不要和 `moveFeature` 同时驱动同一个单体，两者都写 `translation`。
   */
  followPath(
    smid: number,
    points: Path | ArrayLike<number> | Array<[number, number, number]>,
    opts: PathFollowOptions = {}
  ): void {
    const path = points instanceof Path ? points : new Path(points, { closed: opts.closed });
    if (path.length <= 0) return;

    const offset = opts.offset ?? [0, 0, 0];
    const duration =
      opts.duration ??
      (opts.speed && opts.speed > 0 ? (path.length / opts.speed) * 1000 : 2000);

    const key = `feature.${smid}.path`;
    this._pathSpecs.set(key, { path, offset });
    if (!this.animator.has(key)) {
      this.animator.register(key, {
        dim: 1,
        // 每次都从起点开始：进度通道没有「当前值」的概念，循环时正好重置
        read: (out) => {
          out[0] = 0;
        },
        write: (v) => {
          const spec = this._pathSpecs.get(key);
          if (!spec) return;
          spec.path.sampleAt(v[0], this._pathScratch);
          const meshes = this._meshesOf([smid]);
          const cur = this._featureStyleManager.getFeatureStyle(smid) ?? {};
          this._featureStyleManager.setFeatureStyle(
            smid,
            {
              ...cur,
              translation: [
                spec.offset[0] + this._pathScratch[0],
                spec.offset[1] + this._pathScratch[1],
                spec.offset[2] + this._pathScratch[2],
              ],
            },
            meshes
          );
          // 轨迹可能跑到原始包围球外，关掉视锥剔除免得整块瓦片被剔掉
          for (const mesh of meshes) mesh.frustumCulled = false;
        },
      });
    }

    const run = (): void => {
      this.animator.to(key, 1, {
        duration,
        easing: opts.easing ?? 'linear',
        onComplete: () => {
          if (opts.loop) run();
          else opts.onComplete?.();
        },
      });
    };
    run();
  }

  /** 停下路径运动（停在当前位置，不回弹） */
  stopPath(smid: number): void {
    const key = `feature.${smid}.path`;
    this.animator.cancel(key);
    this.animator.unregister(key);
    this._pathSpecs.delete(key);
  }

  /**
   * 换算 GPU 路径单体在**当前时间**的位置与朝向。
   *
   * 位移发生在顶点着色器里，JS 侧要拿到「屏幕上现在在哪」只能按同一套公式在 CPU 复算：
   * `t = phase + uPathTime * speed`，再按 loop 模式夹到 0~1，最后查弧长表。
   * 与 StyleMaterial 的 row5 分支逐行对应，改那边时这里必须同步。
   */
  private _gpuPathPoseAt(smid: number): { pos: [number, number, number]; yaw: number } | null {
    const gp = this._featureStyleManager.getFeatureStyle(smid)?.gpuPath;
    if (!gp) return null;
    const path = this.gpuPathManager.getPath(gp.pathId);
    if (!path || path.length <= 0) return null;

    const time = this.uniforms.uPathTime?.value ?? 0;
    let t = (gp.phase ?? 0) + time * (gp.speed ?? 0);
    const loop = gp.loop;
    if (loop === 'clamp' || loop === false) {
      t = Math.min(1, Math.max(0, t));
    } else if (loop === 'pingpong') {
      t = t % 2;
      if (t < 0) t += 2;
      t = t > 1 ? 2 - t : t;
    } else {
      t = t - Math.floor(t);
    }

    path.sampleAt(t, this._pathScratch);
    const pos: [number, number, number] = [this._pathScratch[0], this._pathScratch[1], this._pathScratch[2]];

    let yaw = 0;
    if (gp.autoHeading !== false) {
      const d = 1e-3;
      path.sampleAt(Math.min(1, t + d), this._pathScratch2);
      let dx = this._pathScratch2[0] - pos[0];
      let dy = this._pathScratch2[1] - pos[1];
      if (dx * dx + dy * dy < 1e-8) {
        // 已经在终点：退回用「后一点减前一点」求切线
        path.sampleAt(Math.max(0, t - d), this._pathScratch2);
        dx = pos[0] - this._pathScratch2[0];
        dy = pos[1] - this._pathScratch2[1];
      }
      if (dx * dx + dy * dy >= 1e-8) yaw = Math.atan2(dy, dx);
    }
    return { pos, yaw };
  }

  /**
   * 注册 GPU 路径到路径库
   * @param points 折线点数组或 Path 实例
   * @param opts 选项（可指定路径 ID 或闭合）
   * @returns 路径 ID
   */
  registerGPUPath(
    points: Path | ArrayLike<number> | Array<[number, number, number]>,
    opts: { id?: number; name?: string; closed?: boolean } = {}
  ): number {
    const id = this.gpuPathManager.registerPath(points, opts);
    this.gpuPathManager.updateUniforms(this.uniforms);
    return id;
  }

  /**
   * 注销 GPU 路径
   */
  unregisterGPUPath(id: number): boolean {
    const res = this.gpuPathManager.unregisterPath(id);
    this.gpuPathManager.updateUniforms(this.uniforms);
    return res;
  }

  /**
   * 获取 GPUPathManager 实例
   */
  getGPUPathManager(): GPUPathManager {
    return this.gpuPathManager;
  }

  /**
   * 将单体绑定到 GPU 路径动画（智慧交通车流 / 大批量巡检无人机）
   * @param smid 单体 ID
   * @param path 路径 ID 或新的路径折线
   * @param options 动画配置（速度、相位、循环模式、自动朝向等）
   */
  bindGPUPath(
    smid: number,
    path: number | Path | ArrayLike<number> | Array<[number, number, number]>,
    options: Omit<GPUPathOptions, 'pathId'> = {}
  ): number {
    let pathId: number;
    if (typeof path === 'number') {
      pathId = path;
    } else {
      pathId = this.registerGPUPath(path);
    }
    const meshes = this._meshesOf([smid]);
    this._featureStyleManager.bindGPUPath(smid, pathId, options, meshes);
    for (const mesh of meshes) mesh.frustumCulled = false;
    this.gpuPathManager.updateUniforms(this.uniforms);
    return pathId;
  }

  /**
   * 解绑单体的 GPU 路径动画
   */
  unbindGPUPath(smid: number): void {
    const meshes = this._meshesOf([smid]);
    this._featureStyleManager.unbindGPUPath(smid, meshes);
    this.gpuPathManager.updateUniforms(this.uniforms);
  }

  /**
   * 手动设置单体在 GPU 路径上的归一化进度（0.0 ~ 1.0）
   */
  setGPUPathProgress(smid: number, progress: number): void {
    const meshes = this._meshesOf([smid]);
    this._featureStyleManager.setGPUPathProgress(smid, progress, meshes);
    for (const mesh of meshes) mesh.frustumCulled = false;
  }

  /**
   * 设置全局 GPU 路径时间（秒）
   */
  setGPUPathTime(time: number, autoAdvance = false): void {
    if (this.uniforms.uPathTime) {
      this.uniforms.uPathTime.value = time;
    }
    this._customPathTime = !autoAdvance;
  }

  /**
   * 获取全局 GPU 路径时间（秒）
   */
  getGPUPathTime(): number {
    return this.uniforms.uPathTime?.value ?? 0;
  }
  /**
   * 单体样式过渡：颜色 / 抬高 / 透明度 / 平移可以任意组合。
   *
   * 各属性各走一条通道，互不覆盖——同一个单体上「一边抬高一边变色」是两条独立的
   * track，写回时都是「读当前 → 改一个字段 → 写回」，不会互相冲掉。
   * `hidden` 不可插值，直接生效。
   */
  animateFeature(smid: number, style: Partial<FeatureStyle>, transition?: TransitionOptions): void {
    if (style.translation) this.moveFeature(smid, style.translation, transition);
    if (style.rotation != null) this.rotateFeature(smid, style.rotation, style.pivot, transition);
    if (style.elevation != null) {
      this.animator.to(this._ensureFeatureChannel(smid, 'elevation'), style.elevation, transition);
    }
    if (style.opacity != null) {
      this.animator.to(this._ensureFeatureChannel(smid, 'opacity'), style.opacity, transition);
    }
    if (style.color) {
      this._colorScratch.set(style.color);
      this.animator.to(
        this._ensureFeatureChannel(smid, 'color'),
        [this._colorScratch.r, this._colorScratch.g, this._colorScratch.b],
        transition
      );
    }
    if (style.hidden != null) {
      const cur = this._featureStyleManager.getFeatureStyle(smid) ?? {};
      this.setFeatureStyle(smid, { ...cur, hidden: style.hidden });
    }
  }

  /**
   * 批量单体样式过渡，支持 `stagger` 错峰。
   *
   * 错峰是这类系统性价比最高的选项：一万个单体错峰 8ms，总时长不变，但每帧只推进
   * 一小批，把峰值摊平——比任何「每帧上限」都自然。
   */
  animateFeatures(
    smids: number[],
    style: Partial<FeatureStyle>,
    transition?: TransitionOptions
  ): void {
    const stagger = transition?.stagger ?? 0;
    if (stagger <= 0) {
      for (const smid of smids) this.animateFeature(smid, style, transition);
      return;
    }
    const baseDelay = transition?.delay ?? 0;
    for (let i = 0; i < smids.length; i++) {
      this.animateFeature(smids[i], style, { ...transition, delay: baseDelay + i * stagger });
    }
  }

  /**
   * 切换着色模式，用 fade-through 代替硬切。
   *
   * `uMode` 是 int，插不了值；能做的就是「压暗 → 换 → 亮回来」。
   * 编排走 onComplete 回调而不是 Promise 链，这样换模式发生在同一帧的回调里，
   * 不会多出一帧的空白。返回的 Promise 在整段编排结束后 resolve。
   */
  setMode(mode: StyleMode, opts: { duration?: number; dim?: number } = {}): Promise<void> {
    const d = Math.max(0, opts.duration ?? 300);
    const dim = Math.min(1, Math.max(0.05, opts.dim ?? 0.35));
    if (this.style.mode === mode) return Promise.resolve();
    if (d <= 0) {
      this.setStyle({ mode });
      return Promise.resolve();
    }

    const gen = ++this._modeGen;
    return new Promise<void>((resolve) => {
      this.animator.to('style.fade', dim, {
        duration: d,
        easing: 'easeInOutQuad',
        onComplete: () => {
          // 中途又切了一次：这次编排作废，收尾交给新的那次
          if (gen !== this._modeGen) {
            resolve();
            return;
          }
          this.setStyle({ mode });
          this.animator.to('style.fade', 1, {
            duration: d,
            easing: 'easeInOutQuad',
            onComplete: resolve,
          });
        },
      });
    });
  }

  /**
   * 按需注册「单体属性」通道。
   *
   * 通道按 smid 惰性创建：绝大多数场景只动几十个单体，没必要给全城几万个 smid
   * 预先建通道。`removeFeatureStyle` / `clearFeatureStyles` 会顺手回收。
   *
   * 写回统一走 `setFeatureStyle`：它内部已经按 `_meshesOf([smid])` 收敛脏网格，
   * 所以单个单体动画每帧只重烘「含这个单体」的那一两块，不会全场景重算。
   */
  private _ensureFeatureChannel(smid: number, prop: FeatureProp): string {
    const key = `feature.${smid}.${prop}`;
    if (this.animator.has(key)) return key;

    const channel: Channel = prop === 'translation' || prop === 'color' || prop === 'rotation'
      ? {
          dim: 3,
          read: (out) => {
            if (prop === 'translation') {
              const t = this._featureStyleManager.getFeatureStyle(smid)?.translation;
              out[0] = t?.[0] ?? 0;
              out[1] = t?.[1] ?? 0;
              out[2] = t?.[2] ?? 0;
            } else if (prop === 'rotation') {
              const r = this._featureStyleManager.getFeatureStyle(smid)?.rotation;
              const euler = extractEulerAngles(r);
              out[0] = euler[0];
              out[1] = euler[1];
              out[2] = euler[2];
            } else {
              // 没有自定义色时以图层主色为起点，插值才连续
              const hex = this._featureStyleManager.getFeatureStyle(smid)?.color ?? this.style.colorA;
              this._colorScratch.set(hex);
              out[0] = this._colorScratch.r;
              out[1] = this._colorScratch.g;
              out[2] = this._colorScratch.b;
            }
          },
          write: (v) => {
            const meshes = this._meshesOf([smid]);
            const cur = this._featureStyleManager.getFeatureStyle(smid) ?? {};
            if (prop === 'translation') {
              this._featureStyleManager.setFeatureStyle(
                smid,
                { ...cur, translation: [v[0], v[1], v[2]] },
                meshes
              );
              // 有位移或旋转就关掉视锥剔除，否则移出原始包围球后整块瓦片会凭空消失
              const transMoving = Math.abs(v[0]) > 1e-6 || Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6;
              const rotEuler = extractEulerAngles(cur.rotation);
              const rotMoving = Math.abs(rotEuler[0]) > 1e-6 || Math.abs(rotEuler[1]) > 1e-6 || Math.abs(rotEuler[2]) > 1e-6;
              for (const mesh of meshes) mesh.frustumCulled = !(transMoving || rotMoving);
            } else if (prop === 'rotation') {
              this._featureStyleManager.setFeatureStyle(
                smid,
                { ...cur, rotation: [v[0], v[1], v[2]] },
                meshes
              );
              const rotMoving = Math.abs(v[0]) > 1e-6 || Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6;
              const t = cur.translation ?? [0, 0, 0];
              const transMoving = Math.abs(t[0]) > 1e-6 || Math.abs(t[1]) > 1e-6 || Math.abs(t[2]) > 1e-6;
              for (const mesh of meshes) mesh.frustumCulled = !(rotMoving || transMoving);
            } else {
              const c = this._colorScratch.setRGB(v[0], v[1], v[2]);
              this._featureStyleManager.setFeatureStyle(
                smid,
                { ...cur, color: `#${c.getHexString()}` },
                meshes
              );
            }
          },
        }
      : {
          dim: 1,
          read: (out) => {
            const st = this._featureStyleManager.getFeatureStyle(smid);
            out[0] = (prop === 'elevation' ? st?.elevation : st?.opacity) ?? (prop === 'opacity' ? 1 : 0);
          },
          write: (v) => {
            const cur = this._featureStyleManager.getFeatureStyle(smid) ?? {};
            const next: FeatureStyle = prop === 'elevation' ? { ...cur, elevation: v[0] } : { ...cur, opacity: v[0] };
            this._featureStyleManager.setFeatureStyle(smid, next, this._meshesOf([smid]));
          },
        };

    this.animator.register(key, channel);
    return key;
  }

  /** 回收某个单体的动画通道（单体被删除 / 样式被清空时调用） */
  private _releaseFeatureChannels(smid: number): void {
    for (const prop of FEATURE_PROPS) this.animator.unregister(`feature.${smid}.${prop}`);
    const pathKey = `feature.${smid}.path`;
    this.animator.unregister(pathKey);
    this._pathSpecs.delete(pathKey);
  }

  /** 获取指定单体的自定义样式 */
  getFeatureStyle(smid: number): FeatureStyle | null {
    return this._featureStyleManager.getFeatureStyle(smid);
  }

  /** 获取所有自定义样式的单体映射表 */
  getFeatureStyles(): Map<number, FeatureStyle> {
    return this._featureStyleManager.getFeatureStyles();
  }

  /** 移除指定单体的自定义样式，恢复为图层全局样式 */
  removeFeatureStyle(smid: number): void {
    this._releaseFeatureChannels(smid);
    this._featureStyleManager.removeFeatureStyle(smid, this._meshesOf([smid]));
  }

  /** 清空所有单体的自定义样式 */
  clearFeatureStyles(): void {
    for (const smid of this._featureStyleManager.getFeatureStyles().keys()) {
      this._releaseFeatureChannels(smid);
    }
    this._featureStyleManager.clearFeatureStyles();
  }

  /* ---------------------------------------------------------------- 按业务字段着色 */

  setAttributeSource(options: AttributeQueryOptions | null): void {
    this.attributeQuery = options
      ? new AttributeQuery({ ...options, authenticate: options.authenticate ?? this._authenticate })
      : null;
  }

  getLoadedSmids(): number[] {
    return [...this._smidMeshes.keys()];
  }

  auditBatches(): BatchAudit {
    const res = this._featureStyleManager.auditBatches(this._pickables.values());
    res.smids = this._smidMeshes.size;
    return res;
  }

  getThematicField(): string | null {
    return this._featureStyleManager.thematicField;
  }

  setThematicColors(colors: Map<number, string> | null, field = 'custom'): void {
    this._featureStyleManager.setThematicColors(colors, field);
  }

  clearThematic(): void {
    this._featureStyleManager.clearThematicColors();
  }

  /* ---------------------------------------------------------------- 按业务字段过滤 / 抬高 */

  getFilterField(): string | null {
    return this._featureStyleManager.fieldFilter?.field ?? null;
  }

  filterByField(options: FieldFilterOptions): Promise<FieldFilterResult> {
    return this._featureStyleManager.filterByField(options, this.attributeQuery, this.getLoadedSmids());
  }

  clearFieldFilter(): void {
    this._featureStyleManager.clearFieldFilter();
  }

  getElevationField(): string | null {
    return this._featureStyleManager.elevationField;
  }

  elevateByField(options: FieldElevationOptions): Promise<FieldElevationResult> {
    return this._featureStyleManager.elevateByField(options, this.attributeQuery, this.getLoadedSmids());
  }

  setThematicElevation(elevations: Map<number, number> | null, field = 'custom'): void {
    this._featureStyleManager.setThematicElevation(elevations, field);
  }

  clearThematicElevation(): void {
    this._featureStyleManager.clearThematicElevation();
  }

  colorByField(options: ColorByFieldOptions): Promise<ThematicResult> {
    return this._featureStyleManager.colorByField(options, this.attributeQuery, this.getLoadedSmids());
  }

  setFilter(filter: S3MFilter | null): void {
    this._featureStyleManager.setFilter(filter, this.uniforms);
  }

  getFilter(): S3MFilter | null {
    return this._featureStyleManager.filter;
  }

  clearFilter(): void {
    this._featureStyleManager.clearFilter(this.uniforms);
  }

  /* ---------------------------------------------------------------- 3D 物理地表与基坑 */

  /** 设置 3D 物理地表面渲染模式：'none' 关闭 | 'translucent' 半透明透视 | 'excavate' 基坑开挖 */
  setGroundMode(mode: GroundMode): void {
    this.groundManager.setMode(mode);
    this._requestRepaint();
  }

  /** 设置 3D 物理地表面不透明度 (0~1) */
  setGroundOpacity(opacity: number): void {
    this.groundManager.setOpacity(opacity);
    this._requestRepaint();
  }

  /** 设置基坑开挖范围 [minX, minY, maxX, maxY]（米，场景 ENU 坐标） */
  setExcavationBounds(bounds: [number, number, number, number] | null): void {
    this.groundManager.setExcavationBounds(bounds);
    this._requestRepaint();
  }

  /**
   * 开关「物理地表作为深度遮挡源」：开启后地表以下的几何被真正切掉。
   * 不依赖宿主是否开启 MapLibre terrain——深度缓冲是共用的，谁更近谁遮挡。
   */
  setGroundOcclude(enabled: boolean): void {
    this.groundManager.setOcclude(enabled);
    this._requestRepaint();
  }

  /* ---------------------------------------------------------------- 状态纹理同步 */

  private _isFeatureHidden(smid: number | null, _batchId: number): boolean {
    if (smid == null) return false;
    const ff = this._featureStyleManager.fieldFilter;
    if (ff) {
      const inSet = ff.matched.has(smid);
      if (ff.mode === 'keep' ? !inSet : inSet) return true;
    }
    const filter = this._featureStyleManager.filter;
    if (filter) {
      if (filter.include && filter.include.length > 0 && !filter.include.includes(smid)) return true;
      if (filter.exclude && filter.exclude.length > 0 && filter.exclude.includes(smid)) return true;
    }
    const st = this._featureStyleManager.featureStyles.get(smid);
    if (st?.hidden) return true;
    return false;
  }

  getAllMeshes(): THREE.Mesh[] {
    const list: THREE.Mesh[] = [];
    for (const p of this._pickables.values()) list.push(p.mesh);
    return list;
  }

  private _meshesOf(smids: Iterable<number>): Set<THREE.Mesh> {
    const out = new Set<THREE.Mesh>();
    for (const smid of smids) {
      const set = this._smidMeshes.get(smid);
      if (set) for (const mesh of set) out.add(mesh);
    }
    return out;
  }

  private _markOverridesDirty(scope: Iterable<THREE.Mesh> | 'all' = 'all'): void {
    if (scope === 'all') {
      this._featureStyleManager.markOverridesDirty(undefined, this.getAllMeshes());
    } else {
      this._featureStyleManager.markOverridesDirty(scope);
    }
  }

  flushOverrides(): void {
    this._featureStyleManager.flushOverrides();
  }

  /** @internal 内部状态纹理烘焙代理，保留供回归单测与钩子使用 */
  _applyOverridesToMesh(mesh: THREE.Mesh): void {
    this._featureStyleManager.applyOverridesToMesh(mesh);
  }

  removeDataset(id: string): void {
    const entry = this.datasets.get(id);
    if (!entry) return;
    if (this._selection?.datasetId === id) this.select(null);
    this._datasetManager.removeDataset(id, this.scene!, this.geo, (e) => {
      e.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const ud = mesh.userData as MeshUserData;
        if (ud.pickId != null) {
          this._pickables.delete(ud.pickId);
          this._releasePickId(ud.pickId);
          ud.pickId = undefined;
        }
        this._unindexMeshSmids(mesh);
        this._removeMeshHeight(mesh);
        mesh.geometry?.dispose?.();
        const styled = styledMaterialOf(mesh);
        if (styled) styled.dispose();
        if (isOwnedPointCloudMaterial(mesh.material)) (mesh.material as THREE.Material).dispose();
        this._featureStyleManager.disposeMesh(mesh);
      });
    });
    for (const [pickId, p] of this._pickables) if (p.datasetId === id) this._pickables.delete(pickId);
    this.onStats(this.stats);
    this._requestRepaint();
  }

  /** 清空当前所有数据集 */
  clearDatasets(): void {
    for (const id of [...this.datasets.keys()]) this.removeDataset(id);
  }

  setDatasetVisible(id: string, visible: boolean): void {
    this._datasetManager.setDatasetVisible(id, visible);
    if (!visible && this._selection?.datasetId === id) this.select(null);
    this._requestRepaint();
  }

  /* ---------------------------------------------------------------- 瓦片注册 */

  private _registerTile(node: TileNode, entry: S3MDatasetEntry): void {
    entry.root.add(node.group);
    node.group.updateMatrixWorld(true);

    const hasNativeEdges = node.group.userData.hasNativeEdges === true;
    // forceCpuEdges：无视数据自带的棱线包，改由 CPU 现算。native 是 1px 的
    // LineBasicMaterial，edgeWidth / 外扩 / 单体跟随全都吃不上。
    // gpu 画法由 shader 自己描边，native 线段包同样不能留
    const useNativeEdges =
      hasNativeEdges && this.style.forceCpuEdges !== true && !this._edgeModes.gpu;

    for (const child of node.group.children) {
      // 数据自带的棱线包：只跟着 edges 开关显示，不参与拾取、不参与着色
      if ((child as THREE.LineSegments).isLineSegments && (child.userData as MeshUserData).isEdgeLines) {
        // 一律登记进 _nativeEdgeLines：forceCpuEdges 之后又关掉时还要能把它们放出来
        this._nativeEdgeLines.add(child as THREE.LineSegments);
        child.visible = useNativeEdges && this._edgesEnabled;
        this._styleEdgeLine(child as THREE.LineSegments);
        continue;
      }

      // 点云是 THREE.Points 不是 Mesh，但同样要进拾取表、吃不透明度、跟着着色模式走
      const isPoints = isPointCloudObject(child);
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh && !isPoints) continue;
      if (isPoints) this._pointClouds.add(child as THREE.Points);
      // 新瓦片里的泼溅实例还没按当前视角排过，下一帧要重排
      if (isPoints) this._splatsSorted = false;
      const ud = mesh.userData as MeshUserData;
      ud.pickId = this._allocPickId();
      ud.datasetId = entry.id;
      ud.nativeEdges = useNativeEdges;
      ud.nativeEdgesRaw = hasNativeEdges;
      this._pickables.set(ud.pickId, {
        datasetId: entry.id,
        mesh,
        tile: node.tile,
        skeletonName: ud.skeletonName ?? '',
      });
      this._indexMeshSmids(mesh);
      this._addMeshHeight(mesh);
      // 点云没有「棱」：给一堆孤立点建 EdgesGeometry 又慢又没意义
      // 点云没有「棱」：给一堆孤立点建 EdgesGeometry 又慢又没意义。
      // 自动描边受三道开关控制：全局 style.edges / 数据集 enableEdges / 地形绿地等关键字跳过。
      if (!useNativeEdges && !isPoints && this._datasetEdgesEnabled(entry) && !this._shouldSkipAutoEdges(ud, entry.name)) {
        // 数据集强制开启（enableEdges: true）时全局画法可能还是关的，退回默认折边线；
        // 但 gpu 画法本来就不建几何，别在这里多此一举
        if (this._edgeModes.line || this._edgeModes.hull) this._ensureEdgeDecoration(mesh);
        else if (!this._edgeModes.gpu) this._ensureEdges(mesh);
      }

      // 新瓦片要继承当前的不透明度与着色方式
      if (isPoints) {
        this._applyPointCloudStyle(child as THREE.Points);
      } else {
        const mat = styledMaterialOf(mesh);
        if (mat) {
          const o = clampOpacity(this.style.opacity);
          // 不写 mat.opacity：全局透明度走共享 uOpacity，材质自身 opacity 保留模型自带 alpha
          // 混合开关不能写成 `o < 0.999` 一刀切：材质自身可能是 blend / 顶点 alpha
          // 透明（s3mOpts.transparent，如 SMID 4421），注册时就被这句踩掉，
          // 表现为「刚进去没透明度，切换材质质感重建后才恢复」。
          const keepDepth = this.style.depthWrite !== false;
          restoreBaseBlendState(mat, o < 0.999, keepDepth);
          // shading 走共享 uniform（uFlatShading），不写 mat.flatShading / needsUpdate——
          // transparent / depthWrite 也不是 program 决定项，整套样式继承零重编译
          if (mat.userData.uFlatShading) {
            mat.userData.uFlatShading.value = this.style.shading !== 'smooth' ? 1 : 0;
          }
          this._featureStyleManager.applyOverridesToMesh(mesh);
          this._startTileFade(mesh, mat);
        }
      }

      // 选中状态也要跟着继承：LOD 细化 / 瓦片重载会换掉 mesh，
      // 不重放就出现「点中的那栋楼一拉近就没高亮了」
      this._replaySelectionOnto(mesh);
    }
  }

  /**
   * 新瓦片淡入。
   *
   * 每块网格有自己的材质实例，所以给一个逐材质的 `uTileFade` 就够，不需要动共享
   * uniform、也不需要重建任何东西。淡入期间该网格进透明队列（混合 + 排序），
   * 淡完立刻把 `transparent` 还给图层状态，避免长期留在透明通道里。
   *
   * 通道 key 用自增序号而不是 pickId：pickId 会被回收复用，用它会串到新瓦片上。
   */
  private _startTileFade(mesh: THREE.Mesh, mat: StyledMaterial): void {
    const duration = this.style.fadeIn ?? 0;
    if (duration <= 0) return;
    const uFade = mat.userData.uTileFade;
    if (!uFade) return;

    uFade.value = 0;
    mat.transparent = true;
    // 淡入期间保持深度写入：否则能透过正在淡入的楼看到后面的东西，像在「漏」
    mat.depthWrite = true;

    const key = `tile.${this._tileFadeSeq++}.fade`;
    (mesh.userData as MeshUserData).tileFadeKey = key;
    this.animator.register(key, {
      dim: 1,
      read: (out) => {
        out[0] = uFade.value;
      },
      write: (v) => {
        uFade.value = v[0];
      },
    });
    this.animator.to(key, 1, {
      duration,
      easing: 'easeOutQuad',
      onComplete: () => {
        uFade.value = 1;
        (mesh.userData as MeshUserData).tileFadeKey = undefined;
        this.animator.unregister(key);
        // 淡入期间强制开了 transparent + depthWrite，结束时不能自己拍板关掉——
        // 先恢复「材质自身语义 || 图层透明度」的基础状态（材质可能是 blend /
        // 顶点 alpha 透明，如 SMID 4421），再让单体淡化流程有需要时重新打开。
        restoreBaseBlendState(mat, this._opacityTransparent, this.style.depthWrite !== false);
        this._featureStyleManager.applyOverridesToMesh(mesh);
        this._requestRepaint();
      },
    });
  }

  /**
   * 把「当前选中」重放到一块新登记的 mesh 上。
   *
   * 为什么需要：选中高亮是直接写在各 mesh 材质的 uSelBatch / uSelWhole 上的，
   * 而 LOD 细化、瓦片重载、淘汰回补都会换掉 mesh —— 不重放的话，用户点中的那栋楼
   * 一细化就失去高亮（状态还在 _selection.smid 里，只是没人往新 mesh 上刷）。
   */
  /**
   * 判断一块无 SMID 单体化信息的网格（如倾斜摄影或白模整块）是否空间覆盖当前选中命中点
   */
  private _isMeshCoveringSelection(mesh: THREE.Mesh, sel: PickResult): boolean {
    if (!sel.point) return false;
    const geom = mesh.geometry;
    if (!geom) return false;
    if (!geom.boundingBox) geom.computeBoundingBox();
    if (!geom.boundingBox) return false;

    // 将选中的三维场景点转入网格局部坐标系进行包围盒检测
    const pt = new THREE.Vector3(sel.point[0], sel.point[1], sel.point[2]);
    mesh.updateWorldMatrix(true, false);
    const inv = mesh.matrixWorld.clone().invert();
    const localPt = pt.applyMatrix4(inv);

    // 留出 0.5 米容差，避免刚好处于三角网格边缘缝隙时漏判
    const box = geom.boundingBox.clone().expandByScalar(0.5);
    return box.containsPoint(localPt);
  }

  private _replaySelectionOnto(mesh: THREE.Mesh): void {
    const sel = this._selection;
    if (!sel) return;
    const mat = styledMaterialOf(mesh);
    if (!mat) return;

    const ud = mesh.userData as MeshUserData;
    let batchId = -1;
    if (sel.smid != null) {
      const pickInfo = ud.geoRef?.pickInfo as Record<string | number, unknown> | undefined;
      const entry = pickInfo?.[sel.smid] ?? pickInfo?.[String(sel.smid)];
      batchId = entry ? pickEntryId(entry as any) : -1;
    }
    // 拾取命中的那块 mesh 用原始 batchId；同一 smid 散在别的几何里时按各自的区间算
    if (mesh === sel.mesh) batchId = sel.batchId;
    // 这块几何里根本没有这个单体 → 不动它（否则会把无关瓦片一起点亮）
    if (batchId < 0 && mesh !== sel.mesh) {
      if (sel.smid == null && ud.datasetId === sel.datasetId && this._isMeshCoveringSelection(mesh, sel)) {
        batchId = -1;
      } else {
        return;
      }
    }

    mat.userData.uSelBatch.value = batchId;
    mat.userData.uSelWhole.value = batchId < 0 ? 1 : 0;
    if (!this._selectedMeshes.includes(mesh)) this._selectedMeshes.push(mesh);
    if (isPointCloudObject(mesh)) this._applyPointCloudStyle(mesh, true);
    this.uniforms.uSelMix.value = 1;
    this.uniforms.uDim.value = this.style.dimOthers ? 1 : 0;
  }

  /** 瓦片被淘汰：从拾取表和场景里摘掉，并深度彻底释放所有几何体与材质显存 */
  private _unregisterTile(node: TileNode, entry: S3MDatasetEntry): void {
    node.group.traverse((child) => {
      const obj = child as any;
      if ((child as THREE.LineSegments).isLineSegments && obj.userData?.isEdgeLines) {
        this._nativeEdgeLines.delete(child as THREE.LineSegments);
      }
      if (isPointCloudObject(child)) this._pointClouds.delete(child);
      // 淡入还没结束就被淘汰：把通道收掉，否则会对着已释放的材质继续写
      if (obj.userData?.tileFadeKey) {
        this.animator.unregister(obj.userData.tileFadeKey);
        obj.userData.tileFadeKey = undefined;
      }
      if (obj.userData?.pickId != null) {
        this._pickables.delete(obj.userData.pickId);
        this._releasePickId(obj.userData.pickId);
        obj.userData.pickId = undefined;
      }
      if (obj.isMesh) {
        const wasSelected = this._selectedMeshes.includes(obj);
        if (wasSelected) {
          this._selectedMeshes = this._selectedMeshes.filter((m) => m !== obj);
        }
        const currentSel = this._selection;
        if (currentSel && currentSel.mesh === obj) {
          const smid = currentSel.smid;
          const carrier = (
            smid != null
              ? [...(this._smidMeshes.get(smid) ?? [])].find((m) => m !== obj && m.parent)
              : this._selectedMeshes.find((m) => m !== obj && m.parent && (m.parent as any).visible) ??
                this._selectedMeshes.find((m) => m !== obj && m.parent)
          ) as THREE.Mesh | undefined;
          if (carrier) {
            // 选中身份交给承载同一 smid 的另一块 mesh（通常是接替显示的子瓦）
            this._selection = { ...currentSel, mesh: carrier };
            this._replaySelectionOnto(carrier);
          } else {
            this.select(null);
          }
        }
        this._unindexMeshSmids(obj);
        this._removeMeshHeight(obj);
        this._featureStyleManager.disposeMesh(obj);
        const styled = styledMaterialOf(obj);
        styled?.dispose?.();
      }
      // 深度释放材质（点云、普通材质、材质数组）
      if (isOwnedPointCloudMaterial(obj.material)) {
        (obj.material as THREE.Material).dispose();
      } else if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m: any) => m?.dispose?.());
        } else {
          obj.material.dispose?.();
        }
      }
      // 释放几何体显存缓冲
      obj.geometry?.dispose?.();
    });
    entry.root.remove(node.group);
  }

  /**
   * 拾取 ID 只有 2 个字节（RG 两个通道），65535 个网格就到头了，
   * 所以必须回收：瓦片淘汰 / 数据集移除时把 id 还回池子。
   */
  private _allocPickId(): number {
    const reused = this._freePickIds.pop();
    if (reused !== undefined) return reused;
    if (this._pickSeq > MAX_PICK_ID) {
      for (let id = 0; id <= MAX_PICK_ID; id++) if (!this._pickables.has(id)) return id;
      throw new Error(`[s3m] 可拾取网格超过 ${MAX_PICK_ID + 1} 个，2 字节 ID 编码不够用`);
    }
    return this._pickSeq++;
  }

  private _releasePickId(id: number): void {
    this._freePickIds.push(id);
  }

  /* ---------------------------------------------------------------- 样式 */

  /** 动态设置图层整体透明度 (0.0 ~ 1.0) */
  setOpacity(opacity: number, transition?: TransitionOptions): void {
    this.setStyle({ opacity }, transition);
  }

  /**
   * 合并并应用样式。
   *
   * 只改 uniform 的项不会触发几何 / 着色器重建。带 `transition` 时，能插值的项
   * 交给动画调度器逐帧推进；不能插值的项（`mode` / `shading` / `edges`）走各自的
   * 编排逻辑（`edges` 由 setEdges 做淡入淡出，`mode` 建议配 fade-through）。
   */
  setStyle(patch: Partial<S3MStyle> = {}, transition?: TransitionOptions): void {
    Object.assign(this._styleTarget, patch);

    const duration = transition?.duration ?? 0;
    const wantAnim = duration > 0 || !!transition?.spring;

    // 棱线开关是结构变更，不是插值：交给 setEdges 编排
    let rest = patch;
    if ('edges' in patch) {
      const { edges, ...others } = patch;
      rest = others;
      this.setEdges(edges as EdgesOption, wantAnim ? transition : undefined);
      if (Object.keys(rest).length === 0) {
        this._requestRepaint();
        return;
      }
    }

    const animated: string[] = [];
    const immediate: Record<string, unknown> = {};
    for (const key of Object.keys(rest) as (keyof S3MStyle)[]) {
      if (wantAnim && this.animator.has(`style.${String(key)}`)) animated.push(String(key));
      else immediate[key] = rest[key];
    }

    if (Object.keys(immediate).length > 0) {
      Object.assign(this.style, immediate);
      this._applyStyleEffects(immediate as Partial<S3MStyle>);
    }

    for (const key of animated) {
      this.animator.to(`style.${key}`, this._animTargetOf(key, rest), {
        ...transition,
        duration,
      });
    }

    this._requestRepaint();
  }

  getStyle(): S3MStyle & { modeLabel: string } {
    return { ...this._styleTarget, modeLabel: STYLE_LABELS[this._styleTarget.mode] };
  }

  /**
   * 挂 / 摘环境贴图。
   *
   * 金属度（`setStyle({ metalness })`）**必须**有环境图才看得出质感：
   * PBR 的金属几乎没有漫反射，画面全靠 `scene.environment` 里的环境反射，
   * 没有它时 metalness 一高就整片发黑，只剩两盏平行灯打成的小高光点。
   *
   * @param source 等距柱状图（.hdr / .jpg / .png，2:1）地址，或已加载的 `THREE.Texture`；
   *               `null` = 关掉环境图
   * @param intensity 环境光强度（`scene.environmentIntensity`，默认 1）
   *
   * 传入 URL 时纹理由内部加载并转成 PMREM（预滤波 mipmap）；传 Texture 时不会接管它的生命周期。
   */
  async setEnvironment(
    source: string | THREE.Texture | null,
    intensity = 1
  ): Promise<void> {
    if (!this.renderer || !this.scene) return;
    this.scene.environmentIntensity = Math.max(0, intensity);

    if (source == null) {
      this.scene.environment = null;
      this._envRT?.dispose();
      this._envRT = null;
      this._requestRepaint();
      return;
    }

    const fromUrl = typeof source === 'string';
    const tex = fromUrl ? await new THREE.TextureLoader().loadAsync(source) : source;
    // PMREM 只认等距柱状图；普通贴图也按 2:1 全景处理
    tex.mapping = THREE.EquirectangularReflectionMapping;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    if (fromUrl) tex.dispose();

    this.scene.environment = rt.texture;
    // 上一张（同一个 viewer 反复换）要释放，否则显存里会一直堆
    this._envRT?.dispose();
    this._envRT = rt;
    this._requestRepaint();
  }

  /** 把某个样式键的取值转成动画通道能吃的形状（标量 or 线性 RGB 三元组） */
  private _animTargetOf(key: string, patch: Partial<S3MStyle>): number | number[] {
    const value = (patch as Record<string, unknown>)[key];
    const dim = this._animDimOf(key);
    if (dim === 1) return Number(value);
    this._colorScratch.set(String(value));
    return [this._colorScratch.r, this._colorScratch.g, this._colorScratch.b];
  }

  /** 该样式键的动画维度：3 = 颜色，1 = 标量 */
  private _animDimOf(key: string): 1 | 3 {
    return STYLE_COLOR_KEYS.includes(key as (typeof STYLE_COLOR_KEYS)[number]) ? 3 : 1;
  }

  /**
   * 注册样式动画通道。
   *
   * 每个通道的 write 都是 O(1)：只改 `this.style` 的一个字段 + 一次 uniform 赋值。
   * 这里不注册 `mode` / `shading` / `edges`——它们不可插值，见类文档。
   */
  private _registerAnimChannels(): void {
    for (const key of STYLE_SCALAR_KEYS) {
      this.animator.register(`style.${key}`, {
        dim: 1,
        read: (out) => {
          out[0] = Number((this.style as unknown as Record<string, number>)[key] ?? 0);
        },
        write: (v) => {
          (this.style as unknown as Record<string, number>)[key] = v[0];
          this._onStyleChannelWrote(key);
        },
      });
    }

    for (const key of STYLE_COLOR_KEYS) {
      this.animator.register(`style.${key}`, {
        dim: 3,
        read: (out) => {
          const c = this._uniformColorOf(key);
          out[0] = c.r;
          out[1] = c.g;
          out[2] = c.b;
        },
        write: (v) => {
          const c = this._uniformColorOf(key);
          // 直接写线性分量：shader 消费的就是线性值，端点严格吻合
          c.setRGB(v[0], v[1], v[2]);
          (this.style as unknown as Record<string, string>)[key] = `#${c.getHexString()}`;
          this._onStyleChannelWrote(key);
        },
      });
    }

    // 棱线淡入淡出乘子：不属于 S3MStyle，单独一条通道
    this.animator.register('style.edgeFade', {
      dim: 1,
      read: (out) => {
        out[0] = this.uniforms.uEdgeFade?.value ?? 1;
      },
      write: (v) => {
        if (this.uniforms.uEdgeFade) this.uniforms.uEdgeFade.value = v[0];
        this._syncEdgeStyle();
      },
    });

    // 整体压暗乘子：setMode 的 fade-through 用它，也不是 S3MStyle 字段
    this.animator.register('style.fade', {
      dim: 1,
      read: (out) => {
        out[0] = this.uniforms.uFade?.value ?? 1;
      },
      write: (v) => {
        if (this.uniforms.uFade) this.uniforms.uFade.value = v[0];
        this._requestRepaint();
      },
    });
  }

  /** 通道写完一个样式键后的最小副作用（全部 O(1)） */
  private _onStyleChannelWrote(key: string): void {
    if (key === 'opacity') {
      this._applyOpacity();
      return;
    }
    this._applyStyleUniforms();
    if (
      key === 'edgeColor' ||
      key === 'edgeWidth' ||
      key === 'edgeOpacity' ||
      key === 'edgeOffset' ||
      key === 'edgeHullWidth'
    ) {
      this._refreshEdgeLines();
    }
  }

  /** 取某个颜色键对应的共享 uniform Color 对象 */
  private _uniformColorOf(key: string): THREE.Color {
    const u = this.uniforms;
    switch (key) {
      case 'colorA':
        return u.uColorA.value;
      case 'colorB':
        return u.uColorB.value;
      case 'colorC':
        return u.uColorC.value;
      case 'selectColor':
        return u.uSelColor.value;
      case 'edgeColor':
        return this.edgeMaterial.uniforms.uColor.value;
      default:
        return u.uColorA.value;
    }
  }

  /** 应用一批样式键带来的副作用（uniform / 材质 / 棱线 / 选中态） */
  private _applyStyleEffects(patch: Partial<S3MStyle>): void {
    this._applyStyleUniforms();
    if ('opacity' in patch || 'depthWrite' in patch) this._applyOpacity();
    // 点云不走 StyleMaterial 的 uMode，模式切换要单独同步它的材质
    if ('mode' in patch) this._applyPointCloudStyles();
    if ('shading' in patch) this._applyShading();
    // 临界角变了要重建 CPU 棱线（EdgesGeometry 的参数），开 / 关走 setEdges 整体刷新。
    // 必须先 _disposeEdges()：setEdges 只挑「还没有棱线」的网格来建，
    // 不先拆掉的话已经建好的会被全部跳过，临界角改了等于没改。
    if (('edgeThreshold' in patch || 'forceCpuEdges' in patch) && this._edgesEnabled) {
      this._disposeEdges();
      this.setEdges(this.style.edges);
    } else if (
      'edgeColor' in patch ||
      'edgeWidth' in patch ||
      'opacity' in patch ||
      'edgeOpacity' in patch ||
      'edgeOffset' in patch ||
      'edgeHullWidth' in patch
    ) {
      // 颜色 / 粗细 / 外推距离 / 外扩厚度都只是 uniform，拖着滑块逐帧改也不重建几何
      this._refreshEdgeLines();
    }
    if (this._selection) {
      // 换描边画法要重建几何；颜色 / 粗细 / 拔高只是 uniform，拖着滑块也不卡
      if ('outline' in patch || 'outlineStyle' in patch) this.select(this._selection, { silent: true });
      else this._syncSelectionStyle();
    }
  }

  private _applyStyleUniforms(): void {
    const u = this.uniforms;
    const s = this.style;
    u.uMode.value = s.mode;
    u.uColorA.value.set(s.colorA);
    u.uColorB.value.set(s.colorB);
    u.uColorC.value.set(s.colorC);
    u.uSelColor.value.set(s.selectColor);
    u.uFloorHeight.value = s.floorHeight;

    const selMode = s.selectMode ?? SELECT_MODE.OVERLAY;
    if (u.uSelMode) {
      u.uSelMode.value =
        selMode === SELECT_MODE.REPLACE
          ? 0
          : selMode === SELECT_MODE.MULTIPLY
            ? 2
            : selMode === SELECT_MODE.GLOW_ONLY
              ? 3
              : 1;
    }
    if (u.uSelOpacity && s.selectOpacity != null) u.uSelOpacity.value = s.selectOpacity;
    if (u.uSelEmissive && s.selectEmissive != null) u.uSelEmissive.value = s.selectEmissive;
    if (u.uSelElevation && s.selectElevation != null) u.uSelElevation.value = s.selectElevation;
    if (u.uDimFactor && s.dimFactor != null) u.uDimFactor.value = s.dimFactor;

    if (u.uRoofThreshold && s.roofThreshold != null) {
      u.uRoofThreshold.value = s.roofThreshold;
    }
    if (u.uTexMix && s.texMix != null) {
      u.uTexMix.value = s.texMix;
    }
    if (u.uAmbientGain && s.ambientGain != null) {
      u.uAmbientGain.value = s.ambientGain;
    }
    // 金属度 / 粗糙度：负值 = 不覆盖，保持材质（数据）自身的值
    if (u.uMetalness) u.uMetalness.value = s.metalness ?? -1;
    if (u.uRoughness) u.uRoughness.value = s.roughness ?? -1;
    if (u.uOpacity && s.opacity != null) {
      u.uOpacity.value = clampOpacity(s.opacity);
    }
    if (this.outlineMaterial) {
      if (this.outlineMaterial.uniforms.uElevation && s.selectElevation != null) {
        this.outlineMaterial.uniforms.uElevation.value = s.selectElevation;
      }
      if (s.outlineWidth != null) this.outlineMaterial.uniforms.uWidth.value = s.outlineWidth;
      if (s.outlineColor != null) {
        this.outlineMaterial.uniforms.uColor.value.set(s.outlineColor);
      } else {
        this.outlineMaterial.uniforms.uColor.value.set(s.selectColor);
      }
    }
  }

  /**
   * 透明度：写共享 uniform，**不再逐 mesh 改材质**。
   *
   * 原来的写法每次都要遍历全部 pickables 改 `material.opacity` + `material.transparent`，
   * 是 O(meshes)；而且 `opaque` 参与 three 的 program 缓存键，跨 0.999 会换一次 program。
   * 拖滑块时一秒钟几十次调用，几十万面的场景就是明显掉帧。
   *
   * 现在逐帧只写一个 float（`uOpacity`），混合开关只在**真正跨过阈值**时切一次。
   */
  private _applyOpacity(): void {
    const o = clampOpacity(this.style.opacity);
    if (this.uniforms.uOpacity) this.uniforms.uOpacity.value = o;

    const transparent = o < 0.999;
    if (transparent !== this._opacityTransparent) {
      this._opacityTransparent = transparent;
      // 关键：若 depthWrite 开启（默认开启），即使半透明也保持深度写入，完美遮挡背面棱线，防止背面线条透出
      const keepDepth = this.style.depthWrite !== false;
      for (const p of this._pickables.values()) {
        if (isPointCloudObject(p.mesh)) continue;
        const m = styledMaterialOf(p.mesh);
        if (!m) continue;
        // 有单体淡化 / 正在淡入的材质，transparent 由各自的流程管，这里不要抢
        if (m.userData.uBatchTexActive?.value) continue;
        if ((m.userData.uTileFade?.value ?? 1) < 1) continue;
        // 材质自身可能是 blend / 顶点 alpha 透明（s3mOpts.transparent），
        // 关全局混合时不能把它一刀切成不透明
        restoreBaseBlendState(m, transparent, keepDepth);
      }
    }

    // 点云不走 StyleMaterial，自己有一套 uOpacity，逐帧刷的只有这几个对象
    for (const pc of this._pointClouds) this._applyPointCloudStyle(pc);

    this._syncEdgeStyle();
    this._requestRepaint();
  }

  /** 单个点云对象同步当前样式（着色模式 + 不透明度 + 选中高亮） */
  private _applyPointCloudStyle(points: THREE.Points, selected = this._selectedMeshes.includes(points)): void {
    applyPointCloudStyle(points, this.style, this.uniforms, selected);
  }

  /** 全部点云刷新：着色模式切换时用（uniform 是共享引用，改色不用走这里） */
  private _applyPointCloudStyles(): void {
    for (const pc of this._pointClouds) this._applyPointCloudStyle(pc);
    this._requestRepaint();
  }

  /** 平面/平滑着色：FLAT_SHADED 是编译期宏，改它必须重编译 */
  private _applyShading(): void {
    // shading 现在是共享 uniform（uFlatShading）驱动的运行期分支，不再是
    // flatShading define：翻一个 float 就完成切换，零重编译、零卡顿。
    const target = this.style.shading !== 'smooth' ? 1 : 0;
    for (const p of this._pickables.values()) {
      const m = styledMaterialOf(p.mesh);
      const u = m?.userData.uFlatShading;
      if (!u || u.value === target) continue;
      u.value = target;
    }
    this._requestRepaint();
  }

  /**
   * 运行时切换材质质感（`'pbr'` | `'lambert'`）。
   *
   * 档位是模块级设置（影响之后新建的材质）；已加载瓦片的材质在这里**原位重建**：
   * 不重拉瓦片、不重建几何，按创建时记录的参数（`userData.s3mOpts`）换一个
   * 新材质实例，并保留逐材质状态（选中编号、瓦片淡入、批量状态纹理）。
   * 切换后 program 需要重新编译一次（lambert / pbr 是不同着色器），这是唯一开销。
   */
  setMaterialQuality(q: MaterialQuality): void {
    setMaterialQuality(q);
    this._rebuildStyledMaterials();
    this._requestRepaint();
  }

  /** 当前材质质感档位 */
  get materialQuality(): MaterialQuality {
    return getMaterialQuality();
  }

  /** 按创建参数原位重建所有 styled 材质（materialQuality 切换用） */
  private _rebuildStyledMaterials(): void {
    // 逐材质 own uniform 的状态要在重建时搬过去，否则选中高亮 / 瓦片淡入会闪没
    const PRESERVED = [
      'uSelBatch',
      'uSelWhole',
      'uBatchTex',
      'uBatchTex2',
      'uBatchTexWidth',
      'uBatchTexActive',
      'uTileFade',
    ] as const;
    for (const p of this._pickables.values()) {
      const mesh = p.mesh;
      const raw = mesh.material;
      if (Array.isArray(raw)) continue; // styled 材质恒为单材质；数组材质（点云等）不归这里管
      const old = raw as StyledMaterial | undefined;
      if (!old?.userData?.isStyled || !old.userData?.s3mOpts) continue;
      const opts = old.userData.s3mOpts as StyledMaterialOptions;
      const fresh = createStyledMaterial({ ...opts, uniforms: this.uniforms });
      for (const key of PRESERVED) {
        const src = old.userData[key] as { value: unknown } | undefined;
        const dst = fresh.userData[key] as { value: unknown } | undefined;
        if (src && dst) dst.value = src.value;
      }
      mesh.material = fresh;
      old.dispose();
    }
  }

  /**
   * 预热着色 program，避免首帧同步编译。
   *
   * shading 改为 `uFlatShading` 共享 uniform 驱动后（见 `_applyShading`），
   * flat / smooth 共用同一个 program，不再存在「另一种变体」，也不需要
   * 「翻变体 → 编译 → 翻回来」的那套流程与 `_prewarming` 跳帧。这里只把当前
   * 唯一的 program 编一次（优先 `compileAsync`，KHR_parallel_shader_compile）。
   */
  async prewarmShading(): Promise<void> {
    if (this._shadingPrewarmed || this._prewarming) return;
    const r = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!r || !scene || !camera) return;

    // 场上还没有材质就没必要预热：program 会在首个材质出现时编译
    let hasMaterial = false;
    for (const p of this._pickables.values()) {
      if (styledMaterialOf(p.mesh)) {
        hasMaterial = true;
        break;
      }
    }
    if (!hasMaterial) return;

    this._shadingPrewarmed = true;
    try {
      const anyR = r as unknown as {
        compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown>;
      };
      if (typeof anyR.compileAsync === 'function') await anyR.compileAsync(scene, camera);
      else r.compile(scene, camera);
    } catch {
      // 预热失败不影响主流程：最坏情况退回「首次渲染时编译一次」
    }
    this._requestRepaint();
  }

  /**
   * 高度范围增量维护。
   *
   * 原来每注册一块瓦片都要把所有网格重新遍历一遍、每个都 clone 一个 Box3 再乘矩阵，
   * 加载 n 块瓦片就是 O(n²) 次矩阵乘 + n² 个垃圾对象。现在只在网格进出的记一次，
   * 全局值从缓存里滚：只有被移除的那块正好卡在边界上时，才回退到一次 O(n) 重算。
   */
  private _addMeshHeight(mesh: THREE.Mesh): void {
    const bb = mesh.geometry?.boundingBox;
    if (!bb) return;
    this._boxScratch.copy(bb).applyMatrix4(mesh.matrixWorld);
    const min = this._boxScratch.min.z;
    const max = this._boxScratch.max.z;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    this._meshHeight.set(mesh, { min, max });
    if (min < this._heightMin) this._heightMin = min;
    if (max > this._heightMax) this._heightMax = max;
    this._pushHeightRange();
  }

  private _removeMeshHeight(mesh: THREE.Mesh): void {
    const rec = this._meshHeight.get(mesh);
    if (!rec) return;
    this._meshHeight.delete(mesh);
    // 只有正好卡在边界上才需要重算，否则滚动的 min/max 依然成立
    if (rec.min === this._heightMin || rec.max === this._heightMax) this._recomputeHeightRange();
    else this._pushHeightRange();
  }

  /** 数据集整体位移（换高程偏移 / 重新布局）后，缓存的世界高度全部失效 */
  private _refreshAllHeights(): void {
    if (this._meshHeight.size === 0) return;
    const meshes = [...this._meshHeight.keys()];
    this._meshHeight.clear();
    this._heightMin = Infinity;
    this._heightMax = -Infinity;
    for (const mesh of meshes) this._addMeshHeight(mesh);
    this._pushHeightRange();
  }

  private _recomputeHeightRange(): void {
    let min = Infinity;
    let max = -Infinity;
    for (const h of this._meshHeight.values()) {
      if (h.min < min) min = h.min;
      if (h.max > max) max = h.max;
    }
    this._heightMin = min;
    this._heightMax = max;
    this._pushHeightRange();
  }

  private _pushHeightRange(): void {
    let min = this._heightMin;
    let max = this._heightMax;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      min = 0;
      max = 100;
    }
    this.uniforms.uHeightMin.value = min;
    this.uniforms.uHeightMax.value = max;
  }

  /** 建 SMID → 网格 反查表，逐单体改样式时才知道该重算哪几块 */
  private _indexMeshSmids(mesh: THREE.Mesh): void {
    const pickInfo = (mesh.userData as MeshUserData).geoRef?.pickInfo;
    if (!pickInfo) return;
    for (const key of Object.keys(pickInfo)) {
      const smid = Number(key);
      if (!Number.isFinite(smid) || smid < 0) continue;
      let set = this._smidMeshes.get(smid);
      if (!set) this._smidMeshes.set(smid, (set = new Set()));
      set.add(mesh);
    }
  }

  private _unindexMeshSmids(mesh: THREE.Mesh): void {
    const pickInfo = (mesh.userData as MeshUserData).geoRef?.pickInfo;
    if (!pickInfo) return;
    for (const key of Object.keys(pickInfo)) {
      const smid = Number(key);
      const set = this._smidMeshes.get(smid);
      if (!set) continue;
      set.delete(mesh);
      if (set.size === 0) this._smidMeshes.delete(smid);
    }
  }

  /**
   * 全局棱线开关。
   *
   * 取值是 `boolean | EdgeStyle | EdgeStyle[]`（见 resolveEdgeModes）：
   *   - `true` / `'line'`   折边线（旧口径）
   *   - `'offset'`          折边线 + 沿边法线外推 `edgeOffset` 米
   *   - `'hull'`            背面外扩轮廓（选中侧 outlineStyle:'hull' 的整场景版）
   *   - `'gpu'`             纯片元描边：零几何、零额外 pass，线宽约 1 像素
   *   - 数组                叠加，例如 `['line', 'hull']`
   *
   * 数据自带棱线包（primitiveType 13）时直接用，成本为零；`style.forceCpuEdges`
   * 可以无视它，改由 CPU 现算 —— 那是 CPU 端的活，几十万面一次性建会卡住主线程
   * （实测 20 个网格 1.9s），所以按 8ms 一帧切片，边建边出。
   *
   * 棱线本身用「屏幕空间等宽线」画（见 EdgeLines.ts）：WebGL 的 lineWidth 基本无效，
   * 只有摊成面向屏幕的四边形，`edgeWidth` 才能真正调粗。
   *
   * 带 `transition` 时做「淡入 / 淡出」，**不对几何做插值**（几何没法插值）：
   * 开：立刻置位 + 开始分片建线，同时 `uEdgeFade` 0→1 —— 建好一块亮一块，视觉上是渐显；
   * 关：`uEdgeFade` 1→0，淡完才 dispose，避免棱线「啪」一下消失。
   */
  setEdges(edges: EdgesOption, transition?: TransitionOptions): void {
    const wantAnim = !!transition && ((transition.duration ?? 0) > 0 || !!transition.spring);
    const modes = resolveEdgeModes(edges);
    // 换画法（line ↔ hull ↔ offset）是结构变更：旧装饰必须拆掉再建，
    // 否则会出现「切到 hull 了折边线还留着」这种叠影。
    // 同一画法重复调用（滑块逐帧 setEdges(true)）不重建，几何是复用的。
    const modesChanged = !sameEdgeModes(this._edgeModes, modes);

    this._edgeModes = modes;
    this._edgesEnabled = modes.enabled;
    this.style.edges = edges;
    this._styleTarget.edges = edges;

    // 数据自带的棱线：直接切可见性（forceCpuEdges 时永远收起，改由 CPU 现算）。
    // 只遍历注册时收集好的那批 LineSegments —— 全数据集 traverse 在几千节点下太贵。
    // gpu 模式下 shader 自己描边，native 线段包必须收起，否则叠成双线
    const nativeVisible = modes.enabled && !modes.gpu && this.style.forceCpuEdges !== true;
    for (const lines of this._nativeEdgeLines) {
      lines.visible = nativeVisible;
      this._styleEdgeLine(lines);
    }
    this._syncEdgeStyle();

    // 关掉 gpu 画法就把后处理资源还回去（整屏 RT 白占显存没意义）。
    // 必须放在「整体关闭」的早退之前，否则关棱线时永远轮不到它。
    if (!modes.gpu && this._gpuEdge) {
      this._gpuEdge.dispose();
      this._gpuEdge = null;
    }

    if (!modes.enabled) {
      if (wantAnim) {
        this.animator.to('style.edgeFade', 0, {
          ...transition,
          onComplete: () => {
            this._disposeEdges();
            this._requestRepaint();
            transition?.onComplete?.();
          },
        });
      } else {
        this._setEdgeFade(1);
        this._disposeEdges();
      }
      this._requestRepaint();
      return;
    }

    if (modesChanged) this._disposeEdges();

    const pending = [...this._pickables.values()]
      .map((p) => p.mesh)
      .filter((m) => {
        const ud = m.userData as MeshUserData;
        // 点云没有棱可描
        if (isPointCloudObject(m)) return false;
        // native 棱线还算不算数，取决于**当前**的 forceCpuEdges（它可以在运行中切换），
        // 所以这里按注册时记下的原始标记重算，而不是沿用注册那一刻的结论。
        ud.nativeEdges = ud.nativeEdgesRaw === true && this.style.forceCpuEdges !== true;
        return !ud.nativeEdges && this._needsEdgeDecoration(ud);
      });
    let i = 0;
    const step = (): void => {
      const t0 = performance.now();
      while (i < pending.length && performance.now() - t0 < 8) this._ensureEdgeDecoration(pending[i++]);
      if (i < pending.length) setTimeout(step, 0);
      else this._requestRepaint();
    };
    step();

    if (wantAnim) {
      // 从 0 起淡入：新建出来的棱线自动继承当前进度，不会半路冒出一条满亮度的线
      this._setEdgeFade(0);
      this.animator.to('style.edgeFade', 1, transition);
    } else {
      this._setEdgeFade(1);
    }
  }

  /** 直接写棱线淡入乘子（不走动画通道） */
  private _setEdgeFade(v: number): void {
    if (this.uniforms.uEdgeFade) this.uniforms.uEdgeFade.value = v;
    this._syncEdgeStyle();
  }

  /** 释放所有现算棱线几何 */
  private _disposeEdges(): void {
    for (const p of this._pickables.values()) this._removeEdges(p.mesh);
  }

  /**
   * 挂载预制棱线缓存（Crease Cache）。
   *
   * 直接把 `source-creases.f32` 这类 Float32Array 缓冲载入为一组全局统一的
   * LineSegments —— 相比逐 Mesh 现算 EdgesGeometry，性能高一个量级，视觉也最干净。
   * 坐标按「场景本地坐标」（相对场景锚点的米）处理，与瓦片几何同一坐标系。
   *
   * @param url  棱线缓存地址（二进制 Float32 序列：x,y,z,x,y,z,… 成对成段）
   */
  async loadCreases(url: string): Promise<void> {
    const resp = await authFetch(url, this._authenticate, 'creases');
    if (!resp.ok) throw new Error(`[s3m] 棱线缓存加载失败: ${resp.status} ${url}`);
    const buf = await resp.arrayBuffer();
    const arr = new Float32Array(buf);
    if (arr.length < 6) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const s = this.style;
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(s.edgeColor),
      transparent: true,
      opacity: Math.min(1, Math.max(0, s.edgeOpacity ?? 0.6)) * clampOpacity(s.opacity),
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 2;
    lines.frustumCulled = false;
    lines.raycast = () => {};

    this.clearCreases();
    this._creaseLines = lines;
    this.scene?.add(lines);
    this._requestRepaint();
  }

  /** 移除并释放预制棱线缓存 */
  clearCreases(): void {
    if (!this._creaseLines) return;
    this.scene?.remove(this._creaseLines);
    this._creaseLines.geometry.dispose();
    (this._creaseLines.material as THREE.Material)?.dispose?.();
    this._creaseLines = null;
    this._requestRepaint();
  }

  /**
   * 让全局棱线材质跟上 style.edgeColor / edgeWidth / edgeOpacity / edgeOffset。
   *
   * 全程 O(1)：只有一份共享 edgeMaterial（所有逐 mesh 棱线都用它）+ 一份预制缓存
   * + 一批共享外观对象的轮廓壳，所以棱线淡入淡出只要改一个 uniform，
   * 新建瓦片自动继承当前进度。
   */
  private _syncEdgeStyle(): void {
    const s = this.style;
    const fade = this.uniforms.uEdgeFade?.value ?? 1;
    const opacity =
      Math.min(1, Math.max(0, s.edgeOpacity ?? 0.6)) *
      clampOpacity(s.opacity) *
      fade;
    const u = this.edgeMaterial.uniforms;
    u.uColor.value.set(s.edgeColor);
    u.uWidth.value = Math.max(0.1, s.edgeWidth ?? 1.5);
    u.uOpacity.value = opacity;
    // 外推距离只在 offset 画法下非 0；其它画法把线钉在面上（与改动前一致）
    u.uOffset.value = this._edgeModes.offset ? Math.max(0, s.edgeOffset ?? 0.15) : 0;
    // 外扩轮廓壳与折边线共用颜色 / 透明度，厚度是米制的单独一项
    const h = this._hullStyleUniforms;
    h.uColor.value.set(s.edgeColor);
    h.uWidth.value = Math.max(0, s.edgeHullWidth ?? 0.9);
    h.uOpacity.value = opacity;
    // GPU 描边（edges: 'gpu'）是后处理，参数每帧从 style 现取，这里不用同步 uniform
    // 预制棱线缓存（LineBasicMaterial）同步颜色 / 不透明度
    if (this._creaseLines) {
      const m = this._creaseLines.material as THREE.LineBasicMaterial;
      m.color.set(s.edgeColor);
      m.opacity = opacity;
    }
  }

  /** 让数据自带的棱线跟着 style.edgeColor / opacity 走（这些是 LineBasicMaterial，改不了粗细） */
  private _styleEdgeLine(lines: THREE.LineSegments): void {
    const mat = lines.material as THREE.LineBasicMaterial;
    if (!mat || !mat.color) return;
    mat.color.set(this.style.edgeColor);
    const baseOpacity = this.style.edgeOpacity ?? 0.6;
    mat.opacity =
      baseOpacity *
      clampOpacity(this.style.opacity) *
      (this.uniforms.uEdgeFade?.value ?? 1);
    mat.transparent = true;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    mat.needsUpdate = true;
  }

  /**
   * 刷新所有棱线外观。
   *
   * 数据自带的棱线是逐对象的 LineBasicMaterial，改颜色只能一个个写；但原来每次都要
   * 遍历整个数据集树（几千个节点），颜色动画逐帧跑就是灾难。改成只刷注册时收集好的
   * 那批 LineSegments，复杂度降到 O(棱线条数)。
   */
  private _refreshEdgeLines(): void {
    this._syncEdgeStyle();
    for (const lines of this._nativeEdgeLines) {
      if (lines.parent) this._styleEdgeLine(lines);
    }
  }

  /** 地形 / 绿地 / 道路 / 地面铺装等不参与自动描边（数据自带棱线包另说） */
  private static readonly _EDGE_SKIP_KEYWORDS = [
    'terrain', 'ground', 'vegetation', 'green', 'road', 'dem',
    '绿地', '道路', '地面', '地形', '植被', '铺装',
  ];

  /** 数据集级别的棱线开关：enableEdges 优先，否则跟随全局 style.edges */
  private _datasetEdgesEnabled(entry: S3MDatasetEntry): boolean {
    const opt = entry.options?.enableEdges;
    if (opt === true) return true;
    if (opt === false) return false;
    return this._edgesEnabled;
  }

  /** 该 mesh 是否命中「跳过自动描边」的关键字（skeletonName / 数据集名） */
  private _shouldSkipAutoEdges(ud: MeshUserData, datasetName: string): boolean {
    const hay = `${ud.skeletonName ?? ''} ${datasetName}`.toLowerCase();
    return S3MViewer._EDGE_SKIP_KEYWORDS.some((k) => hay.includes(k));
  }

  /**
   * 这块网格还缺哪种棱线装饰（缺就建，齐了就不动）。
   *
   * setEdges 的分片建线靠它筛「还没建完的」，注册新瓦片也靠它决定要不要动手。
   */
  private _needsEdgeDecoration(ud: MeshUserData): boolean {
    if (this._edgeModes.line && !ud.edges) return true;
    if (this._edgeModes.hull && !ud.edgeHull) return true;
    return false;
  }

  /** 按当前画法补齐这块网格的棱线装饰 */
  private _ensureEdgeDecoration(mesh: THREE.Mesh): void {
    if (this._edgeModes.line) this._ensureEdges(mesh);
    if (this._edgeModes.hull) this._ensureHull(mesh);
  }

  private _ensureEdges(mesh: THREE.Mesh): void {
    const ud = mesh.userData as MeshUserData;
    if (ud.edges || ud.nativeEdges || !mesh.geometry) return;
    // 地形 / 绿地 / 道路等不参与自动描边（即使全局开棱线也要跳过）
    if (this._shouldSkipAutoEdges(ud, '')) return;

    const posAttr = mesh.geometry.getAttribute('position');
    const indexCount = mesh.geometry.index?.count ?? (posAttr ? posAttr.count : 0);
    // 棱线是 CPU 端建的，超大几何直接跳过，避免拖慢加载
    if (indexCount > 120000) return;

    // 1. 先做顶点容差焊合，让相邻三角形正确共享边索引。
    //    S3M 几何常为「每面独立顶点」，不焊合的话 EdgesGeometry 会把每条三角形边都当成边界，棱线爆炸。
    //    注意用本地实现而不是 three/examples/jsm —— jsm 子路径导入会在宿主里
    //    制造第二份 three 实例（"Multiple instances of Three.js" 警告的元凶）。
    //    tolerance 取米级模型下的 5mm，足以合并重合顶点又不会误并真实相邻面。
    const welded = mergeVerticesByPosition(mesh.geometry, 0.005);
    // 2. 调大临界角（默认 55°，可在 style.edgeThreshold 调），过滤浅坡与曲面细分，只保留真正的棱。
    const thresholdAngle = this.style.edgeThreshold ?? 55;

    // 'offset' 画法要额外带一条「边法线」才知道往哪推，所以走本地实现（它本来就算好了
    // 相邻两面法线）；其余画法保持 EdgesGeometry 这条老路，几何输出与改动前逐字一致。
    let segments: Float32Array | null;
    let normals: Float32Array | undefined;
    if (this._edgeModes.offset) {
      const raw: number[] = [];
      segments = buildFeatureEdgeSegments(welded, null, thresholdAngle, raw);
      if (raw.length > 0) normals = new Float32Array(raw);
    } else {
      const source = new THREE.EdgesGeometry(welded, thresholdAngle);
      const attr = source.getAttribute('position') as THREE.BufferAttribute | undefined;
      segments = attr ? (attr.array as Float32Array) : null;
      source.dispose();
    }
    welded.dispose();
    if (!segments || segments.length < 6) return;

    // 3. 回填每段棱线所属的单体 batchId。
    //    EdgesGeometry 只输出坐标不输出顶点号，只能拿端点坐标去查「位置 → batchId」表。
    //    没有这张表，单体一动棱线就留在原地——这正是「棱线跟随」的关键一环。
    const TOL = 0.005;
    const batchMap = buildPositionBatchMap(mesh.geometry, TOL);
    let batchIds: Float32Array | undefined;
    if (batchMap) {
      const segCount = segments.length / 6;
      batchIds = new Float32Array(segCount);
      for (let i = 0; i < segCount; i++) {
        const s = i * 6;
        batchIds[i] =
          batchMap.get(positionQuantKey(segments[s], segments[s + 1], segments[s + 2], 1 / TOL)) ?? -1;
      }
    }

    const lines = new THREE.Mesh(
      buildThickLineGeometry(segments, batchIds, normals),
      this._createEdgeMaterial(mesh)
    );
    lines.renderOrder = 2;
    // 屏幕空间外扩后可能超出原包围球，关掉剔除更稳
    lines.frustumCulled = false;
    lines.raycast = () => {};
    (lines.userData as MeshUserData).isThickEdge = true;
    ud.edges = lines;
    mesh.add(lines); // 作为子节点，自动继承 mesh 的世界变换
  }

  /**
   * 给一块网格挂「背面外扩轮廓」（整场景版）。
   *
   * 复用选中侧那套 `createOutlineMaterial`：顶点沿法线鼓 `edgeHullWidth` 米、只画背面，
   * 于是被本体挡住的部分不显示，露出来的那圈就是描边。与折边线的差别在于——
   * 这里**不建任何新几何**，成本只是把同一块网格多画一遍，折边判定那套 CPU 活全省了。
   *
   * 实例化几何拿不到逐实例变换（轮廓壳是 mesh 的子节点，不吃 instanceMatrix），
   * 直接跳过：宁可这栋没描边，也不要所有实例的壳叠在原点。
   */
  private _ensureHull(mesh: THREE.Mesh): void {
    const ud = mesh.userData as MeshUserData;
    if (ud.edgeHull || !mesh.geometry) return;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    // 地形 / 绿地 / 道路等不参与自动描边（即使全局开棱线也要跳过）
    if (this._shouldSkipAutoEdges(ud, '')) return;

    // 逐网格一份材质（各绑各的单体状态纹理），外观 uniform 复用共享对象
    const mat = createOutlineMaterial(
      this.uniforms,
      this.style.edgeHullWidth ?? 0.9,
      this._hullStyleUniforms,
      true
    );
    // 整块几何都要外扩：选中侧靠 uSelBatch 只扩一栋，全局必须置 whole
    mat.uniforms.uSelWhole.value = 1;
    mat.uniforms.uSelBatch.value = -1;
    const styled = styledMaterialOf(mesh);
    if (styled?.userData?.uBatchTex) {
      mat.uniforms.uBatchTex.value = styled.userData.uBatchTex.value as THREE.Texture;
      mat.uniforms.uBatchTexWidth.value = styled.userData.uBatchTexWidth.value as number;
      mat.uniforms.uBatchTexActive.value = styled.userData.uBatchTexActive.value as number;
    }

    const hull = new THREE.Mesh(mesh.geometry, mat);
    hull.renderOrder = 2;
    hull.frustumCulled = false;
    hull.raycast = () => {};
    (hull.userData as MeshUserData).isEdgeHull = true;
    ud.edgeHull = hull;
    mesh.add(hull); // 作为子节点，自动继承 mesh 的世界变换
  }

  /**
   * 给一块网格造专属的棱线材质。
   *
   * 棱线材质必须逐网格一份，因为它要绑定**这个网格**的单体状态纹理；但外观
   * （颜色 / 粗细 / 透明度）必须全局统一——所以外观 uniform 直接复用
   * `_edgeStyleUniforms` 里的对象，`_syncEdgeStyle()` 改一次全部生效，
   * program 也因为着色器相同而只编译一次。
   */
  private _createEdgeMaterial(mesh: THREE.Mesh): ThickLineMaterial {
    const styled = styledMaterialOf(mesh);
    const batch = styled?.userData?.uBatchTex
      ? {
          uBatchTex: styled.userData.uBatchTex,
          uBatchTex2: styled.userData.uBatchTex2,
          uBatchMix: this.uniforms.uBatchMix,
          uBatchTexWidth: styled.userData.uBatchTexWidth,
          uBatchTexActive: styled.userData.uBatchTexActive,
          uPathTex: this.uniforms.uPathTex,
          uPathCount: this.uniforms.uPathCount,
          uPathTexActive: this.uniforms.uPathTexActive,
          uPathTime: this.uniforms.uPathTime,
        }
      : undefined;
    return createThickLineMaterial(this.lineShared, {}, this._edgeStyleUniforms, batch);
  }

  /** 选中棱线的逐网格材质，道理同上 */
  private _createSelectionEdgeMaterial(mesh: THREE.Mesh): ThickLineMaterial {
    const styled = styledMaterialOf(mesh);
    const batch = styled?.userData?.uBatchTex
      ? {
          uBatchTex: styled.userData.uBatchTex,
          uBatchTex2: styled.userData.uBatchTex2,
          uBatchMix: this.uniforms.uBatchMix,
          uBatchTexWidth: styled.userData.uBatchTexWidth,
          uBatchTexActive: styled.userData.uBatchTexActive,
          uPathTex: this.uniforms.uPathTex,
          uPathCount: this.uniforms.uPathCount,
          uPathTexActive: this.uniforms.uPathTexActive,
          uPathTime: this.uniforms.uPathTime,
        }
      : undefined;
    return createThickLineMaterial(this.lineShared, {}, this._selEdgeStyleUniforms, batch);
  }

  private _removeEdges(mesh: THREE.Mesh): void {
    const ud = mesh.userData as MeshUserData;

    const lines = ud.edges;
    if (lines) {
      mesh.remove(lines);
      (lines as THREE.Mesh).geometry?.dispose();
      // 棱线材质现在是逐网格一份（要绑各自的 batch 纹理），得跟着释放
      const mat = (lines as THREE.Mesh).material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => (m as any)?.dispose?.());
      } else {
        (mat as any)?.dispose?.();
      }
      ud.edges = null;
    }

    // 外扩壳的 geometry 是**复用主网格的**，只能释放材质，不能 dispose 几何
    const hull = ud.edgeHull;
    if (hull) {
      mesh.remove(hull);
      const hmat = hull.material;
      if (Array.isArray(hmat)) hmat.forEach((m) => (m as any)?.dispose?.());
      else (hmat as any)?.dispose?.();
      ud.edgeHull = null;
    }
  }

  /* ---------------------------------------------------------------- 拾取 */

  /** 获取指定屏幕像素对应的场景射线（用于高精度求交与穿透拾取） */
  getRayAt(x: number, y: number): THREE.Ray | null {
    if (!this.camera || !this.canvas) return null;
    const canvas = this.canvas;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (!w || !h) return null;

    const ndcX = (x / w) * 2 - 1;
    const ndcY = -(y / h) * 2 + 1;

    const near = new THREE.Vector3(ndcX, ndcY, -1).unproject(this.camera);
    const far = new THREE.Vector3(ndcX, ndcY, 1).unproject(this.camera);
    const dir = far.clone().sub(near).normalize();
    return new THREE.Ray(near, dir);
  }

  private _intersectMeshAtRay(mesh: THREE.Mesh, ray: THREE.Ray, instanceIndex?: number): THREE.Vector3 | null {
    const raycaster = new THREE.Raycaster();
    raycaster.ray.copy(ray);
    const hits = raycaster.intersectObject(mesh, false);
    if (!hits.length) return null;
    if (instanceIndex != null) {
      const match = hits.find((h) => h.instanceId === instanceIndex);
      return match ? match.point : hits[0].point;
    }
    return hits[0].point;
  }

  private _buildPickResult(
    hit: { objectId: number; batchId: number; instanceIndex?: number },
    ref: PickableRef,
    exactPoint?: THREE.Vector3,
    ray?: THREE.Ray
  ): PickResult | null {
    const ud = ref.mesh.userData as MeshUserData;
    // 泼溅走独立分支：它既没有 instanceMatrix，也没有 geoRef.pickInfo 里的单体表，
    // 走下面那段会在 `_instanceFeature()` 拿到 null 直接返回 —— 表现是「点得中但拿不到结果」。
    if (ud.isGaussianSplat) return this._buildSplatPickResult(hit, ref, exactPoint, ray);
    let smid: number | null = null;
    let batchId = hit.batchId;
    let instanceIndex = hit.instanceIndex;
    let geoRef = ud.geoRef;
    let segments: Array<{ vertexOffset: number; vertexCount: number }> = [];

    if (instanceIndex != null) {
      const feature = this._instanceFeature(ref.mesh, geoRef, instanceIndex);
      if (!feature) return null;
      smid = feature.smid;
      batchId = feature.batchId;
    } else {
      geoRef = (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(hit.batchId) ?? ud.geoRef;
      const resolved = resolveFeature(geoRef, hit.batchId);
      smid = resolved.smid;
      segments = resolved.segments;
    }

    if (this._isFeatureHidden(smid, batchId)) return null;

    let box: SegmentBox | null = null;
    let totalTriangles = 0;

    if (instanceIndex != null) {
      box = this._instanceBox(ref.mesh, instanceIndex);
      totalTriangles = ref.mesh.geometry.index ? Math.round(ref.mesh.geometry.index.count / 3) : 0;
    } else if (smid != null && this._smidMeshes.has(smid)) {
      const meshes = this._smidMeshes.get(smid)!;
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      let count = 0;
      for (const m of meshes) {
        const mUd = m.userData as MeshUserData;
        const mPick = mUd.geoRef?.pickInfo;
        const entry = (mPick as Record<string | number, unknown> | undefined)?.[smid] ??
          (mPick as Record<string | number, unknown> | undefined)?.[String(smid)];
        const bId = entry ? pickEntryId(entry as any) : -1;
        const mSegs = (entry as any)?.segments ?? (bId >= 0 ? resolveFeature(mUd.geoRef, bId).segments : []);
        const mBox = measureSegments(m.geometry, mSegs);
        if (mBox) {
          if (mBox.minX < minX) minX = mBox.minX;
          if (mBox.minY < minY) minY = mBox.minY;
          if (mBox.minZ < minZ) minZ = mBox.minZ;
          if (mBox.maxX > maxX) maxX = mBox.maxX;
          if (mBox.maxY > maxY) maxY = mBox.maxY;
          if (mBox.maxZ > maxZ) maxZ = mBox.maxZ;
          count += mBox.count;
          totalTriangles += mBox.triangles;
        }
      }
      if (count > 0) {
        box = { minX, minY, minZ, maxX, maxY, maxZ, count, triangles: totalTriangles };
      }
    }

    if (!box) {
      box = measureSegments(ref.mesh.geometry, segments);
      if (!box && ref.mesh.geometry) {
        if (!ref.mesh.geometry.boundingBox) ref.mesh.geometry.computeBoundingBox();
        const bb = ref.mesh.geometry.boundingBox;
        if (bb) {
          box = {
            minX: bb.min.x,
            maxX: bb.max.x,
            minY: bb.min.y,
            maxY: bb.max.y,
            minZ: bb.min.z,
            maxZ: bb.max.z,
            count: 0,
            triangles: 0,
          };
        }
      }
    }
    const geometry = ref.mesh.geometry;
    const triangles = totalTriangles > 0 ? totalTriangles : (geometry.index ? Math.round(geometry.index.count / 3) : 0);
    const attributes = buildAttributes({ smid, box, triangles, floorHeight: this.style.floorHeight });

    let centerLngLat: [number, number] | null = null;
    if (box && this.sceneAnchor) {
      const v = new THREE.Vector3((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2);
      v.applyMatrix4(ref.mesh.matrixWorld);
      const s = this.sceneAnchor.meterInMercator;
      centerLngLat = this._lngLatFromWorld(v.x * s + this.sceneAnchor.x, -v.y * s + this.sceneAnchor.y);
    }

    // 精确命中点求交计算
    let hitPoint: THREE.Vector3 | null = exactPoint ?? null;
    if (!hitPoint && ray) {
      hitPoint = this._intersectMeshAtRay(ref.mesh, ray, instanceIndex);
    }

    let point: [number, number, number] | null = null;
    let lngLat: [number, number] | null = null;
    let altitude: number | null = null;

    if (hitPoint && this.sceneAnchor) {
      const off = smid != null ? this._featureStyleManager.getFeatureEffectiveOffset(smid) : {};
      const trans = off.translation;
      const elev = off.elevation;
      const finalPos = hitPoint.clone();

      if (off.rotation) {
        const rotMat = resolveRotationMatrix(off.rotation);
        if (rotMat) {
          const m3 = new THREE.Matrix3().set(
            rotMat[0], rotMat[1], rotMat[2],
            rotMat[3], rotMat[4], rotMat[5],
            rotMat[6], rotMat[7], rotMat[8]
          );
          const piv = off.pivot ? new THREE.Vector3(off.pivot[0], off.pivot[1], off.pivot[2]) : new THREE.Vector3(0, 0, 0);
          finalPos.sub(piv).applyMatrix3(m3).add(piv);
        }
      }

      if (trans) finalPos.add(new THREE.Vector3(trans[0], trans[1], trans[2]));
      else if (elev) finalPos.z += elev;

      point = [finalPos.x, finalPos.y, finalPos.z];
      const s = this.sceneAnchor.meterInMercator;
      lngLat = this._lngLatFromWorld(finalPos.x * s + this.sceneAnchor.x, -finalPos.y * s + this.sceneAnchor.y);
      altitude = finalPos.z + (this.sceneAnchor.altitude ?? 0);
    } else if (centerLngLat && box && this.sceneAnchor) {
      lngLat = centerLngLat;
      altitude = (box.minZ + box.maxZ) / 2 + (this.sceneAnchor.altitude ?? 0);
    }

    return {
      datasetId: ref.datasetId,
      datasetName: this.datasets.get(ref.datasetId)?.name ?? ref.datasetId,
      objectId: hit.objectId,
      batchId,
      instanceIndex,
      skeletonName: ref.skeletonName,
      centerLngLat,
      point,
      lngLat,
      altitude,
      ...attributes,
      mesh: ref.mesh,
    };
  }

  /**
   * 泼溅的拾取结果。
   *
   * 整块泼溅瓦片当一个单体（没有单体级 smid 可报），命中点由 `splatRaycast` 给出 ——
   * 它按每个高斯的 3σ 球求交，比拾取那一趟为了命中率摊开的 4px 方块准得多。
   * 包围盒必须由 `iCenter` 算：geometry 的 position 只是 [-1,1]² 的四边形角点。
   */
  private _buildSplatPickResult(
    hit: { objectId: number; batchId: number; instanceIndex?: number },
    ref: PickableRef,
    exactPoint?: THREE.Vector3,
    ray?: THREE.Ray
  ): PickResult | null {
    const anchor = this.sceneAnchor;
    if (!anchor) return null;
    const mesh = ref.mesh;

    let hitPoint = exactPoint ?? null;
    if (!hitPoint && ray) hitPoint = this._intersectMeshAtRay(mesh, ray);

    const local = splatCenterBounds(mesh.geometry);
    const box: SegmentBox | null = local
      ? {
          minX: local.minX,
          minY: local.minY,
          minZ: local.minZ,
          maxX: local.maxX,
          maxY: local.maxY,
          maxZ: local.maxZ,
          count: local.count,
          triangles: 0,
        }
      : null;

    const attributes = buildAttributes({
      smid: null,
      box,
      triangles: 0,
      floorHeight: this.style.floorHeight,
    });

    const s = anchor.meterInMercator;
    let point: [number, number, number] | null = null;
    let lngLat: [number, number] | null = null;
    let altitude: number | null = null;
    let centerLngLat: [number, number] | null = null;

    if (hitPoint) {
      point = [hitPoint.x, hitPoint.y, hitPoint.z];
      lngLat = this._lngLatFromWorld(hitPoint.x * s + anchor.x, -hitPoint.y * s + anchor.y);
      altitude = hitPoint.z + (anchor.altitude ?? 0);
      // 泼溅命中的就是一个高斯，没有「单体中心」可言，用命中点当中心
      centerLngLat = lngLat;
    } else if (box) {
      const v = new THREE.Vector3(
        (box.minX + box.maxX) / 2,
        (box.minY + box.maxY) / 2,
        (box.minZ + box.maxZ) / 2
      ).applyMatrix4(mesh.matrixWorld);
      centerLngLat = this._lngLatFromWorld(v.x * s + anchor.x, -v.y * s + anchor.y);
      altitude = v.z + (anchor.altitude ?? 0);
    }

    return {
      datasetId: ref.datasetId,
      datasetName: this.datasets.get(ref.datasetId)?.name ?? ref.datasetId,
      objectId: hit.objectId,
      batchId: -1,
      instanceIndex: undefined,
      skeletonName: ref.skeletonName,
      centerLngLat,
      point,
      lngLat,
      altitude,
      ...attributes,
      mesh,
    };
  }

  /** 按 canvas 左上角的 CSS 像素坐标拾取。 */
  pick(x: number, y: number): PickResult | null {
    if (!this.picker || !this.scene || !this.camera || !this.sceneAnchor) return null;
    const hit = this.picker.pick(this.scene, this.camera, x, y);
    if (!hit) return null;

    const ref = this._pickables.get(hit.objectId);
    if (!ref) return null;

    const ray = this.getRayAt(x, y);
    return this._buildPickResult(hit, ref, undefined, ray ?? undefined);
  }

  /**
   * 拾取指定屏幕像素对应的世界坐标与场景位置。
   * 优先与命中的建筑网格精确求交；未命中建筑时若视线与地表相交则返回地面交点。
   */
  pickPosition(x: number, y: number): { lngLat: [number, number]; altitude: number; point: [number, number, number] } | null {
    if (!this.camera || !this.sceneAnchor) return null;

    const hit = this.pick(x, y);
    if (hit?.point && hit?.lngLat && hit.altitude != null) {
      return {
        lngLat: hit.lngLat,
        altitude: hit.altitude,
        point: hit.point,
      };
    }

    const ray = this.getRayAt(x, y);
    if (!ray) return null;

    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const target = new THREE.Vector3();
    const intersect = ray.intersectPlane(groundPlane, target);
    if (intersect) {
      const s = this.sceneAnchor.meterInMercator;
      const lngLat = this._lngLatFromWorld(intersect.x * s + this.sceneAnchor.x, -intersect.y * s + this.sceneAnchor.y);
      const altitude = intersect.z + (this.sceneAnchor.altitude ?? 0);
      return {
        lngLat,
        altitude,
        point: [intersect.x, intersect.y, intersect.z],
      };
    }
    return null;
  }

  /**
   * 沿视线方向穿透拾取多个单体，按由近至远排序返回。
   */
  drillPick(x: number, y: number, limit = 10): PickResult[] {
    if (!this.sceneAnchor || !this.camera) return [];
    const ray = this.getRayAt(x, y);
    if (!ray) return [];

    const raycaster = new THREE.Raycaster();
    raycaster.ray.copy(ray);

    const meshes = [...this._pickables.values()]
      .map((p) => p.mesh)
      .filter((m) => {
        let curr: THREE.Object3D | null = m;
        while (curr) {
          if (!curr.visible) return false;
          curr = curr.parent;
        }
        return true;
      });
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return [];

    const results: PickResult[] = [];
    const seenSmids = new Set<number>();
    const seenBatches = new Set<string>();

    for (const hit of hits) {
      if (results.length >= limit) break;
      const mesh = hit.object as THREE.Mesh;
      const ud = mesh.userData as MeshUserData & { pickId?: number };
      if (ud.pickId == null) continue;
      const ref = this._pickables.get(ud.pickId);
      if (!ref) continue;

      let smid: number | null = null;
      let batchId = -1;
      let instanceIndex = hit.instanceId;

      if (instanceIndex != null) {
        const feature = this._instanceFeature(mesh, ud.geoRef, instanceIndex);
        if (!feature) continue;
        smid = feature.smid;
        batchId = feature.batchId;
      } else if (hit.faceIndex != null) {
        const batchAttr = mesh.geometry.attributes.aBatchId;
        if (batchAttr) {
          const idx = mesh.geometry.index ? mesh.geometry.index.getX(hit.faceIndex * 3) : hit.faceIndex * 3;
          batchId = Math.round(batchAttr.getX(idx));
          const geoRef = (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(batchId) ?? ud.geoRef;
          const resolved = resolveFeature(geoRef, batchId);
          smid = resolved.smid;
        }
      }

      if (smid != null) {
        if (seenSmids.has(smid)) continue;
        seenSmids.add(smid);
      } else {
        const key = `${ud.pickId}:${batchId}:${instanceIndex ?? -1}`;
        if (seenBatches.has(key)) continue;
        seenBatches.add(key);
      }

      if (this._isFeatureHidden(smid, batchId)) continue;

      const pickHit = {
        objectId: ud.pickId,
        batchId,
        instanceIndex,
      };
      const res = this._buildPickResult(pickHit, ref, hit.point);
      if (res) results.push(res);
    }

    return results;
  }

  /**
   * 获取指定 SMID 单体的经纬度包围盒 [[minLng, minLat], [maxLng, maxLat]]。
   * 若模型尚未加载到场景中或无此单体则返回 null。
   */
  getFeatureBounds(smid: number): [[number, number], [number, number]] | null {
    if (!this.sceneAnchor) return null;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let found = false;

    for (const ref of this._pickables.values()) {
      const mesh = ref.mesh;
      const ud = mesh.userData as MeshUserData;
      const geoRef = ud.geoRef;
      const pickInfo = geoRef?.pickInfo;
      if (!pickInfo) continue;

      let box: SegmentBox | null = null;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        let lookup = ud.instanceLookup as Map<number, InstanceFeature> | undefined;
        if (!lookup) {
          lookup = buildInstanceLookup(pickInfo);
          ud.instanceLookup = lookup;
        }
        for (const [instIdx, feat] of lookup) {
          if (feat.smid === smid) {
            box = this._instanceBox(mesh, instIdx);
            break;
          }
        }
      } else {
        const infoMap = pickInfo as Record<string | number, unknown>;
        const entry = infoMap[smid] ?? infoMap[String(smid)];
        if (entry) {
          const bId = pickEntryId(entry);
          const resolved = resolveFeature(geoRef, bId);
          box = measureSegments(mesh.geometry, resolved.segments);
          if (!box && mesh.geometry) {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            const bb = mesh.geometry.boundingBox;
            if (bb) {
              box = {
                minX: bb.min.x,
                maxX: bb.max.x,
                minY: bb.min.y,
                maxY: bb.max.y,
                minZ: bb.min.z,
                maxZ: bb.max.z,
                count: 0,
                triangles: 0,
              };
            }
          }
        }
      }

      if (box) {
        found = true;
        const corners = [
          new THREE.Vector3(box.minX, box.minY, box.minZ),
          new THREE.Vector3(box.maxX, box.minY, box.minZ),
          new THREE.Vector3(box.minX, box.maxY, box.minZ),
          new THREE.Vector3(box.maxX, box.maxY, box.minZ),
          new THREE.Vector3(box.minX, box.minY, box.maxZ),
          new THREE.Vector3(box.maxX, box.minY, box.maxZ),
          new THREE.Vector3(box.minX, box.maxY, box.maxZ),
          new THREE.Vector3(box.maxX, box.maxY, box.maxZ),
        ];

        const off = smid != null ? this._featureStyleManager.getFeatureEffectiveOffset(smid) : {};
        const trans = off.translation;
        const elev = off.elevation;

        const rotMat = off.rotation ? resolveRotationMatrix(off.rotation) : null;
        let rotM3: THREE.Matrix3 | null = null;
        let rotPiv: THREE.Vector3 | null = null;
        if (rotMat) {
          rotM3 = new THREE.Matrix3().set(
            rotMat[0], rotMat[1], rotMat[2],
            rotMat[3], rotMat[4], rotMat[5],
            rotMat[6], rotMat[7], rotMat[8]
          );
          rotPiv = off.pivot ? new THREE.Vector3(off.pivot[0], off.pivot[1], off.pivot[2]) : new THREE.Vector3(0, 0, 0);
        }

        // GPU 路径：位移发生在顶点着色器里，包围盒要按同一套公式在 CPU 复算，
        // 否则「运动中的车」的包围盒会停在路径原点（相机 fitBounds / 属性过滤都会错）。
        const gpuPose = smid != null ? this._gpuPathPoseAt(smid) : null;
        let headM3: THREE.Matrix3 | null = null;
        if (gpuPose && gpuPose.yaw !== 0) {
          const c = Math.cos(gpuPose.yaw);
          const s = Math.sin(gpuPose.yaw);
          // 与着色器的 mat3( c, s, 0, -s, c, 0, 0, 0, 1 ) 等价：GLSL 是列优先，
          // three 的 Matrix3.set 是行优先，所以这里写成 (c, -s; s, c) 才是同一个矩阵。
          headM3 = new THREE.Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
        }

        for (const c of corners) {
          if (rotM3 && rotPiv) c.sub(rotPiv).applyMatrix3(rotM3).add(rotPiv);
          if (headM3) {
            const piv = rotPiv ?? new THREE.Vector3(0, 0, 0);
            c.sub(piv).applyMatrix3(headM3).add(piv);
          }
          if (trans) c.add(new THREE.Vector3(trans[0], trans[1], trans[2]));
          else if (elev) c.z += elev;
          if (gpuPose) c.add(new THREE.Vector3(gpuPose.pos[0], gpuPose.pos[1], gpuPose.pos[2]));

          c.applyMatrix4(mesh.matrixWorld);
          const s = this.sceneAnchor.meterInMercator;
          const [lng, lat] = this._lngLatFromWorld(c.x * s + this.sceneAnchor.x, -c.y * s + this.sceneAnchor.y);
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }

    if (!found) return null;
    return [
      [minLng, minLat],
      [maxLng, maxLat],
    ];
  }

  /** 实例序号 → 所属单体（按网格缓存反查表，实例多的数据不用每次重建） */
  private _instanceFeature(
    mesh: THREE.Mesh,
    geoRef: GeoPackageEntry | undefined,
    instanceIndex: number
  ): InstanceFeature | null {
    const ud = mesh.userData as MeshUserData & { instanceLookup?: Map<number, InstanceFeature> };
    if (!ud.instanceLookup) ud.instanceLookup = buildInstanceLookup(geoRef?.pickInfo);
    return ud.instanceLookup.get(instanceIndex) ?? null;
  }

  /** 实例化几何的单体包围盒：base mesh 的包围盒套上该实例的矩阵 */
  private _instanceBox(mesh: THREE.Mesh, instanceIndex: number): SegmentBox | null {
    const im = mesh as THREE.InstancedMesh;
    if (!im.isInstancedMesh) return null;
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (!bb) return null;
    const m = new THREE.Matrix4();
    im.getMatrixAt(instanceIndex, m);
    const box = bb.clone().applyMatrix4(m);
    return {
      minX: box.min.x,
      minY: box.min.y,
      minZ: box.min.z,
      maxX: box.max.x,
      maxY: box.max.y,
      maxZ: box.max.z,
      count: geometry.getAttribute('position')?.count ?? 0,
      triangles: geometry.index ? Math.round(geometry.index.count / 3) : 0,
    };
  }

  /** 选中/取消选中单体。`silent` 为 true 时不回调 onPick。 */
  select(result: PickResult | null, { silent = false }: { silent?: boolean } = {}): void {
    // 清掉上一次
    if (this._selection) {
      for (const obj of this._selectedMeshes) {
        // 点云：恢复成当前着色模式（去掉选中混色）
        if (isPointCloudObject(obj)) {
          this._applyPointCloudStyle(obj, false);
          continue;
        }
        const mat = styledMaterialOf(obj as THREE.Mesh);
        if (mat) {
          mat.userData.uSelBatch.value = -1;
          mat.userData.uSelWhole.value = 0;
        }
      }
      this._selectedMeshes = [];
      this._clearSelectionDecoration();
      this._selection = null;
    }

    if (!result) {
      this.uniforms.uSelMix.value = 0;
      this.uniforms.uDim.value = 0;
      this.outlineMaterial.uniforms.uSelBatch.value = -1;
      this.outlineMaterial.uniforms.uSelWhole.value = 0;
      this.outlineMaterial.uniforms.uElevation.value = 0;
      this._requestRepaint();
      if (!silent) this.onPick(null);
      return;
    }

    this._selection = result;
    const targetMeshes = new Set<THREE.Mesh>();
    if (result.smid != null) {
      const smidSet = this._smidMeshes.get(result.smid);
      if (smidSet) {
        for (const m of smidSet) targetMeshes.add(m);
      }
    }
    targetMeshes.add(result.mesh);

    for (const mesh of targetMeshes) {
      const mat = styledMaterialOf(mesh);
      if (!mat) continue;
      let batchId = result.batchId;
      if (result.instanceIndex != null && mesh === result.mesh) {
        batchId = result.batchId;
      } else if (result.smid != null) {
        const ud = mesh.userData as MeshUserData;
        const pickInfo = ud.geoRef?.pickInfo;
        const entry = (pickInfo as Record<string | number, unknown> | undefined)?.[result.smid] ??
          (pickInfo as Record<string | number, unknown> | undefined)?.[String(result.smid)];
        const bId = entry ? pickEntryId(entry as any) : -1;
        batchId = bId >= 0 ? bId : (mesh === result.mesh ? result.batchId : -1);
      }
      mat.userData.uSelBatch.value = batchId;
      // 没有单体化信息时整块高亮，否则会出现「点中了但什么都没亮、其他全暗了」
      mat.userData.uSelWhole.value = batchId < 0 ? 1 : 0;
      this._selectedMeshes.push(mesh);
    }
    // 点云没有单体粒度：整块混成 selectColor，让选中至少看得见
    for (const mesh of this._selectedMeshes) {
      if (isPointCloudObject(mesh)) this._applyPointCloudStyle(mesh, true);
    }
    this.uniforms.uSelMix.value = 1;
    this.uniforms.uDim.value = this.style.dimOthers ? 1 : 0;

    if (this.style.outline) {
      // 棱线 / 外扩轮廓都是按「面」设计的，点云画不出来也不该画
      const decoMeshes = [...targetMeshes].filter((m) => !isPointCloudObject(m));
      if (decoMeshes.length) {
        if ((this.style.outlineStyle ?? 'edges') === 'edges') {
          this._addSelectionEdges(result, decoMeshes);
        } else {
          this._addSelectionHull(result, decoMeshes);
        }
      }
    }
    this._requestRepaint();
  }

  /**
   * 选中单体的棱线：只挑这个单体自己的三角面算折边，再画成屏幕空间等宽线。
   * 抽出来的线段数很少（一栋楼通常几百到几千条），所以选中开销可以忽略。
   */
  private _addSelectionEdges(result: PickResult, meshes: Iterable<THREE.Mesh>): void {
    this._syncSelectionStyle();
    for (const mesh of meshes) {
      const ud = mesh.userData as MeshUserData;
      const geoRef = ud.geoRef;
      let segments: PickSegment[] = [];
      // 这块网格上的棱线全部属于选中的那个单体，整批填同一个 batchId，
      // 顶点着色器才能从状态纹理里取到平移 / 拔高——选中跟随移动靠它。
      let batchId = -1;
      if (mesh === result.mesh && result.instanceIndex != null) {
        // 实例化几何没有逐单体的顶点区间，整个 base mesh 就是这一栋的外形
        segments = [{ vertexOffset: 0, vertexCount: mesh.geometry.getAttribute('position')?.count ?? 0 }];
        const pickInfo = geoRef?.pickInfo;
        const entry = (pickInfo as Record<string | number, unknown> | undefined)?.[result.smid ?? ''] ??
          (pickInfo as Record<string | number, unknown> | undefined)?.[String(result.smid)];
        batchId = entry ? pickEntryId(entry as any) : -1;
      } else if (result.smid != null) {
        const pickInfo = geoRef?.pickInfo;
        const entry = (pickInfo as Record<string | number, unknown> | undefined)?.[result.smid] ??
          (pickInfo as Record<string | number, unknown> | undefined)?.[String(result.smid)];
        const bId = entry ? pickEntryId(entry as any) : -1;
        batchId = bId;
        segments = (entry as any)?.segments ?? (bId >= 0 ? resolveFeature(geoRef, bId).segments : []);
      } else if (mesh === result.mesh) {
        const localGeo = (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(result.batchId) ?? geoRef;
        segments = resolveFeature(localGeo, result.batchId).segments;
        batchId = result.batchId;
      }

      const pairs = buildFeatureEdgeSegments(mesh.geometry, segments);
      if (pairs && pairs.length > 0) {
        const batchIds = batchId >= 0 ? new Float32Array(pairs.length / 6).fill(batchId) : undefined;
        const lines = new THREE.Mesh(
          buildThickLineGeometry(pairs, batchIds),
          this._createSelectionEdgeMaterial(mesh)
        );
        lines.renderOrder = 4;
        // 屏幕空间外扩后可能超出原包围球，关掉剔除更稳
        lines.frustumCulled = false;
        lines.raycast = () => {};
        (lines.userData as MeshUserData).isSelectionEdge = true;
        if (mesh === result.mesh && result.instanceIndex != null) {
          this._applyInstanceTransform(lines, result);
        }
        mesh.add(lines); // 作为子节点，直接继承世界变换
        this._selectionEdgeMeshes.push(lines);
      }
    }

    if (this._selectionEdgeMeshes.length === 0) {
      // 抽不出折边（退化几何 / 没有任何夹角）时退回外扩轮廓，至少保证选中可见
      this._addSelectionHull(result, meshes);
      return;
    }
    this._selectionEdges = this._selectionEdgeMeshes[0] ?? null;
  }

  /** 实例化几何：把某个实例的矩阵套到一个普通 Mesh/子节点上（子节点不参与父级的 instanceMatrix） */
  private _applyInstanceTransform(obj: THREE.Object3D, result: PickResult): void {
    const im = result.mesh as THREE.InstancedMesh;
    if (result.instanceIndex == null || !im.isInstancedMesh) return;
    const m = new THREE.Matrix4();
    im.getMatrixAt(result.instanceIndex, m);
    m.decompose(obj.position, obj.quaternion, obj.scale);
  }

  /** 旧的描边画法：背面外扩法，整块几何一起上，靠 uSelBatch 只显示选中那栋 */
  private _addSelectionHull(result: PickResult, meshes: Iterable<THREE.Mesh>): void {
    const instanced = result.instanceIndex != null;
    // 实例化：轮廓是这个实例的单独一份副本（普通 Mesh），所以整份都画；
    // 顶点区间型：整块几何一起画，靠 uSelBatch 只显示选中那栋。
    this.outlineMaterial.uniforms.uSelBatch.value = instanced ? -1 : result.batchId;
    this.outlineMaterial.uniforms.uSelWhole.value = instanced || result.batchId < 0 ? 1 : 0;
    this.outlineMaterial.uniforms.uElevation.value = instanced
      ? this._selectionElevation(result)
      : this.style.selectElevation ?? 0;

    for (const mesh of meshes) {
      const mat = styledMaterialOf(mesh);
      if (mat?.userData?.uBatchTex) {
        this.outlineMaterial.uniforms.uBatchTex.value = mat.userData.uBatchTex.value as THREE.Texture;
        this.outlineMaterial.uniforms.uBatchTexWidth.value = mat.userData.uBatchTexWidth.value as number;
        this.outlineMaterial.uniforms.uBatchTexActive.value = mat.userData.uBatchTexActive.value as number;
      }
      const outline = new THREE.Mesh(mesh.geometry, this.outlineMaterial);
      outline.renderOrder = 3;
      outline.frustumCulled = false;
      outline.raycast = () => {};
      if (mesh === result.mesh && result.instanceIndex != null) {
        this._applyInstanceTransform(outline, result);
      }
      mesh.add(outline); // 作为子节点，直接继承世界变换
      this._outlineMeshes.push(outline);
    }
    this._outlineMesh = this._outlineMeshes[0] ?? null;
  }

  /** 只改 uniform：颜色 / 粗细 / 拔高，拖着滑块实时生效，不重建几何 */
  private _syncSelectionStyle(): void {
    const s = this.style;
    const u = this.selectionEdgeMaterial.uniforms;
    u.uColor.value.set(s.outlineColor ?? s.selectColor);
    u.uWidth.value = Math.max(0.1, s.outlineWidthPx ?? 3);
    u.uOpacity.value = clampOpacity(s.opacity);
    // 只加全局 selectElevation：单体自己的拔高已经写在状态纹理第 2 行 z 里，
    // 顶点着色器采样时带出来了，这里再加一次就会双重拔高
    if (u.uElevation) u.uElevation.value = s.selectElevation ?? 0;

    // 外扩描边是另一个材质实例，单体状态纹理的开关是建的时候抄过去的。
    // 先选中、再抬高（或反过来）时模板会停留在旧值，这里补一次同步。
    for (const outline of this._outlineMeshes) {
      const parent = outline.parent as THREE.Mesh | null;
      const ud = parent ? styledMaterialOf(parent)?.userData : null;
      if (ud?.uBatchTex) {
        this.outlineMaterial.uniforms.uBatchTex.value = ud.uBatchTex.value;
        this.outlineMaterial.uniforms.uBatchTexWidth.value = ud.uBatchTexWidth.value;
        this.outlineMaterial.uniforms.uBatchTexActive.value = ud.uBatchTexActive.value;
      }
    }
  }

  /** 选中单体的实际拔高 = 全局选中拔高 + 该单体的独立拔高（与着色器口径一致） */
  private _selectionElevation(result: PickResult): number {
    let elev = this.style.selectElevation ?? 0;
    if (result.smid != null) {
      const off = this._featureStyleManager.getFeatureEffectiveOffset(result.smid);
      if (off.elevation) elev += off.elevation;
    }
    return elev;
  }

  private _clearSelectionDecoration(): void {
    for (const outline of this._outlineMeshes) {
      outline.parent?.remove(outline);
    }
    this._outlineMeshes = [];
    this._outlineMesh = null;

    for (const edges of this._selectionEdgeMeshes) {
      edges.parent?.remove(edges);
      edges.geometry.dispose();
    }
    this._selectionEdgeMeshes = [];
    this._selectionEdges = null;
  }

  /* ---------------------------------------------------------------- 渲染 */

  /**
   * 执行一帧 GPU 描边（法线 + 深度后处理）。
   *
   * 参数全部来自 style，不缓存：`edgeWidth` 在这里是「采样偏移」，线宽 ≈ 2×它；
   * `edgeThreshold` 是折边敏感度（夹角小于它不描），和 CPU 折边线同一口径。
   */
  private _renderGpuEdges(canvas: HTMLCanvasElement): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    const s = this.style;
    const fade = this.uniforms.uEdgeFade?.value ?? 1;
    const opacity =
      Math.min(1, Math.max(0, s.edgeOpacity ?? 0.6)) * clampOpacity(s.opacity) * fade;
    if (opacity <= 0.004) return;

    if (!this._gpuEdge) this._gpuEdge = new GpuEdgePass();
    if (!this._gpuEdge.supported(this.renderer)) return;

    // 度数 → 归一化法线差（|Δn| = 2·sin(θ/2)），乘 0.6 让阈值落在「刚好能描出」的位置
    const deg = Math.min(179, Math.max(1, s.edgeThreshold ?? 55));
    const normalThreshold = 2 * Math.sin((deg * Math.PI) / 360) * 0.6;

    this._gpuEdge.render(this.renderer, this.scene, this.camera, canvas.width, canvas.height, {
      color: this._gpuEdgeColor.set(s.edgeColor),
      opacity,
      radius: Math.max(1, s.edgeWidth ?? 1.5),
      normalThreshold,
      depthThreshold: 0.08,
    });
  }

  /** 等宽线要按设备像素换算线宽：uResolution 用绘图缓冲尺寸，uDpr 是缓冲 / CSS 的比值 */
  private _updateLineResolution(canvas: HTMLCanvasElement): void {
    const w = canvas.width || 1;
    const h = canvas.height || 1;
    const cssW = canvas.clientWidth || w;
    this.lineShared.uResolution.value.set(w, h);
    this.lineShared.uDpr.value = Math.max(1, w / cssW);
  }

  /** 当前 LOD 切换距离缩放系数 */
  get lodRangeScale(): number {
    return this._lodRangeScale;
  }

  /* ------------------------------------------------ LOD 屏幕高度 / 面数预算 */

  /** 当前 LOD 判定用的 DPR 上限。Infinity = 不截断 */
  get lodPixelRatioCap(): number {
    return this._lodPixelRatioCap;
  }

  /**
   * 调整 LOD 判定屏幕高度的 DPR 上限（默认 Infinity = 不截断，行为与旧版一致）。
   *
   * 传 2 = 「按 CSS 高度 × 2 截断」：3x DPR 手机上把 2556 的判定高度压到 ~1704，
   * 少约半层 LOD 的细化，观感几乎无损。传 `Infinity` 恢复原口径。
   */
  setLodPixelRatioCap(cap: number): void {
    const next = cap > 0 ? cap : Infinity;
    this._lodPixelRatioCap = next;
    this.options.lodPixelRatioCap = next;
    this._requestRepaint();
  }

  /**
   * 计算 LOD 判定用的屏幕高度（像素）。
   *
   * 默认原样返回 `canvasHeight`（绘图缓冲物理像素，官方 `calcPixFromCam` 的口径）。
   * 只有在 `lodPixelRatioCap` 有限时才去读 `clientHeight` 并按 CSS 高度截断——
   * 离屏 canvas 没有布局尺寸（clientHeight 为 0）时退回原口径。
   */
  private _lodScreenHeight(canvasHeight: number): number {
    const cap = this._lodPixelRatioCap;
    if (!Number.isFinite(cap)) return canvasHeight;
    const cssHeight = this.canvas?.clientHeight ?? 0;
    if (cssHeight <= 0) return canvasHeight;
    return Math.min(canvasHeight, cssHeight * cap);
  }

  /** 当前纹理缓存条数上限 */
  get maxImageCache(): number {
    return this.options.maxImageCache ?? 128;
  }

  /**
   * 调整纹理缓存条数。不传 `datasetId` 时对所有已存在数据集立即生效，
   * 并作为之后新增数据集的默认值。缓存是 LRU，降下来不会立刻释放，下次淘汰时生效。
   */
  setMaxImageCache(n: number, datasetId?: string): void {
    const next = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 128;
    if (datasetId) {
      const entry = this.datasets.get(datasetId);
      if (entry?.tileset) entry.tileset.maxImageCache = next;
    } else {
      this.options.maxImageCache = next;
      for (const entry of this.datasets.values()) {
        if (entry.tileset) entry.tileset.maxImageCache = next;
      }
    }
    this._requestRepaint();
  }

  /** 当前每个数据集的驻留面数预算。Infinity = 不限制 */
  get maxTriangles(): number {
    return this.options.maxTriangles ?? Infinity;
  }

  /**
   * 调整每个数据集驻留三角形总数的软上限（默认 Infinity = 不限制）。
   * 不传 `datasetId` 时对所有已存在数据集立即生效，并作为之后新增数据集的默认值。
   * 实际裁剪发生在下一次 `update()` 末尾，不会当场掉内容。
   */
  setMaxTriangles(n: number, datasetId?: string): void {
    const next = n > 0 ? n : Infinity;
    if (datasetId) {
      const entry = this.datasets.get(datasetId);
      if (entry?.tileset) entry.tileset.setMaxTriangles(next);
    } else {
      this.options.maxTriangles = next;
      for (const entry of this.datasets.values()) {
        if (entry.tileset) entry.tileset.setMaxTriangles(next);
      }
    }
  }

  /** 当前各向异性过滤上限。Infinity = 不封顶 */
  get anisotropyCap(): number {
    return this.options.anisotropyCap ?? Infinity;
  }

  /**
   * 调整各向异性过滤上限（默认 Infinity = 取 GPU 最大值）。
   * 只影响**之后创建**的纹理——已上传的纹理需要重新上传才会变，代价远大于收益，
   * 所以切换档位请在建图层前决定，或接受「新瓦片按新档位、旧瓦片保持原样」。
   */
  setAnisotropyCap(cap: number): void {
    const next = Number.isFinite(cap) && cap > 0 ? Math.max(1, cap) : Infinity;
    this.options.anisotropyCap = next;
    const gpuMax = this.renderer?.capabilities.getMaxAnisotropy?.() ?? 1;
    setMaxAnisotropy(gpuMax, next);
    this._requestRepaint();
  }

  /** 当前纹理长边像素上限。Infinity = 不限制 */
  get maxTextureSize(): number {
    return this.options.maxTextureSize ?? Infinity;
  }

  /**
   * 调整纹理长边像素上限（默认 Infinity = 不限制）。
   * 只影响之后解码的纹理；非图集的 RGBA / WebP 产物按 2× 减半逼近上限。
   * 注意这是**模块级**设置（图集 / 解码 Worker 共享），多 viewer 实例会互相覆盖。
   */
  setMaxTextureSize(n: number): void {
    const next = Number.isFinite(n) && n >= 1 ? n : Infinity;
    this.options.maxTextureSize = next;
    setTextureSizeCap(next);
    this._requestRepaint();
  }

  /**
   * 动态调整 LOD 切换范围缩放系数。
   * scale > 1 时倾向保留粗模（降低瓦片请求与面数）；scale < 1 时提前细化加载高精瓦片。
   */
  setLodRangeScale(scale: number, datasetId?: string): void {
    if (scale <= 0) return;
    if (datasetId) {
      const entry = this.datasets.get(datasetId);
      if (entry?.tileset) entry.tileset.lodRangeScale = scale;
    } else {
      this._lodRangeScale = scale;
      for (const entry of this.datasets.values()) {
        if (entry.tileset) entry.tileset.lodRangeScale = scale;
      }
    }
    this._requestRepaint();
  }

  /**
   * 泼溅实例按视深 back-to-front 重排：alpha 混合是顺序相关的，
   * 乱序混合就是满屏彩色噪点。相机没动且没有新瓦片时整个跳过；
   * 单个瓦片顺序本来就对时 sortSplatMesh 内部也会跳过重写。
   */
  private _sortSplats(): void {
    const cam = this.camera;
    if (!cam) return;
    if (this._splatsSorted && this._lastSplatSortView.equals(cam.matrixWorldInverse)) return;
    for (const pc of this._pointClouds) {
      if (!(pc.userData as { isGaussianSplat?: boolean }).isGaussianSplat) continue;
      sortSplatMesh(pc as unknown as THREE.Mesh, cam.matrixWorldInverse);
    }
    this._lastSplatSortView.copy(cam.matrixWorldInverse);
    this._splatsSorted = true;
  }

  /**
   * 渲染一帧。所有宿主相关量都由调用方喂进来，viewer 不碰任何地图 API：
   *
   * @param mvp        宿主本帧的 world→clip 矩阵（列主序 16 元素）
   * @param cameraEnu  相机在场景 ENU 里的位置（米，相对场景锚点）
   * @param fovRad     垂直视场角（弧度），用于 LOD 屏幕误差
   * @param canvasHeight 绘图缓冲高度（像素），LOD 判定用
   * @returns 是否需要宿主继续驱动下一帧（动态着色 / 瓦片加载中 / LOD 发生变化）
   */
  renderFrame(opts: {
    mvp: ArrayLike<number>;
    cameraEnu: [number, number, number];
    fovRad: number;
    canvasHeight: number;
  }): boolean {
    if (!this.renderer || !this.scene || !this.camera || !this.sceneAnchor || !this.canvas) return false;
    // 上下文丢失期间（丢失→恢复之间）不要尝试渲染，否则会刷一堆 GL 错误
    const gl = this.renderer.getContext() as WebGLRenderingContext | null;
    if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) return false;

    // shading 预热期间材质是「另一种变体」，这一帧先不画：少画一两帧看不出来，
    // 把平滑的楼画成平面的一眼就能看出来。
    if (this._prewarming) return true;

    // 先推进动画，再刷脏标记，最后渲染 —— 保证本帧画出来的是最新值
    const animating = this.animator.tick();

    // 脏标记正常由微任务刷掉；这里再兜一次底，保证「本帧画出来的」一定是最新样式
    this.flushOverrides();

    const canvas = this.canvas;
    const s = this.sceneAnchor.meterInMercator;

    // ENU → 世界坐标：x 向东，y 向北（墨卡托 y 朝南，所以取负），z 向上
    this._enuMatrix.set(
      s, 0, 0, this.sceneAnchor.x,
      0, -s, 0, this.sceneAnchor.y,
      0, 0, s, this.sceneAnchor.z,
      0, 0, 0, 1
    );

    // 正交模式由宿主在传入 mvp 前自行替换（见 s3m-maplibre 的 S3MLayer._applyOrtho），
    // 视图矩阵是从宿主输入反推的（P⁻¹×MVP），不会和宿主的 pan/zoom/pitch 错位。
    const mvp = this._frameMvp.fromArray(opts.mvp as number[]);
    mvp.multiply(this._enuMatrix);
    this.camera.projectionMatrix.copy(mvp);
    this.camera.projectionMatrixInverse.copy(mvp).invert();

    // 相机在场景 ENU 中的位置
    const camEnu = opts.cameraEnu;

    // 补齐相机的真实场景坐标与世界矩阵逆矩阵，确保依赖 matrixWorldInverse 的场景正常运作
    this.camera.position.set(camEnu[0], camEnu[1], camEnu[2]);
    this.camera.matrixWorld.setPosition(camEnu[0], camEnu[1], camEnu[2]);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();

    // 更新 3D 物理地表面中心随相机延伸
    this.groundManager.update(this.camera);

    // 弧度视场角。MapLibre v5 起 transform.fov 是「度」，当弧度用会让
    // LOD 屏幕误差算大 20% 以上（提前加载更细的瓦片）—— 换算由宿主负责。
    let tilesetChanged = false;
    // LOD 判定高度：默认就是绘图缓冲高度（物理像素，与官方口径一致）；
    // 配了 lodPixelRatioCap 才按 CSS 高度截断，默认状态下这两行不产生任何开销。
    const lodScreenHeight = this._lodScreenHeight(opts.canvasHeight);
    for (const entry of this.datasets.values()) {
      if (!entry.visible || !entry.tileset) continue;
      const local: [number, number, number] = [
        camEnu[0] - entry.offset[0],
        camEnu[1] - entry.offset[1],
        camEnu[2] - entry.offset[2],
      ];
      if (entry.tileset.update(local, opts.fovRad, lodScreenHeight)) {
        tilesetChanged = true;
      }
    }

    if (this.style.mode === STYLE.DYNAMIC) {
      this.uniforms.uTime.value += 0.016 * (this.style.speed ?? 1);
    }

    this.gpuPathManager.updateUniforms(this.uniforms);
    const gpuPathActive = (this.uniforms.uPathTexActive?.value ?? 0) > 0;
    if (gpuPathActive && !this._customPathTime && this.uniforms.uPathTime) {
      this.uniforms.uPathTime.value += 0.016;
    }

    this._updateLights();

    // 等宽棱线按设备像素撑开，分辨率每帧同步一次
    this._updateLineResolution(canvas);
    // 泼溅的最小像素半径 / 抗锯齿低通同样要把 ndc 换算成像素
    setSplatViewport(canvas.width, canvas.height);

    this.renderer.setViewport(0, 0, canvas.width, canvas.height);
    this.renderer.resetState();
    // 完全透明时什么都不画：透明物体照样写深度，画了会在底图上挖出一个洞。
    // 这里跳过的是「本层的绘制」，宿主自己的清屏 / 底图照旧。
    if ((this.uniforms.uOpacity?.value ?? 1) > OPACITY_EPS) {
      this._sortSplats();
      this.renderer.render(this.scene, this.camera);
      // GPU 描边必须画在主场景之后：它的全屏 quad 参与宿主深度测试，
      // 依赖本帧已经写好的深度（被地形挡住的地方不该描边）
      if (this._edgeModes.gpu) this._renderGpuEdges(canvas);
    }

    this._frame++;
    const now = performance.now();
    if (now - this._fps.last > 500) {
      this._fps.value = Math.round((this._frame * 1000) / (now - this._fps.last));
      this._frame = 0;
      this._fps.last = now;
    }

    // 动态着色 / 动画进行中 / 瓦片加载中 / 瓦片层级或可见性改变，都需要宿主继续驱动下一帧。
    // 动画结束那一帧必须精确回到 false，否则 MapLibre 会永远重绘（耗电、发热）。
    const needsNextFrame =
      animating ||
      this.style.mode === STYLE.DYNAMIC ||
      gpuPathActive ||
      this.stats.loading > 0 ||
      tilesetChanged;

    // 首帧画完、场上有材质了，再把另一种 shading 变体编出来（异步，不挡当前帧）
    if (this._prewarmShadingEnabled && !this._shadingPrewarmed && this._pickables.size > 0) {
      void this.prewarmShading();
    }

    return needsNextFrame;
  }

  /* ---------------------------------------------------------------- 只读属性 */

  get fps(): number {
    return this._fps.value;
  }

  get stats(): Stats {
    const total: Stats = {
      tiles: 0,
      loading: 0,
      failed: 0,
      meshes: 0,
      vertices: 0,
      triangles: 0,
      datasets: this.datasets.size,
      drawCalls: 0,
      programs: 0,
      textures: 0,
      geometries: 0,
      degradations: [],
    };
    let degradations: DegradationKind[] | null = null;
    for (const entry of this.datasets.values()) {
      const s = entry.tileset?.stats;
      if (!s) continue;
      total.tiles += s.tiles;
      total.loading += s.loading;
      total.failed += s.failed;
      total.meshes += s.meshes;
      total.vertices += s.vertices;
      total.triangles += s.triangles;
      // 降级项跨数据集去重：同一类只报一次给 UI
      if (s.degradations?.length) {
        degradations ??= [];
        for (const d of s.degradations) {
          if (!degradations.includes(d)) degradations.push(d);
        }
      }
    }
    if (degradations) total.degradations = degradations;
    // GPU 侧预算观测：draw call / program / 显存驻留。没有渲染器（未 mount /
    // 纯解析场景）时保持 0，不抛错。
    const info = this.renderer?.info;
    if (info) {
      total.drawCalls = info.render.calls;
      total.programs = info.programs?.length ?? 0;
      total.textures = info.memory.textures;
      total.geometries = info.memory.geometries;
    }
    return total;
  }

  /** 所有数据集合并后的经纬度包围盒 */
  getBounds(): [[number, number], [number, number]] | null {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const entry of this.datasets.values()) {
      // 同 DatasetManager.getBounds：退化 / 越界的 geoBounds 不参与，避免视角甩到 (0,0)
      const b = usableGeoBounds(entry.tileset?.config?.geoBounds);
      if (!b) continue;
      minLon = Math.min(minLon, b.left);
      maxLon = Math.max(maxLon, b.right);
      minLat = Math.min(minLat, b.bottom);
      maxLat = Math.max(maxLat, b.top);
    }
    if (!isFinite(minLon)) return null;
    return [
      [minLon, minLat],
      [maxLon, maxLat],
    ];
  }

  dispose(): void {
    this.unmount();
  }
}
