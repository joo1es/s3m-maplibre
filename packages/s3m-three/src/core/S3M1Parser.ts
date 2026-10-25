/**
 * S3M 1.x（SuperMapCache，文件后缀 `.s3m`）容器解析
 *
 * iServer 把 OSGB 等倾斜摄影成果按这种格式发布。输出与 `parseS3MB` 同形状的
 * `ParsedTile`，因此 GeometryBuilder / S3MTileset / 拾取这套下游不用改。
 *
 * 结构（root / L16 / L17 / L18 四块真实瓦片交叉标定，链尾全部精确闭合）：
 * ```
 * byte[4] 's3m\0'  +  zlib
 *   解压后：
 *   uint32 xmlSize; byte[] XML; <补齐 4 字节对齐>
 *   uint32 geoSize;  几何流
 *   uint32 4;        uint32 0            // 固定小段，实测恒 0
 *   uint32 texSize;  纹理流
 *
 * 几何流： uint32 meshCount，然后每块网格
 *   uint32 geoName; uint32 7; uint32 772; uint32 V; uint32 0
 *   V × 16B  顶点 (x, y, z, w)，实测 w 恒等于 z
 *   uint32[6] 数组头 [0,0,0,kind=1,count=V,flag=2]
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
 * 几何里**没有法线数组**，交给 GeometryBuilder 在绑定索引后 computeVertexNormals()。
 */
import { BinaryReader } from './BinaryReader.js';
import type {
  GeoPackageEntry,
  GroupNode,
  IndexPackage,
  PageLOD,
  ParsedTile,
  S3MTexture,
  VertexAttribute,
  VertexPackage,
} from './types.js';

/** S3M 1.x 魔数：ASCII "s3m" + 结尾 0 */
const S3M_V1_MAGIC = 0x006d3373;

export interface ParseS3M1Options {
  inflate?: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

/** 是不是 S3M 1.x 容器 */
export function isS3M1Buffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  return new DataView(buffer, 0, 8).getUint32(0, true) === S3M_V1_MAGIC;
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
  indices: Uint16Array;
  materialId: string;
}

function readGeometry(br: BinaryReader, geoSize: number): MeshRecord[] {
  const meshCount = br.u32();
  if (meshCount > 4096) throw new Error(`[s3m] S3M 1.x 网格数异常：${meshCount}`);
  const out: MeshRecord[] = [];

  for (let m = 0; m < meshCount; m++) {
    const geoName = String(br.u32());
    const seven = br.u32();
    const seven72 = br.u32();
    const V = br.u32();
    br.u32(); // 恒 0
    if (!(V > 0 && V <= 8_000_000)) {
      throw new Error(`[s3m] S3M 1.x 顶点数异常：网格 ${geoName} V=${V}（字段 7=${seven} 772=${seven72}）`);
    }

    // 顶点 (x, y, z, w)；w 实测恒等于 z
    const position = new Float32Array(V * 3);
    for (let i = 0; i < V; i++) {
      const x = br.f32();
      const y = br.f32();
      const z = br.f32();
      br.f32(); // w == z
      position[i * 3] = x;
      position[i * 3 + 1] = y;
      position[i * 3 + 2] = z;
    }

    // UV 数组头 [0,0,0,kind=1,count=V,flag=2]
    br.u32(); br.u32(); br.u32();
    const uvKind = br.u32();
    const uvCount = br.u32();
    br.u32(); // flag
    if (uvKind !== 1 || uvCount !== V) {
      throw new Error(`[s3m] S3M 1.x UV 头不符：网格 ${geoName} kind=${uvKind} count=${uvCount} 期望 1/${V}`);
    }
    const uv = new Float32Array(V * 2);
    for (let i = 0; i < V; i++) {
      uv[i * 2] = br.f32();
      uv[i * 2 + 1] = br.f32();
    }

    // 索引头 [1, indexCount, 0x00040100]
    const idxKind = br.u32();
    const indexCount = br.u32();
    br.u32(); // 常量标记
    if (idxKind !== 1 || indexCount === 0 || indexCount % 3 !== 0) {
      throw new Error(`[s3m] S3M 1.x 索引头不符：网格 ${geoName} kind=${idxKind} count=${indexCount}`);
    }
    const indices = new Uint16Array(indexCount);
    for (let i = 0; i < indexCount; i++) indices[i] = br.u16();
    if (br.offset > geoSize) throw new Error(`[s3m] S3M 1.x 索引越界：网格 ${geoName}`);
    br.align4();

    const one = br.u32();
    const materialId = String(br.u32());
    if (one !== 1) {
      throw new Error(`[s3m] S3M 1.x 记录尾标记异常：网格 ${geoName} 期望 1 实得 ${one}`);
    }
    out.push({ geoName, vertexCount: V, position, uv, indexCount, indices, materialId });
  }
  return out;
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
  if (Math.abs(bpp - 0.5) < 0.02) return 17; // DXT1
  if (Math.abs(bpp - 1) < 0.02) return 21; // DXT5
  if (Math.abs(bpp - 4) < 0.02) return 14; // BGRA
  if (Math.abs(bpp - 3) < 0.02) return 10; // RGB
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
  const meshes = readGeometry(new BinaryReader(br.buffer, br.base + geoStart, geoSize), geoSize);
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
    const pack: IndexPackage = {
      indexCount: mesh.indexCount,
      indexType: 0, // 0 = UNSIGNED_SHORT
      useIndex: 1,
      primitiveType: 4, // TRIANGLES
      indices: new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
      passNames: [mesh.materialId],
    };
    geoPackage[name] = { name, vertexPackage: vp, indexPackages: [pack] };
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
