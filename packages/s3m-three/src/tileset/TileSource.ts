/**
 * 瓦片取源与解析：URL 解引用、字节抓取、S3MBLOCK 组缓存、经典 `.s3mb` 的 Worker 解析。
 *
 * 从 `S3MTileset.ts` 搬出来（issue #27 的 P5 阶段），行为逐字未变。
 *
 * 边界划在「拿到 ParsedTile」为止，往后组装节点、补图集、建几何都留在宿主 ——
 * 因为那些步骤要写节点表、写统计、发回调，属于宿主的状态，不属于取源。
 *
 * 两条不能动的语义：
 *   ① URL 里的 `#N` 是「同一个 .s3mblock 文件里的第 N 个 LOD 组」，不是 fragment。
 *      一个块文件打包了一整棵 LOD 子树，下层瓦片不是独立文件，命中缓存就零请求。
 *   ② Worker 崩溃（`WorkerDeadError`）是**永久**降级：把 client 置 null 之后不再重试，
 *      避免每块瓦片都浪费一次超时。瓦片本身解析失败仍然照常抛，交给宿主重试。
 */
import { parseS3MB } from '../core/S3MBParser.js';
import { authFetch } from '../core/AuthFetch.js';
import type { AuthenticateFn } from '../core/AuthFetch.js';
import { parseS3MBlockGroups } from '../core/S3MBlockParser.js';
import type { S3MBlockGroupSet } from '../core/S3MBlockParser.js';
import type { ParsedTile } from '../core/types.js';
import type { TileGeometryData } from '../core/TileGeometry.js';
import { getSharedS3MWorker, S3MWorkerClient, WorkerDeadError } from '../worker/S3MWorkerClient.js';
import type { BuildTileFn } from './types.js';

/** 一次取源的产物：解析好的瓦片 + 它来自哪个块文件、是不是块容器 */
export interface LoadedTileSource {
  tile: ParsedTile;
  /** Worker 侧已组装好的纯数据几何（仅经典 `.s3mb` 路径） */
  geometry?: TileGeometryData;
  /** 块文件里全部 LOD 组的名字，用于把同文件内的子瓦指向 `#index` */
  groupNames: string[];
  /** 去掉 `#N` 之后的真实文件地址 */
  baseUrl: string;
  /** 是否 S3MBLOCK 容器 */
  isBlock: boolean;
}

/** `TileSource` 需要的宿主状态 */
export interface TileSourceHost {
  /** 鉴权适配函数 */
  readonly authenticate: AuthenticateFn | undefined;
  /** 块 URL → 该文件里的全部 LOD 组（LRU 24，实例由宿主持有） */
  readonly groupCache: Map<string, S3MBlockGroupSet>;
  /** 是否允许走 Worker 解析（`useWorker` 选项） */
  useWorker(): boolean;
  /** config 里声明的顶点属性语义，透传给解析器 */
  vertexAttributeDescript(): ParsedTile['vertexAttributeDescript'];
  /**
   * 经典 `.s3mb` 解析入口，**由宿主回注**而不是直接调 `parseClassicTile`。
   *
   * 单测把 `tileset._parseClassicTile` 整个替换成 stub 来喂假瓦片（`degradations.test.ts`），
   * 走内部方法会绕过这个替换点 —— 和 `S3MViewer` 里 `triggerRepaint` 是同一类接缝，
   * 绕过去测试当场变瞎。默认实现就是宿主那次转发，最终仍是本类的 `parseClassicTile`。
   */
  classicParser(buffer: ArrayBuffer): Promise<{ tile: ParsedTile; geometry?: TileGeometryData }>;
}

export class TileSource {
  /** 经典 .s3mb 的 Worker 解析客户端；undefined = 尚未尝试创建，null = 不可用/已降级 */
  private _workerClient: S3MWorkerClient | null | undefined;
  /** 几何构建器（懒加载 `render/GeometryBuilder`，测试可注入） */
  private _buildTile: BuildTileFn | null;

  constructor(
    private readonly host: TileSourceHost,
    buildTile: BuildTileFn | null
  ) {
    this._buildTile = buildTile;
  }

  /**
   * 取一块瓦片：命中块缓存就直接取组，否则抓字节再解析。
   *
   * 不在这里补图集、不在这里建几何 —— 那两步要写宿主状态。
   */
  async load(url: string): Promise<LoadedTileSource> {
    // URL 里的 `#N` 表示「同一个 .s3mblock 文件里的第 N 个 LOD 组」。
    // 一个块文件打包的是一整棵 LOD 子树（6_01 → 6_0100 → 6_010000 → …），
    // 这些下层瓦片**不是独立文件**，用 `#N` 直接命中已缓存的组，不再发请求。
    const hashAt = url.indexOf('#');
    const baseUrl = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const groupIndex = hashAt >= 0 ? Number(url.slice(hashAt + 1)) || 0 : 0;
    const isBlock = /\.s3mblock($|\?)/i.test(baseUrl);

    const cachedSet = this.host.groupCache.get(baseUrl);
    if (cachedSet) {
      return {
        tile: cachedSet.tiles[groupIndex] ?? cachedSet.tiles[0]!,
        groupNames: cachedSet.names,
        baseUrl,
        isBlock,
      };
    }

    const res = await authFetch(baseUrl, this.host.authenticate, 'tile');
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
      this.rememberGroups(baseUrl, set);
      return {
        tile: set.tiles[groupIndex] ?? set.tiles[0]!,
        groupNames: set.names,
        baseUrl,
        isBlock,
      };
    }

    const parsed = await this.host.classicParser(buffer);
    return { tile: parsed.tile, geometry: parsed.geometry, groupNames: [], baseUrl, isBlock };
  }

  /** 懒加载几何构建器：没有注入时动态 import，避免 Node 环境下拉进 three 渲染层 */
  async builder(): Promise<BuildTileFn> {
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
  async parseClassicTile(buffer: ArrayBuffer): Promise<{ tile: ParsedTile; geometry?: TileGeometryData }> {
    if (this.host.useWorker() && this._workerClient === undefined) {
      // 与纹理解码共用进程级单例，避免每个数据集各起一个 Worker
      this._workerClient = getSharedS3MWorker();
    }
    if (this._workerClient) {
      try {
        return await this._workerClient.parseTile(buffer, true, true, this.host.vertexAttributeDescript());
      } catch (e) {
        if (e instanceof WorkerDeadError) {
          // 脚本加载失败 / 崩溃属于环境问题，永久退回主线程；瓦片本身的问题照常抛
          this._workerClient = null;
        } else {
          throw e;
        }
      }
    }
    return { tile: await parseS3MB(buffer, { vertexAttributeDescript: this.host.vertexAttributeDescript() }) };
  }

  /**
   * 记住一个块文件里解析出来的全部 LOD 组。
   *
   * 一棵 LOD 子树的几层几何加图集动辄好几 MB，全数据集都留着会把内存吃光，
   * 所以只保留最近 24 个块（LRU 足够：相机在附近移动时命中的永远是同几个块）。
   */
  rememberGroups(baseUrl: string, set: S3MBlockGroupSet): void {
    const cache = this.host.groupCache;
    cache.delete(baseUrl);
    cache.set(baseUrl, set);
    while (cache.size > 24) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  /** 释放 Worker（`dispose()` 里调） */
  dispose(): void {
    this._workerClient?.dispose();
  }
}
