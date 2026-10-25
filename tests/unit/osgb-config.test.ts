/**
 * 回归测试：OSGB / SuperMapCache 风格的 XML 配置与 iServer 的 URL 编码
 *
 * 数据来自 SuperMap Online 的公开服务
 * `3D-suofeiya_church/rest/realspace/datas/Config/config`（索菲亚教堂倾斜摄影，
 * FileType = OSGBFile），抓取于 2026-10-25。
 *
 * 踩过的两个坑：
 * 1. 这类 XML 不带经纬度范围（只有 <sml:Position> 的经纬度原点和 <sml:BoundingBox>
 *    的局部米制盒）。老代码只找 Left/Right/Top/Bottom，找不到就留全 0 ——
 *    于是 fitBounds 甩到几内亚湾，_resolveAnchor 还会因为「position 与 geoBounds 相差
 *    126°」把唯一正确的 position 判成异常，模型也被搬到 (0,0)。
 *    现在按 Position + 米制盒反算出经纬度范围，并且退化框不再反过来否决 position。
 * 2. 瓦片名是 `Tile_+002_+001` 这种带 + 的，new URL() 认为 + 在 path 里合法就不编码，
 *    而 iServer 的 Java 侧按 URLDecoder 解路径，+ 变成空格 → 404「瓦片数据不存在」。
 *    实测同一个地址：裸 + 404，%2B 返回 200 application/s3m。
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  fixPathEncoding,
  parseConfigText,
  usableGeoBounds,
} from '../../packages/s3m-three/src/tileset/S3MTileset';
import { S3MFormatError, parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';

const XML = readFileSync(join(import.meta.dir, '../fixtures/osgb/SuperMapCache-OSGB.xml'), 'utf8');
const SERVICE = 'https://www.supermapol.com/realspace/services/3D-suofeiya_church/rest/realspace';
const CONFIG_URL = `${SERVICE}/datas/Config/config`;

test('OSGB XML：position 取经纬度原点，geoBounds 由米制局部盒反算', () => {
  const cfg = parseConfigText(XML);
  const pos = cfg.position as { x: number; y: number; z: number; units: string };
  expect(pos).toMatchObject({ x: 126.621288, y: 45.768172, z: 0, units: 'Degree' });

  const b = usableGeoBounds(cfg.geoBounds);
  expect(b, '反算后应该是一张可用的经纬度范围').toBeTruthy();

  // 盒中心必须贴着 position —— 否则 _resolveAnchor 的一致性检查（阈值 0.5°）
  // 会判定 position 异常并退回 (0,0)，位置就错了
  const cLon = (b!.left + b!.right) / 2;
  const cLat = (b!.bottom + b!.top) / 2;
  expect(Math.abs(cLon - pos.x)).toBeLessThan(0.01);
  expect(Math.abs(cLat - pos.y)).toBeLessThan(0.01);

  // 范围量级：这份数据局部盒是 -312..195 m × -247..260 m，反算回来应该是几百米见方
  const widthM = (b!.right - b!.left) * 111320 * Math.cos((pos.y * Math.PI) / 180);
  const heightM = (b!.top - b!.bottom) * 110540;
  expect(widthM).toBeGreaterThan(400);
  expect(widthM).toBeLessThan(600);
  expect(heightM).toBeGreaterThan(400);
  expect(heightM).toBeLessThan(600);

  const tiles = cfg.rootTiles as Array<{ url: string }>;
  expect(tiles.length).toBe(9);
  expect(tiles[0]!.url).toBe('./Tile_+002_+001/Tile_+002_+001.s3m');
});

test('瓦片 URL：路径里的 + 必须编码成 %2B，query 与已编码的不动', () => {
  const raw = new URL('./Tile_+002_+001/Tile_+002_+001.s3m', CONFIG_URL).href;
  expect(raw).toContain('Tile_+002_+001'); // new URL 自己不会编码 +，这就是 404 的由来
  expect(fixPathEncoding(raw)).toBe(
    `${SERVICE}/datas/Config/Tile_%2B002_%2B001/Tile_%2B002_%2B001.s3m`
  );

  // 幂等：已经编码好的不再动
  const fixed = fixPathEncoding(raw);
  expect(fixPathEncoding(fixed)).toBe(fixed);
  // query 里的 + 本来就是空格约定，改了反而换味
  expect(fixPathEncoding(`${CONFIG_URL}?a=+1`)).toBe(`${CONFIG_URL}?a=+1`);
  // hash 保持原样
  expect(fixPathEncoding(`${CONFIG_URL}?x=1#/Tile_+0`)).toBe(`${CONFIG_URL}?x=1#/Tile_+0`);
  // 空格也补上
  expect(fixPathEncoding(`${SERVICE}/datas/Config/Tile_ 002/a.s3m`)).toBe(
    `${SERVICE}/datas/Config/Tile_%20002/a.s3m`
  );
  // 干净地址原样返回
  expect(fixPathEncoding(CONFIG_URL)).toBe(CONFIG_URL);
});

test('usableGeoBounds：退化 / 越界 / 缺失一律判为不可用', () => {
  expect(usableGeoBounds({ left: 0, right: 0, top: 0, bottom: 0 })).toBeNull();
  expect(usableGeoBounds({ left: 1, right: 1, top: 2, bottom: 2 })).toBeNull(); // 收缩成一个点
  expect(usableGeoBounds({ left: 0, right: 0.002, top: 1, bottom: 2 })).toEqual({
    left: 0,
    right: 0.002,
    top: 1,
    bottom: 2,
  }); // 边界恰好是 0 但有真实范围，不能误判成全 0
  expect(usableGeoBounds({ left: 1, bottom: NaN, right: 2, top: 3 })).toBeNull();
  expect(usableGeoBounds({ left: 1e6, bottom: 0, right: 2e6, top: 1 })).toBeNull(); // 米制当成经纬度
  expect(usableGeoBounds(undefined)).toBeNull();
  expect(usableGeoBounds('x')).toBeNull();
});

test('JSON 配置仍按 JSON 走，v3.01 的 position.point3D 认得', () => {
  const cfg = parseConfigText(
    JSON.stringify({
      dataType: '3DGaussianSplatting',
      position: { point3D: { x: 118.14385313861287, y: 48.33620331866743, z: 730.4826 }, unit: 'Degree' },
      geoBounds: { left: 118.14345608, right: 118.14425019, bottom: 48.33595941, top: 48.33644722 },
      rootTiles: [{ url: './Tile_0019_262145_524289_0000/Tile_0019_262145_524289_0000.s3mb' }],
    })
  );
  expect(cfg.dataType).toBe('3DGaussianSplatting');
  expect((cfg.position as { point3D?: { z?: number } }).point3D?.z).toBeCloseTo(730.4826, 3);
  expect(usableGeoBounds(cfg.geoBounds)).toBeTruthy();
  expect(cfg.fileType).toBeUndefined();
});

test('OSGB XML 把 FileType 带出来，供上层提前判定这是 1.x 缓存', () => {
  expect(parseConfigText(XML).fileType).toBe('OSGBFile');
});

test('S3M 1.x 容器：识别 s3m\\0 魔数，报可行动的永久错误而不是 RangeError', async () => {
  // 真实文件的头 4 字节就是 73 33 6D 00，紧接 78 da 的 zlib 流
  const body = deflateSync(Buffer.from('<Group/>', 'utf8'));
  const buf = Buffer.concat([Buffer.from([0x73, 0x33, 0x6d, 0x00]), body]);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

  let err: unknown;
  try {
    await parseS3MB(ab);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(S3MFormatError);
  const e = err as S3MFormatError & { permanent?: boolean };
  expect(e.permanent).toBe(true);
  expect(e.message).toContain('S3M 1.x');
  expect(e.message).toContain('.osgb');
  // 修复前的症状留个记录：头 4 字节被当成 float32 版本号（1e-38），
  // 于是 zlib 头 78 da cc bd 被读成 compressedSize，直接 RangeError
  expect(e.message).not.toContain('typed array length');
});

test('S3M 2.x / 3.x 的正常头不会被 1.x 识别误伤', async () => {
  // 3.00 开头（00 00 40 40）与 2.10 开头都不该命中魔数分支；
  // 这里只喂 8 字节，让它在后面的读取里失败，验证失败原因不是 S3MFormatError
  const ab = new Uint8Array([0x00, 0x00, 0x40, 0x40, 0x00, 0x00, 0x00, 0x00]).buffer;
  let err: unknown;
  try {
    await parseS3MB(ab);
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(err).not.toBeInstanceOf(S3MFormatError);
});
