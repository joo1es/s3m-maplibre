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
import { setMaxAnisotropy } from './TextureFactory.js';
import {
  STYLE,
  STYLE_LABELS,
  SELECT_MODE,
  DEFAULT_STYLE,
  createSharedUniforms,
  createOutlineMaterial,
} from './StyleMaterial.js';
import type { OutlineMaterial, StyledMaterial, StyleMode, SelectMode, S3MStyle } from './StyleMaterial.js';
import { applyPointCloudStyle, isOwnedPointCloudMaterial } from './PointCloudMaterial.js';
import { Picker } from './Picker.js';
import {
  buildFeatureEdgeSegments,
  buildThickLineGeometry,
  createLineSharedUniforms,
  createThickLineMaterial,
} from './EdgeLines.js';
import type { LineSharedUniforms, ThickLineMaterial } from './EdgeLines.js';
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
  /** 主平行光颜色，默认 0xffffff */
  keyLightColor?: number | string;
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
  /** 光照参数配置（强度、颜色、朝向模式、太阳方位角/仰角等） */
  light?: LightOptions;
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
  /** LOD 切换范围缩放系数（默认 1.0），> 1 更倾向保留粗模，< 1 提前换细模 */
  lodRangeScale?: number;
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
  onStats?: (stats: Stats) => void;
  onReady?: (entry: S3MDatasetEntry) => void;
  onPick?: (result: PickResult | null) => void;
  onError?: (error: unknown) => void;
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
  /** 数据自带棱线包（此时不再用 EdgesGeometry 现算） */
  nativeEdges?: boolean;
  /** 数据自带的棱线对象本身 */
  isEdgeLines?: boolean;
  /** CPU 现算的等宽棱线（与 isEdgeLines 区分，便于刷新样式） */
  isThickEdge?: boolean;
  /** 选中单体的棱线对象 */
  isSelectionEdge?: boolean;
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
  style: S3MStyle;
  readonly outlineMaterial: OutlineMaterial;

  /** 等宽线共享的分辨率 uniform（全局棱线 + 选中棱线共用） */
  readonly lineShared: LineSharedUniforms;
  /** 全局棱线材质 */
  readonly edgeMaterial: ThickLineMaterial;
  /** 选中棱线材质 */
  readonly selectionEdgeMaterial: ThickLineMaterial;

  /** 3D 物理地表面 / 基坑开挖管理器 */
  readonly groundManager: GroundManager;
  /** 多数据集生命周期与锚点管理器 */
  private readonly _datasetManager = new DatasetManager();
  /** 单体样式、专题着色与状态纹理管理器 */
  private readonly _featureStyleManager: FeatureStyleManager;

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

  /** 业务属性查询（可选，配了 `attributes` 才有） */
  attributeQuery: AttributeQuery | null = null;

  private readonly _enuMatrix = new THREE.Matrix4();
  private _needsRepaint = true;
  private _frame = 0;
  private readonly _fps = { value: 0, last: 0 };
  private _ambientLight!: THREE.AmbientLight;
  private _hemiLight!: THREE.HemisphereLight;
  private _keyLight!: THREE.DirectionalLight;
  private _fillLight!: THREE.DirectionalLight;
  private readonly _lightOptions: Required<LightOptions> = {
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
  private _lodRangeScale = 1.0;

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
    if (options.light) {
      Object.assign(this._lightOptions, options.light);
    }
    if (options.totalMaxTiles) {
      this._datasetManager.totalMaxTiles = options.totalMaxTiles;
    }
    this._onRequestRepaint = options.onRequestRepaint ?? (() => {});
    this._getBearing = options.getBearing;
    this.onStats = options.onStats ?? (() => {});
    this.onReady = options.onReady ?? (() => {});
    this.onPick = options.onPick ?? (() => {});
    this.onError = options.onError ?? ((e) => console.warn('[s3m]', e));

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
      (mesh) => this._applyOverridesToMesh(mesh)
    );

    this.uniforms = createSharedUniforms();
    this.style = { ...DEFAULT_STYLE, ...(options.style ?? {}) };
    this.outlineMaterial = createOutlineMaterial(this.uniforms);

    this.lineShared = createLineSharedUniforms();
    this.edgeMaterial = createThickLineMaterial(this.lineShared, {
      color: this.style.edgeColor,
      opacity: this.style.edgeOpacity ?? 0.45,
      width: this.style.edgeWidth ?? 1.2,
    });
    this.selectionEdgeMaterial = createThickLineMaterial(this.lineShared, {
      color: this.style.outlineColor ?? this.style.selectColor,
      opacity: 1,
      width: this.style.outlineWidthPx ?? 3,
    });

    // 关键：style.edges 是个开关，但构造函数从没据此启用过棱线，导致
    // `style: { edges: true }` 形同虚设、_edgesEnabled 永远是 false。
    // 这里按 style 实际值调一次 setEdges，让开关真正生效（与 setEdges 后来的手工调用一致）。
    this.setEdges(!!this.style.edges);

    this._fps.last = performance.now();
    this._datasetQueue = this._normalizeDatasets(options);
    if (options.attributes) this.attributeQuery = new AttributeQuery(options.attributes);
  }

  /* ---------------------------------------------------------------- 生命周期 */

  /**
   * 绑定宿主画布与 WebGL 上下文，建场景并启动数据集队列。
   * MapLibre 宿主由 S3MLayer 在 onAdd 里调用；纯 three 宿主直接传自己的 canvas / gl。
   */
  /** 创建并配置一个绑定到给定 gl 上下文的 three renderer（mount 与上下文恢复共用） */
  private _createRenderer(canvas: HTMLCanvasElement, gl: WebGLRenderingContext | WebGL2RenderingContext): THREE.WebGLRenderer {
    const r = new THREE.WebGLRenderer({
      canvas,
      context: gl as WebGLRenderingContext,
      antialias: true,
    });
    r.autoClear = false;
    r.setPixelRatio(1);
    // 白模 albedo 接近 1，不做色调映射会过曝成一片纯白、丢失明暗关系
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    return r;
  }

  mount(canvas: HTMLCanvasElement, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.canvas = canvas;

    this.renderer = this._createRenderer(canvas, gl);
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

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
      this.renderer?.dispose();
    } catch {
      /* noop */
    }
    this.renderer = this._createRenderer(this.canvas, gl);
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    this.picker?.dispose();
    this.picker = new Picker(this.renderer);
    // 共享 uniform / 材质引用不变，three 重新编译着色器时会自然接管；
    // 这里只确保下一帧尽快驱动一次渲染。
    this._requestRepaint();
  }

  /** 解绑场景并释放全部 GPU 资源。对应 MapLibre 图层的 onRemove()。 */
  unmount(): void {
    for (const id of [...this.datasets.keys()]) this.removeDataset(id);
    this.groundManager.dispose();
    this.picker?.dispose();
    this.picker = null;
    this.outlineMaterial.dispose();
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
    this._heightMin = Infinity;
    this._heightMax = -Infinity;
    this.renderer?.dispose();
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
   * 动态设置光照配置
   */
  setLight(options: Partial<LightOptions>): void {
    Object.assign(this._lightOptions, options);
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
  }

  /* ---------------------------------------------------------------- 数据集 */

  private _normalizeDatasets(options: S3MViewerOptions): S3MDatasetOptions[] {
    if (Array.isArray(options.datasets)) return options.datasets.filter((d) => !!d?.configUrl);
    if (options.configUrl) return [{ id: 'default', name: '默认数据集', configUrl: options.configUrl }];
    return [];
  }

  /** 追加一个数据集。图层 addLayer 之前调用会抛错。 */
  async addDataset(ds: S3MDatasetOptions): Promise<S3MDatasetEntry> {
    if (!this.scene) throw new Error('[s3m] 图层尚未 addLayer，不能添加数据集');
    const entry = await this._datasetManager.addDataset(
      ds,
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
      }
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
    this._featureStyleManager.removeFeatureStyle(smid, this._meshesOf([smid]));
  }

  /** 清空所有单体的自定义样式 */
  clearFeatureStyles(): void {
    this._featureStyleManager.clearFeatureStyles();
  }

  /* ---------------------------------------------------------------- 按业务字段着色 */

  setAttributeSource(options: AttributeQueryOptions | null): void {
    this.attributeQuery = options ? new AttributeQuery(options) : null;
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

    for (const child of node.group.children) {
      // 数据自带的棱线包：只跟着 edges 开关显示，不参与拾取、不参与着色
      if ((child as THREE.LineSegments).isLineSegments && (child.userData as MeshUserData).isEdgeLines) {
        child.visible = this._edgesEnabled;
        this._styleEdgeLine(child as THREE.LineSegments);
        continue;
      }

      // 点云是 THREE.Points 不是 Mesh，但同样要进拾取表、吃不透明度、跟着着色模式走
      const isPoints = isPointCloudObject(child);
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh && !isPoints) continue;
      const ud = mesh.userData as MeshUserData;
      ud.pickId = this._allocPickId();
      ud.datasetId = entry.id;
      ud.nativeEdges = hasNativeEdges;
      this._pickables.set(ud.pickId, {
        datasetId: entry.id,
        mesh,
        tile: node.tile,
        skeletonName: ud.skeletonName ?? '',
      });
      this._indexMeshSmids(mesh);
      this._addMeshHeight(mesh);
      // 点云没有「棱」：给一堆孤立点建 EdgesGeometry 又慢又没意义
      if (this._edgesEnabled && !hasNativeEdges && !isPoints) this._ensureEdges(mesh);

      // 新瓦片要继承当前的不透明度与着色方式
      if (isPoints) {
        this._applyPointCloudStyle(child as THREE.Points);
      } else {
        const mat = styledMaterialOf(mesh);
        if (mat) {
          const o = Math.min(1, Math.max(0.05, this.style.opacity ?? 1));
          mat.opacity = o;
          mat.transparent = o < 0.999;
          mat.depthWrite = o >= 0.999;
          mat.flatShading = this.style.shading !== 'smooth';
          mat.needsUpdate = true;
          this._featureStyleManager.applyOverridesToMesh(mesh);
        }
      }

      // 选中状态也要跟着继承：LOD 细化 / 瓦片重载会换掉 mesh，
      // 不重放就出现「点中的那栋楼一拉近就没高亮了」
      this._replaySelectionOnto(mesh);
    }
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
  setOpacity(opacity: number): void {
    this.setStyle({ opacity });
  }

  /** 合并并应用样式。只改 uniform 的项不会触发几何/着色器重建。 */
  setStyle(patch: Partial<S3MStyle> = {}): void {
    this.style = { ...this.style, ...patch };
    this._applyStyleUniforms();
    if ('opacity' in patch || 'depthWrite' in patch) this._applyOpacity();
    // 点云不走 StyleMaterial 的 uMode，模式切换要单独同步它的材质
    if ('mode' in patch) this._applyPointCloudStyles();
    if ('shading' in patch) this._applyShading();
    if ('edges' in patch) this.setEdges(!!this.style.edges);
    else if ('edgeColor' in patch || 'edgeWidth' in patch || 'opacity' in patch || 'edgeOpacity' in patch) {
      this._refreshEdgeLines();
    }
    if (this._selection) {
      // 换描边画法要重建几何；颜色 / 粗细 / 拔高只是 uniform，拖着滑块也不卡
      if ('outline' in patch || 'outlineStyle' in patch) this.select(this._selection, { silent: true });
      else this._syncSelectionStyle();
    }
    this._requestRepaint();
  }

  getStyle(): S3MStyle & { modeLabel: string } {
    return { ...this.style, modeLabel: STYLE_LABELS[this.style.mode] };
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

  /** 透明度：只改材质状态，不触发着色器重编译，所以可以跟着滑块实时拖 */
  private _applyOpacity(): void {
    const o = Math.min(1, Math.max(0.05, this.style.opacity ?? 1));
    const transparent = o < 0.999;
    // 关键：若 depthWrite 开启（默认开启），即使半透明也保持深度写入，完美遮挡背面棱线，防止背面线条透出
    const keepDepth = this.style.depthWrite !== false;
    for (const p of this._pickables.values()) {
      if (isPointCloudObject(p.mesh)) {
        this._applyPointCloudStyle(p.mesh);
        continue;
      }
      const m = styledMaterialOf(p.mesh);
      if (!m) continue;
      m.opacity = o;
      m.transparent = transparent;
      m.depthWrite = transparent ? keepDepth : true;
    }
    this._requestRepaint();
  }

  /** 单个点云对象同步当前样式（着色模式 + 不透明度 + 选中高亮） */
  private _applyPointCloudStyle(points: THREE.Points, selected = this._selectedMeshes.includes(points)): void {
    applyPointCloudStyle(points, this.style, this.uniforms, selected);
  }

  /** 全部点云刷新：着色模式切换时用（uniform 是共享引用，改色不用走这里） */
  private _applyPointCloudStyles(): void {
    for (const p of this._pickables.values()) {
      if (isPointCloudObject(p.mesh)) this._applyPointCloudStyle(p.mesh);
    }
    this._requestRepaint();
  }

  /** 平面/平滑着色：FLAT_SHADED 是编译期宏，改它必须重编译 */
  private _applyShading(): void {
    const flat = this.style.shading !== 'smooth';
    for (const p of this._pickables.values()) {
      const m = styledMaterialOf(p.mesh);
      if (!m || m.flatShading === flat) continue;
      m.flatShading = flat;
      m.needsUpdate = true;
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
   * 数据自带棱线包（primitiveType 13）时直接用，成本为零；
   * 没有的话才用 EdgesGeometry 现算 —— 那是 CPU 端的活，几十万面一次性建会卡住主线程
   * （实测 20 个网格 1.9s），所以按 8ms 一帧切片，边建边出。
   *
   * 棱线本身用「屏幕空间等宽线」画（见 EdgeLines.ts）：WebGL 的 lineWidth 基本无效，
   * 只有摊成面向屏幕的四边形，`edgeWidth` 才能真正调粗。
   */
  setEdges(enabled: boolean): void {
    this._edgesEnabled = enabled;
    this.style.edges = enabled;

    // 数据自带的棱线：直接切可见性
    for (const entry of this.datasets.values()) {
      entry.root.traverse((o) => {
        const ud = o.userData as MeshUserData;
        if (ud.isEdgeLines) {
          o.visible = enabled;
          this._styleEdgeLine(o as THREE.LineSegments);
        }
      });
    }
    this._syncEdgeStyle();

    if (!enabled) {
      for (const p of this._pickables.values()) this._removeEdges(p.mesh);
      this._requestRepaint();
      return;
    }

    const pending = [...this._pickables.values()]
      .map((p) => p.mesh)
      .filter((m) => {
        const ud = m.userData as MeshUserData;
        // 点云没有棱可描
        return !ud.edges && !ud.nativeEdges && !isPointCloudObject(m);
      });
    let i = 0;
    const step = (): void => {
      const t0 = performance.now();
      while (i < pending.length && performance.now() - t0 < 8) this._ensureEdges(pending[i++]);
      if (i < pending.length) setTimeout(step, 0);
      else this._requestRepaint();
    };
    step();
  }

  /** 让全局棱线材质跟上 style.edgeColor / edgeWidth / edgeOpacity */
  private _syncEdgeStyle(): void {
    const s = this.style;
    const u = this.edgeMaterial.uniforms;
    u.uColor.value.set(s.edgeColor);
    u.uWidth.value = Math.max(0.1, s.edgeWidth ?? 1.2);
    u.uOpacity.value =
      Math.min(1, Math.max(0, s.edgeOpacity ?? 0.45)) * Math.min(1, Math.max(0.05, s.opacity ?? 1));
  }

  /** 让数据自带的棱线跟着 style.edgeColor / opacity 走（这些是 LineBasicMaterial，改不了粗细） */
  private _styleEdgeLine(lines: THREE.LineSegments): void {
    const mat = lines.material as THREE.LineBasicMaterial;
    if (!mat || !mat.color) return;
    mat.color.set(this.style.edgeColor);
    const baseOpacity = this.style.edgeOpacity ?? 0.45;
    mat.opacity = baseOpacity * Math.min(1, Math.max(0.05, this.style.opacity ?? 1));
    mat.transparent = true;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    mat.needsUpdate = true;
  }

  private _refreshEdgeLines(): void {
    this._syncEdgeStyle();
    for (const entry of this.datasets.values()) {
      entry.root.traverse((o) => {
        if ((o.userData as MeshUserData).isEdgeLines) this._styleEdgeLine(o as THREE.LineSegments);
      });
    }
  }

  private _ensureEdges(mesh: THREE.Mesh): void {
    const ud = mesh.userData as MeshUserData;
    if (ud.edges || ud.nativeEdges || !mesh.geometry) return;
    const indexCount = mesh.geometry.index?.count ?? 0;
    // 棱线是 CPU 端建的，超大几何直接跳过，避免拖慢加载
    if (indexCount > 120000) return;

    const source = new THREE.EdgesGeometry(mesh.geometry, 40);
    const attr = source.getAttribute('position') as THREE.BufferAttribute | undefined;
    const segments = attr ? (attr.array as Float32Array) : null;
    source.dispose();
    if (!segments || segments.length < 6) return;

    const lines = new THREE.Mesh(buildThickLineGeometry(segments), this.edgeMaterial);
    lines.renderOrder = 2;
    // 屏幕空间外扩后可能超出原包围球，关掉剔除更稳
    lines.frustumCulled = false;
    lines.raycast = () => {};
    (lines.userData as MeshUserData).isThickEdge = true;
    ud.edges = lines;
    mesh.add(lines); // 作为子节点，自动继承 mesh 的世界变换
  }

  private _removeEdges(mesh: THREE.Mesh): void {
    const ud = mesh.userData as MeshUserData;
    const lines = ud.edges;
    if (!lines) return;
    mesh.remove(lines);
    (lines as THREE.Mesh).geometry?.dispose();
    ud.edges = null;
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

        for (const c of corners) {
          if (trans) c.add(new THREE.Vector3(trans[0], trans[1], trans[2]));
          else if (elev) c.z += elev;

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
      if (mesh === result.mesh && result.instanceIndex != null) {
        // 实例化几何没有逐单体的顶点区间，整个 base mesh 就是这一栋的外形
        segments = [{ vertexOffset: 0, vertexCount: mesh.geometry.getAttribute('position')?.count ?? 0 }];
      } else if (result.smid != null) {
        const pickInfo = geoRef?.pickInfo;
        const entry = (pickInfo as Record<string | number, unknown> | undefined)?.[result.smid] ??
          (pickInfo as Record<string | number, unknown> | undefined)?.[String(result.smid)];
        const bId = entry ? pickEntryId(entry as any) : -1;
        segments = (entry as any)?.segments ?? (bId >= 0 ? resolveFeature(geoRef, bId).segments : []);
      } else if (mesh === result.mesh) {
        const localGeo = (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(result.batchId) ?? geoRef;
        segments = resolveFeature(localGeo, result.batchId).segments;
      }

      const pairs = buildFeatureEdgeSegments(mesh.geometry, segments);
      if (pairs && pairs.length > 0) {
        const lines = new THREE.Mesh(buildThickLineGeometry(pairs), this.selectionEdgeMaterial);
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
    u.uOpacity.value = Math.min(1, Math.max(0.05, s.opacity ?? 1));
    u.uElevation.value = this._selection ? this._selectionElevation(this._selection) : 0;

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
    const mvp = new THREE.Matrix4().fromArray(opts.mvp as number[]);
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
    for (const entry of this.datasets.values()) {
      if (!entry.visible || !entry.tileset) continue;
      const local: [number, number, number] = [
        camEnu[0] - entry.offset[0],
        camEnu[1] - entry.offset[1],
        camEnu[2] - entry.offset[2],
      ];
      if (entry.tileset.update(local, opts.fovRad, opts.canvasHeight)) {
        tilesetChanged = true;
      }
    }

    if (this.style.mode === STYLE.DYNAMIC) {
      this.uniforms.uTime.value += 0.016 * (this.style.speed ?? 1);
    }

    this._updateLights();

    // 等宽棱线按设备像素撑开，分辨率每帧同步一次
    this._updateLineResolution(canvas);

    this.renderer.setViewport(0, 0, canvas.width, canvas.height);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);

    this._frame++;
    const now = performance.now();
    if (now - this._fps.last > 500) {
      this._fps.value = Math.round((this._frame * 1000) / (now - this._fps.last));
      this._frame = 0;
      this._fps.last = now;
    }

    // 动态着色 / 瓦片加载中 / 瓦片层级或可见性改变，都需要宿主继续驱动下一帧
    return this.style.mode === STYLE.DYNAMIC || this.stats.loading > 0 || tilesetChanged;
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
    };
    for (const entry of this.datasets.values()) {
      const s = entry.tileset?.stats;
      if (!s) continue;
      total.tiles += s.tiles;
      total.loading += s.loading;
      total.failed += s.failed;
      total.meshes += s.meshes;
      total.vertices += s.vertices;
      total.triangles += s.triangles;
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
