/**
 * S3M 纹理 → three.js Texture
 *
 * 解码本体已下沉到 core/TextureDecode.ts（three 无关，主线程 / Worker 共用），
 * 本文件只负责两件事：
 *   1. 优先把解码派给 Worker（setTextureOffThreadDecode 注入，S3MViewer 装配），
 *      Worker 不可用时用同一份 decodeTextureData 在主线程兜底；
 *   2. 把纯数据解码产物包成 three Texture 并按 atlas / 普通 分别配置采样参数。
 */
import * as THREE from 'three';
import type { S3MTexture } from '../core/types.js';
import { decodeTextureData, textureDecodeIsTrivial } from '../core/TextureDecode.js';
import { queueBandedUpload, shouldBandTexture } from './AtlasUpload.js';
import type { DecodedTextureData } from '../core/TextureDecode.js';

export { PixelFormat } from '../core/TextureFormat.js';

/** 由 S3MLayer 在拿到 GL 上下文后注入，用于斜视角下保持纹理清晰 */
let maxAnisotropy = 1;

/**
 * 各向异性过滤的**上限**（默认 Infinity = 不封顶，取 GPU 报的最大值）。
 *
 * 各向异性对斜视角立面清晰度的提升比提高分辨率更直接，所以默认全量启用；
 * 但它每像素要多采样，移动端 GPU 上封到 4 或 8 通常肉眼无差、成本明显下降。
 * 由 `setMaxAnisotropy(gpuMax, cap)` 一起注入，接入方通过 `anisotropyCap` 配置。
 */
let anisotropyCap = Infinity;

export function setMaxAnisotropy(n: number, cap = Infinity): void {
  maxAnisotropy = Math.max(1, n | 0);
  anisotropyCap = Number.isFinite(cap) && cap > 0 ? Math.max(1, cap) : Infinity;
}

/**
 * 单次创建的纹理参数。三项都可缺省 —— 缺省时读模块级默认（`setSrgbTextureDecode`
 * / `setMaxTextureSize` / `setAnisotropyCap`），所以老调用方行为逐字不变。
 *
 * 图层级隔离靠这条：`S3MLayer` 把自己的渲染 profile 透传进来，不再共享模块级状态。
 */
export interface TextureCreateOptions {
  /** 是否做 sRGB 解码（默认读 `getSrgbTextureDecode()`）。`'direct'` 管线传 false */
  srgbDecode?: boolean;
  /** 长边像素上限（默认读 `setMaxTextureSize` 的值）。图集恒不缩放 */
  maxSize?: number;
  /** 各向异性上限（默认读 `setAnisotropyCap` 的值）。Infinity = 取 GPU 最大值 */
  anisotropyCap?: number;
}

/** 把「上限」解析成实际的 anisotropy 值（GPU 最大值与 cap 取小） */
function resolveAnisotropy(cap: number): number {
  return Number.isFinite(cap) && cap > 0 ? Math.min(maxAnisotropy, Math.max(1, cap)) : maxAnisotropy;
}

/**
 * 把各向异性上限**即时应用**到一批已上传的纹理。
 *
 * `anisotropy` 是采样参数，不需要重新解码 —— 改值 + `needsUpdate` 让 three 重传一次
 * 即可，代价远小于重载瓦片。图集纹理（`configureAtlas` 打过 `s3mNoAniso` 标记）
 * 保持 1：它关了 mip、靠子区域 rect 自己算层级，开各向异性会把相邻子区域混进来。
 */
export function applyAnisotropyCap(textures: Iterable<THREE.Texture>, cap: number): void {
  const n = resolveAnisotropy(cap);
  for (const tex of textures) {
    if (!tex || (tex.userData as { s3mNoAniso?: boolean })?.s3mNoAniso) continue;
    if (tex.anisotropy === n) continue;
    tex.anisotropy = n;
    tex.needsUpdate = true;
  }
}

/**
 * 单独调各向异性上限（只影响之后创建的纹理）。
 * supermap 预设会设成 1 —— 官方 iClient3D 不开各向异性，斜视角直接采高 mip
 * 平均成纯色；我们默认拉满（Infinity）是为了倾斜摄影立面清晰度，代价是
 * 米制平铺纹理的远处高频纹（点阵/砖缝）被硬保下来，怎么调光照都"不像官方"。
 */
