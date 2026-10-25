/**
 * 回归测试：S3M v3 的 Draco 点云分支（core/Draco.ts）
 *
 * 样本来自 SuperMap Online 的点云服务，抓取后留在仓库里当 fixture：
 *   pointcloud.s3mb       —— 单骨架，6149 点
 *   pointcloud-multi.s3mb —— 4 骨架（多骨架才是藏 bug 的地方）
 *
 * 这条分支的容器**与规范描述对不上**，字段顺序是从真实瓦片逐字节标定的，而且
 * 官方 SDK 的 parseDracoSkeleton 解析不了同一个服务（多一个 materialCount、
 * 且 `version === 3` 的判定对 v3.01 不成立）。所以这里用不变量把结构钉死：
 * 谁改了字段顺序，这几条断言必须红。
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';

const FIXTURES = join(import.meta.dir, '../fixtures/draco');

async function parse(name: string) {
  const b = readFileSync(join(FIXTURES, name));
  return parseS3MB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, {
    inflate: (x) => inflateSync(x),
  });
}

const asF32 = (data: Uint8Array) =>
  new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);

test('Draco 点云：单骨架解码完整，属性与自定义映射都对', async () => {
  const tile = await parse('pointcloud.s3mb');

  expect(tile.version).toBe(3.01);
  const skels = Object.values(tile.geoPackage);
  expect(skels.length).toBe(1);
  // 整块流必须不多不少吃完 —— 字段顺序读错时这里第一个炸
  expect(tile.bytesRead).toBe(tile.bytesTotal);

  const vp = skels[0]!.vertexPackage;
  expect(vp.verticesCount).toBe(6149);
  expect(vp.vertexAttributes.map((a) => `${a.semantic}:${a.components}/${a.dtype}`).sort())
    .toEqual(['batchId:1/f32', 'color:4/u8', 'position:3/f32']);

  // descript 的 value 是「自定义属性在 uid 数组里的下标」，不是分量数
  expect(vp.customVertexAttribute).toEqual({
    PointCloudClassCode: 2,
    PointCloudIntensity: 1,
    VertexWeight: 0,
  });

  const pos = asF32(vp.vertexAttributes.find((a) => a.semantic === 'position')!.data);
  expect(pos.length / 3).toBe(vp.verticesCount);
  for (const v of pos) {
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThan(1000); // 局部 ENU 米，点云在百米量级
  }

  // 分类码在解析阶段被烘成 batchId（点云没有单体，只能整类控制）
  const batch = asF32(vp.vertexAttributes.find((a) => a.semantic === 'batchId')!.data);
  expect(batch.length).toBe(vp.verticesCount);
  let maxClass = 0;
  for (const v of batch) {
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    maxClass = Math.max(maxClass, v);
  }
  expect(maxClass).toBeLessThanOrEqual(16);

  // 点包没有索引；有索引的话也不能越界
  for (const p of skels[0]!.indexPackages) {
    if (p.indices) {
      const view = new Uint32Array(
        p.indices.buffer.slice(p.indices.byteOffset, p.indices.byteOffset + p.indices.byteLength) as ArrayBuffer
      );
      for (const i of view) expect(i).toBeLessThan(vp.verticesCount);
    }
  }
});

test('Draco 点云：LOD 头解出来的 rangeMode / childTile 与数据一致', async () => {
  const tile = await parse('pointcloud.s3mb');
  expect(tile.groupNode.pageLods.length).toBe(1);
  const lod = tile.groupNode.pageLods[0]!;
  // 点云走的是 Distance_From_EyePoint（米），不是屏幕像素
  expect(lod.rangeMode).toBe(0);
  expect(lod.rangeValue).toBeCloseTo(9783.939453125, 3);
  expect(lod.childTile).toBe('Tile_0014_5117_8477_0000.s3mb');
  expect(lod.boundingSphere.radius).toBeGreaterThan(0);
});

test('Draco 点云：多骨架瓦片每块都解得动，且逐条流对齐', async () => {
  const tile = await parse('pointcloud-multi.s3mb');
  const skels = Object.values(tile.geoPackage);
  expect(skels.length).toBe(4);
  expect(tile.bytesRead).toBe(tile.bytesTotal);
  expect(tile.groupNode.pageLods.length).toBe(4);

  for (const s of skels) {
    const vp = s.vertexPackage;
    expect(vp.verticesCount).toBeGreaterThan(0);
    const semantics = vp.vertexAttributes.map((a) => a.semantic);
    expect(semantics).toContain('position');
    expect(semantics).toContain('color');
    expect(semantics).toContain('batchId');
    const pos = vp.vertexAttributes.find((a) => a.semantic === 'position')!;
    expect(pos.data.length).toBe(vp.verticesCount * 12);
    const col = vp.vertexAttributes.find((a) => a.semantic === 'color')!;
    expect(col.data.length).toBe(vp.verticesCount * 4);
  }
});

test('Draco 分支已接线：不再抛「需接入 draco3d 解码器」占位错误', async () => {
  // 这条是防回退的：以前遇到 VertexTag.DRACO 直接抛错，整个点云服务加载不出来
  let err: unknown = null;
  try {
    await parse('pointcloud.s3mb');
  } catch (e) {
    err = e;
  }
  expect(err).toBeNull();
});
