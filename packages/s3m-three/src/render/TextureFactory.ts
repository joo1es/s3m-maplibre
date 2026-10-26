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

export function setMaxAnisotropy(n: number): void {
  maxAnisotropy = Math.max(1, n | 0);
}

export interface DecodedTexture {
  texture: THREE.Texture | null;
  /** 实际走的解码路径，`unsupported(26)` 这类值会进 stats.skipped */
  decoded: string;
}

/**
 * 注入「离线解码」实现（S3MViewer 装配：走共享解析 Worker）。
 * 返回 null = Worker 不可用 / 崩溃，createTexture 自动退回主线程 decodeTextureData。
 */
let offThreadDecode: ((tex: S3MTexture) => Promise<DecodedTextureData | null>) | null = null;

export function setTextureOffThreadDecode(
  fn: ((tex: S3MTexture) => Promise<DecodedTextureData | null>) | null
): void {
  offThreadDecode = fn;
}

async function decodeTexture(tex: S3MTexture): Promise<DecodedTextureData> {
  if (offThreadDecode) {
    const viaWorker = await offThreadDecode(tex);
    if (viaWorker) return viaWorker;
  }
  return decodeTextureData(tex);
}

function configure<T extends THREE.Texture>(tex: T, srgb = true): T {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // 各向异性过滤对斜视角立面清晰度的提升比提高分辨率更直接
  tex.anisotropy = maxAnisotropy;
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

  const data = await decodeTexture(tex);

  if (!data.rgba && !data.bitmap) {
    if (data.error) {
      // 一张纹理坏了不该带崩整个瓦片，如实上报并降级成无贴图
      console.warn('[s3m] CRN 转码失败：', data.error);
    }
    return { texture: null, decoded: data.kind };
  }

  let texture: THREE.Texture;
  if (data.bitmap) {
    texture = new THREE.Texture(data.bitmap);
  } else {
    const dt = new THREE.DataTexture(data.rgba!, data.width, data.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    if (data.hasAlpha) dt.userData.s3mHasAlpha = true;
    texture = dt;
  }
  texture.needsUpdate = true;
  // flipY 为真即 S3MBLOCK 图集（见 core/types.ts），必须无 mip
  return { texture: isAtlas ? configureAtlas(texture) : configure(texture), decoded: data.kind };
}
