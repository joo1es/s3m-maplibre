/**
 * S3M 解析 / 纹理解码 Worker 入口。
 *
 * 职责：把 CPU 密集的解码搬离主线程——
 *   - parse：`.s3mb`（含 S3M 1.x / Draco / MeshOpt 内联 wasm 解码）整块解析；
 *   - block：`.s3mblock` 容器（一整棵 LOD 子树，逐组 inflate + 图集解码）；
 *   - tex：  纹理解码（DXT 解块 / CRN wasm 转码 / WEBP createImageBitmap），
 *            与主线程共用 core/TextureDecode.ts 的同一份实现。
 * 抓取（fetch）仍由 S3MTileset 在主线程做——重试、退避、content-type 检查这些
 * 语义都留在原处不动，Worker 只收字节、吐纯数据结果。
 *
 * 协议：
 *   { type:'parse', id, buffer } → { id, ok:true, tile } | { id, ok:false, message, permanent }
 *   { type:'block', id, buffer } → { id, ok:true, set  } | { id, ok:false, message, permanent }
 *   { type:'tex',  id, tex }     → { id, ok:true, data } | { id, ok:false, message }
 *
 * 线程安全：两个入口都无模块级可变状态；每次调用用独立的 reader / 解码器实例。
 */
import { parseS3MB } from '../core/S3MBParser.js';
import { parseS3MBlockGroups } from '../core/S3MBlockParser.js';
import type { S3MBlockGroupSet } from '../core/S3MBlockParser.js';
import { decodeTextureData } from '../core/TextureDecode.js';
import { decodeAtlasImage } from '../core/AtlasPack.js';
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
  vertexAttributeDescript?: unknown;
};
type BlockRequest = { type: 'block'; id: number; buffer: ArrayBuffer };
type TexRequest = {
  type: 'tex';
  id: number;
  tex: S3MTexture;
  compressed?: boolean;
  maxSize?: number;
  /** 与 DecodeOptions 同义（图集直传：跳过翻行 / 只取 level0） */
  opts?: { allowCompressedFlipY?: boolean; onlyLevel0?: boolean };
};
/**
 * 块图集解码：主线程把「将要被 composeLeafAtlas / packAtlases 解码的原始缓冲」一次性丢过来，
 * 这里用同一份 `decodeAtlasImage` 解好、零拷贝传回。主线程随后照常调同步函数，
 * 命中的缓冲不再重复解块（见 core/atlasDecodeCache.ts）。
 */
type AtlasRequest = {
  type: 'atlas';
  id: number;
  items: Array<{ width: number; height: number; pixelFormat: number; compressType: number; data: Uint8Array }>;
};
type Request = ParseRequest | BlockRequest | TexRequest | AtlasRequest;

type ParseResponse =
  | { id: number; ok: true; tile: ParsedTile; geometry?: TileGeometryData }
  | { id: number; ok: false; message: string; permanent: boolean };

type BlockResponse =
  | { id: number; ok: true; set: S3MBlockGroupSet }
  | { id: number; ok: false; message: string; permanent: boolean };

type TexResponse = { id: number; ok: true; data: Awaited<ReturnType<typeof decodeTextureData>> };

/** 图集解码结果：`null` = 这条本来就是 RGBA，主线程走自己的快路径 */
type AtlasResponse = {
  id: number;
  ok: true;
  images: Array<{ rgba: Uint8Array; topDown: boolean } | null>;
};

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
      const tile = await parseS3MB(msg.buffer, { vertexAttributeDescript: msg.vertexAttributeDescript });
      if (msg.assemble) {
        // 解析 + 组装一起做，避免 tile 回主线程后再整块克隆回来一次
        const geometry = assembleTileGeometry(tile, {
          batching: msg.batching,
          vertexAttributeDescript: msg.vertexAttributeDescript,
        });
        ctx.postMessage(
          { id, ok: true, tile, geometry } satisfies ParseResponse,
          [...collectTransferables(tile), ...collectTransferables(geometry)]
        );
      } else {
        // 响应整体过线（零拷贝）；请求 buffer 是主线程 structured clone 过来的副本，无需回传
        ctx.postMessage({ id, ok: true, tile } satisfies ParseResponse, collectTransferables(tile));
      }
    } else if (msg.type === 'block') {
      // 整个 .s3mblock 容器在这里解析：inflate（DecompressionStream）+ 逐组段目录 +
      // 图集解码全在 Worker，主线程只接纯数据结果。
      const set = await parseS3MBlockGroups(msg.buffer);
      ctx.postMessage({ id, ok: true, set } satisfies BlockResponse, collectTransferables(set));
    } else if (msg.type === 'atlas') {
      // 逐条解 DXT 图集：解出来的 RGBA 是新分配的缓冲，可以整块 transfer 回主线程
      const images: Array<{ rgba: Uint8Array; topDown: boolean } | null> = [];
      const transfer: ArrayBuffer[] = [];
      for (const it of msg.items) {
        const img = decodeAtlasImage(it);
        if (!img) {
          images.push(null);
          continue;
        }
        images.push({ rgba: img.rgba, topDown: img.topDown });
        // 只 transfer 我们自己新分配的（RGBA 快路径返回的是输入缓冲本身，不能转）
        if (img.rgba.buffer !== it.data.buffer) transfer.push(img.rgba.buffer as ArrayBuffer);
      }
      ctx.postMessage({ id, ok: true, images } satisfies AtlasResponse, transfer);
    } else {
      const data = await decodeTextureData(msg.tex, {
        compressed: msg.compressed,
        maxSize: msg.maxSize,
        ...msg.opts,
      });
      ctx.postMessage({ id, ok: true, data } satisfies TexResponse, texTransferList(data));
    }
  } catch (err) {
    const permanent = (err as { permanent?: boolean } | null)?.permanent === true;
    const message = String((err as Error | null)?.message ?? err);
    ctx.postMessage({ id, ok: false, message, permanent });
  }
};
