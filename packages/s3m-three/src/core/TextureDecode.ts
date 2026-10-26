/**
 * S3M 纹理解码（three 无关，主线程 / Worker 共用同一份实现）
 *
 * 职责到「解出像素数据」为止：DXT 族解块成 RGBA8、CRN 先用 crunch wasm 转码回 DXT
 * 再解块、WEBP 交给 createImageBitmap、RGB 系逐像素重排。产出是纯数据
 * （DecodedTextureData），包成 three 对象由渲染层的 TextureFactory 负责——
 * 这样整份文件可以原样搬进 Worker 跑。
 *
 * 该走哪条解码路径由 compressType 判定（见 core/TextureFormat.ts）：
 * v3.00 的 CRN 纹理 pixelFormat 是 13（ABGR）、行标的 CRN 是 32856（GL_RGBA8），
 * 都不是 26 / 27，所以判定只能看 compressType，不能看 pixelFormat。
 */
import DXTTextureDecode from './DXTTextureDecode.js';
import { transcodeCRN } from './CRNDecode.js';
import { dxtPixelFormatOf, resolveTextureKind, PixelFormat } from './TextureFormat.js';
import type { S3MTexture } from './types.js';

/** 解码产物：rgba 与 bitmap 二选一，都为 null = 解码失败 / 格式不支持 */
export interface DecodedTextureData {
  /** 实际走的解码路径（'crn->dxt5' / 'dxt1' / 'raw' / 'webp' / 'crn(failed)' / 'unsupported(...)'） */
  kind: string;
  width: number;
  height: number;
  /** RGBA8 像素（已按需翻行） */
  rgba: Uint8Array | null;
  /** WEBP 路径的解码结果（ImageBitmap 可 transfer，主线程直接 new THREE.Texture 包） */
  bitmap: ImageBitmap | null;
  hasAlpha: boolean;
  /**
   * 压缩直传模式（decodeTextureData 的 compressed 选项）：不解码，原样返回 DXT 块，
   * 主线程用 CompressedTexture 硬件解压上传。与 rgba 互斥。
   */
  blocks?: Uint8Array;
  blockFormat?: 'dxt1' | 'dxt5';
  /** CRN 转码失败时的原始错误（渲染层负责打 warn） */
  error?: string;
}

export interface DecodeOptions {
  /**
   * 压缩直传：dxt1/dxt5（含 CRN 转码产物）不解码，原样返回 DXT 块。
   * 仅在宿主支持 WEBGL_compressed_texture_s3tc(+srgb) 时开启；
   * flipY 纹理走不了压缩上传（WebGL 对压缩纹理忽略 UNPACK_FLIP_Y），自动回退解码。
   */
  compressed?: boolean;
}

/** 行序翻转（原地）。S3MBLOCK 图集按 GL 方向存储（v=0 在最后一行），解码后要翻一次行 */
function flipRows(rgba: Uint8Array, width: number, height: number): void {
  const row = width * 4;
  const tmp = new Uint8Array(row);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row;
    const b = (height - 1 - y) * row;
    tmp.set(rgba.subarray(a, a + row));
    rgba.copyWithin(a, b, b + row);
    rgba.set(tmp, b);
  }
}

/** 该像素格式自带 alpha 通道（DXT1 的 1bit alpha 不算，历史上没开过 alphaTest） */
function hasAlphaChannel(pixelFormat: number): boolean {
  return (
    pixelFormat === PixelFormat.DXT3 ||
    pixelFormat === PixelFormat.DXT4 ||
    pixelFormat === PixelFormat.DXT5 ||
    pixelFormat === PixelFormat.ARGB ||
    pixelFormat === PixelFormat.ABGR ||
    pixelFormat === PixelFormat.BGRA ||
    pixelFormat === PixelFormat.RGBA
  );
}

/** 解 DXT 到 RGBA8。DXT5 是 1 字节/像素，DXT1 是 0.5 字节/像素。 */
/** DXT 解码只需要尺寸 / 格式 / 字节，CRN 转码出来的结果也走这条路 */
function decodeDXT(tex: Pick<S3MTexture, 'width' | 'height' | 'pixelFormat' | 'data' | 'flipY'>): {
  rgba: Uint8Array;
  hasAlpha: boolean;
} {
  const { width, height, pixelFormat, data } = tex;
  const out = new Uint8Array(width * height * 4);
  DXTTextureDecode.decode(out, width, height, data, pixelFormat);
  if (tex.flipY) flipRows(out, width, height);
  return { rgba: out, hasAlpha: hasAlphaChannel(pixelFormat) };
}

function rawRGBA(tex: S3MTexture): { rgba: Uint8Array; hasAlpha: boolean } {
  const { width, height, pixelFormat, data } = tex;
  const out = new Uint8Array(width * height * 4);
  // RGBA / BGRA / ARGB / ABGR 都是 4 字节，前两个是「尾字节是 alpha」，后两个是「首字节是 alpha」
  const hasAlpha =
    pixelFormat === PixelFormat.RGBA ||
    pixelFormat === PixelFormat.BGRA ||
    pixelFormat === PixelFormat.ARGB ||
    pixelFormat === PixelFormat.ABGR;
  const swapRB = pixelFormat === PixelFormat.BGR || pixelFormat === PixelFormat.BGRA;
  const alphaFirst = pixelFormat === PixelFormat.ARGB || pixelFormat === PixelFormat.ABGR;
  const src = hasAlpha ? 4 : 3;
  for (let i = 0, s = 0, d = 0; i < width * height; i++, s += src, d += 4) {
    const p = alphaFirst ? s + 1 : s;
    out[d] = swapRB ? data[p + 2] : data[p];
    out[d + 1] = data[p + 1];
    out[d + 2] = swapRB ? data[p] : data[p + 2];
    out[d + 3] = hasAlpha ? data[alphaFirst ? s : s + 3] : 255;
  }
  if (tex.flipY) flipRows(out, width, height);
  return { rgba: out, hasAlpha: hasAlphaChannel(pixelFormat) };
}

