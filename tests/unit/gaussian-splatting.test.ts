/**
 * 回归测试：v3.01 高斯泼溅 / 点云多骨架瓦片的条目边界
 *
 * 数据来自 SuperMap Online 的公开服务
 * `3D-ShouNingGe/rest/realspace/datas/寿宁阁`（dataType = 3DGaussianSplatting，
 * crs = epsg:4326，s3m:VertexCompressionType = MESHOPT，s3m:TileSplitType = GLOBAL），
 * 抓取于 2026-10-25，两块瓦片分别是 LOD 树的根（Tile_0019_…，1888 点）
 * 和它的一块细化子瓦（Tile_0020_…，4 块骨架共 9448 点）。
 *
 * 踩过的坑：子瓦第 3 块骨架（0_4955）在几何段与末尾 OBB 之间比其它块多了 4 字节对齐填充。
 * readV3BoundingBox 的启发式只挡「非有限 / 超地球量级」的垃圾值，而这 4 字节错位读出来的
 * 框是 center(0,0,0) + extent 2.0/4.0 —— 有限、量级也正常，于是判定「像个包围盒」直接放行，
 * 整条流从此偏 4 字节：下一块骨架的 skeletonStreamSize 读到 1072419456、
 * 名字长度读到 13360，最后抛「未知骨架标记 0（…13KB 乱码…）」，整套高斯数据加载失败。
 *
 * 现在的做法是拿每块骨架自带的 skeletonStreamSize 当权威边界（实测三条边界严丝合缝：
 * 1660+4+25396 = 27060、27060+4+32204 = 59268、59268+4+76252 = 135524），
 * OBB 一律按「条目末尾 96 字节」定位，读完再对齐到条目末尾。
 * 所以这里既断言解析能跑通，也断言每块骨架的 OBB 中心与 pageLOD 里对应 geode
 * 的包围球中心一致 —— 后者才是「读对位置」而不是「蒙对一个有限值」的证据。
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';

const FIXTURES = join(import.meta.dir, '../fixtures/gaussian-splatting');
const ROOT_TILE = 'Tile_0019_262145_524289_0000.s3mb';
const CHILD_TILE = 'Tile_0020_262145_524289_0003.s3mb';

const parse = (name: string) => {
  const b = readFileSync(join(FIXTURES, name));
  // Buffer 可能是从共享内存池里切出来的，直接取 .buffer 会把邻居的字节也带上
  return parseS3MB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, {
    inflate: (x) => inflateSync(x),
  });
};

test('高斯泼溅根瓦片：单骨架纯点、带 GaussianSplatting 标记、rangeMode=2', async () => {
  const tile = await parse(ROOT_TILE);

  expect(tile.version).toBe(3.01);
  expect((tile.extensions as { GaussianSplatting?: { isGaussianSplatting?: boolean } }).GaussianSplatting)
    ?.toMatchObject({ isGaussianSplatting: true });

  const lods = tile.groupNode.pageLods;
  expect(lods.length).toBe(1);
  // 服务端这里用的是规范没写进 RangeMode 枚举的 2，调度要认得它
  expect(lods[0]!.rangeMode).toBe(2);
  expect(lods[0]!.rangeValue).toBeGreaterThan(0);
  // childTile 只是文件名，真实路径要挂在父瓦片自己的目录下
  expect(lods[0]!.childTile).toBe('Tile_0020_262145_524289_0003.s3mb');

  const skels = Object.values(tile.geoPackage);
  expect(skels.length).toBe(1);
  expect(skels[0]!.vertexPackage.verticesCount).toBe(1888);
  // 泼溅数据没有索引，几何就是一包点
  expect(skels[0]!.indexPackages.length).toBe(0);
  // 属性：位置 + 颜色 + 泼溅自身的尺寸/朝向。
  // gsScale / gsRotation 是 MeshOpt 的自定义流（每点 4 字节），以前直接被丢掉，
  // 导致 3DGaussianSplatting 数据到渲染层只剩「点 + 颜色」，永远做不出真正的泼溅。
  expect(skels[0]!.vertexPackage.vertexAttributes.map((a) => `${a.semantic}:${a.components}/${a.dtype}`))
    .toEqual(['position:3/f32', 'color:4/u8', 'gsScale:4/u8', 'gsRotation:4/u8']);
  // 名字 → 槽位的映射来自数据自带的 vertexAttributeDescript
  expect(skels[0]!.vertexPackage.customVertexAttribute).toEqual({ GS_Rotation: 1, GS_Scale: 0 });
  expect(tile.bytesRead).toBe(tile.bytesTotal);
});

test('多骨架子瓦：4 块骨架全部解析，条目边界靠 skeletonStreamSize 兜住', async () => {
  const tile = await parse(CHILD_TILE);

  const names = Object.keys(tile.geoPackage);
  expect(names.map((n) => n.match(/%0_(\d+)#/)?.[1])).toEqual(['1597', '2048', '4955', '844']);
  expect(Object.values(tile.geoPackage).map((s) => s.vertexPackage.verticesCount)).toEqual([
    1598, 2049, 4956, 845,
  ]);
  expect(tile.bytesRead).toBe(tile.bytesTotal);

  // 每块骨架的 OBB 必须与 pageLOD 里点名它的 geode 的包围球同心。
  // 偏 4 字节时 0_4955 会读成 center(0,0,0)，这条断言立刻红。
  expect(names.length).toBe(tile.groupNode.pageLods.length);
  for (const lod of tile.groupNode.pageLods) {
    const skelName = lod.geodes[0]!.skeletonNames[0]!;
    const skel = tile.geoPackage[skelName];
    expect(skel, `瓦片里没有骨架 ${skelName}`).toBeTruthy();
    const obb = skel!.obb;
    expect(obb, `${skelName} 缺 OBB`).toBeTruthy();
    const c = lod.boundingSphere.center;
    expect(obb!.center.x).toBeCloseTo(c.x, 3);
    expect(obb!.center.y).toBeCloseTo(c.y, 3);
    expect(obb!.center.z).toBeCloseTo(c.z, 3);
  }
});

test('多骨架子瓦：4 块骨架各自指向下一级，子引用互不重复', async () => {
  const tile = await parse(CHILD_TILE);
  const children = tile.groupNode.pageLods.map((l) => l.childTile);
  expect(new Set(children).size).toBe(4);
  expect(children).toEqual([
    'Tile_0021_262145_524289_0010.s3mb',
    'Tile_0021_262145_524289_0011.s3mb',
    'Tile_0021_262145_524289_0014.s3mb',
    'Tile_0021_262145_524289_0015.s3mb',
  ]);
});

test('泼溅瓦片要能建成 three 对象：无索引包的骨架按 Points 出图，不是「无可用几何」', async () => {
  // 这些瓦片一个索引包都没有 —— 顶点就是点。补不出「顶点即点」的伪包的话，
  // GeometryBuilder 会一块几何都不产出，最后落到 skipped: ['tile 无可用几何']。
  const tile = await parse(CHILD_TILE);
  const res = await buildTileObjects(tile);

  const points: THREE.Points[] = [];
  res.group.traverse((o) => o instanceof THREE.Points && points.push(o));
  expect(points.length).toBe(4);
  expect(res.stats.skipped.length).toBe(0);
  expect(res.stats.meshes).toBe(4);
  expect(points.reduce((s, p) => s + (p.geometry.getAttribute('position')?.count ?? 0), 0)).toBe(9448);
  // 点渲染必须有顶点色可用（PointsMaterial 读内置 color 槽）
  for (const p of points) expect(p.geometry.getAttribute('color')).toBeTruthy();
});
