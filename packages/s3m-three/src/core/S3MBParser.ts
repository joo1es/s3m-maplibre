/**
 * S3MB 瓦片解析器（S3M 1.0 / 2.0 / 3.0）
 *
 * 实现依据：SuperMap/s3m-spec 官方 S3M_SDK/S3M_JS/S3M_module/S3MParser/S3ModelParser.js
 * （Apache-2.0）+ Specification/S3MB/S3MBBinary.md。
 *
 * 与官方实现的差异：
 *   1. 不依赖 Cesium —— 输出纯数据对象，几何上传交给渲染层。
 *   2. 修复了官方 v3 非压缩分支把整个 ArrayBuffer（含文件头）当数据流的缺陷。
 *   3. Draco 点云 / MeshOpt 几何压缩都用内联 wasm 解码器还原，与标准骨架同路输出。
 */
import { BinaryReader } from './BinaryReader.js';
import { parseDracoGeometry } from './Draco.js';
import { parseMeshOptGeometry } from './MeshOpt.js';
import { isS3M1Buffer, parseS3M1 } from './S3M1Parser.js';
import type { DegradationKind } from './degradations.js';
import type {
  AttrDType,
  BoundingBox,
  GeoPackageEntry,
  Geode,
  GroupNode,
  IndexPackage,
  PageLOD,
  ParsedTile,
  PickEntry,
  S3MTexture,
  Vec3,
  VertexAttribute,
  VertexPackage,
} from './types.js';

export const S3M_VERSION = { V1: 1.0, V2: 2.0, V3: 3.0 } as const;

export const VertexTag = { UNKNOWN: 0, STANDARD: 1, COMPRESSED: 2, DRACO: 3 } as const;
export const VertexTagV3 = { STANDARD: 0, DRACO: 1, MESHOPT: 2 } as const;

const CompressOption = {
  VERTEX: 1,
  NORMAL: 2,
  VERTEX_COLOR: 4,
  SECOND_COLOR: 8,
  TEXCOORD: 16,
  TEXCOORD_IS_W: 32,
} as const;

const AttrTypeSize: Record<number, number> = { 0: 4, 1: 4, 2: 8, 3: 2 };

export type InflateFn = (data: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export interface ParseOptions {
  /** 自定义解压实现，默认用 DecompressionStream('deflate')；Node 下传 zlib.inflateSync */
  inflate?: InflateFn;
  /** 逐段追踪偏移，调试解析用 */
  trace?: (section: string, detail?: unknown, offset?: number) => void;
}

/** 默认解压：zlib（文件头 78 9C / 78 DA）。浏览器与 Node 18+ 均可用。 */
async function defaultInflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('[s3m] 当前环境无 DecompressionStream，请通过 options.inflate 注入解压实现');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
    stride: stride || components * 4,
    offsetInBytes: offset,
    divisor,
    dtype,
  });
}

function newVertexPackage(): VertexPackage {
  return { vertexAttributes: [], attrLocation: {}, instanceCount: 0, instanceMode: 0, instanceIndex: -1, verticesCount: 0 };
}

/* ---------------------------------------------------------------- LOD 树 */

function parseGeode(r: BinaryReader): Geode {
  const matrix: number[] = new Array(16);
  for (let i = 0; i < 16; i++) matrix[i] = r.f64();
  const n = r.u32();
  const skeletonNames: string[] = [];
  for (let i = 0; i < n; i++) skeletonNames.push(r.string());
  return { matrix, skeletonNames };
}

function parsePageLOD(r: BinaryReader, version: number): PageLOD {
  const rangeValue = r.f32();
  const rangeMode = r.u16();
  const boundingSphere = { center: r.vec3f64(), radius: r.f64() };

  const pageLod: PageLOD = { rangeValue, rangeMode, boundingSphere, childTile: '', geodes: [] };

  if (version >= 3) {
    pageLod.obb = {
      center: r.vec3f64(),
      xExtent: r.vec3f64(),
      yExtent: r.vec3f64(),
      zExtent: r.vec3f64(),
    };
  }

  // childTile 里可能带 "Geometry" 后缀，官方在切分时去掉
  let childTile = r.string();
  const gi = childTile.indexOf('Geometry');
  if (gi !== -1) childTile = childTile.substring(0, gi);
  pageLod.childTile = childTile;

  const geodeCount = r.u32();
  for (let i = 0; i < geodeCount; i++) pageLod.geodes.push(parseGeode(r));

  if (version >= 3) r.string(); // 动画 JSON，暂不解析

  return pageLod;
}

