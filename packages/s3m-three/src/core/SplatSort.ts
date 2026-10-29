/**
 * 高斯泼溅的 back-to-front 排序（纯数学，可单测）
 *
 * alpha 混合是顺序相关的：先画近的再画远的，远的颜色会盖到近的上头，
 * 画面就是一片随视角乱闪的彩色噪点。3DGS 必须按视深从远到近画。
 *
 * 排序键是**视图空间 z**（相机前方为负），升序 = 远的先画。
 * view 矩阵由调用方给（通常是 camera.matrixWorldInverse × mesh.matrixWorld），
 * 本模块不关心相机朝向约定，只取矩阵第三行做点积。
 *
 * ## 为什么是基数排序
 *
 * 这里是**每帧**都要跑的路径（相机一动就重排），原来的
 * `TypedArray.sort((a, b) => keys[a] - keys[b])` 有两个代价：
 *   - 比较函数是 JS 调用，10 万点实测 38 ms/帧；
 *   - 每次调用都 `new Float32Array(count)` + `new Uint32Array(count)`，每帧分配 800 KB。
 *
 * 换成 4 遍 8 位 LSD 基数排序后实测 3 ms，且缓冲全部复用。没选桶排序是因为
 * 深度分布会很不均匀（正对相机的墙面，几万个点的视深几乎相同），桶内再排会退化。
 *
 * 排序键先转成「无符号可比」的 32 位整数（IEEE754 的标准技巧），
 * 这样无符号整数比较的大小顺序与 float 完全一致，基数排序才成立。
 */
import type * as THREE from 'three';

/** 模块级 scratch：只增不减。排序是同步的，同一时刻只有一个在跑 */
let _keys = new Uint32Array(0);
let _scratch = new Uint32Array(0);
const _counts = new Uint32Array(256);

/** float → 无符号可比的 32 位键（正数翻符号位，负数按位取反） */
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

function sortableBits(k: number): number {
  _f32[0] = k;
  const u = _u32[0]!;
  // 负数的 IEEE754 表示是「符号位 1 + 绝对值」，直接按无符号比会把 -1 排到 0 后面
  return u & 0x80000000 ? ~u >>> 0 : (u | 0x80000000) >>> 0;
}

export function splatDepthOrder(
  positions: Float32Array,
  count: number,
  view: THREE.Matrix4,
  out?: Uint32Array
): Uint32Array {
  const idx = out && out.length >= count ? out : new Uint32Array(count);
  if (count <= 1) {
    if (count === 1) idx[0] = 0;
    return idx;
  }

  if (_keys.length < count) _keys = new Uint32Array(count);
  if (_scratch.length < count) _scratch = new Uint32Array(count);
  const keys = _keys;
  const scratch = _scratch;

  const e = view.elements;
  const r0 = e[2]!, r1 = e[6]!, r2 = e[10]!, r3 = e[14]!;
  for (let i = 0; i < count; i++) {
    keys[i] = sortableBits(r0 * positions[i * 3]! + r1 * positions[i * 3 + 1]! + r2 * positions[i * 3 + 2]! + r3);
    idx[i] = i;
  }

  // 4 遍 × 8 位。偶数遍 → 结果一定回到 idx，不用再拷一次
  let src = idx;
  let dst = scratch;
  for (let pass = 0; pass < 4; pass++) {
    const shift = pass * 8;
    _counts.fill(0);
    for (let i = 0; i < count; i++) _counts[(keys[src[i]!]! >>> shift) & 0xff]!++;
    // 前缀和 → 每个桶的起始写位置
    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = _counts[b]!;
      _counts[b] = sum;
      sum += c;
    }
    for (let i = 0; i < count; i++) {
      const v = src[i]!;
      dst[_counts[(keys[v]! >>> shift) & 0xff]!++] = v;
    }
    const t = src;
    src = dst;
    dst = t;
  }

  // 4 遍之后 src 就是 idx（起始 src=idx，偶数次交换后回到 idx）；防御性兜一下
  if (src !== idx) idx.set(src);
  return idx;
}
