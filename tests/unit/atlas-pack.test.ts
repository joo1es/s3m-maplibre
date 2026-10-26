/**
 * AtlasPack 行序回归测试。
 *
 * 拼图必须让「第 0 行 = 源图顶行」，否则 rect 的 offsetY 约定与图集内容错位。
 * 这个 bug 的隐蔽之处在于：同一个块里各图集高度不同（实测 192 / 184 / 64 / 128），
 * 颠倒量随图集而异，于是「哪些精灵对」取决于它属于哪张图集 ——
 * 表现为同一面墙一半正常、一半贴到别处，很难从截图上归因。
 *
 * 这里用合成的 DXT5 数据直接测：每 4 行一个色带，行序一错立刻红。
 */
import { describe, expect, test } from 'bun:test';
import { packAtlases } from '../../packages/s3m-three/src/core/AtlasPack';

type Rgb = readonly [number, number, number];
const RED: Rgb = [248, 0, 0];
const BLUE: Rgb = [0, 0, 248];
const GREEN: Rgb = [0, 248, 0];
const YELLOW: Rgb = [248, 248, 0];
const MAGENTA: Rgb = [248, 0, 248];

/** 造一张 4×（4×bands）的 DXT5，自上而下每个 4 行带一种颜色 */
function dxt5Bands(bands: Rgb[]): Uint8Array {
  const block = ([r, g, b]: Rgb) => {
    const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    return [
      // alpha 块：a0 = a1 = 255，索引全 0 → 全不透明
      255, 255, 0, 0, 0, 0, 0, 0,
      // 颜色块：c0 = c1，索引全 0 → 整块同色
      v & 0xff, (v >> 8) & 0xff, v & 0xff, (v >> 8) & 0xff, 0, 0, 0, 0,
    ];
  };
  return new Uint8Array(bands.flatMap(block));
}

const dxtAtlas = (bands: Rgb[]) => ({
  width: 4,
  height: bands.length * 4,
  compressType: 14,
  pixelFormat: 21,
  data: dxt5Bands(bands),
});

const pixelAt = (data: Uint8Array, w: number, x: number, y: number) => {
  const o = (y * w + x) * 4;
  return [data[o]!, data[o + 1]!, data[o + 2]!] as const;
};

const near = (got: readonly number[], want: Rgb) =>
  Math.abs(got[0] - want[0]) < 12 && Math.abs(got[1] - want[1]) < 12 && Math.abs(got[2] - want[2]) < 12;

describe('AtlasPack 行序', () => {
  test('拼图第 0 行必须是源图顶行，且每张图集各自成立', () => {
    // 两张**高度不同**的图集：4x8 与 4x12。高度差正是这个 bug 藏身之处。
    const packed = packAtlases({
      'a.texblock': dxtAtlas([RED, BLUE]),
      'b.texblock': dxtAtlas([GREEN, YELLOW, MAGENTA]),
    });
    expect(packed).not.toBeNull();

    const a = packed!.offsets.get('a.texblock')!;
    const b = packed!.offsets.get('b.texblock')!;
    const W = packed!.width;
    const at = (x: number, y: number) => pixelAt(packed!.data, W, x, y);

    // 图集 a：顶行红、底行蓝
    expect(near(at(a.x, a.y), RED)).toBe(true);
    expect(near(at(a.x, a.y + 7), BLUE)).toBe(true);

    // 图集 b（高 12，颠倒量与 a 不同）：绿 / 黄 / 品红 三段都必须对上
    expect(near(at(b.x, b.y), GREEN)).toBe(true);
    expect(near(at(b.x, b.y + 4), YELLOW)).toBe(true);
    expect(near(at(b.x, b.y + 11), MAGENTA)).toBe(true);
  });

  test('单张图集不合并（保持原样，避免多一次解码）', () => {
    expect(packAtlases({ 'a.texblock': dxtAtlas([RED, BLUE]) })).toBeNull();
  });
});
