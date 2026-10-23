/**
 * S3M 纹理 → three.js Texture
 *
 * S3M 的纹理是「裸块」：没有容器头，只有 width/height/compressType/dataSize/pixelFormat + 原始字节。
 * 该走哪条解码路径由 compressType 决定（见 core/TextureFormat.ts）：DXT 族直接解块，
 * CRN（26 / 27 / 38001 / 50000）先用 crunch wasm 转码回 DXT，WEBP 交给浏览器，
 * RGB 系逐像素拷贝。
 */
import * as THREE from 'three';
import DXTTextureDecode from '../core/DXTTextureDecode.js';
import { transcodeCRN } from '../core/CRNDecode.js';
import { dxtPixelFormatOf, resolveTextureKind } from '../core/TextureFormat.js';
import type { S3MTexture } from '../core/types.js';

export const PixelFormat = {
  RGB: 10,
  BGR: 11,
  ARGB: 12,
  ABGR: 13,
  BGRA: 14,
  RGBA: 28,
  WEBP: 25,
  DXT1: 17,
  DXT3: 19,
  DXT4: 20,
  DXT5: 21,
  CRN_DXT5: 26,
  STANDARD_CRN: 27,
} as const;

/** 由 S3MLayer 在拿到 GL 上下文后注入，用于斜视角下保持纹理清晰 */
let maxAnisotropy = 1;

export function setMaxAnisotropy(n: number): void {
  maxAnisotropy = Math.max(1, n | 0);
}

export interface DecodedTexture {
  texture: THREE.Texture | null;
  /** 实际走的解码路径，`unsupported(26)` 这类值会进 stats.skipped */
  decoded: string;
}

function configure<T extends THREE.Texture>(tex: T, srgb = true): T {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // 建筑立面大多是斜视角，各向异性过滤对清晰度的提升比提高分辨率更直接
  tex.anisotropy = maxAnisotropy;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** 解 DXT 到 RGBA8。DXT5 是 1 字节/像素，DXT1 是 0.5 字节/像素。 */
/** DXT 解码只需要尺寸 / 格式 / 字节，CRN 转码出来的结果也走这条路 */
function decodeDXT(tex: Pick<S3MTexture, 'width' | 'height' | 'pixelFormat' | 'data'>): THREE.DataTexture {
  const { width, height, pixelFormat, data } = tex;
  const out = new Uint8Array(width * height * 4);
  DXTTextureDecode.decode(out, width, height, data, pixelFormat);
  return new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
}

function fromRawRGB(tex: S3MTexture): THREE.DataTexture {
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
  return new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
}

export async function createTexture(tex: S3MTexture | null | undefined): Promise<DecodedTexture> {
  if (!tex || !tex.width || !tex.height) return { texture: null, decoded: 'empty' };

  // 判定只能看 compressType：v3.00 的 CRN 纹理 pixelFormat 是 13（ABGR）、
  // 行标的 CRN 是 32856（GL_RGBA8），都不是 26 / 27（见 core/TextureFormat.ts）
  const kind = resolveTextureKind(tex.compressType ?? 0, tex.pixelFormat);

  if (kind === 'crn') {
    try {
      const crn = await transcodeCRN(tex.data);
      const decoded = decodeDXT({
        width: crn.width,
        height: crn.height,
        pixelFormat: crn.dxtFormat === 1 ? 17 : 21,
        data: crn.data,
      });
      return { texture: configure(decoded), decoded: `crn->dxt${crn.dxtFormat}` };
    } catch (e) {
      // 一张纹理坏了不该带崩整个瓦片，如实上报并降级成无贴图
      console.warn('[s3m] CRN 转码失败：', e);
      return { texture: null, decoded: 'crn(failed)' };
    }
  }

  if (kind === 'dxt1' || kind === 'dxt3' || kind === 'dxt4' || kind === 'dxt5') {
    return {
      texture: configure(decodeDXT({ ...tex, pixelFormat: dxtPixelFormatOf(kind) })),
      decoded: kind,
    };
  }

  if (kind === 'webp') {
    const blob = new Blob([tex.data as BlobPart], { type: 'image/webp' });
    const bmp = await createImageBitmap(blob);
    const t = new THREE.Texture(bmp);
    t.needsUpdate = true;
    return { texture: configure(t), decoded: 'webp' };
  }

  if (kind === 'raw') {
    return { texture: configure(fromRawRGB(tex)), decoded: 'raw' };
  }

  // KTX2 / ETC 需要额外解码器，先如实上报而不是静默出错
  return { texture: null, decoded: `unsupported(${tex.compressType}/${tex.pixelFormat})` };
}
