/**
 * DXT1 / DXT3 / DXT5 纹理解码（squish 算法的 JS 移植）
 *
 * 来源：SuperMap iClient3D S3M SDK（Apache-2.0）。
 * 迁移到 TS 时做了三件事，算法本身未改：
 *   1. 补齐类型；
 *   2. 修掉 `DecompressAlphaDxt3` 里把 `block` 误写成未定义全局 `bytes` 的笔误
 *      （DXT3 纹理此前会直接 ReferenceError）；
 *   3. 修掉 `DecompressImage565` 的两处 flipY 笔误（见下方函数内注释：
 *      块行下标少减 1 让 format ≤ 11 的 DXT1 顶部块行整行变黑；块内 4 行
 *      没倒着写，导致行序和 `DecompressImage` 主路径对不上）。
 */

const kDxt1 = 1 << 0;
const kDxt3 = 1 << 1;
const kDxt5 = 1 << 2;
const krgb565 = 1 << 5;

function Unpack565(packed0: number, packed1: number, colour: Uint8Array, offset: number): number {
  const value = packed0 | (packed1 << 8);

  const red = (value >> 11) & 0x1f;
  const green = (value >> 5) & 0x3f;
  const blue = value & 0x1f;

  colour[offset + 0] = (red << 3) | (red >> 2);
  colour[offset + 1] = (green << 2) | (green >> 4);
  colour[offset + 2] = (blue << 3) | (blue >> 2);
  colour[offset + 3] = 255;

  return value;
}

function DecompressColour(rgba: Uint8Array, block: Uint8Array, nOffset: number, isDxt1: boolean): void {
  const codes = new Uint8Array(16);

  const a = Unpack565(block[nOffset + 0], block[nOffset + 1], codes, 0);
  const b = Unpack565(block[nOffset + 2], block[nOffset + 3], codes, 4);

  for (let i = 0; i < 3; i++) {
    const c = codes[i];
    const d = codes[4 + i];

    if (isDxt1 && a <= b) {
      codes[8 + i] = (c + d) / 2;
      codes[12 + i] = 0;
    } else {
      codes[8 + i] = (2 * c + d) / 3;
      codes[12 + i] = (c + 2 * d) / 3;
    }
  }

  codes[8 + 3] = 255;
  codes[12 + 3] = isDxt1 && a <= b ? 0 : 255;

  const indices = new Uint8Array(16);
  for (let i = 0; i < 4; ++i) {
    const packed = block[nOffset + 4 + i];

    indices[4 * i + 0] = packed & 0x3;
    indices[4 * i + 1] = (packed >> 2) & 0x3;
    indices[4 * i + 2] = (packed >> 4) & 0x3;
    indices[4 * i + 3] = (packed >> 6) & 0x3;
  }

  for (let i = 0; i < 16; ++i) {
    const offset = 4 * indices[i];
    for (let j = 0; j < 4; ++j) rgba[4 * i + j] = codes[offset + j];
  }
}

function DecompressAlphaDxt3(rgba: Uint8Array, block: Uint8Array, nOffset: number): void {
  // unpack the alpha values pairwise
  for (let i = 0; i < 8; ++i) {
    // quantise down to 4 bits
    const quant = block[nOffset + i];

    // unpack the values
    const lo = quant & 0x0f;
    const hi = quant & 0xf0;

    // convert back up to bytes
    rgba[8 * i + 3] = lo | (lo << 4);
    rgba[8 * i + 7] = hi | (hi >> 4);
  }
}

function DecompressAlphaDxt5(rgba: Uint8Array, block: Uint8Array, start: number): void {
  const alpha0 = block[start + 0];
  const alpha1 = block[start + 1];

  const codes = new Uint8Array(8);

  codes[0] = alpha0;
  codes[1] = alpha1;
  if (alpha0 <= alpha1) {
    // use 5-alpha codebook
    for (let i = 1; i < 5; ++i) codes[1 + i] = ((5 - i) * alpha0 + i * alpha1) / 5;
    codes[6] = 0;
    codes[7] = 255;
  } else {
    // use 7-alpha codebook
    for (let i = 1; i < 7; ++i) codes[1 + i] = ((7 - i) * alpha0 + i * alpha1) / 7;
  }

  const indices = new Uint8Array(16);
  let nOffset = start + 2;
  let nBegin = 0;
  for (let i = 0; i < 2; ++i) {
    // grab 3 bytes
    let value = 0;
    for (let j = 0; j < 3; ++j) {
      const byte = block[nOffset++];
      value |= byte << (8 * j);
    }

    // unpack 8 3-bit values from it
    for (let j = 0; j < 8; ++j) {
      const index = (value >> (3 * j)) & 0x7;
      indices[nBegin++] = index;
    }
  }

  for (let i = 0; i < 16; ++i) rgba[4 * i + 3] = codes[indices[i]];
}

