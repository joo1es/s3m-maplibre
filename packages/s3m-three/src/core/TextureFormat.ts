/**
 * S3M 纹理格式判定
 *
 * 纹理头里有两个字段特别容易搞混：
 *   compressType —— 压缩方式。S3M 3.0（v3.00）这个字段直接借用了 PixelFormat 的数值，
 *                   26 / 27 表示 CRN；行标（v3.01）改成了 GL 压缩枚举（33776 DXT1、
 *                   33779 DXT5、38000 WEBP、38001 CRN、38002 KTX2），再加自定义的
 *                   50000（CRN_DXT5）。
 *   pixelFormat  —— 像素 / 块格式。v3.00 下 CRN 纹理这里写的是 13（ABGR，实际无意义）；
 *                   v3.01 下写的是 32856（GL_RGBA8）这类 GL 内部格式，也不是 DXT。
 *
 * 实测（SuperMap Online 公有服务，2026-10）三组组合：
 *   v3.00  ct=26     pf=13     → CRN，数据以 'Hx' 开头
 *   v3.00  ct=14     pf=21     → DXT5 裸块
 *   v3.01  ct=50000  pf=32856  → CRN，数据以 'Hx' 开头
 *
 * 结论：**「是不是 CRN」只能看 compressType**。之前按 pixelFormat 26 / 27 判断，
 * 真实服务里的 CRN 纹理会被当成未知格式整包丢掉（模型变成无贴图的灰模）。
 */

/** S3M 3.01（行标）compressType 取值 */
export const TextureCompress = {
  NONE: 0,
  DXT1_RGB: 33776,
  DXT1_RGBA: 33777,
  DXT3: 33778,
  DXT5: 33779,
  WEBP: 38000,
  CRN: 38001,
  KTX2: 38002,
  /** 超图自定义扩展 */
  CRN_DXT5: 50000,
} as const;

/** 判定结果：`dxt*` 走块解码，`crn` 先转码成 DXT，`raw` 走逐像素拷贝 */
export type TextureKind = 'dxt1' | 'dxt3' | 'dxt4' | 'dxt5' | 'crn' | 'webp' | 'ktx2' | 'raw' | 'unknown';

/** GL 压缩枚举与 TC_* 之外的 CRN 标记（v3.00 借用 PixelFormat 的 26 / 27） */
const CRN_COMPRESS = new Set([26, 27]);

function kindOfPixelFormat(pf: number): TextureKind | null {
  switch (pf) {
    case 17:
      return 'dxt1';
    case 18:
    case 19:
      return 'dxt3';
    case 20:
      return 'dxt4';
    case 21:
      return 'dxt5';
    case 25:
      return 'webp';
    case 12: // ARGB
    case 13: // ABGR
    case 10: // RGB
    case 11: // BGR
    case 14: // BGRA
    case 28: // RGBA
      return 'raw';
    default:
      return null;
  }
}

function kindOfCompress(ct: number): TextureKind | null {
  switch (ct) {
    case TextureCompress.DXT1_RGB:
    case TextureCompress.DXT1_RGBA:
      return 'dxt1';
    case TextureCompress.DXT3:
      return 'dxt3';
    case TextureCompress.DXT5:
      return 'dxt5';
    case TextureCompress.WEBP:
      return 'webp';
    case TextureCompress.CRN:
    case TextureCompress.CRN_DXT5:
      return 'crn';
    case TextureCompress.KTX2:
      return 'ktx2';
    default:
      return null;
  }
}

/**
 * 判定一张纹理该走哪条解码路径。
 *
 * 顺序有讲究：先看 compressType（CRN / 行标枚举），再退回 pixelFormat——
 * v3.00 的 CRN 纹理 pixelFormat 是 13，先看 pixelFormat 会误判成 raw。
 */
export function resolveTextureKind(compressType: number, pixelFormat: number): TextureKind {
  if (CRN_COMPRESS.has(compressType)) return 'crn';
  const byCompress = kindOfCompress(compressType);
  if (byCompress) return byCompress;
  return kindOfPixelFormat(pixelFormat) ?? 'unknown';
}

/** DXT 族对应的 pixelFormat（喂给 DXTTextureDecode，>11 即按 16 字节块解） */
export function dxtPixelFormatOf(kind: TextureKind): number {
  return kind === 'dxt1' ? 17 : 21;
}