/**
 * pageLOD 条目序列（无 streamSize 前缀）。
 * 经典 s3mb 的 groupNode 与 S3MBLOCK 的 shell 段共用这一段。
 */
export function parseGroupNodeEntries(r: BinaryReader, version: number): GroupNode {
  const count = r.u32();
  const pageLods: PageLOD[] = [];
  for (let i = 0; i < count; i++) pageLods.push(parsePageLOD(r, version));
  r.align4();
  return { pageLods };
}

export function parseGroupNode(r: BinaryReader, version: number): GroupNode {
  r.u32(); // streamSize
  return parseGroupNodeEntries(r, version);
}

/* ------------------------------------------------------------ 顶点数据包 */

function parseVertex(r: BinaryReader, vp: VertexPackage): void {
  const count = r.u32();
  vp.verticesCount = count;
  if (count === 0) return;
  const dim = r.u16();
  r.u16(); // stride 字段不可信，官方也忽略它
  pushAttr(vp, 'position', r.bytes(count * dim * 4), dim, dim * 4);
}

function parseNormal(r: BinaryReader, vp: VertexPackage): void {
  const count = r.u32();
  if (count <= 0) return;
  const dim = r.u16();
  const stride = r.u16();
  pushAttr(vp, 'normal', r.bytes(count * dim * 4), dim, stride || dim * 4);
}

function parseVertexColor(r: BinaryReader, vp: VertexPackage): void {
  const count = r.u32();
  let data: Uint8Array;
  if (count > 0) {
    r.u16(); // stride
    r.skip(2);
    data = r.bytes(count * 4);
  } else {
    // 缺省白色，保证 shader 拿得到 aColor
    data = new Uint8Array((vp.verticesCount || 0) * 4).fill(255);
  }
  pushAttr(vp, 'color', data, 4, 4, 0, undefined, 'u8');
}

function parseSecondColor(r: BinaryReader, vp: VertexPackage): void {
  const count = r.u32();
  if (count <= 0) return;
  r.u16();
  r.skip(2);
  pushAttr(vp, 'secondColor', r.bytes(count * 4), 4, 4, 0, undefined, 'u8');
}

function parseTexCoord(r: BinaryReader, vp: VertexPackage): void {
  const count = r.u16();
  r.skip(2);
  for (let i = 0; i < count; i++) {
    const n = r.u32();
    const dim = r.u16();
    const stride = r.u16();
    pushAttr(vp, i === 0 ? 'uv' : `uv${i + 1}`, r.bytes(n * dim * 4), dim, stride || dim * 4);
  }
}

/**
 * 实例化信息。官方按 dimension 分派：
 *   16    → 每实例一个 4x4 矩阵（另有 2/4 字节 per-instance 前缀，v3 与 v1/v2 不同）
 *   17/29 → 每实例一个矩阵 + 颜色
 * 其余情况按 dimension * count * 4 字节整体跳过。
 */
function parseInstanceInfo(r: BinaryReader, vp: VertexPackage, version: number): void {
  const count = r.u16();
  r.skip(2);

  for (let i = 0; i < count; i++) {
    const instanceCount = r.u32();
    const dim = r.u16();

    if (dim === 16) {
      r.offset -= 2; // 官方此处回退 2 字节，perInstance 前缀直接计入行长
      const prefix = version === 3 ? 2 : 4;
      const rowLen = dim * 4 + prefix;
      const total = instanceCount * rowLen;
      const raw = r.bytes(total);
      const clean = new Uint8Array(instanceCount * dim * 4);
      for (let k = 0; k < instanceCount; k++) {
        clean.set(raw.subarray(k * rowLen + prefix, k * rowLen + rowLen), k * dim * 4);
      }
      vp.instanceCount = instanceCount;
      vp.instanceMode = dim;
      vp.instanceBuffer = clean;
      vp.instanceIndex = 1;
      const byteStride = 64;
      pushAttr(vp, 'instanceMatrix0', clean, 4, byteStride, 0, 1);
      pushAttr(vp, 'instanceMatrix1', clean, 4, byteStride, 16, 1);
      pushAttr(vp, 'instanceMatrix2', clean, 4, byteStride, 32, 1);
      pushAttr(vp, 'instanceColor', clean, 4, byteStride, 48, 1);
    } else {
      r.u16(); // stride
      const total = instanceCount * dim * 4;
      if (dim === 17 || dim === 29) {
        vp.instanceCount = instanceCount;
        vp.instanceMode = dim;
        vp.instanceBuffer = r.bytesCopy(total);
        vp.instanceIndex = 1;
      } else {
        r.skip(total);
      }
    }
  }
}

