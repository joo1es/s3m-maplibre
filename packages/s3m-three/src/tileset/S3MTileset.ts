/**
 * S3M 瓦片集：配置解析 + 按需加载 + LOD 判定
 *
 * LOD 规则（对应规范里的 RangeMode）：
 *   Pixel_Size_OnScreen(1) —— 用包围球投影到屏幕的像素半径与 rangeValue 比较
 *   Distance_From_EyePoint(0) —— 直接用相机到包围球中心的距离
 *   命中阈值就请求 childTile，实现渐进式细化。
 */
import { parseS3MB } from '../core/S3MBParser.js';
import { planDegradations } from '../core/degradations.js';
import { splatLodDecision } from '../core/SplatLod.js';
import type { UnsupportedPolicy } from '../core/degradations.js';
import { authFetch, type AuthenticateFn } from '../core/AuthFetch.js';
import { getSharedS3MWorker, S3MWorkerClient, WorkerDeadError } from '../worker/S3MWorkerClient.js';
import {
  composeLeafAtlas,
  expandTexblockRequestNames,
  parseS3MBlockGroups,
  parseTexblockSegments,
  rebuildBlockTextureState,
  unpackBlockTextures,
} from '../core/S3MBlockParser.js';
import type { S3MBlockTile } from '../core/S3MBlockParser.js';
import { evaluateAtlasUpgrade } from '../core/AtlasUpgrade.js';
import type { AtlasPixels } from '../core/AtlasUpgrade.js';
import type {
  LeafSprite,
  S3MBlockAtlasImage,
  S3MBlockGroupSet,
  S3MBlockTexture,
  TexblockRequestPlan,
} from '../core/S3MBlockParser.js';
import type { Anchor, ParsedTile, Stats, StyleUniforms } from '../core/types.js';
import type { TileGeometryData } from '../core/TileGeometry.js';
import { AUTO_BAKE_RADIUS_THRESHOLD } from '../core/BakeMercator.js';
import type { TextureCreateOptions } from '../render/TextureFactory.js';
import type { Group, Texture } from 'three';

import { dirOf, fixPathEncoding, resolveUrl, s3m1ChildUrl, toAbsolute } from './url.js';
import {
  classifyDatasetKind,
  configTypeHint,
  datasetNameOf,
  parseConfigText,
  resolveAnchor,
} from './config.js';
import type {
  BuildTileFn,
  DatasetKind,
  GeoBounds,
  S3MTilesetOptions,
  TileNode,
  TileVisibilityTest,
} from './types.js';

// 公共面原样保留：这些符号过去就从这个模块导出，引用方不用改一行
export { fixPathEncoding, s3m1ChildUrl } from './url.js';
export { classifyDatasetKind, parseConfigText, usableGeoBounds } from './config.js';
export type {
  BuildTileFn,
  DatasetKind,
  GeoBounds,
  S3MTilesetOptions,
  TileNode,
  TileVisibilityTest,
} from './types.js';

/** 估算单个纹理占用的显存字节数 */
export function estimateTextureBytes(tex: any): number {
  if (!tex) return 0;
  if (Array.isArray(tex.mipmaps) && tex.mipmaps.length > 0) {
    let bytes = 0;
    for (const m of tex.mipmaps) {
      if (m?.data?.byteLength) bytes += m.data.byteLength;
    }
    if (bytes > 0) return bytes;
  }
  const img = tex.image;
  if (!img) return 0;
  if (img.data && typeof img.data.byteLength === 'number') {
    return img.data.byteLength;
  }
  const w = img.width ?? 0;
  const h = img.height ?? 0;
  if (w > 0 && h > 0) {
    const factor = tex.generateMipmaps ? 1.3333333333333333 : 1;
    return Math.round(w * h * 4 * factor);
  }
  return 0;
}

/** 估算三维对象树中包含的几何缓冲字节数 */
export function estimateObjectGeometryBytes(obj: any): number {
  let bytes = 0;
  if (!obj) return 0;
  obj.traverse?.((child: any) => {
    const geo = child.geometry;
    if (geo) {
      if (geo.attributes) {
        for (const attr of Object.values(geo.attributes) as any[]) {
          if (attr?.array?.byteLength) bytes += attr.array.byteLength;
        }
      }
      if (geo.index?.array?.byteLength) {
        bytes += geo.index.array.byteLength;
      }
    }
    if (child.isInstancedMesh) {
      if (child.instanceMatrix?.array?.byteLength) bytes += child.instanceMatrix.array.byteLength;
      if (child.instanceColor?.array?.byteLength) bytes += child.instanceColor.array.byteLength;
    }
  });
  return bytes;
}

export class S3MTileset {
  configUrl: string;
  config: Record<string, unknown> | null = null;
  /**
   * S3MBLOCK 数据集的完整瓦片清单（config.tiles 解析成绝对 URL）。
   * 这类数据的 pageLOD 会引用服务端并不存在的子块（LOD 树占位），
   * 按清单过滤可以避免成片的 404。经典 scp 不建这个索引，行为不变。
   */
  private _blockTileIndex: Set<string> | null = null;
  anchor: Anchor = { lon: 0, lat: 0, height: 0 };

  readonly rootUrls: string[] = [];
  readonly nodes = new Map<string, TileNode>();
  readonly failed = new Set<string>();
  readonly textureCache = new Map<string, Texture>();
  maxImageCache: number;
  private readonly _textureRefs = new Map<string, number>();
  private readonly _tileTextureKeys = new Map<string, string[]>();
  readonly pending = new Set<string>();
  /** 是否请求 `.texblock` 子图集，默认关，见 S3MTilesetOptions.atlasLod */
  atlasLod: boolean;
  /** 根图集 id → 已拉到的清晰版子图集；null = 正在请求或确认没有，避免重复发请求 */
  readonly atlasLodCache = new Map<string, S3MBlockAtlasImage | null>();
  /** 块 URL → 该文件里的全部 LOD 组（一个 .s3mblock 是一棵子树，不是一块瓦片） */
  private readonly _groupCache = new Map<string, S3MBlockGroupSet>();
  /** 独立 `.texblock` 图集缓存：id → 图像；null 表示正在请求或确认不可用 */
  readonly externalAtlasCache = new Map<string, S3MBlockAtlasImage | null>();
  /**
   * leaf 子请求缓存：去扩展名的子请求名（`Tex_0_000` / `Tile_6_000000`）→ 响应里的记录；
   * null = 已判定不可用。精灵按全局共享（同名同内容），跨瓦片复用。
   */
  readonly leafRequestCache = new Map<string, S3MBlockAtlasImage[] | null>();
  /** 进行中的 leaf 请求（stem → Promise），跨瓦片并发时同名只发一次 */
  private readonly _leafPending = new Map<string, Promise<void>>();
  /** 真正被高清版顶替掉的图集 id（判定通过） */
  readonly atlasUpgraded = new Set<string>();
  /** 拿到高清版但判定不通过 → 原因。用于排查「为什么这块还是糊的」 */
  readonly atlasUpgradeSkipped = new Map<string, string>();
  // drawCalls / programs / textures / geometries 是 viewer 级 GPU 观测，
  // 瓦片侧不产生，恒为 0；聚合时由 S3MViewer.stats 用 renderer.info 覆盖
  readonly stats: Stats = {
    tiles: 0,
    loading: 0,
    failed: 0,
    meshes: 0,
    vertices: 0,
    triangles: 0,
    datasets: 1,
    drawCalls: 0,
    programs: 0,
    textures: 0,
    geometries: 0,
    degradations: [],
  };

  maxConcurrent: number;
  maxTiles: number;
  /**
   * 驻留三角形总数的软上限。`Infinity` = 不限制（默认），此时 `_trimBudget` 的
   * 判据与旧版逐字一致，不会多算一次面数。
   */
  maxTriangles: number;
  /**
   * 驻留显存/内存字节数的软上限。`Infinity` = 不限制（默认）。
   */
  maxMemory: number;
  lodRangeScale: number;
  lodTransition: 'binary' | 'incremental';
  fallbackOffset: { factor: number; units: number };
  readonly primaryNodes = new Set<string>();
  readonly fallbackNodes = new Set<string>();

  /** 数据集配置声明的高度范围（米），若配置未声明则返回 null */
  get heightRange(): { min: number; max: number } | null {
    const hr = this.config?.heightRange as { min?: number; max?: number } | undefined;
    if (hr && typeof hr.min === 'number' && typeof hr.max === 'number') {
      return { min: hr.min, max: hr.max };
    }
    return null;
  }

