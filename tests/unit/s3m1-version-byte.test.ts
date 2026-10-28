/**
 * 回归测试：S3M 1.x 容器魔数第 4 字节是**版本号**，不是常量 0
 *
 * 触发场景（2026-10-28，用户上报）：
 *   https://www.supermapol.com/realspace/services/3D-tishuju/rest/realspace/datas/model/config
 *   https://www.supermapol.com/realspace/services/3D-Histogram/rest/realspace/datas/Point2D_1000_3000/config
 * 两个数据集（体数据 / 柱状图）都是 `FileType = OSGBCacheFile`，瓦片头是 `s3m\x01`
 * （iServer 2025 出的），而老样本 `3D-suofeiya_church` 是 `s3m\x00`。
 *
 * `isS3M1Buffer` 原先逐字比对 `s3m\0`，于是版本 1 的瓦片没被分流到 S3M1 解析器，
 * 4 字节魔数被当成 float32 版本号（≈1.4e-38），紧跟的 zlib 头被当成压缩长度，
 * 最终报 `RangeError: Invalid typed array length: 1424349816` —— 完全看不出根因。
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { isS3M1Buffer, parseS3M1 } from '../../packages/s3m-three/src/core/S3M1Parser';
import { buildInstanceLookup } from '../../packages/s3m-three/src/core/FeatureInfo';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { parseConfigText, usableGeoBounds } from '../../packages/s3m-three/src/tileset/S3MTileset';

const FIX = (n: string) => join(import.meta.dir, '../fixtures/osgb', n);
const ab = (n: string) => {
  const b = readFileSync(FIX(n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const inflate = (x: Uint8Array) => inflateSync(x);

/** 按容器结构拼一个最小 S3M1 瓦片，只用来验魔数分流，不验几何 */
function container(versionByte: number): ArrayBuffer {
  const head = Buffer.from([0x73, 0x33, 0x6d, versionByte]);
  // 解压后：uint32 xmlSize=7 + "<Group>"
  const body = deflateSync(Buffer.from([0x07, 0x00, 0x00, 0x00, 0x3c, 0x47, 0x72, 0x6f, 0x75, 0x70, 0x3e]));
  const all = Buffer.concat([head, body]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

test('魔数分流：s3m\\x00 与 s3m\\x01 都是 S3M 1.x，s3m\\x02 起让路', () => {
  // 真实样本：老服务是 00，iServer 2025 的两个新数据集是 01
  expect(isS3M1Buffer(ab('root.s3m'))).toBe(true);
  expect(isS3M1Buffer(ab('s3m1-tishuju-model.s3m'))).toBe(true);
  expect(isS3M1Buffer(ab('s3m1-histogram.s3m'))).toBe(true);

  expect(isS3M1Buffer(container(0))).toBe(true);
  expect(isS3M1Buffer(container(1))).toBe(true);
  // 版本 2 以后结构可能变，宁可让它落到别的分支报错，也不要猜着解
  expect(isS3M1Buffer(container(2))).toBe(false);
  // 非 s3m 魔数一律不认
  expect(isS3M1Buffer(new Uint8Array([0x73, 0x33, 0x6d]).buffer)).toBe(false);
  expect(isS3M1Buffer(new Uint8Array([0x00, 0x00, 0x40, 0x40, 0, 0, 0, 0]).buffer)).toBe(false);
});

test('体数据（3D-tishuju / datas/model）瓦片能真解码，且顶点落在自带包围球内', async () => {
  const tile = await parseS3M1(ab('s3m1-tishuju-model.s3m'), { inflate });

  const skels = Object.values(tile.geoPackage);
  expect(skels.length).toBe(1);
  const vp = skels[0]!.vertexPackage;
  expect(vp.verticesCount).toBe(44);
  expect(skels[0]!.indexPackages[0]!.indexCount).toBe(192);
  expect(skels[0]!.indexPackages[0]!.indexCount % 3).toBe(0);

  const lod = tile.groupNode.pageLods[0]!;
  // 这份数据的顶点是网格局部坐标，得先过 GeoDeModMatrix 的平移才是包围球所在的坐标系
  const m = lod.geodes[0]!.matrix;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  const pos = vp.vertexAttributes.find((a) => a.semantic === 'position')!;
  const f = new Float32Array(
    pos.data.buffer.slice(pos.data.byteOffset, pos.data.byteOffset + pos.data.byteLength)
  );
  const c = lod.boundingSphere.center;
  let need = 0;
  for (let i = 0; i < f.length; i += 3) {
    need = Math.max(need, Math.hypot(f[i]! + tx - c.x, f[i + 1]! + ty - c.y, f[i + 2]! + tz - c.z));
  }
  // 位置判据：读偏一位就会飞出包围球（实测 124.5 / 半径 127）
  expect(need).toBeLessThanOrEqual(lod.boundingSphere.radius * 1.05);
  // XML 里的子瓦是 .s3m（不是 .osgb），交给 s3m1ChildUrl 换名即可
  expect(lod.childTile).toBe('Tile_-11507_35982_0000_0003_0000.s3m');
});

test('柱状图（3D-Histogram）瓦片走 parseS3MB 也不再报 RangeError', async () => {
  const tile = await parseS3MB(ab('s3m1-histogram.s3m'), { inflate });
  expect(tile.version).toBe(1);
  expect(tile.groupNode.pageLods.length).toBe(4);
  // 4 根柱子各一块网格，每块 36 顶点 / 36 索引（12 个三角形）
  const skels = Object.values(tile.geoPackage);
  expect(skels.length).toBe(4);
  for (const s of skels) {
    expect(s.vertexPackage.verticesCount).toBe(36);
    expect(s.indexPackages[0]!.indexCount).toBe(36);
  }
  // 柱状图的材质没有纹理单元，纹理流就是 count=0 —— 属性块被跳过不影响画面
  expect(Object.keys(tile.textures).length).toBe(0);
  expect(tile.materials.length).toBeGreaterThan(0);
});

test('柱状图：几何是「一份模板 + N 个实例矩阵」，不是一堆顶点', async () => {
  const tile = await parseS3MB(ab('s3m1-histogram.s3m'), { inflate });

  // 4 块网格各自的实例数（超图规范里 InstanceObject = uint16 count + float[16]）
  const counts = Object.values(tile.geoPackage).map((gp) => gp.vertexPackage.instanceCount);
  expect(counts.sort((a, b) => a - b)).toEqual([1, 8, 10, 11]);

  for (const gp of Object.values(tile.geoPackage)) {
    const vp = gp.vertexPackage;

    // 顶点必须是归一化模板：一旦被展开成世界坐标，就说明走了错的分支（几何会被压成薄片）
    const pos = vp.vertexAttributes.find((a) => a.semantic === 'position')!;
    const f = new Float32Array(
      pos.data.buffer.slice(pos.data.byteOffset, pos.data.byteOffset + pos.data.byteLength)
    );
    let maxAbs = 0;
    for (let i = 0; i < f.length; i++) maxAbs = Math.max(maxAbs, Math.abs(f[i]!));
    expect(maxAbs).toBeLessThanOrEqual(1.001);

    expect(vp.instanceMode).toBe(16);
    expect(vp.instanceIndex).not.toBe(-1);
    const m = new Float32Array(
      vp.instanceBuffer!.buffer,
      vp.instanceBuffer!.byteOffset,
      vp.instanceCount * 16
    );
    for (let i = 0; i < vp.instanceCount; i++) {
      const o = i * 16;
      // 3×4 行主序：前三个是缩放对角，3/7/11 是平移
      expect(m[o]!).toBeGreaterThan(1); // 柱宽 ~45m
      expect(m[o + 5]!).toBeGreaterThan(1);
      expect(m[o + 10]!).toBeGreaterThan(1); // 柱高 38~45m
      // 平移必须落在本瓦片的范围里（数据在悉尼，局部坐标 ±2.2km）
      expect(Math.abs(m[o + 3]!)).toBeLessThan(5000);
      expect(Math.abs(m[o + 7]!)).toBeLessThan(5000);
      expect(Math.abs(m[o + 11]!)).toBeLessThan(500);
      // [12..14] 是实例颜色，官方截图里那些黄绿色就是它
      for (let k = 12; k <= 14; k++) {
        expect(m[o + k]!).toBeGreaterThanOrEqual(0);
        expect(m[o + k]!).toBeLessThanOrEqual(1);
      }
    }
  }
});

test('柱状图：实例矩阵的高度能把模板顶到几十米，而不是贴地薄片', async () => {
  const tile = await parseS3MB(ab('s3m1-histogram.s3m'), { inflate });
  let top = -Infinity;
  let bottom = Infinity;
  for (const gp of Object.values(tile.geoPackage)) {
    const vp = gp.vertexPackage;
    const pos = vp.vertexAttributes.find((a) => a.semantic === 'position')!;
    const f = new Float32Array(
      pos.data.buffer.slice(pos.data.byteOffset, pos.data.byteOffset + pos.data.byteLength)
    );
    const m = new Float32Array(
      vp.instanceBuffer!.buffer,
      vp.instanceBuffer!.byteOffset,
      vp.instanceCount * 16
    );
    for (let i = 0; i < vp.instanceCount; i++) {
      const o = i * 16;
      for (let v = 0; v < f.length; v += 3) {
        // 只关心 z 轴：z' = m20*x + m21*y + m22*z + tz
        const z = m[o + 8]! * f[v]! + m[o + 9]! * f[v + 1]! + m[o + 10]! * f[v + 2]! + m[o + 11]!;
        top = Math.max(top, z);
        bottom = Math.min(bottom, z);
      }
    }
  }
  expect(top).toBeGreaterThan(30); // 之前没实例矩阵时整片只有 0.1m
  expect(top - bottom).toBeGreaterThan(30);
});

test('柱状图：实例化网格必须合成 pickInfo + 逐实例控制位，否则点不中', async () => {
  const tile = await parseS3MB(ab('s3m1-histogram.s3m'), { inflate });

  const allSmids = new Set<number>();
  for (const gp of Object.values(tile.geoPackage)) {
    const vp = gp.vertexPackage;
    const pickInfo = gp.pickInfo;
    // 之前 S3M1 一律 pickInfo: null —— 拾取链路拿不到 实例序号 → SMID 的映射，
    // pick() 直接返回 null，现象就是「柱子在、但怎么点都选不中」
    expect(pickInfo).toBeTruthy();
    expect(vp.instanceBatchIds?.length).toBe(vp.instanceCount);

    // 逐实例的控制位：0..N-1，选中时着色器靠它只高亮一根柱子
    for (let i = 0; i < vp.instanceCount; i++) expect(vp.instanceBatchIds![i]).toBe(i);

    const lookup = buildInstanceLookup(pickInfo);
    expect(lookup.size).toBe(vp.instanceCount);
    for (let i = 0; i < vp.instanceCount; i++) {
      const feat = lookup.get(i)!;
      expect(feat).toBeTruthy();
      expect(feat.batchId).toBe(i);
      // SMID 必须跨网格/跨瓦片唯一，否则 _smidMeshes 会把不同柱子归成一栋
      expect(allSmids.has(feat.smid)).toBe(false);
      allSmids.add(feat.smid);
    }
  }
  expect(allSmids.size).toBe(1 + 8 + 10 + 11);
});

test('非实例化网格（体数据）不合成 pickInfo：拾取走整块网格的老路径', async () => {
  const tile = await parseS3MB(ab('s3m1-tishuju-model.s3m'), { inflate });
  for (const gp of Object.values(tile.geoPackage)) {
    expect(gp.vertexPackage.instanceCount).toBe(0);
    expect(gp.pickInfo).toBeUndefined();
  }
});

test('柱状图 XML 配置：反斜杠相对路径要能还原成可请求的瓦片地址', () => {
  const xml = readFileSync(FIX('SuperMapCache-Histogram.xml'), 'utf8');
  const cfg = parseConfigText(xml);
  expect(cfg.fileType).toBe('OSGBCacheFile');

  const base =
    'https://www.supermapol.com/realspace/services/3D-Histogram/rest/realspace/datas/Point2D_1000_3000/config';
  const tiles = (cfg.tiles ?? cfg.rootTiles) as Array<{ url: string }>;
  expect(tiles.length).toBeGreaterThan(0);
  // XML 里写的是 `.\Tile_3439_13192\Tile_3439_13192.s3m`（Windows 反斜杠）
  // new URL 对 http 这个 special scheme 会把 \ 当 /，所以能直接还原
  expect(new URL(tiles[0]!.url, base).href).toBe(
    'https://www.supermapol.com/realspace/services/3D-Histogram/rest/realspace/datas/Point2D_1000_3000/Tile_3439_13192/Tile_3439_13192.s3m'
  );

  const b = usableGeoBounds(cfg.geoBounds);
  expect(b).toBeTruthy();
  // 悉尼附近，不能落成 (0,0)
  expect(b!.left).toBeGreaterThan(140);
  expect(b!.bottom).toBeLessThan(-30);
});
