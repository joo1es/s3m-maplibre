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
    expect(dxtPixelFormatOf('dxt3')).toBe(21);
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