  private readonly _onTile: (node: TileNode) => void;
  private readonly _onTileRemoved: (node: TileNode) => void;
  private readonly _onError: (error: unknown) => void;
  private readonly _onProgress: (stats: Stats) => void;
  private readonly _maxRetries: number;
  /** 鉴权适配函数；undefined = 不做任何改写（行为与旧版一致） */
  readonly authenticate: AuthenticateFn | undefined;
  /** 能力降级的处置策略，默认 'warn'，见 `S3MTilesetOptions.unsupported` */
  private readonly _unsupported: UnsupportedPolicy;
  /** 失败重试计数与下次可用时间，退避期间 _enqueue 会直接跳过 */
  private readonly _retryCount = new Map<string, number>();
  private readonly _retryAt = new Map<string, number>();
  /** 子瓦片 URL → 父瓦片 URL，用于淘汰后补洞 */
  private readonly _parentOf = new Map<string, string>();
  private _frame = 0;
  /** 格式类永久错误只向上报一次，避免整棵瓦片树刷同样的日志 */
  private _permanentReported = false;
  /** 请求量的硬上限（软上限 maxTiles 的超额余量），见构造函数注释 */
  hardCap = 96;
  /** 本数据集是 S3M 1.x（SuperMapCache，.s3m）：子瓦地址规则与 3.x 不同 */
  isS3MV1 = false;
  private _buildTile: BuildTileFn | null;
  private _bakeMercator?: boolean;
  rootRadius?: number;

  shouldBakeMercator(radius?: number): boolean {
    if (this._bakeMercator !== undefined) return this._bakeMercator;
    const r = radius ?? this.rootRadius ?? 0;
    return r > AUTO_BAKE_RADIUS_THRESHOLD;
  }
  private readonly _polygonOffset: { factor: number; units: number } | undefined;
  private _materialQuality: 'pbr' | 'lambert' | undefined;
  private _colorPipeline: 'linear' | 'direct' | undefined;
  private _textureOptions: TextureCreateOptions | undefined;
  private readonly _uniforms: StyleUniforms | null;
  /** 经典 .s3mb 的 Worker 解析客户端；undefined = 尚未尝试创建，null = 不可用/已降级 */
  private _workerClient: S3MWorkerClient | null | undefined;  private readonly _useWorker: boolean;
  private _queue: string[] = [];
  private _active = 0;

  constructor(options: S3MTilesetOptions) {
    this.configUrl = options.configUrl;
    this.lodRangeScale = options.lodRangeScale ?? 3.0;
    this.lodTransition = options.lodTransition ?? 'binary';
    this.fallbackOffset = {
      factor: options.fallbackOffset?.factor ?? 1,
      units: options.fallbackOffset?.units ?? 2,
    };
    this._onTile = options.onTile ?? (() => {});
    this._onTileRemoved = options.onTileRemoved ?? (() => {});
    this._onError = options.onError ?? ((e) => console.warn(e));
    this._onProgress = options.onProgress ?? (() => {});
    this._maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.authenticate = options.authenticate;
    this._unsupported = options.unsupported ?? 'warn';

    // 渲染层可注入：Node 环境下不需要 three，也能跑 URL / 解析链路
    this._buildTile = options.buildTile ?? null;
    this._bakeMercator = options.bakeMercator;
    this._polygonOffset = options.polygonOffset;
    this._materialQuality = options.materialQuality;
    this._colorPipeline = options.colorPipeline;
    this._textureOptions = options.textureOptions;
    // 着色器共享 uniform，由 S3MLayer 持有并传进来
    this._uniforms = options.uniforms ?? null;
    this._useWorker = options.useWorker !== false;

    // 并发与总量限制：iServer 公开服务上别把人家打爆
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxTiles = options.maxTiles ?? 64;
    this.maxTriangles = options.maxTriangles ?? Infinity;
    this.maxMemory = Number.isFinite(options.maxMemory) && (options.maxMemory as number) > 0
      ? (options.maxMemory as number)
      : Infinity;
    this.maxImageCache = options.maxImageCache ?? 128;
    // 硬上限 = 软上限 + 余量。淘汰只在「新瓦片已经落地并接管显示」之后做（make-before-break），
    // 所以中间态允许临时超出 maxTiles；硬上限只用来挡住失控的请求量，不用于挤掉正在显示的内容。
    this.hardCap = this.maxTiles + Math.max(8, Math.ceil(this.maxTiles * 0.5));
    // 默认开启清晰版子图集：根图集是 level=0 的低清代理，拿它平铺就是一堆马赛克
    this.atlasLod = options.atlasLod !== false;
  }

  async init(): Promise<this> {
    this.configUrl = toAbsolute(this.configUrl);
    const res = await authFetch(this.configUrl, this.authenticate, 'config');
    if (!res.ok) throw new Error(`配置读取失败 ${res.status} ${this.configUrl}`);
    const text = await res.text();
    const config = parseConfigText(text);
    this.config = config;

    // 地形/影像缓存（金字塔栅格，无瓦片清单）不能当模型加载：走到下面「缺少 root tile」
    // 那步只会得到一句把「类型不支持」伪装成「配置缺字段」的报错（issue #7），
    // 所以在锚点解析之前先按类型标记拒掉，把病因说清楚。
    const kind = classifyDatasetKind(config);
    if (kind !== 'model') {
      const err = new Error(
        `数据集 ${datasetNameOf(this.configUrl)} 是${kind === 'terrain' ? '地形' : '影像'}缓存（${configTypeHint(config)}），本层仅支持模型类 S3M 数据集`
      ) as Error & { datasetKind: DatasetKind };
      // 程序化判别用：调用方（如数据集列表 UI）可以据此标注/跳过该数据集
      err.datasetKind = kind;
      throw err;
    }

    this.anchor = resolveAnchor(config);

    // iServer 的 realspace 配置用 rootTiles（可多棵树），桌面导出的用 tiles
    const roots = (config.rootTiles ?? config.tiles ?? []) as Array<{ url: string }>;
    if (!roots.length) {
      // 带上 config 的类型标记：地形/影像缓存（本应在前一步被拒）与「configUrl 误指向
      // …/datas 清单」「桌面导出漏瓦片清单」是三种不同的病因，文案必须能区分
      throw new Error(
        `配置中缺少 root tile（${configTypeHint(config)}）——若是地形/影像数据集，或 configUrl 误指向 …/datas 数据集清单，本层仅支持模型类 S3M 数据集`
      );
    }

    this.rootUrls.length = 0;
    for (const r of roots) {
      const u = resolveUrl(this.configUrl, r.url);
      if (u) this.rootUrls.push(u);
    }

    // S3M 1.x（SuperMapCache，.s3m）容器：早点说清楚，别等几十块瓦片全失败才看出来。
    // 位置与范围是按配置反算出来的，所以视角会正确落到模型上，只是这种容器还没接解码。
    this.isS3MV1 =
      /OSGB/i.test(String(config.fileType ?? '')) ||
      /OSGB/i.test(String(config.dataType ?? '')) ||
      (this.rootUrls.length > 0 && this.rootUrls.every((u) => /\.s3m($|\?)/i.test(u)));

    // S3MBLOCK：config.tiles 就是全部瓦片，子引用超出清单的一律不请求
    if (this.rootUrls.every((u) => /\.s3mblock($|\?)/i.test(u))) {
      this._blockTileIndex = new Set(this.rootUrls);
      for (const r of roots) {
        const u = resolveUrl(this.configUrl, r.url);
        if (u) this._blockTileIndex.add(u);
      }
    }

    // 首棵树同步加载，保证 init 返回时已有内容可渲染
    await this._load(this.rootUrls[0]);
    for (const r of this.rootUrls.slice(1)) this._enqueue(r);

    return this;
  }

  private _enqueue(url: string | null, parentUrl?: string): void {
    if (!url) return;
    if (parentUrl) this._parentOf.set(url, parentUrl);
    if (this.nodes.has(url) || this.pending.has(url) || this.failed.has(url)) return;
    if (this._queue.includes(url)) return;
    // 失败退避期间不重入队，等 update() 下一轮再来
    const retryAt = this._retryAt.get(url);
    if (retryAt !== undefined && performance.now() < retryAt) return;
    // 不在这里淘汰！「为了塞新的先删旧的」会立刻在画面上开一个洞 —— 旧的已经没了、
    // 新的还没下载完，而洞那块地下一帧又要靠它回补，于是「删 → 补 → 再删」就是闪烁。
    // 改成 make-before-break：新瓦片落地并接管显示之后，再由 update() 末尾的
    // _trimBudget() 统一裁。这里只用硬上限挡住失控的请求量。
    if (this.nodes.size + this.pending.size + this._queue.length >= this.hardCap) return;
    this._queue.push(url);
    this._pump();
  }

  /**
   * 淘汰一块瓦片给新瓦片腾位置。
   *
   * 分两轮挑：
   * 1. 先挑「没有已加载子瓦片」的叶子 —— 删父瓦片容易露洞；
   * 2. 但如果树的形状是「所有节点都已细化」，一棵叶子都没有，第 1 轮会挑空，
   *    于是永远拒绝加载、相机移到哪都卡在旧画面。这时退一步挑「已经不带
   *    渲染职责」的父瓦片：它的子节点完全覆盖同一片区域，删掉视觉上无损。
   *
   * 两轮都按「最久没进有效范围」排，同帧再比距离。
   * 淘汰最细一级时，如果上一级也不在内存里，顺手把上一级排回队列补洞。
   */
  /** 记录瓦片引用的纹理 key，并递增其引用计数 */
  registerTileTextures(url: string, textureKeys: string[]): void {
    this._tileTextureKeys.set(url, textureKeys);
    const node = this.nodes.get(url);
    if (node) {
      node.textureKeys = textureKeys;
    }
    for (const key of textureKeys) {
      this._textureRefs.set(key, (this._textureRefs.get(key) ?? 0) + 1);
    }
  }

