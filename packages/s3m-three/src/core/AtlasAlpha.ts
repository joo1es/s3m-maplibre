import DXTTextureDecode from './DXTTextureDecode.js';

/**
 * 解出图集的 alpha 掩码（1 B/像素）。只对 DXT 图集做，其它格式返回 null。
 *
 * 用途：图集里的每个精灵是「建筑立面 + 上方天空」的一整块照片，天空是 alpha=0。
 * 官方材质 alphaMode 全是 opaque，说明它拿到的精灵本来就没有天空 —— 也就是
 * **rect 只框立面本体**。我们手里的 rect 是"照片块"，所以用掩码把它收缩到
 * 不透明包围盒，等价于官方那份裁好的 rect。
 */
export function atlasAlphaMask(tex: {
  width: number;
  height: number;
  pixelFormat: number;
  compressType: number;
  data: Uint8Array | null;
}): Uint8Array | null {
  if (!tex.data || !tex.width || !tex.height) return null;
  const ct = tex.compressType;
  const isDxt = ct === 14 || ct === 13 || ct === 12 || ct === 17 || ct === 19 || ct === 20 || ct === 21 || tex.pixelFormat >= 17;
  if (!isDxt) return null;
  // compressType 14 → DXT5（pixelFormat 13），见 TextureFormat.ts 的说明
  const pf = ct === 14 ? 21 : tex.pixelFormat;
  if (pf !== 19 && pf !== 20 && pf !== 21) return null; // 只有带 alpha 的格式值得做
  const w = tex.width;
  const h = tex.height;
  const rgba = new Uint8Array(w * h * 4);
  try {
    DXTTextureDecode.decode(rgba, w, h, tex.data, pf);
  } catch {
    return null;
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = rgba[i * 4 + 3]!;
  return mask;
}

/**
 * 把 rect（uv 空间、y 向上的归一化矩形）收缩到掩码里的不透明包围盒。
 * 找不到不透明像素时原样返回，避免把合法 rect 弄成退化矩形。
 */
export function shrinkRectToOpaque(
  rect: { x: number; y: number; w: number; h: number },
  mask: Uint8Array | null,
  W: number,
  H: number
): { x: number; y: number; w: number; h: number } {
  if (!mask) return rect;
  const px0 = Math.max(0, Math.floor(rect.x * W));
  const px1 = Math.min(W, Math.ceil((rect.x + rect.w) * W));
  // rect.y 是 uv 空间（0 在底部），掩码是图像空间（0 在顶部）
  const py0 = Math.max(0, Math.floor(rect.y * H));
  const py1 = Math.min(H, Math.ceil((rect.y + rect.h) * H));
  if (px1 <= px0 || py1 <= py0) return rect;

  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (let py = py0; py < py1; py++) {
    const iy = H - 1 - py;
    if (iy < 0) continue;
    for (let px = px0; px < px1; px++) {
      if (mask[iy * W + px]! <= 8) continue;
      if (px < bx0) bx0 = px;
      if (px > bx1) bx1 = px;
      if (py < by0) by0 = py;
      if (py > by1) by1 = py;
    }
  }
  if (!(bx1 >= bx0) || !(by1 >= by0)) return rect;

  // 内缩半像素，避开边缘的混色 alpha
  const x0 = bx0;
  const x1 = bx1 + 1;
  const y0 = by0;
  const y1 = by1 + 1;
  const eps = 0.5;
  return {
    x: (x0 + eps) / W,
    w: Math.max(1 / W, (x1 - x0 - 2 * eps) / W),
    y: (y0 + eps) / H,
    h: Math.max(1 / H, (y1 - y0 - 2 * eps) / H),
  };
}
