/**
 * S3M 解析结果 → 纯数据几何组装（three 无关，主线程 / Worker 共用）
 *
 * 从 GeometryBuilder 拆出来的 CPU 密集段：顶点流解交错、法线计算、
 * 同材质合批合并（含 geode 矩阵变换）。产出是「PrimitiveData 列表」——
 * 每个 primitive 就是一份能直接包成 BufferGeometry 的 attribute 字典 + 索引，
 * three 对象（Mesh / 材质 / InstancedMesh）仍由渲染层的 GeometryBuilder 包装。
 *
 * 语义必须与原实现逐位一致（下游拾取 / 单体化 / 图集都依赖）：
 *   - attribute 省缺补默认：aColor 补白、aBatchId 补 -1、无 index 走 drawRange；
 *   - 点云骨架（无索引包）补一个 primitiveType=1 的伪包；
 *   - 合批只在 primitiveType=4 且 batching 开启时做，棱线包与实例化网格单独摆放；
 *   - 合并时矩阵变换用列主序 mat4（S3M 与 three elements 布局一致），
 *     法线用上 3x3 的逆转置并归一化。
 */
import type {
  AttrDType,
  GeoPackageEntry,
  IndexPackage,
  ParsedTile,
  VertexAttribute,
} from './types.js';

/**
 * S3M 规范里 `DrawPrimitiveType` 的两个特殊值（原住 GeometryBuilder，随组装层
 * 下沉到 core —— 渲染层从这里 re-export，对外 API 不变）：
 *   13 = 数据自带的「棱线包」—— 索引是线段对，不是三角形（把 13 当三角形画，
 *        每条棱线都会被连成一根几十上百米的尖刺）；
 *   1  = 点云包。索引是点序号，画成三角面就是满屏彩色尖刺。
 */
export const LINE_PRIMITIVE = 13;
export const POINT_PRIMITIVE = 1;

/* ------------------------------------------------------------------ 顶点流工具 */

function bytesPerElement(dtype: AttrDType): number {
  return dtype === 'u8' ? 1 : dtype === 'u16' ? 2 : 4;
}

/** 解交错后的属性流：数组 + 分量数 + 是否归一化（对应 THREE.BufferAttribute 三参） */
export interface PlainAttribute {
  array: Float32Array | Uint8Array | Uint16Array | Uint32Array;
  components: number;
  normalized: boolean;
}

function typedArray(dtype: AttrDType, buffer: ArrayBufferLike): Float32Array | Uint8Array | Uint16Array | Uint32Array {
  switch (dtype) {
    case 'u8':
      return new Uint8Array(buffer);
    case 'u16':
      return new Uint16Array(buffer);
    case 'u32':
      return new Uint32Array(buffer);
    default:
      return new Float32Array(buffer);
  }
}

function typedArrayOf(dtype: AttrDType, length: number): Float32Array | Uint8Array | Uint16Array | Uint32Array {
  switch (dtype) {
    case 'u8':
      return new Uint8Array(length);
    case 'u16':
      return new Uint16Array(length);
    case 'u32':
      return new Uint32Array(length);
    default:
      return new Float32Array(length);
  }
}

/** 非交错整段铺开 / 交错逐元素抽取（原 toBufferAttribute 的数据部分） */
export function deinterleave(attr: VertexAttribute): PlainAttribute {
  const { data, stride, offsetInBytes, dtype = 'f32' } = attr;
  const components = attr.components ?? (attr as unknown as { comp?: number }).comp ?? 3;
  const bpe = bytesPerElement(dtype);
  const itemBytes = components * bpe;
  const actualStride = stride ?? itemBytes;
  const actualOffset = offsetInBytes ?? 0;
  const normalized = dtype === 'u8';

  if (actualStride === itemBytes && actualOffset === 0) {
    const view = typedArray(dtype, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return { array: view, components, normalized };
  }

  const count = Math.floor(data.byteLength / actualStride);
  const out = typedArrayOf(dtype, count * components);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < count; i++) {
    const base = i * actualStride + actualOffset;
    for (let c = 0; c < components; c++) {
      const o = base + c * bpe;
      out[i * components + c] =
        dtype === 'u8'
          ? dv.getUint8(o)
          : dtype === 'u16'
            ? dv.getUint16(o, true)
            : dtype === 'u32'
              ? dv.getUint32(o, true)
              : dv.getFloat32(o, true);
    }
  }
  return { array: out, components, normalized };
}

