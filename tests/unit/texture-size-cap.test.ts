/**
 * 回归测试：纹理解码产物的大小上限（`DecodeOptions.maxSize` / `maxTextureSize`）
 *
 * 这一项是移动端的显存/上传刹车：手机上 1024 与 2048 肉眼几乎无差，显存差 4 倍。
 * 两条硬约束必须钉住：
 *   1. **默认不缩放** —— 不传 maxSize 时产物必须逐字节、逐尺寸保持原样；
 *   2. **压缩直传不缩放** —— DXT 块不能重采样，且要直传的场合本就是想省显存。
 */
import { expect, test } from 'bun:test';
import { decodeTextureData } from '../../packages/s3m-three/src/core/TextureDecode';
import { PixelFormat } from '../../packages/s3m-three/src/core/TextureFormat';

/** 构造一张 raw RGBA 纹理（pixelFormat 28 = RGBA，走 rawRGBA 直通分支） */
function rawTex(width: number, height: number, fill?: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill ? fill(x, y) : [10, 20, 30, 255];
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data, compressType: 0, pixelFormat: PixelFormat.RGBA } as never;
}

test('不传 maxSize 时不缩放，尺寸与像素原样保留', async () => {
  const tex = rawTex(64, 32);
  const out = await decodeTextureData(tex);
  expect(out.width).toBe(64);
  expect(out.height).toBe(32);
  expect(out.rgba?.byteLength).toBe(64 * 32 * 4);
  expect(out.rgba?.[0]).toBe(10);
});

test('超过上限按 2× 逐次减半，直到长边进入上限', async () => {
  const out = await decodeTextureData(rawTex(2048, 2048), { maxSize: 1024 });
  expect(out.width).toBe(1024);
  expect(out.height).toBe(1024);
  expect(out.rgba?.byteLength).toBe(1024 * 1024 * 4);

  // 4096 需要减半两次才落到 1024
  const big = await decodeTextureData(rawTex(4096, 1024), { maxSize: 1024 });
  expect(big.width).toBe(1024);
  expect(big.height).toBe(256);
});

test('没超上限时不动（512 < 1024）', async () => {
  const out = await decodeTextureData(rawTex(512, 256), { maxSize: 1024 });
  expect(out.width).toBe(512);
  expect(out.height).toBe(256);
});

test('减半用 2×2 盒式平均，不是取某一点', async () => {
  // 四个角的颜色差异很大，取平均后应落在中间
  const tex = rawTex(2, 2, (x, y) => {
    if (x === 0 && y === 0) return [0, 0, 0, 255];
    if (x === 1 && y === 0) return [100, 0, 0, 255];
    if (x === 0 && y === 1) return [0, 200, 0, 255];
    return [0, 0, 50, 255];
  });
  const out = await decodeTextureData(tex, { maxSize: 1 });
  expect(out.width).toBe(1);
  expect(out.height).toBe(1);
  expect(Array.from(out.rgba ?? [])).toEqual([25, 50, 12, 255]);
});

test('奇数边长尽力减半（输出 ⌊w/2⌋ × ⌊h/2⌋），不会留下 0 尺寸', async () => {
  const out = await decodeTextureData(rawTex(5, 3), { maxSize: 1 });
  expect(out.width).toBe(2);
  expect(out.height).toBe(1);
  expect(out.rgba?.byteLength).toBe(2 * 1 * 4);
});

test('压缩直传（blocks）不缩放：DXT 块不能重采样', async () => {
  // 4×4 DXT1 = 1×1 块 × 8 字节，长度必须与 4×4 对齐公式一致才会走直传
  const tex = {
    width: 4,
    height: 4,
    data: new Uint8Array(8),
    compressType: 0,
    pixelFormat: PixelFormat.DXT1,
  } as never;
  const out = await decodeTextureData(tex, { compressed: true, maxSize: 2 });
  expect(out.blocks).toBeDefined();
  expect(out.width).toBe(4);
  expect(out.height).toBe(4);
});