function parseVertexAttrExtension(r: BinaryReader, vp: VertexPackage): void {
  const n = r.u32();
  for (let i = 0; i < n; i++) {
    const count = r.u32();
    const dim = r.u16();
    const type = r.u16();
    const size = AttrTypeSize[type] ?? 4;
    pushAttr(vp, `custom${i}`, r.bytes(count * dim * size), dim, dim * size);
  }
}

function parseTangent(r: BinaryReader): void {
  const n = r.u32();
  if (n <= 0) return;
  const dim = r.u16();
  r.u16();
  r.skip(n * dim * 4);
}

function parseStandardSkeleton(r: BinaryReader, vp: VertexPackage, version: number): void {
  if (version >= 3) r.u32(); // streamSize

  parseVertex(r, vp);
  parseNormal(r, vp);
  parseVertexColor(r, vp);
  if (version < 3) parseSecondColor(r, vp);
  parseTexCoord(r, vp);
  parseInstanceInfo(r, vp, version);

  if (version >= 3) {
    parseVertexAttrExtension(r, vp);
    const descript = r.string();
    vp.customVertexAttribute = descript ? JSON.parse(descript) : undefined;
    r.align4();
    parseTangent(r);
  }
}

function parseCompressedSkeleton(r: BinaryReader, vp: VertexPackage, version: number): void {
  const flags = r.u32();
  vp.compressOptions = flags;

  if (flags & CompressOption.VERTEX) throw new Error('[s3m] 顶点量化压缩（v2 旧式）暂未实现');
  parseVertex(r, vp);

  if (flags & CompressOption.NORMAL) throw new Error('[s3m] 法线压缩（v2 旧式）暂未实现');
  parseNormal(r, vp);

  parseVertexColor(r, vp);
  parseSecondColor(r, vp);

  if (flags & CompressOption.TEXCOORD) throw new Error('[s3m] 纹理坐标压缩（v2 旧式）暂未实现');
  parseTexCoord(r, vp);

  if (flags & CompressOption.TEXCOORD_IS_W) vp.textureCoordIsW = true;
  parseInstanceInfo(r, vp, version);
}

/* ---------------------------------------------------------------- 索引包 */

function parseIndexPackages(r: BinaryReader, version: number): IndexPackage[] {
  const count = r.u32();
  const packs: IndexPackage[] = [];

  for (let i = 0; i < count; i++) {
    if (version >= 3) r.u32(); // streamSize

    const indexCount = r.u32();
    const indexType = r.u8();
    const useIndex = r.u8();
    const primitiveType = r.u8();
    r.skip(1);

    let indices: Uint8Array | null = null;
    if (indexCount > 0) {
      const wide = indexType === 1 || indexType === 3;
      const size = wide ? 4 : 2;
      indices = r.bytes(indexCount * size);
      if (!wide && indexCount % 2 !== 0) r.skip(2); // 16 位奇数索引补齐
    }

    const passNames: string[] = [];
    const passCount = r.u32();
    for (let j = 0; j < passCount; j++) passNames.push(r.string());

    r.align4();

    packs.push({ indexCount, indexType, useIndex, primitiveType, indices, passNames });
  }
  return packs;
}

/* ------------------------------------------------------------------ 骨架 */

/** v3 骨架条目末尾的包围盒大小：center + xExtent/yExtent/zExtent 各 3 个 float64 */
const OBB_V3_SIZE = 96;

/**
 * v3 骨架末尾的包围盒。
 *
 * v3.01 的实际数据在索引包之后、包围盒之前多了一个 4 字节字段（实测恒为 0，
 * 推测是线框几何的长度）。规范里没有写，标准骨架是否也有无法验证。
 *
 * 首选路径是 parseSkeletonEntries 里按 skeletonStreamSize 直接定位到「条目末尾
 * 96 字节」——那是生产端写死的权威边界，不用猜。这里只保留 streamSize 不可用时
 * （S3MBLOCK 内层、末条越界）的启发式兜底：读一遍看像不像包围盒，不像就跳 4 字节重读。
 *
 * 注意「不像」的判定必须只针对垃圾值（非有限 / 超出地球量级）：
 * 点云叶子瓦片只有一个点，extent 合法地为 0，退化包围盒是正常数据，
 * 不能因为 extent≈0 就认定错位 —— 否则流会整体偏 4 字节，
 * 下一个骨架的名字长度会读到 ASCII 数字上（如 858992690 = "2033"），
 * 直接 RangeError。
 */
