/**
 * S3M 解析 / 纹理解码 Worker 入口。
 *
 * 职责：把 CPU 密集的解码搬离主线程——
 *   - parse：`.s3mb`（含 S3M 1.x / Draco / MeshOpt 内联 wasm 解码）整块解析；
 *   - tex：  纹理解码（DXT 解块 / CRN wasm 转码 / WEBP createImageBitmap），
 *            与主线程共用 core/TextureDecode.ts 的同一份实现。
 * 抓取（fetch）仍由 S3MTileset 在主线程做——重试、退避、content-type 检查这些
 * 语义都留在原处不动，Worker 只收字节、吐纯数据结果。
 *
 * 协议：
 *   { type:'parse', id, buffer } → { id, ok:true, tile } | { id, ok:false, message, permanent }
 *   { type:'tex',  id, tex }     → { id, ok:true, data } | { id, ok:false, message }
 *
 * 线程安全：两个入口都无模块级可变状态；每次调用用独立的 reader / 解码器实例。
 */
import { parseS3MB } from '../core/S3MBParser.js';
import { decodeTextureData } from '../core/TextureDecode.js';
import { assembleTileGeometry } from '../core/TileGeometry.js';
import type { ParsedTile, S3MTexture } from '../core/types.js';
import type { TileGeometryData } from '../core/TileGeometry.js';
import { collectTransferables } from './transferables.js';

type ParseRequest = {
  type: 'parse';
  id: number;
  buffer: ArrayBuffer;
  /** 解析后顺带做纯数据几何组装（解交错 / 法线 / 合批），一次往返带回 */
  assemble?: boolean;
  batching?: boolean;
};
type TexRequest = { type: 'tex'; id: number; tex: S3MTexture; compressed?: boolean; maxSize?: number };
type Request = ParseRequest | TexRequest;

type ParseResponse =
  | { id: number; ok: true; tile: ParsedTile; geometry?: TileGeometryData }
  | { id: number; ok: false; message: string; permanent: boolean };

type TexResponse = { id: number; ok: true; data: Awaited<ReturnType<typeof decodeTextureData>> };

const ctx = self as unknown as Worker;

/** 纹理解码响应的传输清单：RGBA 像素 buffer + WEBP 的 ImageBitmap 都走零拷贝 */
function texTransferList(data: Awaited<ReturnType<typeof decodeTextureData>>): ArrayBuffer[] {
  const list = collectTransferables(data);
  if (data.bitmap) list.push(data.bitmap as unknown as ArrayBuffer);
  return list;
}

ctx.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  const { id } = msg;
  try {
    if (msg.type === 'parse') {
      const tile = await parseS3MB(msg.buffer);
      if (msg.assemble) {
        // 解析 + 组装一起做，避免 tile 回主线程后再整块克隆回来一次
        const geometry = assembleTileGeometry(tile, { batching: msg.batching });
        ctx.postMessage(
          { id, ok: true, tile, geometry } satisfies ParseResponse,
          [...collectTransferables(tile), ...collectTransferables(geometry)]
        );
      } else {
        // 响应整体过线（零拷贝）；请求 buffer 是主线程 structured clone 过来的副本，无需回传
        ctx.postMessage({ id, ok: true, tile } satisfies ParseResponse, collectTransferables(tile));
      }
    } else {
      const data = await decodeTextureData(msg.tex, { compressed: msg.compressed, maxSize: msg.maxSize });
      ctx.postMessage({ id, ok: true, data } satisfies TexResponse, texTransferList(data));
    }
  } catch (err) {
    const permanent = (err as { permanent?: boolean } | null)?.permanent === true;
    const message = String((err as Error | null)?.message ?? err);
    ctx.postMessage({ id, ok: false, message, permanent });
  }
};
