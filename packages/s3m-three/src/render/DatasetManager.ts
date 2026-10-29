/**
 * 数据集管理器
 *
 * 负责：
 * 1. 多 S3M 数据集的注册、加载、卸载与生命周期维护
 * 2. 数据集锚点对齐、场景主锚点维护与 RTC 局部坐标偏移
 * 3. 语义高程对齐（align: 'top' | 'bottom' | 'center'）与垂直高程偏移计算
 * 4. 多数据集全局经纬度包围盒计算（getBounds）
 */
import * as THREE from 'three';
import { S3MTileset, usableGeoBounds } from '../tileset/S3MTileset.js';
import type { AuthenticateFn } from '../core/AuthFetch.js';
import type { Anchor } from '../core/types.js';
import type { UnsupportedPolicy } from '../core/degradations.js';
import { worldFromLngLat, type GeoAdapter } from './GeoAdapter.js';

export type DatasetAlignment = 'origin' | 'bottom' | 'top' | 'center';

export interface S3MDatasetOptions {
  id: string;
  name?: string;
  configUrl: string;
  visible?: boolean;
  maxTiles?: number;
  /** 该数据集驻留三角形总数的软上限（默认跟随图层级设置；都不传则不限制） */
  maxTriangles?: number;
  /** 该数据集驻留显存/内存字节数的软上限（默认跟随图层级设置；都不传则不限制） */
  maxMemory?: number;
  /** 该数据集的纹理缓存条数上限（默认跟随图层级设置，图层不传则 128） */
  maxImageCache?: number;
  lodRangeScale?: number;
  /**
   * 垂直对齐基准（默认 'origin'）：
   * - 'origin': 忠实使用数据源原生 position.z 原点
   * - 'top':    将模型顶部对齐地表 Z=0（整体沉入地下，适合地下工程、地铁站、地下管线）
   * - 'bottom': 将模型底部对齐地表 Z=0（消除模型深埋或浮空，适合地上建筑）
   * - 'center': 将几何中心对齐地表 Z=0
   */
  align?: DatasetAlignment;
  /** 垂直高度偏移（米），在 align 对齐基准上的额外偏移，正数抬升，负数下降，默认 0 */
  heightOffset?: number;
  /** 是否用 Web Worker 解析经典 .s3mb 瓦片（默认开，崩溃自动降级主线程），见 S3MTilesetOptions.useWorker */
  useWorker?: boolean;
  /** 三角面材质深度偏移（共面摩尔纹 / 重合面归属），见 BuildTileOptions.polygonOffset */
  polygonOffset?: { factor: number; units: number };
  /**
   * 本数据集的光照模型档位（不填则用图层级设置）。
   * 只影响该数据集**之后创建**的材质。
   */
  materialQuality?: 'pbr' | 'lambert';
  /**
   * 是否对该数据集生成几何棱线（CPU 端 EdgesGeometry）。
   * - 不填：跟随全局 `style.edges`
   * - true / false：强制开 / 关（例如地形、绿地、道路只显示材质、不描边）
   */
  enableEdges?: boolean;
  /**
   * 本数据集专属的鉴权适配函数（不填则用图层级的 `authenticate`）。
   * 适合多数据集走不同网关 / 不同 token 的场景。见 `AuthenticateFn`。
   */
  authenticate?: AuthenticateFn;
  /**
   * 本数据集遇到「解析得了但画不出该有的样子」时怎么办（默认 `'warn'`）。
   * 目前只有 3DGS：按点渲染，做不出泼溅。见 `S3MTilesetOptions.unsupported`。
   */
  unsupported?: UnsupportedPolicy;
}

export interface S3MDatasetEntry {
  id: string;
  name: string;
  options: S3MDatasetOptions;
  root: THREE.Group;
  tileset: S3MTileset | null;
  anchor: Anchor | null;
  /** 语义对齐方式计算出的基础偏移（米） */
  baseAlignOffset: number;
  /** 应用层设置的额外垂直偏移（米，贴地高程 / 手动微调），与对齐基准相互独立 */
  userOffset: number;
  /** 最终垂直高度偏移（米）= baseAlignOffset + userOffset */
  heightOffset: number;
  /** 相对场景锚点的偏移（米） */
  offset: [number, number, number];
  visible: boolean;
  error: unknown;
}

