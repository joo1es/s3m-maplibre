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
import type { AuthenticateFn } from '../core/AuthFetch.js';
import { setSplatViewport } from './GeometryBuilder.js';
import { setMaxAnisotropy, setCompressedTexturesSupported, setTextureOffThreadDecode, setMaxTextureSize as setTextureSizeCap } from './TextureFactory.js';
import { getMaterialQuality, normalizeMaterialQuality } from './StyleMaterial.js';
import type { LightingPreset } from './lightingPreset.js';
import { LightRig } from './viewer/LightRig.js';
import { HeightIndex } from './viewer/HeightIndex.js';
import { SplatLayer } from './viewer/SplatLayer.js';
import { EdgeDecorator } from './viewer/EdgeDecorator.js';
import { PickService } from './viewer/PickService.js';
import { SelectionDecorator } from './viewer/SelectionDecorator.js';
import type {
  LightOptions,
  S3MViewerOptions,
  PickResult,
  PickableRef,
  PathFollowOptions,
  MeshUserData,
} from './viewer/types.js';
import { decodeTextureWithWorker } from '../worker/S3MWorkerClient.js';
import {
  STYLE,
  STYLE_LABELS,
  SELECT_MODE,
  DEFAULT_STYLE,
  createSharedUniforms,
  createStyledMaterial,
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
} from './StyleMaterial.js';
import { applyPointCloudStyle, isOwnedPointCloudMaterial } from './PointCloudMaterial.js';
import type { DegradationKind, UnsupportedPolicy } from '../core/degradations.js';
import { Picker } from './Picker.js';
import { GpuEdgePass } from './GpuEdgePass.js';
import { Animator } from '../anim/Animator.js';
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
} from './viewer/types.js';

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
  private readonly _pathSpecs = new Map<string, { path: Path; offset: [number, number, number] }>();
  /** 路径采样临时对象，避免每帧 new */
  private readonly _pathScratch = new Float32Array(3);
  /** 求切线用的第二个采样点（包围盒换算 GPU 路径朝向时用） */
  private readonly _pathScratch2 = new Float32Array(3);

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
    // 只记本层的档位，**不写模块级全局**：以前这里 setMaterialQuality(...) 会把全局
    // 改掉，于是同页后创建的图层顺手把先创建的图层也打回去了（多层互相覆盖的根因）。
    this._materialQuality = normalizeMaterialQuality(options.materialQuality);
    // 之后 addDataset 的数据集按这个默认建材质（数据集自己指定则用自己的）
    this._datasetManager.defaultMaterialQuality = this._materialQuality;
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
    // 光源状态在这里就位：LightRig 构造时会按 lightingPreset 切模块级颜色管线，
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
      scene: this.scene,
      renderer: this.renderer,
      camera: this.camera,
      authenticate: this._authenticate,
      requestRepaint: () => this.triggerRepaint(),
    });
    this.lineShared = this._edges.lineShared;
    this.edgeMaterial = this._edges.edgeMaterial;
    this.selectionEdgeMaterial = this._edges.selectionEdgeMaterial;
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
    this.edgeMaterial.dispose();
    this.selectionEdgeMaterial.dispose();
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

  private _registerTile(node: TileNode, entry: S3MDatasetEntry): void {
    entry.root.add(node.group);
    node.group.updateMatrixWorld(true);

    const hasNativeEdges = node.group.userData.hasNativeEdges === true;
    // forceCpuEdges：无视数据自带的棱线包，改由 CPU 现算。native 是 1px 的
    // LineBasicMaterial，edgeWidth / 外扩 / 单体跟随全都吃不上。
    // gpu 画法由 shader 自己描边，native 线段包同样不能留
    const useNativeEdges = this._edges.useNativeEdges(hasNativeEdges);

    for (const child of node.group.children) {
      // 数据自带的棱线包：只跟着 edges 开关显示，不参与拾取、不参与着色
      if ((child as THREE.LineSegments).isLineSegments && (child.userData as MeshUserData).isEdgeLines) {
        // 一律登记：forceCpuEdges 之后又关掉时还要能把它们放出来
        this._edges.registerNativeLine(child as THREE.LineSegments, useNativeEdges && this._edges.enabled);
        continue;
      }

      // 点云是 THREE.Points 不是 Mesh，但同样要进拾取表、吃不透明度、跟着着色模式走
      const isPoints = isPointCloudObject(child);
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh && !isPoints) continue;
      if (isPoints) this._pointClouds.add(child as THREE.Points);
      // 新瓦片里的泼溅实例还没按当前视角排过，下一帧要重排
      if (isPoints) this._splats.markDirty();
      const ud = mesh.userData as MeshUserData;
      ud.pickId = this._allocPickId();
      ud.datasetId = entry.id;
      ud.nativeEdges = useNativeEdges;
      ud.nativeEdgesRaw = hasNativeEdges;
      this._picks.pickables.set(ud.pickId, {
        datasetId: entry.id,
        mesh,
        tile: node.tile,
        skeletonName: ud.skeletonName ?? '',
      });
      this._indexMeshSmids(mesh);
      this._heights.add(mesh);
      // 点云没有「棱」：给一堆孤立点建 EdgesGeometry 又慢又没意义
      // 点云没有「棱」：给一堆孤立点建 EdgesGeometry 又慢又没意义。
      // 自动描边受三道开关控制：全局 style.edges / 数据集 enableEdges / 地形绿地等关键字跳过。
      this._edges.autoDecorate(mesh, entry, useNativeEdges);

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
      this._sel.replayOnto(mesh);
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

  /** @internal 把当前选中重放到新登记的 mesh 上，见 viewer/SelectionDecorator.ts */
  _replaySelectionOnto(mesh: THREE.Mesh): void {
    this._sel.replayOnto(mesh);
  }

  /** 瓦片被淘汰：从拾取表和场景里摘掉，并深度彻底释放所有几何体与材质显存 */
  private _unregisterTile(node: TileNode, entry: S3MDatasetEntry): void {
    node.group.traverse((child) => {
      const obj = child as any;
      if ((child as THREE.LineSegments).isLineSegments && obj.userData?.isEdgeLines) {
        this._edges.unregisterNativeLine(child as THREE.LineSegments);
      }
      if (isPointCloudObject(child)) this._pointClouds.delete(child);
      // 淡入还没结束就被淘汰：把通道收掉，否则会对着已释放的材质继续写
      if (obj.userData?.tileFadeKey) {
        this.animator.unregister(obj.userData.tileFadeKey);
        obj.userData.tileFadeKey = undefined;
      }
      if (obj.userData?.pickId != null) {
        this._picks.pickables.delete(obj.userData.pickId);
        this._releasePickId(obj.userData.pickId);
        obj.userData.pickId = undefined;
      }
      if (obj.isMesh) {
        const wasSelected = this._sel.selectedMeshes.includes(obj);
        if (wasSelected) {
          this._sel.selectedMeshes = this._sel.selectedMeshes.filter((m) => m !== obj);
        }
        const currentSel = this._sel.selection;
        if (currentSel && currentSel.mesh === obj) {
          const smid = currentSel.smid;
          const carrier = (
            smid != null
              ? [...(this._smidMeshes.get(smid) ?? [])].find((m) => m !== obj && m.parent)
              : this._sel.selectedMeshes.find((m) => m !== obj && m.parent && (m.parent as any).visible) ??
                this._sel.selectedMeshes.find((m) => m !== obj && m.parent)
          ) as THREE.Mesh | undefined;
          if (carrier) {
            // 选中身份交给承载同一 smid 的另一块 mesh（通常是接替显示的子瓦）
            this._sel.selection = { ...currentSel, mesh: carrier };
            this._sel.replayOnto(carrier);
          } else {
            this.select(null);
          }
        }
        this._unindexMeshSmids(obj);
        this._heights.remove(obj);
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
        this._edges.syncStyle();
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
      this._edges.refreshLines();
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
    if (('edgeThreshold' in patch || 'forceCpuEdges' in patch) && this._edges.enabled) {
      this._edges.disposeEdgeGeometry();
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
      this._edges.refreshLines();
    }
    if (this._sel.selection) {
      // 换描边画法要重建几何；颜色 / 粗细 / 拔高只是 uniform，拖着滑块也不卡
      if ('outline' in patch || 'outlineStyle' in patch) this.select(this._sel.selection, { silent: true });
      else this._sel.syncStyle();
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
      for (const p of this._picks.pickables.values()) {
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

    this._edges.syncStyle();
    this._requestRepaint();
  }

  /** 单个点云对象同步当前样式（着色模式 + 不透明度 + 选中高亮） */
  private _applyPointCloudStyle(points: THREE.Points, selected = this._sel.selectedMeshes.includes(points)): void {
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
    for (const p of this._picks.pickables.values()) {
      const m = styledMaterialOf(p.mesh);
      const u = m?.userData.uFlatShading;
      if (!u || u.value === target) continue;
      u.value = target;
    }
    this._requestRepaint();
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
  get materialQuality(): MaterialQuality {
    return this._materialQuality ?? getMaterialQuality();
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
    for (const p of this._picks.pickables.values()) {
      const mesh = p.mesh;
      const raw = mesh.material;
      if (Array.isArray(raw)) continue; // styled 材质恒为单材质；数组材质（点云等）不归这里管
      const old = raw as StyledMaterial | undefined;
      if (!old?.userData?.isStyled || !old.userData?.s3mOpts) continue;
      const opts = old.userData.s3mOpts as StyledMaterialOptions;
      // 显式传本层档位：s3mOpts 里记的是创建时的参数，可能是 undefined（跟随全局），
      // 重建时必须钉成本层当前档位，否则「别处改了全局」会把这一层带跑。
      const fresh = createStyledMaterial({ ...opts, uniforms: this.uniforms, materialQuality: this.materialQuality });
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
    for (const p of this._picks.pickables.values()) {
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
  /** @internal 泼溅按视深重排，见 viewer/SplatLayer.ts */
  _sortSplats(): void {
    this._splats.sort(this.camera, this._pointClouds);
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
      this._edges.renderGpuEdges(canvas);
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
    if (this._prewarmShadingEnabled && !this._shadingPrewarmed && this._picks.pickables.size > 0) {
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
