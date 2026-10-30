/**
 * 回归测试：S3M v3 的 Draco 三角网格分支（core/Draco.ts）
 *
 * 当前（实现前）所有「三角网格」相关测试都应该失败或通过鲁棒性测试。
 * 按照项目规范：先写失败测试 → 跑一遍确认失败 → 写实现 → 全绿。
 *
 * fixture 来源：tests/helpers/draco-mesh-tile.ts 用 draco3d 编码器在运行时合成，
 * 不依赖外部真实瓦片。几何：正方形 4 顶点 2 三角面。
 *
 * 核实路径（与 Issue #5 调研一致）：
 *   - 容器头与点云共用（payloadSize / posUniqueId / dracoSize / …）
 *   - 解码用 DecodeArrayToMesh + GetFaceFromMesh 逐面取索引
 *   - IndexPackage.primitiveType = 4（THREE.TrianglePrimitive，对应 gl.TRIANGLES）
 *   - IndexPackage.useIndex = 1，indices 不为 null
 */
import { expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { buildDracoMeshTile } from '../helpers/draco-mesh-tile';

/** THREE.Triangles 对应的 primitiveType 值（gl.TRIANGLES = 4） */
const TRIANGLE_PRIMITIVE = 4;

async function parseMeshTile() {
  const buf = await buildDracoMeshTile();
  return parseS3MB(buf, { inflate: (x) => inflateSync(x) });
}

// ---- 鲁棒性（当前实现前必须先失败） ----

test('Draco 三角网格：不再因「暂未实现」抛错导致整层崩溃', async () => {
  // 当前实现会抛 "[s3m] Draco 三角网格 几何暂未实现（仅支持点云）"
  // 实现后应正常返回解析结果（不抛错）
  let err: unknown = null;
  try {
    await parseMeshTile();
  } catch (e) {
    err = e;
  }
  expect(err).toBeNull();
});

// ---- 完整实现（以下均为新能力测试） ----

test('Draco 三角网格：解析成功，版本号正确，字节流对齐', async () => {
  const tile = await parseMeshTile();
  expect(tile.version).toBe(3.01);
  // 整块流必须不多不少吃完——字段顺序读错时这里第一个炸
  expect(tile.bytesRead).toBe(tile.bytesTotal);
});

test('Draco 三角网格：骨架数为 1，顶点数为 4（正方形 4 顶点）', async () => {
  const tile = await parseMeshTile();
  const skels = Object.values(tile.geoPackage);
  expect(skels.length).toBe(1);
  const vp = skels[0]!.vertexPackage;
  expect(vp.verticesCount).toBe(4);
});

test('Draco 三角网格：包含 position 属性，分量数 3，类型 f32', async () => {
  const tile = await parseMeshTile();
  const vp = Object.values(tile.geoPackage)[0]!.vertexPackage;
  const pos = vp.vertexAttributes.find((a) => a.semantic === 'position');
  expect(pos).toBeDefined();
  expect(pos!.components).toBe(3);
  expect(pos!.dtype).toBe('f32');
  expect(pos!.data.length).toBe(4 * 3 * 4); // 4 顶点 × 3 分量 × 4 字节
});

test('Draco 三角网格：position 坐标全部有限且与编码值吻合', async () => {
  const tile = await parseMeshTile();
  const vp = Object.values(tile.geoPackage)[0]!.vertexPackage;
  const raw = vp.vertexAttributes.find((a) => a.semantic === 'position')!.data;
  const pos = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);

  expect(pos.length).toBe(12); // 4 顶点 × 3
  for (const v of pos) {
    expect(Number.isFinite(v)).toBe(true);
  }

  // 夹具顶点坐标（量化误差 < 0.01）：
  // 顶点 0: (0,0,0)  1: (1,0,0)  2: (1,1,0)  3: (0,1,0)
  const expected = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  // 坐标顺序可能因 draco 重排而变，只断言集合覆盖
  const rows: Array<[number, number, number]> = [];
  for (let v = 0; v < 4; v++) {
    rows.push([
      Math.round(pos[v * 3]!),
      Math.round(pos[v * 3 + 1]!),
      Math.round(pos[v * 3 + 2]!),
    ]);
  }
  for (const [ex, ey, ez] of expected) {
    expect(rows.some(([rx, ry, rz]) => rx === ex && ry === ey && rz === ez)).toBe(true);
  }
});

test('Draco 三角网格：IndexPackage 有索引，primitiveType = 4（THREE.Triangles）', async () => {
  const tile = await parseMeshTile();
  const ip = Object.values(tile.geoPackage)[0]!.indexPackages[0]!;

  // 三角网格必须有索引
  expect(ip.useIndex).toBe(1);
  expect(ip.indices).not.toBeNull();

  // primitiveType 必须是三角形（4），不能是点云的 1
  expect(ip.primitiveType).toBe(TRIANGLE_PRIMITIVE);
});

test('Draco 三角网格：索引数 = 2 面 × 3 = 6，无越界', async () => {
  const tile = await parseMeshTile();
  const vp = Object.values(tile.geoPackage)[0]!.vertexPackage;
  const ip = Object.values(tile.geoPackage)[0]!.indexPackages[0]!;

  // 2 个三角面 × 3 = 6 个索引
  expect(ip.indexCount).toBe(6);

  // 索引不越界
  const buf = ip.indices!;
  const view = ip.indexType === 0
    ? new Uint16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
    : new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

  expect(view.length).toBe(6);
  for (const idx of view) {
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(vp.verticesCount);
  }
});

test('Draco 三角网格：默认行为不变 —— 点云骨架仍正常解析（不受影响）', async () => {
  // 回归：三角网格实现不应破坏已有的点云路径
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const FIXTURES = join(import.meta.dir, '../fixtures/draco');
  const b = readFileSync(join(FIXTURES, 'pointcloud.s3mb'));
  const result = await parseS3MB(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    { inflate: (x) => inflateSync(x) }
  );
  const vp = Object.values(result.geoPackage)[0]!.vertexPackage;
  expect(vp.verticesCount).toBe(6149);
  // 点包的 primitiveType 仍为 1（不应被三角网格实现修改）
  const ip = Object.values(result.geoPackage)[0]!.indexPackages[0]!;
  expect(ip.primitiveType).toBe(1);
});
