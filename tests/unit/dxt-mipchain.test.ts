/**
 * DXT 内联 mip 链单测。
 *
 * 背景：S3M 纹理的 data 常是「level0 + 完整 mip 链」（实测 3D-BIMbuilding-2 的
 * 1024² DXT5 带 level=11，总字节 ≈ level0 的 4/3）。官方 iClient3D 把整条链
 * 逐层 compressedTexImage2D 上传，远处采样高层级 → 平均成纯色（"灰色滤镜"）。
 *
 * 我们此前两处都丢了 mip：
 *   1. `compressible()` 按 level0 字节数校验，带链数据（1.33×）直接回退 RGBA 解码；
 *   2. DXT 单层直传时 `generateMipmaps=false; minFilter=Linear` —— 无 mip。
 * 表现就是远处地面点阵、高频纹全保留，怎么调光照都"不像官方"。
 */
import { describe, expect, test } from 'bun:test';
import { sliceDxtMipChain } from '../../packages/s3m-three/src/core/TextureDecode';
import { decodeTextureData } from '../../packages/s3m-three/src/core/TextureDecode';
import type { S3MTexture } from '../../packages/s3m-three/src/core/types';

/** 64×64 DXT5 的完整链字节长：Σ ceil(w/4)*ceil(h/4)*16，w=64..1 */
const CHAIN64_DXT5 = (() => {
  let total = 0;
  for (let w = 64, h = 64; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    total += Math.ceil(w / 4) * Math.ceil(h / 4) * 16;
    if (w === 1 && h === 1) break;
  }
  return total; // (256+64+16+4+1+1+1)*16 = 5488
})();

describe('sliceDxtMipChain（纯函数）', () => {
  test('完整链：逐层尺寸减半、偏移连续、末层 1×1', () => {
    const data = new Uint8Array(CHAIN64_DXT5);
    const levels = sliceDxtMipChain(data, 64, 64, 16)!;
    expect(levels).not.toBeNull();
    expect(levels.map((l) => l.width)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    expect(levels.map((l) => l.height)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    expect(levels[0]!.data.byteLength).toBe(256 * 16);
    expect(levels[levels.length - 1]!.data.byteLength).toBe(16);
    // 层与层不重叠：切出的 subarray 拼回来等于原数据
    let off = 0;
    for (const l of levels) off += l.data.byteLength;
    expect(off).toBe(data.byteLength);
  });

  test('字节数对不上 level0 时回退 null（调用方降级为解码路径）', () => {
    // 只有 level0 的数据却按链切 → 首层之后字节耗尽
    expect(sliceDxtMipChain(new Uint8Array(256 * 16), 64, 64, 16)).toBeNull();
    expect(sliceDxtMipChain(new Uint8Array(0), 64, 64, 16)).toBeNull();
  });

  test('DXT1 每块 8 字节', () => {
    let total = 0;
    for (let w = 8, h = 8; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
      total += Math.ceil(w / 4) * Math.ceil(h / 4) * 8;
      if (w === 1 && h === 1) break;
    }
    const levels = sliceDxtMipChain(new Uint8Array(total), 8, 8, 8)!;
    expect(levels!.length).toBe(4);
    expect(levels![0]!.data.byteLength).toBe(4 * 8);
  });
});

describe('decodeTextureData 产出 mip 链', () => {
  const fakeTex = (data: Uint8Array, level: number): S3MTexture =>
    ({
      code: 'T',
      level,
      width: 64,
      height: 64,
      compressType: 14, // 实测 iClient3D 恒为 DXT5
      pixelFormat: 21,
      data,
    }) as unknown as S3MTexture;

  test('带链数据（1.33×level0）不再被字节数校验拒掉，产出 mipmaps', async () => {
    const data = new Uint8Array(CHAIN64_DXT5);
    const d = await decodeTextureData(fakeTex(data, 7), { compressed: true });
    expect(d.blockFormat).toBe('dxt5');
    expect(d.mipmaps).toBeDefined();
    expect(d.mipmaps!.length).toBe(7);
    expect(d.mipmaps![0]!.width).toBe(64);
    expect(d.mipmaps![d.mipmaps!.length - 1]!.width).toBe(1);
  });

  test('纯 level0 数据保持单层直传（行为不变）', async () => {
    const d = await decodeTextureData(fakeTex(new Uint8Array(256 * 16), 1), { compressed: true });
    expect(d.blockFormat).toBe('dxt5');
    expect(d.mipmaps).toBeUndefined();
    expect(d.blocks!.byteLength).toBe(256 * 16);
  });
});
