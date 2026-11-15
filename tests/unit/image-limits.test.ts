/**
 * 图像尺寸上限守卫。
 *
 * 背景：S3M 里所有图像尺寸都是 `r.u32()` 直读、没有校验。数据错位 / 截断 / 异构版本
 * 会让某个值变成 4e9 这种数，下游 `new Uint8Array(w * h * 4)` 直接抛
 * `RangeError: Array buffer allocation failed` —— **和真的内存不足报错完全一样**，
 * 排查时极容易误判成 OOM 去查缓存，方向就走偏了。
 *
 * 这里钉两件事：
 *   1. 判定函数本身的边界（0 / 负数 / NaN / 小数 / 超单边 / 超总量）；
 *   2. 各个分配点遇到异常尺寸时**返回 null / 空产物**，而不是尝试分配。
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_IMAGE_BYTES,
  MAX_TEXTURE_DIMENSION,
  isSaneImageSize,
  isSaneSubValue,
} from '../../packages/s3m-three/src/core/imageLimits';
import { decodeAtlasImage, packAtlases } from '../../packages/s3m-three/src/core/AtlasPack';
import { composeLeafAtlas } from '../../packages/s3m-three/src/core/S3MBlockParser';
import { decodeTextureData } from '../../packages/s3m-three/src/core/TextureDecode';
import type { S3MTexture } from '../../packages/s3m-three/src/core/types';

/* ------------------------------------------------------------ 判定函数 */

describe('isSaneImageSize', () => {
  test('常规尺寸通过（含单边上限本身）', () => {
    expect(isSaneImageSize(1, 1)).toBe(true);
    expect(isSaneImageSize(1024, 1024)).toBe(true);
    expect(isSaneImageSize(16384, 1024)).toBe(true);
  });

  test('0 / 负数 / 小数 / 非数字 一律拒绝', () => {
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [-1, 100],
      [100.5, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100],
    ]) {
      expect(isSaneImageSize(w, h)).toBe(false);
    }
    expect(isSaneImageSize('100', 100)).toBe(false);
    expect(isSaneImageSize(null, undefined)).toBe(false);
  });

  test('单边超上限拒绝（u32 错位的典型值）', () => {
    expect(isSaneImageSize(MAX_TEXTURE_DIMENSION + 1, 1)).toBe(false);
    expect(isSaneImageSize(0xffffffff, 1)).toBe(false);
    expect(isSaneImageSize(1, 0xffffffff)).toBe(false);
  });

  test('面积超总量拒绝：单边都合法，但 w*h*4 超过 256MB', () => {
    // 16384×16384 = 1GB > 256MB，必须被拦
    expect(isSaneImageSize(16384, 16384)).toBe(false);
    const side = Math.floor(Math.sqrt(MAX_IMAGE_BYTES / 4));
    expect(isSaneImageSize(side, side)).toBe(true);
    expect(isSaneImageSize(side + 1, side)).toBe(false);
  });
});

describe('isSaneSubValue', () => {
  test('offset / 宽高只接受有限非负整数，且不超单边上限', () => {
    expect(isSaneSubValue(0)).toBe(true);
    expect(isSaneSubValue(1024)).toBe(true);
    expect(isSaneSubValue(-1)).toBe(false);
    expect(isSaneSubValue(1.5)).toBe(false);
    expect(isSaneSubValue(0xffffffff)).toBe(false);
    expect(isSaneSubValue(Number.NaN)).toBe(false);
  });
});

/* ------------------------------------------------------------ 分配点行为 */

/** 任意非空数据，尺寸校验发生在看数据之前 */
const dummyData = new Uint8Array(16);

/** 一张合法的 RGBA 小图（16×16，compressType 0 / pixelFormat 28 = 直通 RGBA） */
const rgbaSprite = {
  id: 'a',
  width: 16,
  height: 16,
  compressType: 0,
  pixelFormat: 28,
  data: new Uint8Array(16 * 16 * 4),
};

describe('各分配点遇到异常尺寸不尝试分配', () => {
  test('decodeAtlasImage：单张图集尺寸异常返回 null', () => {
    expect(
      decodeAtlasImage({ width: 0xffffffff, height: 1024, compressType: 14, pixelFormat: 21, data: dummyData })
    ).toBeNull();
    // 对照：正常尺寸的解码不会被误伤（这里数据是假的，DXT 解出来是垃圾，但**不返回 null**）
    expect(
      decodeAtlasImage({ width: 4, height: 4, compressType: 14, pixelFormat: 21, data: new Uint8Array(16) })
    ).not.toBeNull();
  });

  test('composeLeafAtlas：画布超限返回 null（而不是开一块 4GB 的画布）', () => {
    const tex = {
      width: 1024,
      height: 1024,
      subTexInfos: [
        { subName: 'a', offsetX: 0, offsetY: 0, width: 16, height: 16, bindings: [] },
      ],
    };
    const sprites = new Map([['a', { source: 'x', image: rgbaSprite as never }]]);
    // 正常尺寸能组合出来
    expect(composeLeafAtlas(tex as never, sprites)).not.toBeNull();

    // 声明尺寸异常 → 直接 null
    const huge = { ...tex, width: 0xffffffff, height: 0xffffffff };
    expect(composeLeafAtlas(huge as never, sprites)).toBeNull();

    // 精灵把画布撑爆（offset 已在解析处夹过，但这里直接喂函数，验证函数自身也守）
    const poke = {
      width: 64,
      height: 64,
      subTexInfos: [{ subName: 'a', offsetX: 0, offsetY: 16000, width: 16, height: 16, bindings: [] }],
    };
    const tall = new Map([
      [
        'a',
        {
          source: 'x',
          image: { ...rgbaSprite, height: 16000, data: new Uint8Array(16 * 16000 * 4) } as never,
        },
      ],
    ]);
    expect(composeLeafAtlas(poke as never, tall)).toBeNull();
  });

  test('packAtlases：货架累加后超限整体放弃', () => {
    // 四张 8192 宽的图：单张合法（8192×64×4=2MB），货架 H 累加到 4×64 仍然合法
    const make = (i: number) => ({
      width: 512,
      height: 64,
      compressType: 0,
      pixelFormat: 28,
      // 尺寸校验在数据长度检查之前，这里只要非空
      data: new Uint8Array(64),
      id: `a${i}`,
    });
    const normal = Object.fromEntries([0, 1, 2, 3].map((i) => [`a${i}`, make(i)]));
    // 单张 8192×64 的数据长度不等于 w*h*4，会走 DXT 分支；这里只关心「不返回 null 就说明没被尺寸守卫误杀」
    expect(() => packAtlases(normal as never)).not.toThrow();

    // 塞一张异常尺寸进去：decodeAtlasImage 返回 null → 整体放弃
    const withBad = { ...normal, bad: { ...make(9), width: 0xffffffff, height: 0xffffffff } };
    expect(packAtlases(withBad as never)).toBeNull();
  });

  test('decodeTextureData：尺寸异常返回 unsupported，不抛 RangeError', async () => {
    const tex = {
      code: 'T',
      level: 0,
      width: 0xffffffff,
      height: 0xffffffff,
      compressType: 0,
      pixelFormat: 28,
      data: dummyData,
    } as unknown as S3MTexture;

    const out = await decodeTextureData(tex);
    expect(out.rgba).toBeNull();
    expect(out.kind).toContain('unsupported');
    // 关键：不能是 RangeError
    expect(out.width).toBe(0);
  });
});
