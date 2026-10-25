/**
 * 纹理格式判定单测（不依赖外部样例，CI 里必跑）
 *
 * 判定错误在真实服务上的后果很直接：CRN 纹理被当成未知格式整包丢掉，
 * 模型退化成无贴图的灰模。这里把实测到的组合都钉死：
 *   v3.00  ct=26     pf=13     → crn   （SuperMap Online 3D-BianDianZhan3）
 *   v3.00  ct=14     pf=21     → dxt5  （3D-scyx，compressType 是噪声）
 *   v3.01  ct=50000  pf=32856  → crn   （3D-BIMTreeModel / SubwayStationCombined）
 */
import { describe, expect, test } from 'bun:test';
import { dxtPixelFormatOf, resolveTextureKind } from '../../packages/s3m-three/src/core/TextureFormat';
import { transcodeCRN } from '../../packages/s3m-three/src/core/CRNDecode';
import DXTTextureDecode from '../../packages/s3m-three/src/core/DXTTextureDecode';

describe('S3M 3.0（v3.00）：compressType 借用 PixelFormat 数值', () => {
  test('26/13 → crn（CRN_DXT5）', () => {
    expect(resolveTextureKind(26, 13)).toBe('crn');
  });

  test('27/32856 → crn（STANDARD_CRN）', () => {
    expect(resolveTextureKind(27, 32856)).toBe('crn');
  });

  test('14/21 → dxt5（compressType 是噪声时退回 pixelFormat）', () => {
    expect(resolveTextureKind(14, 21)).toBe('dxt5');
  });

  test('0/17 → dxt1，0/19 → dxt3，0/20 → dxt4', () => {
    expect(resolveTextureKind(0, 17)).toBe('dxt1');
    expect(resolveTextureKind(0, 19)).toBe('dxt3');
    expect(resolveTextureKind(0, 20)).toBe('dxt4');
  });

  test('0/25 → webp，0/28 → raw（RGBA），0/13 → raw（ABGR）', () => {
    expect(resolveTextureKind(0, 25)).toBe('webp');
    expect(resolveTextureKind(0, 28)).toBe('raw');
    expect(resolveTextureKind(0, 13)).toBe('raw');
  });
});

describe('行标（v3.01）：compressType 换成 TC_* / GL 压缩枚举', () => {
  test('50000/32856 → crn（TC_CRN_DXT5），38001/32856 → crn（TC_CRN）', () => {
    expect(resolveTextureKind(50000, 32856)).toBe('crn');
    expect(resolveTextureKind(38001, 32856)).toBe('crn');
  });

  test('33776/33777 → dxt1，33778 → dxt3，33779 → dxt5', () => {
    expect(resolveTextureKind(33776, 32856)).toBe('dxt1');
    expect(resolveTextureKind(33777, 32856)).toBe('dxt1');
    expect(resolveTextureKind(33778, 32856)).toBe('dxt3');
    expect(resolveTextureKind(33779, 32856)).toBe('dxt5');
  });

  test('38000 → webp，38002 → ktx2', () => {
    expect(resolveTextureKind(38000, 32856)).toBe('webp');
    expect(resolveTextureKind(38002, 32856)).toBe('ktx2');
  });
});

describe('认不出来就如实上报，别猜', () => {
  test('未知 pixelFormat / compressType 一律 unknown', () => {
    expect(resolveTextureKind(0, 9999)).toBe('unknown');
    expect(resolveTextureKind(12345, 0)).toBe('unknown');
  });
});

describe('DXT 解码只需要区分「8 字节块」和「16 字节块」', () => {
  test('块大小映射', () => {
    expect(dxtPixelFormatOf('dxt1')).toBe(17);
    // dxt3 从前被写成 21，于是 DXT3 的显式 4-bit alpha 会按 DXT5 的插值 alpha 解
    expect(dxtPixelFormatOf('dxt3')).toBe(19);
    expect(dxtPixelFormatOf('dxt4')).toBe(20);
    expect(dxtPixelFormatOf('dxt5')).toBe(21);
  });
});

