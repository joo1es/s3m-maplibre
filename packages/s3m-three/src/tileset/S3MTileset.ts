/**
 * S3M 瓦片集：配置解析 + 按需加载 + LOD 判定
 *
 * LOD 规则（对应规范里的 RangeMode）：
 *   Pixel_Size_OnScreen(1) —— 用包围球投影到屏幕的像素半径与 rangeValue 比较
 *   Distance_From_EyePoint(0) —— 直接用相机到包围球中心的距离
 *   命中阈值就请求 childTile，实现渐进式细化。
 */
import { planDegradations } from '../core/degradations.js';
import type { UnsupportedPolicy } from '../core/degradations.js';
import { authFetch, type AuthenticateFn } from '../core/AuthFetch.js';
import type { S3MBlockAtlasImage, S3MBlockGroupSet } from '../core/S3MBlockParser.js';
import type { Anchor, ParsedTile, Stats, StyleUniforms } from '../core/types.js';
import type { TileGeometryData } from '../core/TileGeometry.js';
import { BlockAtlas } from './BlockAtlas.js';
import { TileBudget, estimateObjectGeometryBytes } from './TileBudget.js';
import { TileVisibility } from './TileVisibility.js';
import type { TileVisibilityOptions } from './TileVisibility.js';
import { TileSource } from './TileSource.js';
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
  readonly pending = new Set<string>();
  /** 是否请求 `.texblock` 子图集，默认关，见 S3MTilesetOptions.atlasLod */
  atlasLod: boolean;
  /** 根图集 id → 已拉到的清晰版子图集；null = 正在请求或确认没有，避免重复发请求 */
  readonly atlasLodCache = new Map<string, S3MBlockAtlasImage | null>();
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
  private _queue: string[] = [];
  private _active = 0;
  /** 图集补齐（leaf / texblock 请求 + LRU + 整图替换验证），见 tileset/BlockAtlas.ts */
  private readonly _atlas: BlockAtlas;
  /** 驻留预算与淘汰，见 tileset/TileBudget.ts */
  private readonly _budget: TileBudget;
  /** LOD 可见性与细化判定，见 tileset/TileVisibility.ts */
  private readonly _visibility: TileVisibility;
  /** 瓦片取源与解析，见 tileset/TileSource.ts */
  private readonly _source: TileSource;
  /** 块 URL → 该文件里的全部 LOD 组（一个 .s3mblock 是一棵子树，不是一块瓦片） */
  private readonly _groupCache = new Map<string, S3MBlockGroupSet>();
  /** 是否允许走 Worker 解析经典 .s3mb（`useWorker` 选项，默认开） */
  private readonly _useWorker: boolean;

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

    // Worker 解析开关：构造期快照，运行中不变
    this._useWorker = options.useWorker !== false;
    // 渲染层可注入：Node 环境下不需要 three，也能跑 URL / 解析链路
    this._bakeMercator = options.bakeMercator;
    this._polygonOffset = options.polygonOffset;
    this._materialQuality = options.materialQuality;
    this._colorPipeline = options.colorPipeline;
    this._textureOptions = options.textureOptions;
    // 着色器共享 uniform，由 S3MLayer 持有并传进来
    this._uniforms = options.uniforms ?? null;

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

    // 缓存实例留在主类（是公共字段，单测直接读写），BlockAtlas 只操作同一份引用；
    // 两个开关用取值函数而不是快照 —— maxImageCache 运行时可调。
    const self = this;
    this._atlas = new BlockAtlas({
      imageCacheLimit: () => self.maxImageCache,
      get authenticate() {
        return self.authenticate;
      },
      externalAtlasCache: this.externalAtlasCache,
      leafRequestCache: this.leafRequestCache,
      atlasUpgraded: this.atlasUpgraded,
      atlasUpgradeSkipped: this.atlasUpgradeSkipped,
    });

    this._budget = new TileBudget({
      nodes: this.nodes,
      pending: this.pending,
      textureCache: this.textureCache,
      stats: this.stats,
      parentOf: this._parentOf,
      onTileRemoved: (node) => self._onTileRemoved(node),
      maxTiles: () => self.maxTiles,
      maxTriangles: () => self.maxTriangles,
      maxMemory: () => self.maxMemory,
      hardCap: () => self.hardCap,
      lodTransition: () => self.lodTransition,
    });

    this._visibility = new TileVisibility({
      nodes: this.nodes,
      failed: this.failed,
      pending: this.pending,
      rootUrls: this.rootUrls,
      parentOf: this._parentOf,
      primaryNodes: this.primaryNodes,
      fallbackNodes: this.fallbackNodes,
      fallbackOffset: this.fallbackOffset,
      lodRangeScale: () => self.lodRangeScale,
      lodTransition: () => self.lodTransition,
      beginFrame: () => ++self._frame,
      frame: () => self._frame,
      enqueue: (url, parentUrl) => self._enqueue(url, parentUrl),
      trimBudget: () => self._budget.trimBudget(),
    });

    this._source = new TileSource(
      {
        authenticate: this.authenticate,
        groupCache: this._groupCache,
        useWorker: () => self._useWorker,
        vertexAttributeDescript: () => self.config?.vertexAttributeDescript,
        classicParser: (buffer) => self._parseClassicTile(buffer),
        blockParser: (buffer) => self._parseBlockGroups(buffer),
      },
      options.buildTile ?? null,
    );
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
    /** 记录瓦片引用的纹理 key，并递增其引用计数（实现在 tileset/TileBudget.ts） */
  registerTileTextures(url: string, textureKeys: string[]): void {
    this._budget.registerTileTextures(url, textureKeys);
  }

  /** 淘汰单块瓦片节点并释放专属纹理（实现在 tileset/TileBudget.ts） */
  _evictTileNode(victim: TileNode): void {
    this._budget.evictTileNode(victim);
  }

  /** 图集补齐全部委托给 tileset/BlockAtlas.ts；保留同名转发供既有单测调用 */
  private async _fillExternalAtlases(tile: ParsedTile, url: string): Promise<void> {
    return this._atlas.fillExternalAtlases(tile, url);
  }

  /** 存入外部图集（带 LRU 容量上限） */
  putExternalAtlas(id: string, img: S3MBlockAtlasImage | null): void {
    this._atlas.putExternalAtlas(id, img);
  }

  /** 读取外部图集 */
  getExternalAtlas(id: string): S3MBlockAtlasImage | null | undefined {
    return this._atlas.getExternalAtlas(id);
  }

  /** 存入 leaf 记录段（带 LRU 容量上限） */
  putLeafRecords(name: string, recs: S3MBlockAtlasImage[] | null): void {
    this._atlas.putLeafRecords(name, recs);
  }

  /** 读取 leaf 记录段 */
  getLeafRecords(name: string): S3MBlockAtlasImage[] | null | undefined {
    return this._atlas.getLeafRecords(name);
  }

    /** @internal 见 tileset/TileBudget.ts */
  _evictOne(allowUncovered = false): boolean {
    return this._budget.evictOne(allowUncovered);
  }

  /** @internal 见 tileset/TileBudget.ts */
  _pickVictim(allowRefined: boolean, allowUncovered = false): TileNode | null {
    return this._budget.pickVictim(allowRefined, allowUncovered);
  }

  /** @internal 见 tileset/TileBudget.ts */
  private _trimBudget(): boolean {
    return this._budget.trimBudget();
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
   * 当前驻留的显存与内存总字节数（几何缓冲精确大小 + 纹理显存估计）
   * 实现在 tileset/TileBudget.ts。
   */
  residentMemory(): number {
    return this._budget.residentMemory();
  }

  /** @internal 当前驻留瓦片的三角形总数，见 tileset/TileBudget.ts */
  _residentTriangles(): number {
    return this._budget.residentTriangles();
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

  /** 经典 `.s3mb` 解析（测试直接调用），实现在 tileset/TileSource.ts */
  private _parseClassicTile(buffer: ArrayBuffer): Promise<{ tile: ParsedTile; geometry?: TileGeometryData }> {
    return this._source.parseClassicTile(buffer);
  }

  /** S3MBLOCK 容器解析（测试直接调用），实现在 tileset/TileSource.ts */
  private _parseBlockGroups(buffer: ArrayBuffer): Promise<S3MBlockGroupSet> {
    return this._source.parseBlockGroups(buffer);
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
      // 取源与解析全在 tileset/TileSource.ts：`#N` 组引用、块缓存、Worker 降级都在那里
      const { tile, geometry: assembled, groupNames, baseUrl, isBlock } = await this._source.load(url);
      if (isBlock) {
        // 子瓦片的图集像素在独立 .texblock 里，必须先补齐，否则整块无贴图
        await this._fillExternalAtlases(tile, baseUrl);
        await this._atlas.upgradeAtlasLod(tile, baseUrl);
      }

      // 解析成功但能力不完整的（目前只有 3DGS），在花力气建几何之前先决定处置
      this._noteDegradations(tile);

            const lodForBake = this._pickLod(tile);
      if (this.rootRadius === undefined && lodForBake?.boundingSphere?.radius) {
        this.rootRadius = lodForBake.boundingSphere.radius;
      }
      const shouldBake = this.shouldBakeMercator(lodForBake?.boundingSphere?.radius);
      const build = await this._source.builder();
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
   * 每帧调度：算距离与像素尺寸、决定细化、分配显示职责、裁预算。
   * 实现在 tileset/TileVisibility.ts。
   *
   * @param camEnu 相机在该数据集局部 ENU 坐标系中的位置（米）
   * @param fovRad 垂直视场角（弧度）
   * @param screenHeight 视口像素高度
   * @returns 瓦片加载队列或可见性是否发生变化
   */
  update(
    camEnu: [number, number, number],
    fovRad: number,
    screenHeight: number,
    isVisible?: TileVisibilityTest,
    options?: TileVisibilityOptions
  ): boolean {
    return this._visibility.update(camEnu, fovRad, screenHeight, isVisible, options);
  }

  getLodTransition(): 'binary' | 'incremental' {
    return this.lodTransition;
  }

  setLodTransition(mode: 'binary' | 'incremental'): void {
    if (this.lodTransition === mode) return;
    this.lodTransition = mode;
    if (mode === 'binary') this._visibility.restoreAllPolygonOffsets();
  }

  dispose(): void {
    this._source.dispose();
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