export function setAnisotropyCap(cap: number): void {
  anisotropyCap = Number.isFinite(cap) && cap > 0 ? Math.max(1, cap) : Infinity;
}

/**
 * 纹理长边像素上限（默认 Infinity = 不限制）。
 * 只作用于非图集的 RGBA / WebP 产物，见 `core/TextureDecode.ts` 的 `maxSize`。
 */
let maxTextureSize = Infinity;

export function setMaxTextureSize(n: number): void {
  maxTextureSize = Number.isFinite(n) && n >= 1 ? n : Infinity;
}

/**
 * DXT 压缩直传开关（S3MViewer 在 mount / 上下文恢复时按 GL 能力注入）：
 * 需要 WEBGL_compressed_texture_s3tc 与 s3tc_srgb 两个扩展同时可用 ——
 * 纹理是 SRGBColorSpace，缺 srgb 变体会出现贴图发白的颜色失配。
 * 移动端大多没有 s3tc，自动回退 Worker 解码成 RGBA 上传，行为同旧版。
 */
let compressedTexturesSupported = false;

export function setCompressedTexturesSupported(v: boolean): void {
  compressedTexturesSupported = v;
}

export interface DecodedTexture {
  texture: THREE.Texture | null;
  /** 实际走的解码路径，`unsupported(26)` 这类值会进 stats.skipped */
  decoded: string;
}

/**
 * 注入「离线解码」实现（S3MViewer 装配：走共享解析 Worker）。
 * 返回 null = Worker 不可用 / 崩溃，createTexture 自动退回主线程 decodeTextureData。
 * `maxSize` 一并带过去，缩放也在 Worker 里做（同样是 CPU 活）。
 */
let offThreadDecode:
  | ((
      tex: S3MTexture,
      compressed: boolean,
      maxSize?: number,
      opts?: { allowCompressedFlipY?: boolean; onlyLevel0?: boolean }
    ) => Promise<DecodedTextureData | null>)
  | null = null;

export function setTextureOffThreadDecode(
  fn:
    | ((
        tex: S3MTexture,
        compressed: boolean,
        maxSize?: number,
        opts?: { allowCompressedFlipY?: boolean; onlyLevel0?: boolean }
      ) => Promise<DecodedTextureData | null>)
    | null
): void {
  offThreadDecode = fn;
}

async function decodeTexture(
  tex: S3MTexture,
  compressed: boolean,
  maxSize: number,
  extra: { allowCompressedFlipY?: boolean; onlyLevel0?: boolean } = {}
): Promise<DecodedTextureData> {
  const options = { compressed, maxSize, ...extra };
  // 「一次 memcpy 就完事」的纹理不走 Worker。
  //
  // 这类纹理（RGBA8 直排、不翻行、长度精确、不需缩图）在 CBD 场景占纹理字节的
  // 99.9%，但发去 Worker 要先把整块 data structured clone 过去（3.4 MB/张，
  // 实测合计 2.5 GB / 2.9 秒主线程时间），Worker 那边也只是复制一遍再传回来。
  // 本地用原生 memcpy 出同样的字节，两张拷贝都省掉。
  //
  // 判据不满足时一切照旧 —— 仍优先 Worker，Worker 不可用再主线程兜底。
  if (offThreadDecode && !textureDecodeIsTrivial(tex, { maxSize })) {
    const viaWorker = await offThreadDecode(tex, compressed, maxSize, extra);
    if (viaWorker) return viaWorker;
  }
  return decodeTextureData(tex, options);
}

/**
 * 纹理是否做 sRGB→linear 解码。
 *
 * 默认 true（three 线性 PBR 管线的正确姿势）。`lightingPreset: 'supermap'` 会关掉它：
 * 官方 iClient3D 把贴图字节值**不解码**直接进 shader、在 sRGB 数值空间做 Lambert 直乘，
 * 要逐像素对齐就得让字节值原样进来（输出端由 StyleMaterial 的 S3M_DIRECT_COLOR 抵消）。
 */
