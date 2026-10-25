/**
 * S3MBLOCK 单文件分块瓦片（S3M 2.0+ 的 TextureSharing / StoreType=SingleFile 数据）
 *
 * 桌面端生成瓦片时选「文件类型 = S3MBLOCK」会把纹理与骨架分离存储：
 * 配置里 tiles 是 N 个 `.s3mblock`，每个文件内含若干 RO 组，每组一段 pageLOD 元信息
 * 加一份 zlib 压缩的 v2 瓦片体；纹理不跟瓦片走，而是作为「图集」内嵌在块里，
 * 材质通过图集 id（如 `-667946976.texblock`）引用，几何顶点区间绑定到图集子区域。
 *
 * 布局从真实数据（SuperMap Online `3D-CBD/Xiaopin@CBD`）逐字节标定，
 * 并与官方 `@supermapgis/s3m-content-loader` 的 S3MBlockBufferLoader 交叉验证过。
 *
 * 容器：
 * ```
 * float32 blockVersion                 // 2.1
 * uint32 groupCount                    // RO 组数，实测 1
 *   ↑ 每组重复：
 *   String  name                       // "0.s3mblock"
 *   if blockVersion <= 3.0:
 *     uint32 pageLodCount
 *       float32 rangeValue             // 与内层瓦片的 pageLOD 相同（索引冗余）
 *       uint16 rangeMode
 *       float64 boundingSphere.center.xyz + radius
 *       String  childTile              // "0_00.s3mblock"
 *   float32 version                    // 内层瓦片版本（2.1）
 *   if version >= 3: uint32 compressedType
 *   uint32 unzipSize
 *   uint32 zipSize
 *   byte    zipData[zipSize]           // zlib
 * ```
 *
 * 内层（解压后）是「段目录」结构，与经典 v2 s3mb 的区别在于各段带独立长度前缀、
 * v2 的 secondColor 独立成段、纹理段换成图集格式：
 * ```
 * uint32 options                       // bit0 = 有单体化信息
 * uint32 size → groupNode 段（pageLOD + geode）
 * uint32 size → 骨架段（v2 布局，复用 parseSkeletons）
 * if version < 3: uint32 size → secondColor 段（跳过）
 * uint32 size → 图集段（见下）
 * String  materials JSON
 * if options & 1: uint32 size → 单体化信息段
 * ```
 *
 * 图集段（纹理共享的核心）：
 * ```
 * uint32 count
 *   ↑ 每张图集重复：
 *   String  id                         // "-667946976.texblock"，材质 JSON 用它引用
 *   pad4
 *   uint32 level
 *   uint8   isSaveData                 // 1 = 纹理数据内嵌在本块
 *   uint32 width; uint32 height
 *   uint32 compressType; uint32 size; uint32 pixelFormat
 *   byte    data[size]                 // 仅 isSaveData 时存在
 *   uint32 childTexCount → String×n    // 派生图集链（祖先表）
 *   uint32 requestNameCount → String×n // 需要额外请求的 texblock 文件
 *   uint32 subTexCount                 // 图集子区域
 *     String  subName                  // "60_3.texblock"
 *     pad4
 *     uint32 offsetX; offsetY; subWidth; subHeight
 *     uint32 geoCount
 *       String  geoName                // 骨架名
 *       uint32 vertexOffset; vertexCount; texUnitIndex
 * ```
 *
 * 渲染侧的处理是 CPU 重映射：把每个顶点区间的 UV 从子区域空间
 * 变换到图集空间 (offsetX + u·subW) / W，这样下游材质直接绑定整张图集即可，
 * 不需要官方那套 aTextureBatchId + 着色器采样数组。
 */
import { BinaryReader } from './BinaryReader.js';
import type { InflateFn, ParseOptions } from './S3MBParser.js';
import type { GeoPackageEntry, GroupNode, PageLOD, ParsedTile, S3MTexture } from './types.js';
import { parseGroupNodeEntries, parseSkeletonEntries, parsePickInfoEntries } from './S3MBParser.js';

/** 图集子区域，以及它绑定的几何顶点区间 */
export interface S3MSubTextureBinding {
  geoName: string;
  vertexOffset: number;
  vertexCount: number;
  /** 0 → uv，1 → uv2 */
  texUnitIndex: number;
}

export interface S3MSubTexture {
  subName: string;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  bindings: S3MSubTextureBinding[];
}

/** 一张共享图集。data 为空表示数据在别的块里（requestNames 列出要去取的文件） */
export interface S3MBlockTexture {
  id: string;
  level: number;
  width: number;
  height: number;
  compressType: number;
  pixelFormat: number;
  data: Uint8Array | null;
  childTexNames: string[];
  requestNames: string[];
  subTexInfos: S3MSubTexture[];
}