/** 把 u8 顶点色转成 float vec3，供着色器直接相乘（原 toColorAttribute） */
function colorData(attr: VertexAttribute | null, vertexCount: number): Float32Array {
  const out = new Float32Array(vertexCount * 3);
  if (!attr) {
    out.fill(1);
    return out;
  }
  const src = attr.data;
  const comp = attr.components ?? 4;
  const scale = attr.dtype === 'u8' ? 1 / 255 : 1;
  for (let i = 0; i < vertexCount; i++) {
    const o = i * comp;
    out[i * 3] = (src[o] ?? 255) * scale;
    out[i * 3 + 1] = (src[o + 1] ?? 255) * scale;
    out[i * 3 + 2] = (src[o + 2] ?? 255) * scale;
  }
  return out;
}

/** 解出索引（原 toIndex 的数据部分），返回 null = 无索引走 drawRange */
function indexData(pack: IndexPackage): Uint16Array | Uint32Array | null {
  const { indices, indexType, indexCount } = pack;
  if (!indices || indexCount === 0) return null;
  // 以字节宽度为准：S3M 的 indexType 在 MeshOpt 包里恒为 0，靠它会读错一半索引。
  const width = Math.floor(indices.byteLength / indexCount);
  const wide = width === 4 || (width !== 2 && (indexType === 1 || indexType === 3));
  const n = indexCount * (wide ? 4 : 2);
  if (n > indices.byteLength) return null;
  const buf = indices.buffer.slice(indices.byteOffset, indices.byteOffset + n);
  return wide ? new Uint32Array(buf) : new Uint16Array(buf);
}

/**
 * 顶点法线计算（等价 BufferGeometry.computeVertexNormals：索引几何按面累积、
 * 非索引逐面复制，最后归一化）。仅三角面在数据没带 normal 时调用。
 */
function computeVertexNormals(
  position: ArrayLike<number>,
  index: Uint16Array | Uint32Array | null,
  vertexCount: number
): Float32Array {
  const normals = new Float32Array(vertexCount * 3);
  const addFace = (a: number, b: number, c: number): void => {
    const ax = position[a * 3], ay = position[a * 3 + 1], az = position[a * 3 + 2];
    const bx = position[b * 3], by = position[b * 3 + 1], bz = position[b * 3 + 2];
    const cx = position[c * 3], cy = position[c * 3 + 1], cz = position[c * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      normals[v * 3] += nx;
      normals[v * 3 + 1] += ny;
      normals[v * 3 + 2] += nz;
    }
  };
  if (index) {
    for (let i = 0; i + 2 < index.length; i += 3) {
      addFace(index[i], index[i + 1], index[i + 2]);
    }
  } else {
    for (let i = 0; i + 2 < vertexCount; i += 3) {
      addFace(i, i + 1, i + 2);
    }
  }
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3;
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
    if (len > 0) {
      normals[o] /= len;
      normals[o + 1] /= len;
      normals[o + 2] /= len;
    }
  }
  return normals;
}

/* ------------------------------------------------------------------ 包围盒 / 包围球 */

export interface BoundsData {
  boxMin: [number, number, number];
  boxMax: [number, number, number];
  sphereCenter: [number, number, number];
  sphereRadius: number;
}

