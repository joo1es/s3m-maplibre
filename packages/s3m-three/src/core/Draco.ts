/**
 * S3M v3 Draco 几何压缩（Skeleton 的 Draco 分支）
 *
 * 与 MeshOpt 一样，这里的布局不是照规范写的 —— 规范里的 Draco 分支描述和实际数据
 * 对不上，字段顺序是从真实瓦片逐字节标定出来的（两个瓦片 5 个骨架完全一致，
 * 且用 payloadSize / dracoSize / "DRACO" magic / skeletonStreamSize 四重自校验）。
 *
 * 二进制布局（v3.01 实测，偏移以 tag 字段之后为 0）：
 * ```
 * u32  payloadSize          // 覆盖 [本字段之后 .. 条目末尾 OBB 之前]
 * u32  unknown = 32         // 实测恒 32，语义未知
 * i32  posUniqueId          // draco 属性 uid，POSITION；-1 = 无
 * i32  normalUniqueId       // -1 = 无
 * i32  colorUniqueId        // -1 = 无
 * i32  secondColorUniqueId
 * u32  texCoordCount        // 自定义属性个数，实测 3
 * i32  texCoordUniqueIds[texCoordCount]   // 各自定义属性的 draco uid
 * u32  vertexAttrCount      // 实测恒 0
 * u32  dracoSize
 * byte draco[dracoSize]     // 标准 draco 比特流，开头 5 字节是 "DRACO" magic
 * pad4
 * String descript           // {"PointCloudClassCode":2,"PointCloudIntensity":1,"VertexWeight":0}
 * pad4
 * f64  obb[12]              // ← 由调用方 parseSkeletonEntries 统一按条目末尾读
 * ```
 *
 * descript 的 value 是「自定义属性在 texCoordUniqueIds 里的下标」：
 * VertexWeight→uid2(float 高度)、PointCloudIntensity→uid3、PointCloudClassCode→uid4。
 * uid1 没被 descript 引用（实测是 0~29 的 uint32，用途不明）。
 *
 * 官方 SDK 的 `parseDracoSkeleton` 字段顺序不一样（多了 materialCount，且
 * `version === 3` 的判定对 3.01 瓦片不成立），实际解析不了这个服务，所以以实测为准。
 */
import type { BinaryReader } from './BinaryReader.js';
import type { AttrDType, IndexPackage, VertexPackage } from './types.js';
import type { DracoMesh, DracoModule, DracoPointAttribute, DracoPointCloud } from '../vendor/draco_decoder.module.js';

/* ------------------------------------------------------------ draco 枚举（本地副本） */

/** draco::GeometryAttribute::Type */
const ATTR_POSITION = 0;
const ATTR_NORMAL = 1;
const ATTR_COLOR = 2;

/** draco::DataType（DT_INVALID = 0 占位） */
const DT_UINT8 = 2;
const DT_UINT16 = 4;
const DT_UINT32 = 6;
const DT_FLOAT32 = 9;

/** draco::EncodedGeometryType */
const GEOM_POINT_CLOUD = 0;
const GEOM_TRIANGULAR_MESH = 1;

const DRACO_MAGIC = 'DRACO';

/** primitiveType = 1：点云包（渲染层据此走 THREE.Points） */
const POINT_PRIMITIVE = 1;

/** primitiveType = 4：三角网格包（渲染层据此走 THREE.Mesh，对应 gl.TRIANGLES） */
const TRIANGLE_PRIMITIVE = 4;

/** 单个 skeleton 的点数上限，防头读错时开出天文数字的缓冲 */
const MAX_POINTS = 64 * 1024 * 1024;

/* ------------------------------------------------------------ 解码器 */

let decoderPromise: Promise<DracoModule> | null = null;

/**
 * 懒加载 Draco 解码器（wasm 内联，约 266KB）。
 * 只有真正遇到 Draco 瓦片时才会编译，标准 / MeshOpt 瓦片不受影响。
 */
export function loadDracoDecoder(): Promise<DracoModule> {
  if (!decoderPromise) {
    decoderPromise = import('../vendor/draco_decoder.module.js').then((mod) => mod.default());
  }
  return decoderPromise;
}

