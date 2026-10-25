/**
 * S3M 瓦片集：配置解析 + 按需加载 + LOD 判定
 *
 * LOD 规则（对应规范里的 RangeMode）：
 *   Pixel_Size_OnScreen(1) —— 用包围球投影到屏幕的像素半径与 rangeValue 比较
 *   Distance_From_EyePoint(0) —— 直接用相机到包围球中心的距离
 *   命中阈值就请求 childTile，实现渐进式细化。
 */
import { parseS3MB } from '../core/S3MBParser.js';
import { parseS3MBlock, parseS3MBlockGroups, parseS3MBlockTextureFile } from '../core/S3MBlockParser.js';
import type { S3MBlockAtlasImage, S3MBlockGroupSet, S3MBlockTexture } from '../core/S3MBlockParser.js';
import type { Anchor, ParsedTile, Stats, StyleUniforms } from '../core/types.js';
import type { Group, Texture } from 'three';

function dirOf(url: string): string {
  return url.slice(0, url.lastIndexOf('/') + 1);
}

/**
 * 把任意 URL 转成绝对地址。
 * 关键：configUrl 常常是相对路径（如 '../../data/cbd.scp'），
 * 而 new URL(rel, 相对基准) 会抛异常，导致后续 childTile 全部解析错误。
 * 所以进 init 前必须先锚定到 document.baseURI。
 */
function toAbsolute(url: string): string {
  if (!url) return url;
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : undefined;
    return base ? new URL(url, base).href : new URL(url).href;
  } catch {
    return url;
  }
}

function resolveUrl(base: string, rel: string | null | undefined): string | null {
  if (!rel) return null;
  try {
    return fixPathEncoding(new URL(rel, base).href);
  } catch {
    // base 不是合法绝对地址时，退化为手工拼接，避免静默拿到错误路径
    return fixPathEncoding(`${dirOf(base)}${rel}`);
  }
}

/**
 * 修补路径里没被编码、但会被服务端改写的字符。
 *
 * 最典型的是 `+`：OSGB 转 S3M 的缓存瓦片名就是 `Tile_+002_+001`，而 iServer 的 Java 侧
 * 按 URLDecoder 解路径，未编码的 `+` 会变成空格 → 404「瓦片数据不存在」。
 * new URL() 的序列化器认为 `+` 在 path 里是合法字符，所以不会替我们编码，必须自己补上。
 * 只动 path，不动 query/hash：query 里的 `+` 本来就是空格的约定，改了反而换味。
 */
export function fixPathEncoding(url: string): string {
  if (!/[+ ]/.test(url)) return url;
  const hashAt = url.indexOf('#');
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const body = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = body.indexOf('?');
  const path = queryAt < 0 ? body : body.slice(0, queryAt);
  const query = queryAt < 0 ? '' : body.slice(queryAt);
  return `${path.replace(/\+/g, '%2B').replace(/ /g, '%20')}${query}${hash}`;
}

/** 每度对应的米数（等距圆柱近似），与 demo 里量测瓦片尺寸用的是同一套系数 */
const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON_EQUATOR = 111320;

