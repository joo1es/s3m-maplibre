/**
 * S3M 1.x（SuperMapCache，文件后缀 `.s3m`）容器解析
 *
 * iServer 把 OSGB 等倾斜摄影成果按这种格式发布。输出与 `parseS3MB` 同形状的
 * `ParsedTile`，因此 GeometryBuilder / S3MTileset / 拾取这套下游不用改。
 *
 * 结构（root / L16 / L17 / L18 四块真实瓦片交叉标定，链尾全部精确闭合）：
 * ```
 * byte[4] 's3m' + 版本字节（0 = 老导出，1 = iServer 2025 起）+ zlib
 *   解压后：
 *   uint32 xmlSize; byte[] XML; <补齐 4 字节对齐>
 *   uint32 geoSize;  几何流
 *   uint32 4;        uint32 0            // 固定小段，实测恒 0
 *   uint32 texSize;  纹理流
 *
 * 几何流： uint32 meshCount，然后每块网格
 *   uint32 geoName; uint32 7; uint32 772; uint32 V; uint32 0
 *   V × 16B  顶点 (x, y, z, w)，实测 w 恒等于 z        ← 版本 0
 *   V × 12B  顶点 (x, y, z)                            ← 版本 1（部分数据）
 *   uint32[6] 数组头 [0,0,0,kind=1,count=V,flag=2]     ← 版本 0
 *   V × 8B   UV (u, v)
 *   uint32[3] 索引头 [1, indexCount, 0x00040100]
 *   indexCount × uint16                     // indexCount 恒为 3 的倍数，值域最大 V-1
 *   <补齐 4 字节对齐>
 *   uint32 1; uint32 materialId             // 与 XML <material><name> 一致
 *
 * 纹理流： uint32 count，然后每条
 *   uint32 id; uint32 width; uint32 height; uint32 format; uint32 size; uint32 flag
 *   byte[size]                              // 实测 format=14、0.5B/px，即 DXT1
 * ```
 *
 * **版本 0 与版本 1 的几何流布局不同**（2026-10-28 用 SuperMap Online 的
 * `3D-tishuju`（体数据）与 `3D-Histogram`（柱状图）两组真实瓦片标定）：
 * - 版本 0：顶点恒 vec4(16B)，顶点块之后一定是上面那套 UV 头。
 * - 版本 1：顶点有 vec3(12B) / vec4(16B) 两种；顶点块之后是若干「属性块」，
 *   块头里带 count=V，但块数（3~4）与行宽逐网格不同，UV / 法线 / 颜色的顺序
 *   没有稳定规律可循（同一文件里 4 个网格的记录长度都不一样）。
 *   所以版本 1 只取顶点与索引，中间那一段属性块整段跳过 —— 实测这两类数据的
 *   材质都没有纹理（texSize 只有 count=0），跳过不影响画面。
 *   索引段带固定标记 `[1, indexCount, 0x00040100]`，跳过就靠它定位。
 *
 *   版本 1 的顶点还可能是**归一化模板**（柱状图：x/z 落在 [-0.5,0.5]、y 落在 [0,1]，
 *   即一根菱形截面柱），真实位置与尺寸只写在记录尾的 `[1][8][minx…maxz]` 量化盒里。
 *   不展开的话所有柱子都叠在原点 1 米见方 —— 画面上等于「什么都没加载出来」。
 *   展开后每块网格的包围盒与 XML 的 BoundingSphere 完全重合（4/4，误差 0.00m）。
 *
 *   ★ 柱状图真正的几何是**实例化**的（对应规范里 VertexDataPackage 的 InstanceInfo /
 *   InstanceObject）：瓦片里只有一份「单位盒模板」，每根柱是一条 20 float 记录：
 *     [0..11] 3×4 行主序仿射矩阵（缩放≈45 / 平移=柱底中心）
 *     [12..15] RGBA —— 官方截图里黄/绿/红的来源
 *     [16..19] 预留（值与权重之类，本库暂不用）
 *   实测一块 250×50m 的瓦片里 11 条记录、缩放 45×45×38~44，柱间距 50m，与官方渲染一致。
 *   实例数组紧贴记录尾的量化盒（[1][8]+6 float），从盒往前按 80 字节回溯就能整段取到；
 *   块头到实例数组之间还夹着长度不定的零区，所以**不能**正向扫固定偏移。
 *
 *   ★ S3M 1.x 容器**没有 pickInfo 段**，而拾取链路（Picker → _instanceFeature）全靠
 *   pickInfo.instanceIds 把实例序号翻译成 SMID，缺了它就是「看得见、点不中」。
 *   所以实例化网格会合成一份：控制位 = 实例序号，SMID = geoName × 1e6 + 序号。
 *   非实例化网格不需要（拾取退化成「整块网格」，本来就能选中）。
 *
 * 几何里**没有法线数组**，交给 GeometryBuilder 在绑定索引后 computeVertexNormals()。
 */