export interface S3MBlockPageLod {
  rangeValue: number;
  rangeMode: number;
  boundingSphere: { center: { x: number; y: number; z: number }; radius: number };
  childTile: string;
}

export interface S3MBlockTile extends ParsedTile {
  /** 容器版本的原始 float（2.1） */
  blockVersion: number;
  /** 块文件名（去掉 .s3mblock 后缀） */
  blockName: string;
  texturePackage: Record<string, S3MBlockTexture>;
}

export interface ParseBlockOptions {
  inflate?: InflateFn;
}

async function defaultInflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('[s3m] 当前环境无 DecompressionStream，请通过 options.inflate 注入解压实现');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------ 图集段 */

function parseBlockTextures(r: BinaryReader): Record<string, S3MBlockTexture> {
  const count = r.u32();
  const out: Record<string, S3MBlockTexture> = {};

  for (let i = 0; i < count; i++) {
    const id = r.string();
    r.align4();
    const level = r.u32();
    const isSaveData = r.u8();
    const width = r.u32();
    const height = r.u32();
    const compressType = r.u32();
    const size = r.u32();
    const pixelFormat = r.u32();
    const data = isSaveData ? r.bytesCopy(size) : null;

    const childTexCount = r.u32();
    const childTexNames: string[] = [];
    for (let j = 0; j < childTexCount; j++) childTexNames.push(r.string());

    const requestNameCount = r.u32();
    const requestNames: string[] = [];
    for (let j = 0; j < requestNameCount; j++) requestNames.push(r.string());

    const subTexCount = r.u32();
    const subTexInfos: S3MSubTexture[] = [];
    for (let j = 0; j < subTexCount; j++) {
      const subName = r.string();
      // 注意：subName 后不 align（官方亦无），四个 u32 紧跟着来
      const offsetX = r.u32();
      const offsetY = r.u32();
      const subWidth = r.u32();
      const subHeight = r.u32();
      const geoCount = r.u32();
      const bindings: S3MSubTextureBinding[] = [];
      for (let k = 0; k < geoCount; k++) {
        const geoName = r.string();
        const vertexOffset = r.u32();
        const vertexCount = r.u32();
        const texUnitIndex = r.u32();
        bindings.push({ geoName, vertexOffset, vertexCount, texUnitIndex });
      }
      subTexInfos.push({ subName, offsetX, offsetY, width: subWidth, height: subHeight, bindings });
    }

    out[id] = { id, level, width, height, compressType, pixelFormat, data, childTexNames, requestNames, subTexInfos };
  }

  return out;
}

/**
 * 把顶点 UV 从子纹理空间重映射到图集空间。
 *
 * 原始 UV 是子纹理的归一化坐标，材质允许平铺（addressmode u/v = 0 即 repeat），
 * 所以用 fract 取平铺周期内的位置，再落到子区域上——三个实测样本
 * （UV 分别是「全覆盖图集的 [0,1]」和「平铺到 47 / 510 个周期」）全部自洽。
 * 不覆盖任何绑定的顶点保持原值，落在整张图集上。
 */
/**
 * 【临时实验开关】图集朝向两种约定，用于 A/B 对拍，验证完删除：
 *  A flip   = 解码后翻行 + offsetY 原值（当前实现）
 *  B noflip = 不翻行 + offsetY 从图集另一端起算
 */
const atlasMode = (): 'flip' | 'noflip' =>
  ((globalThis as any).__s3mAtlasMode === 'noflip' ? 'noflip' : 'flip') as 'flip' | 'noflip';