  /** 淘汰单块瓦片节点并释放专属纹理 */
  _evictTileNode(victim: TileNode): void {
    this.nodes.delete(victim.url);
    victim.group?.parent?.remove(victim.group);
    this._onTileRemoved(victim);
    this._parentOf.delete(victim.url);

    this.stats.tiles = Math.max(0, this.stats.tiles - 1);
    if (victim.stats) {
      this.stats.meshes = Math.max(0, this.stats.meshes - (victim.stats.meshes ?? 0));
      this.stats.vertices = Math.max(0, this.stats.vertices - (victim.stats.vertices ?? 0));
      this.stats.triangles = Math.max(0, this.stats.triangles - (victim.stats.triangles ?? 0));
    }

    // 释放此瓦片引用的纹理计数；引用归零时从 GPU / 缓存彻底 dispose
    const keys = victim.textureKeys ?? this._tileTextureKeys.get(victim.url) ?? (victim.group?.userData?.textureKeys as string[] | undefined);
    this._tileTextureKeys.delete(victim.url);
    if (keys?.length) {
      for (const key of keys) {
        const ref = (this._textureRefs.get(key) ?? 1) - 1;
        if (ref <= 0) {
          this._textureRefs.delete(key);
          const tex = this.textureCache.get(key);
          if (tex) {
            tex.dispose?.();
            this.textureCache.delete(key);
          }
        } else {
          this._textureRefs.set(key, ref);
        }
      }
    }
  }

  /** 存入外部图集（带 LRU 容量上限） */
  putExternalAtlas(id: string, img: S3MBlockAtlasImage | null): void {
    if (this.externalAtlasCache.size >= this.maxImageCache && !this.externalAtlasCache.has(id)) {
      const oldestKey = this.externalAtlasCache.keys().next().value;
      if (oldestKey !== undefined) this.externalAtlasCache.delete(oldestKey);
    }
    Map.prototype.set.call(this.externalAtlasCache, id, img);
  }

  /** 读取外部图集 */
  getExternalAtlas(id: string): S3MBlockAtlasImage | null | undefined {
    return this.externalAtlasCache.get(id);
  }

  /** 存入 leaf 记录段（带 LRU 容量上限） */
  putLeafRecords(name: string, recs: S3MBlockAtlasImage[] | null): void {
    if (this.leafRequestCache.size >= this.maxImageCache && !this.leafRequestCache.has(name)) {
      const oldestKey = this.leafRequestCache.keys().next().value;
      if (oldestKey !== undefined) this.leafRequestCache.delete(oldestKey);
    }
    Map.prototype.set.call(this.leafRequestCache, name, recs);
  }

  /** 读取 leaf 记录段 */
  getLeafRecords(name: string): S3MBlockAtlasImage[] | null | undefined {
    return this.leafRequestCache.get(name);
  }

  private _evictOne(allowUncovered = false): boolean {

    // 只挑安全候选：叶子 → 已被子瓦接手的父瓦。allowUncovered 仅在超出硬上限时开启（内存兜底）
    const victim = this._pickVictim(true, allowUncovered) ?? this._pickVictim(false, allowUncovered);
    if (!victim) return false;

    const parentUrl = victim.parentUrl ?? this._parentOf.get(victim.url);
    const childUrls = victim.childUrls ?? (victim.childUrl ? [victim.childUrl] : []);
    const isLeaf = !childUrls.some((u) => u !== victim.url && this.nodes.has(u));

    this._evictTileNode(victim);

    // 淘汰的是中间层时，把已加载的子孙改挂到它的父级上：
    // 不然它们瞬间"无父"，父级那边还留着指向 victim 的 childUrls，
    // 于是 allChildrenReady 永远为假 —— 既显示不对，也白占预算。
    const kids = childUrls.filter((u) => u !== victim.url && this.nodes.has(u));
    if (kids.length) {
      for (const k of kids) {
        const kn = this.nodes.get(k);
        if (!kn) continue;
        kn.parentUrl = parentUrl ?? undefined;
        if (parentUrl) this._parentOf.set(k, parentUrl);
        else this._parentOf.delete(k);
      }
      if (parentUrl) {
        const pn = this.nodes.get(parentUrl);
        if (pn) {
          const merged = new Set<string>(pn.childUrls ?? []);
          if (pn.childUrl) merged.add(pn.childUrl);
          merged.delete(victim.url);
          for (const k of kids) merged.add(k);
          pn.childUrls = [...merged];
          pn.childUrl = pn.childUrls[0] ?? null;
        }
      }
    }

    // 删的是最细一级、而上一级又不在内存里 → 把上一级排回去，别让那块地空着
    if (false as boolean && isLeaf && parentUrl && !this.nodes.has(parentUrl) && !this.pending.has(parentUrl)) {
      // 淘汰阶段不再重新入队父瓦，防止预算满载时引发父子死循环震荡（thrashing loop）
    }
    return true;
  }

  /** 当前驻留瓦片的三角形总数（只算已落地的；在途瓦片还没构建，统计不到） */
  private _residentTriangles(): number {
    let total = 0;
    for (const node of this.nodes.values()) total += node.stats?.triangles ?? 0;
    return total;
  }

  /**
   * 运行时调整面数预算。`Infinity` = 不限制（默认）。
   * 收紧后不会立刻掉内容，要等下一次 `_trimBudget`（下一帧 update）才生效。
   */
  setMaxTriangles(n: number): void {
    this.maxTriangles = n > 0 ? n : Infinity;
  }

  /**
   * 运行时调整显存/内存字节预算。`Infinity` = 不限制（默认）。
   * 收紧后不会立刻掉内容，要等下一次 `_trimBudget`（下一帧 update）才生效。
   */
  setMaxMemory(bytes: number): void {
    this.maxMemory = Number.isFinite(bytes) && bytes > 0 ? bytes : Infinity;
  }

  /**
   * 运行时改本数据集的光照模型档位。只影响**之后**构建的瓦片材质；
   * 场上已有材质由 `S3MViewer.setMaterialQuality` 原位重建。
   * `undefined` = 跟随模块级默认。
   */
  setMaterialQuality(q: 'pbr' | 'lambert' | undefined): void {
    this._materialQuality = q;
  }

  /**
   * 运行时改本数据集的渲染 profile（颜色管线 / 纹理参数）。
   * 只影响**之后**构建的瓦片材质与纹理；场上已有的由 `S3MViewer` 统一重建 / 重传。
   */
  setRenderProfile(p: { colorPipeline?: 'linear' | 'direct'; textureOptions?: TextureCreateOptions }): void {
    if (p.colorPipeline !== undefined) this._colorPipeline = p.colorPipeline;
    if (p.textureOptions !== undefined) this._textureOptions = p.textureOptions;
  }

  /**
   * 当前数据集驻留的显存与内存总字节数（几何缓冲精确大小 + 纹理显存估计）
   */
  residentMemory(): number {
    return this._residentGeometryBytes() + this._residentTextureBytes();
  }

  private _residentGeometryBytes(): number {
    let total = 0;
    for (const node of this.nodes.values()) {
      if (node.stats && typeof node.stats.memory === 'number') {
        total += node.stats.memory;
      } else if (node.group) {
        total += estimateObjectGeometryBytes(node.group);
      }
    }
    return total;
  }

  private _residentTextureBytes(): number {
    let total = 0;
    for (const tex of this.textureCache.values()) {
      total += estimateTextureBytes(tex);
    }
    return total;
  }

  /**
   * 预算裁剪 —— 必须在可见性算完之后调用（make-before-break）：
   * 新瓦片已经落地、也已经决定由谁负责显示，这时候才把没人依赖的那块裁掉。
   * 只踢「当前不显示」或「位置已被可见子瓦接手」的瓦片；挑不出安全候选时允许
   * 暂时超出预算，等下一帧再裁 —— 宁可多占一会儿内存，也不在画面上开洞。
   *
   * 三条预算并行：瓦片数（`maxTiles`）、三角形总数（`maxTriangles`）与显存字节（`maxMemory`）。
   * `maxTriangles` / `maxMemory` 为 Infinity 时短路，行为与只有瓦片数预算时完全一致。
   */
  private _trimBudget(): boolean {
    let removed = false;
    let guard = 0;
    // 在途的也算进"预期驻留数"：不然一批瓦片同时落地时会先把画面撑爆再疯狂裁
    const overTiles = () => this.nodes.size + this.pending.size > this.maxTiles;
    const overTriangles = () =>
      Number.isFinite(this.maxTriangles) && this._residentTriangles() > this.maxTriangles;
    const overMemory = () =>
      Number.isFinite(this.maxMemory) && this.residentMemory() > this.maxMemory;
    // 预算生效时可能要连踢多块，迭代上限跟着驻留规模走；不生效时根本进不了循环
    const iterationCap = this.nodes.size + this.maxTiles + 16;
    while ((overTiles() || overTriangles() || overMemory()) && guard++ <= iterationCap) {
      if (!this._evictOne(this.nodes.size + this.pending.size > this.hardCap)) break;
      removed = true;
    }
    return removed;
  }