export interface DatasetManagerCallbacks {
  onTile: (node: any, entry: S3MDatasetEntry) => void;
  onTileRemoved: (node: any, entry: S3MDatasetEntry) => void;
  onStats: () => void;
  onError: (err: unknown) => void;
  onReady: (entry: S3MDatasetEntry) => void;
  triggerRepaint: () => void;
}

export class DatasetManager {
  readonly datasets = new Map<string, S3MDatasetEntry>();
  sceneAnchor: { x: number; y: number; z: number; meterInMercator: number; altitude?: number } | null = null;
  totalMaxTiles: number = 0;
  /**
   * 图层级默认光照模型档位（`undefined` = 跟随模块级默认）。
   * 数据集自己指定了 `materialQuality` 就用自己的。
   */
  defaultMaterialQuality: 'pbr' | 'lambert' | undefined = undefined;

  /**
   * 图层档位变更：同步给已存在的数据集（它们之后加载的瓦片才用新档位；
   * 场上已有材质由 `S3MViewer._rebuildStyledMaterials` 原位重建）。
   *
   * 数据集自己指定过档位的不动 —— 那是它显式要的，不该被图层级设置覆盖。
   */
  setDefaultMaterialQuality(q: 'pbr' | 'lambert' | undefined): void {
    this.defaultMaterialQuality = q;
    for (const entry of this.datasets.values()) {
      if (entry.options.materialQuality) continue;
      entry.tileset?.setMaterialQuality(q);
    }
  }

  get(id: string): S3MDatasetEntry | undefined {
    return this.datasets.get(id);
  }

  values(): IterableIterator<S3MDatasetEntry> {
    return this.datasets.values();
  }

  /**
   * 同步预注册数据集（用于提前建立条目与预算平衡）
   */
  registerDataset(options: S3MDatasetOptions): S3MDatasetEntry {
    const existing = this.datasets.get(options.id);
    if (existing) return existing;
    const root = new THREE.Group();
    root.name = `s3m-dataset:${options.id}`;
    root.visible = options.visible !== false;
    const entry: S3MDatasetEntry = {
      id: options.id,
      name: options.name ?? options.id,
      options,
      root,
      tileset: null,
      anchor: null,
      baseAlignOffset: 0,
      userOffset: options.heightOffset ?? 0,
      heightOffset: options.heightOffset ?? 0,
      offset: [0, 0, 0],
      visible: options.visible !== false,
      error: null,
    };
    this.datasets.set(options.id, entry);
    this.rebalanceBudgets();
    return entry;
  }

  /**
   * 全局多数据集预算再平衡：在所有可见数据集之间均衡分配 maxTiles
   */
  rebalanceBudgets(totalMaxTiles?: number): void {
    const budget = totalMaxTiles ?? this.totalMaxTiles;
    if (!budget || budget <= 0) return;
    this.totalMaxTiles = budget;

    const visibleEntries = Array.from(this.datasets.values()).filter((d) => d.visible && d.tileset);
    const count = Math.max(1, visibleEntries.length);
    const perDataset = Math.max(8, Math.floor(budget / count));

    for (const entry of this.datasets.values()) {
      if (!entry.tileset) continue;
      if (entry.visible) {
        entry.tileset.maxTiles = perDataset;
        entry.tileset.hardCap = perDataset + Math.max(4, Math.ceil(perDataset * 0.5));
      } else {
        // 隐藏数据集仅保留极低配额（防止占着显存）
        entry.tileset.maxTiles = Math.min(4, entry.tileset.maxTiles);
        entry.tileset.hardCap = Math.min(6, entry.tileset.hardCap);
      }
    }
  }

  /** 根据语义对齐方式（'top' | 'bottom' | 'center'）和数据源高度范围计算基准高度偏移 */
  computeAlignOffset(tileset: S3MTileset | null, align?: DatasetAlignment): number {
    if (!align || align === 'origin' || !tileset) return 0;
    const hr = tileset.heightRange;
    if (!hr) return 0;
    switch (align) {
      case 'top':
        return -hr.max;
      case 'bottom':
        return -hr.min;
      case 'center':
        return -(hr.min + hr.max) / 2;
      default:
        return 0;
    }
  }

