/**
 * S3M × MapLibre / Mapbox 图层
 *
 * 坐标链路：
 *   S3M 顶点（数据集局部 ENU，米）
 *     → 数据集 Group 偏移：把各数据集锚点对齐到「场景锚点」
 *     → L 矩阵：ENU → Web Mercator 归一化坐标
 *     → 宿主传入的 mercator→clip 矩阵
 *
 * 关键点：three 场景原点固定在**场景锚点**（第一个数据集的位置），
 * 所有顶点只保留「相对锚点的米」，避免 float32 在墨卡托大坐标下的抖动（RTC 思路）。
 * 多数据集叠加时，每个数据集一个 Group，用 position 承担锚点差。
 *
 * 兼容性：图层只依赖 `MapLike` 这组鸭子类型接口，MapLibre GL JS v4/v5 与
 * Mapbox GL JS v2/v3 都可以直接 `map.addLayer(layer)`，不引入任一方的类型依赖。
 */
import * as THREE from 'three';
import { S3MTileset } from '../tileset/S3MTileset.js';
import type { BuildTileFn, TileNode } from '../tileset/S3MTileset.js';
import { setMaxAnisotropy } from './TextureFactory.js';
import {
  STYLE,
  STYLE_LABELS,
  SELECT_MODE,
  SELECT_MODE_LABELS,
  createSharedUniforms,
  createOutlineMaterial,
} from './StyleMaterial.js';
import type { OutlineMaterial, StyledMaterial, StyleMode, SelectMode } from './StyleMaterial.js';
import { Picker } from './Picker.js';
import {
  buildFeatureEdgeSegments,
  buildThickLineGeometry,
  createLineSharedUniforms,
  createThickLineMaterial,
} from './EdgeLines.js';
import type { LineSharedUniforms, ThickLineMaterial } from './EdgeLines.js';
import { resolveFeature, measureSegments, buildAttributes, DEFAULT_FLOOR_HEIGHT } from '../core/FeatureInfo.js';
import { AttributeQuery } from '../core/AttributeQuery.js';
import type { AttributeQueryOptions, AttributeRow } from '../core/AttributeQuery.js';
import type {
  Anchor,
  FeatureAttributes,
  GeoPackageEntry,
  ParsedTile,
  Stats,
  StyleUniforms,
} from '../core/types.js';

const EARTH_RADIUS = 6378137;
const DEFAULT_FOV = 0.6435011087932844; // MapLibre 默认垂直视场角

/* ------------------------------------------------------------------ 宿主适配 */

/** 宿主地图上我们真正用到的能力，MapLibre / Mapbox 的交集 */
export interface MapLike {
  getCanvas(): HTMLCanvasElement;
  triggerRepaint(): void;
  on(type: string, listener: (e: MapMouseEventLike) => void): unknown;
  off(type: string, listener: (e: MapMouseEventLike) => void): unknown;
  getBearing?(): number;
  getFreeCameraOptions?(): { position?: { x: number; y: number; z: number } | null } | null;
  transform?: { fov?: number };
}

export interface MapMouseEventLike {
  originalEvent?: { clientX: number; clientY: number };
  point?: { x: number; y: number };
}

/* ------------------------------------------------------------------ 数学 */

/** 经纬度 → 墨卡托归一化坐标（世界为 1×1） */
function mercatorFromLngLat(
  lon: number,
  lat: number,
  altitude = 0
): { x: number; y: number; z: number; meterInMercator: number } {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const x = (180 + lon) / 360;
  const y = 0.5 - (0.25 * Math.log((1 + sinLat) / (1 - sinLat))) / Math.PI;
  const meterInMercator = 1 / (2 * Math.PI * EARTH_RADIUS) / Math.cos((lat * Math.PI) / 180);
  return { x, y, z: altitude * meterInMercator, meterInMercator };
}

/** 墨卡托归一化坐标 → 经纬度 */
function lngLatFromMercator(x: number, y: number): [number, number] {
  const lon = x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [lon, lat];
}

/* ------------------------------------------------------------------ 配置 */

export interface S3MStyle {
  /** 着色模式，见 STYLE */
  mode: StyleMode;
  /** 主色：白膜 / 单色 / 渐变起点 / 动态扫描底色 */
  colorA: string;
  /** 渐变终点 / 楼层高段色 */
  colorB: string;
  /** 动态扫描的高亮带颜色 */
  colorC: string;
  /** 选中单体的高亮色 */
  selectColor: string;
  /** 选中单体的高亮模式：'overlay' 叠加原图 | 'replace' 纯色覆盖 | 'multiply' 叠乘 | 'glowOnly' 仅描边发光 */
  selectMode?: SelectMode;
  /** 选中高亮叠色强度 / 透明度（0~1，默认 0.65） */
  selectOpacity?: number;
  /** 选中自发光强度（0~1，默认 0.35） */
  selectEmissive?: number;
  /** 选中单体垂直拔高高度（米，默认 0） */
  selectElevation?: number;
  /** 楼层估算层高（米） */
  floorHeight: number;
  /** 动态扫描速度倍率 */
  speed: number;
  /** 整体不透明度，< 1 时自动开启混合并关闭深度写入 */
  opacity: number;
  /** 'flat' 平面着色（白模更干净） | 'smooth' 平滑着色（倾斜摄影更自然） */
  shading: 'flat' | 'smooth';
  /** 选中单体时是否压暗其余建筑 */
  dimOthers: boolean;
  /** 未选中建筑压暗系数（0~1，默认 0.42） */
  dimFactor?: number;
  /** 是否给选中单体描边 */
  outline: boolean;
  /** 选中描边的画法：'edges' 单体棱线（默认）| 'hull' 背面外扩轮廓 */
  outlineStyle?: 'edges' | 'hull';
  /** 描边颜色（默认跟随 selectColor） */
  outlineColor?: string;
  /** 外扩轮廓的粗细（米，默认 0.9，仅 outlineStyle: 'hull' 生效） */
  outlineWidth?: number;
  /** 选中棱线的粗细（像素，默认 3，仅 outlineStyle: 'edges' 生效，缩放时保持恒定） */
  outlineWidthPx?: number;
  /** 是否显示几何棱线（CPU 端生成，有开销） */
  edges: boolean;
  /** 全局棱线粗细（像素，默认 1.2） */
  edgeWidth?: number;
  edgeColor: string;
  edgeOpacity?: number;
  roofThreshold?: number;
  /** 是否与模型原色贴图叠加混合（0 = 纯色覆盖，1 = 叠乘原色贴图） */
  texMix?: number;
  /** 半透明时是否保持深度写入（默认 true，保持写入可彻底遮挡背面与内部棱线，避免背面透出） */
  depthWrite?: boolean;
}

export const DEFAULT_STYLE: S3MStyle = {
  mode: STYLE.TEXTURE,
  colorA: '#dfe6ee',
  colorB: '#1d4ed8',
  colorC: '#fbbf24',
  selectColor: '#22d3ee',
  selectMode: SELECT_MODE.OVERLAY,
  selectOpacity: 0.65,
  selectEmissive: 0.35,
  selectElevation: 0,
  floorHeight: DEFAULT_FLOOR_HEIGHT,
  speed: 1,
  opacity: 1,
  shading: 'flat',
  dimOthers: true,
  dimFactor: 0.42,
  outline: true,
  outlineStyle: 'edges',
  outlineColor: '#22d3ee',
  outlineWidth: 0.9,
  outlineWidthPx: 3,
  edges: false,
  edgeWidth: 1.2,
  edgeColor: '#334155',
  edgeOpacity: 0.45,
  roofThreshold: 0.65,
  texMix: 0,
  depthWrite: true,
};