function Decompress(rgba: Uint8Array, block: Uint8Array, nOffset: number, flags: number): void {
  let nOffset2 = 0;
  if ((flags & (kDxt3 | kDxt5)) !== 0) nOffset2 = 8;

  DecompressColour(rgba, block, nOffset + nOffset2, (flags & kDxt1) !== 0);

  if ((flags & kDxt3) !== 0) {
    DecompressAlphaDxt3(rgba, block, nOffset);
  } else if ((flags & kDxt5) !== 0) {
    DecompressAlphaDxt5(rgba, block, nOffset);
  }
}

/** 把 block 视为 uint16 数组：DXT1 的 565 快路径需要按 16 位读 */
function asU16(view: Uint8Array): Uint16Array {
  const start = view.byteOffset & ~1;
  const len = (view.byteLength + (view.byteOffset & 1)) >> 1;
  return new Uint16Array(view.buffer, start, len);
}

function DecompressImage565(rgb565: Uint16Array, width: number, height: number, blocks: Uint16Array): Uint16Array {
  const c = new Uint16Array(4);
  const dst = rgb565;
  let m = 0;
  let dstI = 0;
  let i = 0;
  let r0 = 0;
  let g0 = 0;
  let b0 = 0;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  const blockWidth = width / 4;
  const blockHeight = height / 4;
  for (let blockY = 0; blockY < blockHeight; blockY++) {
    for (let blockX = 0; blockX < blockWidth; blockX++) {
      // flipY 分两级做，才和 DecompressImage 的 height - 1 - sy 真正同口径：
      //   ① 块行倒着取（blockHeight - 1 - blockY）；
      //   ② 块内 4 行也倒着写（下面 dstI 从块底行起、逐行 -= width）。
      // 只做 ① 会变成「块带倒序、带内行正序」的错位图，和主路径对不上。
      // 写成 blockHeight - blockY 则会让 blockY=0 读到数组界外（Uint16Array 越界读
      // 得 undefined，位运算后归 0），顶部块行解成全黑、其余块行整体错位一行。
      i = 4 * ((blockHeight - 1 - blockY) * blockWidth + blockX);
      c[0] = blocks[i];
      c[1] = blocks[i + 1];
      r0 = c[0] & 0x1f;
      g0 = c[0] & 0x7e0;
      b0 = c[0] & 0xf800;
      r1 = c[1] & 0x1f;
      g1 = c[1] & 0x7e0;
      b1 = c[1] & 0xf800;
      // Interpolate between c0 and c1 to get c2 and c3.
      // 1/3 用 3/8 近似、2/3 用 5/8 近似 —— 这也是多数 GPU 硬件解码器的做法
      c[2] = ((5 * r0 + 3 * r1) >> 3) | (((5 * g0 + 3 * g1) >> 3) & 0x7e0) | (((5 * b0 + 3 * b1) >> 3) & 0xf800);
      c[3] = ((5 * r1 + 3 * r0) >> 3) | (((5 * g1 + 3 * g0) >> 3) & 0x7e0) | (((5 * b1 + 3 * b0) >> 3) & 0xf800);
      m = blocks[i + 2];
      // 块内第 0 行写到块底行，逐行往上走 —— 逐行 flipY
      dstI = (blockY * 4 + 3) * width + blockX * 4;
      dst[dstI] = c[m & 0x3];
      dst[dstI + 1] = c[(m >> 2) & 0x3];
      dst[dstI + 2] = c[(m >> 4) & 0x3];
      dst[dstI + 3] = c[(m >> 6) & 0x3];
      dstI -= width;
      dst[dstI] = c[(m >> 8) & 0x3];
      dst[dstI + 1] = c[(m >> 10) & 0x3];
      dst[dstI + 2] = c[(m >> 12) & 0x3];
      dst[dstI + 3] = c[(m >> 14) & 0x3];
      m = blocks[i + 3];
      dstI -= width;
      dst[dstI] = c[m & 0x3];
      dst[dstI + 1] = c[(m >> 2) & 0x3];
      dst[dstI + 2] = c[(m >> 4) & 0x3];
      dst[dstI + 3] = c[(m >> 6) & 0x3];
      dstI -= width;
      dst[dstI] = c[(m >> 8) & 0x3];
      dst[dstI + 1] = c[(m >> 10) & 0x3];
      dst[dstI + 2] = c[(m >> 12) & 0x3];
      dst[dstI + 3] = c[(m >> 14) & 0x3];
    }
  }
  return dst;
}

