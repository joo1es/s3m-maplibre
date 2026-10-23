/**
 * S3M 纹理 → three.js Texture
 *
 * S3M 的纹理是「裸块」：没有容器头，只有 width/height/pixelFormat/dataSize + 原始字节。
 * pixelFormat 沿用 OpenGL 枚举，实际见到的有：
 *   21 = DXT5、19 = DXT3、17 = DXT1、25 = WEBP、10/11 = RGB/BGR、28 = RGBA
 * 官方 JS 只保证 DXT 与 WEBP 可用，这里按同样的范围实现。
 */
import * as THREE from 'three';
import DXTTextureDecode from '../core/DXTTextureDecode.js';
import type { S3MTexture } from '../core/types.js';

export const PixelFormat = {
  RGB: 10,
  BGR: 11,
  BGRA: 14,
  RGBA: 28,
  WEBP: 25,
  DXT1: 17,
  DXT3: 19,
  DXT4: 20,
  DXT5: 21,
  CRN_DXT5: 26,
} as const;

const DXT_SET: ReadonlySet<number> = new Set([PixelFormat.DXT1, PixelFormat.DXT3, PixelFormat.DXT4, PixelFormat.DXT5]);

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
function decodeDXT(tex: S3MTexture): THREE.DataTexture {
  const { width, height, pixelFormat, data } = tex;
  const out = new Uint8Array(width * height * 4);
  DXTTextureDecode.decode(out, width, height, data, pixelFormat);
  return new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
}

function fromRawRGB(tex: S3MTexture): THREE.DataTexture {
  const { width, height, pixelFormat, data } = tex;
  const out = new Uint8Array(width * height * 4);
  const swapRB = pixelFormat === PixelFormat.BGR || pixelFormat === PixelFormat.BGRA;
  const hasAlpha = pixelFormat === PixelFormat.RGBA || pixelFormat === PixelFormat.BGRA;
  const src = hasAlpha ? 4 : 3;
  for (let i = 0, s = 0, d = 0; i < width * height; i++, s += src, d += 4) {
    out[d] = swapRB ? data[s + 2] : data[s];
    out[d + 1] = data[s + 1];
    out[d + 2] = swapRB ? data[s] : data[s + 2];
    out[d + 3] = hasAlpha ? data[s + 3] : 255;
  }
  return new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
}

export async function createTexture(tex: S3MTexture | null | undefined): Promise<DecodedTexture> {
  if (!tex || !tex.width || !tex.height) return { texture: null, decoded: 'empty' };

  if (DXT_SET.has(tex.pixelFormat)) {
    return {
      texture: configure(decodeDXT(tex)),
      decoded: `dxt${tex.pixelFormat === PixelFormat.DXT1 ? 1 : 5}`,
    };
  }

  if (tex.pixelFormat === PixelFormat.WEBP) {
    const blob = new Blob([tex.data as BlobPart], { type: 'image/webp' });
    const bmp = await createImageBitmap(blob);
    const t = new THREE.Texture(bmp);
    t.needsUpdate = true;
    return { texture: configure(t), decoded: 'webp' };
  }

  if (
    tex.pixelFormat === PixelFormat.RGB ||
    tex.pixelFormat === PixelFormat.BGR ||
    tex.pixelFormat === PixelFormat.RGBA ||
    tex.pixelFormat === PixelFormat.BGRA
  ) {
    return { texture: configure(fromRawRGB(tex)), decoded: 'raw' };
  }

  // KTX2 / CRN / ETC 需要额外解码器，先如实上报而不是静默出错
  return { texture: null, decoded: `unsupported(${tex.pixelFormat})` };
}
