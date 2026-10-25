/**
 * S3M 解析结果 → three.js 可渲染对象
 *
 * 职责边界：这里只做「数据 → BufferGeometry / Material」的搬运，
 * 不处理坐标系、不处理 LOD、不处理样式切换 —— 那些属于 S3MLayer。
 *
 * 三条约定，下游都依赖它：
 *   1. 几何一定有 `aBatchId`（单体编号）和 `aColor`（顶点色），没有就补零/补白，
 *      否则着色器里的 attribute 绑定会缺槽位。
 *   2. 每个 Mesh 独享一个材质实例，但 uniform 对象是全局共享的，
 *      所以既能逐单体高亮，又能一次改样式全场景生效。
 *   3. `userData` 上挂 `skeletonName / geoRef / tileRef`，供拾取后反查单体属性。
 */
import * as THREE from 'three';
import { createTexture } from './TextureFactory.js';
import { createSharedUniforms, createStyledMaterial } from './StyleMaterial.js';
import type { StyledMaterial } from './StyleMaterial.js';
import type {
  AttrDType,
  GeoPackageEntry,
  IndexPackage,
  ParsedTile,
  StyleUniforms,
  VertexAttribute,
} from '../core/types.js';

/* ------------------------------------------------------------------ 索引包类型 */

/**
 * S3M 规范里 `DrawPrimitiveType` 只到 10（多边形），但 iServer 实际发布的 v3 瓦片里
 * 会出现 **13**：它是数据自带的「棱线包」—— 索引是线段对，不是三角形。
 *
 * 这条是踩过坑才认出来的：把 13 当三角形画，每条棱线都会被连成一根几十上百米的尖刺，
 * 满屏都是放射状的三角面。按 LineSegments 画出来，正好是整片建筑轮廓线。
 */
export const LINE_PRIMITIVE = 13;

/** primitiveType = 1：点云包。索引是点序号，画成三角面就是满屏彩色尖刺。 */
export const POINT_PRIMITIVE = 1;

function isLinePrimitive(primitiveType: number): boolean {
  // 1 = 点，2 = 线段，3 = 折线，13 = 棱线包
  return primitiveType === LINE_PRIMITIVE || primitiveType === 2 || primitiveType === 3;
}

function isPointPrimitive(primitiveType: number): boolean {
  return primitiveType === POINT_PRIMITIVE;
}

/**
 * 按「binding 的原始 uv 跨度 ÷ 精灵像素尺寸」重算图集 UV（顶点已按三角形展开）。
 *
 * 关键事实（`_tmp/atlas/calib.mts` 实测 53 条 binding 得出）：同一个骨架里混着两类 binding ——
 *
 * | binding | uv 跨度 | 精灵像素 | 含义 |
 * |---|---|---|---|
 * | `108_3` | 1.0 × 1.0 | 96×32 | uv 已经是 0..1，一面墙一整张精灵 |
 * | `103_3` | 279 × 31 | 12×8 | uv 是世界尺度，一张精灵只占很小一段，必须平铺 |
 *
 * 所以「一律 0..1」会把第二类拉成一整张照片，「一律平铺」又会把第一类切成碎片。
 * 统一公式：把 uv 归一化到该组的跨度，再按 `跨度 / 精灵像素` 取整重复 ——
 * 这样两类都退化成正确结果，而且**保留了 uv 的空间连续性**（相邻墙不会贴到图集别处）。
 *
 * 之所以必须展开顶点：转角顶点同时属于两堵墙，共享一份 UV 会把另一面墙拽歪。
 */
export function buildScaledUVs(
  expandedUv: THREE.BufferAttribute,
  expandedDim: Float32Array,
  index: ArrayLike<number>,
  groups: Float32Array
): Float32Array | null {
  const triCount = (index.length / 3) | 0;
  if (triCount < 1) return null;

  const uv = expandedUv.array as ArrayLike<number>;
  const stride = expandedUv.itemSize;
  const giCount = triCount * 3;

  // 先把展开后的顶点按「原顶点」映射回 group / dim
  const gidOf = new Int32Array(giCount);
  const dimW = new Float32Array(giCount);
  const dimH = new Float32Array(giCount);
  for (let g = 0; g < giCount; g++) {
    const src = index[g]!;
    gidOf[g] = groups[src] ?? -1;
    dimW[g] = expandedDim[src * 2] ?? 1;
    dimH[g] = expandedDim[src * 2 + 1] ?? 1;
  }

  // 逐组统计 uv 包围盒
  const box = new Map<number, { u0: number; u1: number; v0: number; v1: number; w: number; h: number }>();
  for (let g = 0; g < giCount; g++) {
    const gid = gidOf[g]!;
    if (gid < 0) continue;
    const u = uv[g * stride]!;
    const v = uv[g * stride + 1]!;
    let b = box.get(gid);
    if (!b) {
      b = { u0: u, u1: u, v0: v, v1: v, w: dimW[g]!, h: dimH[g]! };
      box.set(gid, b);
    } else {
      if (u < b.u0) b.u0 = u;
      if (u > b.u1) b.u1 = u;
      if (v < b.v0) b.v0 = v;
      if (v > b.v1) b.v1 = v;
    }
  }

  // 预计算每组 (起点, 跨度, 重复次数)
  const calc = new Map<number, { u0: number; v0: number; su: number; sv: number; ru: number; rv: number }>();
  for (const [gid, b] of box) {
    const su = b.u1 - b.u0;
    const sv = b.v1 - b.v0;
    // 一个周期 = 精灵宽（像素）个 uv 单位；至少 1 次，四舍五入到整数保持接缝对齐
    const ru = su > 1e-6 ? Math.max(1, Math.round(su / Math.max(b.w, 1))) : 1;
    const rv = sv > 1e-6 ? Math.max(1, Math.round(sv / Math.max(b.h, 1))) : 1;
    calc.set(gid, { u0: b.u0, v0: b.v0, su, sv, ru, rv });
  }

  const out = new Float32Array(giCount * 2);
  for (let g = 0; g < giCount; g++) {
    const gid = gidOf[g]!;
    const c = gid >= 0 ? calc.get(gid) : undefined;
    if (!c) continue;
    const u = uv[g * stride]!;
    const v = uv[g * stride + 1]!;
    // 跨度为 0 的方向（垂直于墙的那一维）取精灵中线，避免除零
    out[g * 2] = c.su > 1e-6 ? ((u - c.u0) / c.su) * c.ru : 0.5 * c.ru;
    out[g * 2 + 1] = c.sv > 1e-6 ? ((v - c.v0) / c.sv) * c.rv : 0.5 * c.rv;
  }
  return out;
}

/**
 * 按「绑定组」生成逐面 0..1 的图集 UV（顶点已按三角形展开，返回长度 = 三角形数 * 6）。
 *
 * 依据来自数据本身：块文件的 subTexInfos 里，每条 binding 明确写了「哪段顶点用哪张子纹理」
 * （geoName + vertexOffset + vertexCount）。这就是官方的 batch 表语义 —— 官方片元里
 * `fract(uv) * scale + translate` 用的 uv 正是这套划分下的局部坐标。
 *
 * 所以这里直接按 binding 分组：一组顶点（= 一面墙 / 一个建筑单体的一个立面）用整张精灵，
 * 水平竖直都归一化到 0..1，不做平铺。之前的两种做法都不对：
 *   - 用世界尺度 uv 直接 fract：一个周期只有 1.65 m，整段立面被压进两米重复几百遍；
 *   - 按几何连通性自己分 patch：整片街区被并成一块，每面墙显示的都是整个街区。
 */
