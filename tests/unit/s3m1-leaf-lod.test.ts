/**
 * Issue #23: parseXmlLods 识别裸 <PageLods><Geode>，S3M 1.x 叶子瓦片合成 pageLod 与包围球
 *
 * 场景：
 *   S3M 1.x 数据集（如 3D-suofeiya_church）的最细一层叶子瓦片，XML 里 <PageLods> 底下
 *   直接就是 <Geode>，没有 <PagedLOD> 包装，且没有 <BoundingSphere> / <RangeMode> / <RangeList>。
 *   旧实现只匹配 <PagedLOD>，解析出 pageLods = []，导致瓦片拿不到包围球与矩阵，
 *   在 LOD 计算中无法计算距离与误差。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { parseXmlLods, parseS3M1 } from '../../packages/s3m-three/src/core/S3M1Parser';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

const FIX = (n: string) => join(import.meta.dir, '../fixtures/osgb', n);
const ab = (n: string) => {
  const b = readFileSync(FIX(n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const inflate = (x: Uint8Array) => inflateSync(x);

const align4 = (n: number): number => (n % 4 === 0 ? n : n + (4 - (n % 4)));

/**
 * 借用 s3m1-pipe.s3m 的有效几何段，替换其 XML 段，合成一个完整的 S3M 1.x 瓦片 buffer
 */