import { BinaryReader } from './BinaryReader.js';
import type {
  GeoPackageEntry,
  GroupNode,
  IndexPackage,
  PageLOD,
  ParsedTile,
  PickEntry,
  S3MTexture,
  VertexAttribute,
  VertexPackage,
} from './types.js';

/**
 * S3M 1.x 魔数：ASCII "s3m" + 1 字节版本号。
 *
 * 第 4 字节**不是常量 0**：老导出写 0x00，iServer 2025 写 0x01。原先逐字比对
 * `s3m\0`，版本 1 的瓦片就落到 2.x/3.x 分支，4 字节魔数被当 float32 版本号
 * （≈1.4e-38），紧跟的 zlib 头被当压缩长度，最终抛
 * `RangeError: Invalid typed array length: 1424349816` —— 完全看不出根因。
 * 版本 2 起结构可能再变，宁可让它在 2.x 分支明确报错，也不要猜着解。
 */
const S3M_V1_MAGIC = 0x006d3373;
const S3M_V1_MAGIC_MASK = 0x00ffffff;
const S3M_V1_MAX_VERSION = 1;

export interface ParseS3M1Options {
  inflate?: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

/** 是不是 S3M 1.x 容器（版本字节 0 或 1） */
export function isS3M1Buffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  const v = new DataView(buffer, 0, 8).getUint32(0, true);
  if ((v & S3M_V1_MAGIC_MASK) !== S3M_V1_MAGIC) return false;
  return v >>> 24 <= S3M_V1_MAX_VERSION;
}

async function defaultInflate(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: unknown }).DecompressionStream as
    | (new (format: string) => TransformStream)
    | undefined;
  if (!DS) throw new Error('[s3m] 当前环境无 DecompressionStream，请通过 options.inflate 注入解压实现');
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DS('deflate') as unknown as TransformStream);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

const align4 = (n: number): number => (n % 4 === 0 ? n : n + (4 - (n % 4)));

/* ------------------------------------------------------------------ XML */

interface XmlMaterial {
  name: string;
  diffuse: { r: number; g: number; b: number; a: number };
  shininess: number;
  cullMode: string;
  transparentSorting: boolean;
  textureName?: string;
  addressMode?: { u: number; v: number };
}

interface XmlLod {
  geoNames: string[];
  matrix: number[];
  childTile: string;
  rangeMode: number;
  rangeValue: number;
  center: { x: number; y: number; z: number };
  radius: number;
}

function num(text: string | null | undefined, fallback = 0): number {
  const v = parseFloat(text ?? '');
  return Number.isFinite(v) ? v : fallback;
}

/** 抓 <Tag>value</Tag>（带命名空间前缀，取第一个） */
function tag(scope: string, name: string): string | null {
  const m = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}[^>]*>([^<]*)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, 'i').exec(scope);
  return m ? m[1].trim() : null;
}

function allTags(scope: string, name: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}[^>]*>([^<]*)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, 'gi');
  return [...scope.matchAll(re)].map((m) => m[1].trim());
}

/** RangeMode 文本 → 数值（规范：0 = 视点距离，1 = 屏幕像素） */
function rangeModeOf(text: string | null): number {
  const t = (text ?? '').toUpperCase();
  if (t.includes('DISTANCE')) return 0;
  if (t.includes('GEOMETRIC') || t === '2') return 2;
  return 1;
}

