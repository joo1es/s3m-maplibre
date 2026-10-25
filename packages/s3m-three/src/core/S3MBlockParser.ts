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
 * 渲染侧不做 UV 烘焙，而是给每个顶点输出一份「所属子区域矩形」（ParsedTile.atlasRects），
 * 由着色器逐片元算 `rect.xy + fract(uv) * rect.zw`——与官方 aTextureBatchId + batch 表
 * 等价，但不需要官方的采样数组。顶点上取 fract 会让跨平铺边界的三角形反向扫纹理，别那样做。
 */
import { BinaryReader } from './BinaryReader.js';
import type { InflateFn, ParseOptions } from './S3MBParser.js';
import type { GeoPackageEntry, GroupNode, PageLOD, ParsedTile, S3MAtlasRects, S3MTexture } from './types.js';
import { parseGroupNodeEntries, parseSkeletonEntries, parsePickInfoEntries } from './S3MBParser.js';
import { atlasAlphaMask, shrinkRectToOpaque } from './AtlasAlpha.js';
import { packAtlases } from './AtlasPack.js';

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
 * 生成「每顶点的图集子区域矩形」，而不是把图集坐标烘进 UV。
 *
 * 原始 UV 是子纹理坐标，材质允许平铺（addressmode u/v = 0 即 repeat），实测很多立面
 * 平铺到 ±20 个周期。官方是在**片元**里做 `xywh.xy + fract(uv) * xywh.wh`；如果在顶点
 * 上取 fract，跨整数边界的三角形会反向扫过整个周期（Building@CBD 实测 17% 的三角形受影响，
 * 部分子纹理 100%），表现为拉丝与错位。所以这里只输出矩形，fract 留给着色器逐片元做。
 *
 * 矩形是图集归一化坐标 (x, y, w, h)；未被任何绑定覆盖的顶点写成退化矩形 (0, 0, 0, 0)，
 * 对应官方 `getTextureBatchId(...) < 0 → maxMipLevel = -1 → 该纹理单元返回 vec4(1.0)`
 * （不参与合成）。**不能**默认成 (0,0,1,1)：那等于拿整张图集当贴图，配上世界尺度的
 * 野 UV 就是一屏重复的微缩照片。
 */