export interface S3MDatasetOptions {
  id: string;
  name?: string;
  configUrl: string;
  visible?: boolean;
  maxTiles?: number;
  /** 垂直高度偏移（米），正数抬升，负数下降，默认 0 */
  heightOffset?: number;
}

export interface S3MDatasetEntry {
  id: string;
  name: string;
  options: S3MDatasetOptions;
  root: THREE.Group;
  tileset: S3MTileset | null;
  anchor: Anchor | null;
  /** 垂直高度偏移（米） */
  heightOffset: number;
  /** 相对场景锚点的偏移（米） */
  offset: [number, number, number];
  visible: boolean;
  error: unknown;
}

export interface FeatureStyle {
  /** 自定义单体颜色 */
  color?: string;
  /** 自定义单体独立拔高高度（米） */
  elevation?: number;
  /** 自定义单体不透明度（0~1） */
  opacity?: number;
}

export interface S3MFilter {
  /** 白名单：仅显示指定 SMID，其余全部隐藏 */
  include?: number[];
  /** 黑名单：隐藏指定 SMID */
  exclude?: number[];
  /** 最小高度（米，相对场景高程），低于此高度的建筑隐藏 */
  minHeight?: number;
  /** 最大高度（米，相对场景高程），高于此高度的建筑隐藏 */
  maxHeight?: number;
  /** 自定义谓词函数过滤（基于建筑属性） */
  predicate?: (feature: FeatureAttributes & { smid: number | null }) => boolean;
}

export interface PickResult extends FeatureAttributes {
  datasetId: string;
  datasetName: string;
  /** 网格编号 */
  objectId: number;
  /** 单体编号，-1 表示该几何没有单体化信息 */
  batchId: number;
  skeletonName: string;
  /** 单体中心经纬度，拿不到时为 null */
  centerLngLat: [number, number] | null;
  mesh: THREE.Mesh;
}

export interface S3MLayerOptions {
  id?: string;
  /** 单数据集简写 */
  configUrl?: string;
  /** 多数据集 */
  datasets?: S3MDatasetOptions[];
  style?: Partial<S3MStyle>;
  pickable?: boolean;
  /** 每个数据集最多驻留瓦片 */
  maxTiles?: number;
  /** 每个数据集并发请求数 */
  maxConcurrent?: number;
  /** 自定义瓦片构建器（测试 / 服务端渲染时注入） */
  buildTile?: BuildTileFn | null;
  /**
   * 可选：业务属性查询配置（iServer 数据服务）。
   * 配上之后才能用 `colorByField()` 按业务字段着色 —— 属性值不在 S3M 瓦片里，只能去数据服务查。
   */
  attributes?: AttributeQueryOptions;
  onStats?: (stats: Stats) => void;
  onReady?: (entry: S3MDatasetEntry) => void;
  onPick?: (result: PickResult | null) => void;
  onError?: (error: unknown) => void;
}

/* ------------------------------------------------------------------ 专题着色 */

/** 按业务字段着色的选项 */
export interface ColorByFieldOptions {
  /** 字段名，如 ENTITYID / KEYID / SmMaxZ */
  field: string;
  /**
   * category —— 按不同取值分配颜色（默认）
   * ramp     —— 数值字段连续色带
   * breaks   —— 数值字段按 `breaks` 阈值分级
   */
  type?: 'category' | 'ramp' | 'breaks';
  /** 调色板 / 色带，至少 2 个颜色；不给就用内置的 12 色 */
  colors?: string[];
  /** breaks 模式的分级阈值（升序）。颜色数应 ≥ 阈值数 + 1 */
  breaks?: number[];
  /** 只给这些单体上色，默认取「当前已加载的全部单体」 */
  smids?: number[];
  /** 取值预处理，分类模式下很有用（比如取编码前 12 位做分组） */
  transform?: (value: string) => string;
  /** 手动固定某些取值的颜色，key 是 transform 之后的值 */
  colorMap?: Record<string, string>;
}

export interface ThematicLegendEntry {
  label: string;
  color: string;
  count: number;
}

/** 按业务字段过滤：条件之间是「与」，一个条件都不给就按「字段非空」算命中 */
export interface FieldFilterOptions {
  /** 字段名 */
  field: string;
  /** 数值区间（含端点），只对能转成数字的取值生效 */
  min?: number;
  /** 数值区间上界 */
  max?: number;
  /** 取值白名单，按 `String(value)` 比较（编码类字段用它做精确匹配） */
  values?: Array<string | number>;
  /** 自定义判断，返回 true 表示命中 */
  keep?: (value: string | number | null, row: AttributeRow) => boolean;
  /** `keep`（默认）只显示命中的单体；`hide` 隐藏命中的单体 */
  mode?: 'keep' | 'hide';
  /** 查询范围，默认取「当前已加载的全部单体」 */
  smids?: number[];
  /** 查不到属性值的单体：`keep`（默认，保留）或 `hide` */
  onMissing?: 'keep' | 'hide';
}

export interface FieldFilterResult {
  field: string;
  mode: 'keep' | 'hide';
  /** 参与判断的单体数 */
  total: number;
  /** 命中条件的单体数 */
  matched: number;
  /** 查不到属性值的单体数 */
  missing: number;
  /** 最终被隐藏的单体 ID */
  hidden: number[];
}

/** 按业务字段抬高：抬高 = 字段值 × scale + offset（米），也可用 map 自定义 */
export interface FieldElevationOptions {
  /** 数值字段名 */
  field: string;
  /** 米 / 字段单位，默认 1（即字段值直接当米） */
  scale?: number;
  /** 基础偏移（米），默认 0 */
  offset?: number;
  /** 抬高上限（米），超出按上限算 */
  max?: number;
  /** 自定义映射，第二参数是该字段在当前范围内的 min / max */
  map?: (value: number, range: { min: number; max: number }) => number;
  /** 只抬这些单体，默认取「当前已加载的全部单体」 */
  smids?: number[];
}

export interface FieldElevationResult {
  field: string;
  /** 真正抬起来的单体数 */
  matched: number;
  /** 字段值不是数字、跳过的单体数 */
  missing: number;
  /** 该字段在当前范围内的最小 / 最大值 */
  min: number;
  max: number;
  /** 实际最大抬高（米） */
  appliedMax: number;
}

export interface ThematicResult {
  field: string;
  /** 真正上了色的单体数 */
  matched: number;
  /** 查不到属性值的单体数 */
  missing: number;
  legend: ThematicLegendEntry[];
}

/** 分类模式的默认调色板（色相拉开，深浅接近） */
const DEFAULT_THEMATIC_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#06b6d4',
  '#84cc16',
  '#ec4899',
  '#6366f1',
  '#14b8a6',
  '#f97316',
  '#64748b',
];

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

/** 在色带上取 t（0~1）位置的颜色，多段线性插值 */
function sampleRamp(stops: THREE.Color[], t: number): THREE.Color {
  if (stops.length < 2) return stops[0].clone();
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  return stops[i].clone().lerp(stops[i + 1], scaled - i);
}