let srgbTextureDecode = true;

/** 切换纹理解码（只影响之后创建的纹理，已上传 GPU 的不受影响） */
export function setSrgbTextureDecode(v: boolean): void {
  srgbTextureDecode = v;
}

export function getSrgbTextureDecode(): boolean {
  return srgbTextureDecode;
}

function configure<T extends THREE.Texture>(tex: T, srgb = true, opts: TextureCreateOptions = {}): T {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // 各向异性过滤对斜视角立面清晰度的提升比提高分辨率更直接
  tex.anisotropy = resolveAnisotropy(opts.anisotropyCap ?? anisotropyCap);
  if (srgb && (opts.srgbDecode ?? srgbTextureDecode)) tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * S3MBLOCK 图集专用：关掉 GPU mip。
 *
 * 官方 `sampleLod` 是显式 `textureLod(tex, uv, 0.0)`，层级靠「把子区域 rect 平移 +
 * 内缩」自己算（见 StyleMaterial 的 s3mAtlasUnit）。若让 GPU 对整张图集生成 mip，
 * 自动选的层级会把相邻子区域混进来，远处就是一糊串色 —— 实测照抄公式但留着 GPU mip
 * 时，画面反而比不改更糟，就是因为这两个变量叠在一起了。
 */
function configureAtlas<T extends THREE.Texture>(tex: T, opts: TextureCreateOptions = {}): T {
  configure(tex, true, opts);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 1;
  // 标记给 applyAnisotropyCap：图集不吃各向异性上限（见该函数注释）
  (tex.userData as { s3mNoAniso?: boolean }).s3mNoAniso = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 图集压缩直传的**临时**开关（排查用，定位完就删）。
 *
 * 默认开。要关掉做 A/B：控制台执行
 *   localStorage.setItem('s3mNoAtlasCompressed', '1') 然后刷新
 * 恢复：localStorage.removeItem('s3mNoAtlasCompressed')。
 * 用 localStorage 而不是全局变量，是因为刷新会丢全局。
 */
function atlasCompressedEnabled(): boolean {
  const g = globalThis as { __s3mAtlasCompressed?: boolean };
  if (g.__s3mAtlasCompressed === false) return false;
  try {
    return globalThis.localStorage?.getItem('s3mNoAtlasCompressed') !== '1';
  } catch {
    return true; // 私密模式 / 无 localStorage
  }
}

export async function createTexture(
  tex: S3MTexture | null | undefined,
  opts: TextureCreateOptions = {}
): Promise<DecodedTexture> {
  if (!tex || !tex.width || !tex.height) return { texture: null, decoded: 'empty' };

  // 图集纹理（flipY 的原始 DXT 图集 / AtlasPack 拼出来的 RGBA 大图 / leaf 组合画布）都必须
  // 关 GPU mip，层级由 StyleMaterial.s3mAtlasUnit 的内联金字塔自己算。
  const isAtlas = tex.packed === true || tex.flipY === true || tex.composed === true;
  /**
   * 原始 S3MBLOCK 排版（未拼图、未组合）的图集。
   *
   * 只有这一类能用「DXT 直传 + 着色器翻行」：数据就是文件里的 DXT 块，翻行由
   * `uAtlasFlipV` 在采样时取反抵消。拼图 / leaf 画布是 JS 拼出来的 RGBA，天然没有块。
   */
  const rawAtlas = isAtlas && !tex.packed && !tex.composed;

  // 压缩直传：宿主 GL 支持即开，原始排版图集也走直传（行序交给 uAtlasFlipV 抵消）。
  const wantCompressed =
    compressedTexturesSupported && (!isAtlas || (atlasCompressedEnabled() && rawAtlas));
  // 尺寸上限同样跳过图集：UV 已重映射到子区域，缩放会让整体错位
  const sizeCap = isAtlas ? Infinity : (opts.maxSize ?? maxTextureSize);
  const data = await decodeTexture(tex, wantCompressed, sizeCap, {
    allowCompressedFlipY: rawAtlas,
    onlyLevel0: isAtlas,
  });

  if (!data.rgba && !data.blocks && !data.bitmap) {
    if (data.error) {
      // 一张纹理坏了不该带崩整个瓦片，如实上报并降级成无贴图
      console.warn('[s3m] CRN 转码失败：', data.error);
    }
    return { texture: null, decoded: data.kind };
  }

  let texture: THREE.Texture;
  if (data.bitmap) {
    texture = new THREE.Texture(data.bitmap);
  } else if (data.blocks && data.blockFormat) {
    // DXT 块直传：GPU 硬件解压，省 4~8 倍上传带宽与显存。压缩纹理不能 generateMipmaps
    // （WebGL 限制）——所以**数据自带的内联 mip 链**（官方 iClient3D 逐层上传的那条）
    // 必须切出来一起传，否则远处只有 level0 可采，高频纹/点阵全保留，永远"糊"不出
    // 官方那种平均色；s3mHasAlpha 走 alphaTest 的 DXT1 1bit alpha 历史上没开过，
    // DXT5 的 hasAlpha 由 decodeTextureData 判定
    const format =
      data.blockFormat === 'dxt1' ? THREE.RGB_S3TC_DXT1_Format : THREE.RGBA_S3TC_DXT5_Format;
    texture = new THREE.CompressedTexture(
      data.mipmaps && data.mipmaps.length > 1
        ? data.mipmaps.map((m) => ({ data: m.data, width: m.width, height: m.height }))
        : [{ data: data.blocks, width: data.width, height: data.height }],
      data.width,
      data.height,
      format,
      THREE.UnsignedByteType
    );
  } else {
    const dt = new THREE.DataTexture(data.rgba!, data.width, data.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    if (data.hasAlpha) dt.userData.s3mHasAlpha = true;
    texture = dt;
  }
  texture.needsUpdate = true;
  // 原始图集走压缩直传：**不需要任何行序修正**。
  //
  // DXTTextureDecode 解块时内置了一次 flipY，TextureDecode 又按 tex.flipY 翻一次，
  // 两次抵消 —— 解成 RGBA 的结果与块序逐字节相同，所以压缩上传与旧的 RGBA 上传同向。
  // （曾按「块是底朝上」在着色器里镜像 v，结果桥面整片错位；GPU 实测同向差 0、镜像差 200+。）
  if (isAtlas && rawAtlas && data.blocks) {
    // 镂空语义沿用旧口径：解成 RGBA 时 DataTexture 会置 s3mHasAlpha（DXT5 才有 alpha），
    // 直传后必须保持一样，否则图集的 alphaTest 会静默消失。
    if (data.hasAlpha) (texture.userData as { s3mHasAlpha?: boolean }).s3mHasAlpha = true;
  }
  const configured = isAtlas ? configureAtlas(texture, opts) : configure(texture, true, opts);
  if (data.blocks) {
    configured.generateMipmaps = false;
    // 带链 → 三线性取链上高层级（官方同款平均效果）；纯 level0 才退回 Linear 兜底
    configured.minFilter =
      data.mipmaps && data.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  }
  // RGBA 图集（拼图 / leaf 画布 / 无 s3tc 时的回退）走分带上传：先分配存储，
  // 再按行带逐帧 texSubImage2D。避免一张几十 MB 的图集在某一帧里同步灌进显存。
  // 压缩直传的图集没有这段开销（DXT 只有 RGBA 的 1/4~1/8），也就没必要分带。
  // RGBA 图集（拼图 / leaf 画布 / 无 s3tc 时的回退）走分带上传：先分配存储，
  // 再按行带逐帧 texSubImage2D。unpack 状态每次都会重设（见 AtlasUpload.prepareUnpack），
  // 否则中间夹一次别的纹理上传，行带就会被竖着翻——那正是「同一块花纹重复」的来源。
  if (isAtlas && !data.blocks && data.rgba && shouldBandTexture(configured, data.rgba.byteLength)) {
    queueBandedUpload(configured as THREE.DataTexture);
  }
  // flipY 为真即 S3MBLOCK 图集（见 core/types.ts），必须无 mip
  return { texture: configured, decoded: data.kind };
}
