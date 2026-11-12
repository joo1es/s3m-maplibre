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
import type { BuildTileFn, TileNode, TileVisibilityTest } from '../tileset/S3MTileset.js';
import type { AuthenticateFn } from '../core/AuthFetch.js';
import { setSplatViewport } from './GeometryBuilder.js';
import { setMaxAnisotropy, setCompressedTexturesSupported, setTextureOffThreadDecode, setMaxTextureSize as setTextureSizeCap } from './TextureFactory.js';
import type { TextureCreateOptions } from './TextureFactory.js';
import { getMaterialQuality, normalizeMaterialQuality, getColorPipeline, normalizeColorPipeline } from './StyleMaterial.js';
import type { LightingPreset } from './lightingPreset.js';
import { LightRig } from './viewer/LightRig.js';
import { HeightIndex } from './viewer/HeightIndex.js';
import { SplatLayer } from './viewer/SplatLayer.js';
import { EdgeDecorator } from './viewer/EdgeDecorator.js';
import { PickService } from './viewer/PickService.js';
import { SelectionDecorator } from './viewer/SelectionDecorator.js';
import { AnalysisService } from './viewer/AnalysisService.js';
import { OPACITY_EPS, clampOpacity, isPointCloudObject, styledMaterialOf } from './viewer/materialHelpers.js';
import { TilePlacement } from './viewer/TilePlacement.js';
import { PathFollow } from './viewer/PathFollow.js';
import { TileRegistry } from './viewer/TileRegistry.js';
import { StyleController } from './viewer/StyleController.js';
import { OverlayLayer } from './overlay/OverlayLayer.js';
import type { PathSpec } from './viewer/PathFollow.js';
import type {
  LightOptions,
  S3MViewerOptions,
  PickResult,
  PickableRef,
  PathFollowOptions,
  DepthMode,
  MeshUserData,
} from './viewer/types.js';
import { decodeTextureWithWorker } from '../worker/S3MWorkerClient.js';
import {
  STYLE,
  STYLE_LABELS,
  DEFAULT_STYLE,
  createSharedUniforms,
  createOutlineMaterial,
  restoreBaseBlendState,
} from './StyleMaterial.js';
import type {
  OutlineMaterial,
  StyledMaterial,
  StyledMaterialOptions,
  StyleMode,
  S3MStyle,
  EdgeModes,
  EdgesOption,
  MaterialQuality,
  ColorPipeline,
} from './StyleMaterial.js';
import { applyPointCloudStyle, isOwnedPointCloudMaterial } from './PointCloudMaterial.js';
import type { DegradationKind, UnsupportedPolicy } from '../core/degradations.js';
import { Picker } from './Picker.js';
import { GpuEdgePass } from './GpuEdgePass.js';
import { MotionBlurPass, normalizeMotionBlur, autoMotionBlurDamp } from './MotionBlurPass.js';
import type { MotionBlurOptions, MotionBlurConfig } from './MotionBlurPass.js';
import { PresenterTarget } from './PresenterTarget.js';
import type { ViewerPresenter, PresenterContext } from './PresenterTarget.js';
import { Animator } from '../anim/Animator.js';
import type {
  ClipOptions,
  LineOfSightOptions,
  LineOfSightResult,
  LngLatAlt,
  MeasureResult,
  SkylineResult,
  Vec3,
  ViewshedResult,
} from '../analysis/index.js';
import type { Channel, TransitionOptions } from '../anim/Animator.js';
import { Path } from '../anim/Path.js';
import type { EasingFn, EasingName } from '../anim/easing.js';
import type { LineSharedUniforms, ThickLineMaterial } from './EdgeLines.js';
import { GPUPathManager } from './GPUPathManager.js';
import type { GPUPathOptions } from './FeatureStyleManager.js';
import type { InstanceFeature } from '../core/FeatureInfo.js';
import { AttributeQuery } from '../core/AttributeQuery.js';
import type { AttributeQueryOptions } from '../core/AttributeQuery.js';
import type {
  FeatureAttributes,
  GeoPackageEntry,
  ParsedTile,
  SegmentBox,
  Stats,
  StyleUniforms,
} from '../core/types.js';

import { lngLatFromWorld, worldFromLngLat, type GeoAdapter } from './GeoAdapter.js';
import { computeTilePlacement } from './tilePlacement.js';

import {
  DatasetManager,
  normalizeDatasetOptions,
  type DatasetAlignment,
  type S3MDatasetOptions,
  type S3MDatasetEntry,
} from './DatasetManager.js';

