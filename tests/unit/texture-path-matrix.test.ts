/**
 * 纹理路径矩阵：「哪种数据走哪条路」+「两条路方向必须一致」。
 *
 * 这套代码里所有跟行序有关的结论都建立在一个假设上：DXT 族解码器内置一次 flip、
 * TextureDecode 又按 flipY 翻一次，两次抵消 —— 于是**解出来的 RGBA 与块序同向**。
 * 一旦以后接入新格式、或有人改动解码器，这个假设就会静默失效（上次桥面错位就是这么来的）。
 *
 * 这里把 (格式 × flipY × 排版) 列成表，逐格断言：
 *   ① 走压缩直传还是 RGBA（以及纹理类型是 CompressedTexture 还是 DataTexture）；
 *   ② 镂空语义 s3mHasAlpha 有没有跟着走；
 *   ③ 图集分带只碰 RGBA，不碰压缩块；
 *   ④ flipY=true 的 DXT/CRN：块序与 RGBA 上传方向逐像素一致。
 * 另有一条「已知边角」：flipY=false 的 DXT 目前两条路方向相反（现网数据里不存在这种纹理，
 * 但先把它记录成事实，将来真出现时这里会红）。
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseS3MBlock } from '../../packages/s3m-three/src/core/S3MBlockParser';
import { decodeTextureData, expectedDxtByteLength } from '../../packages/s3m-three/src/core/TextureDecode';
import { createTexture, setCompressedTexturesSupported } from '../../packages/s3m-three/src/render/TextureFactory';
import { isBandedUploadPending } from '../../packages/s3m-three/src/render/AtlasUpload';
import DXTTextureDecode from '../../packages/s3m-three/src/core/DXTTextureDecode';
import { PixelFormat } from '../../packages/s3m-three/src/core/TextureFormat';
import type { S3MTexture } from '../../packages/s3m-three/src/core/types';

const W = 16;
const H = 16;

/**
 * 造一张「每行颜色都不同」的 DXT5 图：每个 4×4 块里，第 py 行统一选第 py 个调色板项。
 * 全零的块翻不翻都一样，测不出方向问题 —— 必须让行之间可区分。
 */
function dxt5Gradient(width: number, height: number): Uint8Array {
  const bw = (width + 3) >> 2;
  const bh = (height + 3) >> 2;
  const out = new Uint8Array(bw * bh * 16);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      out[o] = 255; // alpha0
      out[o + 1] = 255; // alpha1 → 全不透明
      const c0 = 0xf800; // 红
      const c1 = 0x07e0; // 绿
      out[o + 8] = c0 & 0xff;
      out[o + 9] = (c0 >> 8) & 0xff;
      out[o + 10] = c1 & 0xff;
      out[o + 11] = (c1 >> 8) & 0xff;
      let idx = 0;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          idx |= py << ((py * 4 + px) * 2); // 第 py 行 → 调色板项 py
        }
      }
      out[o + 12] = idx & 0xff;
      out[o + 13] = (idx >> 8) & 0xff;
      out[o + 14] = (idx >> 16) & 0xff;
      out[o + 15] = (idx >> 24) & 0xff;
      o += 16;
    }
  }
  return out;
}

function dxt(compressType: number, pixelFormat: number, flipY: boolean): S3MTexture {
  const format = pixelFormat === PixelFormat.DXT1 ? 'dxt1' : 'dxt5';
  return {
    code: 'm',
    level: 1,
    width: W,
    height: H,
    compressType,
    pixelFormat,
    data: new Uint8Array(expectedDxtByteLength(W, H, format)),
    flipY,
  };
}

function rawRgba(flipY: boolean, packed = false, width = W, height = H): S3MTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = y * 16; // 行号写进 R 通道，方向一眼可见
      data[o + 1] = x * 16;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  return { code: 'r', level: 1, width, height, compressType: 0, pixelFormat: PixelFormat.RGBA, data, flipY, packed };
}

