import DXTTextureDecode from './DXTTextureDecode.js';

/**
 * 把「一个块里的多张图集」合并成一张。
 *
 * 为什么必须合并：S3MBLOCK 的一个 geo（= 一个网格）里，不同顶点区间可以绑定到**不同的图集**
 * （实测 41_00.s3mblock 里 6 张图集，尺寸 120x144 / 192x128 / 216x288 …，各自的 subTexInfo
 * 绑定不同的 vertexOffset 区间）。而我们的材质只有一个 `map`，只能喂一张图 ——
 * 其它图集那部分顶点就会拿着「自己图集里的归一化坐标」去采另一张图集，采到的是完全无关的
 * 内容（表现就是墙上贴着别处的立面照）。
 *
 * 官方用的是纹理数组（着色器里 `atlas_batchTable_xywh(batchId, batchTextureAtlas, …)` +
 * `uTexAtlasDim` 复数形式），每个 batch 自己带图集序号。这里用等价但更省事的做法：
 * 解析阶段把所有图集按「货架」拼进一张大图，rect 全部换算到这张大图的坐标系，
 * 于是单张 map 就够用了。
 *
 * 坐标系约定：拼图按**自上而下**的行序存放，并让纹理 `flipY = false`，
 * 也就是 UV 的 v=0 对应图片顶行 —— 这样 rect 的 y 直接用 `offsetY / height` 即可。
 */

interface AtlasLike {
  id?: string;
  width: number;
  height: number;
  pixelFormat: number;
  compressType: number;
  data?: Uint8Array | null;
}

export interface PackedAtlases {
  width: number;
  height: number;
  data: Uint8Array;
  /** 图集 id → 它在拼图里的左上角像素坐标 */
  offsets: Map<string, { x: number; y: number }>;
}

/** 解出图集 RGBA（自上而下，不翻转）。非 DXT 或解码失败返回 null。 */
function decodeAtlasRGBA(tex: AtlasLike): Uint8Array | null {
  if (!tex.data || !tex.width || !tex.height) return null;
  const ct = tex.compressType;
  const isDxt =
    ct === 12 || ct === 13 || ct === 14 || ct === 17 || ct === 19 || ct === 20 || ct === 21 || tex.pixelFormat >= 17;
  if (!isDxt) return null;
  const out = new Uint8Array(tex.width * tex.height * 4);
  try {
    DXTTextureDecode.decode(out, tex.width, tex.height, tex.data, tex.pixelFormat);
  } catch {
    return null;
  }
  return out;
}

/**
 * 合并一个块里的全部图集。只有一张图集时返回 null（没必要合并，也避免多一次解码）。
 */
export function packAtlases(tp: Record<string, AtlasLike>): PackedAtlases | null {
  const entries = Object.entries(tp).filter(([, t]) => t.data && t.width > 0 && t.height > 0);
  if (entries.length < 2) return null;

  const images = new Map<string, { w: number; h: number; rgba: Uint8Array }>();
  for (const [key, tex] of entries) {
    const rgba = decodeAtlasRGBA(tex);
    if (!rgba) return null; // 有一张解不出来就整体放弃，保持原样比拼错强
    images.set(key, { w: tex.width, h: tex.height, rgba });
  }

  // 货架式装箱：按宽度累加，超宽换行。图集都是小块，这样做足够紧凑。
  const MAX_W = 1024;
  let x = 0;
  let y = 0;
  let rowH = 0;
  let usedW = 0;
  const offsets = new Map<string, { x: number; y: number }>();
  for (const [id, img] of images) {
    if (x > 0 && x + img.w > MAX_W) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    offsets.set(id, { x, y });
    x += img.w;
    rowH = Math.max(rowH, img.h);
    usedW = Math.max(usedW, x);
  }
  const W = Math.max(1, usedW);
  const H = Math.max(1, y + rowH);
  const data = new Uint8Array(W * H * 4);

  for (const [id, img] of images) {
    const off = offsets.get(id)!;
    for (let row = 0; row < img.h; row++) {
      const src = row * img.w * 4;
      data.set(img.rgba.subarray(src, src + img.w * 4), ((off.y + row) * W + off.x) * 4);
    }
  }

  return { width: W, height: H, data, offsets };
}
