/**
 * 高清图集替换门禁（`core/AtlasUpgrade.ts`）的单测。
 *
 * 这一层的存在理由：官方 `requestSubTextures` 是「整体换图、rect 照旧」，
 * 前提是 child 与缩略图**同一套排布、只是分辨率更高**。实测这个前提只对一部分图集成立，
 * 无条件换会整张错位。所以判据必须可测、可回归。
 */
import { describe, expect, test } from 'bun:test';
import {
  boxDownsample,
  DEFAULT_MAX_ASPECT_DELTA,
  DEFAULT_MAX_MEAN_ERROR,
  evaluateAtlasUpgrade,
  type AtlasPixels,
} from '../../packages/s3m-three/src/core/AtlasUpgrade';

/** 造一张 RGBA 图：用 (x,y) 的函数填充，保证图案可复现 */
function make(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): AtlasPixels {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { width: w, height: h, data, compressType: 0, pixelFormat: 28 };
}

/** 棋盘格：每个 2px 块黑白交替，用来检验「面积平均」而不是「最近邻」 */
const checker = (x: number, y: number) => (((x >> 1) + (y >> 1)) & 1 ? [235, 235, 235, 255] : [20, 20, 20, 255]) as [number, number, number, number];

/** 最近邻放大 —— 模拟「同一张图的高清版」 */
function upscale(src: AtlasPixels, k: number): AtlasPixels {
  return make(src.width * k, src.height * k, (x, y) => {
    const o = ((y / k | 0) * src.width + (x / k | 0)) * 4;
    return [src.data[o]!, src.data[o + 1]!, src.data[o + 2]!, src.data[o + 3]!];
  });
}

describe('boxDownsample', () => {
  test('面积平均：2×2 黑白棋盘缩成 1 像素必须得到中灰，不能取某一边', () => {
    const src = make(2, 2, (x, y) => (x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const down = boxDownsample(src.data, 2, 2, 1, 1);
    expect(down[0]).toBe(127); // (255+0+0+255)/4 = 127.5 → 取整 127
    expect(down[1]).toBe(127);
    expect(down[2]).toBe(127);
  });

  test('尺寸不变时逐像素一致', () => {
    const src = make(4, 3, checker);
    const down = boxDownsample(src.data, 4, 3, 4, 3);
    expect(Array.from(down)).toEqual(Array.from(src.data));
  });
});

describe('evaluateAtlasUpgrade：什么时候允许换图', () => {
  test('等比放大的同一张图 → 通过，且误差很小', () => {
    const lo = make(8, 8, checker);
    const hi = upscale(lo, 2); // 16×16，长宽比完全一致
    const v = evaluateAtlasUpgrade(lo, hi);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('ok');
    expect(v.aspectDelta).toBe(0);
    expect(v.meanAbsError).toBeLessThan(2);
  });

  test('长宽比不一致 → 拒绝（这是实测里 6/8 张图集的情形）', () => {
    const lo = make(8, 8, checker);
    // 16×24：等比放大不可能长这样
    const hi = make(16, 24, (x, y) => {
      const o = ((y * 8 / 24) | 0) * 8 * 4 + ((x * 8 / 16) | 0) * 4;
      return [lo.data[o]!, lo.data[o + 1]!, lo.data[o + 2]!, 255];
    });
    const v = evaluateAtlasUpgrade(lo, hi);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('aspect');
    expect(v.aspectDelta).toBeGreaterThan(DEFAULT_MAX_ASPECT_DELTA);
  });

  test('长宽比一致但内容是错的（整体错位）→ 拒绝', () => {
    // 注意不能用棋盘格做基准：它是周期的，平移偶数像素会「看起来一样」。
    // 这里用渐变，任何平移都会明显改变像素值。
    const grad = (x: number, y: number): [number, number, number, number] => [
      (x * 15) % 256,
      (y * 15) % 256,
      128,
      255,
    ];
    const lo = make(16, 16, grad);
    const hi = make(32, 32, (x, y) => {
      // 平移 6px 后再放大：长宽比一样，内容对不上
      const sx = ((x / 2 | 0) + 6) % 16;
      const sy = ((y / 2 | 0) + 6) % 16;
      const o = (sy * 16 + sx) * 4;
      return [lo.data[o]!, lo.data[o + 1]!, lo.data[o + 2]!, 255];
    });
    const v = evaluateAtlasUpgrade(lo, hi);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('content');
    expect(v.meanAbsError).toBeGreaterThan(DEFAULT_MAX_MEAN_ERROR);
  });

  test('高清版并不更大 → 拒绝（换了也没意义）', () => {
    const lo = make(8, 8, checker);
    const same = make(8, 8, checker);
    expect(evaluateAtlasUpgrade(lo, same).ok).toBe(false);
  });

  test('缩略图全透明 → 无法判定，拒绝（宁可不换，不能换错）', () => {
    const lo = make(8, 8, () => [0, 0, 0, 0]);
    const hi = upscale(make(8, 8, checker), 2);
    const v = evaluateAtlasUpgrade(lo, hi);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('empty');
  });

  test('缩略图的透明区域不参与比较（避免透明填充的色值拉高误差）', () => {
    // 左半不透明棋盘、右半全透明；高清版右半填了乱七八糟的颜色
    const half = (x: number, y: number): [number, number, number, number] =>
      x < 4 ? checker(x, y) : [255, 0, 255, 0];
    const lo = make(8, 8, half);
    const hi = make(16, 16, (x, y) => {
      if (x >= 8) return [1, 2, 3, 255]; // 透明区随便填
      const o = ((y / 2 | 0) * 8 + (x / 2 | 0)) * 4;
      return [lo.data[o]!, lo.data[o + 1]!, lo.data[o + 2]!, 255];
    });
    const v = evaluateAtlasUpgrade(lo, hi);
    expect(v.ok).toBe(true);
    expect(v.meanAbsError).toBeLessThan(2);
  });

  test('噪声冒充高清版 → 拒绝', () => {
    const lo = make(16, 16, checker);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 256;
    };
    const hi = make(32, 32, () => [rnd(), rnd(), rnd(), 255]);
    const v = evaluateAtlasUpgrade(lo, hi);
    expect(v.ok).toBe(false);
    expect(v.meanAbsError).toBeGreaterThan(DEFAULT_MAX_MEAN_ERROR);
  });

  test('解不出来的格式 → undecodable，不崩', () => {
    const lo = make(8, 8, checker);
    const hi: AtlasPixels = { width: 16, height: 16, data: new Uint8Array(4), compressType: 999, pixelFormat: 999 };
    const v = evaluateAtlasUpgrade(lo, hi);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('undecodable');
  });
});
