/**
 * 把泼溅实例按视深重排（back-to-front）
 *
 * three 的 InstancedMesh 按 attribute 顺序画实例，所以「排序」在这里就是
 * 用排序索引把 iCenter / iScale / iQuat / iColor 四条流一起重排 —— 必须
 * 四条同步动，只排中心会把颜色和形状排串。
 *
 * 顺序已经正确时直接返回 false，不换 buffer、不触发上传（静止相机 + 静止
 * 数据时零开销）。scratch 数组按 attribute 缓存，避免每帧分配。
 */
import * as THREE from 'three';
import { splatDepthOrder } from '../core/SplatSort.js';

const SORTED_ATTRS = ['iCenter', 'iScale', 'iQuat', 'iColor'] as const;

const _view = new THREE.Matrix4();
const _scratch = new WeakMap<THREE.BufferAttribute, THREE.TypedArray>();

/** @returns 是否真的重排了（false = 顺序本来就对，没动任何数据） */
export function sortSplatMesh(mesh: THREE.Mesh, viewMatrix: THREE.Matrix4): boolean {
  const geo = mesh.geometry as THREE.InstancedBufferGeometry;
  const center = geo.getAttribute('iCenter') as THREE.InstancedBufferAttribute | undefined;
  if (!center) return false;
  const count = Math.min(geo.instanceCount ?? Infinity, center.count);
  if (count <= 1) return false;

  _view.multiplyMatrices(viewMatrix, mesh.matrixWorld);
  const order = splatDepthOrder(center.array as Float32Array, count, _view);

  let sorted = true;
  for (let i = 0; i < count; i++) {
    if (order[i] !== i) {
      sorted = false;
      break;
    }
  }
  if (sorted) return false;

  for (const name of SORTED_ATTRS) {
    const attr = geo.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
    if (!attr) continue;
    const src = attr.array;
    const itemSize = attr.itemSize;
    const needed = count * itemSize;
    let dst = _scratch.get(attr);
    if (!dst || dst.length < needed) {
      dst = new (src.constructor as new (n: number) => THREE.TypedArray)(needed);
      _scratch.set(attr, dst);
    }
    for (let i = 0; i < count; i++) {
      const from = order[i]! * itemSize;
      const to = i * itemSize;
      for (let k = 0; k < itemSize; k++) dst[to + k] = src[from + k]!;
    }
    src.set(dst.subarray(0, needed));
    attr.needsUpdate = true;
  }
  return true;
}
