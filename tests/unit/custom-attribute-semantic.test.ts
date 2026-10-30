import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser.js';
import { assembleTileGeometry } from '../../packages/s3m-three/src/core/TileGeometry.js';
import { S3MWorkerClient } from '../../packages/s3m-three/src/worker/S3MWorkerClient.js';

const TILE_271 = resolve(__dirname, '../fixtures/rvm/Tile_-89065_258271_0000.s3mb');
const TILE_272 = resolve(__dirname, '../fixtures/rvm/Tile_-89065_258272_0000.s3mb');

describe('Issue #9: 标准 S3MB 分支 custom 槽语义映射与 aTextureCoordMatrix 消费', () => {
  const configDescript = [
    {
      category: 'VertexWeight',
      range: { dimension: 1, max: [36.14], min: [23.33] },
    },
    {
      category: 'TextureCoordMatrix',
      range: { dimension: 0, max: [], min: [] },
    },
  ];

  test('瓦片 1 (258271)：按 descript 映射语义，custom0 重命名为 VertexWeight，不留为占位名', async () => {
    const buf = readFileSync(TILE_271);
    const tile = await parseS3MB(buf.buffer, { vertexAttributeDescript: configDescript });
    const skel = Object.values(tile.geoPackage)[0]!;
    const vp = skel.vertexPackage;

    expect(vp.customVertexAttribute).toEqual({ TextureCoordMatrix: 1, VertexWeight: 0 });

    const weightAttr = vp.vertexAttributes.find((a) => a.semantic === 'VertexWeight');
    expect(weightAttr).toBeDefined();
    expect(weightAttr!.components).toBe(1);

    const f32 = new Float32Array(weightAttr!.data.buffer, weightAttr!.data.byteOffset, weightAttr!.data.byteLength / 4);
    expect(f32.length).toBe(204);
    // 实测 VertexWeight 是高度值 [23.327, 25.327]
    expect(f32[0]!).toBeGreaterThan(23.0);
    expect(f32[0]!).toBeLessThan(26.0);

    const texMatrixAttr = vp.vertexAttributes.find((a) => a.semantic === 'TextureCoordMatrix');
    expect(texMatrixAttr).toBeDefined();
    expect(texMatrixAttr!.components).toBe(1);

    // custom0 / custom1 占位名应被语义替换
    expect(vp.vertexAttributes.some((a) => a.semantic === 'custom0')).toBe(false);
    expect(vp.vertexAttributes.some((a) => a.semantic === 'custom1')).toBe(false);
  });

  test('瓦片 2 (258272)：两块瓦片对位一致，custom 槽位映射正确', async () => {
    const buf = readFileSync(TILE_272);
    const tile = await parseS3MB(buf.buffer, { vertexAttributeDescript: configDescript });
    const skel = Object.values(tile.geoPackage)[0]!;
    const vp = skel.vertexPackage;

    const weightAttr = vp.vertexAttributes.find((a) => a.semantic === 'VertexWeight');
    expect(weightAttr).toBeDefined();
    const texMatrixAttr = vp.vertexAttributes.find((a) => a.semantic === 'TextureCoordMatrix');
    expect(texMatrixAttr).toBeDefined();
  });

  test('渲染组装层：VertexWeight（高度值）绝对不能被当成 aTexCoordZ 消费', async () => {
    const buf = readFileSync(TILE_271);
    const tile = await parseS3MB(buf.buffer, { vertexAttributeDescript: configDescript });
    const { primitives } = assembleTileGeometry(tile);

    expect(primitives.length).toBeGreaterThan(0);
    for (const prim of primitives) {
      // 全哨兵或 dimension: 0 的 TextureCoordMatrix，以及 VertexWeight，都不应该进入 aTexCoordZ
      expect(prim.attributes.aTexCoordZ).toBeUndefined();
    }
  });

  test('即便没有传入外部 configDescript，仅凭瓦片内 descript 也应正确映射语义并跳过哨兵 aTexCoordZ', async () => {
    const buf = readFileSync(TILE_271);
    // 模拟不传 options，仅靠瓦片内嵌的 descript 字符串
    const tile = await parseS3MB(buf.buffer);
    const skel = Object.values(tile.geoPackage)[0]!;
    const vp = skel.vertexPackage;

    expect(vp.vertexAttributes.find((a) => a.semantic === 'VertexWeight')).toBeDefined();
    expect(vp.vertexAttributes.find((a) => a.semantic === 'TextureCoordMatrix')).toBeDefined();

    const { primitives } = assembleTileGeometry(tile);
    for (const prim of primitives) {
      expect(prim.attributes.aTexCoordZ).toBeUndefined();
    }
  });

  test('当 TextureCoordMatrix 含有图集矩阵值（如 65536/65792）时，即便 configDescript 中 range.dimension 为 0，也必须正常保留并生成 aTexCoordZ', async () => {
    const buf = readFileSync(TILE_271);
    const tile = await parseS3MB(buf.buffer, { vertexAttributeDescript: configDescript });
    const skel = Object.values(tile.geoPackage)[0]!;
    const texMatAttr = skel.vertexPackage.vertexAttributes.find((a) => a.semantic === 'TextureCoordMatrix')!;
    const f32 = new Float32Array(texMatAttr.data.buffer, texMatAttr.data.byteOffset, texMatAttr.data.byteLength / 4);
    // 模拟地板或管道的有值状态（65536 = level 1, 65792 = level 1 + xTran 1）
    f32.fill(65792);

    const { primitives } = assembleTileGeometry(tile, { vertexAttributeDescript: configDescript });
    expect(primitives.length).toBeGreaterThan(0);
    for (const prim of primitives) {
      expect(prim.attributes.aTexCoordZ).toBeDefined();
      expect(prim.attributes.aTexCoordZ!.array[0]).toBe(65792);
    }
  });

  test('Worker 端到端：透传 vertexAttributeDescript 并产出无 aTexCoordZ 的正确几何', async () => {
    const worker = S3MWorkerClient.create();
    if (!worker) return; // 环境不支持 Worker 时安全跳过
    try {
      const buf = readFileSync(TILE_271);
      const { tile, geometry } = await worker.parseTile(buf.buffer.slice(0), true, true, configDescript);
      const skel = Object.values(tile.geoPackage)[0]!;
      expect(skel.vertexPackage.vertexAttributes.find((a) => a.semantic === 'VertexWeight')).toBeDefined();
      expect(skel.vertexPackage.vertexAttributes.find((a) => a.semantic === 'TextureCoordMatrix')).toBeDefined();
      expect(geometry).toBeDefined();
      for (const prim of geometry!.primitives) {
        expect(prim.attributes.aTexCoordZ).toBeUndefined();
      }
    } finally {
      worker.dispose();
    }
  });
});