/** 等价 BufferGeometry.computeBoundingBox / computeBoundingSphere 的数学部分 */
export function computeBounds(position: ArrayLike<number>, vertexCount: number): BoundsData {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    for (let c = 0; c < 3; c++) {
      const v = position[i * 3 + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  let radius = 0;
  for (let i = 0; i < vertexCount; i++) {
    const dx = position[i * 3] - center[0];
    const dy = position[i * 3 + 1] - center[1];
    const dz = position[i * 3 + 2] - center[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > radius) radius = d;
  }
  return { boxMin: min as [number, number, number], boxMax: max as [number, number, number], sphereCenter: center, sphereRadius: Math.sqrt(radius) };
}

/* ------------------------------------------------------------------ 组装产物 */

/** 一个 primitive 的属性字典：键即 geometry attribute 名，数组/分量/归一化齐备 */
export interface PrimitiveAttributes {
  position: PlainAttribute;
  normal?: PlainAttribute;
  uv?: PlainAttribute;
  uv1?: PlainAttribute;
  aColor: PlainAttribute;
  aBatchId: PlainAttribute;
  aAtlasRect?: PlainAttribute;
  aAtlasRect1?: PlainAttribute;
  aSecUv?: PlainAttribute;
}

export interface PrimitiveData {
  /** 首个候选骨架名（userData.skeletonName） */
  skeletonName: string;
  /** 参与合并的 geoPackage 键（主线程重建 geoRef / geoByBatchId） */
  geoNames: string[];
  primitiveType: number;
  passNames: string[];
  /** geode 矩阵（列主序 16 个数）或 null */
  matrix: number[] | null;
  vertexCount: number;
  indexCount: number;
  attributes: PrimitiveAttributes;
  index: Uint16Array | Uint32Array | null;
  bounds: BoundsData;
  /** 合批前候选数（>1 表示是合并产物） */
  batchedFrom?: number;
}

export interface TileGeometryStats {
  vertices: number;
  instanced: number;
  edgeLines: number;
  /** 合批前独立网格数（batching 生效时 > meshes） */
  originalMeshes?: number;
  skipped: string[];
}

export interface TileGeometryData {
  primitives: PrimitiveData[];
  stats: TileGeometryStats;
}

export interface AssembleOptions {
  /** 是否对 primitiveType=4 的三角面做瓦片内同材质合批（默认 true） */
  batching?: boolean;
}

/* ------------------------------------------------------------------ 合批合并 */

interface Candidate {
  attrs: PrimitiveAttributes;
  index: Uint16Array | Uint32Array | null;
  vertexCount: number;
  indexCount: number;
  name: string;
  geo: GeoPackageEntry;
  matrix: number[] | null;
  passNames: string[];
  primitiveType: number;
}

const LINE_PRIMITIVES = [LINE_PRIMITIVE, 2, 3];
const POINT_PRIMITIVE_TYPE = POINT_PRIMITIVE;

function isLinePrimitive(primitiveType: number): boolean {
  return LINE_PRIMITIVES.includes(primitiveType);
}

/** 列主序 mat4 是否为单位阵（等价 THREE.Matrix4.equals(IDENTITY)） */
function isIdentity(m: number[] | null): boolean {
  if (!m) return true;
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 &&
    m[4] === 0 && m[5] === 1 && m[6] === 0 && m[7] === 0 &&
    m[8] === 0 && m[9] === 0 && m[10] === 1 && m[11] === 0 &&
    m[12] === 0 && m[13] === 0 && m[14] === 0 && m[15] === 1
  );
}

/** 列主序 mat4 变换点（仿射，忽略投影行——与 applyMatrix4 对点一致） */
function xformPoint(m: number[], x: number, y: number, z: number, out: number[]): void {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

/**
 * 上 3x3 的逆转置（normal matrix），列主序展开。
 * 等价 THREE.Matrix3.getNormalMatrix，纯标量实现，不依赖 three。
 */
function normalMatrixOf(m: number[]): Float32Array {
  // 上 3x3（列主序）：a=m0 b=m4 c=m8 / d=m1 e=m5 f=m9 / g=m2 h=m6 i=m10
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C || 1e-12;
  // 逆转置 = inv 上 3x3 的转置；inv 的元素 = cofactor / det（行主序），转置后回列主序
  const inv = [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
  // 转置回列主序布局：n[0..2] 是第一列
  const n = new Float32Array(9);
  n[0] = inv[0]; n[1] = inv[3]; n[2] = inv[6];
  n[3] = inv[1]; n[4] = inv[4]; n[5] = inv[7];
  n[6] = inv[2]; n[7] = inv[5]; n[8] = inv[8];
  return n;
}

/** 逆转置 3x3 变换法线并归一化 */
function xformNormal(n: Float32Array, x: number, y: number, z: number, out: number[]): void {
  out[0] = n[0] * x + n[3] * y + n[6] * z;
  out[1] = n[1] * x + n[4] * y + n[7] * z;
  out[2] = n[2] * x + n[5] * y + n[8] * z;
  const len = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= len;
  out[1] /= len;
  out[2] /= len;
}

/**
 * 合并同材质候选（等价 GeometryBuilder.mergeBatchGeometries 的数据部分）。
 * 矩阵变换烘进顶点；合出的 primitive 自身 matrix 为 null。
 */
function mergeCandidates(candidates: Candidate[]): PrimitiveData {
  let totalVertices = 0;
  let totalIndices = 0;
  let hasNormal = false;
  let hasUv = false;
  let hasUv1 = false;
  let hasAtlas = false;

  for (const c of candidates) {
    totalVertices += c.vertexCount;
    totalIndices += c.index ? c.indexCount : c.vertexCount;
    if (c.attrs.normal) hasNormal = true;
    if (c.attrs.uv) hasUv = true;
    if (c.attrs.uv1) hasUv1 = true;
    if (c.attrs.aAtlasRect) hasAtlas = true;
  }

  const mergedPos: PlainAttribute = { array: new Float32Array(totalVertices * 3), components: 3, normalized: false };
  const mergedNorm = hasNormal ? { array: new Float32Array(totalVertices * 3), components: 3, normalized: false } : null;
  const mergedUv = hasUv ? { array: new Float32Array(totalVertices * 2), components: 2, normalized: false } : null;
  const mergedUv1 = hasUv1 ? { array: new Float32Array(totalVertices * 2), components: 2, normalized: false } : null;
  const mergedColor: PlainAttribute = { array: new Float32Array(totalVertices * 3), components: 3, normalized: false };
  const mergedBatchId: PlainAttribute = { array: new Float32Array(totalVertices), components: 1, normalized: false };
  const mergedRect0 = hasAtlas ? { array: new Float32Array(totalVertices * 4), components: 4, normalized: false } : null;
  const mergedRect1 = hasAtlas ? { array: new Float32Array(totalVertices * 4), components: 4, normalized: false } : null;
  const mergedSecUv = hasAtlas ? { array: new Float32Array(totalVertices * 2), components: 2, normalized: false } : null;
  const mergedIndices = (totalVertices > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices)) as Uint16Array | Uint32Array;

  const tmp = [0, 0, 0];
  let vertexOffset = 0;
  let indexOffset = 0;

  for (const c of candidates) {
    const { attrs } = c;
    const vCount = c.vertexCount;
    const m = isIdentity(c.matrix) ? null : c.matrix;
    const nrm = m && mergedNorm ? normalMatrixOf(m) : null;
    const posArr = attrs.position.array;
    const normArr = attrs.normal?.array;
    const uvArr = attrs.uv?.array;
    const uv1Arr = attrs.uv1?.array;
    const colArr = attrs.aColor.array;
    const bArr = attrs.aBatchId.array;
    const posOut = mergedPos.array as Float32Array;
    const normOut = mergedNorm?.array as Float32Array | undefined;
    const uvOut = mergedUv?.array as Float32Array | undefined;
    const uv1Out = mergedUv1?.array as Float32Array | undefined;
    const colOut = mergedColor.array as Float32Array;
    const bOut = mergedBatchId.array as Float32Array;

    for (let i = 0; i < vCount; i++) {
      const dst = vertexOffset + i;
      // position
      if (m) {
        xformPoint(m, posArr[i * 3], posArr[i * 3 + 1], posArr[i * 3 + 2], tmp);
        posOut[dst * 3] = tmp[0];
        posOut[dst * 3 + 1] = tmp[1];
        posOut[dst * 3 + 2] = tmp[2];
      } else {
        posOut[dst * 3] = posArr[i * 3];
        posOut[dst * 3 + 1] = posArr[i * 3 + 1];
        posOut[dst * 3 + 2] = posArr[i * 3 + 2];
      }
      // normal
      if (normOut) {
        if (normArr && nrm) {
          xformNormal(nrm, normArr[i * 3], normArr[i * 3 + 1], normArr[i * 3 + 2], tmp);
          normOut[dst * 3] = tmp[0];
          normOut[dst * 3 + 1] = tmp[1];
          normOut[dst * 3 + 2] = tmp[2];
        } else if (normArr) {
          normOut[dst * 3] = normArr[i * 3];
          normOut[dst * 3 + 1] = normArr[i * 3 + 1];
          normOut[dst * 3 + 2] = normArr[i * 3 + 2];
        }
      }
      // uv / uv1
      if (uvOut && uvArr) {
        uvOut[dst * 2] = uvArr[i * 2];
        uvOut[dst * 2 + 1] = uvArr[i * 2 + 1];
      }
      if (uv1Out && uv1Arr) {
        uv1Out[dst * 2] = uv1Arr[i * 2];
        uv1Out[dst * 2 + 1] = uv1Arr[i * 2 + 1];
      }
      // aColor
      if (colArr) {
        colOut[dst * 3] = colArr[i * 3];
        colOut[dst * 3 + 1] = colArr[i * 3 + 1];
        colOut[dst * 3 + 2] = colArr[i * 3 + 2];
      } else {
        colOut[dst * 3] = 1;
        colOut[dst * 3 + 1] = 1;
        colOut[dst * 3 + 2] = 1;
      }
      // aBatchId
      bOut[dst] = bArr ? bArr[i] : -1;
    }

    // 图集矩形（缺失补 0，等价原 copyAttr 的 fallback）
    if (mergedRect0) {
      const r0 = attrs.aAtlasRect?.array;
      const r1 = attrs.aAtlasRect1?.array;
      const su = attrs.aSecUv?.array;
      const r0Out = mergedRect0.array as Float32Array;
      const r1Out = mergedRect1!.array as Float32Array;
      const suOut = mergedSecUv!.array as Float32Array;
      for (let i = 0; i < vCount; i++) {
        const dst = (vertexOffset + i) * 4;
        for (let k = 0; k < 4; k++) {
          r0Out[dst + k] = r0 ? r0[i * 4 + k] ?? 0 : 0;
          r1Out[dst + k] = r1 ? r1[i * 4 + k] ?? 0 : 0;
        }
        suOut[(vertexOffset + i) * 2] = su ? su[i * 2] ?? 0 : 0;
        suOut[(vertexOffset + i) * 2 + 1] = su ? su[i * 2 + 1] ?? 0 : 0;
      }
    }

    // index（偏移累加；无索引按序号）
    if (c.index) {
      for (let k = 0; k < c.indexCount; k++) {
        mergedIndices[indexOffset + k] = c.index[k] + vertexOffset;
      }
      indexOffset += c.indexCount;
    } else {
      for (let k = 0; k < vCount; k++) {
        mergedIndices[indexOffset + k] = k + vertexOffset;
      }
      indexOffset += vCount;
    }

    vertexOffset += vCount;
  }

  const bounds = computeBounds(mergedPos.array, totalVertices);
  return {
    skeletonName: candidates[0].name,
    geoNames: candidates.map((c) => c.name),
    primitiveType: 4,
    passNames: candidates[0].passNames,
    matrix: null,
    vertexCount: totalVertices,
    indexCount: totalIndices,
    attributes: {
      position: mergedPos,
      normal: mergedNorm ?? undefined,
      uv: mergedUv ?? undefined,
      uv1: mergedUv1 ?? undefined,
      aColor: mergedColor,
      aBatchId: mergedBatchId,
      aAtlasRect: mergedRect0 ?? undefined,
      aAtlasRect1: mergedRect1 ?? undefined,
      aSecUv: mergedSecUv ?? undefined,
    },
    index: mergedIndices,
    bounds,
    batchedFrom: candidates.length,
  };
}

/* ------------------------------------------------------------------ 入口 */

/** 单个骨架解交错后的属性与索引包（按 pack 分） */
interface SkeletonAsm {
  attrs: PrimitiveAttributes;
  packs: IndexPackage[];
  instanced: boolean;
}

/** 每骨架只解一次交错流（同一骨架被多个 pack / geode 引用时共享同一份数据） */
function assembleSkeleton(name: string, geo: GeoPackageEntry, tile: ParsedTile, skipped: string[]): SkeletonAsm | null {
  const vp = geo.vertexPackage;
  const positionAttr = vp.vertexAttributes.find((a) => a.semantic === 'position');
  if (!positionAttr) {
    skipped.push(`${name} 无 position`);
    return null;
  }

  const vertexCount = vp.verticesCount || 0;
  const attrs: PrimitiveAttributes = {
    position: deinterleave(positionAttr),
    aColor: { array: new Float32Array(0), components: 3, normalized: false },
    aBatchId: { array: new Float32Array(0), components: 1, normalized: false },
  };
  let colorAttr: VertexAttribute | null = null;
  let batchAttr: VertexAttribute | null = null;
  let normalData: PlainAttribute | null = null;
  let uvData: PlainAttribute | null = null;
  let uv1Data: PlainAttribute | null = null;

  for (const attr of vp.vertexAttributes) {
    if (attr.divisor !== undefined) continue; // 实例属性不进顶点流
    if (attr.semantic === 'position') continue;
    if (attr.semantic === 'color') colorAttr = attr;
    else if (attr.semantic === 'batchId') batchAttr = attr;
    else if (attr.semantic === 'normal') normalData = deinterleave(attr);
    else if (attr.semantic === 'uv') uvData = deinterleave(attr);
    else if (attr.semantic === 'uv2') uv1Data = deinterleave(attr);
  }

  attrs.aColor = { array: colorData(colorAttr, vertexCount), components: 3, normalized: false };
  attrs.aBatchId = batchAttr
    ? { array: deinterleave(batchAttr).array, components: 1, normalized: false }
    : { array: new Float32Array(vertexCount).fill(-1), components: 1, normalized: false };
  if (normalData) attrs.normal = normalData;
  if (uvData) attrs.uv = uvData;
  if (uv1Data) attrs.uv1 = uv1Data;

  // S3MBLOCK 图集：逐顶点带子区域矩形；烘焙图用第二套 UV（aSecUv）
  const rects = tile.atlasRects?.[name];
  if (rects) {
    attrs.aAtlasRect = { array: rects.uv ?? new Float32Array(vertexCount * 4), components: 4, normalized: false };
    if (rects.uv2 && uv1Data) {
      attrs.aAtlasRect1 = { array: rects.uv2, components: 4, normalized: false };
      attrs.aSecUv = { array: uv1Data.array, components: uv1Data.components, normalized: uv1Data.normalized };
    } else {
      attrs.aAtlasRect1 = { array: new Float32Array(vertexCount * 4), components: 4, normalized: false };
      attrs.aSecUv = attrs.uv ?? { array: new Float32Array(vertexCount * 2), components: 2, normalized: false };
    }
  }

  // 一个索引包都没有的骨架 = 纯点集（高斯泼溅 / 无索引点云）：补「顶点即点」伪包
  let packs = geo.indexPackages ?? [];
  if (packs.length === 0 && vertexCount > 0) {
    packs = [
      {
        indexCount: 0,
        indexType: 0,
        useIndex: 0,
        primitiveType: POINT_PRIMITIVE_TYPE,
        indices: null,
        passNames: [],
      },
    ];
  }

  return {
    attrs,
    packs,
    instanced: vp.instanceIndex !== -1 && (vp.instanceMode === 16 || vp.instanceMode === 17),
  };
}

function primitiveOf(
  skeletonName: string,
  geoName: string,
  geo: GeoPackageEntry,
  asm: SkeletonAsm,
  pack: IndexPackage,
  matrix: number[] | null
): PrimitiveData {
  const vertexCount = geo.vertexPackage.verticesCount || 0;
  const index = indexData(pack);
  const attrs: PrimitiveAttributes = { ...asm.attrs };
  // 数据没带法线的三角网格：必须按索引后的连续顶点算，否则法线朝向错乱甚至 NaN 死黑面
  if (!isLinePrimitive(pack.primitiveType) && pack.primitiveType !== POINT_PRIMITIVE_TYPE && !attrs.normal) {
    attrs.normal = {
      array: computeVertexNormals(attrs.position.array, index, vertexCount),
      components: 3,
      normalized: false,
    };
  }
  return {
    skeletonName,
    geoNames: [geoName],
    primitiveType: pack.primitiveType,
    passNames: pack.passNames ?? [],
    matrix,
    vertexCount,
    indexCount: pack.indexCount || 0,
    attributes: attrs,
    index,
    bounds: computeBounds(attrs.position.array, vertexCount),
  };
}

/**
 * 瓦片几何组装入口。与 GeometryBuilder 的摆放/分组逻辑逐位对齐，
 * 但只产出纯数据 —— three 包装在渲染层。
 */
export function assembleTileGeometry(tile: ParsedTile, options: AssembleOptions = {}): TileGeometryData {
  const batching = options.batching !== false;
  const skipped: string[] = [];
  const stats: TileGeometryStats = { vertices: 0, instanced: 0, edgeLines: 0, skipped };

  const skeletons = new Map<string, SkeletonAsm>();
  for (const [name, geo] of Object.entries(tile.geoPackage ?? {})) {
    const asm = assembleSkeleton(name, geo, tile, skipped);
    if (asm) {
      skeletons.set(name, asm);
      stats.vertices += geo.vertexPackage.verticesCount || 0;
    }
  }

  const primitives: PrimitiveData[] = [];
  const batchGroups = new Map<string, Candidate[]>();
  let placed = 0;

  const emit = (p: PrimitiveData): void => {
    if (isLinePrimitive(p.primitiveType)) stats.edgeLines++;
    primitives.push(p);
  };
  const group = (candidate: Candidate): void => {
    const matKey = candidate.passNames[0] ?? '__default__';
    let list = batchGroups.get(matKey);
    if (!list) {
      list = [];
      batchGroups.set(matKey, list);
    }
    list.push(candidate);
  };

  const placeOrGroup = (
    name: string,
    geo: GeoPackageEntry,
    asm: SkeletonAsm,
    pi: number,
    matrix: number[] | null
  ): void => {
    const pack = asm.packs[pi];
    const isInstanced = asm.instanced && !!geo.vertexPackage.instanceBuffer && (geo.vertexPackage.instanceCount ?? 0) > 0;
    if (isLinePrimitive(pack.primitiveType) || isInstanced) {
      if (isInstanced) stats.instanced++;
      emit(primitiveOf(name, name, geo, asm, pack, matrix));
      placed++;
      return;
    }
    if (batching && pack.primitiveType === 4) {
      group({
        attrs: asm.attrs,
        index: indexData(pack),
        vertexCount: geo.vertexPackage.verticesCount || 0,
        indexCount: pack.indexCount || 0,
        name,
        geo,
        matrix,
        passNames: pack.passNames ?? [],
        primitiveType: pack.primitiveType,
      });
      placed++;
      return;
    }
    emit(primitiveOf(name, name, geo, asm, pack, matrix));
    placed++;
  };

  // 按 Geode 摆放：一个骨架可能被多个 geode 以不同矩阵引用
  for (const pageLod of tile.groupNode?.pageLods ?? []) {
    for (const geode of pageLod.geodes ?? []) {
      const matrix = geode.matrix && geode.matrix.length === 16 ? geode.matrix : null;
      for (const name of geode.skeletonNames ?? []) {
        const asm = skeletons.get(name);
        if (!asm) continue;
        const geo = tile.geoPackage[name];
        if (!geo) continue;
        for (let pi = 0; pi < asm.packs.length; pi++) {
          placeOrGroup(name, geo, asm, pi, matrix);
        }
      }
    }
  }

  // 兜底：没有被任何 geode 引用的骨架，按单位矩阵渲染，避免整块消失
  if (placed === 0) {
    for (const [name, asm] of skeletons) {
      const geo = tile.geoPackage[name];
      if (!geo) continue;
      for (let pi = 0; pi < asm.packs.length; pi++) {
        placeOrGroup(name, geo, asm, pi, null);
      }
    }
  }

  // 执行同材质几何合批
  if (batchGroups.size > 0) {
    for (const [, list] of batchGroups) {
      stats.originalMeshes = (stats.originalMeshes ?? 0) + list.length;
      if (list.length === 1) {
        const c = list[0];
        emit(primitiveOf(c.name, c.name, c.geo, { attrs: c.attrs, packs: [], instanced: false }, {
          indexCount: c.indexCount,
          indexType: 0,
          useIndex: 1,
          primitiveType: c.primitiveType,
          indices: c.index ? new Uint8Array(c.index.buffer, c.index.byteOffset, c.index.byteLength) : null,
          passNames: c.passNames,
        }, c.matrix));
      } else {
        emit(mergeCandidates(list));
      }
    }
  }

  return { primitives, stats };
}