function buildAtlasRects(
  geoPackage: Record<string, GeoPackageEntry>,
  texturePackage: Record<string, S3MBlockTexture>
): Record<string, S3MAtlasRects> {
  const rects: Record<string, S3MAtlasRects> = {};
  const rectOf = (name: string, key: 'uv' | 'uv2'): Float32Array => {
    const geo = geoPackage[name];
    if (!geo) return new Float32Array(0);
    const entry = (rects[name] ??= {});
    let arr = entry[key];
    if (!arr) {
      const n = geo.vertexPackage.verticesCount;
      arr = entry[key] = new Float32Array(n * 4); // 全 0 = 退化矩形 = 该单元不参与
    }
    return arr;
  };

  // 一个 geo 的顶点可能分散绑定在多张图集上（官方用纹理数组按 batch 取）。
  // 这里先把它们拼成一张大图，rect 全部换算到拼图坐标系，单张 map 就能覆盖全部顶点。
  //
  // 顺序很重要：**先在各自图集里做 alpha 收缩，再拼**。
  // 收缩要读的是「这张图集自己的 alpha 掩码」，拼成大图之后坐标与掩码都对不上了。
  const localRects = new Map<string, { x: number; y: number; w: number; h: number }[]>();
  for (const [key, tex] of Object.entries(texturePackage)) {
    if (!tex.width || !tex.height) continue;
    const mask = atlasAlphaMask(tex);
    const W = tex.width;
    const H = tex.height;
    localRects.set(
      key,
      tex.subTexInfos.map((sub) => {
        let lx = sub.offsetX;
        let ly = sub.offsetY;
        let lw = sub.width;
        let lh = sub.height;
        if (mask) {
          // 图集里的精灵是「立面 + 上方天空」的整块照片，天空 alpha=0。
          // 裁到不透明包围盒后，一个 uv 周期只重复立面本体，不再每格带一段天空。
          const nf = shrinkRectToOpaque({ x: lx / W, y: ly / H, w: lw / W, h: lh / H }, mask, W, H);
          lx = nf.x * W;
          ly = nf.y * H;
          lw = nf.w * W;
          lh = nf.h * H;
        }
        return { x: lx, y: ly, w: lw, h: lh };
      })
    );
  }

  const packed = packAtlases(texturePackage);
  if (packed) {
    for (const tex of Object.values(texturePackage)) {
      // 拼合会覆盖 width/height/data，把解析出来的原始元信息留一份，便于排查与测试
      (tex as { origin?: unknown }).origin = {
        width: tex.width,
        height: tex.height,
        pixelFormat: tex.pixelFormat,
        compressType: tex.compressType,
        dataLength: tex.data?.length ?? 0,
      };
      tex.width = packed.width;
      tex.height = packed.height;
      tex.data = packed.data;
      tex.compressType = 0;
      tex.pixelFormat = 28; // RGBA
      (tex as { flipY?: boolean }).flipY = false; // 拼图按自上而下存，v=0 就是顶行
      (tex as { packed?: boolean }).packed = true;
    }
  }

  let groupId = 0;
  for (const [key0, tex] of Object.entries(texturePackage)) {
    if (!tex.width || !tex.height) continue;
    const off = packed ? (packed.offsets.get(key0) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    const locals = localRects.get(key0) ?? [];
    tex.subTexInfos.forEach((sub, si) => {
      groupId++;
      const lr = locals[si] ?? { x: sub.offsetX, y: sub.offsetY, w: sub.width, h: sub.height };
      const src = (tex as { origin?: { width: number; height: number } }).origin;
      const srcArea = src ? src.width * src.height : tex.width * tex.height;
      const wideSprite = srcArea > 0 && (sub.width * sub.height) / srcArea >= 0.5;
      const fit = {
        x: (off.x + lr.x) / tex.width,
        y: (off.y + lr.y) / tex.height,
        w: lr.w / tex.width,
        h: lr.h / tex.height,
      };
      for (const b of sub.bindings) {
        const geo = geoPackage[b.geoName];
        if (!geo) continue;
        const key = b.texUnitIndex === 0 ? 'uv' : 'uv2';
        const arr = rectOf(b.geoName, key);
        // group / groupDim 只认 **基色单元（unit0）**。
        // 一个顶点可以同时出现在 unit0（立面）和 unit1（烘焙图）的 binding 里，
        // 两边都写的话后写的会覆盖前者 —— 实测就是拿烘焙图的分组去算立面 UV，
        // 整块街区的烘焙照片被贴到每一面墙上。
        const garr =
          b.texUnitIndex === 0
            ? (rects[b.geoName]!.group ??= new Float32Array(geo.vertexPackage.verticesCount))
            : null;
        const darr =
          b.texUnitIndex === 0
            ? (rects[b.geoName]!.groupDim ??= new Float32Array(geo.vertexPackage.verticesCount * 3))
            : null;
        const end = Math.min(b.vertexOffset + b.vertexCount, geo.vertexPackage.verticesCount);
        for (let v = b.vertexOffset; v < end; v++) {
          arr[v * 4] = fit.x;
          arr[v * 4 + 1] = fit.y;
          arr[v * 4 + 2] = fit.w;
          arr[v * 4 + 3] = fit.h;
          if (!garr || !darr) continue;
          garr[v] = groupId;
          // 精灵的原始像素尺寸（不是裁切后的）：决定平铺时一个周期该有多大
          darr[v * 3] = sub.width;
          darr[v * 3 + 1] = sub.height;
          darr[v * 3 + 2] = wideSprite ? 1 : 0;
        }
      }
    });
  }
  return rects;
}

/* ------------------------------------------------------------------ 子图集（.texblock） */

/** `.texblock` 里的一张图集图像（同一套排布的清晰版，没有自己的 subTexInfos） */
export interface S3MBlockAtlasImage {
  id: string;
  width: number;
  height: number;
  compressType: number;
  pixelFormat: number;
  data: Uint8Array;
}

/**
 * 解析独立的 `.texblock` 子图集文件。
 *
 * S3MBLOCK 的每张根图集（level=0）都挂一个 `childTexNames`，指向同一套排布的**清晰版**：
 * 实测三对样本里，把子图集按归一化 rect 裁回来，与根图集槽位的 alpha 轮廓 IoU 0.85~1.00、
 * 色差也更低（例：48×64 槽位 37.9 vs 像素同位的 88.3），即「换图不换归一化 rect」。
 * 官方 `requestSubTextures` 里那句 `_oriTexture.arrayBufferView = tex.arrayBufferView`
 * 就是整体换图。
 *
 * 容器（与 .s3mblock 不同，实测字节严丝合缝）：
 * ```
 * uint32 count                     // 组数，实测 1
 * uint32 nameLen; String name      // "911305599.texblock"，即本文件的图集 id
 * uint32 unzipSize; uint32 zipSize
 * byte   zipData[zipSize]          // zlib
 * ```
 * 内层每条记录：
 * ```
 * uint32 compressType              // 14
 * uint32 width; uint32 height
 * uint32 pixelFormat               // 实测 13；像素数按 1 B/px 与 DXT5 吻合
 * uint32 size; byte data[size]
 * ```
 */
export async function parseS3MBlockTextureFile(
  arrayBuffer: ArrayBuffer,
  options: ParseBlockOptions = {}
): Promise<S3MBlockAtlasImage[]> {
  const inflate = options.inflate ?? defaultInflate;
  const r = new BinaryReader(arrayBuffer);
  const count = r.u32();
  if (count < 1 || count > 64) throw new Error(`[s3m] .texblock 组数异常：${count}`);
  const name = r.string();
  const unzipSize = r.u32();
  const zipSize = r.u32();
  if (r.remaining < zipSize) throw new Error(`[s3m] .texblock 声明长度 ${zipSize} 超出文件剩余 ${r.remaining}`);
  const raw = await inflate(r.bytesCopy(zipSize));
  if (raw.length !== unzipSize) {
    throw new Error(`[s3m] .texblock 解压长度不符：声明 ${unzipSize}，实际 ${raw.length}`);
  }

  const t = new BinaryReader(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength);
  const out: S3MBlockAtlasImage[] = [];
  while (t.remaining >= 20) {
    const compressType = t.u32();
    const width = t.u32();
    const height = t.u32();
    const pixelFormat = t.u32();
    const size = t.u32();
    if (!width || !height || size > t.remaining) break;
    out.push({ id: name, width, height, compressType, pixelFormat, data: t.bytesCopy(size) });
  }
  if (!out.length) throw new Error(`[s3m] .texblock ${name} 内没有可用图集`);
  return out;
}

/* ------------------------------------------------------------------ 容器 */

export async function parseS3MBlock(arrayBuffer: ArrayBuffer, options: ParseBlockOptions = {}): Promise<S3MBlockTile> {
  const { tiles } = await parseS3MBlockGroups(arrayBuffer, options);
  return tiles[0]!;
}

export interface S3MBlockGroupSet {
  /** 每组 = 一层 LOD 瓦片（最粗在前） */
  tiles: S3MBlockTile[];
  /** 每组的瓦片名（去掉 .s3mblock 后缀），与 tiles 一一对应 */
  names: string[];
}

/**
 * 解析 S3MBLOCK 容器里的**全部**组。
 *
 * 一个 `.s3mblock` 文件不是"一块瓦片"，而是**一整棵 LOD 子树的打包**。实测
 * `6_01.s3mblock`（549 KB）里有 5 组：
 *
 * ```
 * 组0 6_01.s3mblock       rv=586.8  r=293.4  child=6_0100.s3mblock
 * 组1 6_0100.s3mblock     rv=1024.0 r=293.4  child=6_010000.s3mblock
 * 组2 6_010000.s3mblock   rv=1024.0 r=338.2  child=6_01000000.s3mblock / 6_01000001.s3mblock
 * 组3 6_01000000.s3mblock rv=1024.0 r=278.2
 * 组4 6_01000001.s3mblock rv=1024.0 r=278.2
 * ```
 *
 * childTile 指向的下一层**就在同一个文件里**，不是独立文件。只取第 0 组的话，
 * 4/5 的几何与它们那份精细图集全被丢掉 —— 画面上永远只有最粗一层的
 * "整栋楼缩略图"图集，这正是"官方是窗格立面、我们是整楼照片重复"的根源。
 */
export async function parseS3MBlockGroups(
  arrayBuffer: ArrayBuffer,
  options: ParseBlockOptions = {}
): Promise<S3MBlockGroupSet> {
  const inflate = options.inflate ?? defaultInflate;
  const r = new BinaryReader(arrayBuffer);

  const blockVersion = r.f32();
  const groupCount = r.u32();
  if (groupCount < 1 || groupCount > 4096) {
    throw new Error(`[s3m] S3MBLOCK 组数异常：${groupCount}`);
  }

  const tiles: S3MBlockTile[] = [];
  const names: string[] = [];

  for (let g = 0; g < groupCount; g++) {
    const name = r.string().replace(/\.s3mblock$/i, '');
    names.push(name);

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

    // ---- 图集 → 纹理表 ----
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
        flipY: true,
      };
    }
    const atlasRects = buildAtlasRects(geoPackage, texturePackage);

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

    tiles.push({
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
      atlasRects,
    });
  }

  return { tiles, names };
}