/** 按字段值判断是否命中过滤条件（各条件之间是「与」） */
function matchFieldValue(
  value: string | number | null,
  row: AttributeRow,
  options: FieldFilterOptions
): boolean {
  if (options.keep && !options.keep(value, row)) return false;
  if (options.values?.length) {
    const text = value == null ? '' : String(value);
    if (!options.values.some((v) => String(v) === text)) return false;
  }
  if (options.min != null || options.max != null) {
    const num = Number(value);
    if (!Number.isFinite(num)) return false;
    if (options.min != null && num < options.min) return false;
    if (options.max != null && num > options.max) return false;
  }
  // 一个条件都没给：字段非空就算命中
  if (!options.keep && !options.values?.length && options.min == null && options.max == null) {
    return value != null && String(value) !== '';
  }
  return true;
}

/** 图例上的数值：够用就好，别出现 60.390098571777344 */
function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/* ------------------------------------------------------------------ 图层 */

export class S3MLayer {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  readonly options: S3MLayerOptions;
  readonly pickable: boolean;
  onStats: (stats: Stats) => void;
  onReady: (entry: S3MDatasetEntry) => void;
  onPick: (result: PickResult | null) => void;
  onError: (error: unknown) => void;

  map: MapLike | null = null;
  renderer: THREE.WebGLRenderer | null = null;
  scene: THREE.Scene | null = null;
  camera: THREE.Camera | null = null;
  sceneAnchor: { x: number; y: number; z: number; meterInMercator: number } | null = null;
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

  readonly datasets = new Map<string, S3MDatasetEntry>();

  private readonly _pickables = new Map<number, PickableRef>();
  private _pickSeq = 0;
  private _selection: PickResult | null = null;
  private _outlineMesh: THREE.Mesh | null = null;
  private _selectionEdges: THREE.Mesh | null = null;
  private _edgesEnabled = false;

  private readonly _featureStyles = new Map<number, FeatureStyle>();

  /** 业务属性查询（可选，配了 `attributes` 才有） */
  attributeQuery: AttributeQuery | null = null;
  /** 专题着色：SMID → 颜色（手动 featureStyle 的颜色优先级更高） */
  private _thematic = new Map<number, string>();
  private _thematicField: string | null = null;
  private _thematicElevation = new Map<number, number>();
  private _elevationField: string | null = null;
  private _fieldFilter: { field: string; mode: 'keep' | 'hide'; matched: Set<number> } | null = null;
  private _filter: S3MFilter | null = null;
  private readonly _meshBatchTextures = new WeakMap<
    THREE.Mesh,
    { texture: THREE.DataTexture; data: Float32Array; width: number }
  >();

  private readonly _enuMatrix = new THREE.Matrix4();
  private _needsRepaint = true;
  private _frame = 0;
  private readonly _fps = { value: 0, last: 0 };
  private _keyLight: THREE.DirectionalLight | null = null;
  private _fillLight: THREE.DirectionalLight | null = null;

  private readonly _datasetQueue: S3MDatasetOptions[];

  constructor(options: S3MLayerOptions = {}) {
    this.id = options.id ?? 's3m';
    this.options = options;
    this.pickable = options.pickable !== false;
    this.onStats = options.onStats ?? (() => {});
    this.onReady = options.onReady ?? (() => {});
    this.onPick = options.onPick ?? (() => {});
    this.onError = options.onError ?? ((e) => console.warn('[s3m]', e));

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

    this._fps.last = performance.now();
    this._datasetQueue = this._normalizeDatasets(options);
    if (options.attributes) this.attributeQuery = new AttributeQuery(options.attributes);
  }

  /* ---------------------------------------------------------------- 生命周期 */

  onAdd(map: MapLike, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl as WebGLRenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);
    // 白模 albedo 接近 1，不做色调映射会过曝成一片纯白、丢失明暗关系
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this._addLights();

    this.camera = new THREE.Camera();
    this.camera.matrixAutoUpdate = false;

    this.picker = new Picker(this.renderer);

    this._applyStyleUniforms();
    for (const ds of this._datasetQueue) void this.addDataset(ds).catch((e) => this.onError(e));