function parseXmlLods(xml: string): XmlLod[] {
  const blocks = [...xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?PagedLOD[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?PagedLOD>/gi)];
  const out: XmlLod[] = [];
  for (const b of blocks) {
    const s = b[1];
    const matrix = (tag(s, 'GeoDeModMatrix') ?? '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1')
      .split(',')
      .map((x) => parseFloat(x.trim()))
      .filter((x) => Number.isFinite(x));
    // 中心/半径只在 <BoundingSphere> 作用域里取，否则 <x> 会误吃到别处的同名标签
    const sphere =
      /<(?:[A-Za-z0-9_-]+:)?BoundingSphere[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?BoundingSphere>/i.exec(s)?.[1] ?? '';
    out.push({
      geoNames: allTags(s, 'GeoName'),
      matrix: matrix.length === 16 ? matrix : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      childTile: tag(s, 'RangeDataList') ?? '',
      rangeMode: rangeModeOf(tag(s, 'RangeMode')),
      rangeValue: num(tag(s, 'RangeList')),
      center: { x: num(tag(sphere, 'x')), y: num(tag(sphere, 'y')), z: num(tag(sphere, 'z')) },
      radius: num(tag(sphere, 'radius')),
    });
  }
  return out;
}

function parseXmlMaterials(xml: string): XmlMaterial[] {
  const blocks = [...xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?material[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?material>/gi)];
  const out: XmlMaterial[] = [];
  for (const b of blocks) {
    const s = b[1];
    const rgba = (name: string) => {
      const inner = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, 'i').exec(s);
      if (!inner) return { r: 1, g: 1, b: 1, a: 1 };
      const t = inner[1];
      // 1.x 的取值键名实测是小写 r/g/b/a，个别版本写 A/R/G/B
      return { r: num(tag(t, 'r'), 1), g: num(tag(t, 'g'), 1), b: num(tag(t, 'b'), 1), a: num(tag(t, 'a'), 1) };
    };
    out.push({
      name: tag(s, 'name') ?? '',
      diffuse: rgba('Diffuse'),
      shininess: num(tag(s, 'Shininess')),
      cullMode: tag(s, 'CullMode') ?? tag(s, 'cullmode') ?? 'none',
      transparentSorting: (tag(s, 'TransparentSorting') ?? 'false').toLowerCase() === 'true',
      textureName: undefined,
      addressMode: undefined,
    });
    // 纹理单元：<texture><name>纹理号</name><AddressMode><u><v>…</texture>
    const tex = /<(?:[A-Za-z0-9_-]+:)?texture[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?texture>/i.exec(s);
    if (tex) {
      const t = tex[1];
      const last = out[out.length - 1];
      last.textureName = tag(t, 'name') ?? undefined;
      const am = /<(?:[A-Za-z0-9_-]+:)?AddressMode[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?AddressMode>/i.exec(t);
      if (am) last.addressMode = { u: num(tag(am[1], 'u')), v: num(tag(am[1], 'v')) };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 几何 */

interface MeshRecord {
  geoName: string;
  vertexCount: number;
  position: Float32Array;
  uv: Float32Array;
  indexCount: number;
  indices: Uint16Array | Uint32Array;
  primitiveType: number;
  materialId: string;
  /** 实例矩阵（每实例 16 float：3×4 行主序 + RGBA），没有实例化时为 undefined */
  instances?: Float32Array;
}

/**
 * 校验 p 偏移处是否为合法的 S3M 1.x 索引头：
 *   dword[0] = 1 (idxKind)
 *   dword[1] = indexCount
 *   dword[2] = mark，按字节小端存储：
 *     byte 0: indexType (0=u16, 1/3=u32)
 *     byte 1: useIndex (恒 1)
 *     byte 2: primitiveType (1=POINTS, 2=LINES, 3=LINE_STRIP, 4=TRIANGLES, 5/6=STRIP/FAN, 13=EDGES)
 *     byte 3: reserved (恒 0)
 * 校验紧随其后的索引数据（4 字节对齐）之后，记录尾标记恒为 1。
 */
function isValidIndexHeader(view: DataView, p: number): boolean {
  if (view.getUint32(p, true) !== 1) return false;
  const count = view.getUint32(p + 4, true);
  if (count === 0 || count > 10_000_000) return false;
  const mark = view.getUint32(p + 8, true);
  const indexType = mark & 0xff;
  const useIndex = (mark >> 8) & 0xff;
  const primitiveType = (mark >> 16) & 0xff;
  const reserved = (mark >> 24) & 0xff;
  if (useIndex !== 1 || reserved !== 0) return false;
  if (indexType !== 0 && indexType !== 1 && indexType !== 3) return false;
  if (![1, 2, 3, 4, 5, 6, 13].includes(primitiveType)) return false;
  if (primitiveType === 4 && count % 3 !== 0) return false;
  if (primitiveType === 2 && count % 2 !== 0) return false;

  const wide = indexType === 1 || indexType === 3;
  const indexBytes = count * (wide ? 4 : 2);
  const tailOffset = (p + 12 + indexBytes + 3) & ~3;
  if (tailOffset + 8 > view.byteLength) return false;
  return view.getUint32(tailOffset, true) === 1;
}

/**
 * v1 里每个实例记录固定 20 个 float（80 字节）：
 *   [0..11]  3×4 行主序仿射矩阵（第 4 行隐式 0,0,0,1）
 *   [12..15] RGBA —— 实测就是柱子的配色，官方截图里那些黄/绿/红
 *   [16..19] 预留（值/权重之类，本库暂时不用）
 * 取前 16 个交给 GeometryBuilder，正好对上它认的 stride=16（矩阵 + 颜色）。
 */
const V1_INSTANCE_FLOATS = 20;
const V1_INSTANCE_BYTES = V1_INSTANCE_FLOATS * 4;

/**
 * 合成 SMID 时给每个 geoName 留的实例位宽。
 *
 * geoName 是 uint32 哈希，乘 1e6 后最大约 4.29e15，仍在 Number 安全整数范围内
 * （9.007e15），所以「geoName × 1e6 + 实例序号」可以当作全局唯一键。
 * S3M 1.x 容器不带单体化信息，SMID 只能这样合成——它只用于本库内部的拾取/描边，
 * 和 iServer 侧的 SMID 没有对应关系。
 */
const S3M1_SMID_STRIDE = 1_000_000;

/**
 * 解析实例化数组。
 *
 * 地块级数据（柱状图）不是「一堆柱子的顶点」，而是**一份模板几何 + N 个变换矩阵**：
 * 顶点是单位盒（x/z ∈ [-0.5,0.5]、y ∈ [0,1]），真实位置/尺寸/颜色全在实例矩阵里。
 * 块内布局（实测 5 个网格交叉验证，N 全是整数）：
 *   [V][2] 块头 | V×8 字节（恒 0） | [1][20] 头 | N×80 实例 | [1][8] + 6 float 量化盒
 */
function readInstances(
  view: DataView,
  from: number,
  to: number
): { count: number; floats: Float32Array } | null {
  // 实例数组紧贴量化盒（[1][8] + 6 float）。从它往前按 80 字节回溯，
  // 一旦遇到不像矩阵的记录就停 —— 块头到实例数组之间还夹着长度不定的零区，
  // 正向扫「[1][20] 头」只在单实例的网格上成立（多实例的网格压根没这个头）。
  let aabb = -1;
  for (let p = to - 12; p >= from; p -= 4) {
    if (view.getUint32(p, true) === 1 && view.getUint32(p + 4, true) === 8) {
      aabb = p;
      break;
    }
  }
  if (aabb < 0) return null;

  const ok = (o: number): boolean => {
    const m00 = view.getFloat32(o, true);
    const m11 = view.getFloat32(o + 20, true);
    const m22 = view.getFloat32(o + 40, true);
    const tx = view.getFloat32(o + 12, true);
    const ty = view.getFloat32(o + 28, true);
    const tz = view.getFloat32(o + 44, true);
    if (![m00, m11, m22, tx, ty, tz].every(Number.isFinite)) return false;
    if (Math.abs(tx) > 1e7 || Math.abs(ty) > 1e7 || Math.abs(tz) > 1e7) return false;
    // 缩放不能全是 0：零填充区被这条挡掉
    if (m00 === 0 && m11 === 0 && m22 === 0) return false;
    for (let k = 12; k < 16; k++) {
      const c = view.getFloat32(o + k * 4, true);
      if (!Number.isFinite(c) || Math.abs(c) > 1e3) return false;
    }
    return true;
  };

  let start = aabb;
  while (start - V1_INSTANCE_BYTES >= from && ok(start - V1_INSTANCE_BYTES)) {
    start -= V1_INSTANCE_BYTES;
  }
  const count = (aabb - start) / V1_INSTANCE_BYTES;
  if (count <= 0 || count > 1_000_000) return null;

  const out = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    const o = start + i * V1_INSTANCE_BYTES;
    for (let k = 0; k < 16; k++) out[i * 16 + k] = view.getFloat32(o + k * 4, true);
  }
  return { count, floats: out };
}

/**
 * 从 `from` 起找索引头 `[1, indexCount, 0x00040100]`，返回相对偏移，找不到返回 -1。
 *
 * 只在「顶点块之后那段不是版本 0 的 UV 头」时用得到：版本 1 的属性块布局没有
 * 稳定规律，与其猜行宽，不如直接跳到结构最稳定的索引段。
 */
function findIndexHeader(view: DataView, from: number): number {
  const limit = view.byteLength - 12;
  for (let p = from; p <= limit; p += 4) {
    if (isValidIndexHeader(view, p)) return p;
  }
  return -1;
}

/**
 * 从 `to - 12` 往前找量化盒 `[1][8][minx,miny,minz,maxx,maxy,maxz]`，返回 6 个 float。
 *
 * 版本 1 的柱状图（`3D-Histogram`）把顶点压进单位盒（x/z 落在 [-0.5,0.5]、y 落在 [0,1]，
 * 就是「一根菱形截面的柱」的模板），真实位置与尺寸只存在记录尾部这个盒里。不反量化的
 * 话所有柱子都叠在原点、边长 1 米，看起来就是「什么都加载不出来」。
 *
 * 反过来从索引头往前扫：同一个记录里可能还有别的 `[1][8]`（实测 mesh1 就有一个诱饵），
 * 越靠后越可能是真正的那个。盒本身要求每轴 min < max，这是排除诱饵的硬条件。
 */
function findQuantBox(view: DataView, from: number, to: number): Float32Array | null {
  for (let p = to - 12; p >= from; p -= 4) {
    if (view.getUint32(p, true) !== 1 || view.getUint32(p + 4, true) !== 8) continue;
    if (p + 32 > view.byteLength) continue;
    const f = new Float32Array(6);
    let ok = true;
    for (let i = 0; i < 6; i++) {
      const v = view.getFloat32(p + 8 + i * 4, true);
      if (!Number.isFinite(v) || Math.abs(v) > 1e7) {
        ok = false;
        break;
      }
      f[i] = v;
    }
    if (!ok) continue;
    if (!(f[0]! < f[3]! && f[1]! < f[4]! && f[2]! < f[5]!)) continue;
    return f;
  }
  return null;
}

/**
 * 顶点落在 [-1, 1] 里就认为它是「归一化模板」，按盒逐轴拉伸回去。
 *
 * 逐轴用自己的包围盒做映射（而不是假设 [0,1] 或 [-0.5,0.5]）：实测柱状图 x、z 是
 * [-0.5,0.5]、y 是 [0,1]，硬编码任一约定都会把柱子摆错。
 */
function applyQuantBox(position: Float32Array, box: Float32Array): boolean {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = position[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  for (let a = 0; a < 3; a++) {
    if (!(Math.abs(min[a]!) <= 1.001 && Math.abs(max[a]!) <= 1.001)) return false;
  }
  for (let a = 0; a < 3; a++) {
    const span = max[a]! - min[a]!;
    const scale = (box[a + 3]! - box[a]!) / (span > 1e-6 ? span : 1);
    const base = box[a]! - (span > 1e-6 ? min[a]! * scale : (box[a + 3]! - box[a]!) / 2);
    for (let i = a; i < position.length; i += 3) position[i] = base + position[i]! * scale;
  }
  return true;
}

/**
 * 从版本 1 属性块中尝试提取 UV 坐标：
 * 倾斜摄影（OSGB）等数据中，UV 块通常紧贴在索引头前：
 *   头: [count: u32, dim: u32 = 2]
 *   数据: V * 8 字节 float32 (u, v)
 */
function findV1UV(view: DataView, from: number, to: number, V: number): Float32Array | null {
  const head = to - V * 8 - 8;
  if (head >= from && view.getUint32(head, true) === V && view.getUint32(head + 4, true) === 2) {
    let uv = new Float32Array(V * 2);
    for (let i = 0; i < V * 2; i++) {
      uv[i] = view.getFloat32(head + 8 + i * 4, true);
    }
    return uv;
  }
  for (let p = to - V * 8 - 8; p >= from; p -= 4) {
    if (view.getUint32(p, true) === V && view.getUint32(p + 4, true) === 2) {
      let uv = new Float32Array(V * 2);
      let ok = true;
      for (let i = 0; i < V * 2; i++) {
        const val = view.getFloat32(p + 8 + i * 4, true);
        if (!Number.isFinite(val) || Math.abs(val) > 1e4) {
          ok = false;
          break;
        }
        uv[i] = val;
      }
      if (ok) return uv;
    }
  }
  return null;
}

function readGeometry(
  br: BinaryReader,
  geoSize: number
): { meshes: MeshRecord[]; skippedAttrs: number; quantized: number } {
  const meshCount = br.u32();
  if (meshCount > 4096) throw new Error(`[s3m] S3M 1.x 网格数异常：${meshCount}`);
  const out: MeshRecord[] = [];
  let skippedAttrs = 0;
  let quantized = 0;

  for (let m = 0; m < meshCount; m++) {
    const geoName = String(br.u32());
    const seven = br.u32();
    const seven72 = br.u32();
    const V = br.u32();
    br.u32(); // 恒 0
    if (!(V > 0 && V <= 8_000_000)) {
      throw new Error(`[s3m] S3M 1.x 顶点数异常：网格 ${geoName} V=${V}（字段 7=${seven} 772=${seven72}）`);
    }

    // 顶点：版本 0 是 vec4(x,y,z,w)，w 实测恒等于 z；版本 1 有一半数据是 vec3。
    // 先认版本 0 的 UV 头（不传参时走的还是这条老路，判据一字未改），认不出才用
    // 「顶点块之后那块的头 dword 等于 V」去定行宽。
    const posStart = br.offset;
    const u32At = (off: number): number =>
      off + 4 <= br.view.byteLength ? br.view.getUint32(off, true) : -1;
    const v0UvAt16 =
      u32At(posStart + V * 16 + 12) === 1 && u32At(posStart + V * 16 + 16) === V;
    const stride: 12 | 16 = v0UvAt16
      ? 16
      : u32At(posStart + V * 16) === V
        ? 16
        : 12;
    const position = new Float32Array(V * 3);
    for (let i = 0; i < V; i++) {
      const x = br.f32();
      const y = br.f32();
      const z = br.f32();
      if (stride === 16) br.f32(); // w
      position[i * 3] = x;
      position[i * 3 + 1] = y;
      position[i * 3 + 2] = z;
    }

    let uv = new Float32Array(V * 2);
    let instances: Float32Array | undefined;
    if (v0UvAt16) {
      // 版本 0：UV 数组头 [0,0,0,kind=1,count=V,flag=2]
      br.u32(); br.u32(); br.u32();
      const uvKind = br.u32();
      const uvCount = br.u32();
      br.u32(); // flag
      if (uvKind !== 1 || uvCount !== V) {
        throw new Error(`[s3m] S3M 1.x UV 头不符：网格 ${geoName} kind=${uvKind} count=${uvCount} 期望 1/${V}`);
      }
      for (let i = 0; i < V; i++) {
        uv[i * 2] = br.f32();
        uv[i * 2 + 1] = br.f32();
      }
    } else {
      // 版本 1：顶点块之后是若干属性块（UV / 法线 / 颜色混排，行宽逐网格不同），
      // 整段跳过，靠索引头的固定标记落位。这两类数据没有纹理，跳过不影响画面。
      const at = findIndexHeader(br.view, br.offset);
      if (at < 0) {
        throw new Error(`[s3m] S3M 1.x 属性段无法定位索引头：网格 ${geoName}（偏移 ${br.offset}/${geoSize}）`);
      }
      if (at !== br.offset) {
        const foundUv = findV1UV(br.view, br.offset, at, V);
        if (foundUv) {
          uv = foundUv;
        } else {
          skippedAttrs++;
        }
        // 优先认实例化：柱状图是真·实例化的（一份模板 + N 个变换矩阵），
        // 顶点本来就该保持单位盒，靠矩阵摆位/缩放/上色。
        const inst = readInstances(br.view, br.offset, at);
        if (inst) {
          instances = inst.floats;
        } else {
          // 没有实例矩阵时，顶点是归一化模板，用记录尾的量化盒展开兜底
          const box = findQuantBox(br.view, br.offset, at);
          if (box) quantized += applyQuantBox(position, box) ? 1 : 0;
        }
        br.offset = at;
      }
    }

    // 索引头 [1, indexCount, mark]
    const idxKind = br.u32();
    const indexCount = br.u32();
    const mark = br.u32();
    const indexType = mark & 0xff;
    const useIndex = (mark >> 8) & 0xff;
    const primitiveType = (mark >> 16) & 0xff;
    if (idxKind !== 1 || indexCount === 0 || useIndex !== 1) {
      throw new Error(`[s3m] S3M 1.x 索引头不符：网格 ${geoName} kind=${idxKind} count=${indexCount} mark=0x${mark.toString(16)}`);
    }
    if (primitiveType === 4 && indexCount % 3 !== 0) {
      throw new Error(`[s3m] S3M 1.x 索引头不符：网格 ${geoName} 三角形索引数 ${indexCount} 非 3 的倍数`);
    }
    if (primitiveType === 2 && indexCount % 2 !== 0) {
      throw new Error(`[s3m] S3M 1.x 索引头不符：网格 ${geoName} 线段索引数 ${indexCount} 非 2 的倍数`);
    }
    const wide = indexType === 1 || indexType === 3;
    const indices = wide ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    if (wide) {
      for (let i = 0; i < indexCount; i++) indices[i] = br.u32();
    } else {
      for (let i = 0; i < indexCount; i++) indices[i] = br.u16();
    }
    if (br.offset > geoSize) throw new Error(`[s3m] S3M 1.x 索引越界：网格 ${geoName}`);
    br.align4();

    const one = br.u32();
    const materialId = String(br.u32());
    if (one !== 1) {
      throw new Error(`[s3m] S3M 1.x 记录尾标记异常：网格 ${geoName} 期望 1 实得 ${one}`);
    }
    out.push({
      geoName,
      vertexCount: V,
      position,
      uv,
      indexCount,
      indices,
      primitiveType,
      materialId,
      ...(instances ? { instances } : {}),
    });
  }
  return { meshes: out, skippedAttrs, quantized };
}

/**
 * 按「字节/像素」反推 S3MPixelFormat。
 *
 * v1 头里那个 format 数字不能直接当 pixelFormat 用（实测恒为 14，而本库枚举里
 * 14 = BGRA = 4 字节/像素，照搬会把 0.5 字节/像素的数据当 4 字节读 → 满屏彩噪）。
 * 压缩格式与密度是一一对应的，所以用密度判定，并把原始数字留在告警里。
 */
export function pixelFormatOfBpp(bpp: number, rawFormat: number): number {
  if (!Number.isFinite(bpp) || bpp <= 0) return rawFormat;
  if (Math.abs(bpp - 0.5) < 0.05 || (bpp >= 0.6 && bpp <= 0.75)) return 17; // DXT1（含全 mip 链 ~0.667 B/px）
  if (Math.abs(bpp - 1) < 0.05 || (bpp >= 1.25 && bpp <= 1.5)) return 21; // DXT5（含全 mip 链 ~1.333~1.44 B/px）
  if (Math.abs(bpp - 4) < 0.05) return 14; // BGRA
  if (Math.abs(bpp - 3) < 0.05) return 10; // RGB
  console.warn(`[s3m] S3M 1.x 纹理密度 ${bpp.toFixed(3)} B/px 不在已知档位，按原 format=${rawFormat} 交给上层判定`);
  return rawFormat;
}

/* ------------------------------------------------------------------ 纹理 */

function readTextures(br: BinaryReader, texSize: number): Record<string, S3MTexture> {
  const count = br.u32();
  const out: Record<string, S3MTexture> = {};
  if (count > 1024) throw new Error(`[s3m] S3M 1.x 纹理数异常：${count}`);
  for (let i = 0; i < count; i++) {
    const id = String(br.u32());
    const width = br.u32();
    const height = br.u32();
    const format = br.u32();
    const size = br.u32();
    br.u32(); // flag
    if (br.offset + size > texSize + 4) throw new Error(`[s3m] S3M 1.x 纹理越界：${id}`);
    out[id] = {
      code: id,
      level: 0,
      width,
      height,
      compressType: 0,
      // v1 头里的 format 不是 S3MPixelFormat 枚举，照搬会把纹理解成一片彩噪：
      // 实测四块瓦片（512×512 / 256×128 / 512×256 / 1024×512）的 format 都是 14，
      // 而 data 长度恒等于 width*height*0.5 —— 只有 DXT1 是这个密度
      // （DXT5 是 1 B/px，BGRA 是 4 B/px，而本库枚举里 14 恰恰是 BGRA）。
      // 所以按「字节/像素」反推，别信那个数字。
      pixelFormat: pixelFormatOfBpp(size / (width * height), format),
      // 必须翻回来：DXT 解码器内部按 GL 约定做了一次 Y 翻转（DecompressImage 里的
      // height - 1 - sy），而 v1 的 UV 是「v = 0 对应文件首行」。
      // 实测这块 512×512 的图集内容在文件行 232~511（前 232 行是空的纯黑），
      // 而几何 UV 的 v 落在 0.483~0.983（= 行 245~503）：
      //   按文件行采 → 区域均值亮度 76.1（有内容）
      //   被内部翻转后再采 → 均值 5.6（正好采到空的那半张 → 模型一片黑块）
      // 交给 TextureFactory 的 flipRows 翻一次，就回到前者。
      flipY: true,
      data: br.bytesCopy(size),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ 入口 */

/** 版本 1 布局的提示只打一次：几百块瓦片各喊一句会把控制台刷爆 */
let warnedV1Attrs = false;
let warnedQuantBox = false;

export async function parseS3M1(arrayBuffer: ArrayBuffer, options: ParseS3M1Options = {}): Promise<ParsedTile> {
  const inflate = options.inflate ?? defaultInflate;
  const r = new BinaryReader(arrayBuffer);
  r.skip(4); // 魔数
  const zipped = new Uint8Array(arrayBuffer, r.base + r.offset, arrayBuffer.byteLength - r.base - r.offset);
  const bytes = await inflate(zipped);
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);

  const br = new BinaryReader(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
  );
  const xmlSize = br.u32();
  if (xmlSize <= 0 || xmlSize > raw.byteLength) throw new Error(`[s3m] S3M 1.x XML 段长度异常：${xmlSize}`);
  const xml = new TextDecoder('utf-8').decode(br.bytes(xmlSize));
  br.offset = align4(br.offset);

  const geoSize = br.u32();
  const geoStart = br.offset;
  const { meshes, skippedAttrs, quantized } = readGeometry(
    new BinaryReader(br.buffer, br.base + geoStart, geoSize),
    geoSize
  );
  if (quantized && !warnedQuantBox) {
    warnedQuantBox = true;
    console.warn(
      `[s3m] S3M 1.x（版本 1 布局）：顶点是归一化模板，已按记录尾的量化盒展开到真实尺寸/位置（本进程只提示一次）。`
    );
  }
  if (skippedAttrs && !warnedV1Attrs) {
    warnedV1Attrs = true;
    console.warn(
      `[s3m] S3M 1.x（版本 1 布局）：UV/法线/颜色属性块已跳过，几何与索引正常。` +
        `若该数据集带纹理，贴图会取到同一像素（本进程只提示一次）。`
    );
  }
  br.offset = geoStart + geoSize;

  const smallSize = br.u32();
  br.skip(smallSize);
  const texSize = br.u32();
  const textures = readTextures(
    new BinaryReader(br.buffer, br.base + br.offset, texSize),
    texSize
  );

  /* ---- 组装成与 parseS3MB 一致的结构 ---- */
  const geoPackage: Record<string, GeoPackageEntry> = {};
  for (const mesh of meshes) {
    const name = `SuperMapCache#${mesh.geoName}`;
    const positionAttr: VertexAttribute = {
      semantic: 'position',
      data: new Uint8Array(mesh.position.buffer, mesh.position.byteOffset, mesh.position.byteLength),
      components: 3,
      stride: 12,
      offsetInBytes: 0,
      dtype: 'f32',
    };
    const uvAttr: VertexAttribute = {
      semantic: 'uv',
      data: new Uint8Array(mesh.uv.buffer, mesh.uv.byteOffset, mesh.uv.byteLength),
      components: 2,
      stride: 8,
      offsetInBytes: 0,
      dtype: 'f32',
    };
    const vp: VertexPackage = {
      verticesCount: mesh.vertexCount,
      vertexAttributes: [positionAttr, uvAttr],
      attrLocation: { aposition: 0, auv: 1 },
      instanceCount: 0,
      instanceMode: 0,
      instanceIndex: -1,
    };
    let pickInfo: Record<number, PickEntry> | undefined;
    if (mesh.instances && mesh.instances.length >= 16) {
      // stride 16 = 3×4 行主序矩阵 + RGBA，正是 GeometryBuilder 认的布局：
      // 它会 setMatrixAt(i) 并拿 [12..14] 当实例颜色（柱状图的黄/绿/红就来自这里）
      const count = mesh.instances.length / 16;
      vp.instanceCount = count;
      vp.instanceMode = 16;
      vp.instanceIndex = 0;
      vp.instanceBuffer = new Uint8Array(
        mesh.instances.buffer,
        mesh.instances.byteOffset,
        mesh.instances.byteLength
      );
      // S3M 1.x 容器里**没有 pickInfo 段**，而拾取链路（Picker → _instanceFeature）
      // 完全靠 pickInfo.instanceIds 把「实例序号」翻译成 SMID；缺了它就一路返回 null，
      // 表现就是「模型能看见、但怎么点都选不中」。这里按实例合成一份：
      //   控制位 = 实例序号（写进 aInstanceBatchId，状态纹理按它索引）
      //   SMID   = geoName × 1e6 + 实例序号（哈希值本身 32 位，跨瓦片不重复）
      const ids = new Float32Array(count);
      const instPick: Record<number, PickEntry> = {};
      const smidBase = Number(mesh.geoName) * S3M1_SMID_STRIDE;
      for (let i = 0; i < count; i++) {
        ids[i] = i;
        instPick[smidBase + i] = { batchId: i, instanceIds: [i] };
      }
      vp.instanceBatchIds = ids;
      pickInfo = instPick;
    }
    const pack: IndexPackage = {
      indexCount: mesh.indexCount,
      indexType: mesh.indices instanceof Uint32Array ? 1 : 0,
      useIndex: 1,
      primitiveType: mesh.primitiveType ?? 4,
      indices: new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
      passNames: [mesh.materialId],
    };
    geoPackage[name] = {
      name,
      vertexPackage: vp,
      indexPackages: [pack],
      ...(pickInfo ? { pickInfo } : {}),
    };
  }

  // pageLods 与网格必须按 GeoName 绑定，不能按出现顺序：
  // 实测 L18 的 XML 列出 [2690529118, 1463699937, 451097586, 4063742103]，
  // 而二进制里网格是 [451097586, 1463699937, 2690529118, 4063742103] —— 同批不同序。
  // 按位置配会把某个 LOD 的包围球/矩阵挂到别的网格上（单网格样本看不出问题）。
  const keyOf = new Map(meshes.map((m) => [m.geoName, `SuperMapCache#${m.geoName}`]));
  const xmlLods = parseXmlLods(xml);
  const pageLods: PageLOD[] = [];
  xmlLods.forEach((lod, i) => {
    const named = lod.geoNames.map((n) => keyOf.get(n)).filter((k): k is string => !!k);
    // 名字对不上时退回位置匹配，并让上层有机会发现（宁可少一个 LOD 也不要挂错球）
    const fallback = meshes[i] ? [`SuperMapCache#${meshes[i].geoName}`] : [];
    const skeletonNames = named.length ? [...new Set(named)] : fallback;
    if (!skeletonNames.length) return;
    pageLods.push({
      rangeValue: lod.rangeValue,
      rangeMode: lod.rangeMode,
      boundingSphere: { center: { ...lod.center }, radius: lod.radius },
      childTile: lod.childTile,
      geodes: [{ matrix: lod.matrix, skeletonNames }],
    });
  });
  const groupNode: GroupNode = { pageLods };

  // 材质：拼成 3.x 那套 JSON 形状，下游 makeMaterial / resolveSide 直接吃
  const materials = parseXmlMaterials(xml).map((m) => ({
    material: {
      name: m.name,
      diffuse: m.diffuse,
      shininess: m.shininess,
      cullMode: m.cullMode,
      transparentsorting: m.transparentSorting,
      textureStates: m.textureName
        ? [{ textureunitstate: { name: m.textureName, ...(m.addressMode ? { addressmode: m.addressMode } : {}) } }]
        : [],
    },
  }));

  return {
    version: 1,
    // 1.x 的整文件压缩就是 zlib，对齐 2.x/3.x 的 compressedType 语义（1 = zip）
    compressedType: 1,
    options: 0,
    groupNode,
    geoPackage,
    textures,
    materials,
    pickInfo: null,
    extensions: { s3m1: true },
    bytesRead: br.offset + texSize,
    bytesTotal: raw.byteLength,
  };
}