function readV3BoundingBox(r: BinaryReader): BoundingBox {
  const start = r.offset;
  const box = r.boundingBox();
  if (isFiniteBox(box)) return box;
  r.offset = start + 4;
  return r.boundingBox();
}

/** 只排除垃圾值； extent 为 0 的退化包围盒（单点点云）是合法数据 */
function isFiniteBox(box: { center: Vec3; xExtent: Vec3; yExtent: Vec3; zExtent: Vec3 }): boolean {
  const all = [box.center, box.xExtent, box.yExtent, box.zExtent];
  for (const v of all) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false;
    if (Math.abs(v.x) > 1e7 || Math.abs(v.y) > 1e7 || Math.abs(v.z) > 1e7) return false;
  }
  return true;
}

/**
 * 骨架条目序列（count 已由调用方语境决定是否读过）。
 * 经典 s3mb 与 S3MBLOCK 的骨架段都长这样，区别只是外层有没有 streamSize / 附加流。
 */
export async function parseSkeletonEntries(
  r: BinaryReader,
  version: number,
  trace?: ParseOptions['trace']
): Promise<Record<string, GeoPackageEntry>> {
  const count = r.u32();
  const geoPackage: Record<string, GeoPackageEntry> = {};

  for (let i = 0; i < count; i++) {
    // v3 起每块骨架自带 streamSize，覆盖「本字段之后 → 下一条记录开头」整段。
    // 这是唯一可靠的条目边界：几何段与末尾 OBB 之间可能还有对齐填充
    // （实测高斯泼溅/点云的多块瓦片里，第 3 块就比别块多 4 字节 pad），
    // 靠「读够固定长度」往后推会整条流错位。
    let entryEnd = -1;
    if (version >= 3) {
      const streamSize = r.u32();
      const end = r.offset + streamSize;
      if (streamSize >= OBB_V3_SIZE && end <= r.view.byteLength) entryEnd = end;
    }

    const name = r.string();
    r.align4();

    let tag: number = r.u32();
    if (version >= 3) {
      tag =
        tag === VertexTagV3.STANDARD ? VertexTag.STANDARD
        : tag === VertexTagV3.DRACO ? VertexTag.DRACO
        : tag === VertexTagV3.MESHOPT ? VertexTag.COMPRESSED
        : VertexTag.UNKNOWN;
    }

    const vp = newVertexPackage();
    let indexPackages: IndexPackage[] = [];

    if (tag === VertexTag.STANDARD) {
      parseStandardSkeleton(r, vp, version);
      indexPackages = parseIndexPackages(r, version);
    } else if (tag === VertexTag.COMPRESSED) {
      if (version >= 3) {
        // 索引包夹在块之间，不能拆成「先骨架后索引」两步读
        indexPackages = (await parseMeshOptGeometry(r, vp)).indexPackages;
      } else {
        parseCompressedSkeleton(r, vp, version);
        indexPackages = parseIndexPackages(r, version);
      }
    } else if (tag === VertexTag.DRACO) {
      // 点云分支：容器自带属性 uid 表，解出来的顶点即点，索引包由解析器合成
      indexPackages = await parseDracoGeometry(r, vp);
    } else {
      throw new Error(`[s3m] 未知骨架标记 ${tag}（${name}）`);
    }

    let obb: BoundingBox | undefined;
    if (version >= 3) {
      if (entryEnd >= 0 && entryEnd - r.offset >= OBB_V3_SIZE) {
        // OBB 恒定在条目末尾 96 字节：中间多出来的按填充丢掉，
        // 这样即使几何段里还有个我们没认出来的字段，也不会波及后面的记录
        const pad = entryEnd - r.offset - OBB_V3_SIZE;
        if (pad > 0) trace?.('  skelPad', pad, r.offset);
        r.offset = entryEnd - OBB_V3_SIZE;
        obb = readV3BoundingBox(r);
        r.offset = entryEnd;
      } else {
        // 没有可用的 streamSize（S3MBLOCK 内层、或末条越界），只能按启发式读
        obb = readV3BoundingBox(r);
      }
    }
    trace?.('  skel', name, r.offset);

    geoPackage[name] = { name, vertexPackage: vp, indexPackages, obb };
  }

  return geoPackage;
}

