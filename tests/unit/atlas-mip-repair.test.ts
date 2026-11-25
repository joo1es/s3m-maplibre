/**
 * 图集内联 mip 列的校验与补齐。
 *
 * 背景：S3MBLOCK 每个精灵 rect 的右 1/3 是官方约定的 mip 缩略图列，
 * `StyleMaterial.s3mAtlasUnit` 在 mip≥1 时按固定公式去那里采样。空列会被采成透明
 * （配 alphaTest = 镂空），写错则是贴图串位。
 *
 * 注意：本模块是**诊断工具**，没有接进 createTexture —— 实测它在真实数据上误报太多
 * （Bridge 根瓦片缺列 0，但整个场景几乎每张图集都被判缺列），自动改写会污染其它图层；
 * 桥面的真实原因是 CRN 解码没翻行。测试钉的是判据与补齐本身的契约：
 *
 *   1. 空列必须被识别出来（hasMipColumn = false）
 *   2. 补齐之后，右列每一级都要等于左 2/3 的对应面积平均
 *   3. 正确图集必须零改动（否则就是误报）
 *
 * 判据用像素本身，不依赖任何服务端数据，所以能当回归测试跑。
 */
import { describe, expect, test } from 'bun:test';
import {
  MIP_COLUMN_MAX_ERROR,
  hasMipColumn,
  repairAtlasMipColumns,
  repairMipColumn,
  type SpriteRect,
} from '../../packages/s3m-three/src/core/AtlasMipRepair';

const W = 96;
const H = 32;

/** 在 rgba 上写一块带纹理的「内容」：按坐标做条纹，保证下采样后不是常数 */
function paintBase(rgba: Uint8Array, rect: SpriteRect, baseW: number): void {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < baseW; x++) {
      const o = ((rect.y + y) * W + rect.x + x) * 4;
      const v = 40 + ((x * 7 + y * 13) % 160);
      rgba[o] = v;
      rgba[o + 1] = 255 - v;
      rgba[o + 2] = (v * 3) % 255;
      rgba[o + 3] = 255;
    }
  }
}

/** 按官方布局往右列写金字塔 */
function paintColumn(rgba: Uint8Array, rect: SpriteRect, baseW: number): void {
  const levels = Math.floor(Math.log2(Math.min(baseW, rect.h)));
  for (let m = 1; m <= levels; m++) {
    const cw = Math.max(1, Math.round(baseW / 2 ** m));
    const ch = Math.max(1, Math.round(rect.h / 2 ** m));
    const oy = rect.y + Math.round((rect.h * (2 ** (m - 1) - 1)) / 2 ** (m - 1));
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const step = 2 ** m;
        let r = 0, g = 0, b = 0, a = 0, k = 0;
        for (let dy = 0; dy < step; dy++) {
          for (let dx = 0; dx < step; dx++) {
            const sx = Math.min(rect.x + x * step + dx, rect.x + baseW - 1);
            const sy = Math.min(rect.y + y * step + dy, rect.y + rect.h - 1);
            const o = (sy * W + sx) * 4;
            r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; a += rgba[o + 3];
            k++;
          }
        }
        const o = ((oy + y) * W + rect.x + baseW + x) * 4;
        rgba[o] = Math.round(r / k);
        rgba[o + 1] = Math.round(g / k);
        rgba[o + 2] = Math.round(b / k);
        rgba[o + 3] = Math.round(a / k);
      }
    }
  }
}

function blank(): Uint8Array {
  return new Uint8Array(W * H * 4);
}

describe('图集内联 mip 列', () => {
  const good: SpriteRect = { x: 0, y: 0, w: 48, h: 16 };
  const broken: SpriteRect = { x: 48, y: 0, w: 48, h: 16 };

  function atlasWith(blankColumn: boolean): Uint8Array {
    const rgba = blank();
    paintBase(rgba, good, 32);
    paintColumn(rgba, good, 32);
    paintBase(rgba, broken, 32);
    if (!blankColumn) paintColumn(rgba, broken, 32);
    return rgba;
  }

  test('右列是正确金字塔 → 判定为「有」，不修补', () => {
    const rgba = atlasWith(false);
    expect(hasMipColumn(rgba, W, good)).toBe(true);
    expect(hasMipColumn(rgba, W, broken)).toBe(true);
    expect(repairAtlasMipColumns(rgba, W, [good, broken])).toBe(0);
  });

  test('右列全透明 → 判定为「没有」，且逐个识别出来', () => {
    const rgba = atlasWith(true);
    expect(hasMipColumn(rgba, W, good)).toBe(true);
    expect(hasMipColumn(rgba, W, broken)).toBe(false);
    expect(repairAtlasMipColumns(rgba, W, [good, broken])).toBe(1);
  });

  test('补齐后右列与左 2/3 的面积平均一致（每一级）', () => {
    const rgba = atlasWith(true);
    repairMipColumn(rgba, W, broken);
    const baseW = 32;
    const levels = Math.floor(Math.log2(Math.min(baseW, broken.h)));
    for (let m = 1; m <= levels; m++) {
      const step = 2 ** m;
      const cw = Math.max(1, Math.round(baseW / step));
      const ch = Math.max(1, Math.round(broken.h / step));
      const oy = broken.y + Math.round((broken.h * (2 ** (m - 1) - 1)) / 2 ** (m - 1));
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          let r = 0, g = 0, b = 0, k = 0;
          for (let dy = 0; dy < step; dy++) {
            for (let dx = 0; dx < step; dx++) {
              const sx = Math.min(broken.x + x * step + dx, broken.x + baseW - 1);
              const sy = Math.min(broken.y + y * step + dy, broken.y + broken.h - 1);
              const o = (sy * W + sx) * 4;
              r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; k++;
            }
          }
          const o = ((oy + y) * W + broken.x + baseW + x) * 4;
          expect(Math.abs(rgba[o] - r / k)).toBeLessThanOrEqual(1);
          expect(Math.abs(rgba[o + 1] - g / k)).toBeLessThanOrEqual(1);
          expect(Math.abs(rgba[o + 2] - b / k)).toBeLessThanOrEqual(1);
          // 关键：补出来的列不能再是透明的，否则远处照样镂空
          expect(rgba[o + 3]).toBeGreaterThan(200);
        }
      }
    }
    // 补完之后判定必须翻成「有」，否则下一帧还会修
    expect(hasMipColumn(rgba, W, broken)).toBe(true);
  });

  test('左右两块互不干扰：修 broken 不能动 good', () => {
    const rgba = atlasWith(true);
    const snap = (r: SpriteRect): number[] => {
      const out: number[] = [];
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const o = ((r.y + y) * W + r.x + x) * 4;
          out.push(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]);
        }
      }
      return out;
    };
    const before = snap(good);
    repairAtlasMipColumns(rgba, W, [good, broken]);
    expect(snap(good)).toEqual(before);
  });

  test('误差阈值必须是能区分「空列」和「正确列」的那一档', () => {
    // 空列：右列 alpha=0，会在 hasMipColumn 里直接判 false，不进入误差分支；
    // 这里额外钉住阈值本身，避免以后把阈值调大到把错列也放行。
    expect(MIP_COLUMN_MAX_ERROR).toBeGreaterThan(0);
    expect(MIP_COLUMN_MAX_ERROR).toBeLessThan(40);
  });
});
