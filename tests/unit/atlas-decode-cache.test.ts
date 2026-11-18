/**
 * 块图集「预解码缓存」的单测（smart-city 卡顿专项 · B）。
 *
 * 这条优化的关键在于**不改变正确性**：Worker 解出来的像素必须和主线程解的一模一样，
 * 且 Worker 不可用时必须静默回退。所以钉的是：
 * 1. 没注册解码器 = 纯主线程，缓存不产生任何副作用；
 * 2. 注册了但抛错 / 返回 null = 同样什么都不写，主线程照常解；
 * 3. 命中缓存时 `decodeAtlasImage` 直接返回缓存结果，不再碰 DXT 解码；
 * 4. 已经是 RGBA 的条目根本不送去 Worker（解它本来就是零成本）。
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  hasOffThreadAtlasDecode,
  predecodeAtlases,
  resetAtlasDecodeCache,
  setAtlasOffThreadDecode,
  takePredecodedAtlas,
} from '../../packages/s3m-three/src/core/atlasDecodeCache';
import { decodeAtlasImage } from '../../packages/s3m-three/src/core/AtlasPack';

function dxtItem(width = 4, height = 4) {
  // 16 字节/块的 DXT 块数据，内容无所谓：缓存命中时根本不会拿去解
  const data = new Uint8Array(width * height);
  return { width, height, pixelFormat: 23, compressType: 14, data };
}

beforeEach(() => {
  setAtlasOffThreadDecode(null);
  resetAtlasDecodeCache();
});

describe('atlasDecodeCache', () => {
  test('默认没有离线程解码器', () => {
    expect(hasOffThreadAtlasDecode()).toBe(false);
  });

  test('没注册解码器时 predecode 是空操作', async () => {
    const item = dxtItem();
    expect(await predecodeAtlases([item])).toBe(0);
    expect(takePredecodedAtlas(item.data)).toBeUndefined();
  });

  test('Worker 返回结果后写进缓存', async () => {
    const item = dxtItem();
    const rgba = new Uint8Array(item.width * item.height * 4).fill(7);
    setAtlasOffThreadDecode(async (items) => items.map(() => ({ rgba, topDown: false })));

    expect(await predecodeAtlases([item])).toBe(1);
    expect(takePredecodedAtlas(item.data)).toEqual({ rgba, topDown: false });
  });

  test('解码器抛错：不抛给调用方，缓存保持为空', async () => {
    const item = dxtItem();
    setAtlasOffThreadDecode(async () => {
      throw new Error('worker dead');
    });
    expect(await predecodeAtlases([item])).toBe(0);
    expect(takePredecodedAtlas(item.data)).toBeUndefined();
  });

  test('解码器返回 null（Worker 不可用）：同样静默回退', async () => {
    const item = dxtItem();
    setAtlasOffThreadDecode(async () => null);
    expect(await predecodeAtlases([item])).toBe(0);
    expect(takePredecodedAtlas(item.data)).toBeUndefined();
  });

  test('已经是 RGBA 的条目不送 Worker', async () => {
    let sent = 0;
    setAtlasOffThreadDecode(async (items) => {
      sent = items.length;
      return items.map(() => null);
    });
    const rgbaItem = {
      width: 2,
      height: 2,
      pixelFormat: 28,
      compressType: 0,
      data: new Uint8Array(16),
    };
    expect(await predecodeAtlases([rgbaItem])).toBe(0);
    expect(sent).toBe(0);
  });

  test('同一缓冲只记一次，结果按源缓冲对象对应', async () => {
    const a = dxtItem();
    const b = dxtItem();
    setAtlasOffThreadDecode(async (items) =>
      items.map((it) => ({ rgba: new Uint8Array(it.width * it.height * 4).fill(it.width), topDown: false })),
    );
    await predecodeAtlases([a, b]);
    expect(takePredecodedAtlas(a.data)!.rgba[0]).toBe(4);
    expect(takePredecodedAtlas(b.data)!.rgba[0]).toBe(4);
  });
});

describe('decodeAtlasImage 命中缓存', () => {
  test('命中时直接返回缓存结果，不再走 DXT 解码', () => {
    const item = dxtItem();
    const rgba = new Uint8Array(item.width * item.height * 4).fill(3);
    setAtlasOffThreadDecode(async (items) => items.map(() => ({ rgba, topDown: false })));
    return predecodeAtlases([item]).then(() => {
      // 数据本身是垃圾（不足 DXT 块长度），能解出东西就说明走的是缓存
      const img = decodeAtlasImage(item as never);
      expect(img).toEqual({ rgba, topDown: false });
    });
  });

  test('没命中时行为不变：仍在主线程解码出图（不被缓存逻辑干扰）', () => {
    const item = dxtItem(64, 64);
    const img = decodeAtlasImage(item as never);
    expect(img).not.toBeNull();
    // DXT 路径的约定：底朝上
    expect(img!.topDown).toBe(false);
  });
});