function makeS3M1Tile(xmlString: string): ArrayBuffer {
  const orig = inflateSync(readFileSync(FIX('s3m1-pipe.s3m')).subarray(4));
  const origXmlSize = orig.readUInt32LE(0);
  const geoStart = align4(4 + origXmlSize);
  const geoBytes = orig.subarray(geoStart); // 包含 geoSize (u32) + 几何体

  const xmlBuf = Buffer.from(xmlString, 'utf8');
  const xmlLenBuf = Buffer.alloc(4);
  xmlLenBuf.writeUInt32LE(xmlBuf.length, 0);

  const padLen = align4(4 + xmlBuf.length) - (4 + xmlBuf.length);
  const padBuf = Buffer.alloc(padLen);

  const payload = Buffer.concat([xmlLenBuf, xmlBuf, padBuf, geoBytes]);
  const compressed = deflateSync(payload);
  const magic = Buffer.from([0x73, 0x33, 0x6d, 0x00]); // s3m\0
  const all = Buffer.concat([magic, compressed]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

describe('Issue #23: parseXmlLods 识别裸 <PageLods><Geode>', () => {
  test('单 Geode 叶子瓦片：合成 1 个 pageLod，提取 GeoName 与矩阵，默认像素档', () => {
    const xml = `
      <Group>
        <PageLods>
          <Geode>
            <GeoName>1227359687</GeoName>
            <GeoDeModMatrix>1,0,0,0, 0,1,0,0, 0,0,1,0, 10,20,30,1</GeoDeModMatrix>
          </Geode>
        </PageLods>
      </Group>
    `;
    const lods = parseXmlLods(xml);
    expect(lods.length).toBe(1);

    const lod = lods[0]!;
    expect(lod.geoNames).toEqual(['1227359687']);
    expect(lod.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
    expect(lod.childTile).toBe('');
    expect(lod.rangeMode).toBe(1); // 1 = 屏幕像素
    expect(lod.rangeValue).toBe(0);
    // 独立 geodes 字段也逐条带上
    expect(lod.geodes?.length).toBe(1);
    expect(lod.geodes?.[0]?.geoName).toBe('1227359687');
    expect(lod.geodes?.[0]?.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
  });

  test('多 Geode 叶子瓦片：逐条保留每个 Geode 的名字与非单位阵', () => {
    const xml = `
      <Group>
        <PageLods>
          <Geode>
            <GeoName>111111</GeoName>
            <GeoDeModMatrix>1,0,0,0, 0,1,0,0, 0,0,1,0, 5,6,7,1</GeoDeModMatrix>
          </Geode>
          <Geode>
            <GeoName>222222</GeoName>
            <GeoDeModMatrix>2,0,0,0, 0,2,0,0, 0,0,2,0, 15,16,17,1</GeoDeModMatrix>
          </Geode>
        </PageLods>
      </Group>
    `;
    const lods = parseXmlLods(xml);
    expect(lods.length).toBe(1);

    const lod = lods[0]!;
    expect(lod.geoNames).toEqual(['111111', '222222']);
    expect(lod.geodes?.length).toBe(2);
    expect(lod.geodes?.[0]?.geoName).toBe('111111');
    expect(lod.geodes?.[0]?.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    expect(lod.geodes?.[1]?.geoName).toBe('222222');
    expect(lod.geodes?.[1]?.matrix).toEqual([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 15, 16, 17, 1]);
  });

  test('既无 PagedLOD 也无 Geode 时返回空数组（保持原有边界安全）', () => {
    const xml = `<Group><PageLods></PageLods></Group>`;
    expect(parseXmlLods(xml)).toEqual([]);
  });
});

describe('Issue #23: parseS3M1 包围球解析期计算与 S3MTileset 调度', () => {
  test('无 BoundingSphere 标签时从顶点计算真实包围盒与包围球', async () => {
    // s3m1-pipe 的网格名是 3531930689
    const xml = `
      <Group>
        <PageLods>
          <Geode>
            <GeoName>3531930689</GeoName>
            <GeoDeModMatrix>1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1</GeoDeModMatrix>
          </Geode>
        </PageLods>
      </Group>
    `;
    const tileBuffer = makeS3M1Tile(xml);
    const parsed = await parseS3M1(tileBuffer, { inflate });

    expect(parsed.groupNode?.pageLods?.length).toBe(1);
    const pl = parsed.groupNode!.pageLods[0]!;
    expect(pl.boundingSphere).toBeDefined();
    expect(pl.boundingSphere.radius).toBeGreaterThan(0);

    // 验证 center 落在顶点的 AABB 范围内部
    const g = parsed.geoPackage['SuperMapCache#3531930689']!;
    const posAttr = g.vertexPackage.vertexAttributes.find((a) => a.semantic === 'position')!;
    const pos = new Float32Array(posAttr.data.buffer, posAttr.data.byteOffset, posAttr.data.byteLength / 4);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const expectedCenter = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2,
    };
    expect(pl.boundingSphere.center.x).toBeCloseTo(expectedCenter.x, 3);
    expect(pl.boundingSphere.center.y).toBeCloseTo(expectedCenter.y, 3);
    expect(pl.boundingSphere.center.z).toBeCloseTo(expectedCenter.z, 3);
  });

  test('非单位阵平移时，解析期计算的包围球中心相应偏移', async () => {
    const xml = `
      <Group>
        <PageLods>
          <Geode>
            <GeoName>3531930689</GeoName>
            <GeoDeModMatrix>1,0,0,0, 0,1,0,0, 0,0,1,0, 100,200,300,1</GeoDeModMatrix>
          </Geode>
        </PageLods>
      </Group>
    `;
    const tileBuffer = makeS3M1Tile(xml);
    const parsed = await parseS3M1(tileBuffer, { inflate });
    const pl = parsed.groupNode!.pageLods[0]!;

    const g = parsed.geoPackage['SuperMapCache#3531930689']!;
    const posAttr = g.vertexPackage.vertexAttributes.find((a) => a.semantic === 'position')!;
    const pos = new Float32Array(posAttr.data.buffer, posAttr.data.byteOffset, posAttr.data.byteLength / 4);

    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
    }
    // 加上平移 100
    const expectedCenterX = (minX + maxX) / 2 + 100;
    expect(pl.boundingSphere.center.x).toBeCloseTo(expectedCenterX, 3);
  });

  test('在 S3MTileset 调度中，叶子瓦片拿到 sphere 后正常计算距离与更新 lastSeen', async () => {
    const xml = `
      <Group>
        <PageLods>
          <Geode>
            <GeoName>3531930689</GeoName>
            <GeoDeModMatrix>1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1</GeoDeModMatrix>
          </Geode>
        </PageLods>
      </Group>
    `;
    const tileBuffer = makeS3M1Tile(xml);
    const parsed = await parseS3M1(tileBuffer, { inflate });

    const ts = new S3MTileset({
      url: 'https://example.com/datas/Config/config',
    });
    // 注入一个 node
    const pl = parsed.groupNode!.pageLods[0]!;
    const node: any = {
      url: 'https://example.com/datas/Config/data/path/Tile/leaf.s3m',
      tile: parsed,
      group: { isObject3D: true, children: [], updateMatrixWorld: () => {} },
      sphere: pl.boundingSphere,
      rangeValue: pl.rangeValue,
      rangeMode: pl.rangeMode,
      childUrls: [],
      state: 'ready',
      stats: { meshes: 1, vertices: 10, triangles: 10, memory: 100 },
    };
    ts.rootUrls.push(node.url);
    ts.nodes.set(node.url, node);

    // 相机位于包围球中心 + 100m 处
    const cam = [pl.boundingSphere.center.x, pl.boundingSphere.center.y, pl.boundingSphere.center.z + 100];
    ts.update(cam, 0.6, 1080);

    // 验证：distance 应该精确为 100m（而不是 null 或 0）
    expect(node.distance).toBeCloseTo(100, 1);
    expect(node.lastSeen).toBe(ts._frame);
    expect(node.needRefine).toBe(false);
  });
});
