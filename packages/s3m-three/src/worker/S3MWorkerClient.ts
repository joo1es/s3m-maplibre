/**
 * 解析 Worker 的主线程客户端。
 *
 * 生命周期约定（由 S3MTileset 使用）：
 * - `create()` 返回 null = 环境不可用（无 Worker / 脚本同步创建失败），调用方直接走主线程解析；
 * - `parseTile()` 抛 `WorkerDeadError` = Worker 脚本加载失败或已崩溃，调用方应**永久**
 *   退回主线程解析（不要再给这个 client 发活，也别让每块瓦片都白白失败两轮重试）；
 * - 抛普通 Error = Worker 活着、但解析本身失败（网络字节坏了 / S3M1 容器永久错误等），
 *   语义与主线程 `parseS3MB` 抛错完全一致，原样向上传。
 */
import type { ParsedTile, S3MTexture } from '../core/types.js';
import type { DecodedTextureData } from '../core/TextureDecode.js';
import type { TileGeometryData } from '../core/TileGeometry.js';

/** Worker 崩溃 / 不可用 —— 与「瓦片数据本身有问题」区分开，调用方据此决定降级还是重试 */
export class WorkerDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerDeadError';
  }
}

interface ParseOkResponse {
  id: number;
  ok: true;
  tile: ParsedTile;
  geometry?: TileGeometryData;
}

interface TexOkResponse {
  id: number;
  ok: true;
  data: DecodedTextureData;
}

interface ErrResponse {
  id: number;
  ok: false;
  message: string;
  permanent: boolean;
}

type Response = ParseOkResponse | TexOkResponse | ErrResponse;

export class S3MWorkerClient {
  private readonly _worker: Worker;
  private _seq = 0;
  private readonly _pending = new Map<number, { resolve: (v: unknown) => void; reject: (err: unknown) => void }>();
  /** true = 已崩溃 / 已终止，后续请求直接拒绝 */
  dead = false;

  /** 创建失败返回 null（不抛），调用方据此走主线程解析 */
  static create(): S3MWorkerClient | null {
    if (typeof Worker === 'undefined') return null;
    try {
      // 路径锚定本模块的编译产物（dist/worker/s3mWorker.js）；
      // Vite 打包时会把这个 pattern 转成独立 worker 资产，IIFE 直引场景由死锁降级兜底
      const worker = new Worker(new URL('./s3mWorker.js', import.meta.url), { type: 'module' });
      return new S3MWorkerClient(worker);
    } catch {
      return null;
    }
  }

  private constructor(worker: Worker) {
    this._worker = worker;
    worker.onmessage = (e: MessageEvent<Response>) => {
      const msg = e.data;
      const waiter = this._pending.get(msg.id);
      if (!waiter) return;
      this._pending.delete(msg.id);
      if (!msg.ok) {
        // 还原主线程 parseS3MB 的错误形状：permanent 标记驱动瓦片级的「永久失败」分支
        const err = new Error(msg.message);
        (err as { permanent?: boolean }).permanent = msg.permanent;
        waiter.reject(err);
      } else if ('tile' in msg) {
        waiter.resolve({ tile: msg.tile, geometry: msg.geometry });
      } else {
        waiter.resolve(msg.data);
      }
    };
    worker.onerror = () => this._die('s3m 解析 Worker 加载失败/崩溃');
    worker.onmessageerror = () => this._die('s3m 解析 Worker 消息无法反序列化');
  }

  /**
   * 解析一块瓦片。buffer 会被 structured clone（不 transfer），主线程保留原 buffer 以便崩溃后降级重解。
   * assemble = true 时顺带在 Worker 里做纯数据几何组装，返回 { tile, geometry } 一次带回。
   */
  parseTile(
    buffer: ArrayBuffer,
    assemble = false,
    batching = true,
    vertexAttributeDescript?: unknown
  ): Promise<{ tile: ParsedTile; geometry?: TileGeometryData }> {
    if (this.dead) return Promise.reject(new WorkerDeadError('s3m 解析 Worker 已终止'));
    const id = ++this._seq;
    return new Promise<{ tile: ParsedTile; geometry?: TileGeometryData }>((resolve, reject) => {
      this._pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this._worker.postMessage({ type: 'parse', id, buffer, assemble, batching, vertexAttributeDescript });
    });
  }

  /**
   * 解码一张纹理（DXT / CRN / WEBP / RGB 系）。tex.data 走 structured clone，主线程保留原数据。
   * `maxSize` 交给 Worker 侧收口——缩放本身也是 CPU 活，放在 Worker 里主线程零成本。
   */
  decodeTexture(tex: S3MTexture, compressed = false, maxSize?: number): Promise<DecodedTextureData> {
    if (this.dead) return Promise.reject(new WorkerDeadError('s3m 解析 Worker 已终止'));
    const id = ++this._seq;
    return new Promise<DecodedTextureData>((resolve, reject) => {
      this._pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this._worker.postMessage({ type: 'tex', id, tex, compressed, maxSize });
    });
  }

  dispose(): void {
    this._die('dispose');
  }

  private _die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this._worker.terminate();
    } catch {
      /* 已死的 worker terminate 不会再抛 */
    }
    const err = new WorkerDeadError(`${reason}，退回主线程解析`);
    for (const waiter of this._pending.values()) waiter.reject(err);
    this._pending.clear();
  }
}

/* ------------------------------------------------------------------ 共享单例 */

/**
 * 进程级共享的解析 Worker（解析 + 纹理解码共用一个线程，避免每个数据集 /
 * 每个渲染层各起一个 Worker 把内存和调度打爆）。懒创建，崩溃后返回 null。
 */
let sharedClient: S3MWorkerClient | null | undefined;

export function getSharedS3MWorker(): S3MWorkerClient | null {
  if (sharedClient === undefined) sharedClient = S3MWorkerClient.create();
  if (sharedClient && sharedClient.dead) return null;
  return sharedClient;
}

/**
 * 纹理解码的「Worker 优先」入口，供 TextureFactory.setTextureOffThreadDecode 装配。
 * 永不 reject：Worker 不可用 / 崩溃 / 单张解码失败都返回 null，调用方主线程兜底
 * （解码失败本身在 decodeTextureData 里也不抛错，走 crn(failed) 之类的标记）。
 * compressed 由 TextureFactory 按宿主 GL 能力传入，Worker 端据此跳过 DXT 解码。
 */
export async function decodeTextureWithWorker(
  tex: S3MTexture,
  compressed: boolean,
  maxSize?: number
): Promise<DecodedTextureData | null> {
  const client = getSharedS3MWorker();
  if (!client) return null;
  try {
    return await client.decodeTexture(tex, compressed, maxSize);
  } catch {
    return null;
  }
}