export function buildGroupUVs(
  expandedPosition: THREE.BufferAttribute,
  index: ArrayLike<number>,
  groups: Float32Array
): Float32Array | null {
  const triCount = (index.length / 3) | 0;
  if (triCount < 1) return null;

  const pos = expandedPosition.array as ArrayLike<number>;
  const stride = expandedPosition.itemSize;
  const px = (k: number) => pos[k * stride]!;
  const py = (k: number) => pos[k * stride + 1]!;
  const pz = (k: number) => pos[k * stride + 2]!;

  const axisOf = (x: number, y: number, z: number) => {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    if (ay >= ax && ay >= az) return 1; // 顶面 → xz
    if (ax >= az) return 0; // 法线朝 x → zy
    return 2; // 法线朝 z → xy
  };
  const uvAxes = (axis: number): [number, number] => {
    if (axis === 1) return [0, 2];
    if (axis === 0) return [2, 1];
    return [0, 1];
  };
  const comp = (k: number, axis: number) => (axis === 0 ? px(k) : axis === 1 ? py(k) : pz(k));

  // key = groupId * 4 + axis，保证同一组里不同朝向的墙各算各的包围盒
  const keyOf = new Int32Array(triCount).fill(-1);
  const minU: number[] = [];
  const maxU: number[] = [];
  const minV: number[] = [];
  const maxV: number[] = [];
  const axisOfPatch: number[] = [];
  const keyToPatch = new Map<number, number>();

  for (let t = 0; t < triCount; t++) {
    const o = t * 3;
    const gid = groups[index[o]!] ?? -1;
    if (gid < 0) continue;
    const ux = px(o + 1) - px(o), uy = py(o + 1) - py(o), uz = pz(o + 1) - pz(o);
    const vx = px(o + 2) - px(o), vy = py(o + 2) - py(o), vz = pz(o + 2) - pz(o);
    const mx = uy * vz - uz * vy;
    const my = uz * vx - ux * vz;
    const mz = ux * vy - uy * vx;
    if (!(Math.hypot(mx, my, mz) > 1e-9)) continue; // 退化三角形
    const axis = axisOf(mx, my, mz);
    const key = gid * 4 + axis;
    let pid = keyToPatch.get(key);
    if (pid === undefined) {
      pid = axisOfPatch.length;
      keyToPatch.set(key, pid);
      axisOfPatch.push(axis);
      minU.push(Infinity);
      maxU.push(-Infinity);
      minV.push(Infinity);
      maxV.push(-Infinity);
    }
    keyOf[t] = pid;
    const [ui, vi] = uvAxes(axis);
    for (let k = 0; k < 3; k++) {
      const u = comp(o + k, ui);
      const v = comp(o + k, vi);
      if (u < minU[pid]!) minU[pid] = u;
      if (u > maxU[pid]!) maxU[pid] = u;
      if (v < minV[pid]!) minV[pid] = v;
      if (v > maxV[pid]!) maxV[pid] = v;
    }
  }

  const out = new Float32Array(triCount * 6);
  for (let t = 0; t < triCount; t++) {
    const pid = keyOf[t]!;
    if (pid < 0) continue;
    const axis = axisOfPatch[pid]!;
    const [ui, vi] = uvAxes(axis);
    const w = maxU[pid]! - minU[pid]!;
    const h = maxV[pid]! - minV[pid]!;
    // 长墙按「宽高比」取整数重复：一面 4:1 的墙横向放 4 张，纵向始终 1 张 ——
    // 竖直方向必须只铺一次，否则立面照会被切成一条条。
    // 一张精灵 = 这面墙的整张立面照片（含所有楼层），所以横向也只铺一次。
    // 之前按宽高比取重复，一栋 200x72 的板楼横向铺 3 张，窗格被横着拉大三倍。
    const repeat = 1;
    for (let k = 0; k < 3; k++) {
      const gi = t * 3 + k;
      const u = comp(gi, ui);
      const v = comp(gi, vi);
      out[gi * 2] = w > 1e-6 ? ((u - minU[pid]!) / w) * repeat : 0;
      out[gi * 2 + 1] = h > 1e-6 ? (v - minV[pid]!) / h : 0;
    }
  }
  return out;
}

/**
 * 由三角网生成「逐面 0..1」的图集 UV（顶点按三角形展开，返回长度 = 三角形数 * 6）。
 *
 * 背景：S3MBLOCK 的原始 UV 是世界尺度投影坐标（实测 ±139），而图集里每个精灵是
 * **一整段建筑立面**。拿世界 UV 去 fract 等于把整段立面压进两米重复几百遍。
 *
 * 三条踩过的坑：
 *   1. patch 必须「共面」—— 只按法线主轴分组会把整片街区并成一整块，bbox 一归一化，
 *      每面墙显示的就是整个街区；
 *   2. 不能按顶点索引判相邻 —— 这类模型的三角形基本不共享顶点（实测 79% 的 patch
 *      退化成一个三角形），必须按**空间坐标**量化后再判相邻；
 *   3. 顶点必须按三角形展开 —— 转角顶点同时属于两堵墙，共享 UV 会把另一面墙拽歪。
 */
