import { describe, expect, it } from 'bun:test';
import DXTTextureDecode from '../../packages/s3m-three/src/core/DXTTextureDecode.js';

describe('DXTTextureDecode 快路径与边界分支', () => {
  it('入参为 null 或宽高为 0 时安全返回', () => {
    const out = new Uint8Array(16 * 4);
    const block = new Uint8Array(8);

    // 不抛出异常
    expect(() => DXTTextureDecode.decode(null as any, 4, 4, block, 17)).not.toThrow();
    expect(() => DXTTextureDecode.decode(out, 4, 4, null as any, 17)).not.toThrow();
    expect(() => DXTTextureDecode.decode(out, 0, 4, block, 17)).not.toThrow();
    expect(() => DXTTextureDecode.decode(out, 4, 0, block, 17)).not.toThrow();
  });

  it('DXT1 的 a <= b 模式：启用 1-bit 透明分支', () => {
    // 构造一个 4x4 的 DXT1 block（8 字节）
    // 前 4 字节为 color0 和 color1 (RGB565 Little-Endian)
    // 设 color0 = 0x0000 (黑色), color1 = 0xffff (白色) -> color0 <= color1 触发 1-bit alpha 分支
    // 后 4 字节为 16 个 2-bit 索引：
    // index 0 -> color0
    // index 1 -> color1
    // index 2 -> (color0 + color1) / 2
    // index 3 -> transparent black (alpha = 0)
    const block = new Uint8Array(8);
    // color0 = 0x0000 (black)
    block[0] = 0x00;
    block[1] = 0x00;
    // color1 = 0xffff (white)
    block[2] = 0xff;
    block[3] = 0xff;

    // 四个像素分别指定 index 0, 1, 2, 3:
    // 第 0 个像素: 0 (color0: 黑色)
    // 第 1 个像素: 1 (color1: 白色)
    // 第 2 个像素: 2 (中间色: 灰)
    // 第 3 个像素: 3 (透明色: alpha=0)
    // 0b11_10_01_00 = 0xe4
    block[4] = 0xe4;
    block[5] = 0x00;
    block[6] = 0x00;
    block[7] = 0x00;

    const out = new Uint8Array(4 * 4 * 4);
    DXTTextureDecode.decode(out, 4, 4, block, 17); // format 17 = DXT1

    // 注意 DXTTextureDecode 对 Y 做了 flipY，第一行像素在输出缓冲的底部 (y=3)
    // row 0 的 4 个像素起始偏移：4 * (4 * (4 - 1 - 0) + x) = 4 * (12 + x)
    const p0 = (12 + 0) * 4; // index 0 (black)
    const p1 = (12 + 1) * 4; // index 1 (white)
    const p2 = (12 + 2) * 4; // index 2 (halfway)
    const p3 = (12 + 3) * 4; // index 3 (transparent)

    // p0: black, alpha 255
    expect(out[p0 + 0]).toBe(0);
    expect(out[p0 + 1]).toBe(0);
    expect(out[p0 + 2]).toBe(0);
    expect(out[p0 + 3]).toBe(255);

    // p1: white, alpha 255
    expect(out[p1 + 0]).toBe(255);
    expect(out[p1 + 1]).toBe(255);
    expect(out[p1 + 2]).toBe(255);
    expect(out[p1 + 3]).toBe(255);

    // p2: halfway gray, alpha 255
    expect(out[p2 + 0]).toBe(127);
    expect(out[p2 + 1]).toBe(127);
    expect(out[p2 + 2]).toBe(127);
    expect(out[p2 + 3]).toBe(255);

    // p3: transparent, alpha 0
    expect(out[p3 + 3]).toBe(0);
  });

  // 回归（issue #2）：DecompressImage565 的块偏移曾少减 1：
  //   原式：i = 4 * ((blockHeight - blockY) * blockWidth + blockX);
  // blockY=0 时读到 blocks 数组界外（Uint16Array 越界读得 undefined，位运算后归 0），
  // 顶部块行解成全黑、其余块行整体错位一行。修复后该用例转为常驻回归断言。
  it('format <= 11 走 rgb565 快路径 (DecompressImage565)：单块不越界', () => {
    // 标准单 block (4x4 像素) 输入，总长恰好 8 字节（4 个 uint16）
    const block = new Uint8Array(8);
    const u16Block = new Uint16Array(block.buffer, block.byteOffset, 4);
    u16Block[0] = 0x001f; // c[0]
    u16Block[1] = 0xf800; // c[1]
    u16Block[2] = 0x0000; // 索引全 0 -> 全部取 c[0]
    u16Block[3] = 0x0000;

    const out = new Uint8Array(4 * 4 * 2); // 16 pixels * 2 bytes = 32 bytes
    // format = 10 (RGB) -> default 分支且 <= 11 -> flags: kDxt1 | krgb565
    DXTTextureDecode.decode(out, 4, 4, block, 10);

    const u16Out = new Uint16Array(out.buffer, out.byteOffset, 16);
    // 正确 flipY 解码后输出的首像素应为 c[0] 即 0x001f
    expect(u16Out[0]).toBe(0x001f);
  });

  // 回归（issue #2）：8x8 = 2x2 个 DXT1 块，每块一个纯色，逐块断言，
  // 钉死「块行按 flipY 取流中第 blockHeight-1-blockY 行」的行序口径——
  // 少减 1 时顶部块行越界变黑、底行拿到的是流中底行（没翻转），两个错都抓得到。
  // 注意：每块是纯色，块内 4 行完全一样，所以这条用例**看不见块内行序**，
  // 块内 flipY 由下面的「跨路径一致性」用例负责。
  it('format <= 11 走 rgb565 快路径：8x8 多块行序/flipY 逐块断言', () => {
    const width = 8;
    const height = 8;
    const blockW = width / 4;
    const blockH = height / 4;
    // 流中 2x2 块按 raster 序填：红 / 绿 / 蓝 / 白（每块 word0=word1=纯色，selector 全 0 → 全取 c[0]）
    const colors = [0xf800, 0x07e0, 0x001f, 0xffff];
    const data = new Uint8Array(4 * 8);
    const u16Blocks = new Uint16Array(data.buffer);
    for (let b = 0; b < 4; b++) {
      u16Blocks[b * 4 + 0] = colors[b];
      u16Blocks[b * 4 + 1] = colors[b];
      u16Blocks[b * 4 + 2] = 0;
      u16Blocks[b * 4 + 3] = 0;
    }

    const out = new Uint8Array(width * height * 2);
    DXTTextureDecode.decode(out, width, height, data, 10);
    const u16Out = new Uint16Array(out.buffer);

    // 输出块 (bx, by) 的 16 个像素都应等于流中块 (bx, blockH-1-by) 的颜色
    for (let by = 0; by < blockH; by++) {
      for (let bx = 0; bx < blockW; bx++) {
        const expected = colors[(blockH - 1 - by) * blockW + bx];
        for (let py = 0; py < 4; py++) {
          for (let px = 0; px < 4; px++) {
            const idx = (by * 4 + py) * width + bx * 4 + px;
            expect(u16Out[idx]).toBe(expected);
          }
        }
      }
    }
  });

  // 回归（issue #2）：flipY 必须分两级 —— 块行倒序 + 块内 4 行倒序。
  // 只做块行倒序时，画面是「块带倒序、带内行正序」的错位图，和主路径对不上，
  // 而纯色块的用例看不出来。这里用同一份块数据分别走 565 快路径与 DXT1 主路径，
  // 逐像素比对，把两条路径的口径钉在一起（主路径的 height - 1 - sy 是既有基准）。
  // 只用 2-bit 索引 0 / 1：两条路径对 c2 / c3 的插值近似不同（565 用 3/8、DXT1 用 1/3），
  // 端点色才是严格可比的。
  it('format <= 11 与 DXT1 主路径逐像素一致（flipY 口径对齐）', () => {
    const width = 8;
    const height = 8;
    const blockW = width / 4;
    const blockH = height / 4;
    // 每块一对端点色，保证 c0 > c1（DXT1 的四色模式）
    const pairs = [
      [0xf800, 0x07e0], // 红 / 绿
      [0x07ff, 0x001f], // 青 / 蓝
      [0xffe0, 0x7c00], // 黄 / 棕
      [0xffff, 0x0000], // 白 / 黑
    ];
    // 块内四行各用一个互不相同的 2-bit 索引图案（低位起 px0..px3），
    // 这样任何一级行序搞错都会让像素对不上
    const rowSelectors = [0x00, 0x01, 0x05, 0x15];

    const data = new Uint8Array(4 * 8 * blockW * blockH);
    const u16Blocks = new Uint16Array(data.buffer);
    for (let b = 0; b < blockW * blockH; b++) {
      u16Blocks[b * 4 + 0] = pairs[b][0];
      u16Blocks[b * 4 + 1] = pairs[b][1];
      for (let r = 0; r < 4; r++) data[b * 8 + 4 + r] = rowSelectors[r];
    }

    // 565 快路径（format 10）
    const out565 = new Uint8Array(width * height * 2);
    DXTTextureDecode.decode(out565, width, height, data, 10);
    const u16Out = new Uint16Array(out565.buffer);

    // DXT1 主路径（format 17），输出 RGBA8
    const outDxt1 = new Uint8Array(width * height * 4);
    DXTTextureDecode.decode(outDxt1, width, height, data, 17);

    // Unpack565 用的是 (v << 3) | (v >> 2) 展开，所以 RGBA8 回压 565 是无损的
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      const fromDxt1 = (((outDxt1[p] >> 3) << 11) | ((outDxt1[p + 1] >> 2) << 5) | (outDxt1[p + 2] >> 3)) & 0xffff;
      expect(u16Out[i]).toBe(fromDxt1);
    }
  });

  it('format 18 (DXT3) 解码：显式 4-bit alpha 正确解码到输出像素', () => {
    // DXT3 每个块 16 字节：前 8 字节为 16 个像素的 4-bit alpha，后 8 字节为 RGB 块
    const block = new Uint8Array(16);
    // 像素 (0,0) 的 alpha: 高低字节拆包，0xff 表示两个像素 alpha 都是 15 -> 归一化为 255
    block[0] = 0xff;
    // color0 = 0xffff (白色), color1 = 0x0000 (黑色)
    block[8] = 0xff;
    block[9] = 0xff;
    block[10] = 0x00;
    block[11] = 0x00;
    // 索引全部选 index 0 (color0: 白)
    block[12] = 0x00;
    block[13] = 0x00;
    block[14] = 0x00;
    block[15] = 0x00;

    const out = new Uint8Array(4 * 4 * 4);
    DXTTextureDecode.decode(out, 4, 4, block, 18);

    // DXT 做了 flipY，第一行像素在输出底部 (y=3)
    const p0 = (4 * 3 + 0) * 4;
    expect(out[p0 + 0]).toBe(255); // R
    expect(out[p0 + 1]).toBe(255); // G
    expect(out[p0 + 2]).toBe(255); // B
    expect(out[p0 + 3]).toBe(255); // Alpha (15 * 17 = 255)
  });

  it('format 20 (DXT4/5) 解码：插值 alpha 正确写入输出像素', () => {
    // DXT4/5 每个块 16 字节：前 8 字节为 2 字节端点 + 6 字节 alpha 索引，后 8 字节为 RGB
    const block = new Uint8Array(16);
    // alpha0 = 255, alpha1 = 0
    block[0] = 255;
    block[1] = 0;
    // alpha 索引全 0 -> 取 alpha0 = 255
    block[2] = 0;
    block[3] = 0;
    block[4] = 0;
    block[5] = 0;
    block[6] = 0;
    block[7] = 0;

    // color0 = 0xf800 (红: 565 高 5 位), color1 = 0
    block[8] = 0x00;
    block[9] = 0xf8;
    block[10] = 0x00;
    block[11] = 0x00;
    // 索引全 0 -> 取 color0
    block[12] = 0x00;
    block[13] = 0x00;
    block[14] = 0x00;
    block[15] = 0x00;

    const out = new Uint8Array(4 * 4 * 4);
    DXTTextureDecode.decode(out, 4, 4, block, 20);

    const p0 = (4 * 3 + 0) * 4;
    expect(out[p0 + 0]).toBe(255); // R (0x1f -> 255)
    expect(out[p0 + 3]).toBe(255); // Alpha (alpha0 = 255)
  });
});