/** 配置文件里的经纬度范围 */
export interface GeoBounds {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/**
 * 判断 config.geoBounds 是不是一张「真的能用」的经纬度范围。
 *
 * 挡掉三种情况：字段缺失 / 非有限值；超出经纬度量级（OSGB 那类只给米制局部坐标的，
 * 反算不出来就是这种）；以及退化成一条线或一个点的全 0 框。
 * 退化框尤其危险：拿它去 fitBounds 会把视角甩到几内亚湾 (0,0)，
 * 拿它去校验 position 又会把唯一正确的 position 判成异常。
 */
export function usableGeoBounds(b: unknown): GeoBounds | null {
  if (!b || typeof b !== 'object') return null;
  const g = b as Partial<GeoBounds>;
  const v = [g.left, g.bottom, g.right, g.top];
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const { left, bottom, right, top } = g as GeoBounds;
  if (Math.abs(left) > 180 || Math.abs(right) > 180 || Math.abs(top) > 90 || Math.abs(bottom) > 90) return null;
  if (right === left && top === bottom) return null;
  return { left, bottom, right, top };
}

/**
 * S3M 1.x（SuperMapCache）的子瓦地址。
 *
 * XML 的 RangeDataList 写的是切片时的原始文件名（`Tile_+002_+001_L16_0.osgb`），
 * 而 iServer 实际发布的是**同名换 .s3m 后缀**、并且插在 `datas/<数据源>/data/path/` 下：
 *   .../datas/Config/Tile_+002_+001/Tile_+002_+001.s3m                     ← 根
 *   .../datas/Config/data/path/Tile_+002_+001/Tile_+002_+001_L16_0.s3m     ← 子
 * 实测 L16/L17/L18 都是 200，`?sceneName=` 不参与寻址。
 */
export function s3m1ChildUrl(tileUrl: string, child: string | null | undefined): string | null {
  if (!child) return null;
  const name = child.replace(/\.(osgb|s3mb|s3m)$/i, '.s3m');
  // 根瓦地址：  <前缀>/datas/<数据源>/<瓦片目录>/<文件名>.s3m
  // 子瓦地址：  <前缀>/datas/<数据源>/data/path/<瓦片目录>/<子瓦名>.s3m
  const parts = tileUrl.split('/');
  const file = parts.pop() ?? '';
  const dir = parts.pop() ?? '';
  const datasIdx = parts.lastIndexOf('datas');
  if (!file || !dir || datasIdx < 1) {
    // 不像 datas/<ds>/<dir>/<file> 的结构，退回按父目录解析
    return resolveUrl(dirOf(tileUrl), name);
  }
  // 父瓦自己就已经在 data/path 下面了（再往下细化），那只换文件名，别再插一层
  const alreadyPath = parts[parts.length - 1] === 'path' && parts[parts.length - 2] === 'data';
  const base = alreadyPath ? `${parts.join('/')}/${dir}` : `${parts.join('/')}/data/path/${dir}`;
  return fixPathEncoding(`${base}/${name}`);
}

/** 兼容解析 JSON 与 XML 格式的 SuperMap .scp / config 配置文件（导出以便单测与自建数据集列表复用） */
export function parseConfigText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    const tagVal = (tag: string): string | null => {
      const m = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tag}[^>]*>([^<]+)<\\/`, 'i').exec(trimmed);
      return m ? m[1].trim() : null;
    };
    const num = (tag: string): number => parseFloat(tagVal(tag) ?? '');
    const posX = num('X') || 0;
    const posY = num('Y') || 0;
    const posZ = num('Z') || 0;

    let left = num('Left');
    let right = num('Right');
    let top = num('Top');
    let bottom = num('Bottom');

    // SuperMapCache（OSGB 转出来的那类 XML）压根不给经纬度范围，只给
    // 「以 Position 为原点、局部 ENU 米制」的 BoundingBox。不反算的话 geoBounds 就是
    // 全 0：getBounds() 会把视角甩到几内亚湾，_resolveAnchor 还会反过来把正确的
    // position 判成「与 geoBounds 不一致」而退回 (0,0)，位置错得彻彻底底。
    if (![left, right, top, bottom].every(Number.isFinite)) {
      const minX = num('MinX');
      const maxX = num('MaxX');
      const minY = num('MinY');
      const maxY = num('MaxY');
      if ([minX, maxX, minY, maxY].every(Number.isFinite) && posX && posY) {
        const kx = METERS_PER_DEG_LON_EQUATOR * Math.cos((posY * Math.PI) / 180);
        if (kx > 1e-6) {
          left = posX + minX / kx;
          right = posX + maxX / kx;
          bottom = posY + minY / METERS_PER_DEG_LAT;
          top = posY + maxY / METERS_PER_DEG_LAT;
        }
      }
    }

    const fileMatches = trimmed.matchAll(/<(?:[a-zA-Z0-9_-]+:)?FileName[^>]*>([^<]+)<\//gi);
    const tiles: Array<{ url: string }> = [];
    for (const m of fileMatches) {
      tiles.push({ url: m[1].trim() });
    }

    // SuperMapCache 用 MinHeight/MaxHeight 声明成果的高程范围（米）。
    // 不读出来的话 align: 'bottom' 无从计算 —— 这类 OSGB 数据的 z 是从 120m 起飞的，
    // 不贴地就会整片悬在地图上方，斜视下看起来像散在别处的碎片。
    const minH = num('MinHeight');
    const maxH = num('MaxHeight');

    return {
      fileType: tagVal('FileType') ?? undefined,
      position: { x: posX, y: posY, z: posZ, units: 'Degree' },
      geoBounds: { left, right, top, bottom },
      heightRange: Number.isFinite(minH) || Number.isFinite(maxH) ? { min: minH, max: maxH } : undefined,
      rootTiles: tiles,
      tiles,
    };
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

export interface TileNode {
  url: string;
  tile: ParsedTile;
  group: Group;
  sphere: { center: { x: number; y: number; z: number }; radius: number } | null;
  rangeValue: number;
  rangeMode: number;
  childUrl: string | null;
  childUrls?: string[];
  state: string;
  /** 最近一次 update() 到相机的距离（米），淘汰时按它排序 */
  distance?: number;
  /** 最近一次「在有效范围内」的帧号，越小越该被淘汰 */
  lastSeen?: number;
  /** 上一级瓦片的 URL（淘汰到最细一级时，要把上一级找回来补洞） */
  parentUrl?: string;
  /** 当前帧是否满足细化条件 */
  needRefine?: boolean;
}

/** 瓦片构建器可注入，用于测试 / 服务端渲染（此时不需要 three） */
export type BuildTileFn = (
  tile: ParsedTile,
  options: { textureCache: Map<string, Texture>; uniforms: StyleUniforms | null }
) => Promise<{ group: Group; stats: Partial<Stats> }>;

export interface S3MTilesetOptions {
  configUrl: string;
  maxTiles?: number;
  maxConcurrent?: number;
  buildTile?: BuildTileFn | null;
  uniforms?: StyleUniforms | null;
  onTile?: (node: TileNode) => void;
  /** 超过 maxTiles 被淘汰时回调，调用方要自己把场景里的对象和拾取表清掉 */
  onTileRemoved?: (node: TileNode) => void;
  onProgress?: (stats: Stats) => void;
  onError?: (error: unknown) => void;
  /** 单块瓦片加载失败后的重试次数，默认 2（退避 0.8s / 1.6s） */
  maxRetries?: number;
  /** LOD 切换范围缩放系数（默认 1.0），> 1 更倾向保留粗模，< 1 提前换细模 */
  lodRangeScale?: number;
  /**
   * 是否请求 `.texblock` 子图集（S3MBLOCK 根图集的清晰版）。**默认关**。
   *
   * 不是没实现，而是「换图不换归一化 rect」这条规则只在部分链上成立：实测三对样本里
   * 有一对的比例是 2.000×1.579（不成比例），打开后整场景建筑会碎成满屏空洞
   * （错裁到 alpha=0 的区域被 alphaTest 丢弃）。要安全启用必须先做逐图集一致性自检
   * （把子图集按归一化 rect 裁回来与根槽位比 alpha 轮廓 IoU + 色差），通过才换。
   * 度量方式见 `_tmp/atlas/rule2.mts`。
   */
  atlasLod?: boolean;
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
  readonly pending = new Set<string>();
  /** 是否请求 `.texblock` 子图集，默认关，见 S3MTilesetOptions.atlasLod */
  atlasLod: boolean;
  /** 根图集 id → 已拉到的清晰版子图集；null = 正在请求或确认没有，避免重复发请求 */
  readonly atlasLodCache = new Map<string, S3MBlockAtlasImage | null>();
  /** 块 URL → 该文件里的全部 LOD 组（一个 .s3mblock 是一棵子树，不是一块瓦片） */
  private readonly _groupCache = new Map<string, S3MBlockGroupSet>();
  /** 独立 `.texblock` 图集缓存：id → 图像；null 表示正在请求或确认不可用 */
  readonly externalAtlasCache = new Map<string, S3MBlockAtlasImage | null>();
  readonly stats: Stats = { tiles: 0, loading: 0, failed: 0, meshes: 0, vertices: 0, triangles: 0, datasets: 1 };

  maxConcurrent: number;
  maxTiles: number;
  lodRangeScale: number;

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
  /** 失败重试计数与下次可用时间，退避期间 _enqueue 会直接跳过 */
  private readonly _retryCount = new Map<string, number>();
  private readonly _retryAt = new Map<string, number>();
  /** 子瓦片 URL → 父瓦片 URL，用于淘汰后补洞 */
  private readonly _parentOf = new Map<string, string>();
  private _frame = 0;
  private _lodDbgOnce = false;
  /** 格式类永久错误只向上报一次，避免整棵瓦片树刷同样的日志 */
  private _permanentReported = false;
  /** 请求量的硬上限（软上限 maxTiles 的超额余量），见构造函数注释 */
  private hardCap = 96;
  /** 本数据集是 S3M 1.x（SuperMapCache，.s3m）：子瓦地址规则与 3.x 不同 */
  private isS3MV1 = false;
  private _buildTile: BuildTileFn | null;
  private readonly _uniforms: StyleUniforms | null;
  private _queue: string[] = [];
  private _active = 0;

  constructor(options: S3MTilesetOptions) {
    this.configUrl = options.configUrl;
    this.lodRangeScale = options.lodRangeScale ?? 3.0;
    this._onTile = options.onTile ?? (() => {});
    this._onTileRemoved = options.onTileRemoved ?? (() => {});
    this._onError = options.onError ?? ((e) => console.warn(e));
    this._onProgress = options.onProgress ?? (() => {});
    this._maxRetries = Math.max(0, options.maxRetries ?? 2);

    // 渲染层可注入：Node 环境下不需要 three，也能跑 URL / 解析链路
    this._buildTile = options.buildTile ?? null;
    // 着色器共享 uniform，由 S3MLayer 持有并传进来
    this._uniforms = options.uniforms ?? null;

    // 并发与总量限制：iServer 公开服务上别把人家打爆
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxTiles = options.maxTiles ?? 64;
    // 硬上限 = 软上限 + 余量。淘汰只在「新瓦片已经落地并接管显示」之后做（make-before-break），
    // 所以中间态允许临时超出 maxTiles；硬上限只用来挡住失控的请求量，不用于挤掉正在显示的内容。
    this.hardCap = this.maxTiles + Math.max(8, Math.ceil(this.maxTiles * 0.5));
    // 默认开启清晰版子图集：根图集是 level=0 的低清代理，拿它平铺就是一堆马赛克
    this.atlasLod = options.atlasLod !== false;
  }

  async init(): Promise<this> {
    this.configUrl = toAbsolute(this.configUrl);
    const res = await fetch(this.configUrl);
    if (!res.ok) throw new Error(`配置读取失败 ${res.status} ${this.configUrl}`);
    const text = await res.text();
    const config = parseConfigText(text);
    this.config = config;
    this.anchor = this._resolveAnchor(config);

    // iServer 的 realspace 配置用 rootTiles（可多棵树），桌面导出的用 tiles
    const roots = (config.rootTiles ?? config.tiles ?? []) as Array<{ url: string }>;
    if (!roots.length) throw new Error('配置中缺少 root tile');

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
  private _evictOne(allowUncovered = false): boolean {
    // 只挑安全候选：叶子 → 已被子瓦接手的父瓦。allowUncovered 仅在超出硬上限时开启（内存兜底）
    const victim = this._pickVictim(false, allowUncovered) ?? this._pickVictim(true, allowUncovered);
    if (!victim) return false;

    const parentUrl = victim.parentUrl ?? this._parentOf.get(victim.url);
    const childUrls = victim.childUrls ?? (victim.childUrl ? [victim.childUrl] : []);
    const isLeaf = !childUrls.some((u) => u !== victim.url && this.nodes.has(u));

    this.nodes.delete(victim.url);
    victim.group.parent?.remove(victim.group);
    this._onTileRemoved(victim);
    this._parentOf.delete(victim.url);

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
    if (isLeaf && parentUrl && !this.nodes.has(parentUrl) && !this.pending.has(parentUrl)) {
      this._enqueue(parentUrl);
    }
    return true;
  }

  /**
   * 预算裁剪 —— 必须在可见性算完之后调用（make-before-break）：
   * 新瓦片已经落地、也已经决定由谁负责显示，这时候才把没人依赖的那块裁掉。
   * 只踢「当前不显示」或「位置已被可见子瓦接手」的瓦片；挑不出安全候选时允许
   * 暂时超出 maxTiles，等下一帧再裁 —— 宁可多占一会儿内存，也不在画面上开洞。
   */
  private _trimBudget(): boolean {
    let removed = false;
    let guard = 0;
    // 在途的也算进"预期驻留数"：不然一批瓦片同时落地时会先把画面撑爆再疯狂裁
    while (this.nodes.size + this.pending.size > this.maxTiles && guard++ <= this.maxTiles + 8) {
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

  /**
   * 定位锚点。规范里 position 是局部 ENU 坐标系原点，
   * 但实际数据里 position 偶尔是生产时的占位值（与 geoBounds 不符），
   * 所以这里做一次一致性检查，不一致就退回 geoBounds 中心。
   *
   * 前提是 geoBounds 真的可用：OSGB/SuperMapCache 这类配置只给米制局部包围盒，
   * 全 0 的退化框不能反过来否定一个正常的 position —— 那等于把模型甩到 (0,0)。
   */
  private _resolveAnchor(config: Record<string, unknown>): Anchor {
    const raw = config.position as
      | {
          point3D?: { x: number; y: number; z?: number };
          x?: number;
          y?: number;
          z?: number;
          units?: string;
          unit?: string;
        }
      | undefined;
    const p = raw?.point3D ?? (raw as { x: number; y: number; z?: number } | undefined);
    const okP = !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
    const b = usableGeoBounds(config.geoBounds);
    const centerLon = b ? (b.left + b.right) / 2 : undefined;
    const centerLat = b ? (b.bottom + b.top) / 2 : undefined;
    // ENU 原点在椭球面上，position.z 就是它的高度；用 heightRange.min 会引入垂直偏移
    const z = p?.z ?? 0;

    if (!okP) return { lon: centerLon ?? 0, lat: centerLat ?? 0, height: 0 };

    // 两种写法都得认：老数据是 position.units，v3.01 起改成了 position.unit
    const units = raw?.units ?? raw?.unit ?? 'Degree';
    if (units !== 'Degree') return { lon: p!.x!, lat: p!.y!, height: z };

    const offLon = centerLon === undefined ? 0 : Math.abs(p!.x! - centerLon);
    const offLat = centerLat === undefined ? 0 : Math.abs(p!.y! - centerLat);
    if (offLon > 0.5 || offLat > 0.5) {
      console.warn('[s3m] position 与 geoBounds 不一致，改用 geoBounds 中心作为锚点', {
        position: p,
        geoBounds: b,
      });
      return { lon: centerLon!, lat: centerLat!, height: z };
    }
    return { lon: p!.x!, lat: p!.y!, height: z };
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
   * 把 S3MBLOCK 根图集换成同排布的清晰版（`.texblock` 子图集）。
   *
   * 根图集只是 level=0 的低清代理：实测一张 48×64 的槽位在子图集里是 96×128，
   * 拿它平铺几十次就是一堆棕色马赛克。子图集文件里没有自己的 subTexInfos，
   * 官方（`requestSubTextures`）的做法就是整体换图、rect 照旧——因为两者是同一套
   * 排布的等比放大（归一化 rect 直接搬，alpha 轮廓 IoU 0.85~1.00）。
   *
   * 只认「更大且字节能完整解析」的子图集；请求失败/尺寸不合法就保留根图集。
   */
  /**
   * 补齐「图集像素不在块文件里」的那一半。
   *
   * 根瓦片（如 6.s3mblock）的图集是内嵌的（isSaveData=1）；但**子瓦片**（6_00 / 6_01）
   * 的图集段只有元信息：`data = null` + `requestNames = ['-704919438.texblock']`，
   * 像素在同目录的独立 `.texblock` 文件里（实测尺寸与声明逐字一致：192×128 / 204×384，
   * 内容按 1 B/px 的 DXT5 排布）。
   *
   * 不补这一步的后果不是「糊一点」，而是子瓦片整块无贴图：`tile.textures` 里根本没有
   * 这条纹理，材质拿不到 map，建筑变成纯白几何——精细 LOD 一旦真的加载进来就会显露。
   */
  private async _fillExternalAtlases(tile: ParsedTile, url: string): Promise<void> {
    const blockTile = tile as ParsedTile & { texturePackage?: Record<string, S3MBlockTexture> };
    const tp = blockTile.texturePackage;
    if (!tp) return;
    const jobs: Promise<void>[] = [];

    for (const [id, tex] of Object.entries(tp)) {
      // 已经拼合成一张大图的块：像素是我们自己重新排过的，再拿单张高清图覆盖会整张错位
      if ((tex as { packed?: boolean }).packed) continue;
      // 高清子图集：requestNames 是子瓦片「像素在独立文件里」的情形，
      // childTexNames 才是根图集挂的「同一套排布的清晰版」。
      // 根块常常自带一份内嵌 data，但它是低分辨率缩略图（实测 120x184 对高清 300x304）——
      // 一张 120x184 的图集装 26 个槽位，每个槽位只能画一整栋楼的缩略图，
      // 贴到墙上就是「满墙小楼照片」。官方一律用 childTexNames 指向的清晰版。
      const names = [...(tex.requestNames ?? []), ...(tex.childTexNames ?? [])];
      if (!names.length) continue;

      const cached = this.externalAtlasCache.get(id);
      const apply = (img: S3MBlockAtlasImage) => {
        // 覆盖解析阶段按内嵌缩略图填好的那份；请求失败时不会走到这里，原样保留
        tex.data = img.data;
        tex.compressType = img.compressType;
        tex.pixelFormat = img.pixelFormat;
        tile.textures[id] = {
          code: id,
          level: tex.level,
          // 必须用清晰版自己的尺寸：块里声明的 120x184 只是缩略图大小，
          // 拿它去解码 300x304 的像素会整张错位。subTexInfos 的 rect 是归一化的，
          // 换图不换归一化坐标，所以不受影响。
          width: img.width || tex.width,
          height: img.height || tex.height,
          compressType: img.compressType,
          pixelFormat: img.pixelFormat,
          data: img.data,
          flipY: true,
        };
      };

      if (cached === null) continue; // 正在请求 / 确认不可用
      if (cached) {
        apply(cached);
        continue;
      }
      this.externalAtlasCache.set(id, null);
      jobs.push(
        (async () => {
          for (const name of names) {
            const u = resolveUrl(dirOf(url), name);
            if (!u) continue;
            try {
              const res = await fetch(u);
              if (!res.ok) continue;
              const imgs = await parseS3MBlockTextureFile(await res.arrayBuffer());
              const img = imgs[0];
              if (!img) continue;
              this.externalAtlasCache.set(id, img);
              apply(img);
              return;
            } catch {
              // 换下一个候选名；全失败就保持无贴图，由上层照常渲染几何
            }
          }
        })()
      );
    }
    if (jobs.length) await Promise.all(jobs);
  }

  private async _upgradeAtlasLod(tile: ParsedTile, url: string): Promise<void> {
    if (!this.atlasLod) return; // 默认关，见 S3MTilesetOptions.atlasLod
    const blockTile = tile as ParsedTile & { texturePackage?: Record<string, { childTexNames?: string[]; width: number; height: number }> };
    const tp = blockTile.texturePackage;
    if (!tp) return;
    const jobs: Promise<void>[] = [];

    for (const [id, tex] of Object.entries(tp)) {
      if ((tex as { packed?: boolean }).packed) continue;
      const childName = (tex.childTexNames ?? [])[0];
      const apply = (best: S3MBlockAtlasImage) => {
        const t = tile.textures[id];
        if (!t) return;
        t.width = best.width;
        t.height = best.height;
        t.compressType = best.compressType;
        t.pixelFormat = best.pixelFormat;
        t.data = best.data;
        // 换了像素就得重解码：缓存里那份是按旧尺寸解的
        this.textureCache.delete(id);
      };

      // 同一张图集会被很多瓦片引用：拉过就复用，没拉过才发请求
      const cached = this.atlasLodCache.get(id);
      if (cached === null) continue; // 正在请求 / 已确认没有清晰版
      if (cached) {
        if (cached.width * cached.height > tex.width * tex.height) apply(cached);
        continue;
      }
      if (!childName) continue;
      this.atlasLodCache.set(id, null);
      const childUrl = resolveUrl(url, childName);
      if (!childUrl) continue;
      jobs.push(
        (async () => {
          try {
            const res = await fetch(childUrl);
            if (!res.ok) return;
            const imgs = await parseS3MBlockTextureFile(await res.arrayBuffer());
            const best = imgs.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a), imgs[0]!);
            // 只接受清晰版：像素数必须严格大于根图集，否则宁可保留原图
            if (best.width * best.height <= tex.width * tex.height) return;
            this.atlasLodCache.set(id, best);
            apply(best);
          } catch {
            // 子图集是增强项，拿不到就用根图集，不该拖垮整块瓦片
          }
        })()
      );
    }
    if (jobs.length) await Promise.all(jobs);
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
      let groupNames: string[] = [];
      const cachedSet = this._groupCache.get(baseUrl);
      if (cachedSet) {
        groupNames = cachedSet.names;
        tile = cachedSet.tiles[groupIndex] ?? cachedSet.tiles[0]!;
      } else {
        const res = await fetch(baseUrl);
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
          tile = await parseS3MB(buffer);
        }
      }
      if (isBlock) {
        // 子瓦片的图集像素在独立 .texblock 里，必须先补齐，否则整块无贴图
        await this._fillExternalAtlases(tile, baseUrl);
        await this._upgradeAtlasLod(tile, baseUrl);
      }

      const build = await this._builder();
      const { group, stats } = await build(tile, { textureCache: this.textureCache, uniforms: this._uniforms });
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
  update(camEnu: [number, number, number], fovRad: number, screenHeight: number): boolean {
    this._frame++;
    let hasChanges = false;

    for (const node of this.nodes.values()) {
      if (!node.sphere) {
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
      const needRefine = childUrls.length > 0 && (byDistance ? metric < threshold : metric > threshold);
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

    for (const rootUrl of roots) {
      if (this._updateNodeVisibility(rootUrl, true, visited)) {
        hasChanges = true;
      }
    }

    // 防御：若有任何未被 root 树访问到的游离瓦片，全部隐藏
    for (const [url, node] of this.nodes) {
      if (!visited.has(url)) {
        if (node.group.visible) {
          node.group.visible = false;
          hasChanges = true;
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

  dispose(): void {
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