export function buildFaceUVs(
  expandedPosition: THREE.BufferAttribute,
  index: ArrayLike<number>,
  _vertexCount?: number
): Float32Array | null {
  const triCount = (index.length / 3) | 0;
  if (triCount < 1) return null;

  const pos = expandedPosition.array as ArrayLike<number>;
  const stride = expandedPosition.itemSize;
  const px = (k: number) => pos[k * stride]!;
  const py = (k: number) => pos[k * stride + 1]!;
  const pz = (k: number) => pos[k * stride + 2]!;

  const giCount = triCount * 3;
  const Q = 20; // 5 cm 量化，抹掉浮点误差

  // ---- 位置量化 → 位置顶点 id（重复顶点合并）----
  const posId = new Int32Array(giCount);
  const idMap = new Map<string, number>();
  let posCount = 0;
  for (let g = 0; g < giCount; g++) {
    const key = `${Math.round(px(g) * Q)}_${Math.round(py(g) * Q)}_${Math.round(pz(g) * Q)}`;
    let id = idMap.get(key);
    if (id === undefined) {
      id = posCount++;
      idMap.set(key, id);
    }
    posId[g] = id;
  }
  idMap.clear();

  // ---- 逐三角形：法线 + 平面偏移 ----
  const nx = new Float32Array(triCount);
  const ny = new Float32Array(triCount);
  const nz = new Float32Array(triCount);
  const plane = new Float32Array(triCount);
  const ok = new Uint8Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const o = t * 3;
    const ux = px(o + 1) - px(o), uy = py(o + 1) - py(o), uz = pz(o + 1) - pz(o);
    const vx = px(o + 2) - px(o), vy = py(o + 2) - py(o), vz = pz(o + 2) - pz(o);
    const mx = uy * vz - uz * vy;
    const my = uz * vx - ux * vz;
    const mz = ux * vy - uy * vx;
    const len = Math.hypot(mx, my, mz);
    if (!(len > 1e-9)) continue; // 退化三角形
    nx[t] = mx / len;
    ny[t] = my / len;
    nz[t] = mz / len;
    const cx = (px(o) + px(o + 1) + px(o + 2)) / 3;
    const cy = (py(o) + py(o + 1) + py(o + 2)) / 3;
    const cz = (pz(o) + pz(o + 1) + pz(o + 2)) / 3;
    plane[t] = nx[t]! * cx + ny[t]! * cy + nz[t]! * cz;
    ok[t] = 1;
  }

  // ---- 并查集（域 = 三角形；位置 id 只用来判共边）----
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const n = parent[x]!;
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const edgeMap = new Map<number, number>();
  const DOT_MIN = 0.985; // 约 10°
  const PLANE_EPS = 0.6; // 米

  for (let t = 0; t < triCount; t++) {
    if (!ok[t]) continue;
    const o = t * 3;
    for (let k = 0; k < 3; k++) {
      const a = posId[o + k]!;
      const b = posId[o + ((k + 1) % 3)]!;
      if (a === b) continue;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * posCount + hi;
      const other = edgeMap.get(key);
      if (other === undefined) {
        edgeMap.set(key, t);
        continue;
      }
      if (!ok[other]) continue;
      const dot = nx[t]! * nx[other]! + ny[t]! * ny[other]! + nz[t]! * nz[other]!;
      if (Math.abs(dot) < DOT_MIN) continue;
      if (Math.abs(plane[t]! - plane[other]!) > PLANE_EPS) continue;
      union(t, other);
    }
  }

  // ---- patch 包围盒 ----
  const patchOf = new Int32Array(triCount).fill(-1);
  const patchAxis: number[] = [];
  const patchMin: number[][] = [];
  const patchMax: number[][] = [];
  const rootToPatch = new Map<number, number>();

  const axisOf = (x: number, y: number, z: number) => {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    if (ay >= ax && ay >= az) return 1; // 顶面 / 底面 → xz
    if (ax >= az) return 0; // 法线朝 x → zy
    return 2; // 法线朝 z → xy
  };
  const uvAxes = (axis: number): [number, number] => {
    if (axis === 1) return [0, 2]; // 顶面：u=x v=z
    if (axis === 0) return [2, 1]; // 法线朝 x：u=z v=y
    return [0, 1]; // 法线朝 z：u=x v=y
  };
  const comp = (k: number, axis: number) => (axis === 0 ? px(k) : axis === 1 ? py(k) : pz(k));

  for (let t = 0; t < triCount; t++) {
    if (!ok[t]) continue;
    const root = find(t);
    let pid = rootToPatch.get(root);
    if (pid === undefined) {
      pid = patchAxis.length;
      rootToPatch.set(root, pid);
      patchAxis.push(axisOf(nx[t]!, ny[t]!, nz[t]!));
      patchMin.push([Infinity, Infinity]);
      patchMax.push([-Infinity, -Infinity]);
    }
    patchOf[t] = pid;
    const [ui, vi] = uvAxes(patchAxis[pid]!);
    const mn = patchMin[pid]!;
    const mx = patchMax[pid]!;
    for (let k = 0; k < 3; k++) {
      const u = comp(t * 3 + k, ui);
      const v = comp(t * 3 + k, vi);
      if (u < mn[0]!) mn[0] = u;
      if (u > mx[0]!) mx[0] = u;
      if (v < mn[1]!) mn[1] = v;
      if (v > mx[1]!) mx[1] = v;
    }
  }

  const out = new Float32Array(triCount * 6);
  for (let t = 0; t < triCount; t++) {
    const pid = patchOf[t]!;
    if (pid < 0) continue;
    const axis = patchAxis[pid]!;
    const [ui, vi] = uvAxes(axis);
    const mn = patchMin[pid]!, mx = patchMax[pid]!;
    const w = mx[0]! - mn[0]!;
    const h = mx[1]! - mn[1]!;
    // 一面墙一张精灵：先不做横向重复，避免同一面墙被拼成好几栋楼
    const repeat = 1;
    for (let k = 0; k < 3; k++) {
      const gi = t * 3 + k;
      const u = comp(gi, ui);
      const v = comp(gi, vi);
      out[gi * 2] = w > 1e-6 ? ((u - mn[0]!) / w) * repeat : 0;
      out[gi * 2 + 1] = h > 1e-6 ? (v - mn[1]!) / h : 0;
    }
  }
  return out;
}

/**
 * 点云共享材质：顶点色直接上屏，不受光照影响。
 * 固定像素尺寸（sizeAttenuation: false），远近点大小一致，高空浏览时不会缩成一团。
 */
let pointCloudMaterial: THREE.PointsMaterial | null = null;
function getPointCloudMaterial(): THREE.PointsMaterial {
  if (!pointCloudMaterial) {
    pointCloudMaterial = new THREE.PointsMaterial({
      size: 2,
      sizeAttenuation: false,
      vertexColors: true,
    });
  }
  return pointCloudMaterial;
}

/* ------------------------------------------------------------------ 顶点流 */