  /**
   * 注册并加载数据集
   */
  async addDataset(
    ds: S3MDatasetOptions,
    scene: THREE.Scene,
    geo: GeoAdapter | null,
    uniforms: any,
    defaultLodRangeScale: number,
    buildTile: any,
    maxTiles: number,
    maxConcurrent: number,
    callbacks: DatasetManagerCallbacks,
    maxTriangles: number = Infinity,
    maxImageCache: number = 128,
    authenticate?: AuthenticateFn,
    maxMemory: number = Infinity
  ): Promise<S3MDatasetEntry> {
    const existing = this.datasets.get(ds.id);
    if (existing) return existing;

    const root = new THREE.Group();
    root.name = `s3m-dataset:${ds.id}`;
    root.visible = ds.visible !== false;
    scene.add(root);

    const entry: S3MDatasetEntry = {
      id: ds.id,
      name: ds.name ?? ds.id,
      options: ds,
      root,
      tileset: null,
      anchor: null,
      baseAlignOffset: 0,
      userOffset: ds.heightOffset ?? 0,
      heightOffset: ds.heightOffset ?? 0,
      offset: [0, 0, 0],
      visible: ds.visible !== false,
      error: null,
    };
    this.datasets.set(ds.id, entry);

    const tileset = new S3MTileset({
      configUrl: ds.configUrl,
      maxTiles: ds.maxTiles ?? maxTiles,
      maxConcurrent: maxConcurrent,
      maxTriangles: ds.maxTriangles ?? maxTriangles,
      maxMemory: ds.maxMemory ?? maxMemory,
      maxImageCache: ds.maxImageCache ?? maxImageCache,
      lodRangeScale: ds.lodRangeScale ?? defaultLodRangeScale,
      buildTile: buildTile ?? null,
      polygonOffset: ds.polygonOffset,
      // 数据集 > 图层 > 模块级默认（undefined 一路传下去，由 createStyledMaterial 回落）
      materialQuality: ds.materialQuality ?? this.defaultMaterialQuality,
      useWorker: ds.useWorker,
      authenticate: ds.authenticate ?? authenticate,
      unsupported: ds.unsupported,
      uniforms: uniforms,
      onTile: (node) => {
        callbacks.onTile(node, entry);
      },
      onTileRemoved: (node) => {
        callbacks.onTileRemoved(node, entry);
      },
      onProgress: () => {
        callbacks.onStats();
        callbacks.triggerRepaint();
      },
      onError: (e) => {
        entry.error = e;
        callbacks.onError(e);
        callbacks.onStats();
      },
    });
    entry.tileset = tileset;
    this.rebalanceBudgets();

    try {
      await tileset.init();
    } catch (e) {
      entry.error = e;
      callbacks.onError(e);
      return entry;
    }

    entry.anchor = tileset.anchor;
    entry.baseAlignOffset = this.computeAlignOffset(tileset, ds.align);
    entry.userOffset = ds.heightOffset ?? 0;
    entry.heightOffset = entry.baseAlignOffset + entry.userOffset;
    this.layoutDataset(entry, geo);
    callbacks.onReady(entry);
    callbacks.triggerRepaint();
    return entry;
  }

  /**
   * 移除指定数据集
   */
  removeDataset(
    id: string,
    scene: THREE.Scene,
    geo: GeoAdapter | null,
    cleanTileMeshes: (entry: S3MDatasetEntry) => void
  ): boolean {
    const entry = this.datasets.get(id);
    if (!entry) return false;

    cleanTileMeshes(entry);
    entry.tileset?.dispose();
    scene.remove(entry.root);
    this.datasets.delete(id);
    this.rebalanceBudgets();

    if (this.datasets.size > 0) {
      this.recomputeAnchors(geo);
    } else {
      this.sceneAnchor = null;
    }
    return true;
  }

  /**
   * 清空所有数据集
   */
  clearDatasets(scene: THREE.Scene, cleanTileMeshes: (entry: S3MDatasetEntry) => void): void {
    for (const entry of this.datasets.values()) {
      cleanTileMeshes(entry);
      entry.tileset?.dispose();
      scene.remove(entry.root);
    }
    this.datasets.clear();
    this.sceneAnchor = null;
  }

