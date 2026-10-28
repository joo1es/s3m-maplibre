/**
 * 高斯泼溅的 back-to-front 排序键（纯数学，可单测）
 *
 * alpha 混合是顺序相关的：先画近的再画远的，远的颜色会盖到近的上头，
 * 画面就是一片随视角乱闪的彩色噪点。3DGS 必须按视深从远到近画。
 *
 * 排序键是**视图空间 z**（相机前方为负），升序 = 远的先画。
 * view 矩阵由调用方给（通常是 camera.matrixWorldInverse × mesh.matrixWorld），
 * 本模块不关心相机朝向约定，只取矩阵第三行做点积。
 */
import type * as THREE from 'three';

export function splatDepthOrder(
  positions: Float32Array,
  count: number,
  view: THREE.Matrix4,
  out?: Uint32Array
): Uint32Array {
  const idx = out && out.length >= count ? out : new Uint32Array(count);
  const keys = new Float32Array(count);
  const e = view.elements;
  const r0 = e[2]!, r1 = e[6]!, r2 = e[10]!, r3 = e[14]!;
  for (let i = 0; i < count; i++) {
    idx[i] = i;
    keys[i] = r0 * positions[i * 3]! + r1 * positions[i * 3 + 1]! + r2 * positions[i * 3 + 2]! + r3;
  }
  // TypedArray.sort 带比较函数时是数值排序，且 V8/JSC 对相同键稳定
  idx.sort((a, b) => keys[a]! - keys[b]!);
  return idx;
}