function bytesPerElement(dtype: AttrDType): number {
  return dtype === 'u8' ? 1 : dtype === 'u16' ? 2 : 4;
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

function toBufferAttribute(attr: VertexAttribute): THREE.BufferAttribute {
  const { data, stride, offsetInBytes, dtype = 'f32' } = attr;
  const components = attr.components ?? (attr as unknown as { comp?: number }).comp ?? 3;
  const bpe = bytesPerElement(dtype);
  const itemBytes = components * bpe;
  const actualStride = stride ?? itemBytes;
  const actualOffset = offsetInBytes ?? 0;
  const normalized = dtype === 'u8';

  // 非交错：整段直接铺开
  if (actualStride === itemBytes && actualOffset === 0) {
    const view = typedArray(dtype, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return new THREE.BufferAttribute(view, components, normalized);
  }

  // 交错：逐元素抽取
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
  return new THREE.BufferAttribute(out, components, normalized);
}

function toIndex(indexPack: IndexPackage): THREE.BufferAttribute | null {
  const { indices, indexType, indexCount } = indexPack;
  if (!indices || indexCount === 0) return null;
  // 以字节宽度为准：S3M 的 indexType 在 MeshOpt 包里恒为 0，靠它会读错一半索引。
  const width = Math.floor(indices.byteLength / indexCount);
  const wide = width === 4 || (width !== 2 && (indexType === 1 || indexType === 3));
  const n = indexCount * (wide ? 4 : 2);
  if (n > indices.byteLength) return null;
  const buf = indices.buffer.slice(indices.byteOffset, indices.byteOffset + n);
  const view = wide ? new Uint32Array(buf) : new Uint16Array(buf);
  return new THREE.BufferAttribute(view, 1);
}

/** 把 u8 顶点色转成 float vec3，供着色器直接相乘 */
function toColorAttribute(attr: VertexAttribute | null, vertexCount: number): THREE.BufferAttribute {
  const out = new Float32Array(vertexCount * 3);
  if (!attr) {
    out.fill(1);
    return new THREE.BufferAttribute(out, 3);
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
  return new THREE.BufferAttribute(out, 3);
}

/** SuperMap 内置水面（`103.water`）的基色：偏深的青蓝，配合低粗糙度出一点天光反射 */
const WATER_COLOR = new THREE.Color(0x1d4e63);

/* ------------------------------------------------------------------ 材质描述 */

interface RawMaterialUnit {
  name?: string;
  id?: string;
  textureunitstate?: RawMaterialUnit;
  texmodmatrix?: number[];
  matrix?: number[];
  addressmode?: { u?: number; v?: number; w?: number };
}

interface RawMaterialDef {
  name?: string;
  id?: string;
  diffuse?: { r?: number; g?: number; b?: number; a?: number };
  shininess?: number;
  alphaMode?: string;
  alphaCutoff?: number;
  cullMode?: string;
  transparentsorting?: boolean;
  textureStates?: RawMaterialUnit[];
  textureunitstates?: RawMaterialUnit[];
}

type RawMaterialEntry = RawMaterialDef & { material?: RawMaterialDef };

/** 3.x 是 `{materials:[...]}`，1.x/2.x 是 `{material:[...]}`，桌面导出偶尔直接给数组 */
function resolveMaterialList(doc: unknown): RawMaterialEntry[] {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc as RawMaterialEntry[];
  const o = doc as { materials?: unknown; material?: unknown };
  const list = o.materials ?? o.material;
  return Array.isArray(list) ? (list as RawMaterialEntry[]) : [];
}

function unwrapMaterial(entry: RawMaterialEntry | undefined): RawMaterialDef | undefined {
  return entry?.material ?? entry;
}

function materialName(m: RawMaterialDef | RawMaterialUnit | undefined): string | undefined {
  return m?.name ?? m?.id;
}

function materialUnits(m: RawMaterialDef | undefined): RawMaterialUnit[] {
  const raw = m?.textureStates ?? m?.textureunitstates ?? [];
  return raw.map((u) => u?.textureunitstate ?? u).filter((u): u is RawMaterialUnit => !!u);
}

/** 判断 4x4 矩阵是否为标准单位矩阵 */
function isIdentityMatrix4(m: number[]): boolean {
  if (m.length !== 16) return false;
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 &&
    m[4] === 0 && m[5] === 1 && m[6] === 0 && m[7] === 0 &&
    m[8] === 0 && m[9] === 0 && m[10] === 1 && m[11] === 0 &&
    m[12] === 0 && m[13] === 0 && m[14] === 0 && m[15] === 1
  );
}

/** cullMode：1.x 用 none/clockwise/backward，3.x 用 CULL_NONE / CULL_BACK / CULL_FRONT */
function resolveSide(m: RawMaterialDef | undefined): THREE.Side {
  const cull = String(m?.cullMode ?? '').toUpperCase();
  if (cull === 'CULL_BACK' || cull === 'BACKWARD') return THREE.FrontSide;
  if (cull === 'CULL_FRONT') return THREE.BackSide;
  return THREE.DoubleSide;
}

/* ------------------------------------------------------------------ 入口 */

export interface TileBuildStats {
  meshes: number;
  vertices: number;
  triangles: number;
  textures: number;
  instanced: number;
  /** 数据自带的棱线包（primitiveType 13）数量 */
  edgeLines: number;
  /** 合批前原有独立网格数 */
  originalMeshes?: number;
  /** 被跳过的东西，加载完可以直接在控制台看 */
  skipped: string[];
}

/**
 * S3MBLOCK 图集的 base UV 取法。
 *
 * - `raw`：直接用数据里的世界尺度 UV（跨度可达 ±139），`fract` 之后一个周期约 1.65 m，
 *   一张整栋楼缩略图会被压到两米宽重复几百遍 —— 满屏 confetti。
 * - `face`：按三角网连通面重新生成「一面墙一套 0..1」的 UV，等价于官方引擎自己算出来的
 *   那套 texcoord（实测 set2 成对出现 0/1、上界是整数重复次数）。
 */
export type AtlasUvMode = 'raw' | 'face';

export interface BuildTileOptions {
  /** 全局共享 uniform；不传则本次构建自建一份（不推荐，样式将无法全局联动） */
  uniforms?: StyleUniforms;
  textureCache?: Map<string, THREE.Texture>;
  /** S3MBLOCK 图集 base UV 的取法，默认 'face'（与官方观感一致） */
  atlasUv?: AtlasUvMode;
  /** 是否显示数据自带的棱线包 */
  edges?: boolean;
  edgeColor?: THREE.ColorRepresentation;
  /**
   * 是否开启瓦片内同材质网格合批（默认 true）。
   * 对倾斜摄影、大网格切片瓦片可减少 90%+ DrawCall，显著提高渲染帧率。
   */
  batching?: boolean;
}

export interface BuildTileResult {
  group: THREE.Group;
  stats: TileBuildStats;
  objects: THREE.Object3D[];
}

interface CachedGeometry {
  geometry: THREE.BufferGeometry;
  pack: IndexPackage;
}

interface SkeletonInfo {
  indexPackages: IndexPackage[];
  instanced: boolean;
}

export async function buildTileObjects(
  tile: ParsedTile,
  options: BuildTileOptions = {}
): Promise<BuildTileResult> {
  const uniforms = options.uniforms ?? createSharedUniforms();
  const atlasUvMode: AtlasUvMode = options.atlasUv ?? 'face';
  /** 本轮几何是否用了「按绑定组归一化」的 UV：决定片元要不要再按精灵像素尺寸换算 */
  let atlasUvNormalized = false;
  const textureByCode = options.textureCache ?? new Map<string, THREE.Texture>();
  const group = new THREE.Group();
  const objects: THREE.Object3D[] = [];
  const stats: TileBuildStats = {
    meshes: 0,
    vertices: 0,
    triangles: 0,
    textures: 0,
    instanced: 0,
    edgeLines: 0,
    skipped: [],
  };

  // 棱线包共用一份材质，颜色随 style.edgeColor 走
  const edgeLineMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color(options.edgeColor ?? '#1f2937'),
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  group.userData.hasNativeEdges = false;

  // 1) 纹理
  for (const [code, tex] of Object.entries(tile.textures ?? {})) {
    // 同一个图集 id 会被很多瓦片共用：先到的那块可能只拿到内嵌缩略图（120x184），
    // 后面的块换成了高清版（240x304）。只按 id 判「缓存已有」会让高清永远进不来，
    // 满屏都是马赛克。所以尺寸变大时必须重解码并覆盖。
    const prev = textureByCode.get(code);
    if (prev) {
      const img = prev.image as { width?: number; height?: number } | undefined;
      const prevPixels = (img?.width ?? 0) * (img?.height ?? 0);
      if (prevPixels >= (tex.width ?? 0) * (tex.height ?? 0)) continue;
      textureByCode.delete(code);
    }
    const { texture, decoded } = await createTexture(tex);
    if (texture) {
      textureByCode.set(code, texture);
      stats.textures++;
    } else {
      stats.skipped.push(`texture ${code} → ${decoded}`);
    }
  }

  // 2) 材质描述表
  //
  // 注意：这里**不做**材质池化。单体状态（隐藏 / 改色 / 抬高 / 选中）是按 mesh 写在
  // 材质自己的 uniform 上的（uBatchTex / uSelBatch），一旦多个 mesh 共用同一个材质实例，
  // 就是「81 个 mesh 抢一份 uniform，最后写的赢」——白模瓦片里按单体操作会大面积失效。
  // 材质对象本身很轻（program 由 customProgramCacheKey 复用），一栋一个不心疼。
  const materialList = resolveMaterialList(tile.materials);

  const makeMaterial = (code?: string, hasAtlasRect = false): StyledMaterial => {
    const entry = materialList.find((e) => materialName(unwrapMaterial(e)) === code);
    const m = unwrapMaterial(entry);
    const units = materialUnits(m);
    const unit0 = units[0];
    let map = unit0 ? (textureByCode.get(materialName(unit0) ?? unit0.id ?? '') ?? null) : null;
    // S3MBLOCK 的烘焙图（unit1 / BakeTex）是光照烘焙，官方与 base 相乘；缺它建筑就是一片平白
    const unit1 = units[1];
    const noBake = (globalThis as { __S3M_NO_BAKE?: boolean }).__S3M_NO_BAKE === true;
    const secMap =
      hasAtlasRect && unit1 && !noBake
        ? (textureByCode.get(materialName(unit1) ?? unit1.id ?? '') ?? null)
        : null;

    // 检查并应用 texmodmatrix 纹理变换矩阵
    const texMod = unit0?.texmodmatrix ?? unit0?.matrix;
    if (map && Array.isArray(texMod) && texMod.length === 16 && !isIdentityMatrix4(texMod)) {
      map = map.clone();
      map.matrixAutoUpdate = false;
      // S3M texmodmatrix 为 4x4 列主序矩阵 [m0..m15]，对应 2D 仿射变换:
      // u' = m[0]*u + m[4]*v + m[12]
      // v' = m[1]*u + m[5]*v + m[13]
      // Three.js Matrix3.set 按行主序接收参数
      map.matrix.set(
        texMod[0], texMod[4], texMod[12],
        texMod[1], texMod[5], texMod[13],
        0,         0,         1
      );
    }

    // 纹理寻址模式（addressmode）
    if (map && unit0?.addressmode) {
      const u = unit0.addressmode.u;
      const v = unit0.addressmode.v;
      if (u !== undefined || v !== undefined) {
        if (map.matrixAutoUpdate) {
          map = map.clone();
        }
        if (u !== undefined) map.wrapS = u === 0 ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
        if (v !== undefined) map.wrapT = v === 0 ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      }
    }

    const diffuse = m?.diffuse ?? { r: 1, g: 1, b: 1, a: 1 };
    const alphaMode = m?.alphaMode;
    // SuperMap 的内置水面：纹理单元 id 是 `103.water`，块里**根本没有像素**
    // （实测 Waters 的 s3mb 只有 1081 字节，textures = 0，材质 diffuse 还是纯白）。
    // 以前当白色漫反射渲染，整片湖就是一块白板。这里按内置水面材质上色。
    const isWater = [unit0, unit1].some((u) => /\.water$/i.test(String(materialName(u) ?? u?.id ?? '')));
    const transparent =
      alphaMode === 'AM_BLEND' || (diffuse.a ?? 1) < 0.999 || m?.transparentsorting === true || (isWater && !map);

    // S3M 的 shininess 是旧式 0~128 高光指数，粗略映射到粗糙度
    const roughness =
      typeof m?.shininess === 'number' && m.shininess > 0 ? Math.max(0.15, 1 - m.shininess / 128) : 0.95;

    // 镂空图集（S3MBLOCK）：建筑照片是异形 alpha 抠图，轮廓顶点会采到 alpha=0 的像素，
    // 不丢弃的话就是成片的黑面。cutoff 取材质自带的 alphaCutoff（实测 0.01）。
    // rect 已经在解析阶段按图集 alpha 收缩到立面本体（见 core/AtlasAlpha.ts），
    // 这里保留 alphaTest 只为挡掉轮廓外的零星像素，不会再出现整面墙被抠空。
    const alphaTest = (map as THREE.Texture | null)?.userData?.s3mHasAlpha
      ? Math.max((m?.alphaCutoff as number) ?? 0, 0.01)
      : 0;

    const mat = createStyledMaterial({
      uniforms,
      map,
      color: isWater && !map ? WATER_COLOR.clone() : new THREE.Color(diffuse.r ?? 1, diffuse.g ?? 1, diffuse.b ?? 1),
      side: resolveSide(m),
      transparent,
      opacity: isWater && !map ? 0.86 : (diffuse.a ?? 1),
      roughness: isWater && !map ? 0.12 : roughness,
      alphaTest,
      atlas: hasAtlasRect && !!map,
      atlasUvNormalized,
      secMap,
    });
    return mat;
  };

  // 3) 骨架 → 几何。顶点是「骨架局部坐标」，真正位置由引用它的 Geode 矩阵决定。
  const geoCache = new Map<string, CachedGeometry>();
  const skeletonInfo = new Map<string, SkeletonInfo>();

  for (const [name, geo] of Object.entries(tile.geoPackage ?? {})) {
    const vp = geo.vertexPackage;
    const positionAttr = vp.vertexAttributes.find((a) => a.semantic === 'position');
    if (!positionAttr) {
      stats.skipped.push(`${name} 无 position`);
      continue;
    }

    const vertexCount = vp.verticesCount || 0;
    const attributes: Record<string, THREE.BufferAttribute> = { position: toBufferAttribute(positionAttr) };
    let colorAttr: VertexAttribute | null = null;
    let batchAttr: VertexAttribute | null = null;

    for (const attr of vp.vertexAttributes) {
      if (attr.divisor !== undefined) continue; // 实例属性不进顶点流
      if (attr.semantic === 'position') continue;
      if (attr.semantic === 'color') colorAttr = attr;
      else if (attr.semantic === 'batchId') batchAttr = attr;
      else if (attr.semantic === 'normal') attributes.normal = toBufferAttribute(attr);
      else if (attr.semantic === 'uv') attributes.uv = toBufferAttribute(attr);
      else if (attr.semantic === 'uv2') attributes.uv1 = toBufferAttribute(attr);
    }

    // 着色器强依赖这两个 attribute，缺了就补默认值
    attributes.aColor = toColorAttribute(colorAttr, vertexCount);
    attributes.aBatchId = batchAttr
      ? toBufferAttribute(batchAttr)
      : new THREE.BufferAttribute(new Float32Array(vertexCount).fill(-1), 1);

    // S3MBLOCK 图集：逐顶点带子区域矩形，平铺的 fract 交给片元做（顶点上做会画反）。
    // 烘焙图（材质 unit1）用第二套原始 UV，这里另开一个 aSecUv 槽位，不跟 three 的 uv1 语义纠缠。
    const rects = tile.atlasRects?.[name];
    if (rects) {
      attributes.aAtlasRect = new THREE.BufferAttribute(rects.uv ?? new Float32Array(vertexCount * 4), 4);
      // 没有第二套 UV 的骨架不做烘焙：给一个退化矩形，片元里据此跳过
      const uv1 = attributes.uv1 as THREE.BufferAttribute | undefined;
      if (rects.uv2 && uv1) {
        attributes.aAtlasRect1 = new THREE.BufferAttribute(rects.uv2, 4);
        attributes.aSecUv = uv1;
      } else {
        attributes.aAtlasRect1 = new THREE.BufferAttribute(new Float32Array(vertexCount * 4), 4);
        attributes.aSecUv = (attributes.uv as THREE.BufferAttribute) ?? new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2);
      }
    }

    const instanced = vp.instanceIndex !== -1 && (vp.instanceMode === 16 || vp.instanceMode === 17);
    // 注意：indexPackages 属于 Skeleton（geoPackage[name]），不在 vertexPackage 里
    //
    // 一个索引包都没有的骨架 = 纯点集：高斯泼溅（3DGaussianSplatting）和无索引点云
    // 都是这种——顶点就是点，没有任何三角形可画。不补一个「顶点即点」的伪包，
    // 下面就不会产出任何对象，整块瓦片最后落到「tile 无可用几何」被丢掉。
    let packs = geo.indexPackages ?? [];
    if (packs.length === 0 && vertexCount > 0) {
      packs = [
        {
          indexCount: 0,
          indexType: 0,
          useIndex: 0,
          primitiveType: POINT_PRIMITIVE,
          indices: null,
          passNames: [],
        },
      ];
    }
    skeletonInfo.set(name, { indexPackages: packs, instanced });
    stats.vertices += vertexCount;

    packs.forEach((pack, pi) => {
      let geometry = new THREE.BufferGeometry();
      for (const [k, v] of Object.entries(attributes)) geometry.setAttribute(k, v);
      const idx = toIndex(pack);
      if (idx) geometry.setIndex(idx);
      else geometry.setDrawRange(0, vertexCount);

      // 图集 UV 要按三角形拆顶点：转角顶点同时属于两堵墙，共享 UV 会把其中一面墙拽歪
      let expandedPosition = attributes.position as THREE.BufferAttribute;
      if (
        atlasUvMode === 'face' &&
        attributes.aAtlasRect &&
        idx &&
        !isLinePrimitive(pack.primitiveType) &&
        !isPointPrimitive(pack.primitiveType)
      ) {
        const expanded = geometry.toNonIndexed();
        expandedPosition = expanded.getAttribute('position') as THREE.BufferAttribute;
        geometry.dispose();
        geometry = expanded;
      }

      // S3MBLOCK 图集：原始 UV 是世界尺度投影坐标（±139），一张立面精灵只摊到 1.65 m，
      // fract 之后就是满屏重复的微缩照片。这里换成「一面墙一套 0..1」，
      // 等价于官方引擎自己在 GPU 侧生成的那套 texcoord。
      if (
        atlasUvMode === 'face' &&
        attributes.aAtlasRect &&
        idx &&
        !isLinePrimitive(pack.primitiveType) &&
        !isPointPrimitive(pack.primitiveType)
      ) {
        const groups = tile.atlasRects?.[name]?.group;
        const dims = tile.atlasRects?.[name]?.groupDim;
        const expUv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
        let faceUv: Float32Array | null = null;
        if (groups && dims && expUv) {
          // groupDim 是「原顶点」维度的，按 index 展开一份给 UV 重算用
          const idxArr = idx.array as ArrayLike<number>;
          const expDim = new Float32Array(idxArr.length * 2);
          for (let i = 0; i < idxArr.length; i++) {
            expDim[i * 2] = dims[idxArr[i]! * 2] ?? 1;
            expDim[i * 2 + 1] = dims[idxArr[i]! * 2 + 1] ?? 1;
          }
          faceUv = buildScaledUVs(expUv, expDim, idxArr, groups);
        }
        if (!faceUv) {
          faceUv = buildFaceUVs(expandedPosition, idx.array as ArrayLike<number>, vertexCount);
        } else {
          atlasUvNormalized = true;
        }
        if (faceUv) geometry.setAttribute('uv', new THREE.BufferAttribute(faceUv, 2));
      }

      // 如果数据本身没有法线且是三角网格，必须在绑定了 index 之后计算法线
      // 绝不能在未索引的 attributes.position 上算，否则非连续顶点会导致法线朝向错乱甚至越界 NaN 导致死黑面
      // 线 / 点包不需要法线
      if (
        !isLinePrimitive(pack.primitiveType) &&
        !isPointPrimitive(pack.primitiveType) &&
        !geometry.getAttribute('normal')
      ) {
        geometry.computeVertexNormals();
      }

      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geoCache.set(`${name}|${pi}`, { geometry, pack });
    });
  }

  const IDENTITY = new THREE.Matrix4();

  interface CandidateMesh {
    cached: CachedGeometry;
    name: string;
    geo: GeoPackageEntry;
    matrix: THREE.Matrix4 | null;
  }

  const batchGroups = new Map<string, CandidateMesh[]>();

  const mergeBatchGeometries = (
    candidates: CandidateMesh[],
    material: StyledMaterial,
    tileRef: ParsedTile
  ): THREE.Mesh => {
    let totalVertices = 0;
    let totalIndices = 0;
    let hasNormal = false;
    let hasUv = false;
    let hasUv1 = false;
    let hasAColor = false;
    let hasABatchId = false;
    let hasAtlas = false;

    for (const c of candidates) {
      const g = c.cached.geometry;
      const vCount = g.attributes.position?.count ?? 0;
      totalVertices += vCount;
      totalIndices += g.index ? g.index.count : vCount;
      if (g.attributes.normal) hasNormal = true;
      if (g.attributes.uv) hasUv = true;
      if (g.attributes.uv1) hasUv1 = true;
      if (g.attributes.aColor) hasAColor = true;
      if (g.attributes.aBatchId) hasABatchId = true;
      if (g.attributes.aAtlasRect) hasAtlas = true;
    }

    const mergedPos = new Float32Array(totalVertices * 3);
    const mergedNorm = hasNormal ? new Float32Array(totalVertices * 3) : null;
    const mergedUv = hasUv ? new Float32Array(totalVertices * 2) : null;
    const mergedUv1 = hasUv1 ? new Float32Array(totalVertices * 2) : null;
    const mergedColor = hasAColor ? new Float32Array(totalVertices * 3) : null;
    const mergedBatchId = hasABatchId ? new Float32Array(totalVertices) : null;
    const mergedRect0 = hasAtlas ? new Float32Array(totalVertices * 4) : null;
    const mergedRect1 = hasAtlas ? new Float32Array(totalVertices * 4) : null;
    const mergedSecUv = hasAtlas ? new Float32Array(totalVertices * 2) : null;

    /** 逐顶点拷一个 n 分量的浮点属性；缺失时用 fallbackRect / 0 兜底 */
    const copyAttr = (
      dst: Float32Array,
      attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
      comp: number,
      vCount: number,
      vertexOffset: number,
      fallback?: (i: number, out: number[]) => void
    ) => {
      if (attr) {
        const src = attr.array as ArrayLike<number>;
        for (let i = 0; i < vCount; i++)
          for (let k = 0; k < comp; k++) dst[(vertexOffset + i) * comp + k] = src[i * comp + k] ?? 0;
        return;
      }
      for (let i = 0; i < vCount; i++) {
        const out: number[] = [];
        fallback ? fallback(i, out) : out.push(...new Array(comp).fill(0));
        for (let k = 0; k < comp; k++) dst[(vertexOffset + i) * comp + k] = out[k] ?? 0;
      }
    };

    const IndexArrayType = totalVertices > 65535 ? Uint32Array : Uint16Array;
    const mergedIndices = new IndexArrayType(totalIndices);

    let vertexOffset = 0;
    let indexOffset = 0;

    const tmpVec = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3();
    const geoByBatchId = new Map<number, GeoPackageEntry>();

    for (const c of candidates) {
      const g = c.cached.geometry;
      const vCount = g.attributes.position.count;
      const m = c.matrix;
      const hasTransform = m && !m.equals(IDENTITY);
      if (hasTransform && hasNormal) {
        normalMatrix.getNormalMatrix(m);
      }

      if (c.geo.pickInfo) {
        for (const entry of Object.values(c.geo.pickInfo)) {
          if (typeof entry.batchId === 'number' && entry.batchId >= 0) {
            geoByBatchId.set(entry.batchId, c.geo);
          }
        }
      }

      // 1. Position
      const posArr = g.attributes.position.array as ArrayLike<number>;
      for (let i = 0; i < vCount; i++) {
        const srcIdx = i * 3;
        const dstIdx = (vertexOffset + i) * 3;
        if (hasTransform) {
          tmpVec.set(posArr[srcIdx], posArr[srcIdx + 1], posArr[srcIdx + 2]).applyMatrix4(m);
          mergedPos[dstIdx] = tmpVec.x;
          mergedPos[dstIdx + 1] = tmpVec.y;
          mergedPos[dstIdx + 2] = tmpVec.z;
        } else {
          mergedPos[dstIdx] = posArr[srcIdx];
          mergedPos[dstIdx + 1] = posArr[srcIdx + 1];
          mergedPos[dstIdx + 2] = posArr[srcIdx + 2];
        }
      }

      // 2. Normal
      if (mergedNorm) {
        const normAttr = g.attributes.normal;
        if (normAttr) {
          const normArr = normAttr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            const srcIdx = i * 3;
            const dstIdx = (vertexOffset + i) * 3;
            if (hasTransform) {
              tmpVec
                .set(normArr[srcIdx], normArr[srcIdx + 1], normArr[srcIdx + 2])
                .applyMatrix3(normalMatrix)
                .normalize();
              mergedNorm[dstIdx] = tmpVec.x;
              mergedNorm[dstIdx + 1] = tmpVec.y;
              mergedNorm[dstIdx + 2] = tmpVec.z;
            } else {
              mergedNorm[dstIdx] = normArr[srcIdx];
              mergedNorm[dstIdx + 1] = normArr[srcIdx + 1];
              mergedNorm[dstIdx + 2] = normArr[srcIdx + 2];
            }
          }
        }
      }

      // 3. UV
      if (mergedUv) {
        const uvAttr = g.attributes.uv;
        if (uvAttr) {
          const uvArr = uvAttr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            mergedUv[(vertexOffset + i) * 2] = uvArr[i * 2];
            mergedUv[(vertexOffset + i) * 2 + 1] = uvArr[i * 2 + 1];
          }
        }
      }

      // 4. UV1
      if (mergedUv1) {
        const uv1Attr = g.attributes.uv1;
        if (uv1Attr) {
          const uvArr = uv1Attr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            mergedUv1[(vertexOffset + i) * 2] = uvArr[i * 2];
            mergedUv1[(vertexOffset + i) * 2 + 1] = uvArr[i * 2 + 1];
          }
        }
      }

      // 5. aColor
      if (mergedColor) {
        const colAttr = g.attributes.aColor;
        if (colAttr) {
          const colArr = colAttr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            mergedColor[(vertexOffset + i) * 3] = colArr[i * 3];
            mergedColor[(vertexOffset + i) * 3 + 1] = colArr[i * 3 + 1];
            mergedColor[(vertexOffset + i) * 3 + 2] = colArr[i * 3 + 2];
          }
        } else {
          for (let i = 0; i < vCount; i++) {
            mergedColor[(vertexOffset + i) * 3] = 1;
            mergedColor[(vertexOffset + i) * 3 + 1] = 1;
            mergedColor[(vertexOffset + i) * 3 + 2] = 1;
          }
        }
      }

      // 6. aBatchId
      if (mergedBatchId) {
        const bAttr = g.attributes.aBatchId;
        if (bAttr) {
          const bArr = bAttr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            mergedBatchId[vertexOffset + i] = bArr[i];
          }
        } else {
          for (let i = 0; i < vCount; i++) {
            mergedBatchId[vertexOffset + i] = -1;
          }
        }
      }

      // 7. 图集矩形（S3MBLOCK）
      if (mergedRect0) {
        copyAttr(mergedRect0, g.attributes.aAtlasRect, 4, vCount, vertexOffset, (_i, out) => out.push(0, 0, 0, 0));
        copyAttr(mergedRect1!, g.attributes.aAtlasRect1, 4, vCount, vertexOffset, (_i, out) => out.push(0, 0, 0, 0));
        copyAttr(mergedSecUv!, g.attributes.aSecUv, 2, vCount, vertexOffset);
      }

      // 8. Indices
      if (g.index) {
        const idxArr = g.index.array as ArrayLike<number>;
        const iCount = g.index.count;
        for (let k = 0; k < iCount; k++) {
          mergedIndices[indexOffset + k] = idxArr[k] + vertexOffset;
        }
        indexOffset += iCount;
      } else {
        for (let k = 0; k < vCount; k++) {
          mergedIndices[indexOffset + k] = k + vertexOffset;
        }
        indexOffset += vCount;
      }

      vertexOffset += vCount;
    }

    const mergedGeo = new THREE.BufferGeometry();
    mergedGeo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
    if (mergedNorm) mergedGeo.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
    if (mergedUv) mergedGeo.setAttribute('uv', new THREE.BufferAttribute(mergedUv, 2));
    if (mergedUv1) mergedGeo.setAttribute('uv1', new THREE.BufferAttribute(mergedUv1, 2));
    if (mergedColor) mergedGeo.setAttribute('aColor', new THREE.BufferAttribute(mergedColor, 3));
    if (mergedBatchId) mergedGeo.setAttribute('aBatchId', new THREE.BufferAttribute(mergedBatchId, 1));
    if (mergedRect0) {
      mergedGeo.setAttribute('aAtlasRect', new THREE.BufferAttribute(mergedRect0, 4));
      mergedGeo.setAttribute('aAtlasRect1', new THREE.BufferAttribute(mergedRect1!, 4));
      mergedGeo.setAttribute('aSecUv', new THREE.BufferAttribute(mergedSecUv!, 2));
    }
    mergedGeo.setIndex(new THREE.BufferAttribute(mergedIndices, 1));
    mergedGeo.computeBoundingBox();
    mergedGeo.computeBoundingSphere();

    const mesh = new THREE.Mesh(mergedGeo, material);
    mesh.userData.skeletonName = candidates[0].name;
    mesh.userData.geoRef = candidates[0].geo;
    mesh.userData.tileRef = tileRef;
    mesh.userData.primitiveType = 4;
    mesh.userData.isBatched = true;
    mesh.userData.batchedCount = candidates.length;
    if (geoByBatchId.size > 0) {
      mesh.userData.geoByBatchId = geoByBatchId;
    }

    return mesh;
  };

  const placeObject = (
    cached: CachedGeometry,
    name: string,
    geo: GeoPackageEntry,
    matrix: THREE.Matrix4 | null
  ): THREE.Object3D => {
    const { geometry, pack } = cached;
    const material = makeMaterial(pack.passNames?.[0], !!geometry.getAttribute('aAtlasRect'));
    let object: THREE.Mesh | THREE.InstancedMesh;

    const info = skeletonInfo.get(name);
    const vp = geo.vertexPackage;

    // 棱线包：线段，不是三角面。默认隐藏，等 setEdges(true) 再显示
    if (isLinePrimitive(pack.primitiveType)) {
      const lines = new THREE.LineSegments(geometry, edgeLineMaterial);
      lines.visible = options.edges === true;
      lines.renderOrder = 2;
      lines.raycast = () => {};
      lines.userData.isEdgeLines = true;
      lines.userData.skeletonName = name;
      if (matrix && !matrix.equals(IDENTITY)) {
        matrix.decompose(lines.position, lines.quaternion, lines.scale);
      }
      group.add(lines);
      objects.push(lines);
      group.userData.hasNativeEdges = true;
      stats.edgeLines++;
      return lines;
    }

    // 点云包：顶点即点，按 THREE.Points 渲染。索引只是点序号，直接走 drawRange。
    if (isPointPrimitive(pack.primitiveType)) {
      // PointsMaterial 的顶点色读内置 'color' 槽位，与 aColor 共享同一份 buffer
      if (!geometry.getAttribute('color')) {
        geometry.setAttribute('color', geometry.getAttribute('aColor')!);
      }
      const points = new THREE.Points(geometry, getPointCloudMaterial());
      // 点云不是 Mesh：viewer 的样式 / 拾取 / 卸载链路都靠这个标记放行
      points.userData.isPointCloud = true;
      points.userData.skeletonName = name;
      points.userData.geoRef = geo;
      points.userData.tileRef = tile;
      points.userData.primitiveType = pack.primitiveType;
      if (matrix && !matrix.equals(IDENTITY)) {
        matrix.decompose(points.position, points.quaternion, points.scale);
      }
      group.add(points);
      objects.push(points);
      stats.meshes++;
      return points;
    }

    if (info?.instanced && vp.instanceBuffer && vp.instanceCount > 0) {
      // 逐实例的两条属性：
      //   aInstanceBatchId —— 单体控制位，着色器靠它查状态纹理（改色 / 隐藏 / 抬高）
      //   aInstanceIndex   —— 实例序号，拾取时编码进颜色，CPU 侧再映射回 SMID
      // 逐顶点属性 aBatchId 在这里没用（顶点数 ≠ 实例数），gpu 上按实例取值只能靠 instanced attribute。
      if (!geometry.getAttribute('aInstanceBatchId')) {
        const ids = vp.instanceBatchIds;
        const batchIds =
          ids && ids.length === vp.instanceCount ? ids.slice() : new Float32Array(vp.instanceCount).fill(-1);
        geometry.setAttribute('aInstanceBatchId', new THREE.InstancedBufferAttribute(batchIds, 1));
        const index = new Float32Array(vp.instanceCount);
        for (let i = 0; i < index.length; i++) index[i] = i;
        geometry.setAttribute('aInstanceIndex', new THREE.InstancedBufferAttribute(index, 1));
      }

      const instanced = new THREE.InstancedMesh(geometry, material, vp.instanceCount);
      instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const m4 = new THREE.Matrix4();
      const color = new THREE.Color();
      const stride = vp.instanceMode;
      const f32 = new Float32Array(vp.instanceBuffer.buffer, vp.instanceBuffer.byteOffset, vp.instanceCount * stride);
      for (let i = 0; i < vp.instanceCount; i++) {
        const o = i * stride;
        // S3M 实例矩阵按 3x4 仿射矩阵（行主序）连续存储 12 个 float：
        //   Row 0: [r00, r01, r02, tx]
        //   Row 1: [r10, r11, r12, ty]
        //   Row 2: [r20, r21, r22, tz]
        //   Row 3: [0, 0, 0, 1] 隐式补齐
        // 后续紧随 4 个 float 的 RGBA 颜色（stride >= 16）及可选 uint32 的 SMID（stride == 17）。
        // 若用 fromArray 直接按列主序填充 Matrix4，会将平移分量塞进底部的投影行 (w)，
        // 造成严重的透视奇点畸变（所有顶点拉扯成放射状尖锥）。
        m4.set(
          f32[o + 0], f32[o + 1], f32[o + 2], f32[o + 3],
          f32[o + 4], f32[o + 5], f32[o + 6], f32[o + 7],
          f32[o + 8], f32[o + 9], f32[o + 10], f32[o + 11],
          0, 0, 0, 1
        );
        instanced.setMatrixAt(i, m4);
        if (stride >= 16) {
          const r = f32[o + 12];
          const g = f32[o + 13];
          const b = f32[o + 14];
          if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
            color.setRGB(r, g, b);
            instanced.setColorAt(i, color);
          }
        }
      }
      instanced.instanceMatrix.needsUpdate = true;
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
      instanced.frustumCulled = false;
      stats.instanced++;
      object = instanced;
    } else {
      object = new THREE.Mesh(geometry, material);
    }

    // 用 decompose 写回 position/quaternion/scale，而不是 matrix.copy + matrixAutoUpdate=false。
    // 后者在 three 的 updateMatrixWorld 链路里会被重算成单位矩阵，结果就是模型偏移几百米。
    if (matrix && !matrix.equals(IDENTITY)) {
      matrix.decompose(object.position, object.quaternion, object.scale);
    }

    object.userData.skeletonName = name;
    object.userData.geoRef = geo;
    object.userData.tileRef = tile;
    object.userData.primitiveType = pack.primitiveType;
    group.add(object);
    objects.push(object);

    stats.meshes++;
    if (pack.primitiveType === 4) stats.triangles += (pack.indexCount || 0) / 3;
    return object;
  };

  // 4) 按 Geode 摆放：一个骨架可能被多个 geode 以不同矩阵引用
  let placed = 0;
  for (const pageLod of tile.groupNode?.pageLods ?? []) {
    for (const geode of pageLod.geodes ?? []) {
      const m = geode.matrix;
      // S3M 的 matrix4d 是列主序（OpenGL 约定），平移在第 12/13/14 位，
      // 与 three 的 Matrix4.elements 布局一致 —— 必须用 fromArray 直接搬。
      // 用 set() 按行主序喂进去等于转置，平移会被塞进投影行，模型直接飞上天。
      const matrix = m && m.length === 16 ? new THREE.Matrix4().fromArray(m) : null;

      for (const name of geode.skeletonNames ?? []) {
        const info = skeletonInfo.get(name);
        if (!info) continue;
        const geo = tile.geoPackage[name];
        if (!geo) continue;
        const vp = geo.vertexPackage;
        for (let pi = 0; pi < info.indexPackages.length; pi++) {
          const cached = geoCache.get(`${name}|${pi}`);
          if (!cached) continue;

          // 棱线包或实例化网格：保持单独摆放
          if (
            isLinePrimitive(cached.pack.primitiveType) ||
            (info.instanced && vp.instanceBuffer && vp.instanceCount > 0)
          ) {
            placeObject(cached, name, geo, matrix);
            placed++;
            continue;
          }

          // 普通三角面网格：若开启合批，按材质进行分组收集
          if (options.batching !== false && cached.pack.primitiveType === 4) {
            const matKey = cached.pack.passNames?.[0] ?? '__default__';
            let list = batchGroups.get(matKey);
            if (!list) {
              list = [];
              batchGroups.set(matKey, list);
            }
            list.push({ cached, name, geo, matrix });
            placed++;
            continue;
          }

          placeObject(cached, name, geo, matrix);
          placed++;
        }
      }
    }
  }

  // 兜底：没有被任何 geode 引用的骨架，按单位矩阵渲染，避免整块消失
  if (placed === 0) {
    for (const [name, info] of skeletonInfo) {
      const geo = tile.geoPackage[name];
      if (!geo) continue;
      const vp = geo.vertexPackage;
      for (let pi = 0; pi < info.indexPackages.length; pi++) {
        const cached = geoCache.get(`${name}|${pi}`);
        if (!cached) continue;

        if (
          isLinePrimitive(cached.pack.primitiveType) ||
          (info.instanced && vp.instanceBuffer && vp.instanceCount > 0)
        ) {
          placeObject(cached, name, geo, null);
          continue;
        }

        if (options.batching !== false && cached.pack.primitiveType === 4) {
          const matKey = cached.pack.passNames?.[0] ?? '__default__';
          let list = batchGroups.get(matKey);
          if (!list) {
            list = [];
            batchGroups.set(matKey, list);
          }
          list.push({ cached, name, geo, matrix: null });
          continue;
        }

        placeObject(cached, name, geo, null);
      }
    }
  }

  // 执行同材质几何合批
  if (batchGroups.size > 0) {
    for (const [matKey, list] of batchGroups) {
      stats.originalMeshes = (stats.originalMeshes ?? 0) + list.length;
      if (list.length === 1) {
        placeObject(list[0].cached, list[0].name, list[0].geo, list[0].matrix);
      } else {
        const hasAtlasRect = !!list[0].cached.geometry.getAttribute('aAtlasRect');
        const material = makeMaterial(matKey === '__default__' ? undefined : matKey, hasAtlasRect);
        const batchedMesh = mergeBatchGeometries(list, material, tile);
        group.add(batchedMesh);
        objects.push(batchedMesh);
        stats.meshes++;
        for (const item of list) {
          stats.triangles += (item.cached.pack.indexCount || 0) / 3;
        }
      }
    }
  }

  if (!group.children.length) stats.skipped.push('tile 无可用几何');

  return { group, stats, objects };
}
