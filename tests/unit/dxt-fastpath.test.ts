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

  it('format <= 11 走 rgb565 快路径 (DecompressImage565)', () => {
    // 构造足够容纳读取偏移的 block 缓冲（至少 8 个 uint16）
    const block = new Uint8Array(16);
    const u16Block = new Uint16Array(block.buffer, block.byteOffset, 8);
    // 写入 565 颜色到读取偏移 i=4 处
    u16Block[4] = 0x001f; // c[0]
    u16Block[5] = 0xf800; // c[1]
    u16Block[6] = 0x0000; // m
    u16Block[7] = 0x0000;

    const out = new Uint8Array(4 * 4 * 2); // 16 pixels * 2 bytes = 32 bytes
    // format = 10 (RGB) -> default 分支且 <= 11 -> flags: kDxt1 | krgb565
    DXTTextureDecode.decode(out, 4, 4, block, 10);

    const u16Out = new Uint16Array(out.buffer, out.byteOffset, 16);
    // 输出的第 0 个像素（取 c[0]）应为 0x001f
    expect(u16Out[0]).toBe(0x001f);
  });

  it('format 18 (DXT3) 与 format 20 (DXT4) 解码无异常', () => {
    // DXT3 / DXT4 每个块 16 字节
    const block = new Uint8Array(16);
    // 填入简单有效数据
    block[0] = 0xff; // alpha
    block[8] = 0xff; // color0
    block[10] = 0x00; // color1

    const out18 = new Uint8Array(4 * 4 * 4);
    expect(() => DXTTextureDecode.decode(out18, 4, 4, block, 18)).not.toThrow();

    const out20 = new Uint8Array(4 * 4 * 4);
    expect(() => DXTTextureDecode.decode(out20, 4, 4, block, 20)).not.toThrow();
  });
});
