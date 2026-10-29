/**
 * 深度图回读的数学部分：解包 + 反投影。
 *
 * GPU 那边只能把深度渲染成 RGBA8（three 的 `RGBADepthPacking`），
 * 回读到 CPU 后要还原成 0~1 的窗口深度，再反投影成世界坐标 —— 这两步都在这里，
 * 与 WebGL 无关，可以用构造出来的矩阵直接单测。
 *
 * 打包/解包的常数照抄 three 的 `packing.glsl.js`，不要自己改：
 * 改一个常数，回读出来的深度就会整体偏移，而画面看起来完全正常。
 */
import type { Vec3 } from './measure.js';

/** three: `PackUpscale = 256 / 255` */
const PACK_UPSCALE = 256 / 255;
/** three: `UnpackDownscale = 255 / 256` */
const UNPACK_DOWNSCALE = 255 / 256;
/** three: `ShiftRight8 = 1 / 256` */
const SHIFT_RIGHT_8 = 1 / 256;
/** three: `PackFactors = (1, 256, 65536, 16777216)` */
const PACK_FACTOR_A = 16777216;

/**
 * 把 0~1 的深度按 three 的 `RGBADepthPacking` 打包成 4 个字节（0~255）。
 *
 * 严格照抄 `packing.glsl.js` 的 `packDepthToRGBA`，**不要凭直觉改**：
 * - `v <= 0` 返回全黑、`v >= 1` 返回**全白**（这两条特判是精度链条的一部分，
 *   也正好让「远平面」和「清屏白」解包出来都是 1.0，背景判定因此简单）；
 * - 中间值是 `modf` 链拆出来的 32 位定点，通道顺序是 (粗 → 细) 的 r/g/b/a。
 *
 * 精度：解包误差约 1e-5（受 g 通道 8 位量化限制），换算成 141m 处的位置误差约 0.2m。
 */
export function packRGBADepth(depth: number): [number, number, number, number] {
  const v = Math.min(1, Math.max(0, depth));
  if (v <= 0) return [0, 0, 0, 0];
  if (v >= 1) return [255, 255, 255, 255];

  const af = modf(v * PACK_FACTOR_A);
  const b = modf(af.int * SHIFT_RIGHT_8);
  const g = modf(b.int * SHIFT_RIGHT_8);

  const toByte = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
  return [
    // r = floor(v*256)/255 —— 乘回 255 就是整数本身
    toByte(g.int / 255),
    toByte(g.frac * PACK_UPSCALE),
    toByte(b.frac * PACK_UPSCALE),
    toByte(af.frac),
  ];
}

/**
 * 解包：RGBA 四个字节 → 0~1 的窗口深度（0 = 近平面，1 = 远平面 / 背景）。
 *
 * 与 `packing.glsl.js` 的 `unpackRGBAToDepth` 同式：
 * `dot(rgba, (UnpackDownscale/1, UnpackDownscale/256, UnpackDownscale/65536, 1/2^24))`。
 *
 * @param rgba 回读出来的像素缓冲
 * @param offset 字节偏移（第 i 个像素就是 i*4）
 */
export function unpackRGBADepth(rgba: ArrayLike<number>, offset = 0): number {
  const r = rgba[offset]! / 255;
  const g = rgba[offset + 1]! / 255;
  const b = rgba[offset + 2]! / 255;
  const a = rgba[offset + 3]! / 255;
  return (
    r * UNPACK_DOWNSCALE +
    g * (UNPACK_DOWNSCALE / 256) +
    b * (UNPACK_DOWNSCALE / 65536) +
    a / PACK_FACTOR_A
  );
}

/** GLSL `modf`：返回小数部分，整数部分写进 `int` */
function modf(x: number): { frac: number; int: number } {
  const int = Math.floor(x);
  return { frac: x - int, int };
}

/**
 * NDC + 窗口深度 → 世界坐标。
 *
 * @param ndcX -1~1（屏幕左侧到右侧）
 * @param ndcY -1~1（屏幕底部到顶部；注意与像素行号反向）
 * @param depth01 0~1 的窗口深度
 * @param inverseViewProj 视图投影矩阵的逆（列主序 16 元，与 `THREE.Matrix4.elements` 同序）
 */
export function unprojectNdc(
  ndcX: number,
  ndcY: number,
  depth01: number,
  inverseViewProj: ArrayLike<number>
): Vec3 {
  const z = depth01 * 2 - 1;
  const m = inverseViewProj;
  const x = m[0]! * ndcX + m[4]! * ndcY + m[8]! * z + m[12]!;
  const y = m[1]! * ndcX + m[5]! * ndcY + m[9]! * z + m[13]!;
  const zz = m[2]! * ndcX + m[6]! * ndcY + m[10]! * z + m[14]!;
  const w = m[3]! * ndcX + m[7]! * ndcY + m[11]! * z + m[15]!;
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 1;
  return [x * iw, y * iw, zz * iw];
}

/** 像素坐标（左上角为 0,0）→ NDC */
export function pixelToNdc(px: number, py: number, width: number, height: number): [number, number] {
  return [((px + 0.5) / width) * 2 - 1, 1 - ((py + 0.5) / height) * 2];
}

/**
 * 把「观察点 → 目标点」拆成方位角 / 仰角（度）。
 *
 * 方位角：0 = 正北，顺时针增大（与地图 bearing 一致），ENU 下 x 向东、y 向北。
 * 仰角：0 = 水平，正值向上，负值向下。
 */
export function azimuthElevation(
  from: Vec3,
  to: Vec3
): { azimuth: number; elevation: number; distance: number } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const horizontal = Math.hypot(dx, dy);
  const distance = Math.hypot(horizontal, dz);
  const azimuth = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  const elevation = (Math.atan2(dz, horizontal) * 180) / Math.PI;
  return { azimuth, elevation, distance };
}