/**
 * DXT 块数据的期望字节数：4×4 对齐块 × 每块字节（DXT1=8，DXT5=16）。
 * S3M 纹理宽高不总是 4 的倍数，驱动按声明尺寸算期望大小——对不上就是
 * GL_INVALID_VALUE: glCompressedTexSubImage2D: The <imageSize> does not match。
 * 压缩直传前必须用这个函数把关，不匹配就回退 RGBA 解码。
 */
export function expectedDxtByteLength(width: number, height: number, format: 'dxt1' | 'dxt5'): number {
  const bw = (width + 3) >> 2;
  const bh = (height + 3) >> 2;
  return bw * bh * (format === 'dxt1' ? 8 : 16);
}

/** 主线程 / Worker 共用的解码入口。不抛错：失败与不支持都体现在返回值里 */
export async function decodeTextureData(
  tex: S3MTexture,
  options: DecodeOptions = {}
): Promise<DecodedTextureData> {
  const empty: DecodedTextureData = {
    kind: 'unsupported(0/0)',
    width: 0,
    height: 0,
    rgba: null,
    bitmap: null,
    hasAlpha: false,
  };
  if (!tex || !tex.width || !tex.height) return empty;

  const kind = resolveTextureKind(tex.compressType ?? 0, tex.pixelFormat);

  // 压缩直传的公共前提：不是 GL 翻行图集（压缩上传无法 flipY）
  const canCompress = options.compressed === true && !tex.flipY;

  /** 块数据字节数与 4×4 对齐公式一致才允许直传，否则回退解码 */
  const compressible = (data: Uint8Array, w: number, h: number, format: 'dxt1' | 'dxt5'): boolean =>
    data.byteLength === expectedDxtByteLength(w, h, format);

  if (kind === 'crn') {
    try {
      const crn = await transcodeCRN(tex.data);
      const pf = crn.dxtFormat === 1 ? PixelFormat.DXT1 : PixelFormat.DXT5;
      const fmt = crn.dxtFormat === 1 ? 'dxt1' : 'dxt5';
      if (canCompress && compressible(crn.data, crn.width, crn.height, fmt)) {
        // CRN→DXT 的转码免不了（wasm），但后续的 DXT→RGBA 解块省掉，块数据直传 GPU
        return {
          kind: `crn->dxt${crn.dxtFormat}(c)`,
          width: crn.width,
          height: crn.height,
          rgba: null,
          bitmap: null,
          hasAlpha: pf === PixelFormat.DXT5,
          blocks: crn.data,
          blockFormat: fmt,
        };
      }
      const decoded = decodeDXT({
        width: crn.width,
        height: crn.height,
        pixelFormat: pf,
        data: crn.data,
      });
      return {
        kind: `crn->dxt${crn.dxtFormat}`,
        width: crn.width,
        height: crn.height,
        rgba: decoded.rgba,
        bitmap: null,
        hasAlpha: decoded.hasAlpha,
      };
    } catch (e) {
      // 一张纹理坏了不该带崩整个瓦片，如实上报并降级成无贴图
      return {
        kind: 'crn(failed)',
        width: tex.width,
        height: tex.height,
        rgba: null,
        bitmap: null,
        hasAlpha: false,
        error: String((e as Error | null)?.message ?? e),
      };
    }
  }

  if (kind === 'dxt1' || kind === 'dxt3' || kind === 'dxt4' || kind === 'dxt5') {
    const pf = dxtPixelFormatOf(kind);
    // dxt3/dxt4 少见，不进直传白名单；块长与 4×4 对齐公式不符的也回退解码
    if (canCompress && (kind === 'dxt1' || kind === 'dxt5') && compressible(tex.data, tex.width, tex.height, kind)) {
      return {
        kind: `${kind}(c)`,
        width: tex.width,
        height: tex.height,
        rgba: null,
        bitmap: null,
        hasAlpha: kind === 'dxt5',
        blocks: tex.data,
        blockFormat: kind,
      };
    }
    const decoded = decodeDXT({ ...tex, pixelFormat: pf });
    return { kind, width: tex.width, height: tex.height, rgba: decoded.rgba, bitmap: null, hasAlpha: decoded.hasAlpha };
  }

  if (kind === 'webp') {
    const blob = new Blob([tex.data as BlobPart], { type: 'image/webp' });
    const bitmap = await createImageBitmap(blob);
    return { kind, width: bitmap.width, height: bitmap.height, rgba: null, bitmap, hasAlpha: true };
  }

  if (kind === 'raw') {
    const decoded = rawRGBA(tex);
    return { kind, width: tex.width, height: tex.height, rgba: decoded.rgba, bitmap: null, hasAlpha: decoded.hasAlpha };
  }

  // KTX2 / ETC 需要额外解码器，先如实上报而不是静默出错
  return { ...empty, kind: `unsupported(${tex.compressType}/${tex.pixelFormat})` };
}