/**
 * 解压整张 DXT 图。
 *
 * 解出的像素按 `{ r1,g1,b1,a1, ... , rn,gn,bn,an }`（n = width*height）连续写入 `rgba`。
 */
function DecompressImage(rgba: Uint8Array, width: number, height: number, blocks: Uint8Array, flags: number): void {
  const bytesPerBlock = (flags & kDxt1) !== 0 ? 8 : 16;

  let nOffset = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const targetRgba = new Uint8Array(4 * 16);
      Decompress(targetRgba, blocks, nOffset, flags);

      let nOffsetTarget = 0;
      for (let py = 0; py < 4; ++py) {
        for (let px = 0; px < 4; ++px) {
          const sx = x + px;
          const sy = y + py;
          if (sx < width && sy < height) {
            // flip Y：squish 的原式是 height - 1 - sy。写成 height - sy 会让 sy = 0
            // 落到 row = height 越界（TypedArray 越界写是静默丢弃），于是缓冲区第 0 行
            // 永远是全 0（透明黑），其余行整体错位一行。
            let nBegin = 4 * (width * (height - 1 - sy) + sx);

            for (let i = 0; i < 4; ++i) rgba[nBegin++] = targetRgba[nOffsetTarget++];
          } else {
            nOffsetTarget += 4;
          }
        }
      }

      // advance
      nOffset += bytesPerBlock;
    }
  }
}

const DXTTextureDecode = {
  /**
   * @param out    输出缓冲，长度须为 width*height*4
   * @param width  像素宽
   * @param height 像素高
   * @param block  压缩块
   * @param format S3M pixelFormat（>11 或 5 走 DXT5，其余走 DXT1）
   */
  decode(out: Uint8Array, width: number, height: number, block: Uint8Array, format: number): void {
    if (out == null || block == null || height === 0 || width === 0) return;

    // 块大小与 alpha 编码只由压缩格式决定：DXT1 = 8 B/块，DXT3/4/5 = 16 B/块。
    //
    // 不能再靠「format > 11」判有没有 alpha：S3MPixelFormat 里 DXT1 = 17 也 > 11，
    // 那样会把 DXT1 当 16 字节块读——512×512 的 DXT1 实际只有 131072 B（0.5 B/px），
    // 按 16 字节块要 262144 B，正好差一倍，越界部分解成全 0。
    // 官方 JS 那个判断是在「无 alpha 时纹理标成 RGB(10)/BGR(11)」的前提下才成立。
    let flags: number;
    switch (format) {
      case 17: // DXT1
        flags = kDxt1;
        break;
      case 18:
      case 19: // DXT3
        flags = kDxt3;
        break;
      case 20: // DXT4
      case 21: // DXT5
        flags = kDxt5;
        break;
      default:
        // 老数据只在 RGB / BGR / LUMINANCE_ALPHA 里出现：无 alpha 时走 DXT1 + rgb565 快路径
        flags = format > 11 || format === 5 ? kDxt5 : kDxt1 | krgb565;
    }

    if ((flags & kDxt1) !== 0 && (flags & krgb565) !== 0) {
      DecompressImage565(asU16(out), width, height, asU16(block));
    } else {
      DecompressImage(out, width, height, block, flags);
    }
  },
};

export default DXTTextureDecode;
