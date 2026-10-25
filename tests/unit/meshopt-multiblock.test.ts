/**
 * MeshOpt 多块骨架（blockCount > 1）单测。
 *
 * 夹具用 meshoptimizer 编码器现场合成（见 helpers/meshopt-tile.ts）：
 * 属性流走真实「编码 → 解码」路径，索引用未压缩 uint32 逐值可断言。
 *
 * 布局要点（从 3D-WorkSpace_pbr1/pbrmodel 真实瓦片逐字节标定）：
 *   索引包**夹在块与块之间**（每块各带一份），不是所有块之后再统一放；
 *   索引是块内局部编号，合并顶点缓冲后必须整体偏移。
 */
import { describe, expect, test } from 'bun:test';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import {
  buildMeshOptTile,
  quantizedPosition,
  quantizedTexCoord,
  vertexColor,
  type BlockSpec,
} from '../helpers/meshopt-tile';

function parse(blocks: BlockSpec[]) {
  return parseS3MB(buildMeshOptTile(blocks));
}

function f32Attr(vp: any, semantic: string): Float32Array {
  const a = vp.vertexAttributes.find((x: any) => x.semantic === semantic);
  expect(a).toBeTruthy();
  expect(a.dtype).toBe('f32');
  return new Float32Array(a.data.buffer, a.data.byteOffset, a.data.byteLength / 4);
}

function u8Attr(vp: any, semantic: string): Uint8Array {
  const a = vp.vertexAttributes.find((x: any) => x.semantic === semantic);
  expect(a).toBeTruthy();
  return a.data;
}

function packIndices(pack: any): Uint32Array {
  expect(pack.indexType).toBe(3); // 解析端按实际位宽回写，未压缩 uint32 → 3
  return new Uint32Array(pack.indices.buffer, pack.indices.byteOffset, pack.indexCount);
}

const twoBlocks: BlockSpec[] = [
  {
    vertexCount: 512,
    vertScale: 0.25,
    min: [100, 200, 300],
    texScale: [0.5, 0.25],
    texOffset: [0.1, 0.2],
    indexPacks: [Array.from({ length: 1536 }, (_, i) => i % 512)],
  },
  {
    vertexCount: 768,
    vertScale: 0.5,
    min: [-50, -60, -70],
    texScale: [2, 2],
    texOffset: [-1, -2],
    indexPacks: [Array.from({ length: 2304 }, (_, i) => i % 768)],
  },
];

