/**
 * RGBA8 直排纹理的主线程零工快路径。
 *
 * 背景（实测）：CBD 场景 722 条 `tex` worker 消息里 705 条是
 * `compressType=0 / pixelFormat=28(RGBA) / flipY=false / data.length === w*h*4`，
 * 合计 2.55 GB，占全部纹理字节的 99.9%。这类纹理进 worker 只是做一次
 * 逐像素复制，主线程还要付一次 3.4MB/张的 structured clone —— 单这一项
 * 在加载期占主线程 2.9 秒。
 *
 * 正确做法：判据成立时主线程用一次原生 memcpy 出结果，worker 整趟省掉。
 * 判据必须严格 —— 只要有一项不成立（翻行、非 RGBA 排列、长度不符、要缩图）
 * 就仍然走 worker / 逐像素路径，否则画面会出现通道错位或上下颠倒。
 */
import { describe, expect, test } from 'bun:test';
import { decodeTextureData, textureDecodeIsTrivial } from '../../packages/s3m-three/src/core/TextureDecode.js';
import { PixelFormat } from '../../packages/s3m-three/src/core/TextureFormat.js';
import type { S3MTexture } from '../../packages/s3m-three/src/core/types.js';

function rgbaTex(w: number, h: number, patch: Partial<S3MTexture> = {}): S3MTexture {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = i & 0xff;
    data[i * 4 + 1] = (i * 3) & 0xff;
    data[i * 4 + 2] = (i * 7) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return {
    width: w,
    height: h,
    pixelFormat: PixelFormat.RGBA,
    compressType: 0,
    data,
    flipY: false,
    ...patch,
  } as S3MTexture;
}

describe('textureDecodeIsTrivial', () => {
  test('RGBA8 直排、不翻行、长度精确 → 可走主线程快路径', () => {
    expect(textureDecodeIsTrivial(rgbaTex(8, 8))).toBe(true);
  });

  test('flipY 为真 → 不可（要翻行）', () => {
    expect(textureDecodeIsTrivial(rgbaTex(8, 8, { flipY: true }))).toBe(false);
  });

  test('BGRA 排列 → 不可（要交换 R/B）', () => {
    expect(textureDecodeIsTrivial(rgbaTex(8, 8, { pixelFormat: PixelFormat.BGRA }))).toBe(false);
  });

  test('data 长度与 w*h*4 不符 → 不可（数据不完整，交给解码器兜底）', () => {
    const tex = rgbaTex(8, 8);
    expect(textureDecodeIsTrivial({ ...tex, data: tex.data.subarray(0, 100) } as S3MTexture)).toBe(false);
  });

  test('要求缩图（maxSize 小于边长）→ 不可（缩放是 CPU 活，留给 worker）', () => {
    expect(textureDecodeIsTrivial(rgbaTex(64, 64), { maxSize: 32 })).toBe(false);
  });

  test('maxSize 不小于边长 → 无需缩放，仍可走快路径', () => {
    expect(textureDecodeIsTrivial(rgbaTex(64, 64), { maxSize: 64 })).toBe(true);
    expect(textureDecodeIsTrivial(rgbaTex(64, 64), { maxSize: 4096 })).toBe(true);
  });

  test('压紧直传（DXT）纹理不适用', () => {
    const dxt = rgbaTex(8, 8, { pixelFormat: PixelFormat.DXT5, compressType: 0 });
    expect(textureDecodeIsTrivial(dxt, {})).toBe(false);
  });
});

describe('decodeTextureData 的 RGBA 快路径', () => {
  test('输出字节与输入一致（不能出现通道错位）', async () => {
    const tex = rgbaTex(16, 16);
    const out = await decodeTextureData(tex, {});
    expect(out.kind).toBe('raw');
    expect(out.rgba).not.toBeNull();
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
    expect(out.rgba!.length).toBe(16 * 16 * 4);
    expect(Array.from(out.rgba!)).toEqual(Array.from(tex.data));
  });

  test('返回的是独立副本：改输出不会污染瓦片原始缓冲', async () => {
    const tex = rgbaTex(8, 8);
    const out = await decodeTextureData(tex, {});
    expect(out.rgba).not.toBe(tex.data);
    const before = tex.data[0]!;
    out.rgba![0] = (before + 1) & 0xff;
    expect(tex.data[0]).toBe(before);
  });

  test('flipY 仍然逐行翻转（不能因为走快路径就把翻行丢掉）', async () => {
    const w = 4;
    const h = 2;
    const tex = rgbaTex(w, h, { flipY: true });
    // 第一行全 10，第二行全 20
    for (let x = 0; x < w; x++) {
      tex.data[(0 * w + x) * 4 + 0] = 10;
      tex.data[(1 * w + x) * 4 + 0] = 20;
    }
    const out = await decodeTextureData(tex, {});
    expect(out.rgba![0]).toBe(20);
    expect(out.rgba![(1 * w) * 4]).toBe(10);
  });
});
