/**
 * 图集「内联 mip 列」的校验与补齐（**诊断工具，不在渲染路径上**）。
 *
 * S3MBLOCK 每个精灵 rect 的右 1/3 按官方约定是 1/2、1/4、1/8… 的缩略图，`StyleMaterial`
 * 的 `s3mAtlasUnit` 在 mip≥1 时就按固定公式去那里采样。理论上服务端不保证每个精灵都写了
 * 这一列，所以这里提供「检测 + 就地补一份正确金字塔」的能力。
 *
 * ★ 为什么没有接到 createTexture 上（2026-11-25 实测）：
 *   - Bridge@CBD 的 4 张图集、45 个精灵缺列 0 个 —— 桥面消失/串位的真实原因是 CRN 解码
 *     少翻了行（见 core/TextureDecode.ts 的 flipY），与本模块无关。
 *   - 但接上去之后，场景里几乎所有图集都被判「缺列」（15/18、19/20、20/20 …），
 *     说明判据在其它数据集的排版上误报率极高；自动改写会重绘别的图层的图集，
 *     风险远大于收益。
 * 因此保留为可离线调用的诊断工具（配 tests/unit/atlas-mip-repair.test.ts），
 * 需要时对指定图集手动跑，**不要**默认接进渲染管线。
 */

export interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 判定用的平均绝对误差上限（0..255，逐通道）。实测正常金字塔 <8，空列/错列 >60 */
export const MIP_COLUMN_MAX_ERROR = 20;

const px = (rgba: Uint8Array, w: number, x: number, y: number): number => (y * w + x) * 4;

/**
 * 该精灵的右列 m1 块是否真的等于「左 2/3 的 1/2 面积平均」。
 *
 * 只比不透明像素：透明填充处的 RGB 没有意义（与 `AtlasUpgrade` 的口径一致）。
 */
export function hasMipColumn(rgba: Uint8Array, atlasW: number, rect: SpriteRect): boolean {
  const baseW = Math.round((rect.w * 2) / 3);
  const outW = rect.w - baseW;
  const cw = Math.min(baseW >> 1, outW);
  const ch = rect.h >> 1;
  if (cw < 2 || ch < 2) return true; // 太小，无从判断，按「有」处理（保持原行为）

  let err = 0;
  let n = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0, a = 0, k = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const o = px(rgba, atlasW, rect.x + Math.min(x * 2 + dx, baseW - 1), rect.y + Math.min(y * 2 + dy, rect.h - 1));
          r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; a += rgba[o + 3];
          k++;
        }
      }
      const o = px(rgba, atlasW, rect.x + baseW + x, rect.y + y);
      const qa = rgba[o + 3];
      // 参考像素几乎全透明 → 没有可比的内容
      if (a / k < 8) continue;
      if (qa < 8) return false; // 该有内容的地方是空的 → 列不可用
      err += Math.abs(rgba[o] - r / k) + Math.abs(rgba[o + 1] - g / k) + Math.abs(rgba[o + 2] - b / k);
      n += 3;
    }
  }
  if (!n) return true; // 整块都透明：无从判断
  return err / n <= MIP_COLUMN_MAX_ERROR;
}

/**
 * 把缺失的内联 mip 列按官方布局补齐（就地改写 rgba）。
 *
 * 布局与 `StyleMaterial.s3mAtlasLod` 严格对应：第 m 级块的顶边在 rect 高度的
 * `(2^(m-1)-1)/2^(m-1)` 处（m1 @ 0、m2 @ h/2、m3 @ 3h/4、m4 @ 7h/8 …），
 * 每级宽 = 左 2/3 宽的 1/2^m，左对齐到列首。
 */
export function repairMipColumn(rgba: Uint8Array, atlasW: number, rect: SpriteRect): void {
  const baseW = Math.round((rect.w * 2) / 3);
  const colW = rect.w - baseW;
  if (colW <= 0) return;
  const levels = Math.floor(Math.log2(Math.max(2, Math.min(baseW, rect.h))));
  for (let m = 1; m <= levels; m++) {
    const cw = Math.max(1, Math.round(baseW / 2 ** m));
    const ch = Math.max(1, Math.round(rect.h / 2 ** m));
    if (cw > colW || ch > rect.h) break;
    const oy = rect.y + Math.round((rect.h * (2 ** (m - 1) - 1)) / 2 ** (m - 1));
    if (oy + ch > rect.y + rect.h) break;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        // 面积平均：一次下采样 2^m 见方
        const step = 2 ** m;
        const sx0 = rect.x + Math.min(x * step, baseW - 1);
        const sy0 = rect.y + Math.min(y * step, rect.h - 1);
        let r = 0, g = 0, b = 0, a = 0, k = 0;
        for (let dy = 0; dy < step; dy++) {
          for (let dx = 0; dx < step; dx++) {
            const sx = Math.min(sx0 + dx, rect.x + baseW - 1);
            const sy = Math.min(sy0 + dy, rect.y + rect.h - 1);
            const o = px(rgba, atlasW, sx, sy);
            r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; a += rgba[o + 3];
            k++;
          }
        }
        const o = px(rgba, atlasW, rect.x + baseW + x, oy + y);
        rgba[o] = Math.round(r / k);
        rgba[o + 1] = Math.round(g / k);
        rgba[o + 2] = Math.round(b / k);
        rgba[o + 3] = Math.round(a / k);
      }
    }
  }
}

/**
 * 逐精灵校验；缺列的补齐。返回补齐的精灵数（0 表示这张图集本来就是好的）。
 *
 * 只处理「与 base 尺寸相符」的 rect（列宽 = w/3），其余形态不做假设。
 */
export function repairAtlasMipColumns(rgba: Uint8Array, atlasW: number, rects: readonly SpriteRect[]): number {
  let fixed = 0;
  for (const rect of rects) {
    if (rect.w < 8 || rect.h < 4) continue;
    const baseW = Math.round((rect.w * 2) / 3);
    if (rect.w - baseW !== Math.round(rect.w / 3)) continue;
    if (hasMipColumn(rgba, atlasW, rect)) continue;
    repairMipColumn(rgba, atlasW, rect);
    fixed++;
  }
  return fixed;
}