describe('MeshOpt 多块骨架（blockCount > 1）', () => {
  test('多块合并：顶点数相加，字节消费完整', async () => {
    const tile = await parse(twoBlocks);
    // bytesRead === bytesTotal 同时验证了夹具的字节布局没有多写少写
    expect(tile.bytesRead).toBe(tile.bytesTotal);

    const vp = tile.geoPackage.GeoTest.vertexPackage;
    expect(vp.verticesCount).toBe(512 + 768);
  });

  test('各块用自己的量化常量解位置（min + u16 × scale）', async () => {
    const tile = await parse(twoBlocks);
    const vp = tile.geoPackage.GeoTest.vertexPackage;
    const pos = f32Attr(vp, 'position');
    expect(pos.length).toBe((512 + 768) * 3);

    // 块 0 第 0 个与最后一个顶点
    for (const v of [0, 511]) {
      const [qx, qy, qz] = quantizedPosition(twoBlocks[0], v);
      const { min, vertScale } = twoBlocks[0];
      expect(pos[v * 3]).toBeCloseTo(min[0] + qx * vertScale, 4);
      expect(pos[v * 3 + 1]).toBeCloseTo(min[1] + qy * vertScale, 4);
      expect(pos[v * 3 + 2]).toBeCloseTo(min[2] + qz * vertScale, 4);
    }
    // 块 1：如果错用了块 0 的 min/scale，这里立刻对不上
    for (const v of [0, 767]) {
      const [qx, qy, qz] = quantizedPosition(twoBlocks[1], v);
      const { min, vertScale } = twoBlocks[1];
      const base = 512;
      expect(pos[(base + v) * 3]).toBeCloseTo(min[0] + qx * vertScale, 4);
      expect(pos[(base + v) * 3 + 1]).toBeCloseTo(min[1] + qy * vertScale, 4);
      expect(pos[(base + v) * 3 + 2]).toBeCloseTo(min[2] + qz * vertScale, 4);
    }
  });

  test('其余属性流长度对齐，UV 用各块自己的 scale/offset', async () => {
    const tile = await parse(twoBlocks);
    const vp = tile.geoPackage.GeoTest.vertexPackage;
    const total = 512 + 768;

    expect(u8Attr(vp, 'color').length).toBe(total * 4);
    expect(f32Attr(vp, 'normal').length).toBe(total * 3);
    const uv = f32Attr(vp, 'uv');
    expect(uv.length).toBe(total * 2);

    // 块 1 的 UV：u16 = 10+v / 20+v，scale [2,2]、offset [-1,-2]
    const b1 = twoBlocks[1];
    const v = 100;
    const [tu, tv] = quantizedTexCoord(b1, v);
    expect(uv[(512 + v) * 2]).toBeCloseTo(b1.texOffset![0] + tu * b1.texScale![0], 4);
    expect(uv[(512 + v) * 2 + 1]).toBeCloseTo(b1.texOffset![1] + tv * b1.texScale![1], 4);

    // 块 0 的 UV：scale [0.5, 0.25]、offset [0.1, 0.2]
    const b0 = twoBlocks[0];
    const [tu0, tv0] = quantizedTexCoord(b0, v);
    expect(uv[v * 2]).toBeCloseTo(b0.texOffset![0] + tu0 * b0.texScale![0], 4);
    expect(uv[v * 2 + 1]).toBeCloseTo(b0.texOffset![1] + tv0 * b0.texScale![1], 4);
  });

  test('每块各带索引包：块内局部编号合并后整体偏移', async () => {
    const tile = await parse(twoBlocks);
    const geo = tile.geoPackage.GeoTest;
    const packs = geo.indexPackages;
    expect(packs.length).toBe(2);

    // 块 0 的包：基数 0，索引保持原值
    const i0 = packIndices(packs[0]);
    expect(i0.length).toBe(1536);
    expect(Array.from(i0.slice(0, 4))).toEqual([0, 1, 2, 3]);
    expect(i0.reduce((m, v) => Math.max(m, v))).toBeLessThan(512);

    // 块 1 的包：文件里是 0..767 的块内编号，解析后必须 +512
    const i1 = packIndices(packs[1]);
    expect(i1.length).toBe(2304);
    expect(Array.from(i1.slice(0, 4))).toEqual([512, 513, 514, 515]);
    // 索引不能越过合并后顶点缓冲的边界（GeometryBuilder 直接按它建 BufferGeometry）
    expect(i1.reduce((m, v) => Math.max(m, v))).toBeLessThan(1280);
  });

  test('blockCount = 3 且块内多索引包：包数与顺序都保留', async () => {
    const blocks: BlockSpec[] = [
      {
        vertexCount: 300,
        vertScale: 1,
        min: [0, 0, 0],
        // 一块两个包（模拟按材质分组）
        indexPacks: [
          Array.from({ length: 900 }, (_, i) => i % 300),
          Array.from({ length: 300 }, (_, i) => (i * 7) % 300),
        ],
      },
      {
        vertexCount: 200,
        vertScale: 1,
        min: [10, 0, 0],
        indexPacks: [Array.from({ length: 600 }, (_, i) => i % 200)],
      },
      {
        vertexCount: 100,
        vertScale: 1,
        min: [20, 0, 0],
        indexPacks: [Array.from({ length: 300 }, (_, i) => i % 100)],
      },
    ];

    const tile = await parse(blocks);
    const geo = tile.geoPackage.GeoTest;
    expect(geo.vertexPackage.verticesCount).toBe(600);
    expect(geo.indexPackages.length).toBe(4);

    // 包按块顺序拼接：[块0包0, 块0包1, 块1包, 块2包]，各包的索引必须落在所属块的区间内
    const ranges: Array<[number, number]> = [
      [0, 300],
      [0, 300],
      [300, 200],
      [500, 100],
    ];
    geo.indexPackages.forEach((pack: any, i: number) => {
      const idx = packIndices(pack);
      const [base, span] = ranges[i];
      for (let k = 0; k < idx.length; k++) {
        expect(idx[k]).toBeGreaterThanOrEqual(base);
        expect(idx[k]).toBeLessThan(base + span);
      }
    });

    // passNames 没有在偏移过程中丢失
    expect(geo.indexPackages[0].passNames).toEqual(['mat#BatchPBR_0']);
  });

  test('blockCount = 1 与旧路径行为一致（回归）', async () => {
    const blocks: BlockSpec[] = [
      {
        vertexCount: 256,
        vertScale: 0.1,
        min: [5, 6, 7],
        indexPacks: [Array.from({ length: 768 }, (_, i) => i % 256)],
      },
    ];
    const tile = await parse(blocks);
    expect(tile.bytesRead).toBe(tile.bytesTotal);

    const geo = tile.geoPackage.GeoTest;
    expect(geo.vertexPackage.verticesCount).toBe(256);
    expect(geo.indexPackages.length).toBe(1);

    const pos = f32Attr(geo.vertexPackage, 'position');
    const [qx, qy, qz] = quantizedPosition(blocks[0], 255);
    const { min, vertScale } = blocks[0];
    expect(pos[255 * 3]).toBeCloseTo(min[0] + qx * vertScale, 4);

    const idx = packIndices(geo.indexPackages[0]);
    expect(Array.from(idx.slice(0, 3))).toEqual([0, 1, 2]);
  });

  test('TANGENT 流被跳过，不拖垮多块解析', async () => {
    const blocks: BlockSpec[] = [
      {
        vertexCount: 128,
        vertScale: 1,
        min: [0, 0, 0],
        withTangent: true,
        indexPacks: [Array.from({ length: 384 }, (_, i) => i % 128)],
      },
      {
        vertexCount: 128,
        vertScale: 1,
        min: [1, 1, 1],
        withTangent: true,
        indexPacks: [Array.from({ length: 384 }, (_, i) => i % 128)],
      },
    ];
    const tile = await parse(blocks);
    expect(tile.bytesRead).toBe(tile.bytesTotal);
    const vp = tile.geoPackage.GeoTest.vertexPackage;
    expect(vp.verticesCount).toBe(256);
    // 切线不进属性流
    expect(vp.vertexAttributes.find((a: any) => a.semantic === 'tangent')).toBeUndefined();
  });

  test('描述串取自数据本身（customVertexAttribute）', async () => {
    const tile = await parse(twoBlocks);
    const vp = tile.geoPackage.GeoTest.vertexPackage;
    expect(vp.customVertexAttribute).toEqual({ TextureCoordMatrix: 1, VertexWeight: 0 });
  });
});
