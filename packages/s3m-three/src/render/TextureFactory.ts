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
import { decodeTextureData } from '../core/TextureDecode.js';
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
  | ((tex: S3MTexture, compressed: boolean, maxSize?: number) => Promise<DecodedTextureData | null>)
  | null = null;

export function setTextureOffThreadDecode(
  fn: ((tex: S3MTexture, compressed: boolean, maxSize?: number) => Promise<DecodedTextureData | null>) | null
): void {
  offThreadDecode = fn;
}

async function decodeTexture(
  tex: S3MTexture,
  compressed: boolean,
  maxSize: number
): Promise<DecodedTextureData> {
  if (offThreadDecode) {
    const viaWorker = await offThreadDecode(tex, compressed, maxSize);
    if (viaWorker) return viaWorker;
  }
  return decodeTextureData(tex, { compressed, maxSize });
}

function configure<T extends THREE.Texture>(tex: T, srgb = true): T {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // 各向异性过滤对斜视角立面清晰度的提升比提高分辨率更直接
  tex.anisotropy = anisotropyCap === Infinity ? maxAnisotropy : Math.min(maxAnisotropy, anisotropyCap);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
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
function configureAtlas<T extends THREE.Texture>(tex: T): T {
  configure(tex);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  return tex;
}

export async function createTexture(tex: S3MTexture | null | undefined): Promise<DecodedTexture> {
  if (!tex || !tex.width || !tex.height) return { texture: null, decoded: 'empty' };

  // 图集纹理（flipY 的原始 DXT 图集 / AtlasPack 拼出来的 RGBA 大图 / leaf 组合画布）都必须
  // 关 GPU mip，层级由 StyleMaterial.s3mAtlasUnit 的内联金字塔自己算。
  const isAtlas = tex.packed === true || tex.flipY === true || tex.composed === true;

  // 压缩直传只在「宿主 GL 支持 + 非图集」时开：图集要 flipY / 无 mip，压缩上传做不了翻行
  const wantCompressed = compressedTexturesSupported && !isAtlas;
  // 尺寸上限同样跳过图集：UV 已重映射到子区域，缩放会让整体错位
  const sizeCap = isAtlas ? Infinity : maxTextureSize;
  const data = await decodeTexture(tex, wantCompressed, sizeCap);

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
    // （WebGL 限制），远处靠 LinearFilter 兜底；s3mHasAlpha 走 alphaTest 的 DXT1 1bit
    // alpha 历史上没开过，DXT5 的 hasAlpha 由 decodeTextureData 判定
    const format =
      data.blockFormat === 'dxt1' ? THREE.RGB_S3TC_DXT1_Format : THREE.RGBA_S3TC_DXT5_Format;
    texture = new THREE.CompressedTexture(
      [{ data: data.blocks, width: data.width, height: data.height }],
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
  const configured = isAtlas ? configureAtlas(texture) : configure(texture);
  if (data.blocks) {
    configured.generateMipmaps = false;
    configured.minFilter = THREE.LinearFilter;
  }
  // flipY 为真即 S3MBLOCK 图集（见 core/types.ts），必须无 mip
  return { texture: configured, decoded: data.kind };
}
