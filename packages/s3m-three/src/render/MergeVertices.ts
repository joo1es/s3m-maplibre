/**
 * 轻量版顶点焊合（只按位置）
 *
 * 为什么不用 three/examples/jsm/utils/BufferGeometryUtils.js 的 mergeVertices：
 * 1. jsm 子路径导入会在宿主打包器里给 three 制造第二个依赖入口，
 *    典型症状就是控制台「WARNING: Multiple instances of Three.js being imported.」
 *    ——同一页面出现两份 three，instanceof 全部失灵。库端唯一治本的办法是
 *    不引入 jsm 子路径，把 import 面收敛到 `three` 一个入口。
 * 2. 对「提棱线」这个用途，位置焊合反而是更对的行为：完整版 mergeVertices
 *    要求所有属性都在容差内匹配，而 S3M 几何常是「每面独立顶点 + 各自 UV」，
 *    重合顶点会因 UV 不同而焊不上，EdgesGeometry 照样把每条三角形边当边界。
 *
 * 输出只保留 position（EdgesGeometry 只消费位置），并把原索引重映射到焊后顶点。
 */
import * as THREE from 'three';

/**
 * 位置量化 key：坐标落到 tolerance 网格上取整。
 *
 * 单独导出是因为棱线的「位置 → batchId」回填（见 EdgeLines.buildPositionBatchMap）
 * 必须用同一套网格，否则焊过的顶点对不上号。
 */
export function positionQuantKey(x: number, y: number, z: number, inv: number): string {
  return `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
}

export function mergeVerticesByPosition(
  geometry: THREE.BufferGeometry,
  tolerance: number
): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count === 0) return geometry;

  const inv = 1 / Math.max(tolerance, 1e-9);
  /** 网格哈希：坐标量化到 tolerance 网格，同格即视为重合 */
  const map = new Map<string, number>();
  const out: number[] = [];
  const remap = new Int32Array(pos.count);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = positionQuantKey(x, y, z, inv);
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      out.push(x, y, z);
      map.set(key, id);
    }
    remap[i] = id;
  }

  // 原几何可能带索引：按原三角形拓扑重映射，不能按顶点顺序重造三角形
  const srcIndex = geometry.getIndex();
  const triCount = srcIndex ? srcIndex.count : pos.count;
  const outIndex = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) {
    outIndex[i] = remap[srcIndex ? srcIndex.getX(i) : i]!;
  }

  const welded = new THREE.BufferGeometry();
  welded.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  welded.setIndex(new THREE.BufferAttribute(outIndex, 1));
  return welded;
}