function flipRows(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(src.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
}

function maxDiff(a: Uint8Array, b: Uint8Array): number {
  let max = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

afterEach(() => setCompressedTexturesSupported(false));

describe('纹理路径矩阵', () => {
  test('DXT5 + flipY + 原始排版 + 支持 s3tc → 压缩直传，保留 alpha', async () => {
    setCompressedTexturesSupported(true);
    const { texture } = await createTexture(dxt(33779, PixelFormat.DXT5, true));
    expect(texture).toBeInstanceOf(THREE.CompressedTexture);
    expect(texture!.userData.s3mHasAlpha).toBe(true); // DXT5：镂空语义必须跟着走
    expect(texture!.generateMipmaps).toBe(false);
  });

  test('DXT1 + flipY → 压缩直传，不带 alpha', async () => {
    setCompressedTexturesSupported(true);
    const { texture } = await createTexture(dxt(33776, PixelFormat.DXT1, true));
    expect(texture).toBeInstanceOf(THREE.CompressedTexture);
    expect(texture!.userData.s3mHasAlpha).toBeUndefined();
  });

  test('DXT3 不在直传白名单 → 始终 RGBA', async () => {
    setCompressedTexturesSupported(true);
    const { texture, decoded } = await createTexture(dxt(33778, PixelFormat.DXT3, true));
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(decoded.startsWith('dxt3')).toBe(true);
  });

  test('宿主不支持 s3tc → 所有 DXT 回退 RGBA', async () => {
    setCompressedTexturesSupported(false);
    const { texture } = await createTexture(dxt(33779, PixelFormat.DXT5, true));
    expect(texture).toBeInstanceOf(THREE.DataTexture);
  });

  test('raw RGBA + flipY → DataTexture，且行序被翻了一次', async () => {
    setCompressedTexturesSupported(true);
    const src = rawRgba(true);
    const { texture } = await createTexture(src);
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    const got = (texture as THREE.DataTexture).image.data as Uint8Array;
    expect(maxDiff(got, flipRows(src.data, W, H))).toBe(0);
  });

  test('拼图 RGBA（packed）：大图参与分带，压缩块不参与', async () => {
    setCompressedTexturesSupported(true);

    // 大图（≥1 MB）→ 进分带队列
    const big = rawRgba(false, true, 512, 512);
    const { texture } = await createTexture(big);
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(isBandedUploadPending(texture!)).toBe(true);
    texture!.dispose(); // 从队列里摘掉，别污染别的用例
    expect(isBandedUploadPending(texture!)).toBe(false);

    // 压缩直传的块没有「逐行搬运」这回事
    const { texture: compressed } = await createTexture(dxt(33779, PixelFormat.DXT5, true));
    expect(compressed).toBeInstanceOf(THREE.CompressedTexture);
    expect(isBandedUploadPending(compressed!)).toBe(false);
  });

  test('fipY=true 的 DXT：块序与 RGBA 上传逐像素一致（压缩直传不需要任何镜像）', async () => {
    const tex = dxt(33779, PixelFormat.DXT5, true);
    tex.data = dxt5Gradient(W, H);
    const rgba = await decodeTextureData(tex, { compressed: false });
    const compressed = await decodeTextureData(tex, {
      compressed: true,
      allowCompressedFlipY: true,
      onlyLevel0: true,
    });
    expect(compressed.blocks).toBeDefined();

    const publicDecode = new Uint8Array(W * H * 4);
    DXTTextureDecode.decode(publicDecode, W, H, compressed.blocks!, PixelFormat.DXT5);
    // 解码器内置一次 flip，块序 = 再翻回来
    expect(maxDiff(flipRows(publicDecode, W, H), rgba.rgba!)).toBeLessThanOrEqual(1);
  });

  test('已知边角：flipY=false 的 DXT 两条路方向相反（现网无此数据，出现即需处理）', async () => {
    const tex = dxt(33779, PixelFormat.DXT5, false);
    tex.data = dxt5Gradient(W, H);
    const rgba = await decodeTextureData(tex, { compressed: false });
    const compressed = await decodeTextureData(tex, { compressed: true, onlyLevel0: true });
    expect(compressed.blocks).toBeDefined();

    const publicDecode = new Uint8Array(W * H * 4);
    DXTTextureDecode.decode(publicDecode, W, H, compressed.blocks!, PixelFormat.DXT5);
    // 「块序」与 RGBA 路径不同向 —— 这正是这条边角的风险
    expect(maxDiff(flipRows(publicDecode, W, H), rgba.rgba!)).toBeGreaterThan(0);
  });
});