/* ------------------------------------------------------------ 属性取值 */

/** embind 数组包装：只暴露逐个取值 */
interface DracoScalarArray {
  size(): number;
  GetValue(index: number): number;
}

/**
 * 把 draco 的一个属性读成 JS 数组。
 *
 * 不能直接把 JS TypedArray 传给 `GetAttribute*ForAllPoints`：embind 会把期望
 * 对象的参数原样透传，TypedArray 没有 `.ptr` 就变成 undefined，wasm 侧写不进
 * 数据，函数却照样返回 true（实测取出来全是 0）。只能逐个 GetValue ——
 * 6 千点 × 3 分量实测 3.5ms，可以接受。
 *
 * 量化 / 八面体变换由 draco 解码时自动还原，这里拿到的是最终值。
 */
function readAttribute(
  draco: DracoModule,
  decoder: InstanceType<DracoModule['Decoder']>,
  geometry: DracoPointCloud,
  attr: DracoPointAttribute
): Float32Array | Uint8Array | Uint16Array | Uint32Array | null {
  const comps = Math.max(1, attr.num_components());
  const n = geometry.num_points() * comps;
  let src: DracoScalarArray;

  switch (attr.data_type()) {
    case DT_FLOAT32:
      src = new draco.DracoFloat32Array();
      if (!decoder.GetAttributeFloatForAllPoints(geometry, attr, src as never)) return null;
      break;
    case DT_UINT8:
      src = new draco.DracoUInt8Array();
      if (!decoder.GetAttributeUInt8ForAllPoints(geometry, attr, src as never)) return null;
      break;
    case DT_UINT16:
      src = new draco.DracoUInt16Array();
      if (!decoder.GetAttributeUInt16ForAllPoints(geometry, attr, src as never)) return null;
      break;
    case DT_UINT32:
      src = new draco.DracoUInt32Array();
      if (!decoder.GetAttributeUInt32ForAllPoints(geometry, attr, src as never)) return null;
      break;
    default:
      // int8/int16/int32/float64：真实点云里没见过，对应取值接口也存在，
      // 需要时按上面同款补一行即可
      return null;
  }

  const size = src.size();
  const isFloat = attr.data_type() === DT_FLOAT32;
  let out: Float32Array | Uint8Array | Uint16Array | Uint32Array;
  if (isFloat) out = new Float32Array(n);
  else if (attr.data_type() === DT_UINT16) out = new Uint16Array(n);
  else if (attr.data_type() === DT_UINT32) out = new Uint32Array(n);
  else out = new Uint8Array(n);
  for (let i = 0; i < size && i < n; i++) out[i] = src.GetValue(i);
  // Draco*Array 是 new 出来的，占 wasm 堆；不解引用会一直涨
  draco.destroy(src);
  return out;
}

/* ------------------------------------------------------------ 分类着色 */

/**
 * LAS / ASPRS 标准分类色带（1~18，其余走兜底灰）。
 *
 * 点云分类服务（3D-PointCloudClassific 这类）本身不带顶点色，颜色全靠分类码。
 * 渲染层的点云路径只认 `color` 属性，所以这里直接把分类码烘成 RGBA8 顶点色，
 * 下游零改动。实测该服务的分类分布是 {5: 高植被, 14: 导线, 15: 输电塔, 18: 高噪声}。
 */
const CLASS_COLORS: Array<[number, number, number]> = [
  [190, 190, 190], // 0 未分类
  [166, 166, 166], // 1 未分类（旧）
  [139, 119, 101], // 2 地面
  [35, 190, 35], // 3 低植被
  [60, 179, 60], // 4 中植被
  [30, 160, 30], // 5 高植被
  [255, 170, 60], // 6 建筑
  [255, 110, 190], // 7 低噪点
  [190, 190, 190], // 8 关键点
  [60, 120, 255], // 9 水面
  [255, 235, 80], // 10 铁轨
  [255, 200, 120], // 11 路面
  [200, 120, 255], // 12 保留
  [255, 120, 255], // 13 线缆
  [255, 235, 60], // 14 导线
  [255, 200, 40], // 15 输电塔
  [120, 200, 255], // 16 桥面
  [200, 160, 255], // 17 桥墩
  [255, 60, 60], // 18 高噪声
];