describe('CRN 魔数校验：标成 CRN 但数据不是，必须直接拒', () => {
  test('非 CRN 数据被魔数挡住', async () => {
    await expect(transcodeCRN(new Uint8Array(16))).rejects.toThrow(/CRN 头/);
  });

  test('空数据直接拒绝', async () => {
    await expect(transcodeCRN(new Uint8Array(0))).rejects.toThrow(/为空/);
  });

  test('Hx 头但内容非法要报明确错误，不能靠 wasm 猜出个「合理」尺寸', async () => {
    const withMagic = new Uint8Array([0x48, 0x78, 0x00, 0x6e, 0, 0, 0, 0]);
    await expect(transcodeCRN(withMagic)).rejects.toThrow(/CRN|crunch/);
  });
});

describe('DXT 块大小：解码路径必须与压缩格式一致', () => {
  test('dxtPixelFormatOf 逐格式给回真实 pixelFormat，不能一律 21', () => {
    expect(dxtPixelFormatOf('dxt1')).toBe(17);
    expect(dxtPixelFormatOf('dxt3')).toBe(19);
    expect(dxtPixelFormatOf('dxt4')).toBe(20);
    expect(dxtPixelFormatOf('dxt5')).toBe(21);
  });

  test('DXT1 按 8 字节块解：4×4 一块就够，不能去读 16 字节', () => {
    // color0 = 0xFFFF（白）、color1 = 0x0000、索引全 0 → 16 个像素都取 color0
    const block = new Uint8Array([0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const out = new Uint8Array(4 * 4 * 4);
    DXTTextureDecode.decode(out, 4, 4, block, 17);
    for (let p = 0; p < 16; p++) {
      // 若被当成 16 字节块，前 8 字节会被读成 alpha 块、颜色区越界 → 全 0 / NaN
      expect([out[p * 4], out[p * 4 + 1], out[p * 4 + 2], out[p * 4 + 3]]).toEqual([255, 255, 255, 255]);
    }
  });

  test('DXT5 仍按 16 字节块解（alpha0=alpha1=255 → 全不透明）', () => {
    const block = new Uint8Array([
      0xff, 0xff, 0, 0, 0, 0, 0, 0, // alpha 块：两端都 255
      0xff, 0xff, 0x00, 0x00, 0, 0, 0, 0, // 颜色块：color0 = 白
    ]);
    const out = new Uint8Array(4 * 4 * 4);
    DXTTextureDecode.decode(out, 4, 4, block, 21);
    for (let p = 0; p < 16; p++) {
      expect([out[p * 4], out[p * 4 + 1], out[p * 4 + 2], out[p * 4 + 3]]).toEqual([255, 255, 255, 255]);
    }
  });

  test('DXT3 用显式 4-bit alpha，不能按 DXT5 的插值 alpha 解', () => {
    // 同一串字节，两种编码必须解出不同结果，才算真的分开了路径：
    //   DXT3：alpha 头 8 字节是 16 个 4-bit 码，byte0 低 4 位 = 0 → alpha 0
    //   DXT5：byte0/byte1 是 alpha0/alpha1，其余 6 字节是 3-bit 选择码（这里全 0 → 取 alpha0）
    const bytes = new Uint8Array([
      0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xff, 0xff, 0x00, 0x00, 0, 0, 0, 0,
    ]);

    const as3 = new Uint8Array(4 * 4 * 4);
    DXTTextureDecode.decode(as3, 4, 4, bytes, 19);
    const as5 = new Uint8Array(4 * 4 * 4);
    DXTTextureDecode.decode(as5, 4, 4, bytes, 21);

    // 颜色部分两者一致，差别只在 alpha
    expect(as3[0]).toBe(255);
    expect(as5[0]).toBe(255);
    // 只要有任何一个像素的 alpha 不同，就说明没把 DXT3 当 DXT5 解
    let diff = 0;
    for (let p = 0; p < 16; p++) if (as3[p * 4 + 3] !== as5[p * 4 + 3]) diff++;
    expect(diff).toBeGreaterThan(0);
    // DXT3 下 byte0 低 4 位那个像素是 0，DXT5 下同一批像素取 alpha0 = 255
    expect(Math.min(...Array.from({ length: 16 }, (_, p) => as3[p * 4 + 3]))).toBe(0);
    expect(Math.max(...Array.from({ length: 16 }, (_, p) => as5[p * 4 + 3]))).toBe(255);
  });
});