  /**
   * 挑淘汰候选。
   * @param allowRefined false = 只挑叶子；true = 也允许挑「子节点已全部加载」的父瓦片
   * @param allowUncovered true = 允许淘汰「正在显示、但位置还没被子瓦接手」的瓦片。
   *   默认 false：这种瓦片一踢，画面上立刻是一个洞，下一帧调度又会把它请回来补洞，
   *   于是「淘汰 → 开洞 → 回补 → 再淘汰」无限循环 = 屏幕不停闪烁。
   *   只有在实在挑不出安全候选时才允许（否则预算满死锁、相机移到哪都不出图）。
   */
  private _pickVictim(allowRefined: boolean, allowUncovered = false): TileNode | null {
    let victim: TileNode | null = null;
    for (const node of this.nodes.values()) {
      const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);
      const refined = childUrls.length > 0 && childUrls.some((u) => u !== node.url && this.nodes.has(u));
      if (refined !== allowRefined) continue;
      // 正在显示且没有可见子瓦接手 → 踢了就是洞
      if (!allowUncovered && node.group.visible) {
        if (this.lodTransition === 'incremental') {
          continue;
        }
        const covered = childUrls.some((u) => {
          const c = this.nodes.get(u);
          return !!c && c.group.visible;
        });
        if (!covered) continue;
      }
      if (!victim) {
        victim = node;
        continue;
      }
      // 可见性优先于时间戳：没有包围球的瓦片算不出距离，`lastSeen` 天然比别的瓦片旧，
      // 只看时间戳会把「正在显示」的那块先踢掉（开洞 → 回补 → 再踢 = 闪）。
      // 只有不可见的候选分不出来时，才轮到 lastSeen / distance 决定。
      const nodeVisible = node.group.visible ? 1 : 0;
      const victimVisible = victim.group.visible ? 1 : 0;
      if (nodeVisible !== victimVisible) {
        if (nodeVisible < victimVisible) victim = node;
        continue;
      }
      const a = node.lastSeen ?? -1;
      const b = victim.lastSeen ?? -1;
      if (a < b || (a === b && (node.distance ?? 0) > (victim.distance ?? 0))) victim = node;
    }
    return victim;
  }

  /** 把之前彻底失败的瓦片全部放回队列（网络恢复后手动调一次） */
  retryFailed(): number {
    const count = this.failed.size;
    this.failed.clear();
    this._retryCount.clear();
    this._retryAt.clear();
    return count;
  }

  private _pump(): void {
    while (this._active < this.maxConcurrent && this._queue.length) {
      const url = this._queue.shift()!;
      this._active++;
      void this._load(url).finally(() => {
        this._active--;
        this._pump();
      });
    }
  }

  private _pickLod(tile: ParsedTile) {
    const lods = tile.groupNode?.pageLods ?? [];
    if (!lods.length) return null;
    // 优先取带 childTile 且 rangeValue > 0 的包，否则退回第一个
    return lods.find((l) => l.childTile && l.rangeValue > 0) ?? lods[0];
  }

  private async _builder(): Promise<BuildTileFn> {
    if (!this._buildTile) {
      const mod = await import('../render/GeometryBuilder.js');
      this._buildTile = mod.buildTileObjects as unknown as BuildTileFn;
    }
    return this._buildTile;
  }

  /**
   * 经典 `.s3mb` 瓦片解析：优先走 Worker（inflate / Draco / MeshOpt / 几何组装
   * 全在 Worker 做，一次往返带回 tile + 纯数据几何），Worker 不可用或已崩溃时
   * 主线程兜底，两条路径输出完全一致。
   */
  private async _parseClassicTile(buffer: ArrayBuffer): Promise<{ tile: ParsedTile; geometry?: TileGeometryData }> {
    if (this._useWorker && this._workerClient === undefined) {
      // 与纹理解码共用进程级单例，避免每个数据集各起一个 Worker
      this._workerClient = getSharedS3MWorker();
    }
    if (this._workerClient) {
      try {
        return await this._workerClient.parseTile(buffer, true, true, this.config?.vertexAttributeDescript);
      } catch (e) {
        if (e instanceof WorkerDeadError) {
          // 脚本加载失败 / 崩溃属于环境问题，永久退回主线程；瓦片本身的问题照常抛
          this._workerClient = null;
        } else {
          throw e;
        }
      }
    }
    return { tile: await parseS3MB(buffer, { vertexAttributeDescript: this.config?.vertexAttributeDescript }) };
  }

  /**
   * 记住一个块文件里解析出来的全部 LOD 组。
   *
   * 一棵 LOD 子树的几层几何加图集动辄好几 MB，全数据集都留着会把内存吃光，
   * 所以只保留最近 24 个块（LRU 足够：相机在附近移动时命中的永远是同几个块）。
   */
  private _rememberGroups(baseUrl: string, set: S3MBlockGroupSet): void {
    this._groupCache.delete(baseUrl);
    this._groupCache.set(baseUrl, set);
    while (this._groupCache.size > 24) {
      const oldest = this._groupCache.keys().next().value;
      if (oldest === undefined) break;
      this._groupCache.delete(oldest);
    }
  }

  /**
   * 补齐「图集像素不在块文件里」的那一半 —— 官方 `requestSubTextures` 的等价物。
   *
   * 根瓦片（如 6.s3mblock）的图集是内嵌的（isSaveData=1）；但**子瓦片**（6_00 / 6_01）
   * 的图集段只有元信息：`data = null` + `requestNames`，像素在同目录的 `.texblock` 里。
   * 不补这一步的后果不是「糊一点」，而是子瓦片整块无贴图：`tile.textures` 里根本没有
   * 这条纹理，材质拿不到 map，建筑变成纯白几何——精细 LOD 一旦真的加载进来就会显露。
   *
   * ★ 只认 requestNames。`childTexNames` 是**下一级 LOD 的图集指针**（官方 `_ancestorTexture`
   *   用它继承 batchTable 的 rect），它有自己的 subTexInfos：同一个精灵在父级叫 `1460_3`
   *   96x64、子级叫 `1460_2` 192x128，排布也不一样。拿父级的 rect 去套子级像素必然错位 ——
   *   上一版就是这么把画面搞坏的。官方从不拿它换像素，那个 LOD 的瓦片自己会加载。
   *
   * requestNames 展开（见 `expandTexblockRequestNames`，逐字对应官方 `_subRequestNames`）：
   *
   * 1. **整图**（`['-704919438.texblock']`，单条记录 = 整张图集）→ 用 `evaluateAtlasUpgrade`
   *    验证后整体替换；根块自带缩略图必须验证过才能换，子瓦片（无基准）至少要求长宽比一致。
   * 2. **leaf 多精灵**（`['Tex_0.texblock#000009…', 'Tile_6_000000.texblock']`，官方 isLeaf）→
   *    图集本身没有像素，只有 `subTexInfos` 里每块一个精灵 rect。按 subName 把精灵贴回
   *    各 rect（`composeLeafAtlas`），组合出整张自上而下 RGBA 画布（compressType=0 /
   *    pixelFormat=28 / flipY=false）。精灵自带「左 2/3 base + 右 1/3 内联 mip 金字塔」，
   *    与 StyleMaterial 的 `s3mAtlasLod` 2/3 采样公式直接配套，rect 一个像素都不用改。
   *
   * 请求方式：pack 组按官方 `Uci` 合并成
   * `GET Tex_0_<code>.texblock?extratiles=Tex_0_000;Tex_0_009;…`（extratiles **去扩展名**、
   * 段序 = 请求序，kMi 取第 i 段）；`Tile_*` 是普通多记录容器，整文件解析后按记录名分发。
   *
   * 不补/补失败时保持缩略图（或无贴图），由上层照常渲染几何，绝不清空已有纹理表。
   */
  private async _fillExternalAtlases(tile: ParsedTile, url: string): Promise<void> {
    const blockTile = tile as ParsedTile & { texturePackage?: Record<string, S3MBlockTexture> };
    const tp = blockTile.texturePackage;
    if (!tp) return;

    // 拼图块：先退回原始图集。拼图是把多张图集重排进一张大图，
    // 换高清图必须在拼图**之前**做，否则 rect 和像素两套排布对不上。
    const wasPacked = unpackBlockTextures(blockTile as S3MBlockTile);
    /** 只要像素被动过，纹理表 / rect 就必须重算 —— 否则子瓦片会整块白膜 */
    let changed = false;

    // ① 展开 requestNames，跨图集汇总本块还缺哪些子请求（同名只拉一次）
    const plans = new Map<string, { tex: S3MBlockTexture; plan: TexblockRequestPlan }>();
    const packMiss = new Map<string, string[]>();
    const plainMiss: string[] = [];
    for (const [id, tex] of Object.entries(tp)) {
      const plan = expandTexblockRequestNames(tex.requestNames);
      if (!plan.names.length) continue; // 只挂了 childTexNames（根瓦片形态）→ 一个请求都不发
      plans.set(id, { tex, plan });
      for (const [base, group] of plan.packGroups) {
        const miss = group.filter((n) => !this.leafRequestCache.has(n));
        if (!miss.length) continue;
        const acc = packMiss.get(base) ?? [];
        for (const n of miss) if (!acc.includes(n)) acc.push(n);
        packMiss.set(base, acc);
      }
      for (const n of plan.plain) {
        if (!this.leafRequestCache.has(n) && !plainMiss.includes(n)) plainMiss.push(n);
      }
    }

    // ② 拉取（先全部 await，再动图集状态；跨瓦片并发时同名请求共享同一个 Promise）
    const pending: Promise<void>[] = [];
    for (const [base, names] of packMiss) {
      let groupFetch: Promise<void> | null = null;
      const start = () => (groupFetch ??= this._fetchLeafPack(url, base, names));
      for (const n of names) pending.push(this._ensureLeafFetch(n, start));
    }
    for (const n of plainMiss) pending.push(this._ensureLeafFetch(n, () => this._fetchLeafFile(url, n)));
    if (pending.length) await Promise.all(pending);

    // ③ 逐图集：leaf 组合优先；没匹配上任何精灵就退回「整图替换 + 验证」
    for (const [id, { tex, plan }] of plans) {
      const sprites = new Map<string, LeafSprite>();
      for (const n of plan.names) {
        const recs = this.leafRequestCache.get(n);
        if (!recs) continue;
        for (const r of recs) sprites.set(r.id, { source: n, image: r });
      }

      const composed = composeLeafAtlas(tex, sprites);
      if (composed) {
        const t = tex as S3MBlockTexture & { composed?: boolean; leafSig?: string };
        t.composed = true;
        t.leafSig = composed.sig;
        t.flipY = false; // 画布自上而下（语义见 S3MBlockTexture.flipY 注释）
        tex.data = composed.data;
        tex.compressType = 0;
        tex.pixelFormat = 28; // RGBA
        tex.width = composed.width;
        tex.height = composed.height;
        tex.rectScale = 1; // 画布与 subTexInfos 同一像素空间，rect 原样、不缩放
        this.atlasUpgraded.add(id);
        changed = true;
        if (composed.missing.length || composed.mismatched.length) {
          // 官方对缺失精灵同样跳过（留透明）；尺寸不一致照样贴。都只告警，不整块拒收。
          console.warn('[s3m] leaf 图集部分精灵异常：', id, {
            missing: composed.missing,
            mismatched: composed.mismatched,
          });
        }
        continue;
      }

      // —— 整图替换回退（官方 isLeaf=false 的路径）——
      // 子瓦片的图集段只有元信息（data = null），没有可比的基准，只能直接采用；
      // 根块自带缩略图，必须验证过才能换。
      const hasBaseline = !!tex.data;
      const accept = (img: S3MBlockAtlasImage): boolean => {
        if (!hasBaseline) {
          // 没有缩略图可比，但至少要挡住「根本不是同一张图集」的情况：
          // 长宽比必须一致，否则 subTexInfos 的 rect 一贴就错位。
          const loAsp = tex.width / tex.height;
          const hiAsp = img.width / img.height;
          if (!(Math.abs(hiAsp / loAsp - 1) <= 0.02)) {
            this.atlasUpgradeSkipped.set(id, `aspect(no-baseline) ${tex.width}x${tex.height} vs ${img.width}x${img.height}`);
            return false;
          }
          return true;
        }
        const v = evaluateAtlasUpgrade(tex as unknown as AtlasPixels, img);
        if (v.ok) return true;
        this.atlasUpgradeSkipped.set(
          id,
          `${v.reason} aspectΔ=${(v.aspectDelta * 100).toFixed(1)}% scale=${v.scale} err=${Number.isNaN(v.meanAbsError) ? 'n/a' : v.meanAbsError.toFixed(1)}`
        );
        return false;
      };

      // ★ 不能无条件换图。实测 3D-OlympicGreen/Building 两块共 8 张图集里，
      //   只有 2 张的 child 是「同一套排布的等比放大」（长宽比 0.0%、下采样色差 8.5/11.2），
      //   其余是**重新排版**过的另一张图（长宽比偏差 5.6%~200%，色差 43~86）。
      //   直接套用 subTexInfos 会整张错位，比不换更糟 —— 所以换之前先验一遍。
      const apply = (img: S3MBlockAtlasImage) => {
        const t = tex as S3MBlockTexture & { composed?: boolean; leafSig?: string };
        // 整图是 DXT 原图（底朝上），清掉 leaf 组合状态
        t.composed = false;
        t.leafSig = undefined;
        t.flipY = true;
        // 覆盖解析阶段按内嵌缩略图填好的那份；判定不通过时不会走到这里，原样保留
        tex.data = img.data;
        tex.compressType = img.compressType;
        tex.pixelFormat = img.pixelFormat;
        // rect 是归一化的，但 subTexInfos 的 offset/width 是像素，必须按倍数换算
        tex.rectScale = tex.width > 0 ? img.width / tex.width : 1;
        tex.width = img.width || tex.width;
        tex.height = img.height || tex.height;
        this.atlasUpgraded.add(id);
        changed = true;
      };

      // 候选只可能是普通请求名的第一条记录；Tex pack 段是子精灵，不是整图（与旧实现一致）。
      let candidate = this.externalAtlasCache.get(id);
      if (candidate === null) continue; // 已判定不可用
      if (candidate === undefined) {
        candidate = null;
        for (const n of plan.plain) {
          const recs = this.leafRequestCache.get(n);
          if (recs?.length) {
            candidate = recs[0]!;
            break;
          }
        }
        this.putExternalAtlas(id, candidate);
      }
      if (candidate) {
        if (accept(candidate)) apply(candidate);
      } else if (!this.atlasUpgradeSkipped.has(id)) {
        this.atlasUpgradeSkipped.set(id, 'no usable external image（请求失败或只拿到子精灵）');
      }
    }

    // 像素定下来了，重新拼图并重算 rect / 纹理表（两者必须一起重算）。
    //
    // ★ 这里必须用 `wasPacked || changed`，不能只看 wasPacked：
    //   **子瓦片**的图集是 `data = null` + `requestNames`，根本没参与拼图（wasPacked=false），
    //   像素是刚从 .texblock 拉回来的。只看 wasPacked 的后果是 `tile.textures` 永远是空的
    //   → 近看整片白膜；同时 atlasRects 也没按 rectScale 重算 → 远处马赛克噪点。
    if (wasPacked || changed) rebuildBlockTextureState(blockTile as S3MBlockTile);
  }

  /** 同名子请求去重：命中缓存立即返回；否则共享进行中的 Promise（跨瓦片并发只发一次） */
  private _ensureLeafFetch(stem: string, start: () => Promise<void>): Promise<void> {
    if (this.leafRequestCache.has(stem)) return Promise.resolve();
    const inflight = this._leafPending.get(stem);
    if (inflight) return inflight;
    const p = start().finally(() => this._leafPending.delete(stem));
    this._leafPending.set(stem, p);
    return p;
  }

  /**
   * pack 组请求 —— 官方 `Uci`：URL = 组内第一个请求的 URL，追加
   * `extratiles=<全组 quadKey，去扩展名，';' 连接>`；响应是 kMi pack，段序 = extratiles 序。
   *
   * 实测服务端两种写法都 200，但带 `.texblock` 的 extratiles 会解出 recs=4 的错内容，
   * 所以必须用**去扩展名**的 quadKey。
   */
  private async _fetchLeafPack(baseUrl: string, base: string, names: string[]): Promise<void> {
    const u = resolveUrl(dirOf(baseUrl), `${names[0]}.texblock?extratiles=${names.join(';')}`);
    try {
      if (!u) throw new Error('无法拼出 URL');
      const res = await authFetch(u, this.authenticate, 'texblock');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const segments = await parseTexblockSegments(await res.arrayBuffer());
      if (segments.length !== names.length) {
        throw new Error(`pack 段数 ${segments.length} ≠ 请求名 ${names.length}`);
      }
      names.forEach((n, i) => this.putLeafRecords(n, segments[i]!));
    } catch (e) {
      console.warn('[s3m] leaf pack 请求失败：', u, e);
      for (const n of names) if (!this.leafRequestCache.has(n)) this.putLeafRecords(n, null);
    }
  }

  /** 普通 `.texblock`（整图或多记录容器）：文件里的全部记录都归这个子请求名 */
  private async _fetchLeafFile(baseUrl: string, stem: string): Promise<void> {
    const u = resolveUrl(dirOf(baseUrl), `${stem}.texblock`);
    try {
      if (!u) throw new Error('无法拼出 URL');
      const res = await authFetch(u, this.authenticate, 'texblock');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const records = (await parseTexblockSegments(await res.arrayBuffer())).flat();
      this.putLeafRecords(stem, records);
    } catch (e) {
      console.warn('[s3m] leaf texblock 请求失败：', u, e);
      if (!this.leafRequestCache.has(stem)) this.putLeafRecords(stem, null);
    }
  }

  /**
   * @deprecated 已由 `_fillExternalAtlases` 覆盖，保留仅为兼容 `atlasLod` 选项。
   *
   * 旧实现「像素数更大就整体换图」，正是被证伪的那个前提：实测 8 张图集里只有 2 张的
   * child 是等比放大，其余是重新排版过的另一张图，硬换会整张错位。
   * 现在换图统一走 `_fillExternalAtlases` + `evaluateAtlasUpgrade` 的验证流程。
   */
  private async _upgradeAtlasLod(_tile: ParsedTile, _url: string): Promise<void> {
    return;
  }

  /**
   * 处置一块瓦片的降级项。
   *
   * 位置很讲究：必须在 `build` 之前。`'throw'` 策略下要在浪费一次几何组装
   * （几十万面的解交错 + 合批）之前就拒绝，否则「拒绝」本身也成了开销。
   *
   * 抛出的错带 `permanent`，由 `_load` 的 catch 识别 → 不重试、直接进 failed。
   */
  private _noteDegradations(tile: ParsedTile): void {
    const incoming = tile.degradations;
    if (!incoming?.length) return;
    const plan = planDegradations(incoming, this.stats.degradations, this._unsupported);
    this.stats.degradations = plan.known;
    for (const msg of plan.messages) console.warn(msg);
    if (plan.error) throw plan.error;
  }

  private async _load(url: string): Promise<void> {
    if (this.nodes.has(url) || this.pending.has(url) || this.failed.has(url)) return;
    this.pending.add(url);
    this.stats.loading++;

    try {
      // URL 里的 `#N` 表示「同一个 .s3mblock 文件里的第 N 个 LOD 组」。
      // 一个块文件打包的是一整棵 LOD 子树（6_01 → 6_0100 → 6_010000 → …），
      // 这些下层瓦片**不是独立文件**，用 `#N` 直接命中已缓存的组，不再发请求。
      const hashAt = url.indexOf('#');
      const baseUrl = hashAt >= 0 ? url.slice(0, hashAt) : url;
      const groupIndex = hashAt >= 0 ? Number(url.slice(hashAt + 1)) || 0 : 0;
      const isBlock = /\.s3mblock($|\?)/i.test(baseUrl);

      let tile: ParsedTile;
      let assembled: TileGeometryData | undefined;
      let groupNames: string[] = [];
      const cachedSet = this._groupCache.get(baseUrl);
      if (cachedSet) {
        groupNames = cachedSet.names;
        tile = cachedSet.tiles[groupIndex] ?? cachedSet.tiles[0]!;
      } else {
        const res = await authFetch(baseUrl, this.authenticate, 'tile');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} 加载瓦片失败: ${baseUrl}`);
        }
        const ctype = res.headers.get('content-type') || '';
        if (ctype.includes('text/html')) {
          throw new Error(`瓦片请求返回了 HTML 页面（通常为 404/500 服务端拦截）: ${baseUrl}`);
        }
        const buffer = await res.arrayBuffer();
        // S3MBLOCK（TextureSharing / 单文件存储）走专用解析：容器 + 内嵌 v2 瓦片体 + 图集纹理
        if (isBlock) {
          const set = await parseS3MBlockGroups(buffer);
          this._rememberGroups(baseUrl, set);
          groupNames = set.names;
          tile = set.tiles[groupIndex] ?? set.tiles[0]!;
        } else {
          const parsed = await this._parseClassicTile(buffer);
          tile = parsed.tile;
          assembled = parsed.geometry;
        }
      }
      if (isBlock) {
        // 子瓦片的图集像素在独立 .texblock 里，必须先补齐，否则整块无贴图
        await this._fillExternalAtlases(tile, baseUrl);
        await this._upgradeAtlasLod(tile, baseUrl);
      }

      // 解析成功但能力不完整的（目前只有 3DGS），在花力气建几何之前先决定处置
      this._noteDegradations(tile);

            const lodForBake = this._pickLod(tile);
      if (this.rootRadius === undefined && lodForBake?.boundingSphere?.radius) {
        this.rootRadius = lodForBake.boundingSphere.radius;
      }
      const shouldBake = this.shouldBakeMercator(lodForBake?.boundingSphere?.radius);
      const build = await this._builder();
      const buildRes = await build(tile, {
        textureCache: this.textureCache,
        uniforms: this._uniforms,
        assembled,
        polygonOffset: this._polygonOffset,
        materialQuality: this._materialQuality,
        colorPipeline: this._colorPipeline,
        textureOptions: this._textureOptions,
        bakeMercator: shouldBake,
        tileAnchor: this.anchor,
        tileCenter: lodForBake?.boundingSphere?.center,
      });
      const { group, stats } = buildRes;
      const texKeys = (buildRes as any).textureKeys ?? (group.userData?.textureKeys as string[] | undefined) ?? Object.keys(tile.textures ?? {});
      this.registerTileTextures(url, texKeys);
      const lod = this._pickLod(tile);

      const childUrls: string[] = [];
      for (const l of tile.groupNode?.pageLods ?? []) {
        // 下一层如果就在本文件里（实测 6_01 的 5 个组是连成一条链的），直接指向 `#index`，
        // 不产生任何网络请求；只有真正的外部文件才走 URL 解析。
        const childName = String(l.childTile ?? '').replace(/\.s3mblock$/i, '');
        const sameFile = isBlock && childName ? groupNames.indexOf(childName) : -1;
        const u =
          sameFile >= 0
            ? `${baseUrl}#${sameFile}`
            : this.isS3MV1
              ? s3m1ChildUrl(url, l.childTile)
              : resolveUrl(dirOf(url), l.childTile);
        // 注意：不能拿 rootTiles 清单去筛子瓦片。S3MBLOCK 的 config.tiles 只是**根**瓦片，
        // 实测 6.s3mblock 的 pageLOD 指向 6_00/6_01.s3mblock（HTTP 200，37 KB / 549 KB），
        // 都在清单之外。按清单筛的后果是 childUrls 恒为空 → update() 永远不细化 →
        // 任何机位都只渲染最粗一级的根图集（一栋楼只剩十几像素，再按 uv 平铺几十遍），
        // 表现为「整栋微缩建筑照片贴满立面」。是否可取由服务器 404 + failed 退避来兜。
        if (u && u !== url && !childUrls.includes(u)) childUrls.push(u);
      }

      const node: TileNode = {
        url,
        tile,
        group,
        sphere: lod?.boundingSphere ?? null,
        rangeValue: lod?.rangeValue ?? 0,
        rangeMode: lod?.rangeMode ?? 1,
        childUrl: childUrls[0] ?? (this.isS3MV1 ? s3m1ChildUrl(url, lod?.childTile) : resolveUrl(dirOf(url), lod?.childTile)),
        childUrls,
        parentUrl: this._parentOf.get(url),
        state: 'ready',
        ...(stats.splatSigma ? { splatSigma: stats.splatSigma } : {}),
        ...(stats.splatCount ? { splatCount: stats.splatCount } : {}),
        stats: {
          meshes: stats.meshes ?? 0,
          vertices: stats.vertices ?? 0,
          triangles: stats.triangles ?? 0,
          memory: (stats as any).memory ?? estimateObjectGeometryBytes(group),
        },
      };

      this.nodes.set(url, node);
      this.stats.tiles++;
      this.stats.meshes += stats.meshes ?? 0;
      this.stats.vertices += stats.vertices ?? 0;
      this.stats.triangles += stats.triangles ?? 0;

      this._onTile(node);
    } catch (e) {
      // 格式层面的永久错误（例如 S3M 1.x 容器）重试一万次也不会变好，
      // 直接判失败，免得反复重下一整块瓦片还拖慢首屏
      const permanent = (e as { permanent?: boolean } | null)?.permanent === true;
      const attempts = (this._retryCount.get(url) ?? 0) + 1;
      this._retryCount.set(url, attempts);
      if (!permanent && attempts <= this._maxRetries) {
        // 退避重试：不进 failed，下一帧 update() 会重新入队，避免网络抖一下就留个永久空洞
        this._retryAt.set(url, performance.now() + 800 * attempts);
      } else {
        // 只有重试耗尽的瓦片才计入 failed：瞬态失败下一轮就成功了，
        // 计进去会让状态栏永久挂着一个「N 个瓦片失败」的假警告
        this.stats.failed++;
        this.failed.add(url);
        this._retryAt.delete(url);
        // 从父瓦片的子列表里摘掉：S3MBLOCK 里有些 pageLOD 的 childTile 在服务器上根本不存在
        // （实测 64_0000 / 65_0200 全是 404）。留着会让父瓦片永远「子未全就绪」→ 永不细化，
        // 症状就是贴着看也一直渲染最粗一级。
        const pUrl = this._parentOf.get(url);
        const pNode = pUrl ? this.nodes.get(pUrl) : undefined;
        if (pNode?.childUrls) {
          pNode.childUrls = pNode.childUrls.filter((u) => u !== url);
          pNode.childUrl = pNode.childUrls[0] ?? null;
        }
      }
      // 同一类永久错误只报一次：OSGB 服务一上来几十块瓦片都是同一个原因，
      // 刷屏会把真正值得看的日志埋掉
      if (permanent) {
        if (!this._permanentReported) {
          this._permanentReported = true;
          this._onError(e);
        }
      } else {
        this._onError(e);
      }
    } finally {
      this.pending.delete(url);
      this.stats.loading--;
      this._onProgress(this.stats);
    }
  }

  /**
   * @param camEnu 相机在该数据集局部 ENU 坐标系中的位置（米）
   * @param fovRad 垂直视场角（弧度）
   * @param screenHeight 视口像素高度
   * @returns 瓦片加载队列或可见性是否发生变化
   */
  update(
    camEnu: [number, number, number],
    fovRad: number,
    screenHeight: number,
    isVisible?: TileVisibilityTest
  ): boolean {
    this._frame++;
    let hasChanges = false;

    for (const node of this.nodes.values()) {
      if (!node.sphere) {
        // 没有包围球（S3M 1.x 叶子瓦片：XML 是 `<PageLods><Geode>`，没有 PagedLOD）时
        // 算不出距离，但**仍要记「最近用过」**：`lastSeen` 恒为 undefined 会让它在
        // `_pickVictim` 里永远排最前（`?? -1`），硬上限一触发 `allowUncovered`，
        // 第一块被踢掉的就是正在显示的那块 —— 画面立刻一个洞，下一帧又加载回来。
        node.lastSeen = this._frame;
        node.needRefine = false;
        continue;
      }

      const c = node.sphere.center;
      const dx = c.x - camEnu[0];
      const dy = c.y - camEnu[1];
      const dz = c.z - camEnu[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      node.distance = dist;

      let metric: number;
      // RangeMode 语义（规范只写了 0/1）：
      //   0 Distance_From_EyePoint —— rangeValue 是米，离得越近越该细化
      //   1 Pixel_Size_OnScreen     —— rangeValue 是屏幕像素，投影半径超过它就细化
      //   2 规范枚举里没有这一档（文档里记作 Geometric_Error）。实测高斯泼溅 / 点云服务用的是
      //     这一档，且 rangeValue ≈ 包围球半径的固定比例（根瓦片 0.664/10.455，子瓦片
      //     0.332/3.7，比例都约 0.064），像是「相对屏幕尺寸的几何误差」而非绝对像素。
      //     这里先按 1 处理：方向是对的（近处细化），只是阈值偏小会多下几层，靠 lodRangeScale 收着。
      const byDistance = node.rangeMode === 0;
      if (byDistance) {
        metric = dist; // Distance_From_EyePoint：距离越小越该细化
      } else {
        // 屏幕像素尺寸。照抄官方 PageLod.calcPixFromCam（SourceRelease/_3437c37f.js）：
        //   pix = (drawingBufferHeight/2) / tan(PI_OVER_FOUR * 0.5) * radius / distance * 2
        //       = drawingBufferHeight * 2.4142 * radius / distance
        // 两个要点：① 视场角是**写死的 45°**（tan(22.5°)），不取渲染器实际 fov；
        // ② 末尾那个 *2（即用直径量屏幕尺寸）。少这个 *2 会让 metric 只有官方的一半，
        //    needRefine 的门槛就永远差一级 —— 表现就是「贴着看也一直在渲染最粗的根图集，
        //    一张整楼雪碧被 uv 平铺几十遍」。实测瓦片 6_01：radius 293.4、rangeValue 586.8，
        //    distance ≈ 824 m、H = 854 → 官方算 734 > 586.8 该细化，我们旧公式只有 326。
        metric = ((screenHeight * 0.5) / Math.tan(Math.PI / 8)) * (node.sphere.radius / dist) * 2;
        void fovRad;
      }

      // 在有效范围内（留一倍余量）的算「正在用」，淘汰时按这个帧号排优先级
      const scale = this.lodRangeScale > 0 ? this.lodRangeScale : 1.0;
      const threshold = node.rangeValue * scale;
      const inRange = byDistance ? dist < threshold * 2 : metric > threshold * 0.5;
      if (inRange) node.lastSeen = this._frame;

      const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);
      // 加入 8% 迟滞区间（Hysteresis Band），防止相机在 LOD 临界距离处发生父子瓦片逐帧来回横跳闪烁
      const hFactor = node.needRefine ? (byDistance ? 1.08 : 0.92) : 1.0;

      // 泼溅 / 点云瓦片走另一套判据：每层 σ 是同一个物理量、只有点数在涨，包围球
      // 像素误差对它没有含义 —— 按上面那套算，metric 在任何距离都远大于阈值，等于
      // 「永远细化到叶子」。
      // 判据换成**屏幕上的高斯尺寸**（3σ 超过 SPLAT_REFINE_PX 就细化），见 core/SplatLod.ts。
      // 别用覆盖率：主体那块根瓦片 32 万高斯、σ=13.5cm，覆盖率一上来就是 51，
      // 当场停止细化，最后只画了总量 2.3% 的高斯 —— 柱子就是这么被糊掉的。
      const splat =
        node.splatSigma && node.sphere
          ? splatLodDecision({
              splats: node.splatCount ?? node.stats?.vertices ?? 0,
              radius: node.sphere.radius,
              distance: dist,
              sigma: node.splatSigma,
              screenHeight,
              hasChild: childUrls.length > 0,
            })
          : null;

      let needRefine = splat
        ? splat.needRefine
        : childUrls.length > 0 &&
          (byDistance ? metric < threshold * hFactor : metric > threshold * hFactor);
      if (needRefine && isVisible && !isVisible(c, node.sphere.radius, node)) {
        needRefine = false;
      }
      node.needRefine = needRefine;

      const dbgSeen = ((globalThis as { __S3M_LOD_SEEN?: Set<string> }).__S3M_LOD_SEEN ??= new Set<string>());
      if ((globalThis as { __S3M_LOD_DEBUG?: boolean }).__S3M_LOD_DEBUG && !dbgSeen.has(node.url) && dbgSeen.size < 260) {
        dbgSeen.add(node.url);
        // eslint-disable-next-line no-console
        console.log('[LOD]', JSON.stringify({
          url: node.url.split('/').pop(), mode: node.rangeMode, rangeValue: node.rangeValue,
          radius: node.sphere.radius, dist: +dist.toFixed(1), metric: +metric.toFixed(1),
          threshold: +threshold.toFixed(1), needRefine, childUrls: childUrls.map((u) => u.split('/').pop()),
          parent: node.parentUrl ? node.parentUrl.split('/').pop() : null,
        }));
      }

      if (needRefine) {
        for (const childUrl of childUrls) {
          if (!this.failed.has(childUrl) && !this.nodes.has(childUrl) && !this.pending.has(childUrl)) {
            this._enqueue(childUrl, node.url);
            hasChanges = true;
          }
        }
      }
    }

    // 树状递归更新所有瓦片的可见性（确保每个位置只渲染一层最适合的 LOD，避免父子瓦片重叠 Z-fighting）
    const visited = new Set<string>();
    // 根集合 = 配置里的入口瓦片 + 所有「父瓦已不在档」的瓦片。
    // 后者必须有：淘汰掉一块中间层瓦片后，它下面的子孙会瞬间变成"无父"状态，
    // 如果只按 rootUrls 走，它们全部不可达，会被下面那条防御规则一起隐藏 ——
    // 症状就是「进去先渲染出来，然后整片消失，偶尔闪一下」。
    const roots = new Set<string>(this.rootUrls);
    for (const [url, node] of this.nodes) {
      const p = node.parentUrl ?? this._parentOf.get(url);
      if (!p || !this.nodes.has(p)) roots.add(url);
    }

    if (this.lodTransition === 'incremental') {
      if (this._updateVisibilityIncremental(roots, visited)) {
        hasChanges = true;
      }
    } else {
      for (const rootUrl of roots) {
        if (this._updateNodeVisibility(rootUrl, true, visited)) {
          hasChanges = true;
        }
      }
      this.primaryNodes.clear();
      for (const [url, node] of this.nodes) {
        if (node.group.visible) this.primaryNodes.add(url);
      }
      this.fallbackNodes.clear();
    }

    // 防御：若有任何未被 root 树访问到的游离瓦片，全部隐藏
    for (const [url, node] of this.nodes) {
      if (!visited.has(url)) {
        if (node.group.visible) {
          node.group.visible = false;
          hasChanges = true;
        }
        if (this.lodTransition === 'incremental') {
          this._restoreNodePolygonOffset(node);
        }
      }
    }

    // 显示职责已经分配完毕，现在才裁预算（make-before-break）：
    // 此时「谁在负责显示这块地」是确定的，只踢没人依赖的那块，不会开出洞来
    if (this._trimBudget()) hasChanges = true;

    // 兜底：绝不允许空场。
    // 可见性递归是按「先访问先决定」处理的，而 LOD 图不一定是严格的树 —— 同一个子瓦可能
    // 被多个父瓦引用（不同层级指向同一份数据），它可能先在某条"隐藏分支"里被访问掉，
    // 之后就再也拿不到显示机会，最终出现「一块都不显示」的整片消失。
    // 这里做最后一次校正：凡是位置没有被任何可见子瓦接手的瓦片，一律自己显示。
    let anyVisible = false;
    for (const node of this.nodes.values()) {
      if (node.group.visible) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible && this.nodes.size > 0) {
      for (const node of this.nodes.values()) {
        const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);
        const covered = childUrls.some((u) => {
          const c = this.nodes.get(u);
          return !!c && c !== node && c.group.visible;
        });
        if (!covered && !node.group.visible) {
          node.group.visible = true;
          hasChanges = true;
        }
      }
    }

    return hasChanges;
  }

  private _updateNodeVisibility(url: string, parentInBranch: boolean, visited: Set<string>): boolean {
    const node = this.nodes.get(url);
    if (!node) return false;
    // 必须挡住重复访问：可见性图不是严格的树 —— 同一个子瓦可能被多个父瓦引用（不同 LOD 源
    // 指向同一份数据）、淘汰后重挂父级也可能临时造出交叉引用。没有这道守卫，
    // 递归会指数级展开甚至成环，直接 RangeError: Maximum call stack size exceeded。
    if (visited.has(url)) return false;
    visited.add(url);

    let changed = false;
    const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);

    if (!parentInBranch) {
      if (node.group.visible) {
        node.group.visible = false;
        changed = true;
      }
      for (const cUrl of childUrls) {
        if (this._updateNodeVisibility(cUrl, false, visited)) changed = true;
      }
      return changed;
    }

    const hasChildren = childUrls.length > 0;
    // 「就绪」= 已加载；失败的已经从 childUrls 里摘掉，剩下的只要都到了就能接手显示
    const readyChildren = childUrls.filter((cUrl) => this.nodes.has(cUrl));
    const allResolved = childUrls.every((cUrl) => this.nodes.has(cUrl) || this.failed.has(cUrl));

    // 细化前提：需要细化、至少有一个子瓦片就绪、且没有还在下载途中的子瓦片
    // （不等「全部就绪」是因为个别 childTile 在服务器上就是 404，等它等于永远不细化）
    const shouldRefine = !!node.needRefine && hasChildren && readyChildren.length > 0 && allResolved;

    if (shouldRefine) {
      // 子节点接替当前节点渲染，当前父节点隐藏
      if (node.group.visible) {
        node.group.visible = false;
        changed = true;
      }
      for (const cUrl of childUrls) {
        if (this._updateNodeVisibility(cUrl, true, visited)) changed = true;
      }
    } else {
      // 当前节点即为最终展示的 LOD：当前节点显示，下层所有已加载子代瓦片隐藏
      if (!node.group.visible) {
        node.group.visible = true;
        changed = true;
      }
      for (const cUrl of childUrls) {
        if (this._updateNodeVisibility(cUrl, false, visited)) changed = true;
      }
    }

    return changed;
  }


  getLodTransition(): 'binary' | 'incremental' {
    return this.lodTransition;
  }

  setLodTransition(mode: 'binary' | 'incremental'): void {
    if (this.lodTransition === mode) return;
    this.lodTransition = mode;
    if (mode === 'binary') {
      for (const node of this.nodes.values()) {
        this._restoreNodePolygonOffset(node);
      }
      this.fallbackNodes.clear();
    }
  }

  private _applyNodeFallbackPolygonOffset(node: TileNode, depth: number): boolean {
    const factor = this.fallbackOffset.factor;
    const units = Math.max(2, (10 - Math.min(depth, 8)) * this.fallbackOffset.units);
    let changed = false;

    node.group.traverse((obj) => {
      const target = obj as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; material?: any };
      if ((target.isMesh || target.isPoints || target.isLine) && target.material) {
        const materials = Array.isArray(target.material) ? target.material : [target.material];
        for (const mat of materials) {
          if (!mat) continue;
          if (!mat.userData) mat.userData = {};
          if (!mat.userData._basePolygonOffset) {
            mat.userData._basePolygonOffset = {
              polygonOffset: mat.polygonOffset === true,
              factor: mat.polygonOffsetFactor ?? 0,
              units: mat.polygonOffsetUnits ?? 0,
            };
          }
          const base = mat.userData._basePolygonOffset;
          const targetFactor = base.factor + factor;
          const targetUnits = base.units + units;
          if (
            mat.polygonOffset !== true ||
            mat.polygonOffsetFactor !== targetFactor ||
            mat.polygonOffsetUnits !== targetUnits
          ) {
            mat.polygonOffset = true;
            mat.polygonOffsetFactor = targetFactor;
            mat.polygonOffsetUnits = targetUnits;
            changed = true;
          }
        }
      }
    });
    return changed;
  }

  private _restoreNodePolygonOffset(node: TileNode): boolean {
    let changed = false;
    node.group.traverse((obj) => {
      const target = obj as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; material?: any };
      if ((target.isMesh || target.isPoints || target.isLine) && target.material) {
        const materials = Array.isArray(target.material) ? target.material : [target.material];
        for (const mat of materials) {
          if (mat?.userData?._basePolygonOffset) {
            const base = mat.userData._basePolygonOffset;
            if (
              mat.polygonOffset !== base.polygonOffset ||
              mat.polygonOffsetFactor !== base.factor ||
              mat.polygonOffsetUnits !== base.units
            ) {
              mat.polygonOffset = base.polygonOffset;
              mat.polygonOffsetFactor = base.factor;
              mat.polygonOffsetUnits = base.units;
              changed = true;
            }
          }
        }
      }
    });
    return changed;
  }

  private _updateVisibilityIncremental(roots: Iterable<string>, visited: Set<string>): boolean {
    const nextPrimary = new Set<string>();
    const nextFallback = new Set<string>();
    const nodeDepths = new Map<string, number>();

    const traverse = (url: string, depth: number) => {
      if (visited.has(url)) return;
      visited.add(url);
      nodeDepths.set(url, depth);

      const node = this.nodes.get(url);
      if (!node) return;

      const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);
      const hasChildren = childUrls.length > 0;
      const readyChildren = childUrls.filter((cUrl) => this.nodes.has(cUrl));
      const missingChildren = childUrls.filter(
        (cUrl) => !this.nodes.has(cUrl) && !this.failed.has(cUrl)
      );

      const canRefine = !!node.needRefine && hasChildren && readyChildren.length > 0;

      if (canRefine) {
        if (missingChildren.length > 0) {
          nextFallback.add(url);
        }
        for (const cUrl of readyChildren) {
          traverse(cUrl, depth + 1);
        }
      } else {
        nextPrimary.add(url);
      }
    };

    for (const rootUrl of roots) {
      traverse(rootUrl, 0);
    }

    let changed = false;

    for (const [url, node] of this.nodes) {
      if (!visited.has(url)) continue;

      if (nextPrimary.has(url)) {
        if (!node.group.visible) {
          node.group.visible = true;
          changed = true;
        }
        const depth = nodeDepths.get(url) ?? 0;
        const targetOrder = 100 + depth;
        if (node.group.renderOrder !== targetOrder) {
          node.group.renderOrder = targetOrder;
          changed = true;
        }
        if (this._restoreNodePolygonOffset(node)) changed = true;
      } else if (nextFallback.has(url)) {
        if (!node.group.visible) {
          node.group.visible = true;
          changed = true;
        }
        const depth = nodeDepths.get(url) ?? 0;
        const targetOrder = depth;
        if (node.group.renderOrder !== targetOrder) {
          node.group.renderOrder = targetOrder;
          changed = true;
        }
        if (this._applyNodeFallbackPolygonOffset(node, depth)) changed = true;
      } else {
        if (node.group.visible) {
          node.group.visible = false;
          changed = true;
        }
        if (this._restoreNodePolygonOffset(node)) changed = true;
      }
    }

    this.primaryNodes.clear();
    for (const u of nextPrimary) this.primaryNodes.add(u);
    this.fallbackNodes.clear();
    for (const u of nextFallback) this.fallbackNodes.add(u);

    return changed;
  }
  dispose(): void {
    this._workerClient?.dispose();
    for (const node of this.nodes.values()) {
      node.group.traverse((o) => {
        const mesh = o as {
          geometry?: { dispose?: () => void };
          material?: { dispose?: () => void } | Array<{ dispose?: () => void }>;
        };
        mesh.geometry?.dispose?.();
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose?.());
        else mesh.material?.dispose?.();
      });
    }
    for (const tex of this.textureCache.values()) tex.dispose?.();
    this.textureCache.clear();
    this.nodes.clear();
  }
}