/* ------------------------------------------------------------ 骨架 */

/**
 * 读取一个 Draco 压缩的 Skeleton。
 *
 * 点云没有索引包（顶点即点），但渲染层是「有 indexPackages 才建几何」，
 * 所以这里合成一个 primitiveType = 1 的空点包，让下游走 THREE.Points 路径。
 *
 * 包围盒不在这里读：调用方 parseSkeletonEntries 统一按 skeletonStreamSize
 * 定位到条目末尾的 OBB，各分支行为保持一致。
 */
export async function parseDracoGeometry(r: BinaryReader, vp: VertexPackage): Promise<IndexPackage[]> {
  const draco = await loadDracoDecoder();

  /* ---- 1. 容器头 ---- */

  const payloadSize = r.u32();
  const payloadStart = r.offset;
  r.u32(); // 实测恒 32，语义未知

  const posUniqueId = r.i32();
  const normalUniqueId = r.i32();
  const colorUniqueId = r.i32();
  r.i32(); // secondColorUniqueId

  const texCoordCount = r.u32();
  if (texCoordCount > 16) {
    throw new Error(`[s3m] Draco 自定义属性个数异常：texCoordCount=${texCoordCount}`);
  }
  const texCoordUniqueIds: number[] = [];
  for (let i = 0; i < texCoordCount; i++) texCoordUniqueIds.push(r.i32());

  r.u32(); // vertexAttrCount，实测恒 0

  const dracoSize = r.u32();
  if (dracoSize < 16 || dracoSize > r.remaining) {
    throw new Error(`[s3m] Draco 流长度异常：dracoSize=${dracoSize}，剩余 ${r.remaining} 字节`);
  }

  const data = r.bytes(dracoSize);
  // 头读错时这里必然对不上，比让 wasm 报一句看不懂的错有用
  if (String.fromCharCode(...data.subarray(0, 5)) !== DRACO_MAGIC) {
    throw new Error('[s3m] Draco 流缺少 "DRACO" magic，容器头解析错位');
  }
  r.align4();

  const descript = r.string();
  r.align4();

  // 自定义属性 uid → 语义名：{"PointCloudClassCode":2,...} 的 value 是 texCoordUniqueIds 下标
  const customNames = new Map<number, string>();
  try {
    const map = JSON.parse(descript) as Record<string, number>;
    for (const [name, idx] of Object.entries(map)) {
      const uid = texCoordUniqueIds[idx];
      if (uid !== undefined) customNames.set(uid, name);
    }
  } catch {
    // descript 不是 JSON 也不影响渲染，只是自定义属性没名字
  }
  vp.customVertexAttribute = descript ? safeJson(descript) : undefined;

  if (payloadSize > 0) {
    const consumed = r.offset - payloadStart;
    if (consumed !== payloadSize) {
      // 条目末尾由 streamSize 兜着，错位不会波及后面的骨架，只提示
      console.warn(`[s3m] Draco 载荷长度不符：声明 ${payloadSize}，实读 ${consumed}`);
    }
  }

  /* ---- 2. 解码 ---- */

  const decoder = new draco.Decoder();
  const geomType = decoder.GetEncodedGeometryType(data);

  if (geomType === GEOM_TRIANGULAR_MESH) {
    // 三角网格分支：draco mesh 内部自带面索引，不需要容器里的 IndexPackage
    // 官方 S3ModelParser 对 Draco 分支的索引包解析阶段是空操作（see Issue #5）
    const mesh = new draco.Mesh();
    try {
      return decodeDracoMesh(draco, decoder, mesh, data, vp, posUniqueId, normalUniqueId, colorUniqueId);
    } finally {
      try { draco.destroy(decoder); draco.destroy(mesh); } catch { /* ignore */ }
    }
  }

  // 点云分支（GEOM_POINT_CLOUD）或其他未知类型
  const geometry = new draco.PointCloud();
  try {
    if (geomType !== GEOM_POINT_CLOUD) {
      // 未知几何类型：warn 并降级为空包，避免整层崩溃
      console.warn(`[s3m] Draco 未知几何类型 ${geomType}，跳过该骨架`);
      vp.verticesCount = 0;
      return [pointPack()];
    }

    const status = decoder.DecodeArrayToPointCloud(data, data.length, geometry);
    if (!status.ok()) throw new Error(`[s3m] Draco 解码失败：${status.error_msg()}`);

    const numPoints = geometry.num_points();
    if (!Number.isInteger(numPoints) || numPoints < 0 || numPoints > MAX_POINTS) {
      throw new Error(`[s3m] Draco 点数异常：${numPoints}`);
    }
    if (numPoints === 0) {
      vp.verticesCount = 0;
      return [pointPack()];
    }

    /* ---- 3. 属性装配 ---- */

    let classCode: Uint8Array | null = null;

    for (let i = 0; i < geometry.num_attributes(); i++) {
      const attr = decoder.GetAttribute(geometry, i);
      const uid = attr.unique_id();
      const comps = Math.max(1, attr.num_components());

      if (uid === posUniqueId || attr.attribute_type() === ATTR_POSITION) {
        if (attr.data_type() !== DT_FLOAT32) {
          throw new Error(`[s3m] Draco 位置属性不是 float32（dt=${attr.data_type()}）`);
        }
        const raw = readAttribute(draco, decoder, geometry, attr) as Float32Array | null;
        if (!raw) throw new Error('[s3m] Draco 位置属性读取失败');
        // draco 偶尔按 3 分量以上的格式存位置，取前 3 个
        const out = new Float32Array(numPoints * 3);
        for (let p = 0; p < numPoints; p++) {
          out[p * 3] = raw[p * comps] ?? 0;
          out[p * 3 + 1] = raw[p * comps + 1] ?? 0;
          out[p * 3 + 2] = raw[p * comps + 2] ?? 0;
        }
        pushAttr(vp, 'position', new Uint8Array(out.buffer), 3, 12, 0, undefined, 'f32');
        continue;
      }

      if (uid === colorUniqueId || attr.attribute_type() === ATTR_COLOR) {
        const raw = readAttribute(draco, decoder, geometry, attr);
        if (raw) {
          const out = new Uint8Array(numPoints * 4);
          const isFloat = raw instanceof Float32Array;
          for (let p = 0; p < numPoints; p++) {
            const o = p * comps;
            if (isFloat) {
              out[p * 4] = clamp255(raw[o] ?? 1);
              out[p * 4 + 1] = clamp255(raw[o + 1] ?? 1);
              out[p * 4 + 2] = clamp255(raw[o + 2] ?? 1);
            } else {
              out[p * 4] = raw[o] ?? 255;
              out[p * 4 + 1] = raw[o + 1] ?? 255;
              out[p * 4 + 2] = raw[o + 2] ?? 255;
            }
            out[p * 4 + 3] = comps >= 4 && !isFloat ? (raw[o + 3] ?? 255) : 255;
          }
          pushAttr(vp, 'color', out, 4, 4, 0, undefined, 'u8');
        }
        continue;
      }

      if (uid === normalUniqueId || attr.attribute_type() === ATTR_NORMAL) {
        // 点云不需要法线，八面体编码由 draco 解码时自动还原，这里直接跳过
        continue;
      }

      // 自定义属性：只挑分类码，其余（高度 / 强度）渲染层用不上
      const name = customNames.get(uid);
      if (name === 'PointCloudClassCode' && comps === 1) {
        const raw = readAttribute(draco, decoder, geometry, attr);
        if (raw && !(raw instanceof Float32Array)) {
          classCode = new Uint8Array(numPoints);
          for (let p = 0; p < numPoints; p++) classCode[p] = raw[p] ?? 0;
        }
      }
    }

    if (vp.attrLocation.position === undefined) {
      throw new Error('[s3m] Draco 点云缺少 position 属性');
    }

    // 数据自带顶点色优先；没有色但有分类码时，用分类色带烘一份 RGBA8
    if (vp.attrLocation.color === undefined && classCode) {
      const out = new Uint8Array(numPoints * 4);
      for (let p = 0; p < numPoints; p++) {
        const c = CLASS_COLORS[classCode[p]] ?? CLASS_COLORS[0];
        out[p * 4] = c[0];
        out[p * 4 + 1] = c[1];
        out[p * 4 + 2] = c[2];
        out[p * 4 + 3] = 255;
      }
      pushAttr(vp, 'color', out, 4, 4, 0, undefined, 'u8');
    }

    vp.verticesCount = numPoints;
    return [pointPack()];
  } finally {
    // embind 对象占的是 wasm 堆，不显式释放会一直涨
    try {
      draco.destroy(decoder);
      draco.destroy(geometry);
    } catch {
      // 某些构建没有 destroy，忽略
    }
  }
}

