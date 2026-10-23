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
import { STYLE, STYLE_LABELS, createSharedUniforms, createOutlineMaterial } from './StyleMaterial.js';
import type { OutlineMaterial, StyledMaterial, StyleMode } from './StyleMaterial.js';
import { Picker } from './Picker.js';
import { resolveFeature, measureSegments, buildAttributes, DEFAULT_FLOOR_HEIGHT } from '../core/FeatureInfo.js';
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
  /** 是否给选中单体描边 */
  outline: boolean;
  /** 描边颜色（默认跟随 selectColor） */
  outlineColor?: string;
  /** 描边粗细（米，默认 0.9） */
  outlineWidth?: number;
  /** 是否显示几何棱线（CPU 端生成，有开销） */
  edges: boolean;
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
  floorHeight: DEFAULT_FLOOR_HEIGHT,
  speed: 1,
  opacity: 1,
  shading: 'flat',
  dimOthers: true,
  outline: true,
  outlineColor: '#22d3ee',
  outlineWidth: 0.9,
  edges: false,
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
}

export interface S3MDatasetEntry {
  id: string;
  name: string;
  options: S3MDatasetOptions;
  root: THREE.Group;
  tileset: S3MTileset | null;
  anchor: Anchor | null;
  /** 相对场景锚点的偏移（米） */
  offset: [number, number, number];
  visible: boolean;
  error: unknown;
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
  edges?: THREE.LineSegments | null;
  /** 数据自带棱线包（此时不再用 EdgesGeometry 现算） */
  nativeEdges?: boolean;
  /** 数据自带的棱线对象本身 */
  isEdgeLines?: boolean;
  pickMaterial?: THREE.Material;
  [key: string]: unknown;
}

function styledMaterialOf(mesh: THREE.Mesh): StyledMaterial | null {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const styled = m as StyledMaterial | undefined;
  return styled?.userData?.isStyled ? styled : null;
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

  readonly datasets = new Map<string, S3MDatasetEntry>();

  private readonly _pickables = new Map<number, PickableRef>();
  private _pickSeq = 0;
  private _selection: PickResult | null = null;
  private _outlineMesh: THREE.Mesh | null = null;
  private _edgesEnabled = false;

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

    this._fps.last = performance.now();
    this._datasetQueue = this._normalizeDatasets(options);
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
    this.scene?.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  private _addLights(): void {
    if (!this.scene) return;
    // 天光打底，保证背光面不死黑
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb6c0cb, 1.0));
    // 主光 / 补光的方向每帧按地图朝向重算（见 _updateLights），
    // 这样旋转视角时白模始终是亮的，不会转到背光面就一片死灰。
    this._keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
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

  /** 数据集锚点对齐到场景锚点 */
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
      (a.z - this.sceneAnchor.z) / s,
    ];
    entry.root.position.set(entry.offset[0], entry.offset[1], entry.offset[2]);
    entry.root.updateMatrixWorld(true);
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
    else if ('edgeColor' in patch || 'opacity' in patch || 'edgeOpacity' in patch) this._refreshEdgeLines();
    if (this._selection) this.select(this._selection, { silent: true });
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
    if (u.uRoofThreshold && s.roofThreshold != null) {
      u.uRoofThreshold.value = s.roofThreshold;
    }
    if (u.uTexMix && s.texMix != null) {
      u.uTexMix.value = s.texMix;
    }
    if (this.outlineMaterial) {
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

  /** 让数据自带的棱线跟着 style.edgeColor / opacity 走 */
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
    const edges = new THREE.EdgesGeometry(mesh.geometry, 40);
    const lines = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: new THREE.Color(this.style.edgeColor),
        transparent: true,
        opacity: this.style.edgeOpacity ?? 0.45,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    );
    lines.renderOrder = 2;
    lines.raycast = () => {};
    ud.edges = lines;
    mesh.add(lines); // 作为子节点，自动继承 mesh 的世界变换
  }

  private _removeEdges(mesh: THREE.Mesh): void {
    const ud = mesh.userData as MeshUserData;
    const lines = ud.edges;
    if (!lines) return;
    mesh.remove(lines);
    lines.geometry.dispose();
    (lines.material as THREE.Material).dispose();
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
    const { smid, segments } = resolveFeature(ud.geoRef, hit.batchId);
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
      this._removeOutline();
      this._selection = null;
    }

    if (!result) {
      this.uniforms.uSelMix.value = 0;
      this.uniforms.uDim.value = 0;
      this.outlineMaterial.uniforms.uSelBatch.value = -1;
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

    if (this.style.outline && result.batchId >= 0) {
      this.outlineMaterial.uniforms.uSelBatch.value = result.batchId;
      const outline = new THREE.Mesh(result.mesh.geometry, this.outlineMaterial);
      outline.renderOrder = 3;
      outline.frustumCulled = false;
      outline.raycast = () => {};
      result.mesh.add(outline); // 作为子节点，直接继承世界变换
      this._outlineMesh = outline;
    }
    this.map?.triggerRepaint();
  }

  private _removeOutline(): void {
    if (!this._outlineMesh) return;
    this._outlineMesh.parent?.remove(this._outlineMesh);
    this._outlineMesh = null;
  }

  /* ---------------------------------------------------------------- 渲染 */

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

export { STYLE, STYLE_LABELS };