export async function parseSkeletons(
  r: BinaryReader,
  version: number,
  trace?: ParseOptions['trace']
): Promise<Record<string, GeoPackageEntry>> {
  r.u32(); // streamSize
  const geoPackage = await parseSkeletonEntries(r, version, trace);

  // v1/v2 在骨架数组之后还有一段附加流。官方写法是
  //   bytesOffset += secColorSize; bytesOffset += 4;
  // 其中读取 secColorSize 时不推进指针，等价于「起点 + 长度 + 4」。
  // 此时 r.offset 已在长度字段之后，所以只补长度即可。
  // （S3MBLOCK 没有这一段——secondColor 在段目录里是独立条目）
  if (version < 3) {
    const extra = r.u32();
    r.skip(extra);
  }

  return geoPackage;
}

/* ------------------------------------------------------------------ 纹理 */

function parseTextures(r: BinaryReader): Record<string, S3MTexture> {
  const streamSize = r.u32();
  const start = r.offset;
  const end = start + streamSize;

  const count = r.u32();
  const textures: Record<string, S3MTexture> = {};

  for (let i = 0; i < count; i++) {
    const code = r.string();
    r.align4(start);

    const level = r.u32();
    const width = r.u32();
    const height = r.u32();
    const compressType = r.u32();
    const dataSize = r.u32();
    const pixelFormat = r.u32();
    const data = r.bytesCopy(dataSize);

    textures[code] = { code, level, width, height, compressType, pixelFormat, data };
  }

  r.offset = end;
  return textures;
}

/* ------------------------------------------------------------ 材质与拾取 */

function parseMaterials(r: BinaryReader): unknown {
  const len = r.u32();
  const str = new TextDecoder('utf-8').decode(r.bytes(len));
  return str ? JSON.parse(str) : [];
}

/**
 * 单体化信息。非实例化数据里每个单体对应一段连续的顶点区间，
 * 这里把它展开成逐顶点的 batchId 属性，渲染层可直接做 GPU picking。
 */
export function parsePickInfo(
  r: BinaryReader,
  options: number,
  geoPackage: Record<string, GeoPackageEntry>,
  version: number
): Record<string, unknown> | null {
  let flags = options;
  if ((flags & 1) !== 1) return null;

  if (version >= 3) flags = r.u32();
  if ((flags & 1) !== 1) return null;

  r.u32(); // streamSize
  return parsePickInfoEntries(r, geoPackage, version);
}

/**
 * 单体化条目序列（无 flags / streamSize 前缀）。
 * 经典 s3mb 在流内自带 streamSize；S3MBLOCK 的段目录里没有，由调用方按目录切好传入。
 */
export function parsePickInfoEntries(
  r: BinaryReader,
  geoPackage: Record<string, GeoPackageEntry>,
  version: number
): Record<string, unknown> {
  const count = r.u32();
  const result: Record<string, unknown> = {};

  for (let i = 0; i < count; i++) {
    const geometryName = r.string();
    const geo = geoPackage[geometryName];
    const selectCount = r.u32();
    const pickInfo: Record<number, PickEntry> = {};
    if (!geo) continue;

    const vp = geo.vertexPackage;
    const instanced = vp.instanceIndex !== -1;

    if (!instanced) {
      const batchIds = new Float32Array(vp.verticesCount || 0);
      for (let j = 0; j < selectCount; j++) {
        const id = r.u32();
        const segCount = r.u32();
        const entry: PickEntry = { batchId: j, segments: [] };
        pickInfo[id] = entry;
        for (let k = 0; k < segCount; k++) {
          const vertexOffset = r.u32();
          const vertexCount = r.u32();
          entry.segments!.push({ vertexOffset, vertexCount });
          batchIds.fill(j, vertexOffset, vertexOffset + vertexCount);
        }
      }
      pushAttr(vp, 'batchId', new Uint8Array(batchIds.buffer), 1, 4, 0, undefined, 'f32');
    } else {
      const instanceCount = vp.instanceCount;
      const instanceBatchIds = new Float32Array(instanceCount).fill(-1);
      for (let j = 0; j < selectCount; j++) {
        const id = r.u32();
        const n = r.u32();
        const entry: PickEntry = { instanceIds: [], instanceBatchId: j };
        pickInfo[id] = entry;
        for (let k = 0; k < n; k++) {
          const instanceId = r.u32();
          if (version >= 3) r.u32();
          if (instanceId >= 0 && instanceId < instanceCount) {
            entry.instanceIds!.push(instanceId);
            instanceBatchIds[instanceId] = j;
          }
        }
      }
      // 实例化的单体粒度是「逐实例」的，不能塞进逐顶点属性：
      // 顶点数（base mesh）和实例数根本不是一个量级，长度对不上会被 three 当成坏 buffer。
      vp.instanceBatchIds = instanceBatchIds;
    }

    geo.pickInfo = pickInfo;
    result[geometryName] = pickInfo;
  }

  return result;
}

