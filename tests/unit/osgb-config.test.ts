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
import { deflateSync, inflateSync } from 'node:zlib';
import {
  fixPathEncoding,
  parseConfigText,
  s3m1ChildUrl,
  usableGeoBounds,
} from '../../packages/s3m-three/src/tileset/S3MTileset';
import { parseS3MB, S3MFormatError } from '../../packages/s3m-three/src/core/S3MBParser';

const XML = readFileSync(join(import.meta.dir, '../fixtures/osgb/SuperMapCache-OSGB.xml'), 'utf8');
const SERVICE = 'https://www.supermapol.com/realspace/services/3D-suofeiya_church/rest/realspace';
const CONFIG_URL = `${SERVICE}/datas/Config/config`;

test('OSGB XML：position 取经纬度原点，geoBounds 由米制局部盒反算', () => {
  const cfg = parseConfigText(XML);
  const pos = cfg.position as { x: number; y: number; z: number; units: string };
  expect(pos).toMatchObject({ x: 126.621288, y: 45.768172, z: 0, units: 'Degree' });

  // 高程范围必须带出来：这类成果从 119.84m 起飞，不读出来就没法 bottom 对齐，
  // 整片模型会悬在 120m 高空，斜视下看起来像散落在别处的碎片
  expect(cfg.heightRange).toEqual({ min: 119.841805, max: 183.047668 });

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

test('S3M 1.x（.s3m / SuperMapCache）瓦片能真解码：几何、纹理、LOD 球全部对上', async () => {
  // 真实根瓦片：supermapol 3D-suofeiya_church / datas/Config/Tile_+002_+001/Tile_+002_+001.s3m
  const b = readFileSync(join(import.meta.dir, '../fixtures/osgb/root.s3m'));
  const tile = await parseS3MB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {
    inflate: (x) => inflateSync(x),
  });

  const skels = Object.values(tile.geoPackage);
  expect(skels.length).toBe(1);
  const vp = skels[0]!.vertexPackage;
  expect(vp.verticesCount).toBe(1542);
  // 索引来自 [u32 1][u32 indexCount][u32 标记] + u16×indexCount
  const packs = skels[0]!.indexPackages;
  expect(packs.length).toBe(1);
  expect(packs[0]!.indexCount).toBe(4746);
  expect(packs[0]!.indexCount % 3).toBe(0);
  expect(packs[0]!.primitiveType).toBe(4);
  // 材质号来自网格记录末尾的 materialId，且与 XML <material><name> 一致
  expect(packs[0]!.passNames).toEqual(['3408883528']);
  // v1 头的 format=14 不是 S3MPixelFormat（那枚举里 14 = BGRA = 4B/px）；
  // 按 data 长度 131072 = 512×512×0.5 反推，真实格式是 DXT1 → pixelFormat 17
  // flipY 必须为真：DXT 解码内部按 GL 约定翻了一次 Y，而 v1 的 UV 是 v=0 对应文件首行。
  // 实测图集内容在文件行 232~511、UV 的 v 落在 0.483~0.983（行 245~503）；
  // 不翻回来就采到空的那半张（区域均值亮度 5.6 vs 76.1），模型上一片黑块。
  expect(tile.textures['2120844245']).toMatchObject({
    width: 512,
    height: 512,
    pixelFormat: 17,
    flipY: true,
  });
  expect(tile.textures['2120844245']!.data.length).toBe(512 * 512 * 0.5);

  // 位置不变量：解码出的顶点必须落在 XML 自带的包围球里（这是判断读对位、没读偏的硬标准）
  const lod = tile.groupNode.pageLods[0]!;
  expect(lod.geodes[0]!.skeletonNames).toEqual(skels.map((s) => s.name));
  const pos = vp.vertexAttributes.find((a) => a.semantic === 'position')!;
  const f = new Float32Array(pos.data.buffer.slice(pos.data.byteOffset, pos.data.byteOffset + pos.data.byteLength));
  const c = lod.boundingSphere.center;
  let need = 0;
  for (let i = 0; i < f.length; i += 3) need = Math.max(need, Math.hypot(f[i] - c.x, f[i + 1] - c.y, f[i + 2] - c.z));
  expect(need).toBeLessThanOrEqual(lod.boundingSphere.radius * 1.05);
  // 子瓦在 XML 里是原始 .osgb 名，换后缀 + 插 data/path 的规则由 S3MTileset 负责
  expect(lod.childTile).toBe('Tile_+002_+001_L16_0.osgb');
  expect(tile.bytesRead).toBe(tile.bytesTotal);
});

test('S3M 1.x 缓冲被截断/伪造时报能定位的错，不是 RangeError 天文长度', async () => {
  // 头 4 字节是魔数就会分流到 1.x 解析器；这里给一段解压后根本不像容器的数据
  const body = deflateSync(Buffer.from('<Group/>', 'utf8'));
  const buf = Buffer.concat([Buffer.from([0x73, 0x33, 0x6d, 0x00]), body]);
  let err: unknown;
  try {
    await parseS3MB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  const msg = String((err as Error).message);
  // 修复前的症状：头 4 字节被当成 float32 版本号（1e-38），再把 zlib 头当长度
  expect(msg).not.toContain('typed array length');
  expect(msg).toContain('1.x');
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

test('.s3m 子瓦地址规则：根瓦插 data/path，子瓦同目录换名，绝不双插', () => {
  const root =
    'https://h/realspace/services/3D-x/rest/realspace/datas/Config/Tile_%2B002_%2B001/Tile_%2B002_%2B001.s3m';
  // XML 的 RangeDataList 写的是切片时残留的原始 .osgb 名，实际发布是同名换 .s3m
  expect(s3m1ChildUrl(root, 'Tile_+002_+001_L16_0.osgb')).toBe(
    'https://h/realspace/services/3D-x/rest/realspace/datas/Config/data/path/Tile_%2B002_%2B001/Tile_%2B002_%2B001_L16_0.s3m'
  );

  // 孙瓦：父瓦自己已经在 data/path 底下了，只能换文件名。
  // 这条是踩过坑加的 —— 早先无脑再插一层，得到 data/path/data/path/... 全部 404。
  const child = s3m1ChildUrl(root, 'Tile_+002_+001_L16_0.osgb')!;
  expect(s3m1ChildUrl(child, 'Tile_+002_+001_L17_00.osgb')).toBe(
    'https://h/realspace/services/3D-x/rest/realspace/datas/Config/data/path/Tile_%2B002_%2B001/Tile_%2B002_%2B001_L17_00.s3m'
  );
  // 再往下一层也不能双插
  const gc = s3m1ChildUrl(child, 'Tile_+002_+001_L17_00.osgb')!;
  expect(s3m1ChildUrl(gc, 'Tile_+002_+001_L18_000t3.osgb')).toContain('/data/path/Tile_%2B002_%2B001/Tile_%2B002_%2B001_L18_000t3.s3m');
  expect(s3m1ChildUrl(gc, 'Tile_+002_+001_L18_000t3.osgb')).not.toContain('data/path/data/path');

  // 中文数据源名保持已编码的样子，不被拆坏
  expect(
    s3m1ChildUrl('https://h/s/rest/realspace/datas/%E5%AF%BF%E5%AE%81%E9%98%81/Tile_A/Tile_A.s3m', 'Tile_A_L16_0.osgb')
  ).toContain('/datas/%E5%AF%BF%E5%AE%81%E9%98%81/data/path/Tile_A/Tile_A_L16_0.s3m');

  // 不像 datas/<ds>/<dir>/<file> 结构时退回父目录拼接，不抛异常
  expect(s3m1ChildUrl('https://h/a/b.s3m', 'c.osgb')).toBe('https://h/a/c.s3m');
  expect(s3m1ChildUrl(root, null)).toBeNull();
});