function remapAtlasUVs(geoPackage: Record<string, GeoPackageEntry>, texturePackage: Record<string, S3MBlockTexture>, mirrorV: boolean): void {
  const fract = (x: number) => x - Math.floor(x);
  for (const tex of Object.values(texturePackage)) {
    if (!tex.width || !tex.height) continue;
    for (const sub of tex.subTexInfos) {
      const baseY = mirrorV ? tex.height - sub.offsetY - sub.height : sub.offsetY;
      for (const b of sub.bindings) {
        const geo = geoPackage[b.geoName];
        if (!geo) continue;
        const semantic = b.texUnitIndex === 0 ? 'uv' : 'uv2';
        const attr = geo.vertexPackage.vertexAttributes.find((a) => a.semantic === semantic);
        if (!attr || attr.dtype !== 'f32') continue;
        const floats = new Float32Array(attr.data.buffer, attr.data.byteOffset, attr.data.byteLength / 4);
        const stride = attr.stride / 4;
        const end = Math.min(b.vertexOffset + b.vertexCount, geo.vertexPackage.verticesCount);
        for (let v = b.vertexOffset; v < end; v++) {
          const base = v * stride;
          floats[base] = (sub.offsetX + fract(floats[base]) * sub.width) / tex.width;
          if (attr.components > 1) {
            floats[base + 1] = (baseY + fract(floats[base + 1]) * sub.height) / tex.height;
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ 容器 */

export async function parseS3MBlock(arrayBuffer: ArrayBuffer, options: ParseBlockOptions = {}): Promise<S3MBlockTile> {
  const inflate = options.inflate ?? defaultInflate;
  const r = new BinaryReader(arrayBuffer);

  const blockVersion = r.f32();
  const groupCount = r.u32();
  if (groupCount < 1 || groupCount > 4096) {
    throw new Error(`[s3m] S3MBLOCK 组数异常：${groupCount}`);
  }

  // 当前实现取第一组（与官方 iClient3D 一致：一个块文件一个渲染组）
  const name = r.string().replace(/\.s3mblock$/i, '');

  const pageLods: S3MBlockPageLod[] = [];
  if (blockVersion <= 3.0) {
    const pageLodCount = r.u32();
    for (let i = 0; i < pageLodCount; i++) {
      const rangeValue = r.f32();
      const rangeMode = r.u16();
      const boundingSphere = {
        center: { x: r.f64(), y: r.f64(), z: r.f64() },
        radius: r.f64(),
      };
      const childTile = r.string();
      pageLods.push({ rangeValue, rangeMode, boundingSphere, childTile });
    }
  }

  const version = Number(r.f32().toFixed(2));
  let compressedType = 0;
  if (version >= 3) compressedType = r.u32();
  const unzipSize = r.u32();
  const zipSize = r.u32();
  const zipData = r.bytesCopy(zipSize);
  const raw = await inflate(zipData);
  if (raw.length !== unzipSize) {
    throw new Error(`[s3m] S3MBLOCK 解压长度不符：声明 ${unzipSize}，实际 ${raw.length}`);
  }

  // ---- 内层：段目录 ----
  const t = new BinaryReader(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength);
  const fileOptions = t.u32();

  let size = t.u32();
  const groupNode: GroupNode = parseGroupNodeEntries(new BinaryReader(t.buffer, t.base + t.offset, size), version);
  t.skip(size);

  size = t.u32();
  const geoPackage = await parseSkeletonEntries(new BinaryReader(t.buffer, t.base + t.offset, size), version);
  t.skip(size);

  if (version < 3) {
    size = t.u32();
    t.skip(size); // secondColor 独立段，渲染用不到
  }

  size = t.u32();
  const texturePackage = parseBlockTextures(new BinaryReader(t.buffer, t.base + t.offset, size));
  t.skip(size);

  const materialsJson = t.string();
  let materials: unknown = [];
  if (materialsJson) {
    try {
      materials = JSON.parse(materialsJson.replace(/\n\0/, ''));
    } catch {
      materials = materialsJson;
    }
  }

  let pickInfo: unknown = null;
  let extensions: unknown;
  if ((fileOptions & 1) === 1) {
    if (version >= 3) t.u32(); // IDInfoOption
    size = t.u32();
    pickInfo = parsePickInfoEntries(new BinaryReader(t.buffer, t.base + t.offset, size), geoPackage, version);
    t.skip(size);
  }
  if (version >= 3) {
    const ext = t.string();
    extensions = ext ? JSON.parse(ext) : undefined;
  }

  // ---- 图集 → 纹理表 + UV 重映射 ----
  const mode = atlasMode();
  const textures: Record<string, S3MTexture> = {};
  for (const tex of Object.values(texturePackage)) {
    if (!tex.data) continue;
    textures[tex.id] = {
      code: tex.id,
      level: tex.level,
      width: tex.width,
      height: tex.height,
      compressType: tex.compressType,
      pixelFormat: tex.pixelFormat,
      data: tex.data,
      flipY: mode === 'flip',
    };
  }
  remapAtlasUVs(geoPackage, texturePackage, mode === 'noflip');

  // pageLOD：容器提供的 LOD/子瓦片信息是权威；geodes 在内层 groupNode 里
  const innerLods = groupNode.pageLods;
  const mergedLods: PageLOD[] = pageLods.map((lod, i) => {
    const inner = innerLods[i];
    return {
      rangeValue: lod.rangeValue,
      rangeMode: lod.rangeMode,
      boundingSphere: lod.boundingSphere,
      childTile: lod.childTile,
      geodes: inner?.geodes ?? [],
      ...(inner?.obb ? { obb: inner.obb } : {}),
    };
  });

  return {
    version,
    compressedType,
    options: fileOptions,
    groupNode: { pageLods: mergedLods } as GroupNode,
    geoPackage,
    textures,
    materials,
    pickInfo,
    extensions,
    bytesRead: t.offset,
    bytesTotal: raw.byteLength,
    blockVersion,
    blockName: name,
    texturePackage,
  };
}
