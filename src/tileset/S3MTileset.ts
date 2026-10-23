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

export interface TileNode {
  url: string;
  tile: ParsedTile;
  group: Group;
  sphere: { center: { x: number; y: number; z: number }; radius: number } | null;
  rangeValue: number;
  rangeMode: number;
  childUrl: string | null;
  state: string;
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
  onProgress?: (stats: Stats) => void;
  onError?: (error: unknown) => void;
}

export class S3MTileset {
  configUrl: string;
  config: Record<string, unknown> | null = null;
  anchor: Anchor = { lon: 0, lat: 0, height: 0 };

  readonly nodes = new Map<string, TileNode>();
  readonly failed = new Set<string>();
  readonly textureCache = new Map<string, Texture>();
  readonly pending = new Set<string>();
  readonly stats: Stats = { tiles: 0, loading: 0, failed: 0, meshes: 0, vertices: 0, triangles: 0, datasets: 1 };

  maxConcurrent: number;
  maxTiles: number;

  private readonly _onTile: (node: TileNode) => void;
  private readonly _onError: (error: unknown) => void;
  private readonly _onProgress: (stats: Stats) => void;
  private _buildTile: BuildTileFn | null;
  private readonly _uniforms: StyleUniforms | null;
  private _queue: string[] = [];
  private _active = 0;

  constructor(options: S3MTilesetOptions) {
    this.configUrl = options.configUrl;
    this._onTile = options.onTile ?? (() => {});
    this._onError = options.onError ?? ((e) => console.warn(e));
    this._onProgress = options.onProgress ?? (() => {});

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
    const config = JSON.parse(text) as Record<string, unknown>;
    this.config = config;
    this.anchor = this._resolveAnchor(config);

    // iServer 的 realspace 配置用 rootTiles（可多棵树），桌面导出的用 tiles
    const roots = (config.rootTiles ?? config.tiles ?? []) as Array<{ url: string }>;
    if (!roots.length) throw new Error('配置中缺少 root tile');

    // 首棵树同步加载，保证 init 返回时已有内容可渲染
    await this._load(resolveUrl(this.configUrl, roots[0].url)!);
    for (const r of roots.slice(1)) this._enqueue(resolveUrl(this.configUrl, r.url));

    return this;
  }

  private _enqueue(url: string | null): void {
    if (!url) return;
    if (this.nodes.has(url) || this.pending.has(url) || this.failed.has(url)) return;
    if (this._queue.includes(url)) return;
    if (this.nodes.size + this.pending.size >= this.maxTiles) return;
    this._queue.push(url);
    this._pump();
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
        // 404 通常意味着数据树在这里被截断（样例数据常见），不是渲染错误
        throw new Error(`${res.status} ${url}`);
      }
      const buffer = await res.arrayBuffer();
      const tile = await parseS3MB(buffer);

      const build = await this._builder();
      const { group, stats } = await build(tile, { textureCache: this.textureCache, uniforms: this._uniforms });
      const lod = this._pickLod(tile);

      const node: TileNode = {
        url,
        tile,
        group,
        sphere: lod?.boundingSphere ?? null,
        rangeValue: lod?.rangeValue ?? 0,
        rangeMode: lod?.rangeMode ?? 1,
        childUrl: resolveUrl(dirOf(url), lod?.childTile),
        state: 'ready',
      };

      this.nodes.set(url, node);
      this.stats.tiles++;
      this.stats.meshes += stats.meshes ?? 0;
      this.stats.vertices += stats.vertices ?? 0;
      this.stats.triangles += stats.triangles ?? 0;

      this._onTile(node);
    } catch (e) {
      this.stats.failed++;
      this.failed.add(url);
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
   */
  update(camEnu: [number, number, number], fovRad: number, screenHeight: number): void {
    for (const node of this.nodes.values()) {
      if (!node.childUrl || !node.sphere) continue;
      if (this.failed.has(node.childUrl)) continue;

      const c = node.sphere.center;
      const dx = c.x - camEnu[0];
      const dy = c.y - camEnu[1];
      const dz = c.z - camEnu[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;

      let metric: number;
      if (node.rangeMode === 0) {
        metric = dist; // Distance_From_EyePoint：距离越小越该细化
      } else {
        // 屏幕像素半径
        metric = ((node.sphere.radius / dist) / Math.tan(fovRad / 2)) * screenHeight * 0.5;
      }

      const needRefine = node.rangeMode === 0 ? metric < node.rangeValue : metric > node.rangeValue;
      if (needRefine) this._enqueue(node.childUrl);
    }
  }

  dispose(): void {
    for (const node of this.nodes.values()) {
      node.group.traverse((o) => {
        (o as { geometry?: { dispose?: () => void } }).geometry?.dispose?.();
      });
    }
    for (const tex of this.textureCache.values()) tex.dispose?.();
    this.textureCache.clear();
    this.nodes.clear();
  }
}
