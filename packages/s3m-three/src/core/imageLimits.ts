/**
 * 图像尺寸的健全性上限。
 *
 * ## 为什么需要
 *
 * S3M 里所有图像尺寸（纹理宽高、图集子区域 offset / 宽高）都是从二进制里
 * `r.u32()` **直读**出来的，没有任何校验。正常数据当然没问题，但一旦出现
 * 数据错位 / 截断 / 异构版本，那个 u32 可能是 `0xFFFFFFFF`：
 *
 * ```
 * const W = sub.offsetX + sprite.image.width;   // 42 亿
 * const data = new Uint8Array(W * H * 4);       // → RangeError: Array buffer allocation failed
 * ```
 *
 * 抛出的错误和「真的内存不足」**一模一样**，日志上无法区分 —— 排查时极容易
 * 误判成 OOM 去查缓存，方向就走偏了。
 *
 * ## 这不是 OOM 的解药
 *
 * 真正的内存耗尽（多数据集各自一份缓存、解码峰值不受预算约束）不归这里管，
 * 加校验也治不了。这里只保证一件事：**单个异常尺寸不会把整页拖崩**，
 * 代价是那一块瓦片没贴图（本来也用不了）。
 *
 * ## 取值依据
 *
 * - 单边 16384：WebGL2 对 `MAX_TEXTURE_SIZE` 的保证下限，超过它就算分配成功也传不上 GPU；
 * - 总量 256 MB：单张 RGBA 超过这个数在任何机器上都不该一次性铺开。
 *
 * 两者取交集 —— 16384×16384 恰好 1 GB，会被 256 MB 那条先拦住。
 */

/** 单边上限（像素）。WebGL2 保证至少支持到这个尺寸 */
export const MAX_TEXTURE_DIMENSION = 16384;

/** 单张 RGBA 图像的内存上限（字节） */
export const MAX_IMAGE_BYTES = 256 * 1024 * 1024;

/** 4 字节/像素（RGBA8） */
const RGBA_BYTES_PER_PIXEL = 4;

/**
 * 这个宽高能否安全分配 `width * height * 4`。
 *
 * 只认「有限正整数 + 单边不超上限 + 总量不超上限」。`NaN` / `Infinity` /
 * 小数 / 0 一律拒绝 —— 它们都不该出现在这个位置。
 */
export function isSaneImageSize(width: unknown, height: unknown): boolean {
  if (typeof width !== 'number' || typeof height !== 'number') return false;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width > MAX_TEXTURE_DIMENSION || height > MAX_TEXTURE_DIMENSION) return false;
  return width * height * RGBA_BYTES_PER_PIXEL <= MAX_IMAGE_BYTES;
}

/** 给 warn 用的一行描述，避免各处自己拼字符串 */
export function describeImageSize(width: unknown, height: unknown): string {
  return `${String(width)}x${String(height)}`;
}

/**
 * 图集子区域里的单个字段（offsetX / offsetY / width / height）是否健康。
 *
 * 子区域用**夹到 0** 而不是丢弃整条：`subTexInfos` 的数组下标与 `texUnitIndex`
 * 绑定，少一条会让后面的 rect 全部错位，比留一条空矩形更糟。宽高为 0 的
 * 子区域在渲染侧表现为「不采样」，与「这条不存在」等效。
 */
export function isSaneSubValue(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_TEXTURE_DIMENSION;
}
