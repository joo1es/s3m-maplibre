/**
 * 外部图集文件（`requestNames` 指向的 `.texblock`）能不能顶替块里自带的那份？
 * —— **先验证，再替换**。
 *
 * 官方 `createTexture` 的判定（SuperMap3D.js，`lM.prototype.createTexture`）：
 *
 * ```js
 * if (!n || !E) {                       // 非根瓦片，或没开 textureLod
 *   this._subRequestNames = [];
 *   for (...) this._subRequestNames.push(yke(h.requestNames[D]));  // 只取 requestNames
 * }
 * return this.isLeaf = (!n || !E) && !(h.requestNames.length === 1 && h.requestNames[0] === a);
 * ```
 *
 * 关键两点：
 * 1. **只认 `requestNames`**。`childTexNames` 是**下一级 LOD 的图集指针**（官方 `_ancestorTexture`
 *    只用它继承 batchTable 的 rect），同一个精灵在父级叫 `1460_3` 96×64、子级叫 `1460_2` 192×128，
 *    排布完全不同。拿父级的 rect 去套子级像素必然整张错位 —— 这是曾经踩过的坑。
 * 2. `requestNames.length === 1 && requestNames[0] === 自身 id` → `isLeaf = false` → **整张替换**；
 *    否则是 leaf → 逐精灵贴进图集（那条路要解析多精灵容器，见 HANDOFF）。
 *
 * 本模块只负责「整张替换」这一支的判据：替换前后必须是**同一套排布**，否则 rect 全错。
 *
 * | 缩略图 | 外部文件 | 长宽比偏差 | 下采样后色差 | 结论 |
 * |---|---|---|---|---|
 * | 96×64 | 192×128 | 0.0% | **8.5** | 同一张图，换对了 |
 * | 108×192 | 204×384 | −5.6% | 43.3 | 不是同一张 |
 * | 96×192 | 192×128 | +200% | 63.4 | 根本不是这张 |
 *
 * 判据（三条全过才允许换）：
 *   1. 长宽比偏差 ≤ 2%
 *   2. 两轴必须是**同一个整数倍**（`subTexInfos` 的像素 offset 要能精确换算，见 rectScale）
 *   3. 面积平均缩到缩略图尺寸后，不透明区域 RGB 平均绝对误差 ≤ 24/255
 * 纯色/全透明图集无法判定，一律不换（宁可不换，不能换错）。
 */

import DXTTextureDecode from './DXTTextureDecode.js';
import { isSaneImageSize } from './imageLimits.js';
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
  if (!isSaneImageSize(tex.width, tex.height)) return null;
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
  if (!isSaneImageSize(dw, dh)) {
    // 目标尺寸异常：返回空缓冲而不是抛错（调用方按下标读，全 0 等价于「没有像素」）
    return new Uint8Array(0);
  }
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

/**
 * **没有缩略图基准**时（子瓦片：`texturePackage` 里 `data = null`）判断外拉的
 * `.texblock` 图集能不能直接替换元信息里的那份。
 *
 * 子瓦没有可比的低清图，`evaluateAtlasUpgrade` 那条路走不了（没有色差可算）。
 * 但「整数等比」这一条**不依赖基准**，必须单独验：
 *
 *   `subTexInfos` 的 offset/width 是像素，替换后按 `rectScale = imgW / atlasW`
 *   换算到新图空间。只有同一个整数倍时结果才落在整数像素上；1.37 倍会让 rect 落到
 *   半个纹素，双线性采样把邻格内容混进来 —— 视觉上就是「同一块花纹重复出现」和
 *   「规整的深色块」。
 *
 * 旧实现这里只比长宽比（2%），于是 1.37 倍这种"形状一样、倍率不对"的图会被放行，
 * 一贴上就整片串位。这个函数就是补上缺的那半条判据。
 */
export function canAdoptAtlasWithoutBaseline(
  atlasW: number,
  atlasH: number,
  imgW: number,
  imgH: number,
  maxAspectDelta: number = DEFAULT_MAX_ASPECT_DELTA
): boolean {
  if (
    !Number.isFinite(atlasW) ||
    !Number.isFinite(atlasH) ||
    !Number.isFinite(imgW) ||
    !Number.isFinite(imgH) ||
    atlasW <= 0 ||
    atlasH <= 0 ||
    imgW <= 0 ||
    imgH <= 0
  ) {
    return false;
  }

  const loAspect = atlasW / atlasH;
  const hiAspect = imgW / imgH;
  const aspectDelta = Math.abs(hiAspect / loAspect - 1);
  if (!Number.isFinite(aspectDelta) || aspectDelta > maxAspectDelta) return false;

  const scaleX = imgW / atlasW;
  const scaleY = imgH / atlasH;
  // 两轴必须同一个倍率，且必须是整数 —— rect 换算只有一个 rectScale
  if (Math.abs(scaleX - scaleY) > 1e-6) return false;
  const n = Math.round(scaleX);
  if (n < 1) return false;
  return Math.abs(scaleX - n) <= 1e-6;
}

/**
 * 从一个 `.texblock` 文件解析出的记录里挑出「哪张才是这张图集」。
 *
 * 一个文件可能装多条记录（`Tile_6_000000.texblock` 实测 16 条）。旧实现盲取
 * `recs[0]`，于是经常拿到**另一张图集**：元信息声明 1536x1024，实际选中的是
 * 384x256 那张 —— `rectScale` 变成 0.25，整块瓦片的 rect 一起缩到角落，贴图串位。
 *
 * 优先按名字匹配（大小写与扩展名都不敏感），匹配不上才退回第一条，保持旧行为兜底。
 */
export function pickAtlasCandidate<T extends { id: string }>(
  recs: readonly T[] | undefined | null,
  name: string
): T | null {
  if (!recs || !recs.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\.texblock$/i, '');
  const want = norm(name);
  return recs.find((r) => norm(r.id) === want) ?? recs[0] ?? null;
}