  /**
   * 布局数据集局部 ENU 与场景锚点对齐
   */
  layoutDataset(entry: S3MDatasetEntry, geo: GeoAdapter | null): void {
    if (!entry.anchor) return;
    if (!this.sceneAnchor) {
      this.sceneAnchor = worldFromLngLat(geo, entry.anchor.lon, entry.anchor.lat, entry.anchor.height ?? 0);
    }
    const s = this.sceneAnchor.meterInMercator;
    const a = worldFromLngLat(geo, entry.anchor.lon, entry.anchor.lat, entry.anchor.height ?? 0);
    entry.offset = [
      (a.x - this.sceneAnchor.x) / s,
      -(a.y - this.sceneAnchor.y) / s,
      (a.z - this.sceneAnchor.z) / s + (entry.heightOffset ?? 0),
    ];
    entry.root.position.set(entry.offset[0], entry.offset[1], entry.offset[2]);
    entry.root.updateMatrixWorld(true);
  }

  /**
   * 当地图投影或主锚点变化时，重新对齐所有数据集
   */
  recomputeAnchors(geo: GeoAdapter | null): void {
    if (this.datasets.size === 0) return;
    this.sceneAnchor = null;
    for (const entry of this.datasets.values()) {
      this.layoutDataset(entry, geo);
    }
  }

  /**
   * 获取指定数据集的应用层附加垂直偏移（米，不含 align 基准）
   */
  getDatasetHeight(id?: string): number {
    const targetId = id ?? this.datasets.keys().next().value;
    return targetId ? this.datasets.get(targetId)?.userOffset ?? 0 : 0;
  }

  /**
   * 设置应用层附加垂直偏移（米）
   *
   * 语义为「在当前 align 基准之上再抬升/下沉多少米」，
   * 与 align 基准解耦：贴地（把模型抬到真实地面高程）不会破坏 align 语义。
   */
  setDatasetHeight(id: string, height: number, geo: GeoAdapter | null): void {
    const entry = this.datasets.get(id);
    if (!entry) return;
    entry.userOffset = height;
    entry.heightOffset = entry.baseAlignOffset + height;
    this.layoutDataset(entry, geo);
  }

  /**
   * 动态设置指定数据集的垂直对齐基准（'origin' | 'bottom' | 'top' | 'center'）
   *
   * 只更换 align 基准，应用层附加偏移（userOffset）保持不变。
   */
  setDatasetAlign(id: string, align: DatasetAlignment, geo: GeoAdapter | null): void {
    const entry = this.datasets.get(id);
    if (!entry) return;
    const manualOffset = entry.heightOffset - entry.baseAlignOffset;
    entry.baseAlignOffset = this.computeAlignOffset(entry.tileset, align);
    entry.userOffset = manualOffset;
    entry.heightOffset = entry.baseAlignOffset + manualOffset;
    entry.options.align = align;
    this.layoutDataset(entry, geo);
  }

  /**
   * 设置可见性
   */
  setDatasetVisible(id: string, visible: boolean): void {
    const entry = this.datasets.get(id);
    if (!entry) return;
    entry.visible = visible;
    entry.root.visible = visible;
    this.rebalanceBudgets();
  }

  /**
   * 获取所有可见数据集的经纬度边界包围盒 [[minLon, minLat], [maxLon, maxLat]]
   */
  getBounds(): [[number, number], [number, number]] | null {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    let found = false;

    for (const entry of this.datasets.values()) {
      if (!entry.visible || !entry.tileset?.config) continue;
      // 只认「确实是一张经纬度范围」的 geoBounds：OSGB/SuperMapCache 那类配置只给米制
      // 局部包围盒，全 0 的退化框拿去 fitBounds 会把视角甩到几内亚湾
      const b = usableGeoBounds(entry.tileset.config.geoBounds);
      if (b) {
        minLon = Math.min(minLon, b.left);
        minLat = Math.min(minLat, b.bottom);
        maxLon = Math.max(maxLon, b.right);
        maxLat = Math.max(maxLat, b.top);
        found = true;
      }
    }
    return found
      ? [
          [minLon, minLat],
          [maxLon, maxLat],
        ]
      : null;
  }
}