import {
  FeatureStyleManager,
  type FeatureStyle,
  type ColorByFieldOptions,
  type ThematicResult,
  type BatchAudit,
  type FieldFilterOptions,
  type FieldFilterResult,
  type FieldElevationOptions,
  type FieldElevationResult,
  type S3MFilter,
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

/* 公共类型定义在 viewer/types.ts；这里 re-export 保持既有 import 路径不变 */
export type {
  PickResult,
  LightOptions,
  S3MViewerOptions,
  PickableRef,
  PathFollowOptions,
  DepthMode,
} from './viewer/types.js';
export type { MotionBlurOptions, MotionBlurConfig } from './MotionBlurPass.js';
export type { ViewerPresenter, PresenterContext } from './PresenterTarget.js';

/** 稳健归一化 depthMode 入参，默认 'scene' */
export function normalizeDepthMode(mode?: unknown): DepthMode {
  if (mode === 'clear') return 'clear';
  if (mode === 'auto') return 'auto';
  return 'scene';
}

/**
 * 拾取反解瓦片级放置时的临时矩阵。命中点→规范 ENU 是一次独立查询（鼠标事件），
 * 复用一个实例避免每次分配；不可重入（`_toCanonicalScene` 内部不递归调用）。
 */

/* ------------------------------------------------------------------ 可动画的样式键 */


/** 可动画的单体属性 */
const FEATURE_PROPS = ['translation', 'elevation', 'opacity', 'color', 'rotation'] as const;
type FeatureProp = (typeof FEATURE_PROPS)[number];

/** 单体沿折线运动的参数 */
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
  /** 棱线装饰（见 viewer/EdgeDecorator.ts） */
  private readonly _edges: EdgeDecorator;

  /** 3D 物理地表面 / 基坑开挖管理器 */
  readonly groundManager: GroundManager;

  /**
   * 三维覆盖物底座（见 render/overlay/OverlayLayer.ts）。
   *
   * 它不预设任何图元形态：飞线、光柱、范围罩子、glb 模型都走 `overlay.add()`，
   * 使用者自己造 three 对象，这里只负责锚点、重锚补偿、帧驱动和生命周期。
   * 只依赖 scene / 锚点 / 重绘三样设施，不认 smid 与瓦片。
   */
  readonly overlay: OverlayLayer;
  /** 多数据集生命周期与锚点管理器 */
  private readonly _datasetManager = new DatasetManager();
  /**
   * 本图层的光照模型档位。
   *
   * `undefined` = 没指定，跟随模块级默认（`getMaterialQuality()`）—— 老代码
   * `setMaterialQuality('lambert')` 一行改全场的用法靠这条继续有效。
   * 传了值就只认自己，多图层同页各用各的，互不覆盖。
   */
  private _materialQuality: MaterialQuality | undefined;
  private _lodTransition: 'binary' | 'incremental';
  private _fallbackOffset?: { factor?: number; units?: number };
  /**
   * 本图层的颜色管线。
   *
   * `undefined` = 没指定，跟随模块级默认（`getColorPipeline()`）。
   * 与 materialQuality 同理：传了值就只认自己，同页多图层互不污染 —— 这条尤其重要，
   * 因为 `lightingPreset: 'supermap'` 会同时改管线、纹理解码方式与各向异性，
   * 以前是三个模块级全局一起被改写。
   */
  private _colorPipeline: ColorPipeline | undefined;
  /** fade-through 编排的代次：中途再切一次，旧编排作废（与 setMode 同一套） */
  private _pipelineGen = 0;
  /** 空间分析（量算 / 通视 / 裁剪 / 天际线 / 可视域），见 viewer/AnalysisService.ts */
  private readonly _analysis: AnalysisService;
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
  get sceneAnchor(): {
    x: number;
    y: number;
    z: number;
    meterInMercatorEast?: number;
    meterInMercatorNorth?: number;
    meterInMercatorUp?: number;
    meterInMercator: number;
    altitude?: number;
  } | null {
    return this._datasetManager.sceneAnchor;
  }
  set sceneAnchor(
    val: {
      x: number;
      y: number;
      z: number;
      meterInMercatorEast?: number;
      meterInMercatorNorth?: number;
      meterInMercatorUp?: number;
      meterInMercator: number;
      altitude?: number;
    } | null
  ) {
    this._datasetManager.sceneAnchor = val;
    this._placement.reapply();
  }

  /** 拾取表 / pickId 池 / 射线求交（见 viewer/PickService.ts） */
  private readonly _picks: PickService;
  /** SMID → 包含它的网格。改单个单体样式时只重算这几块，不用全量扫 */
  private readonly _smidMeshes = new Map<number, Set<THREE.Mesh>>();
  /** 每块网格的世界高度范围，用来增量维护 uHeightMin / uHeightMax */
  /** 世界高度范围增量维护（见 viewer/HeightIndex.ts） */
  private readonly _heights: HeightIndex;
  /** 选中态与装饰（见 viewer/SelectionDecorator.ts） */
  private readonly _sel: SelectionDecorator;

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
  /** `feature.<smid>.path` → 路径规格（unmount 与移除样式时都要清，所以留在宿主） */
  private readonly _pathSpecs = new Map<string, PathSpec>();
  /** 沿路径运动（CPU 补间 + GPU 实例化），见 viewer/PathFollow.ts */
  private readonly _paths: PathFollow;
  /** 瓦片注册 / 注销，见 viewer/TileRegistry.ts */
  private readonly _tiles: TileRegistry;
  /** 图层视觉状态（样式补间 / uniform / 不透明度 / 材质档位），见 viewer/StyleController.ts */
  private readonly _styles: StyleController;
  /** 路径采样临时对象，避免每帧 new */
  /** 求切线用的第二个采样点（包围盒换算 GPU 路径朝向时用） */

  /** 点云对象集合：透明度动画时只刷它们，避免每帧遍历全部 pickables */
  private readonly _pointClouds = new Set<THREE.Points>();
  /** 泼溅排序调度（见 viewer/SplatLayer.ts） */
  private readonly _splats = new SplatLayer();
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
  /** 主场景绘制期间暂存 `camera.matrixWorld`（见 renderFrame 视图归一） */
  private readonly _drawKeepWorld = new THREE.Matrix4();
  /** 颜色换算用的临时对象，避免每帧 new */
  private readonly _colorScratch = new THREE.Color();
  private _frame = 0;
  private readonly _fps = { value: 0, last: 0 };
  /** 光源 / 色调映射 / 环境贴图（见 viewer/LightRig.ts） */
  private readonly _lights: LightRig;

  private readonly _datasetQueue: S3MDatasetOptions[];

  /** 宿主重画信号与地图朝向，构造时注入 */
  private _onRequestRepaint: () => void = () => {};
  private _getBearing: (() => number) | undefined;
  /** 鉴权适配（全局默认），构造时注入 */
  private readonly _authenticate: AuthenticateFn | undefined;
  /** 视锥细化剔除开关，默认 false（issue #25 第一期） */
  private _cullRefine = false;
  /** 逐帧复用：视锥与球心测试用的临时向量，避免每帧 new */
  private _frustum?: THREE.Frustum;
  private _cullTestVec?: THREE.Vector3;
  private _lodRangeScale = 1.0;
  /** 图层级降级策略，数据集可覆盖，见 `S3MViewerOptions.unsupported` */
  private readonly _unsupported: UnsupportedPolicy;
  /** LOD 判定屏幕高度的 DPR 上限。Infinity = 不截断（默认，行为同旧版） */
  private _lodPixelRatioCap = Infinity;
  /**
   * 运动模糊配置（默认 null = 关闭）。归一化后的形状见 `normalizeMotionBlur`；
   * pass 延迟到首帧才建（构造期 renderer 都还没有）。
   */
  private _motionBlurCfg: MotionBlurConfig | null = null;
  private _motionBlur: MotionBlurPass | null = null;
  /**
   * 使用者接管「场景 → 屏幕」的钩子（默认 null = 库自己合成）。
   * 设了就独占上屏，并且与 motionBlur 互斥 —— 两者都想接管同一步，同时开必然打架。
   */
  private _presenter: ViewerPresenter | null = null;
  /** presenter 的 RT 载体。延迟到首次 render 才建，没设 presenter 时零开销 */
  private readonly _presenterTarget = new PresenterTarget();
  /**
   * 瓦片级放置（默认关）。关时 `_registerTile` 完全不碰瓦片矩阵，代码路径与改动前
   * 逐字一致；开时每块瓦片用自己的中心纬度算尺度，见 `tilePlacement.ts`。
   */
  /** 瓦片级放置（按每块瓦片自己的中心纬度算尺度），见 viewer/TilePlacement.ts */
  private readonly _placement: TilePlacement;
  private readonly _perTilePlacement: boolean;
  /** 本层绘制前深度缓冲的处理策略：'scene' | 'clear' | 'auto'，默认 'scene' */
  private _depthMode: DepthMode = 'scene';

  /** 宿主请求重画（MapLibre 传 triggerRepaint，纯 three 宿主传自己的渲染循环） */
  private _requestRepaint(): void {
    this._onRequestRepaint();
  }

  triggerRepaint(): void {
    this._requestRepaint();
  }

  constructor(options: S3MViewerOptions = {}) {
    // 视觉状态控制器最先建：构造期就要用它下发渲染 profile（此时 style 还没赋值，
    // 所以 host 成员一律写成 getter，用的时候才读）
    const self2 = this;
    this._styles = new StyleController({
      get animator() {
        return self2.animator;
      },
      get uniforms() {
        return self2.uniforms;
      },
      get style() {
        return self2.style;
      },
      get styleTarget() {
        return self2._styleTarget;
      },
      get outlineMaterial() {
        return self2.outlineMaterial;
      },
      get edgeMaterial() {
        return self2.edgeMaterial;
      },
      get groundManager() {
        return self2.groundManager;
      },
      get datasetManager() {
        return self2._datasetManager;
      },
      get featureStyles() {
        return self2._featureStyleManager;
      },
      get picks() {
        return self2._picks;
      },
      get sel() {
        return self2._sel;
      },
      get edges() {
        return self2._edges;
      },
      get pointClouds() {
        return self2._pointClouds;
      },
      get datasets() {
        return self2.datasets;
      },
      get options() {
        return self2.options;
      },
      camera: () => this.camera,
      renderer: () => this.renderer,
      scene: () => this.scene,
      opacityTransparent: () => this._opacityTransparent,
      setOpacityTransparent: (val) => {
        this._opacityTransparent = val;
      },
      nextPipelineGen: () => ++this._pipelineGen,
      shadingPrewarmed: () => this._shadingPrewarmed,
      setShadingPrewarmed: (val) => {
        this._shadingPrewarmed = val;
      },
      prewarming: () => this._prewarming,
      setPrewarming: (val) => {
        this._prewarming = val;
      },
      colorPipeline: () => this.colorPipeline,
      setColorPipeline: (val) => {
        this._colorPipeline = val;
      },
      materialQuality: () => this.materialQuality,
      setEdges: (edges, transition) => this.setEdges(edges, transition),
      select: (r, opts) => this.select(r, opts),
      requestRepaint: () => this.triggerRepaint(),
    });

    this.options = options;
    this.pickable = options.pickable !== false;
    this._lodRangeScale = options.lodRangeScale ?? 1.0;
    this._unsupported = options.unsupported ?? 'warn';
    this._lodPixelRatioCap = options.lodPixelRatioCap ?? Infinity;
    // 视锥剔除细化默认关闭：这是可选策略不是 bug 修复，不传就走全向加载的老路径
    this._cullRefine = options.cullRefine === true || options.frustumCullRefine === true;
    // 瓦片级放置默认开启：旧行为是拿单一常量切平面拟合随纬度变化的墨卡托比例，属于 bug 修复，
    // 所以默认值跟着改（见 AGENTS.md 不变式 ①）。显式传 false 仍可回退。
    this._perTilePlacement = options.perTilePlacement !== false;
    this._depthMode = normalizeDepthMode(options.depthMode);
    setTextureSizeCap(options.maxTextureSize ?? Infinity);
    // 运动模糊：默认关闭；开了也只在 renderFrame 里按需接管「场景→屏幕」这一步
    this._motionBlurCfg = normalizeMotionBlur(options.motionBlur);
    // 只记本层的档位，**不写模块级全局**：以前这里 setMaterialQuality(...) 会把全局
    // 改掉，于是同页后创建的图层顺手把先创建的图层也打回去了（多层互相覆盖的根因）。
    this._materialQuality = normalizeMaterialQuality(options.materialQuality);
    // 之后 addDataset 的数据集按这个默认建材质（数据集自己指定则用自己的）
    this._datasetManager.defaultMaterialQuality = this._materialQuality;
    this._lodTransition = options.lodTransition ?? 'binary';
    this._fallbackOffset = options.fallbackOffset;
    this._datasetManager.defaultLodTransition = this._lodTransition;
    this._datasetManager.defaultFallbackOffset = this._fallbackOffset;
    this._datasetManager.defaultBakeMercator = options.bakeMercator;
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
    }
    this._featureStyleManager = new FeatureStyleManager(
      () => this.style.floorHeight,
      () => this._requestRepaint(),
      () => {
        if (this._sel.selection) this._sel.syncStyle();
      },
      () => this.getAllMeshes(),
      (mesh) => this._applyOverridesToMesh(mesh),
      // 图层自身是否半透明：全局透明度改走 uOpacity 后，材质 opacity 不再代表它
      () => this._opacityTransparent
    );

    this.uniforms = createSharedUniforms();
    // 图层 profile 先落位（显式传了就只认自己），再把 LightRig 挂上来 ——
    // 它构造时会按 lightingPreset 覆盖一次管线，这一步走的是图层级通道，
    // 不再去改模块级全局（以前三个全局一起被改写，同页多图层互相污染）。
    this._colorPipeline = normalizeColorPipeline(options.colorPipeline);
    this._applyRenderProfile({}, true);
    // 光源状态在这里就位：LightRig 构造时会按 lightingPreset 切图层颜色管线，
    // 挂进场景要等 scene 建好（构造函数上面已经建了）。
    this._lights = new LightRig({
      scene: () => this.scene,
      renderer: () => this.renderer,
      uniforms: this.uniforms,
      options: this.options,
      getBearing: () => this._getBearing?.(),
      // 走公共 triggerRepaint 而不是 _requestRepaint：宿主 / 单测会覆盖前者来观察重绘，
      // 绕过它会让「有没有触发重绘」这件事失去观测点
      repaint: () => this.triggerRepaint(),
      // 构造期（initial）只记状态：那时还没有材质可重建、没有数据集可同步
      applyRenderProfile: (p, initial) => this._applyRenderProfile(p, initial),
    });
    this._lights.addToScene();
    this._heights = new HeightIndex(this.uniforms);
    const self = this;
    this._picks = new PickService({
      get picker() {
        return self.picker;
      },
      get camera() {
        return self.camera;
      },
      get scene() {
        return self.scene;
      },
      get canvas() {
        return self.canvas;
      },
      get style() {
        return self.style;
      },
      get sceneAnchor() {
        return self.sceneAnchor;
      },
      get datasets() {
        return self.datasets;
      },
      get featureStyleManager() {
        return self._featureStyleManager;
      },
      get smidMeshes() {
        return self._smidMeshes;
      },
      lngLatFromWorld: (x, y) => self._lngLatFromWorld(x, y),
      toCanonicalScene: (p, mesh) => self._toCanonicalScene(p, mesh),
      gpuPathPoseAt: (smid) => self._gpuPathPoseAt(smid),
      isFeatureHidden: (smid, batchId) => self._isFeatureHidden(smid, batchId),
    });
    // 纹理解码优先派给共享解析 Worker（崩溃自动回主线程，见 decodeTextureWithWorker）
    setTextureOffThreadDecode(decodeTextureWithWorker);
    this.style = { ...DEFAULT_STYLE, ...(options.style ?? {}) };
    this._styleTarget = { ...this.style };
    this._opacityTransparent = (this.style.opacity ?? 1) < 0.999;
    this._applyStyleUniforms();
    this._registerAnimChannels();
    // 动画启动必须把按需驱动的帧循环踢起来：MapLibre 空闲时不渲染，
    // 不踢的话动画「卡住不动」，直到别的什么碰巧触发了重绘
    this.animator.onActive = () => this._requestRepaint();
    this.outlineMaterial = createOutlineMaterial(this.uniforms);

    // 棱线装饰：内部持有共享 uniform 与全局材质，公共字段从它取出来保持 API 不变
    this._edges = new EdgeDecorator({
      uniforms: this.uniforms,
      style: this.style,
      styleTarget: this._styleTarget,
      animator: this.animator,
      pickables: this._picks.pickables,
      // mount() / restoreContext() 都会换掉 scene / renderer / camera，这里必须用
      // getter 拿「当下」的实例 —— 拆分 EdgeDecorator 时曾误写成值快照，mount 之后
      // host.renderer 恒为 null，GPU 描边（和 loadCreases 挂线）静默失效
      get scene() {
        return self.scene;
      },
      get renderer() {
        return self.renderer;
      },
      get camera() {
        return self.camera;
      },
      authenticate: this._authenticate,
      requestRepaint: () => this.triggerRepaint(),
    });
    this.lineShared = this._edges.lineShared;
    this.edgeMaterial = this._edges.edgeMaterial;
    this.selectionEdgeMaterial = this._edges.selectionEdgeMaterial;

    // 覆盖物底座：只吃 scene / 锚点 / 重绘三样设施。scene 在 mount 前是 null，
    // 所以 host 成员一律写成 getter，add 时读到的是「当下」的实例
    this.overlay = new OverlayLayer({
      get scene() {
        return self.scene;
      },
      getAnchor: () => self.sceneAnchor,
      lngLatToPoint: (p) => self.lngLatToPoint(p),
      requestRepaint: () => self.triggerRepaint(),
    });
    this._sel = new SelectionDecorator({
      uniforms: this.uniforms,
      style: this.style,
      outlineMaterial: this.outlineMaterial,
      selectionEdgeMaterial: this.selectionEdgeMaterial,
      featureStyleManager: this._featureStyleManager,
      smidMeshes: this._smidMeshes,
      pointClouds: this._pointClouds,
      applyPointCloudStyle: (pc, selected) => this._applyPointCloudStyle(pc, selected),
      onPick: (r) => this.onPick(r),
      requestRepaint: () => this.triggerRepaint(),
      createSelectionEdgeMaterial: (mesh) => this._edges.createSelectionEdgeMaterial(mesh),
    });

    // 关键：style.edges 是个开关，但构造函数从没据此启用过棱线，导致
    // `style: { edges: true }` 形同虚设、_edgesEnabled 永远是 false。
    // 这里按 style 实际值调一次 setEdges，让开关真正生效（与 setEdges 后来的手工调用一致）。
    this.setEdges(this.style.edges);

    // 初始化图层整体不透明度：确保共享 uniform uOpacity、材质混合开关与棱线外观与初始 style.opacity 严格一致
    this._applyOpacity();

    this._fps.last = performance.now();
    this._datasetQueue = this._normalizeDatasets(options);
    this._analysis = new AnalysisService({
      sceneFromLngLat: (p) => this._sceneFromLngLat(p),
      raycastDistance: (origin, dir, maxDistance) => this._picks.raycastDistance(origin, dir, maxDistance),
      requestRepaint: () => this.triggerRepaint(),
      renderer: () => this.renderer,
      scene: () => this.scene,
      camera: () => this.camera,
    });
    this._paths = new PathFollow({
      animator: this.animator,
      gpuPathManager: this.gpuPathManager,
      uniforms: this.uniforms,
      styles: this._featureStyleManager,
      pathSpecs: this._pathSpecs,
      meshesOf: (smids) => this._meshesOf(smids),
      setCustomPathTime: (custom) => {
        this._customPathTime = custom;
      },
    });
    this._placement = new TilePlacement({
      perTilePlacement: () => self._perTilePlacement,
      sceneAnchor: () => self.sceneAnchor,
      geo: () => self.geo,
      datasets: () => self._datasetManager.values(),
    });
    this._tiles = new TileRegistry({
      animator: this.animator,
      picks: this._picks,
      edges: this._edges,
      sel: this._sel,
      heights: this._heights,
      splats: this._splats,
      placement: this._placement,
      featureStyles: this._featureStyleManager,
      pointClouds: this._pointClouds,
      smidMeshes: this._smidMeshes,
      style: this.style,
      opacityTransparent: () => this._opacityTransparent,
      perTilePlacement: () => this._perTilePlacement,
      sceneAnchor: () => this.sceneAnchor,
      select: (r) => this.select(r),
      applyPointCloudStyle: (pc, selected) => this._applyPointCloudStyle(pc, selected),
      indexMeshSmids: (mesh) => this._indexMeshSmids(mesh),
      unindexMeshSmids: (mesh) => this._unindexMeshSmids(mesh),
      allocPickId: () => this._picks.allocPickId(),
      releasePickId: (id) => this._picks.releasePickId(id),
      requestRepaint: () => this.triggerRepaint(),
      nextTileFadeSeq: () => this._tileFadeSeq++,
    });
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
    // 裁剪是构造期就能设的（还没 mount 时 `_applyClipping` 会先跳过），这里补挂一次
    this._analysis.applyClipping();

    this.scene = new THREE.Scene();
    this.scene.add(this.groundManager.group);
    this._addLights();
    // 覆盖物的容器跟着新 scene 走。unmount 时容器被摘掉但条目还在，
    // 所以重新 mount 要把它们挂回来
    this.overlay.attachToScene();

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
    // 新 renderer 的 clippingPlanes 是空的，裁剪状态要重新挂上去
    this._analysis.applyClipping();
    this.picker?.dispose();
    this.picker = new Picker(this.renderer);
    // GPU 描边的 RT / 材质绑定在旧上下文上，整体丢弃，下一帧按需重建
    this._edges.disposeGpuEdge();
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
    this._lights.dispose();
    this.outlineMaterial.dispose();
    this._edges.disposeGpuEdge();
    this._motionBlur?.dispose();
    this._motionBlur = null;
    // presenter 的 RT 绑在旧上下文上，直接丢掉，下一次 render 按需重建
    this._presenterTarget.dispose();
    this.edgeMaterial.dispose();
    this.selectionEdgeMaterial.dispose();
    // 覆盖物只摘不 dispose：几何与材质是使用者造的，只有他知道要不要复用
    this.overlay.dispose();
    this.scene?.clear();
    this._sel.reset();
    this._smidMeshes.clear();
    this._heights.clear();
    // 场景已经清空，还挂着的动画通道（瓦片淡入 / 单体位移）不能再对着死对象写
    this.animator.clear();
    this.animator.unregisterPrefix('tile.');
    this.animator.unregisterPrefix('feature.');
    this._pathSpecs.clear();

    this.renderer?.dispose?.();
    this.renderer = null;
    this.canvas = null;
  }

  /* ---------------------------------------------------------------- 光照 */

  /**
   * @internal 光源实例的转发 —— `lighting.test.ts` 直接读这几个字段。
   * 实现全在 viewer/LightRig.ts。
   */
  get _ambientLight(): THREE.AmbientLight | null {
    return this._lights.ambient;
  }
  get _hemiLight(): THREE.HemisphereLight | null {
    return this._lights.hemi;
  }
  get _keyLight(): THREE.DirectionalLight | null {
    return this._lights.key;
  }
  get _fillLight(): THREE.DirectionalLight | null {
    return this._lights.fill;
  }

  /** @internal 光照位置按当前 bearing 重算，见 viewer/LightRig.ts */
  _updateLights(): void {
    this._lights.update();
  }

  private _addLights(): void {
    this._lights.addToScene();
  }

  setLightingPreset(preset: LightingPreset): void {
    this._lights.setLightingPreset(preset);
  }

  /** 动态设置光照配置 */
  setLight(options: Partial<LightOptions>): void {
    this._lights.setLight(options);
  }

  /** 获取当前光照配置快照 */
  getLight(): LightOptions {
    return this._lights.getLight();
  }

  /** 动态设置色调映射模式与曝光度 */
  setToneMapping(toneMapping: THREE.ToneMapping, exposure = 1.0): void {
    this._lights.setToneMapping(toneMapping, exposure);
  }

  /** 获取当前色调映射模式与曝光度 */
  getToneMapping(): { toneMapping: THREE.ToneMapping; toneMappingExposure: number } {
    return this._lights.getToneMapping();
  }

  /**
   * 挂 / 摘环境贴图。见 viewer/LightRig.ts（PMREM 预滤波 + 旧 RT 释放）。
   */
  setEnvironment(source: string | THREE.Texture | null, intensity = 1): Promise<void> {
    return this._lights.setEnvironment(source, intensity);
  }

  /* ---------------------------------------------------------------- 数据集 */

  /** 数据集 options 归一，实现在 DatasetManager.normalizeDatasetOptions */
  private _normalizeDatasets(options: S3MViewerOptions): S3MDatasetOptions[] {
    return normalizeDatasetOptions(options);
  }

  /** 追加一个数据集。图层 addLayer 之前调用会抛错。 */
  async addDataset(ds: S3MDatasetOptions): Promise<S3MDatasetEntry> {
    if (!this.scene) throw new Error('[s3m] 图层尚未 addLayer，不能添加数据集');
    // 图层级默认值：数据集自己指定了就用自己的，见 `S3MViewerOptions.unsupported`
    const merged: S3MDatasetOptions = {
      ...ds,
      unsupported: ds.unsupported ?? this._unsupported,
      lodTransition: ds.lodTransition ?? this._lodTransition,
      fallbackOffset: ds.fallbackOffset ?? this._fallbackOffset,
    };
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
          this._requestRepaint();
        },
        onTileRemoved: (node, e) => {
          this._unregisterTile(node, e);
          this.onStats(this.stats);
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
          this._heights.refreshAll();
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
      this._authenticate,
      this.options.maxMemory ?? Infinity
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
    // 锚点变了 → 每块瓦片的 k 与 position 都要重算（关这项功能时是空转，一次遍历都不做）
    this._placement.reapply();
    this._heights.refreshAll();
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
    this._heights.refreshAll();
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
    this._heights.refreshAll();
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

  /* ---------------------------------------------------------------- 路径运动 */
  // 实现在 viewer/PathFollow.ts；主类只留同签名转发，公共面不变。

  /**
   * 让单体沿折线运动（CPU 路径，逐帧写 `translation`）。
   *
   * 路径先做弧长参数化（见 `anim/Path.ts`）：缓动作用在「已走距离」上而不是顶点索引上，
   * 所以顶点疏密不均也不会忽快忽慢。注意不要和 `moveFeature` 同时驱动同一个单体 ——
   * 两者都写 `translation`。
   */
  followPath(
    smid: number,
    points: Path | ArrayLike<number> | Array<[number, number, number]>,
    opts: PathFollowOptions = {}
  ): void {
    this._paths.followPath(smid, points, opts);
  }

  /** 停下路径运动（停在当前位置，不回弹） */
  stopPath(smid: number): void {
    this._paths.stopPath(smid);
  }

  /** @internal CPU/GPU 路径单体在当前时间的位姿，见 viewer/PathFollow.ts */
  private _gpuPathPoseAt(smid: number): { pos: [number, number, number]; yaw: number } | null {
    return this._paths.gpuPathPoseAt(smid);
  }

  /** 注册 GPU 路径到路径库，返回路径 ID */
  registerGPUPath(
    points: Path | ArrayLike<number> | Array<[number, number, number]>,
    opts: { id?: number; name?: string; closed?: boolean } = {}
  ): number {
    return this._paths.registerGPUPath(points, opts);
  }

  /** 注销 GPU 路径 */
  unregisterGPUPath(id: number): boolean {
    return this._paths.unregisterGPUPath(id);
  }

  /** 获取 GPUPathManager 实例 */
  getGPUPathManager(): GPUPathManager {
    return this.gpuPathManager;
  }

  /** 将单体绑定到 GPU 路径动画（智慧交通车流 / 大批量巡检无人机） */
  bindGPUPath(
    smid: number,
    path: number | Path | ArrayLike<number> | Array<[number, number, number]>,
    options: Omit<GPUPathOptions, 'pathId'> = {}
  ): number {
    return this._paths.bindGPUPath(smid, path, options);
  }

  /** 解绑单体的 GPU 路径动画 */
  unbindGPUPath(smid: number): void {
    this._paths.unbindGPUPath(smid);
  }

  /** 手动设置单体在 GPU 路径上的归一化进度（0.0 ~ 1.0） */
  setGPUPathProgress(smid: number, progress: number): void {
    this._paths.setGPUPathProgress(smid, progress);
  }

  /** 设置全局 GPU 路径时间（秒） */
  setGPUPathTime(time: number, autoAdvance = false): void {
    this._paths.setGPUPathTime(time, autoAdvance);
  }

  /** 获取全局 GPU 路径时间（秒） */
  getGPUPathTime(): number {
    return this._paths.getGPUPathTime();
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
              // 位移 / 旋转后几何跑出了原始包围球，拾取粗筛必须退回全量。
              // three 的剔除已经由 GeometryBuilder 统一关掉（#36），这里只维护可信标记。
              const transMoving = Math.abs(v[0]) > 1e-6 || Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6;
              const rotEuler = extractEulerAngles(cur.rotation);
              const rotMoving = Math.abs(rotEuler[0]) > 1e-6 || Math.abs(rotEuler[1]) > 1e-6 || Math.abs(rotEuler[2]) > 1e-6;
              const sphereTrusted = !(transMoving || rotMoving);
              for (const mesh of meshes) (mesh.userData as Record<string, unknown>).sphereTrusted = sphereTrusted;
            } else if (prop === 'rotation') {
              this._featureStyleManager.setFeatureStyle(
                smid,
                { ...cur, rotation: [v[0], v[1], v[2]] },
                meshes
              );
              const rotMoving = Math.abs(v[0]) > 1e-6 || Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6;
              const t = cur.translation ?? [0, 0, 0];
              const transMoving = Math.abs(t[0]) > 1e-6 || Math.abs(t[1]) > 1e-6 || Math.abs(t[2]) > 1e-6;
              const sphereTrusted = !(rotMoving || transMoving);
              for (const mesh of meshes) (mesh.userData as Record<string, unknown>).sphereTrusted = sphereTrusted;
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
    const res = this._featureStyleManager.auditBatches(this._picks.pickables.values());
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
    for (const p of this._picks.pickables.values()) list.push(p.mesh);
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
    if (this._sel.selection?.datasetId === id) this.select(null);
    this._datasetManager.removeDataset(id, this.scene!, this.geo, (e) => {
      e.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const ud = mesh.userData as MeshUserData;
        if (ud.pickId != null) {
          this._picks.pickables.delete(ud.pickId);
          this._releasePickId(ud.pickId);
          ud.pickId = undefined;
        }
        this._unindexMeshSmids(mesh);
        this._heights.remove(mesh);
        mesh.geometry?.dispose?.();
        const styled = styledMaterialOf(mesh);
        if (styled) styled.dispose();
        if (isOwnedPointCloudMaterial(mesh.material)) (mesh.material as THREE.Material).dispose();
        this._featureStyleManager.disposeMesh(mesh);
      });
    });
    for (const [pickId, p] of this._picks.pickables) if (p.datasetId === id) this._picks.pickables.delete(pickId);
    this.onStats(this.stats);
    this._requestRepaint();
  }

  /** 清空当前所有数据集 */
  clearDatasets(): void {
    for (const id of [...this.datasets.keys()]) this.removeDataset(id);
  }

  setDatasetVisible(id: string, visible: boolean): void {
    this._datasetManager.setDatasetVisible(id, visible);
    if (!visible && this._sel.selection?.datasetId === id) this.select(null);
    this._requestRepaint();
  }

  /* ---------------------------------------------------------------- 瓦片注册 */
  // 实现在 viewer/TileRegistry.ts；主类只留同签名转发。

  /** @internal 一块瓦片落地：写 userData / 拾取表 / SMID 索引 / 高度 / 棱线 / 样式继承 */
  private _registerTile(node: TileNode, entry: S3MDatasetEntry): void {
    this._tiles.registerTile(node, entry);
    // 材质一落地就发起预热，而不是等这一帧画完（见 `_prewarmShadingSoon`）。
    this._prewarmShadingSoon();
  }

  /** @internal 瓦片被淘汰：从拾取表与场景里摘掉，并释放几何与材质显存 */
  private _unregisterTile(node: TileNode, entry: S3MDatasetEntry): void {
    this._tiles.unregisterTile(node, entry);
  }

  /**
   * 瓦片几何在**数据集局部 ENU** 里的包围盒中心，给没有包围球的瓦片兜底。
   *
   * 调用时机固定在 `entry.root.add()` 之前：此时 group 还没挂到 root 上、matrix 还是
   * 单位阵，`setFromObject` 得到的就是顶点自己的坐标系，正好是摆放要的枢轴。
   * 挂上 root 之后再算会带上 root 的 offset，枢轴就偏了。
   */
  /**
   * @internal 场景锚点变了之后重算已注册瓦片的放置，见 viewer/TilePlacement.ts。
   * 保留在主线是因为锚点 setter 与 `recomputeAnchors` 都调它，单测也直接调。
   */
  private _reapplyTilePlacements(): void {
    this._placement.reapply();
  }

  /** @internal 拾取时把世界坐标反解回规范场景 ENU，见 viewer/TilePlacement.ts */
  private _toCanonicalScene(p: THREE.Vector3, mesh?: THREE.Object3D | null): THREE.Vector3 {
    return this._placement.toCanonicalScene(p, mesh);
  }

  /** @internal 把当前选中重放到新登记的 mesh 上，见 viewer/SelectionDecorator.ts */
  _replaySelectionOnto(mesh: THREE.Mesh): void {
    this._sel.replayOnto(mesh);
  }

  /**
   * 拾取 ID 只有 2 个字节（RG 两个通道），65535 个网格就到头了，
   * 所以必须回收：瓦片淘汰 / 数据集移除时把 id 还回池子。
   */
  /* ---------------------------------------------------------------- 样式 */

  /* ---------------------------------------------------------------- 样式 */
  // 实现在 viewer/StyleController.ts；主类只留同签名转发，公共面不变。

  /** 动态设置图层整体透明度 (0.0 ~ 1.0) */
  setOpacity(opacity: number, transition?: TransitionOptions): void {
    this._styles.setOpacity(opacity, transition);
  }

  /** 改图层样式（写的是「用户想要的」那份，动画朝它收敛） */
  setStyle(patch: Partial<S3MStyle> = {}, transition?: TransitionOptions): void {
    this._styles.setStyle(patch, transition);
  }

  /** 当前样式（叠加模式标签） */
  getStyle(): S3MStyle & { modeLabel: string } {
    return this._styles.getStyle();
  }

  /** @internal 按当前档位 / 管线重建全场材质，见 viewer/StyleController.ts */
  private _rebuildStyledMaterials(): void {
    this._styles.rebuildStyledMaterials();
  }

  /** @internal 本图层此刻该用的纹理创建参数，见 viewer/StyleController.ts */
  private _textureOptions(): TextureCreateOptions {
    return this._styles.textureOptions();
  }

  /** @internal 给可插值样式键注册动画通道，见 viewer/StyleController.ts */
  private _registerAnimChannels(): void {
    this._styles.registerAnimChannels();
  }

  /** 提前编译着色器（`prewarmShading: false` 可关闭） */
  prewarmShading(): Promise<void> {
    return this._styles.prewarmShading();
  }

  /** @internal 点云 / 泼溅网格的样式继承，见 viewer/StyleController.ts */
  private _applyPointCloudStyle(points: THREE.Points, selected = false): void {
    this._styles.applyPointCloudStyle(points, selected);
  }

  /** @internal 写回共享 uniform，见 viewer/StyleController.ts */
  private _applyStyleUniforms(): void {
    this._styles.applyStyleUniforms();
  }

  /** @internal 按当前样式重算不透明度，见 viewer/StyleController.ts */
  private _applyOpacity(): void {
    this._styles.applyOpacity();
  }

  /** @internal 按当前样式重算着色方式，见 viewer/StyleController.ts */
  private _applyShading(): void {
    this._styles.applyShading();
  }

  /** @internal 把当前样式下发到全部数据集，见 viewer/StyleController.ts */
  private _applyRenderProfile(
    patch: { colorPipeline?: ColorPipeline; anisotropyCap?: number },
    initial = false
  ): void {
    this._styles.applyRenderProfile(patch, initial);
  }

  /**
   * 运行时切换**本图层**的材质质感（`'pbr'` | `'lambert'`）。
   *
   * 档位是图层级的：只改这一层，同页其它图层不受影响（也不会去动模块级默认）。
   * 已加载瓦片的材质在这里**原位重建**：不重拉瓦片、不重建几何，按创建时记录的
   * 参数（`userData.s3mOpts`）换一个新材质实例，并保留逐材质状态（选中编号、
   * 瓦片淡入、批量状态纹理）。切换后 program 需要重新编译一次（lambert / pbr 是
   * 不同着色器），这是唯一开销。
   */
  setMaterialQuality(q: MaterialQuality): void {
    this._materialQuality = normalizeMaterialQuality(q) ?? 'pbr';
    // 已建好的数据集也要跟着换，否则之后新加载的瓦片还是旧档位（和重建结果打架）
    this._datasetManager.setDefaultMaterialQuality(this._materialQuality);
    this._rebuildStyledMaterials();
    this._requestRepaint();
  }

  /** 当前材质质感档位（本图层指定了就用本图层的，否则是模块级默认） */
  get lodTransition(): 'binary' | 'incremental' {
    return this._lodTransition;
  }

  setLodTransition(mode: 'binary' | 'incremental'): void {
    if (this._lodTransition === mode) return;
    this._lodTransition = mode;
    this._datasetManager.setDefaultLodTransition(mode);
    this.triggerRepaint();
  }

  get materialQuality(): MaterialQuality {
    return this._materialQuality ?? getMaterialQuality();
  }

  /**
   * 运行时开关运动模糊后处理；`null` / 非法入参 = 关闭并立即释放 RT 显存。
   *
   * 这是纯视觉补偿（见 `motionBlur` 选项），对渲染管线唯一的结构性影响是开启期间
   * 「场景 → 屏幕」改走 RT 中转（合成 quad 会补回色调映射 / sRGB / 深度）。
   * WebGL1 上开了也自动回退直渲。`damp: 'auto'` 每帧按实时 FPS 重新解析。
   */
  /**
   * 接管「场景 → 屏幕」这一步，让使用者自己做后处理。
   *
   * 设置后，本库把场景渲进自己的 RT（线性空间、透明底、带深度纹理），然后把
   * `color` / `depth` 两张纹理交给 `presenter.render(ctx)`，**上屏由它负责**：
   * 画什么、画几趟、要不要再渲一遍场景，全是普通 three 代码。
   *
   * 这是「开个口子」而不是「造一套后处理框架」：没有 pass 列表、没有顺序、没有
   * 共享池。想叠加多个效果就在自己的 render 里串，框架不参与编排。
   *
   * 三个必须知道的约定：
   * - **独占上屏**：设了 presenter，本库不再自己合成。实现方结尾要
   *   `renderer.setRenderTarget(null)` 再画，否则画面停在上一次。
   * - **三处补偿是使用者的责任**：色调映射、linear→输出色彩空间、用 `depth`
   *   写回 `gl_FragDepth`。前两个漏了整层发亮发灰；第三个漏了，后画的宿主图层
   *   挡不住 S3M，会被楼穿过去。
   * - **与 motionBlur 互斥**：两者都要接管这一步，同时设会互相覆盖，所以本方法
   *   会自动关掉 motionBlur 并 warn。
   *
   * 需要 WebGL2（DepthTexture）。不支持时回退直渲，并 warn 一次。
   * 传 `null` 解除接管，RT 立刻释放。
   */
  setPresenter(presenter: ViewerPresenter | null | undefined): void {
    if (!presenter) {
      this._presenter = null;
      this._presenterTarget.dispose();
      this.triggerRepaint();
      return;
    }
    if (this._motionBlurCfg) {
      console.warn('[s3m] setPresenter 与运动模糊都要接管「场景→屏幕」，已自动关闭运动模糊');
      this.setMotionBlur(null);
    }
    this._presenter = presenter;
    this.triggerRepaint();
  }

  /** 当前接管上屏的 presenter；null = 由本库自己合成 */
  get presenter(): ViewerPresenter | null {
    return this._presenter;
  }

  setMotionBlur(cfg: MotionBlurOptions | null | undefined): void {
    const next = normalizeMotionBlur(cfg);
    // presenter 一旦设上就一直赢：它是使用者自己的代码，悄悄丢掉比拒绝设置更糟
    if (next && this._presenter) {
      console.warn('[s3m] 已设置 presenter，运动模糊不再生效（两者都要接管「场景→屏幕」）；需要运动模糊请先 setPresenter(null)');
      this.triggerRepaint();
      return;
    }
    this._motionBlurCfg = next;
    if (!this._motionBlurCfg) {
      this._motionBlur?.dispose();
      this._motionBlur = null;
    }
    // 走公共 triggerRepaint：宿主 / 单测会覆盖前者来观察重绘（同其它 setter 的观测点）
    this.triggerRepaint();
  }

  /** 当前运动模糊配置（归一化后的副本）；null = 关闭 */
  /**
   * 运行时修改深度处理策略（'scene' | 'clear' | 'auto'）。
   */
  setDepthMode(mode: DepthMode): void {
    const next = normalizeDepthMode(mode);
    if (this._depthMode !== next) {
      this._depthMode = next;
      this.triggerRepaint();
    }
  }

  /** 当前深度策略（'scene' | 'clear' | 'auto'，默认 'scene'） */
  get depthMode(): DepthMode {
    return this._depthMode;
  }

  /**
   * 当前帧实际生效的深度处理模式（'scene' | 'clear'）。
   * - 'clear': 显式指定 clear，或 auto 模式下命中地面覆盖/倾斜摄影/DEM等地面类数据
   * - 'scene': 显式指定 scene，或 auto 模式下无地面类数据
   */
  resolveDepthMode(): 'scene' | 'clear' {
    if (this._depthMode === 'clear') return 'clear';
    if (this._depthMode === 'scene') return 'scene';

    // 'auto': 按数据集与地面覆盖特征推断
    if (this.groundManager && this.groundManager.mode !== 'none') {
      return 'clear';
    }

    for (const entry of this._datasetManager.datasets.values()) {
      if (!entry.visible) continue;
      if (entry.options.depthMode === 'clear') return 'clear';
      if (entry.options.depthMode === 'scene') continue;
      if (entry.tileset?.isS3MV1) return 'clear';
      const cfg = entry.tileset?.config as Record<string, unknown> | null | undefined;
      if (cfg) {
        const typeStr = `${cfg.fileType ?? ''} ${cfg.dataType ?? ''} ${cfg.datasetType ?? ''} ${cfg.cacheType ?? ''} ${cfg.fileExtentName ?? ''}`;
        if (/osgb|oblique|ground|dem|tin|terrain/i.test(typeStr)) return 'clear';
      }
      if (entry.options.configUrl && /osgb|oblique/i.test(entry.options.configUrl)) {
        return 'clear';
      }
    }

    return 'scene';
  }

  get motionBlur(): MotionBlurOptions | null {
    return this._motionBlurCfg ? { ...this._motionBlurCfg } : null;
  }

  /**
   * 运行时切换**本图层**的颜色管线（`'linear'` | `'direct'`）。
   *
   * `'direct'` = 官方 iClient3D 的 sRGB 直乘管线（配合纹理解码关 sRGB），
   * 见 `lightingPreset: 'supermap'`。切换牵扯三样东西：材质宏（换 program）、
   * 纹理 colorSpace（重传，**不重新下载瓦片**）、以及各向异性档位。
   *
   * 给 `duration > 0` 时走 fade-through：压暗 → 在同一帧回调里换管线 → 亮回来。
   * 逐像素混合做不到干净 —— 两条管线的差异有一部分在采样端（硬件 sRGB 解码 vs
   * 原始字节），要混合就得让贴图恒为原始字节并在片元里手动解码，那会改掉默认路径。
   */
  setColorPipeline(q: ColorPipeline, opts: { duration?: number; dim?: number } = {}): Promise<void> {
    const next = normalizeColorPipeline(q) ?? 'linear';
    if (next === this.colorPipeline) return Promise.resolve();

    const d = Math.max(0, opts.duration ?? 0);
    if (d <= 0) {
      this._applyRenderProfile({ colorPipeline: next });
      return Promise.resolve();
    }

    const dim = Math.min(1, Math.max(0.05, opts.dim ?? 0.35));
    const gen = ++this._pipelineGen;
    return new Promise<void>((resolve) => {
      this.animator.to('style.fade', dim, {
        duration: d,
        easing: 'easeInOutQuad',
        onComplete: () => {
          // 中途又切了一次：这次编排作废，收尾交给新的那次
          if (gen !== this._pipelineGen) {
            resolve();
            return;
          }
          this._applyRenderProfile({ colorPipeline: next });
          this.animator.to('style.fade', 1, {
            duration: d,
            easing: 'easeInOutQuad',
            onComplete: resolve,
          });
        },
      });
    });
  }

  /** 当前颜色管线（本图层指定了就用本图层的，否则是模块级默认） */
  get colorPipeline(): ColorPipeline {
    return this._colorPipeline ?? getColorPipeline();
  }

  /**
   * 高度范围增量维护。
   *
   * 原来每注册一块瓦片都要把所有网格重新遍历一遍、每个都 clone 一个 Box3 再乘矩阵，
   * 加载 n 块瓦片就是 O(n²) 次矩阵乘 + n² 个垃圾对象。现在只在网格进出的记一次，
   * 全局值从缓存里滚：只有被移除的那块正好卡在边界上时，才回退到一次 O(n) 重算。
   */
  /** @internal 见 viewer/HeightIndex.ts（regressions.test.ts 直接调） */
  _addMeshHeight(mesh: THREE.Mesh): void {
    this._heights.add(mesh);
  }

  /** @internal 见 viewer/HeightIndex.ts */
  _removeMeshHeight(mesh: THREE.Mesh): void {
    this._heights.remove(mesh);
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

  /* ---------------------------------------------------------------- 棱线 */

  /** @internal 测试用：棱线是否开启（实现在 EdgeDecorator） */
  get _edgesEnabled(): boolean {
    return this._edges.enabled;
  }
  /** @internal 测试用：当前画法 */
  get _edgeModes(): EdgeModes {
    return this._edges.modes;
  }
  /** @internal 测试用：GPU 描边实例（可替换） */
  get _gpuEdge(): GpuEdgePass | null {
    return this._edges.gpuEdge;
  }
  set _gpuEdge(v: GpuEdgePass | null) {
    this._edges.gpuEdge = v;
  }

  /** @internal 测试用：给一块网格补折边线 */
  _ensureEdges(mesh: THREE.Mesh): void {
    this._edges.ensureEdges(mesh);
  }

  /** @internal 测试用：拆掉一块网格的棱线装饰 */
  _removeEdges(mesh: THREE.Mesh): void {
    this._edges.removeEdges(mesh);
  }

  /** 全局棱线开关，实现在 viewer/EdgeDecorator.ts */
  setEdges(edges: EdgesOption, transition?: TransitionOptions): void {
    this._edges.setEdges(edges, transition);
  }

  /** 挂载预制棱线缓存（Crease Cache），见 viewer/EdgeDecorator.ts */
  loadCreases(url: string): Promise<void> {
    return this._edges.loadCreases(url);
  }

  /** 移除并释放预制棱线缓存 */
  clearCreases(): void {
    this._edges.clearCreases();
  }

  /* ---------------------------------------------------------------- 拾取 */

  /** 屏幕像素 → 场景射线，见 viewer/PickService.ts */
  getRayAt(x: number, y: number): THREE.Ray | null {
    return this._picks.getRayAt(x, y);
  }

  /** 按 canvas 左上角的 CSS 像素坐标拾取 */
  pick(x: number, y: number): PickResult | null {
    return this._picks.pick(x, y);
  }

  /** 拾取并返回经纬度 + 高程 */
  pickPosition(x: number, y: number): { lngLat: [number, number]; altitude: number; point: [number, number, number] } | null {
    return this._picks.pickPosition(x, y);
  }

  /** 穿透拾取：沿射线返回前 `limit` 个命中 */
  drillPick(x: number, y: number, limit = 10): PickResult[] {
    return this._picks.drillPick(x, y, limit);
  }

  /** 单体的经纬度包围盒 */
  getFeatureBounds(smid: number): [[number, number], [number, number]] | null {
    return this._picks.getFeatureBounds(smid);
  }

  /* -------------------------------------------------------------- 三维空间分析 */

  /**
   * 经纬度 + 高程 → 场景 ENU 米制坐标。
   *
   * 场景锚点可能还没就绪（没加数据集），此时按世界原点处理 —— 量算 API 会因此
   * 给出「以原点为基准」的结果，但不会抛错。真实使用里锚点在 addDataset 之后必然存在。
   */
  private _sceneFromLngLat(p: LngLatAlt): Vec3 {
    const anchor = this.sceneAnchor;
    if (!anchor) return [0, 0, 0];
    const sEast = anchor.meterInMercatorEast ?? anchor.meterInMercator;
    const sNorth = anchor.meterInMercatorNorth ?? anchor.meterInMercator;
    const w = worldFromLngLat(this.geo, p.lng, p.lat, p.altitude);
    // 注意 y 取反：three 的 y 向上，墨卡托 y 向下（与 PickService.pickPosition 互逆）
    return [(w.x - anchor.x) / sEast, -(w.y - anchor.y) / sNorth, p.altitude - (anchor.altitude ?? 0)];
  }

  /**
   * 经纬度 + 绝对高程 → 场景 ENU 米制坐标。
   *
   * 外围要做「分析代理几何」（底图建筑挤出）、或者在 three 里画自定义标注时，
   * 都得先把经纬度落到这个坐标系里 —— 场景的 ENU 原点在 `sceneAnchor`，
   * 不是经纬度，所以必须走这个换算。
   */
  lngLatToPoint(p: LngLatAlt): Vec3 {
    return this._sceneFromLngLat(p);
  }

  /** 场景 ENU 米制坐标 → 经纬度 + 绝对高程（`pointToLngLat` 的逆） */
  pointToLngLat(v: Vec3): LngLatAlt {
    return this._lngLatFromScene(v);
  }

  /** 场景 ENU 米制坐标 → 经纬度 + 绝对高程 */
  private _lngLatFromScene(v: Vec3): LngLatAlt {
    const anchor = this.sceneAnchor;
    if (!anchor) return { lng: 0, lat: 0, altitude: v[2] };
    const sEast = anchor.meterInMercatorEast ?? anchor.meterInMercator;
    const sNorth = anchor.meterInMercatorNorth ?? anchor.meterInMercator;
    const [lng, lat] = lngLatFromWorld(this.geo, v[0] * sEast + anchor.x, -v[1] * sNorth + anchor.y);
    return { lng, lat, altitude: v[2] + (anchor.altitude ?? 0) };
  }

  /* ---------------------------------------------------------------- 空间分析 */
  // 实现在 viewer/AnalysisService.ts；主类只留同签名转发，公共面不变。

  /** 两点量算：三维距离 / 水平距离 / 高差 */
  measureDistance(a: LngLatAlt, b: LngLatAlt): MeasureResult {
    return this._analysis.measureDistance(a, b);
  }

  /** 折线长度（三维 + 水平投影两套口径） */
  measurePolyline(points: readonly LngLatAlt[]): { length3D: number; lengthHorizontal: number } {
    return this._analysis.measurePolyline(points);
  }

  /** 多边形量算：坡面真实面积 / 水平投影面积 / 周长 */
  measurePolygon(points: readonly LngLatAlt[]): {
    area3D: number;
    areaHorizontal: number;
    perimeter: number;
  } {
    return this._analysis.measurePolygon(points);
  }

  /** 通视分析：两点之间是否被已加载的 S3M 几何挡住 */
  lineOfSight(a: LngLatAlt, b: LngLatAlt, opts: LineOfSightOptions = {}): LineOfSightResult {
    return this._analysis.lineOfSight(a, b, opts);
  }

  /** 裁剪 / 剖切（平面、Box、十字）。传 `null` 取消裁剪 */
  setClipping(opt: ClipOptions | null): void {
    this._analysis.setClipping(opt);
  }

  /** 当前裁剪配置（`null` = 未裁剪） */
  get clipping(): ClipOptions | null {
    return this._analysis.clipping;
  }

  /** 天际线分析：按列抽出「方位角 → 仰角」曲线 */
  skyline(opts: {
    width?: number;
    height?: number;
    step?: number;
    include?: readonly THREE.Object3D[];
  } = {}): SkylineResult | null {
    return this._analysis.skyline(opts);
  }

  /** 360° 可视域（地面栅格版） */
  viewshed(opts: {
    origin: LngLatAlt;
    radius: number;
    grid?: number;
    eyeHeight?: number;
    size?: number;
    include?: readonly THREE.Object3D[];
  }): ViewshedResult | null {
    return this._analysis.viewshed(opts);
  }

  /** @internal 见 viewer/PickService.ts */
  _intersectMeshAtRay(mesh: THREE.Mesh, ray: THREE.Ray, instanceIndex?: number): THREE.Vector3 | null {
    return this._picks.intersectMeshAtRay(mesh, ray, instanceIndex);
  }

  /** @internal 见 viewer/PickService.ts */
  _buildPickResult(
    hit: { objectId: number; batchId: number; instanceIndex?: number },
    ref: PickableRef,
    exactPoint?: THREE.Vector3,
    ray?: THREE.Ray
  ): PickResult | null {
    return this._picks.buildPickResult(hit, ref, exactPoint, ray);
  }

  /** @internal 见 viewer/PickService.ts */
  _buildSplatPickResult(
    hit: { objectId: number; batchId: number; instanceIndex?: number },
    ref: PickableRef,
    exactPoint?: THREE.Vector3,
    ray?: THREE.Ray
  ): PickResult | null {
    return this._picks.buildSplatPickResult(hit, ref, exactPoint, ray);
  }

  /** @internal 见 viewer/PickService.ts */
  _instanceFeature(mesh: THREE.Mesh, geoRef: GeoPackageEntry | undefined, instanceIndex: number): InstanceFeature | null {
    return this._picks.instanceFeature(mesh, geoRef, instanceIndex);
  }

  /** @internal 见 viewer/PickService.ts */
  _instanceBox(mesh: THREE.Mesh, instanceIndex: number): SegmentBox | null {
    return this._picks.instanceBox(mesh, instanceIndex);
  }

  /** @internal 拾取 id 池，见 viewer/PickService.ts */
  _allocPickId(): number {
    return this._picks.allocPickId();
  }

  /** @internal */
  _releasePickId(id: number): void {
    this._picks.releasePickId(id);
  }

  /** @internal 拾取表（测试直接读写），见 viewer/PickService.ts */
  get _pickables(): Map<number, PickableRef> {
    return this._picks.pickables;
  }

  /* ---------------------------------------------------------------- 选中 */

  /**
   * 选中一个单体（或整块网格），高亮与轮廓装饰见 viewer/SelectionDecorator.ts。
   * 传 `null` 清空选中；`silent` 为真时不触发 `onPick`。
   */
  select(result: PickResult | null, opts: { silent?: boolean } = {}): void {
    this._sel.select(result, opts);
  }

  /** @internal 选中外观跟随样式变化，见 viewer/SelectionDecorator.ts */
  _syncSelectionStyle(): void {
    this._sel.syncStyle();
  }

  /** @internal 测试用：当前选中 */
  get _selection(): PickResult | null {
    return this._sel.selection;
  }

  /** @internal 测试用：被高亮的网格 */
  get _selectedMeshes(): THREE.Object3D[] {
    return this._sel.selectedMeshes;
  }

  /** @internal 测试用：选中棱线的网格列表 */
  get _selectionEdgeMeshes(): THREE.Mesh[] {
    return this._sel.selectionEdgeMeshes;
  }

  /* ---------------------------------------------------------------- 渲染 */

  /**
   * 执行一帧 GPU 描边（法线 + 深度后处理）。
   *
   * 参数全部来自 style，不缓存：`edgeWidth` 在这里是「采样偏移」，线宽 ≈ 2×它；
   * `edgeThreshold` 是折边敏感度（夹角小于它不描），和 CPU 折边线同一口径。
   */
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

  /** 当前每个数据集的驻留显存/内存字节预算。Infinity = 不限制 */
  get maxMemory(): number {
    return this.options.maxMemory ?? Infinity;
  }

  /**
   * 调整每个数据集驻留显存字节数的软上限（默认 Infinity = 不限制）。
   * 不传 `datasetId` 时对所有已存在数据集立即生效，并作为之后新增数据集的默认值。
   * 实际裁剪发生在每帧调度末尾（make-before-break），不会当场开洞。
   */
  setMaxMemory(bytes: number, datasetId?: string): void {
    const next = Number.isFinite(bytes) && bytes > 0 ? bytes : Infinity;
    if (datasetId) {
      const entry = this.datasets.get(datasetId);
      if (entry?.tileset) (entry.tileset as any).setMaxMemory(next);
    } else {
      this.options.maxMemory = next;
      for (const entry of this.datasets.values()) {
        if (entry.tileset) (entry.tileset as any).setMaxMemory(next);
      }
    }
  }

  /** 当前各向异性过滤上限。Infinity = 不封顶 */
  get anisotropyCap(): number {
    return this.options.anisotropyCap ?? Infinity;
  }

  /**
   * 调整本图层的各向异性过滤上限（默认 Infinity = 取 GPU 最大值）。
   *
   * 与 0.4.22 之前不同：已上传的纹理**会立刻跟着变**（改 sampling 参数 + 重传，
   * 不需要重新解码，也不需要重载瓦片），所以切 `lightingPreset: 'supermap'` 时
   * 立面清晰度是当场变的，不再等新瓦片。
   */
  setAnisotropyCap(cap: number): void {
    const next = Number.isFinite(cap) && cap > 0 ? Math.max(1, cap) : Infinity;
    this.options.anisotropyCap = next;
    // 同步模块级默认：直接调 createTexture / buildTileObjects 的老用法仍读它
    const gpuMax = this.renderer?.capabilities.getMaxAnisotropy?.() ?? 1;
    setMaxAnisotropy(gpuMax, next);
    this._applyRenderProfile({ anisotropyCap: next });
  }

  /** 当前纹理长边像素上限。Infinity = 不限制 */
  get maxTextureSize(): number {
    return this.options.maxTextureSize ?? Infinity;
  }

  /**
   * 调整纹理长边像素上限（默认 Infinity = 不限制）。
   * 只影响之后解码的纹理；非图集的 RGBA / WebP 产物按 2× 减半逼近上限。
   *
   * 图层级：只改本层，同页其它图层不受影响（同时同步模块级默认，照顾直接调
   * `createTexture` 的老用法）。已解码的纹理不会重解 —— 那是另一件事。
   */
  setMaxTextureSize(n: number): void {
    const next = Number.isFinite(n) && n >= 1 ? n : Infinity;
    this.options.maxTextureSize = next;
    setTextureSizeCap(next);
    // 只推给数据集，不动材质也不重传纹理（尺寸上限只影响「之后解码」的纹理）
    this._datasetManager.setRenderProfile({ textureOptions: this._textureOptions() });
    this._requestRepaint();
  }

  /** 当前是否开启细化视锥剔除（第一期，issue #25） */
  get cullRefine(): boolean {
    return this._cullRefine;
  }

  set cullRefine(enabled: boolean) {
    this.setCullRefine(enabled);
  }

  /**
   * 开关细化视锥剔除（第一期，issue #25）。
   *
   * 只影响「要不要继续细化」：视野外的瓦片不再 `_enqueue` 子瓦片，
   * 已加载的瓦片、`lastSeen` 刷新、淘汰与显存预算都不动。
   */
  setCullRefine(enabled: boolean): void {
    const val = !!enabled;
    if (this._cullRefine === val) return;
    this._cullRefine = val;
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
  /** @internal 泼溅按视深重排，见 viewer/SplatLayer.ts */
  _sortSplats(): void {
    this._splats.sort(this.camera, this._pointClouds);
  }

  /**
   * 运动模糊路径（`_motionBlurCfg` 非空时接管「场景 → 屏幕」）。
   *
   * 返回 false = 不能用（WebGL1 / 尺寸非法），调用方回退直渲 —— 配置保留不丢，
   * 上下文恢复成 WebGL2 后下一帧自动生效。
   * `damp: 'auto'` 在这里按实时 FPS 解析（fps 为 0 的启动阶段按 60fps 保守取值），
   * `maxOffset` 已在 `normalizeMotionBlur` 里归一化（默认 0.05，屏宽百分比）。
   */
  private _renderMotionBlur(width: number, height: number): boolean {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    const cfg = this._motionBlurCfg;
    if (!renderer || !scene || !camera || !cfg) return false;
    this._motionBlur ||= new MotionBlurPass();
    if (!this._motionBlur.supported(renderer)) return false;
    this._motionBlur.render(renderer, scene, camera, width, height, {
      mode: cfg.mode,
      damp: cfg.damp === 'auto' ? autoMotionBlurDamp(this.fps) : cfg.damp,
      maxOffset: cfg.maxOffset,
      mvp: this._frameMvp,
      mvpInverse: camera.projectionMatrixInverse,
    });
    return true;
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
    // 覆盖物自己计时（rAF / 宿主帧率都不该影响它），顺带在这一帧完成锚点重锚补偿
    this.overlay.tick(performance.now());

    // 脏标记正常由微任务刷掉；这里再兜一次底，保证「本帧画出来的」一定是最新样式
    this.flushOverrides();

    const canvas = this.canvas;
    const sEast = this.sceneAnchor.meterInMercatorEast ?? this.sceneAnchor.meterInMercator;
    const sNorth = this.sceneAnchor.meterInMercatorNorth ?? this.sceneAnchor.meterInMercator;
    const sUp = this.sceneAnchor.meterInMercatorUp ?? sEast;

    // ENU → 世界坐标：x 向东，y 向北（墨卡托 y 朝南，所以取负），z 向上
    this._enuMatrix.set(
      sEast, 0, 0, this.sceneAnchor.x,
      0, -sNorth, 0, this.sceneAnchor.y,
      0, 0, sUp, this.sceneAnchor.z,
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

    // 视锥始终按宿主 MVP 算，不再受 `cullRefine` 开关控制。
    // three 自己的视锥是错的：`camera.projectionMatrix` 被换成完整 MVP、`matrixWorldInverse`
    // 只是相机平移的逆，两者相乘得到的视锥整体平移了「相机到锚点」的距离（#36 实测平面常数差
    // 恰好等于该距离）。所以「画不画」和「要不要细化」都只信这一份。
    const frustum = (this._frustum ??= new THREE.Frustum());
    frustum.setFromProjectionMatrix(mvp);
    const cullTestVec = (this._cullTestVec ??= new THREE.Vector3());

    for (const entry of this.datasets.values()) {
      if (!entry.visible || !entry.tileset) continue;
      const local: [number, number, number] = [
        camEnu[0] - entry.offset[0],
        camEnu[1] - entry.offset[1],
        camEnu[2] - entry.offset[2],
      ];

      const isVisible: TileVisibilityTest = (() => {
        const f = frustum;
        const v = cullTestVec;
        const entryOffset = entry.offset;
        return (center, radius, node) => {
          let worldX: number;
          let worldY: number;
          let worldZ: number;
          let worldRadius = radius;

          if (node?.group && node.group.parent) {
            v.set(center.x, center.y, center.z).applyMatrix4(node.group.matrixWorld);
            worldX = v.x;
            worldY = v.y;
            worldZ = v.z;
            worldRadius *= node.group.matrixWorld.getMaxScaleOnAxis();
          } else {
            worldX = center.x + entryOffset[0];
            worldY = center.y + entryOffset[1];
            worldZ = center.z + entryOffset[2];
          }

          // 边界余量：按球半径的 15% 且至少保留 10 米余量，避免视野边缘临界抖动与转头瞬间缺块
          const margin = Math.max(worldRadius * 0.15, 10);
          const limit = -(worldRadius + margin);

          const planes = f.planes;
          for (let i = 0; i < 6; i++) {
            const p = planes[i];
            const dist = p.normal.x * worldX + p.normal.y * worldY + p.normal.z * worldZ + p.constant;
            if (dist < limit) return false;
          }
          return true;
        };
      })();

      if (
        entry.tileset.update(local, opts.fovRad, lodScreenHeight, isVisible, {
          // cullRefine 只管「要不要为视野外瓦片请求子瓦片」；画不画一律按宿主 MVP 的视锥来
          refineCull: this._cullRefine,
          visibleCull: true,
        })
      ) {
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
    const effectiveDepthMode = (this.uniforms.uOpacity?.value ?? 1) > OPACITY_EPS
      ? this.resolveDepthMode()
      : 'scene';
    if (effectiveDepthMode === 'clear' && gl) {
      // gl.clear 受 depthMask 约束。上一帧若以 depthWrite=false 的材质收尾（棱线、半透明
      // 地表覆盖、半透明点云、泼溅），GL 的 depthMask 会停在 false —— three 帧末不恢复它，
      // 而 resetState 排在 clear 之后，救不了这一步。不自己打开就是一次静默的空操作：
      // 画面上的 z-fighting 原样保留，且没有任何报错可查。
      gl.depthMask(true);
      // 只清深度，不清颜色 —— 颜色是 MapLibre 已经画好的底图
      gl.clear(gl.DEPTH_BUFFER_BIT);
    }
    // 清完之后必须让 three 知道状态被外部改过，否则它的状态缓存会认为自己仍然正确
    this.renderer.resetState();
    // 完全透明时什么都不画：透明物体照样写深度，画了会在底图上挖出一个洞。
    // 这里跳过的是「本层的绘制」，宿主自己的清屏 / 底图照旧。
    if ((this.uniforms.uOpacity?.value ?? 1) > OPACITY_EPS) {
      this._sortSplats();
      // ── 视图归一（避免非零 cameraEnu 下相机平移被作用两次）──────────────────
      // `camera.projectionMatrix` 上面已经被设成完整 MVP（宿主 MVP · `_enuMatrix`），
      // 视图变换已在其中。关掉 `matrixWorldAutoUpdate` 后 Three.js 不会重算
      // `matrixWorldInverse`，渲染仍直接拿 `camera.matrixWorldInverse × object.matrixWorld`，
      // 所以主场景绘制期间必须把 `matrixWorld` 与 `matrixWorldInverse` 一起置为单位阵，
      // 并在 `finally` 还原，保证 GPU 描边 / 拾取 / LOD 仍拿到真实 `camEnu`。
      const keepWorld = this._drawKeepWorld.copy(this.camera.matrixWorld);
      const keepAuto = this.camera.matrixWorldAutoUpdate;
      this.camera.matrixWorldAutoUpdate = false;
      this.camera.matrixWorld.identity();
      this.camera.matrixWorldInverse.identity();
      try {
        // presenter 优先级最高：设了就由使用者接管「场景 → 屏幕」，库不再自己合成
        const presented = this._presenter
          ? this._presenterTarget.render(
              this.renderer,
              this.scene,
              this.camera,
              canvas.width,
              canvas.height,
              this._presenter
            )
          : false;
        if (presented) {
          // 场景已进 RT，上屏由 presenter 负责（见 PresenterTarget）
        } else if (this._motionBlurCfg && this._renderMotionBlur(canvas.width, canvas.height)) {
          // 运动模糊接管了「场景 → 屏幕」：场景进 RT，合成 quad 补回色调映射 / sRGB / 深度
        } else {
          this.renderer.render(this.scene, this.camera);
        }
      } finally {
        this.camera.matrixWorld.copy(keepWorld);
        this.camera.matrixWorldAutoUpdate = keepAuto;
        this.camera.matrixWorldInverse.copy(keepWorld).invert();
      }
      // GPU 描边必须画在主场景之后：它的全屏 quad 参与宿主深度测试，
      // 依赖本帧已经写好的深度（被地形挡住的地方不该描边）
      // clear 模式下宿主深度已清除，描边会穿透地形产生伪影，故只在非 clear 时画。
      if (effectiveDepthMode !== 'clear') {
        this._edges.renderGpuEdges(canvas);
      }
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
      // 有动态覆盖物就必须继续驱动：它的 update 钩子还等着下一帧。
      // 静态覆盖物不参与，否则挂着 200 个 glb 地图就永远不空闲
      this.overlay.hasAnimated ||
      this.stats.loading > 0 ||
      tilesetChanged;

    // 兜底：材质不是经 `_registerTile` 进来的路径（如原地重建材质）也能热一次。
    // 正常路径上 `_registerTile` 已经发起过，这里有 `_shadingPrewarmed` 挡着。
    this._prewarmShadingSoon();

    return needsNextFrame;
  }

  /**
   * 发起一次着色器预热（没有材质 / 没挂载就什么都不做）。
   *
   * 时机很要紧：`compileAsync` 内部只把 program 交给 GPU 进程去链（`linkProgram` 立即返回），
   * 真正的等待发生在 `compileAsync` 的轮询里，不占 JS。所以越早发起越好 —— 放在
   * `renderFrame` 末尾时那一帧已经画完了，首帧的 `useProgram` 仍要同步等链接完成
   * （实测主线程卡 ~300ms，CPU profile 里 `getProgramInfoLog` 独占 35%）。
   */
  private _prewarmShadingSoon(): void {
    if (!this._prewarmShadingEnabled || this._shadingPrewarmed) return;
    // `prewarmShading` 自己没有材质时也会安全返回，这里只做「开关 + 只热一次」的门禁
    void this.prewarmShading();
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
