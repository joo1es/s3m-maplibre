/**
 * 高清子图集（`.texblock`）能不能顶替块内嵌缩略图？——**先验证，再替换**。
 *
 * 背景：S3MBLOCK 的每张根图集都挂 `childTexNames`，指向同名的独立 `.texblock` 文件。
 * 以前的做法是「无条件整体换图」，前提是「同一套排布、只是分辨率更高」。
 * 实测这个前提**只对一部分图集成立**（`3D-OlympicGreen/Building` 两块 9 张图集里只有 2 张）：
 *
 * | 缩略图 | 高清 | 长宽比偏差 | 下采样后色差 |
 * |---|---|---|---|
 * | 96×64 | 192×128 | 0.0% | **8.5** ← 真·高清版，换对了 |
 * | 96×64 | 192×128 | 0.0% | **11.2** ← 同上 |
 * | 108×192 | 204×384 | −5.6% | 43.3 ← 另一张图 |
 * | 120×184 | 300×304 | +51.3% | 83.3 ← 另一张图 |
 * | 96×192 | 192×128 | +200% | 63.4 ← 根本不是同一张 |
 *
 * 长宽比对不上就说明高清版是**重新排版**过的，`subTexInfos` 的 offset/width 是缩略图坐标，
 * 直接套到高清图上会整张错位（比不换更糟）。所以这里给出一个可判定的判据：
 *
 *   1. 长宽比偏差 ≤ 2%（等比放大才可能「换图不换归一化 rect」）
 *   2. 把高清图面积平均缩到缩略图尺寸后，不透明区域的 RGB 平均绝对误差 ≤ 24/255
 *
 * 两条都过才认为可以替换。纯色/全透明图集无法判定，一律不换（宁可不换，不能换错）。
 */

import DXTTextureDecode from './DXTTextureDecode.js';
import { dxtPixelFormatOf, resolveTextureKind } from './TextureFormat.js';

export interface AtlasPixels {
  width: number;
  height: number;
  data: Uint8Array;
  /** 文件里声明的格式；DXT 族的真实块格式以 compressType 为准（pf 常是 13/ABGR 的错标签） */
  compressType: number;
  pixelFormat: number;
}

export interface UpgradeVerdict {
  ok: boolean;
  reason: 'ok' | 'aspect' | 'scale' | 'content' | 'undecodable' | 'empty';
  /** |hi.aspect / lo.aspect - 1|，0 表示完全等比 */
  aspectDelta: number;
  /** 等比倍数（hi / lo）。只有 ok 时才保证是**整数**且两轴相同 */
  scale: number;
  /** 不透明区域 RGB 的平均绝对误差（0..255）；无法比较时为 NaN */
  meanAbsError: number;
}

export const DEFAULT_MAX_ASPECT_DELTA = 0.02;
export const DEFAULT_MAX_MEAN_ERROR = 24;

/**
 * 解成 RGBA。**不翻行**：比较双方都用同一套方向，翻不翻不影响结论。
 * 非 DXT / 解不出来返回 null。
 */
function decodeRgba(tex: AtlasPixels): Uint8Array | null {
  if (!tex.data?.length || !tex.width || !tex.height) return null;
  // 已经是 RGBA（AtlasPack 拼图、或某些服务端直接给 RGBA 的 .texblock）
  const need = tex.width * tex.height * 4;
  if (tex.compressType === 0 && tex.pixelFormat === 28 && tex.data.length >= need) {
    return tex.data.subarray(0, need);
  }
  const kind = resolveTextureKind(tex.compressType, tex.pixelFormat);
  if (!kind.startsWith('dxt')) return null;
  const out = new Uint8Array(tex.width * tex.height * 4);
  try {
    DXTTextureDecode.decode(out, tex.width, tex.height, tex.data, dxtPixelFormatOf(kind as 'dxt1'));
  } catch {
    return null;
  }
  return out;
}

/** 面积平均缩小到 dw×dh（最近邻会在比较时引入大量假误差，必须用面积平均） */
export function boxDownsample(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let ty = 0; ty < dh; ty++) {
    const y0 = (ty * sh) / dh;
    const y1 = ((ty + 1) * sh) / dh;
    for (let tx = 0; tx < dw; tx++) {
      const x0 = (tx * sw) / dw;
      const x1 = ((tx + 1) * sw) / dw;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const cx = Math.min(sw - 1, x);
          const cy = Math.min(sh - 1, y);
          const o = (cy * sw + cx) * 4;
          r += src[o]!;
          g += src[o + 1]!;
          b += src[o + 2]!;
          a += src[o + 3]!;
          n++;
        }
      }
      const o = (ty * dw + tx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/**
 * 判断 `hi` 是否可以顶替 `lo`。
 *
 * @param lo 块内嵌的缩略图（`subTexInfos` 的坐标就是按它算的）
 * @param hi `.texblock` 里解析出来的高清图
 */
export function evaluateAtlasUpgrade(
  lo: AtlasPixels,
  hi: AtlasPixels,
  opts: { maxAspectDelta?: number; maxMeanError?: number } = {}
): UpgradeVerdict {
  const maxAspect = opts.maxAspectDelta ?? DEFAULT_MAX_ASPECT_DELTA;
  const maxErr = opts.maxMeanError ?? DEFAULT_MAX_MEAN_ERROR;

  const loAspect = lo.width / lo.height;
  const hiAspect = hi.width / hi.height;
  const aspectDelta = Math.abs(hiAspect / loAspect - 1);
  const scale = hi.width / lo.width;
  const scaleY = hi.height / lo.height;
  const fail = (reason: UpgradeVerdict['reason']): UpgradeVerdict => ({
    ok: false,
    reason,
    aspectDelta,
    scale,
    meanAbsError: NaN,
  });

  if (!Number.isFinite(aspectDelta)) return fail('aspect');
  if (aspectDelta > maxAspect) return fail('aspect');
  // 高清版必须真的更大，否则换了没意义
  if (hi.width * hi.height <= lo.width * lo.height) return fail('content');
  // ★ 必须**整数等比**：subTexInfos 的 offset/width 是缩略图像素坐标，换图后要按倍数
  //   精确换算（见 S3MBlockTexture.rectScale）。非整数倍会让 rect 落到半个纹素上，
  //   平铺时逐格漂移 —— 宁可不换。
  if (scale !== scaleY || !Number.isInteger(scale)) return fail('scale');

  const loPx = decodeRgba(lo);
  const hiPx = decodeRgba(hi);
  if (!loPx || !hiPx) return fail('undecodable');

  const down = boxDownsample(hiPx, hi.width, hi.height, lo.width, lo.height);
  let err = 0;
  let n = 0;
  for (let i = 0; i < lo.width * lo.height; i++) {
    // 只比不透明区域：透明填充的色值没有意义
    if (loPx[i * 4 + 3]! < 8) continue;
    for (let c = 0; c < 3; c++) err += Math.abs(loPx[i * 4 + c]! - down[i * 4 + c]!);
    n += 3;
  }
  if (n === 0) return fail('empty');

  const meanAbsError = err / n;
  return {
    ok: meanAbsError <= maxErr,
    reason: meanAbsError <= maxErr ? 'ok' : 'content',
    aspectDelta,
    scale,
    meanAbsError,
  };
}