/* ------------------------------------------------------------ 工具 */

/** 点云包：索引只是点序号，交给渲染层走 drawRange */
function pointPack(): IndexPackage {
  return {
    indexCount: 0,
    indexType: 0,
    useIndex: 0,
    primitiveType: POINT_PRIMITIVE,
    indices: null,
    passNames: [],
  };
}

/**
 * 解码 Draco TRIANGULAR_MESH 几何体，填充 VertexPackage 并返回带索引的 IndexPackage。
 *
 * 按官方 S3MDracoDecode.js 逻辑（Issue #5 调研）：
 *   - DecodeArrayToMesh → num_faces → 逐面 GetFaceFromMesh → 填入索引缓冲
 *   - primitiveType = TRIANGLE_PRIMITIVE（4），让渲染层走 THREE.Mesh
 *   - 容器头（posUniqueId/normalUniqueId/colorUniqueId）与点云共用，直接复用属性装配代码
 *
 * 调用方负责 destroy(decoder) 和 destroy(mesh)。
 */
function decodeDracoMesh(
  draco: DracoModule,
  decoder: InstanceType<DracoModule['Decoder']>,
  mesh: DracoMesh,
  data: Uint8Array,
  vp: VertexPackage,
  posUniqueId: number,
  normalUniqueId: number,
  colorUniqueId: number,
): IndexPackage[] {
  const status = decoder.DecodeArrayToMesh(data, data.length, mesh);
  if (!status.ok()) throw new Error(`[s3m] Draco mesh 解码失败：${status.error_msg()}`);

  const numPoints = mesh.num_points();
  if (!Number.isInteger(numPoints) || numPoints < 0 || numPoints > MAX_POINTS) {
    throw new Error(`[s3m] Draco mesh 顶点数异常：${numPoints}`);
  }
  const numFaces = mesh.num_faces();

  if (numPoints === 0 || numFaces === 0) {
    vp.verticesCount = 0;
    return [meshPack(new Uint8Array(0), 0, 0)];
  }

  /* ---- 属性装配（与点云分支共用逻辑，但三角网格有法线） ---- */

  for (let i = 0; i < mesh.num_attributes(); i++) {
    const attr = decoder.GetAttribute(mesh, i);
    const uid = attr.unique_id();
    const comps = Math.max(1, attr.num_components());

    if (uid === posUniqueId || attr.attribute_type() === ATTR_POSITION) {
      if (attr.data_type() !== DT_FLOAT32) {
        throw new Error(`[s3m] Draco mesh 位置属性不是 float32（dt=${attr.data_type()}）`);
      }
      const raw = readAttribute(draco, decoder, mesh, attr) as Float32Array | null;
      if (!raw) throw new Error('[s3m] Draco mesh 位置属性读取失败');
      const out = new Float32Array(numPoints * 3);
      for (let p = 0; p < numPoints; p++) {
        out[p * 3] = raw[p * comps] ?? 0;
        out[p * 3 + 1] = raw[p * comps + 1] ?? 0;
        out[p * 3 + 2] = raw[p * comps + 2] ?? 0;
      }
      pushAttr(vp, 'position', new Uint8Array(out.buffer), 3, 12, 0, undefined, 'f32');
      continue;
    }

    if (uid === normalUniqueId || attr.attribute_type() === ATTR_NORMAL) {
      if (attr.data_type() === DT_FLOAT32) {
        const raw = readAttribute(draco, decoder, mesh, attr) as Float32Array | null;
        if (raw) {
          // 法线量化由 draco 解码时自动还原为 float32
          const out = new Float32Array(numPoints * 3);
          for (let p = 0; p < numPoints; p++) {
            out[p * 3] = raw[p * comps] ?? 0;
            out[p * 3 + 1] = raw[p * comps + 1] ?? 0;
            out[p * 3 + 2] = raw[p * comps + 2] ?? 0;
          }
          pushAttr(vp, 'normal', new Uint8Array(out.buffer), 3, 12, 0, undefined, 'f32');
        }
      }
      continue;
    }

    if (uid === colorUniqueId || attr.attribute_type() === ATTR_COLOR) {
      const raw = readAttribute(draco, decoder, mesh, attr);
      if (raw) {
        const out = new Uint8Array(numPoints * 4);
        const isFloat = raw instanceof Float32Array;
        for (let p = 0; p < numPoints; p++) {
          const o = p * comps;
          if (isFloat) {
            out[p * 4] = clamp255(raw[o] ?? 1);
            out[p * 4 + 1] = clamp255(raw[o + 1] ?? 1);
            out[p * 4 + 2] = clamp255(raw[o + 2] ?? 1);
          } else {
            out[p * 4] = raw[o] ?? 255;
            out[p * 4 + 1] = raw[o + 1] ?? 255;
            out[p * 4 + 2] = raw[o + 2] ?? 255;
          }
          out[p * 4 + 3] = comps >= 4 && !isFloat ? (raw[o + 3] ?? 255) : 255;
        }
        pushAttr(vp, 'color', out, 4, 4, 0, undefined, 'u8');
      }
      continue;
    }
    // 其余属性（texCoord 等）：暂不处理，等真实瓦片来后按需补齐
  }

  if (vp.attrLocation.position === undefined) {
    throw new Error('[s3m] Draco mesh 缺少 position 属性');
  }

  vp.verticesCount = numPoints;

  /* ---- 三角面索引构建（按官方逻辑：numPoints <= 65535 用 U16，否则 U32） ---- */
  const useU16 = numPoints <= 65535;
  const indices = useU16
    ? new Uint16Array(numFaces * 3)
    : new Uint32Array(numFaces * 3);

  const face = new draco.DracoInt32Array();
  try {
    let n = 0;
    for (let f = 0; f < numFaces; f++) {
      decoder.GetFaceFromMesh(mesh, f, face);
      indices[n++] = face.GetValue(0);
      indices[n++] = face.GetValue(1);
      indices[n++] = face.GetValue(2);
    }
  } finally {
    draco.destroy(face);
  }

  return [meshPack(new Uint8Array(indices.buffer), numFaces * 3, useU16 ? 0 : 1)];
}

/**
 * 三角网格索引包。
 *
 * @param indicesBytes - Uint16Array 或 Uint32Array 的字节视图
 * @param indexCount   - 索引总数（numFaces × 3）
 * @param indexType    - 0 = Uint16, 1 = Uint32（与 IndexPackage.indexType 约定一致）
 */
function meshPack(indicesBytes: Uint8Array, indexCount: number, indexType: number): IndexPackage {
  return {
    indexCount,
    indexType,
    useIndex: 1,
    primitiveType: TRIANGLE_PRIMITIVE,
    indices: indexCount > 0 ? indicesBytes : null,
    passNames: [],
  };
}

function pushAttr(
  vp: VertexPackage,
  semantic: string,
  data: Uint8Array,
  components: number,
  stride: number,
  offset = 0,
  divisor?: number,
  dtype: AttrDType = 'f32'
): void {
  vp.attrLocation[semantic] = vp.vertexAttributes.length;
  vp.vertexAttributes.push({
    semantic,
    data,
    components,
    stride,
    offsetInBytes: offset,
    divisor,
    dtype,
  });
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
