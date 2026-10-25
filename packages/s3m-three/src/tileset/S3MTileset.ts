/**
 * S3M 瓦片集：配置解析 + 按需加载 + LOD 判定
 *
 * LOD 规则（对应规范里的 RangeMode）：
 *   Pixel_Size_OnScreen(1) —— 用包围球投影到屏幕的像素半径与 rangeValue 比较
 *   Distance_From_EyePoint(0) —— 直接用相机到包围球中心的距离
 *   命中阈值就请求 childTile，实现渐进式细化。
 */
import { parseS3MB } from '../core/S3MBParser.js';
import { parseS3MBlock } from '../core/S3MBlockParser.js';
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

    return {
      fileType: tagVal('FileType') ?? undefined,
      position: { x: posX, y: posY, z: posZ, units: 'Degree' },
      geoBounds: { left, right, top, bottom },
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
  /** 格式类永久错误只向上报一次，避免整棵瓦片树刷同样的日志 */
  private _permanentReported = false;
  private _buildTile: BuildTileFn | null;
  private readonly _uniforms: StyleUniforms | null;
  private _queue: string[] = [];
  private _active = 0;

  constructor(options: S3MTilesetOptions) {
    this.configUrl = options.configUrl;
    this.lodRangeScale = options.lodRangeScale ?? 1.0;
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

    // OSGB 原生缓存（SuperMapCache / S3M 1.x）早点说清楚，别等几十块瓦片全失败才看出来。
    // 位置与范围是按配置反算出来的，所以视角会正确落到模型上，只是没有内容可渲染。
    const isV1OSGB =
      /OSGB/i.test(String(config.fileType ?? '')) ||
      /OSGB/i.test(String(config.dataType ?? '')) ||
      (this.rootUrls.length > 0 && this.rootUrls.every((u) => /\.s3m($|\?)/i.test(u)));
    if (isV1OSGB) {
      console.warn(
        '[s3m] 这是 OSGB 原生缓存（SuperMapCache，瓦片为 S3M 1.x 的 .s3m，下一级 LOD 是 .osgb），' +
          '本库只支持 S3MB 2.x / 3.x，不会渲染出内容。请把数据重新导出/发布成 S3M 瓦片缓存（.s3mb）。'
      );
    }

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
    // 满了就淘汰最久没被用到的，而不是干等着永远不再出图
    while (this.nodes.size + this.pending.size >= this.maxTiles) {
      if (!this._evictOne()) return;
    }
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
  private _evictOne(): boolean {
    const victim = this._pickVictim(false) ?? this._pickVictim(true);
    if (!victim) return false;

    const parentUrl = victim.parentUrl ?? this._parentOf.get(victim.url);
    const childUrls = victim.childUrls ?? (victim.childUrl ? [victim.childUrl] : []);
    const isLeaf = !childUrls.some((u) => u !== victim.url && this.nodes.has(u));

    this.nodes.delete(victim.url);
    victim.group.parent?.remove(victim.group);
    this._onTileRemoved(victim);
    this._parentOf.delete(victim.url);

    // 删的是最细一级、而上一级又不在内存里 → 把上一级排回去，别让那块地空着
    if (isLeaf && parentUrl && !this.nodes.has(parentUrl) && !this.pending.has(parentUrl)) {
      this._enqueue(parentUrl);
    }
    return true;
  }

  /**
   * 挑淘汰候选。
   * @param allowRefined false = 只挑叶子；true = 只挑「子节点已全部加载」的父瓦片
   */
  private _pickVictim(allowRefined: boolean): TileNode | null {
    let victim: TileNode | null = null;
    for (const node of this.nodes.values()) {
      const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);
      const refined = childUrls.length > 0 && childUrls.some((u) => u !== node.url && this.nodes.has(u));
      if (refined !== allowRefined) continue;
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

  private async _load(url: string): Promise<void> {
    if (this.nodes.has(url) || this.pending.has(url) || this.failed.has(url)) return;
    this.pending.add(url);
    this.stats.loading++;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} 加载瓦片失败: ${url}`);
      }
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('text/html')) {
        throw new Error(`瓦片请求返回了 HTML 页面（通常为 404/500 服务端拦截）: ${url}`);
      }
      const buffer = await res.arrayBuffer();
      // S3MBLOCK（TextureSharing / 单文件存储）走专用解析：容器 + 内嵌 v2 瓦片体 + 图集纹理
      const tile = /\.s3mblock($|\?)/i.test(url)
        ? await parseS3MBlock(buffer)
        : await parseS3MB(buffer);

      const build = await this._builder();
      const { group, stats } = await build(tile, { textureCache: this.textureCache, uniforms: this._uniforms });
      const lod = this._pickLod(tile);

      const childUrls: string[] = [];
      for (const l of tile.groupNode?.pageLods ?? []) {
        const u = resolveUrl(dirOf(url), l.childTile);
        if (u && u !== url && !childUrls.includes(u)) {
          if (this._blockTileIndex && !this._blockTileIndex.has(u)) continue;
          childUrls.push(u);
        }
      }

      const node: TileNode = {
        url,
        tile,
        group,
        sphere: lod?.boundingSphere ?? null,
        rangeValue: lod?.rangeValue ?? 0,
        rangeMode: lod?.rangeMode ?? 1,
        childUrl: childUrls[0] ?? resolveUrl(dirOf(url), lod?.childTile),
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
        // 屏幕像素半径
        metric = ((node.sphere.radius / dist) / Math.tan(fovRad / 2)) * screenHeight * 0.5;
      }

      // 在有效范围内（留一倍余量）的算「正在用」，淘汰时按这个帧号排优先级
      const scale = this.lodRangeScale > 0 ? this.lodRangeScale : 1.0;
      const threshold = node.rangeValue * scale;
      const inRange = byDistance ? dist < threshold * 2 : metric > threshold * 0.5;
      if (inRange) node.lastSeen = this._frame;

      const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);
      const needRefine = childUrls.length > 0 && (byDistance ? metric < threshold : metric > threshold);
      node.needRefine = needRefine;

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
    const roots = this.rootUrls.length > 0
      ? this.rootUrls
      : [...this.nodes.keys()].filter((u) => {
          const p = this.nodes.get(u)?.parentUrl;
          return !p || !this.nodes.has(p);
        });

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

    return hasChanges;
  }

  private _updateNodeVisibility(url: string, parentInBranch: boolean, visited: Set<string>): boolean {
    const node = this.nodes.get(url);
    if (!node) return false;
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
    const allChildrenReady = hasChildren && childUrls.every((cUrl) => this.nodes.has(cUrl));
    const anyChildFailed = childUrls.some((cUrl) => this.failed.has(cUrl));

    // 细化前提：需要细化、拥有子瓦片、子瓦片全部加载就绪且没有任何一个子瓦片失败
    const shouldRefine = !!node.needRefine && allChildrenReady && !anyChildFailed;

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