    map.on('click', this._onClick);
  }

  onRemove(): void {
    this.map?.off('click', this._onClick);
    for (const id of [...this.datasets.keys()]) this.removeDataset(id);
    this.picker?.dispose();
    this.picker = null;
    this.outlineMaterial.dispose();
    this.edgeMaterial.dispose();
    this.selectionEdgeMaterial.dispose();
    this.scene?.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  private _addLights(): void {
    if (!this.scene) return;
    // 环境光与天光打底，保证背光面和折叠处不死黑
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb6c0cb, 0.8));
    // 主光 / 补光的方向每帧按地图朝向重算（见 _updateLights），
    // 这样旋转视角时白模始终是亮的，不会转到背光面就一片死灰。
    this._keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this._fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
    this.scene.add(this._keyLight, this._fillLight);
  }

  /**
   * 让光照跟着地图朝向走：主光在镜头后上方偏左，补光在后上方偏右。
   * 相当于一盏头灯，看到的立面永远是受光面。
   */
  private _updateLights(): void {
    const bearing = ((this.map?.getBearing?.() ?? 0) * Math.PI) / 180;
    const place = (light: THREE.DirectionalLight | null, azOffsetDeg: number, elevDeg: number): void => {
      if (!light) return;
      const az = bearing + (azOffsetDeg * Math.PI) / 180;
      const el = (elevDeg * Math.PI) / 180;
      const c = Math.cos(el);
      light.position.set(Math.sin(az) * c, Math.cos(az) * c, Math.sin(el)).multiplyScalar(1000);
    };
    place(this._keyLight, 150, 50);
    place(this._fillLight, 215, 30);
  }

  /* ---------------------------------------------------------------- 数据集 */

  private _normalizeDatasets(options: S3MLayerOptions): S3MDatasetOptions[] {
    if (Array.isArray(options.datasets)) return options.datasets.filter((d) => !!d?.configUrl);
    if (options.configUrl) return [{ id: 'default', name: '默认数据集', configUrl: options.configUrl }];
    return [];
  }

  /** 追加一个数据集。图层 addLayer 之前调用会抛错。 */
  async addDataset(ds: S3MDatasetOptions): Promise<S3MDatasetEntry> {
    if (!this.scene) throw new Error('[s3m] 图层尚未 addLayer，不能添加数据集');
    const existing = this.datasets.get(ds.id);
    if (existing) return existing;

    const root = new THREE.Group();
    root.name = `s3m-dataset:${ds.id}`;
    root.visible = ds.visible !== false;
    this.scene.add(root);

    const entry: S3MDatasetEntry = {
      id: ds.id,
      name: ds.name ?? ds.id,
      options: ds,
      root,
      tileset: null,
      anchor: null,
      heightOffset: ds.heightOffset ?? 0,
      offset: [0, 0, 0],
      visible: ds.visible !== false,
      error: null,
    };
    this.datasets.set(ds.id, entry);

    const tileset = new S3MTileset({
      configUrl: ds.configUrl,
      maxTiles: ds.maxTiles ?? this.options.maxTiles ?? 64,
      maxConcurrent: this.options.maxConcurrent ?? 4,
      buildTile: this.options.buildTile ?? null,
      uniforms: this.uniforms,
      onTile: (node) => {
        this._registerTile(node, entry);
        this.onStats(this.stats);
        this._needsRepaint = true;
        this.map?.triggerRepaint();
      },
      onProgress: () => {
        this.onStats(this.stats);
        this.map?.triggerRepaint();
      },
      onError: (e) => {
        entry.error = e;
        this.onError(e);
        this.onStats(this.stats);
      },
    });
    entry.tileset = tileset;

    try {
      await tileset.init();
    } catch (e) {
      entry.error = e;
      this.onError(e);
      return entry;
    }

    entry.anchor = tileset.anchor;
    this._layoutDataset(entry);
    this.onReady(entry);
    this.map?.triggerRepaint();
    return entry;
  }

  /** 数据集锚点对齐到场景锚点，并应用垂直高程偏移 */
  private _layoutDataset(entry: S3MDatasetEntry): void {
    if (!entry.anchor) return;
    if (!this.sceneAnchor) {
      this.sceneAnchor = mercatorFromLngLat(entry.anchor.lon, entry.anchor.lat, entry.anchor.height ?? 0);
    }
    const s = this.sceneAnchor.meterInMercator;
    const a = mercatorFromLngLat(entry.anchor.lon, entry.anchor.lat, entry.anchor.height ?? 0);
    entry.offset = [
      (a.x - this.sceneAnchor.x) / s,
      -(a.y - this.sceneAnchor.y) / s,
      (a.z - this.sceneAnchor.z) / s + (entry.heightOffset ?? 0),
    ];
    entry.root.position.set(entry.offset[0], entry.offset[1], entry.offset[2]);
    entry.root.updateMatrixWorld(true);
  }

  /**
   * 获取指定数据集的垂直高程偏移（米）。
   * 若不传 id，默认获取第一个（或默认）数据集的高程偏移。
   */
  getDatasetHeight(id?: string): number {
    const targetId = id ?? this.datasets.keys().next().value;
    return targetId ? this.datasets.get(targetId)?.heightOffset ?? 0 : 0;
  }

  /**
   * 设置指定数据集的垂直高程偏移（米），正数抬升，负数下降。
   * 支持调用形式：
   *   layer.setDatasetHeight(15.0)              // 针对当前第一个/默认数据集
   *   layer.setDatasetHeight('datasetId', 15.0)  // 针对指定数据集
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
    const entry = this.datasets.get(id);
    if (!entry) return;
    entry.heightOffset = h;
    this._layoutDataset(entry);
    this.map?.triggerRepaint();
  }

  /* ---------------------------------------------------------------- 单体自定义样式 & 过滤 */

  /**
   * 为指定单体（SMID）设置独立自定义样式（颜色、拔高、透明度）。
   * 即使点击选中其他建筑，此单体的独立样式依然持久保留。
   */
  setFeatureStyle(smid: number, style: FeatureStyle): void {
    this._featureStyles.set(smid, style);
    this._applyOverridesToAllMeshes();
    if (this._selection) this._syncSelectionStyle();
    this.map?.triggerRepaint();
  }

  /** 批量为多个单体设置样式 */
  setFeaturesStyle(smids: number[], style: FeatureStyle): void {
    for (const smid of smids) {
      this._featureStyles.set(smid, style);
    }
    this._applyOverridesToAllMeshes();
    if (this._selection) this._syncSelectionStyle();
    this.map?.triggerRepaint();
  }

  /** 获取指定单体的自定义样式 */
  getFeatureStyle(smid: number): FeatureStyle | null {
    return this._featureStyles.get(smid) ?? null;
  }

  /** 获取所有自定义样式的单体映射表 */
  getFeatureStyles(): Map<number, FeatureStyle> {
    return new Map(this._featureStyles);
  }

  /** 移除指定单体的自定义样式，恢复为图层全局样式 */
  removeFeatureStyle(smid: number): void {
    if (this._featureStyles.delete(smid)) {
      this._applyOverridesToAllMeshes();
      if (this._selection) this._syncSelectionStyle();
      this.map?.triggerRepaint();
    }
  }

  /** 清空所有单体的自定义样式 */
  clearFeatureStyles(): void {
    if (this._featureStyles.size > 0) {
      this._featureStyles.clear();
      this._applyOverridesToAllMeshes();
      if (this._selection) this._syncSelectionStyle();
      this.map?.triggerRepaint();
    }
  }

  /* ---------------------------------------------------------------- 按业务字段着色 */

  /**
   * 换一个业务属性数据源（或传 null 关掉）。
   * 属性值不在 S3M 瓦片里，得去 iServer 数据服务查，所以必须先有这一层配置。
   */
  setAttributeSource(options: AttributeQueryOptions | null): void {
    this.attributeQuery = options ? new AttributeQuery(options) : null;
  }

  /** 当前场景里已经加载的单体 ID（按 SMID 去重），也是 colorByField 的默认范围 */
  getLoadedSmids(): number[] {
    const out = new Set<number>();
    for (const p of this._pickables.values()) {
      const pickInfo = (p.mesh.userData as MeshUserData).geoRef?.pickInfo;
      if (!pickInfo) continue;
      for (const key of Object.keys(pickInfo)) {
        const smid = Number(key);
        if (Number.isFinite(smid) && smid >= 0) out.add(smid);
      }
    }
    return [...out];
  }

  /** 当前专题着色用的字段名 */
  getThematicField(): string | null {
    return this._thematicField;
  }

  /**
   * 直接塞一份 SMID → 颜色。已经有属性值（或想按几何派生量自己算色）时用这个，
   * 不走网络。
   */
  setThematicColors(colors: Map<number, string> | null, field = 'custom'): void {
    this._thematic = colors && colors.size > 0 ? new Map(colors) : new Map();
    this._thematicField = this._thematic.size > 0 ? field : null;
    this._applyOverridesToAllMeshes();
    this.map?.triggerRepaint();
  }

  clearThematic(): void {
    if (this._thematic.size === 0 && !this._thematicField) return;
    this._thematic = new Map();
    this._thematicField = null;
    this._applyOverridesToAllMeshes();
    this.map?.triggerRepaint();
  }

  /* ---------------------------------------------------------------- 按业务字段过滤 / 抬高 */

  /** 当前过滤用的业务字段 */
  getFilterField(): string | null {
    return this._fieldFilter?.field ?? null;
  }

  /**
   * 按业务字段过滤单体。
   *
   * 命中的单体集合会记下来参与渲染：`keep` 模式下不在集合里的单体直接不画（顶点被压到原点，
   * 也不参与拾取）；`hide` 模式反之。和 `setFilter()` 是叠加关系（两个都满足才显示）。
   */
  async filterByField(options: FieldFilterOptions): Promise<FieldFilterResult> {
    const query = this.attributeQuery;
    if (!query) {
      throw new Error('[s3m] 未配置业务属性数据源，先调用 setAttributeSource() 或构造时传 attributes');
    }

    const all = options.smids?.length ? [...new Set(options.smids)] : this.getLoadedSmids();
    const mode = options.mode ?? 'keep';
    const onMissing = options.onMissing ?? 'keep';
    const result: FieldFilterResult = {
      field: options.field,
      mode,
      total: all.length,
      matched: 0,
      missing: 0,
      hidden: [],
    };
    if (!all.length) {
      this._fieldFilter = null;
      return result;
    }

    const rows: Map<number, AttributeRow> = await query.queryBySmids(all);
    const matched = new Set<number>();
    for (const smid of all) {
      const row = rows.get(smid);
      if (!row) {
        result.missing++;
        if (onMissing === 'keep') matched.add(smid);
        continue;
      }
      if (matchFieldValue(row[options.field] ?? null, row, options)) matched.add(smid);
    }
    result.matched = matched.size;

    this._fieldFilter = matched.size || mode === 'keep' ? { field: options.field, mode, matched } : null;
    result.hidden = all.filter((smid) => (mode === 'keep' ? !matched.has(smid) : matched.has(smid)));

    this._applyOverridesToAllMeshes();
    if (this._selection) this._syncSelectionStyle();
    this.map?.triggerRepaint();
    return result;
  }

  /** 清除业务字段过滤（不影响 setFilter 的规则） */
  clearFieldFilter(): void {
    if (!this._fieldFilter) return;
    this._fieldFilter = null;
    this._applyOverridesToAllMeshes();
    this.map?.triggerRepaint();
  }

  /** 当前抬高用的业务字段 */
  getElevationField(): string | null {
    return this._elevationField;
  }

  /**
   * 按业务字段抬高单体。
   *
   * 抬高量写进每网格的单体状态纹理（第四通道），顶点着色器里加到 z 上，
   * 所以只影响显示、不改几何：换字段/改系数都是重写一张一维纹理。
   */
  async elevateByField(options: FieldElevationOptions): Promise<FieldElevationResult> {
    const query = this.attributeQuery;
    if (!query) {
      throw new Error('[s3m] 未配置业务属性数据源，先调用 setAttributeSource() 或构造时传 attributes');
    }

    const all = options.smids?.length ? [...new Set(options.smids)] : this.getLoadedSmids();
    const empty: FieldElevationResult = {
      field: options.field,
      matched: 0,
      missing: all.length,
      min: 0,
      max: 0,
      appliedMax: 0,
    };
    if (!all.length) {
      this._thematicElevation = new Map();
      this._elevationField = null;
      this._applyOverridesToAllMeshes();
      return empty;
    }

    const rows: Map<number, AttributeRow> = await query.queryBySmids(all);
    const numeric = new Map<number, number>();
    for (const smid of all) {
      const value = Number(rows.get(smid)?.[options.field]);
      if (Number.isFinite(value)) numeric.set(smid, value);
    }
    if (numeric.size === 0) {
      this._thematicElevation = new Map();
      this._elevationField = null;
      this._applyOverridesToAllMeshes();
      this.map?.triggerRepaint();
      return empty;
    }

    const values = [...numeric.values()];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const scale = options.scale ?? 1;
    const offset = options.offset ?? 0;
    const next = new Map<number, number>();
    let appliedMax = 0;
    for (const [smid, value] of numeric) {
      let height = options.map ? options.map(value, { min, max }) : value * scale + offset;
      if (!Number.isFinite(height)) continue;
      if (options.max != null && height > options.max) height = options.max;
      // 负值等于往下压，没有实际意义，当没抬高处理
      if (height <= 0) continue;
      next.set(smid, height);
      if (height > appliedMax) appliedMax = height;
    }

    this._thematicElevation = next;
    this._elevationField = options.field;
    this._applyOverridesToAllMeshes();
    this.map?.triggerRepaint();

    return {
      field: options.field,
      matched: next.size,
      missing: all.length - numeric.size,
      min,
      max,
      appliedMax,
    };
  }

  /**
   * 直接塞一份 SMID → 抬高米数（已经算好、或不走网络时用这个）。
   * 传 null 复位。
   */
  setThematicElevation(elevations: Map<number, number> | null, field = 'custom'): void {
    this._thematicElevation =
      elevations && elevations.size > 0 ? new Map([...elevations].filter(([, h]) => Number.isFinite(h) && h > 0)) : new Map();
    this._elevationField = this._thematicElevation.size > 0 ? field : null;
    this._applyOverridesToAllMeshes();
    this.map?.triggerRepaint();
  }

  clearThematicElevation(): void {
    if (this._thematicElevation.size === 0) return;
    this._thematicElevation = new Map();
    this._elevationField = null;
    this._applyOverridesToAllMeshes();
    this.map?.triggerRepaint();
  }

  /**
   * 按业务字段给单体上色。
   *
   * 流程：已加载单体 ID → 数据服务取字段值 → 值映射成颜色 → 写进每网格的 batch 纹理。
   * 颜色是逐单体写进现有 override 通道的，不重建几何、不重编译着色器，改字段就是重写一张一维纹理。
   */
  async colorByField(options: ColorByFieldOptions): Promise<ThematicResult> {
    const query = this.attributeQuery;
    if (!query) {
      throw new Error('[s3m] 未配置业务属性数据源，先调用 setAttributeSource() 或构造时传 attributes');
    }

    const smids = options.smids?.length ? options.smids : this.getLoadedSmids();
    const empty: ThematicResult = { field: options.field, matched: 0, missing: 0, legend: [] };
    if (!smids.length) return empty;

    const rows: Map<number, AttributeRow> = await query.queryBySmids(smids);
    const palette = (options.colors?.length ? options.colors : DEFAULT_THEMATIC_COLORS).map(
      (c) => new THREE.Color(c)
    );
    const stops = palette.length > 1 ? palette : [palette[0], palette[0]];
    const type = options.type ?? 'category';
    const colors = new Map<number, string>();
    const legend: ThematicLegendEntry[] = [];

    if (type === 'category') {
      const transform = options.transform ?? ((v: string) => v);
      const counts = new Map<string, number>();
      const keyOf = new Map<number, string>();
      for (const [smid, row] of rows) {
        const raw = row[options.field];
        if (raw == null || String(raw) === '') continue;
        const key = transform(String(raw));
        keyOf.set(smid, key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      // 取值多的排前面，颜色分配稳定：同样的取值永远同一个颜色
      const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const colorOf = new Map<string, string>();
      ordered.forEach(([key, count], i) => {
        const color = options.colorMap?.[key] ?? `#${stops[i % stops.length].getHexString()}`;
        colorOf.set(key, color);
        legend.push({ label: key, color, count });
      });
      for (const [smid, key] of keyOf) {
        const color = colorOf.get(key);
        if (color) colors.set(smid, color);
      }
    } else {
      const numeric = new Map<number, number>();
      for (const [smid, row] of rows) {
        const value = Number(row[options.field]);
        if (Number.isFinite(value)) numeric.set(smid, value);
      }
      if (numeric.size === 0) {
        this._thematic = new Map();
        this._thematicField = null;
        this._applyOverridesToAllMeshes();
        this.map?.triggerRepaint();
        return { field: options.field, matched: 0, missing: smids.length, legend: [] };
      }

      const values = [...numeric.values()];
      const min = Math.min(...values);
      const max = Math.max(...values);

      if (type === 'breaks') {
        // 没给阈值就按色带档数等分，5 段
        const segmentCount = Math.max(2, options.breaks?.length ? options.breaks.length + 1 : Math.min(stops.length, 5));
        const breaks =
          options.breaks?.length
            ? options.breaks
            : Array.from({ length: segmentCount - 1 }, (_, i) => min + ((max - min) * (i + 1)) / segmentCount);
        const counts = new Array(segmentCount).fill(0) as number[];
        for (const [smid, value] of numeric) {
          let idx = 0;
          while (idx < breaks.length && value > breaks[idx]) idx++;
          counts[idx]++;
          colors.set(smid, `#${stops[Math.min(idx, stops.length - 1)].getHexString()}`);
        }
        for (let i = 0; i < segmentCount; i++) {
          const lo = i === 0 ? min : breaks[i - 1];
          const hi = i === segmentCount - 1 ? max : breaks[i];
          legend.push({
            label: `${formatNumber(lo)} ~ ${formatNumber(hi)}`,
            color: `#${stops[Math.min(i, stops.length - 1)].getHexString()}`,
            count: counts[i],
          });
        }
      } else {
        const steps = 5;
        for (const [smid, value] of numeric) {
          const t = max - min < 1e-9 ? 0.5 : (value - min) / (max - min);
          colors.set(smid, `#${sampleRamp(stops, t).getHexString()}`);
        }
        for (let i = 0; i < steps; i++) {
          const t = i / (steps - 1);
          legend.push({
            label: formatNumber(min + (max - min) * t),
            color: `#${sampleRamp(stops, t).getHexString()}`,
            count: 0,
          });
        }
      }
    }

    this._thematic = colors;
    this._thematicField = options.field;
    this._applyOverridesToAllMeshes();
    this.map?.triggerRepaint();

    return {
      field: options.field,
      matched: colors.size,
      missing: smids.length - colors.size,
      legend,
    };
  }

  /**
   * 设置图层过滤规则。
   * 支持按 SMID 白名单（include）、黑名单（exclude）、高度范围（minHeight/maxHeight）或谓词函数过滤。
   * 被过滤隐藏的建筑不渲染、不参与深度测试、鼠标无法拾取。
   */
  setFilter(filter: S3MFilter | null): void {
    this._filter = filter;
    if (filter && (filter.minHeight != null || filter.maxHeight != null)) {
      if (this.uniforms.uFilterMinZ) this.uniforms.uFilterMinZ.value = filter.minHeight ?? -99999;
      if (this.uniforms.uFilterMaxZ) this.uniforms.uFilterMaxZ.value = filter.maxHeight ?? 99999;
      if (this.uniforms.uFilterHeightActive) this.uniforms.uFilterHeightActive.value = 1;
    } else if (this.uniforms.uFilterHeightActive) {
      this.uniforms.uFilterHeightActive.value = 0;
    }
    this._applyOverridesToAllMeshes();
    if (this._selection) this._syncSelectionStyle();
    this.map?.triggerRepaint();
  }

  /** 获取当前生效的过滤规则 */
  getFilter(): S3MFilter | null {
    return this._filter;
  }

  /** 清除过滤规则，恢复全量建筑显示 */
  clearFilter(): void {
    this.setFilter(null);
  }

  private _isFeatureHidden(smid: number | null, _batchId: number): boolean {
    if (smid != null && this._fieldFilter) {
      const inSet = this._fieldFilter.matched.has(smid);
      if (this._fieldFilter.mode === 'keep' ? !inSet : inSet) return true;
    }
    if (!this._filter) return false;
    if (smid != null) {
      if (this._filter.include && this._filter.include.length > 0 && !this._filter.include.includes(smid)) {
        return true;
      }
      if (this._filter.exclude && this._filter.exclude.length > 0 && this._filter.exclude.includes(smid)) {
        return true;
      }
    }
    return false;
  }

  private _applyOverridesToMesh(mesh: THREE.Mesh): void {
    const mat = styledMaterialOf(mesh);
    if (!mat) return;

    const ud = mesh.userData as MeshUserData;
    const pickInfo = ud.geoRef?.pickInfo;

    const hasStyles =
      this._featureStyles.size > 0 || this._thematic.size > 0 || this._thematicElevation.size > 0;
    const filter = this._filter;
    const hasFilter =
      this._fieldFilter != null ||
      (filter != null &&
        ((filter.include?.length ?? 0) > 0 ||
          (filter.exclude?.length ?? 0) > 0 ||
          filter.predicate != null));

    if (!hasStyles && !hasFilter) {
      if (mat.userData.uBatchTexActive) {
        mat.userData.uBatchTexActive.value = 0;
      }
      return;
    }

    if (!pickInfo || Object.keys(pickInfo).length === 0) {
      if (mat.userData.uBatchTexActive) {
        mat.userData.uBatchTexActive.value = 0;
      }
      return;
    }

    let maxBatch = 0;
    for (const p of Object.values(pickInfo)) {
      if (p.batchId != null && p.batchId > maxBatch) maxBatch = p.batchId;
    }
    const width = Math.max(maxBatch + 1, 1);

    let record = this._meshBatchTextures.get(mesh);
    if (!record || record.width < width) {
      const data = new Float32Array(width * 4);
      const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat, THREE.FloatType);
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      record = { texture, data, width };
      this._meshBatchTextures.set(mesh, record);
      mat.userData.uBatchTex.value = texture;
      mat.userData.uBatchTexWidth.value = width;
    }

    const { data, texture } = record;
    // 默认值：[-1, -1, -1, 0]（无自定义色，无抬升，不隐藏）
    data.fill(-1);
    for (let i = 0; i < record.width; i++) {
      data[i * 4 + 3] = 0;
    }

    let hasActive = false;
    for (const [smidStr, entry] of Object.entries(pickInfo)) {
      const smid = Number(smidStr);
      const bId = entry.batchId;
      if (bId == null || bId < 0 || bId >= record.width) continue;

      let hidden = false;
      if (filter) {
        if (filter.include && filter.include.length > 0 && !filter.include.includes(smid)) {
          hidden = true;
        }
        if (filter.exclude && filter.exclude.length > 0 && filter.exclude.includes(smid)) {
          hidden = true;
        }
        if (filter.predicate) {
          const { segments } = resolveFeature(ud.geoRef, bId);
          const box = measureSegments(mesh.geometry, segments);
          const attrs = buildAttributes({ smid, box, triangles: 0, floorHeight: this.style.floorHeight });
          if (!filter.predicate({ ...attrs, smid })) {
            hidden = true;
          }
        }
      }

      if (hidden) {
        data[bId * 4 + 3] = -1.0; // 标记隐藏
        hasActive = true;
        continue;
      }

      // 业务字段过滤：和 setFilter 叠加，两个都放行才显示
      if (this._fieldFilter) {
        const inSet = this._fieldFilter.matched.has(smid);
        if (this._fieldFilter.mode === 'keep' ? !inSet : inSet) {
          data[bId * 4 + 3] = -1.0;
          hasActive = true;
          continue;
        }
      }

      const st = this._featureStyles.get(smid);
      const thematicColor = this._thematic.get(smid);
      // 手动固定色 > 专题色（按业务字段）
      const colorHex = st?.color ?? thematicColor;
      // 手动拔高 > 按业务字段抬高
      const elevation = st?.elevation ?? this._thematicElevation.get(smid);
      if (st || thematicColor || elevation != null) {
        hasActive = true;
        if (colorHex) {
          const c = new THREE.Color(colorHex);
          data[bId * 4 + 0] = c.r;
          data[bId * 4 + 1] = c.g;
          data[bId * 4 + 2] = c.b;
        }
        if (elevation != null && elevation > 0) {
          data[bId * 4 + 3] = elevation;
        }
      }
    }

    texture.needsUpdate = true;
    mat.userData.uBatchTexActive.value = hasActive ? 1 : 0;
  }

  private _applyOverridesToAllMeshes(): void {
    for (const p of this._pickables.values()) {
      this._applyOverridesToMesh(p.mesh);
    }
  }

  removeDataset(id: string): void {
    const entry = this.datasets.get(id);
    if (!entry) return;
    if (this._selection?.datasetId === id) this.select(null);
    entry.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const styled = styledMaterialOf(mesh);
      if (styled) styled.dispose();
    });
    entry.tileset?.dispose();
    this.scene?.remove(entry.root);
    for (const [pickId, p] of this._pickables) if (p.datasetId === id) this._pickables.delete(pickId);
    this.datasets.delete(id);
    if (this.datasets.size === 0) {
      this.sceneAnchor = null;
    }
    this.onStats(this.stats);
    this.map?.triggerRepaint();
  }

  /** 清空当前所有数据集 */
  clearDatasets(): void {
    for (const id of [...this.datasets.keys()]) this.removeDataset(id);
    this.sceneAnchor = null;
  }

  setDatasetVisible(id: string, visible: boolean): void {
    const entry = this.datasets.get(id);
    if (!entry) return;
    entry.visible = visible;
    entry.root.visible = visible;
    if (!visible && this._selection?.datasetId === id) this.select(null);
    this.map?.triggerRepaint();
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

      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      const ud = mesh.userData as MeshUserData;
      ud.pickId = this._pickSeq++;
      ud.datasetId = entry.id;
      ud.nativeEdges = hasNativeEdges;
      this._pickables.set(ud.pickId, {
        datasetId: entry.id,
        mesh,
        tile: node.tile,
        skeletonName: ud.skeletonName ?? '',
      });
      if (this._edgesEnabled && !hasNativeEdges) this._ensureEdges(mesh);

      // 新瓦片要继承当前的不透明度与着色方式
      const mat = styledMaterialOf(mesh);
      if (mat) {
        const o = Math.min(1, Math.max(0.05, this.style.opacity ?? 1));
        mat.opacity = o;
        mat.transparent = o < 0.999;
        mat.depthWrite = o >= 0.999;
        mat.flatShading = this.style.shading !== 'smooth';
        mat.needsUpdate = true;
        this._applyOverridesToMesh(mesh);
      }
    }
    this._refreshHeightRange();
  }

  /* ---------------------------------------------------------------- 样式 */

  /** 合并并应用样式。只改 uniform 的项不会触发几何/着色器重建。 */
  setStyle(patch: Partial<S3MStyle> = {}): void {
    this.style = { ...this.style, ...patch };
    this._applyStyleUniforms();
    if ('opacity' in patch || 'depthWrite' in patch) this._applyOpacity();
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
    this.map?.triggerRepaint();
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
      const m = styledMaterialOf(p.mesh);
      if (!m) continue;
      m.opacity = o;
      m.transparent = transparent;
      m.depthWrite = transparent ? keepDepth : true;
    }
    this.map?.triggerRepaint();
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
    this.map?.triggerRepaint();
  }

  private _refreshHeightRange(): void {
    let min = Infinity;
    let max = -Infinity;
    for (const p of this._pickables.values()) {
      const bb = p.mesh.geometry?.boundingBox;
      if (!bb) continue;
      const box = bb.clone().applyMatrix4(p.mesh.matrixWorld);
      if (box.min.z < min) min = box.min.z;
      if (box.max.z > max) max = box.max.z;
    }
    if (!isFinite(min) || !isFinite(max) || max <= min) {
      min = 0;
      max = 100;
    }
    this.uniforms.uHeightMin.value = min;
    this.uniforms.uHeightMax.value = max;
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
      this.map?.triggerRepaint();
      return;
    }

    const pending = [...this._pickables.values()]
      .map((p) => p.mesh)
      .filter((m) => {
        const ud = m.userData as MeshUserData;
        return !ud.edges && !ud.nativeEdges;
      });
    let i = 0;
    const step = (): void => {
      const t0 = performance.now();
      while (i < pending.length && performance.now() - t0 < 8) this._ensureEdges(pending[i++]);
      if (i < pending.length) setTimeout(step, 0);
      else this.map?.triggerRepaint();
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

  private _onClick = (e: MapMouseEventLike): void => {
    if (!this.pickable) return;
    const hit = this.pickFromEvent(e);
    if (!hit) {
      this.select(null);
      return;
    }
    this.select(hit);
    this.onPick(hit);
  };

  /** 事件对象（宿主 MouseEvent 或原生事件）→ 拾取结果 */
  pickFromEvent(e: MapMouseEventLike | MouseEvent): PickResult | null {
    const canvas = this.map?.getCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const oe = (e as MapMouseEventLike).originalEvent ?? (e as MouseEvent);
    return this.pick(oe.clientX - rect.left, oe.clientY - rect.top);
  }

  /** 按 canvas 左上角的 CSS 像素坐标拾取。 */
  pick(x: number, y: number): PickResult | null {
    if (!this.picker || !this.scene || !this.camera || !this.sceneAnchor) return null;
    const hit = this.picker.pick(this.scene, this.camera, x, y);
    if (!hit) return null;

    const ref = this._pickables.get(hit.objectId);
    if (!ref) return null;

    const ud = ref.mesh.userData as MeshUserData;
    const geoRef = (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(hit.batchId) ?? ud.geoRef;
    const { smid, segments } = resolveFeature(geoRef, hit.batchId);
    if (this._isFeatureHidden(smid, hit.batchId)) return null;
    const box = measureSegments(ref.mesh.geometry, segments);
    const geometry = ref.mesh.geometry;
    const triangles = geometry.index ? Math.round(geometry.index.count / 3) : 0;
    const attributes = buildAttributes({ smid, box, triangles, floorHeight: this.style.floorHeight });

    // 单体中心（场景 ENU 米）→ 经纬度
    let centerLngLat: [number, number] | null = null;
    if (box) {
      const v = new THREE.Vector3((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2);
      v.applyMatrix4(ref.mesh.matrixWorld);
      const s = this.sceneAnchor.meterInMercator;
      centerLngLat = lngLatFromMercator(v.x * s + this.sceneAnchor.x, -v.y * s + this.sceneAnchor.y);
    }

    return {
      datasetId: ref.datasetId,
      datasetName: this.datasets.get(ref.datasetId)?.name ?? ref.datasetId,
      objectId: hit.objectId,
      batchId: hit.batchId,
      skeletonName: ref.skeletonName,
      centerLngLat,
      ...attributes,
      mesh: ref.mesh,
    };
  }

  /** 选中/取消选中单体。`silent` 为 true 时不回调 onPick。 */
  select(result: PickResult | null, { silent = false }: { silent?: boolean } = {}): void {
    // 清掉上一次
    if (this._selection) {
      const prev = styledMaterialOf(this._selection.mesh);
      if (prev) {
        prev.userData.uSelBatch.value = -1;
        prev.userData.uSelWhole.value = 0;
      }
      this._clearSelectionDecoration();
      this._selection = null;
    }

    if (!result) {
      this.uniforms.uSelMix.value = 0;
      this.uniforms.uDim.value = 0;
      this.outlineMaterial.uniforms.uSelBatch.value = -1;
      this.outlineMaterial.uniforms.uSelWhole.value = 0;
      this.outlineMaterial.uniforms.uElevation.value = 0;
      this.map?.triggerRepaint();
      if (!silent) this.onPick(null);
      return;
    }

    this._selection = result;
    const mat = styledMaterialOf(result.mesh);
    if (mat) {
      mat.userData.uSelBatch.value = result.batchId;
      // 没有单体化信息时整块高亮，否则会出现「点中了但什么都没亮、其他全暗了」
      mat.userData.uSelWhole.value = result.batchId < 0 ? 1 : 0;
    }
    this.uniforms.uSelMix.value = 1;
    this.uniforms.uDim.value = this.style.dimOthers ? 1 : 0;

    if (this.style.outline) {
      if ((this.style.outlineStyle ?? 'edges') === 'edges') {
        this._addSelectionEdges(result);
      } else {
        this._addSelectionHull(result, mat);
      }
    }
    this.map?.triggerRepaint();
  }

  /**
   * 选中单体的棱线：只挑这个单体自己的三角面算折边，再画成屏幕空间等宽线。
   * 抽出来的线段数很少（一栋楼通常几百到几千条），所以选中开销可以忽略。
   */
  private _addSelectionEdges(result: PickResult): void {
    const ud = result.mesh.userData as MeshUserData;
    const geoRef =
      (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(result.batchId) ?? ud.geoRef;
    const { segments } = resolveFeature(geoRef, result.batchId);
    const pairs = buildFeatureEdgeSegments(result.mesh.geometry, segments);
    if (!pairs) {
      // 抽不出折边（退化几何 / 没有任何夹角）时退回外扩轮廓，至少保证选中可见
      this._addSelectionHull(result, styledMaterialOf(result.mesh));
      return;
    }

    this._syncSelectionStyle();
    const lines = new THREE.Mesh(buildThickLineGeometry(pairs), this.selectionEdgeMaterial);
    lines.renderOrder = 4;
    // 屏幕空间外扩后可能超出原包围球，关掉剔除更稳
    lines.frustumCulled = false;
    lines.raycast = () => {};
    (lines.userData as MeshUserData).isSelectionEdge = true;
    result.mesh.add(lines); // 作为子节点，直接继承世界变换
    this._selectionEdges = lines;
  }

  /** 旧的描边画法：背面外扩法，整块几何一起上，靠 uSelBatch 只显示选中那栋 */
  private _addSelectionHull(result: PickResult, mat: StyledMaterial | null): void {
    this.outlineMaterial.uniforms.uSelBatch.value = result.batchId;
    this.outlineMaterial.uniforms.uSelWhole.value = result.batchId < 0 ? 1 : 0;
    this.outlineMaterial.uniforms.uElevation.value = this.style.selectElevation ?? 0;
    if (mat?.userData?.uBatchTex) {
      this.outlineMaterial.uniforms.uBatchTex.value = mat.userData.uBatchTex.value as THREE.Texture;
      this.outlineMaterial.uniforms.uBatchTexWidth.value = mat.userData.uBatchTexWidth.value as number;
      this.outlineMaterial.uniforms.uBatchTexActive.value = mat.userData.uBatchTexActive.value as number;
    }
    const outline = new THREE.Mesh(result.mesh.geometry, this.outlineMaterial);
    outline.renderOrder = 3;
    outline.frustumCulled = false;
    outline.raycast = () => {};
    result.mesh.add(outline); // 作为子节点，直接继承世界变换
    this._outlineMesh = outline;
  }

  /** 只改 uniform：颜色 / 粗细 / 拔高，拖着滑块实时生效，不重建几何 */
  private _syncSelectionStyle(): void {
    const s = this.style;
    const u = this.selectionEdgeMaterial.uniforms;
    u.uColor.value.set(s.outlineColor ?? s.selectColor);
    u.uWidth.value = Math.max(0.1, s.outlineWidthPx ?? 3);
    u.uOpacity.value = Math.min(1, Math.max(0.05, s.opacity ?? 1));
    u.uElevation.value = this._selection ? this._selectionElevation(this._selection) : 0;
  }

  /** 选中单体的实际拔高 = 全局选中拔高 + 该单体的独立拔高（与着色器口径一致） */
  private _selectionElevation(result: PickResult): number {
    let elev = this.style.selectElevation ?? 0;
    if (result.smid != null) elev += this._featureStyles.get(result.smid)?.elevation ?? 0;
    return elev;
  }

  private _clearSelectionDecoration(): void {
    if (this._outlineMesh) {
      this._outlineMesh.parent?.remove(this._outlineMesh);
      this._outlineMesh = null;
    }
    if (this._selectionEdges) {
      this._selectionEdges.parent?.remove(this._selectionEdges);
      this._selectionEdges.geometry.dispose();
      this._selectionEdges = null;
    }
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

  /** 从 render 参数里取出 mercator→clip 矩阵，兼容 MapLibre v4 / v5 与 Mapbox 两种签名 */
  private _extractMatrix(arg: unknown): ArrayLike<number> | null {
    if (Array.isArray(arg)) return arg as number[];
    if (arg instanceof Float64Array || arg instanceof Float32Array) return arg;
    const o = arg as
      | { defaultProjectionData?: { mainMatrix?: ArrayLike<number> }; modelViewProjectionMatrix?: ArrayLike<number> }
      | null
      | undefined;
    return o?.defaultProjectionData?.mainMatrix ?? o?.modelViewProjectionMatrix ?? null;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, arg: unknown): void {
    if (!this.renderer || !this.scene || !this.camera || !this.sceneAnchor || !this.map) return;

    const matrix = this._extractMatrix(arg);
    if (!matrix) return;

    const canvas = this.map.getCanvas();
    const s = this.sceneAnchor.meterInMercator;

    // ENU → Mercator：x 向东，y 向北（墨卡托 y 朝南，所以取负），z 向上
    this._enuMatrix.set(
      s, 0, 0, this.sceneAnchor.x,
      0, -s, 0, this.sceneAnchor.y,
      0, 0, s, this.sceneAnchor.z,
      0, 0, 0, 1
    );

    const mvp = new THREE.Matrix4().fromArray(matrix).multiply(this._enuMatrix);
    this.camera.projectionMatrix.copy(mvp);
    this.camera.projectionMatrixInverse.copy(mvp).invert();

    // 相机在场景 ENU 中的位置
    let camEnu: [number, number, number] = [0, 0, 0];
    try {
      const p = this.map.getFreeCameraOptions?.()?.position;
      if (p) {
        camEnu = [
          (p.x - this.sceneAnchor.x) / s,
          -(p.y - this.sceneAnchor.y) / s,
          (p.z - this.sceneAnchor.z) / s,
        ];
      }
    } catch {
      /* FreeCamera 不可用时退回原点，只影响 LOD 精度 */
    }

    const fov = this.map.transform?.fov ?? DEFAULT_FOV;
    for (const entry of this.datasets.values()) {
      if (!entry.visible || !entry.tileset) continue;
      const local: [number, number, number] = [
        camEnu[0] - entry.offset[0],
        camEnu[1] - entry.offset[1],
        camEnu[2] - entry.offset[2],
      ];
      entry.tileset.update(local, fov, canvas.height);
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

    // 动态着色 / 有瓦片在队列里，都需要继续驱动下一帧
    if (this.style.mode === STYLE.DYNAMIC || this.stats.loading > 0) this.map.triggerRepaint();

    this._frame++;
    const now = performance.now();
    if (now - this._fps.last > 500) {
      this._fps.value = Math.round((this._frame * 1000) / (now - this._fps.last));
      this._frame = 0;
      this._fps.last = now;
    }
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
      const b = entry.tileset?.config?.geoBounds as
        | { left: number; bottom: number; right: number; top: number }
        | undefined;
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
    this.onRemove();
  }
}

export { STYLE, STYLE_LABELS, SELECT_MODE, SELECT_MODE_LABELS };
export type { SelectMode };
