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
import { applyCustomAttributeSemantics } from './CustomAttributes.js';

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
/**
 * 顶点色解成 RGBA。
 *
 * **必须带 alpha**：BIM 数据里"材质不透明、靠顶点色 alpha 表达半透明"是常见做法。
 * 实测 `3D-BIMbuilding-2` 的 SMID 4421（`WhiteMaterial_1`，无纹理、`diffuse.a=1`）
 * 顶点色是 u8 `(0,128,192,63)`，alpha = 0.247 —— 之前只取 RGB，这一片就变成实心青色。
 * 官方片元里 `baseColorWithAlpha = vColor` 是 vec4，走的就是这条路。
 */
function colorData(attr: VertexAttribute | null, vertexCount: number): Float32Array {
  const out = new Float32Array(vertexCount * 4);
  if (!attr) {
    out.fill(1);
    return out;
  }
  const src = attr.data;
  const comp = attr.components ?? 4;
  const scale = attr.dtype === 'u8' ? 1 / 255 : 1;
  // 只有 RGB 的旧数据补 alpha = 1，避免留下 0（那会整片全透明）
  const hasAlpha = comp >= 4;
  for (let i = 0; i < vertexCount; i++) {
    const o = i * comp;
    out[i * 4] = (src[o] ?? 255) * scale;
    out[i * 4 + 1] = (src[o + 1] ?? 255) * scale;
    out[i * 4 + 2] = (src[o + 2] ?? 255) * scale;
    out[i * 4 + 3] = hasAlpha ? (src[o + 3] ?? 255) * scale : 1;
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
  /**
   * uv 第三分量（文件里的 `custom0`，官方 `aTextureCoordMatrix`）。
   * 只有存在该流时才产生；解码语义见 core/TexCoordZ.ts。
   */
  aTexCoordZ?: PlainAttribute;
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
  /** 被剔除的「同单体共面重复」三角形数（数据自重叠，见 dropCoincidentTriangles） */
  deduped?: number;
  skipped: string[];
}

export interface TileGeometryData {
  primitives: PrimitiveData[];
  stats: TileGeometryStats;
}

export interface AssembleOptions {
  /** 是否对 primitiveType=4 的三角面做瓦片内同材质合批（默认 true） */
  batching?: boolean;
  /**
   * 是否剔除「同单体、同位置、同绕向」的共面重复三角形（默认 true）。
   *
   * 开：修掉数据自重叠造成的斜向摩尔纹（`3D-BIMbuilding-2` 实测单 geo 有 1/3 重复）。
   * 关：完全不碰索引，一个循环都不跑 —— 数据本来没问题、又不想付这份 CPU 时用。
   *
   * 注意这份开销按三角形数线性增长（10 万三角形约 90 ms），在 Worker 里跑不占主线程；
   * `useWorker: false` 或 Worker 崩溃降级时它落在主线程上。
   */
  dedupeCoincident?: boolean;
  vertexAttributeDescript?: unknown;
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
  let hasTexZ = false;

  for (const c of candidates) {
    totalVertices += c.vertexCount;
    totalIndices += c.index ? c.indexCount : c.vertexCount;
    if (c.attrs.normal) hasNormal = true;
    if (c.attrs.uv) hasUv = true;
    if (c.attrs.uv1) hasUv1 = true;
    if (c.attrs.aAtlasRect) hasAtlas = true;
    if (c.attrs.aTexCoordZ) hasTexZ = true;
  }

  const mergedPos: PlainAttribute = { array: new Float32Array(totalVertices * 3), components: 3, normalized: false };
  const mergedNorm = hasNormal ? { array: new Float32Array(totalVertices * 3), components: 3, normalized: false } : null;
  const mergedUv = hasUv ? { array: new Float32Array(totalVertices * 2), components: 2, normalized: false } : null;
  const mergedUv1 = hasUv1 ? { array: new Float32Array(totalVertices * 2), components: 2, normalized: false } : null;
  const mergedColor: PlainAttribute = { array: new Float32Array(totalVertices * 4), components: 4, normalized: false };
  const mergedBatchId: PlainAttribute = { array: new Float32Array(totalVertices), components: 1, normalized: false };
  const mergedRect0 = hasAtlas ? { array: new Float32Array(totalVertices * 4), components: 4, normalized: false } : null;
  const mergedRect1 = hasAtlas ? { array: new Float32Array(totalVertices * 4), components: 4, normalized: false } : null;
  const mergedSecUv = hasAtlas ? { array: new Float32Array(totalVertices * 2), components: 2, normalized: false } : null;
  const mergedTexZ = hasTexZ ? { array: new Float32Array(totalVertices), components: 1, normalized: false } : null;
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
    const tzArr = attrs.aTexCoordZ?.array;
    const tzOut = mergedTexZ?.array as Float32Array | undefined;
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
      // aTexCoordZ（uv 第三分量）：缺这条流的候选补 0 = 单位变换
      if (tzOut) tzOut[dst] = tzArr ? tzArr[i]! : 0;
      // aColor（RGBA：alpha 是 4421 这类「材质不透明、顶点半透明」的唯一来源）
      if (colArr) {
        colOut[dst * 4] = colArr[i * 4];
        colOut[dst * 4 + 1] = colArr[i * 4 + 1];
        colOut[dst * 4 + 2] = colArr[i * 4 + 2];
        colOut[dst * 4 + 3] = colArr[i * 4 + 3] ?? 1;
      } else {
        colOut[dst * 4] = 1;
        colOut[dst * 4 + 1] = 1;
        colOut[dst * 4 + 2] = 1;
        colOut[dst * 4 + 3] = 1;
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
      aTexCoordZ: mergedTexZ ?? undefined,
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
function assembleSkeleton(
  name: string,
  geo: GeoPackageEntry,
  tile: ParsedTile,
  skipped: string[],
  options?: AssembleOptions
): SkeletonAsm | null {
  const vp = geo.vertexPackage;
  applyCustomAttributeSemantics(vp, undefined, (tile as any).vertexAttributeDescript ?? options?.vertexAttributeDescript);
  const positionAttr = vp.vertexAttributes.find((a) => a.semantic === 'position');
  if (!positionAttr) {
    skipped.push(`${name} 无 position`);
    return null;
  }

  const vertexCount = vp.verticesCount || 0;
  const attrs: PrimitiveAttributes = {
    position: deinterleave(positionAttr),
    aColor: { array: new Float32Array(0), components: 4, normalized: false },
    aBatchId: { array: new Float32Array(0), components: 1, normalized: false },
  };
  let colorAttr: VertexAttribute | null = null;
  let batchAttr: VertexAttribute | null = null;
  let normalData: PlainAttribute | null = null;
  let uvData: PlainAttribute | null = null;
  let uv1Data: PlainAttribute | null = null;
  let texCoordZData: PlainAttribute | null = null;

  for (const attr of vp.vertexAttributes) {
    if (attr.divisor !== undefined) continue; // 实例属性不进顶点流
    if (attr.semantic === 'position') continue;
    if (attr.semantic === 'color') colorAttr = attr;
    else if (attr.semantic === 'batchId') batchAttr = attr;
    else if (attr.semantic === 'normal') normalData = deinterleave(attr);
    else if (attr.semantic === 'uv') uvData = deinterleave(attr);
    else if (attr.semantic === 'uv2') uv1Data = deinterleave(attr);
    // uv 第三分量（官方 aTextureCoordMatrix）：决定「这张贴图用不用、
    // 用图集的哪个子区域、按 2 的几次幂缩放」。语义见 core/TexCoordZ.ts。
    // 注意：按语义查槽（找 TextureCoordMatrix），不要固定取 custom0；
    // 绝对不能把 VertexWeight（高度值）等其它语义属性当成贴图矩阵；
    // 若全为哨兵（-99999）则视为无第三分量，跳过采样/图集选择逻辑。
    else if (
      (attr.semantic === 'TextureCoordMatrix' ||
        attr.semantic === 'aTextureCoordMatrix' ||
        (attr.semantic === 'custom0' && !vp.vertexAttributes.some((a) => a.semantic === 'TextureCoordMatrix' || a.semantic === 'VertexWeight'))) &&
      (attr.components ?? 1) >= 1
    ) {
      const plain = deinterleave(attr);
      const arr = plain.array as Float32Array;
      let hasValid = false;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i]! >= -99900) {
          hasValid = true;
          break;
        }
      }
      if (hasValid) {
        texCoordZData = plain;
      }
    }
  }

  attrs.aColor = { array: colorData(colorAttr, vertexCount), components: 4, normalized: false };
  attrs.aBatchId = batchAttr
    ? { array: deinterleave(batchAttr).array, components: 1, normalized: false }
    : { array: new Float32Array(vertexCount).fill(-1), components: 1, normalized: false };
  if (normalData) attrs.normal = normalData;
  if (uvData) attrs.uv = uvData;
  if (uv1Data) attrs.uv1 = uv1Data;
  if (texCoordZData) attrs.aTexCoordZ = texCoordZData;

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
 * 丢弃「同单体、同位置、同绕向」的重复三角形。
 *
 * 为什么需要：OSGB 转出来的 S3M 里确实存在**模型自重叠**。实测
 * `3D-BIMbuilding-2` 的 `Tile_-85071_248749_0000` 中 geo E2F8F0 有 7156 个三角形，
 * 其中 2276 个与前面某个三角形的三个顶点坐标完全相同（4 位小数，0.1 mm 内），
 * `Tile_-85071_248750_0000` 的 geo 386340 是 58/156 —— 文件级统计，不是我们合批造出来的。
 *
 * 两个共面三角形各自光栅化时深度值只差最后几位，深度缓冲分不出谁在前，
 * 屏幕上就是一片斜向摩尔纹（用户说的「模型重叠的斜线」）；若两份材质不同，
 * 还会随绘制顺序闪成另一种颜色。
 *
 * 只丢**同 batchId** 的重复：跨单体的重叠是数据本身两个单体压在一起，
 * 丢掉任何一个都会让那个 SMID 变得不可见 / 不可拾取，只能留给业务层处理。
 *
 * @param quantum 顶点坐标量化步长（米）。1 mm 足以合并「同一条边」的重复，
 *                又不会误伤真正相邻的两个面。
 */
export function dropCoincidentTriangles(
  index: Uint16Array | Uint32Array,
  positions: ArrayLike<number>,
  batchIds: ArrayLike<number> | null,
  quantum = 1e-3
): { index: Uint16Array | Uint32Array; dropped: number } {
  const triCount = Math.floor(index.length / 3);
  if (triCount === 0) return { index, dropped: 0 };

  const inv = 1 / quantum;
  const keyOf = (v: number): string =>
    `${Math.round(positions[v * 3] * inv)},${Math.round(positions[v * 3 + 1] * inv)},${Math.round(positions[v * 3 + 2] * inv)}`;

  const seen = new Set<string>();
  const out = new (index instanceof Uint32Array ? Uint32Array : Uint16Array)(index.length);
  let w = 0;
  let dropped = 0;
  for (let t = 0; t < triCount; t++) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];
    const ka = keyOf(a);
    const kb = keyOf(b);
    const kc = keyOf(c);
    // 把字典序最小的顶点转到首位，**保持绕向**：
    // 绕向相同的两份才是「同一个面画了两遍」；正反两份是有意做的双面片，
    // 它们共面且绕向相反，深度相等时后者覆盖前者、着色一致，不会出摩尔纹。
    let k1 = ka;
    let k2 = kb;
    let k3 = kc;
    if (kb <= ka && kb <= kc) {
      k1 = kb;
      k2 = kc;
      k3 = ka;
    } else if (kc <= ka && kc <= kb) {
      k1 = kc;
      k2 = ka;
      k3 = kb;
    }
    const key = k1 + k2 + k3 + (batchIds ? `#${batchIds[a]}` : '');
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    out[w++] = a;
    out[w++] = b;
    out[w++] = c;
  }
  if (dropped === 0) return { index, dropped: 0 };
  return { index: out.slice(0, w) as Uint16Array | Uint32Array, dropped };
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
    const asm = assembleSkeleton(name, geo, tile, skipped, options);
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

  // 数据自重叠：同单体、同位置、同绕向的重复三角形会互相压深度，出斜向摩尔纹。
  // 只在**单 geo** 的 primitive 上做：合批产物里多个 geo 的 batchId 各自从 0 起，
  // 混在一起会把「不同单体恰好共面」误判成同一条。
  // 默认开；显式关掉时连循环都不进（stats 里也不会出现 deduped）。
  if (options.dedupeCoincident !== false) {
    for (const p of primitives) {
      if (p.primitiveType !== 4 || !p.index) continue;
      if (p.geoNames.length > 1) continue;
      const positions = p.attributes.position?.array;
      if (!positions) continue;
      const batchIds = p.attributes.aBatchId?.array ?? null;
      const { index, dropped } = dropCoincidentTriangles(p.index, positions, batchIds);
      if (dropped > 0) {
        p.index = index;
        p.indexCount = index.length;
        stats.deduped = (stats.deduped ?? 0) + dropped;
      }
    }
  }

  return { primitives, stats };
}
