/**
 * 纹理格式判定单测（不依赖外部样例，CI 里必跑）
 *
 * 判定错误在真实服务上的后果很直接：CRN 纹理被当成未知格式整包丢掉，
 * 模型退化成无贴图的灰模。这里把实测到的组合都钉死：
 *   v3.00  ct=26     pf=13     → crn   （SuperMap Online 3D-BianDianZhan3）
 *   v3.00  ct=14     pf=21     → dxt5  （3D-scyx，compressType 是噪声）
 *   v3.01  ct=50000  pf=32856  → crn   （3D-BIMTreeModel / SubwayStationCombined）
 */
import assert from 'node:assert';
import { dxtPixelFormatOf, resolveTextureKind } from '../packages/s3m-three/dist/core/TextureFormat.js';
import { transcodeCRN } from '../packages/s3m-three/dist/core/CRNDecode.js';

let n = 0;
function eq(actual, expected, label) {
  n++;
  assert.strictEqual(actual, expected, `${label}：期望 ${expected}，实际 ${actual}`);
}

/* S3M 3.0（v3.00）：compressType 借用 PixelFormat 数值 */
eq(resolveTextureKind(26, 13), 'crn', 'v3.00 CRN_DXT5');
eq(resolveTextureKind(27, 32856), 'crn', 'v3.00 STANDARD_CRN');
eq(resolveTextureKind(14, 21), 'dxt5', 'v3.00 ct 是噪声时退回 pixelFormat');
eq(resolveTextureKind(0, 17), 'dxt1', 'v3.00 DXT1');
eq(resolveTextureKind(0, 19), 'dxt3', 'v3.00 DXT3');
eq(resolveTextureKind(0, 20), 'dxt4', 'v3.00 DXT4');
eq(resolveTextureKind(0, 25), 'webp', 'v3.00 WEBP');
eq(resolveTextureKind(0, 28), 'raw', 'v3.00 RGBA');
eq(resolveTextureKind(0, 13), 'raw', 'v3.00 ABGR');

/* 行标（v3.01）：compressType 换成 TC_* / GL 压缩枚举，pixelFormat 变成 GL 内部格式 */
eq(resolveTextureKind(50000, 32856), 'crn', 'v3.01 TC_CRN_DXT5');
eq(resolveTextureKind(38001, 32856), 'crn', 'v3.01 TC_CRN');
eq(resolveTextureKind(33776, 32856), 'dxt1', 'v3.01 TC_DXT1_RGB');
eq(resolveTextureKind(33777, 32856), 'dxt1', 'v3.01 TC_DXT1_RGBA');
eq(resolveTextureKind(33778, 32856), 'dxt3', 'v3.01 TC_DXT3');
eq(resolveTextureKind(33779, 32856), 'dxt5', 'v3.01 TC_DXT5');
eq(resolveTextureKind(38000, 32856), 'webp', 'v3.01 TC_WEBP');
eq(resolveTextureKind(38002, 32856), 'ktx2', 'v3.01 TC_KTX2');

/* 认不出来就如实上报，别猜 */
eq(resolveTextureKind(0, 9999), 'unknown', '未知 pixelFormat');
eq(resolveTextureKind(12345, 0), 'unknown', '未知 compressType');

/* DXT 解码只需要区分「8 字节块」和「16 字节块」 */
eq(dxtPixelFormatOf('dxt1'), 17, 'DXT1 块大小');
eq(dxtPixelFormatOf('dxt3'), 21, 'DXT3 走 16 字节块');
eq(dxtPixelFormatOf('dxt5'), 21, 'DXT5 走 16 字节块');

/* CRN 魔数校验：标成 CRN 但数据不是，必须直接拒（不能靠 wasm 猜出个「合理」尺寸） */
const dxtBlock = new Uint8Array(16);
await assert.rejects(() => transcodeCRN(dxtBlock), /CRN 头/, '非 CRN 数据应被拒绝');
await assert.rejects(() => transcodeCRN(new Uint8Array(0)), /为空/, '空数据应被拒绝');
const withMagic = new Uint8Array([0x48, 0x78, 0x00, 0x6e, 0, 0, 0, 0]);
await assert.rejects(() => transcodeCRN(withMagic), /CRN|crunch/, 'Hx 头但内容非法应报错');
n += 3;

console.log(`  √ 纹理格式判定 ${n} 项断言通过（v3.00 / v3.01 实测组合、DXT 块大小、CRN 魔数校验）`);
