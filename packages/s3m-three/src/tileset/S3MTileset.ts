/**
 * S3M 瓦片集：配置解析 + 按需加载 + LOD 判定
 *
 * LOD 规则（对应规范里的 RangeMode）：
 *   Pixel_Size_OnScreen(1) —— 用包围球投影到屏幕的像素半径与 rangeValue 比较
 *   Distance_From_EyePoint(0) —— 直接用相机到包围球中心的距离
 *   命中阈值就请求 childTile，实现渐进式细化。
 */
import { parseS3MB } from '../core/S3MBParser.js';
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
    return new URL(rel, base).href;
  } catch {
    // base 不是合法绝对地址时，退化为手工拼接，避免静默拿到错误路径
    return `${dirOf(base)}${rel}`;
  }
}

/** 兼容解析 JSON 与 XML 格式的 SuperMap .scp / config 配置文件 */
function parseConfigText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    const tagVal = (tag: string): string | null => {
      const m = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tag}[^>]*>([^<]+)<\\/`, 'i').exec(trimmed);
      return m ? m[1].trim() : null;
    };
    const posX = parseFloat(tagVal('X') ?? '0');
    const posY = parseFloat(tagVal('Y') ?? '0');
    const posZ = parseFloat(tagVal('Z') ?? '0');

    const left = parseFloat(tagVal('Left') ?? '0');
    const right = parseFloat(tagVal('Right') ?? '0');
    const top = parseFloat(tagVal('Top') ?? '0');
    const bottom = parseFloat(tagVal('Bottom') ?? '0');

    const fileMatches = trimmed.matchAll(/<(?:[a-zA-Z0-9_-]+:)?FileName[^>]*>([^<]+)<\//gi);
    const tiles: Array<{ url: string }> = [];
    for (const m of fileMatches) {
      tiles.push({ url: m[1].trim() });
    }

    return {
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
   */
  private _resolveAnchor(config: Record<string, unknown>): Anchor {
    const raw = config.position as { point3D?: { x: number; y: number; z?: number }; x?: number; y?: number; z?: number } | undefined;
    const p = raw?.point3D ?? (raw as { x: number; y: number; z?: number } | undefined);
    const b = config.geoBounds as { left: number; bottom: number; right: number; top: number } | undefined;
    const centerLon = b ? (b.left + b.right) / 2 : undefined;
    const centerLat = b ? (b.bottom + b.top) / 2 : undefined;
    // ENU 原点在椭球面上，position.z 就是它的高度；用 heightRange.min 会引入垂直偏移
    const z = p?.z ?? 0;

    if (!p) return { lon: centerLon ?? 0, lat: centerLat ?? 0, height: 0 };

    const units = (config.position as { units?: string } | undefined)?.units ?? 'Degree';
    if (units !== 'Degree') return { lon: p.x!, lat: p.y!, height: z };

    const offLon = centerLon === undefined ? 0 : Math.abs(p.x! - centerLon);
    const offLat = centerLat === undefined ? 0 : Math.abs(p.y! - centerLat);
    if (offLon > 0.5 || offLat > 0.5) {
      console.warn('[s3m] position 与 geoBounds 不一致，改用 geoBounds 中心作为锚点', {
        position: p,
        geoBounds: b,
      });
      return { lon: centerLon!, lat: centerLat!, height: z };
    }
    return { lon: p.x!, lat: p.y!, height: z };
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
      const tile = await parseS3MB(buffer);

      const build = await this._builder();
      const { group, stats } = await build(tile, { textureCache: this.textureCache, uniforms: this._uniforms });
      const lod = this._pickLod(tile);

      const childUrls: string[] = [];
      for (const l of tile.groupNode?.pageLods ?? []) {
        const u = resolveUrl(dirOf(url), l.childTile);
        if (u && u !== url && !childUrls.includes(u)) {
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
      const attempts = (this._retryCount.get(url) ?? 0) + 1;
      this._retryCount.set(url, attempts);
      if (attempts <= this._maxRetries) {
        // 退避重试：不进 failed，下一帧 update() 会重新入队，避免网络抖一下就留个永久空洞
        this._retryAt.set(url, performance.now() + 800 * attempts);
      } else {
        // 只有重试耗尽的瓦片才计入 failed：瞬态失败下一轮就成功了，
        // 计进去会让状态栏永久挂着一个「N 个瓦片失败」的假警告
        this.stats.failed++;
        this.failed.add(url);
        this._retryAt.delete(url);
      }
      this._onError(e);
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
      if (node.rangeMode === 0) {
        metric = dist; // Distance_From_EyePoint：距离越小越该细化
      } else {
        // 屏幕像素半径
        metric = ((node.sphere.radius / dist) / Math.tan(fovRad / 2)) * screenHeight * 0.5;
      }

      // 在有效范围内（留一倍余量）的算「正在用」，淘汰时按这个帧号排优先级
      const scale = this.lodRangeScale > 0 ? this.lodRangeScale : 1.0;
      const threshold = node.rangeValue * scale;
      const inRange = node.rangeMode === 0 ? dist < threshold * 2 : metric > threshold * 0.5;
      if (inRange) node.lastSeen = this._frame;

      const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);
      const needRefine = childUrls.length > 0 && (node.rangeMode === 0 ? metric < threshold : metric > threshold);
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