/* ------------------------------------------------------------------ 入口 */

/**
 * 容器层面的永久错误（格式不认识、重试一万次也不会变好）。
 * 瓦片调度看到 permanent 就不再退避重试，免得反复重下一整块瓦片。
 */
export class S3MFormatError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'S3MFormatError';
  }
}

export async function parseS3MB(arrayBuffer: ArrayBuffer, options: ParseOptions = {}): Promise<ParsedTile> {
  // S3M 1.x（SuperMapCache，.s3m）不是「float32 版本号开头」的容器：头 4 字节是魔数
  // s3m\0，紧接 zlib。不当场分流的话，这 4 字节会被读成 1e-38 的「版本号」，再把 zlib
  // 头当压缩长度，最后报出 RangeError: Invalid typed array length 这种看不出根因的错。
  // 容器与结构标定见 S3M1Parser.ts。
  if (isS3M1Buffer(arrayBuffer)) return parseS3M1(arrayBuffer, options);
  const inflate = options.inflate ?? defaultInflate;
  const trace = options.trace;
  const r = new BinaryReader(arrayBuffer);

  const version = Number(r.f32().toFixed(2));

  let compressedType = 0;
  if (version >= 3) compressedType = r.u32();
  if (version >= 2) r.u32(); // uncompressedSize
  const compressedSize = r.u32();

  const payload = new Uint8Array(arrayBuffer, r.base + r.offset, compressedSize);

  let raw: Uint8Array;
  if (version >= 3 && compressedType === 0) {
    raw = payload;
  } else {
    raw = await inflate(payload);
  }

  const t = new BinaryReader(raw.buffer as ArrayBuffer, raw.byteOffset ?? 0, raw.byteLength);

  const fileOptions = t.u32();
  trace?.('fileOptions', fileOptions, t.offset);
  const groupNode = parseGroupNode(t, version);
  trace?.('groupNode', groupNode.pageLods.length, t.offset);
  const geoPackage = await parseSkeletons(t, version, trace);
  trace?.('skeletons', Object.keys(geoPackage).length, t.offset);
  const textures = parseTextures(t);
  trace?.('textures', Object.keys(textures).length, t.offset);
  const materials = parseMaterials(t);
  trace?.('materials', t.offset);
  const pickInfo = parsePickInfo(t, fileOptions, geoPackage, version);
  trace?.('pickInfo', t.offset);

  let extensions: unknown;
  if (version >= 3) {
    const s = t.string();
    extensions = s ? JSON.parse(s) : undefined;
  }

  // 3DGS：泼溅参数（gsScale / gsRotation）的量化格式已经标定（见 core/GaussianSplat.ts），
  // 正常数据会被渲染成各向异性的高斯片，**这不再是降级**。
  // 只有「数据声称自己是 3DGS、但骨架里根本没有这两条流」时才退回点渲染 ——
  // 那种情况没有任何东西可以补，只能如实上报，而不是画一堆点让人猜。
  const degradations: DegradationKind[] = [];
  const gs = (extensions as { GaussianSplatting?: { isGaussianSplatting?: boolean } } | undefined)
    ?.GaussianSplatting;
  if (gs?.isGaussianSplatting) {
    const hasSplatStreams = Object.values(geoPackage).some((e) =>
      e.vertexPackage.vertexAttributes.some(
        (a) => a.semantic === 'gsScale' || a.semantic === 'gsRotation'
      )
    );
    if (!hasSplatStreams) degradations.push('gaussian-splatting-points');
  }

  return {
    version,
    compressedType,
    options: fileOptions,
    groupNode,
    geoPackage,
    textures,
    materials,
    pickInfo,
    extensions,
    ...(degradations.length > 0 ? { degradations } : {}),
    bytesRead: t.offset,
    bytesTotal: t.view.byteLength,
  };
}

export type { VertexAttribute };
