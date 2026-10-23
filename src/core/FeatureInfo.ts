/**
 * 单体属性提取
 *
 * S3M 的 `pickInfo` 是「SMID → batchId + 顶点区间」的映射，本身不带业务属性
 * （OSGB 转 S3M 的数据通常没有属性表）。所以这里做两件事：
 *   1. 反查 SMID —— 这是和 iServer 侧数据对齐的唯一标识；
 *   2. 从几何直接算出可信的派生属性（高度、基底高程、外接盒、三角面数、楼层估算）。
 *
 * 派生属性是「算出来的」而不是「查出来的」，所以每一项都标注了计算口径，
 * 避免使用者误以为是业务数据。
 */
import type { BufferGeometry } from 'three';
import type { FeatureAttributes, GeoPackageEntry, PickSegment, SegmentBox } from './types.js';

/** 楼层估算用的默认层高（米） */
export const DEFAULT_FLOOR_HEIGHT = 3.2;

export function resolveFeature(
  geo: GeoPackageEntry | undefined,
  batchId: number
): { smid: number | null; segments: PickSegment[] } {
  const pickInfo = geo?.pickInfo;
  if (!pickInfo || batchId < 0) return { smid: null, segments: [] };

  for (const [id, entry] of Object.entries(pickInfo)) {
    if (entry?.batchId === batchId) {
      return { smid: Number(id), segments: entry.segments ?? [] };
    }
  }
  return { smid: null, segments: [] };
}

/**
 * 统计单体顶点区间包围盒 + 该单体自身的三角面数。
 */
export function measureSegments(geometry: BufferGeometry | undefined, segments: PickSegment[]): SegmentBox | null {
  const pos = geometry?.getAttribute('position');
  if (!pos || !segments.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let count = 0;

  for (const seg of segments) {
    const end = Math.min(seg.vertexOffset + seg.vertexCount, pos.count);
    for (let i = seg.vertexOffset; i < end; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      count++;
    }
  }

  if (!count) return null;

  // 单体三角面数：索引三元组的三个顶点都落在本单体区间内才算，
  // 直接用整个网格的 index.count 会把整片街区都算进去。
  let triangles = 0;
  const index = geometry!.index;
  if (index) {
    const mask = new Uint8Array(pos.count);
    for (const seg of segments) {
      const end = Math.min(seg.vertexOffset + seg.vertexCount, pos.count);
      mask.fill(1, seg.vertexOffset, end);
    }
    const arr = index.array as ArrayLike<number>;
    for (let i = 0; i < arr.length; i += 3) {
      if (mask[arr[i]] && mask[arr[i + 1]] && mask[arr[i + 2]]) triangles++;
    }
  }

  return { minX, minY, minZ, maxX, maxY, maxZ, count, triangles };
}

/** 组装给 UI 展示的属性对象 */
export function buildAttributes(args: {
  smid: number | null;
  box: SegmentBox | null;
  triangles: number;
  floorHeight?: number;
}): FeatureAttributes {
  const { smid, box, triangles, floorHeight = DEFAULT_FLOOR_HEIGHT } = args;
  if (!box) return { smid, triangles };

  const height = box.maxZ - box.minZ;
  return {
    smid,
    height: round(height, 1),
    baseElevation: round(box.minZ, 1),
    size: [round(box.maxX - box.minX, 1), round(box.maxY - box.minY, 1)],
    bboxArea: round((box.maxX - box.minX) * (box.maxY - box.minY), 1),
    floors: Math.max(1, Math.round(height / floorHeight)),
    triangles: box.triangles ?? triangles,
    vertices: box.count,
    bbox: [
      [round(box.minX, 1), round(box.minY, 1), round(box.minZ, 1)],
      [round(box.maxX, 1), round(box.maxY, 1), round(box.maxZ, 1)],
    ],
  };
}

function round(v: number, d: number): number {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}
