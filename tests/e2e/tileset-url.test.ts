/**
 * 端到端验证：模拟浏览器环境（document.baseURI + fetch + DecompressionStream），
 * 从相对 configUrl 出发走完整链路，确认 URL 解析与瓦片加载没有回归。
 *
 * 需要跑起来的静态服务 + 同级目录里的 s3m-spec 样例，所以默认不跑：
 *
 *   bun run serve                       # 另开一个终端
 *   S3M_E2E_BASE=http://localhost:8123/s3m-maplibre/demo/index.html bun test ./tests/e2e
 *
 * 用桩替代渲染层，只验证 URL 解析 + 解析器本身，不引入 three。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';

const BASE = process.env.S3M_E2E_BASE;
const CASES: [string, string][] = [
  ['cbd', '../../s3m-spec/S3M_SDK/S3M_JS/data/CBD/cbd.scp'],
  ['comModel', '../../s3m-spec/S3M_SDK/S3M_JS/data/comModel/comModel.scp'],
];

if (!BASE) {
  test.skip('跳过端到端：未设置 S3M_E2E_BASE（见文件头注释）', () => {});
} else {
  describe(`端到端（${BASE}）`, () => {
    let S3MTileset: any;
    let parseS3MB: any;
    const originalDocument = (globalThis as any).document;

    beforeAll(async () => {
      // toAbsolute 依赖 document.baseURI，必须在 import 之前伪装好
      (globalThis as any).document = { baseURI: BASE };
      ({ S3MTileset } = await import('../../packages/s3m-three/src/tileset/S3MTileset'));
      ({ parseS3MB } = await import('../../packages/s3m-three/src/core/S3MBParser'));
    });

    afterAll(() => {
      (globalThis as any).document = originalDocument;
    });

    const stubBuild = async (tile: any) => ({
      group: { traverse() {}, children: Object.keys(tile.geoPackage) },
      stats: {
        meshes: Object.keys(tile.geoPackage).length,
        vertices: Object.values(tile.geoPackage).reduce((s: number, g: any) => s + (g.vertexPackage.verticesCount || 0), 0),
        triangles: 0,
        textures: Object.keys(tile.textures).length,
        instanced: 0,
        skipped: [],
      },
    });

    for (const [name, rel] of CASES) {
      test(`${name}：相对 configUrl 被解析成绝对地址`, async () => {
        const seen: string[] = [];
        const errors: string[] = [];
        const ts = new S3MTileset({
          configUrl: rel,
          buildTile: stubBuild,
          onTile: (node: any) => seen.push(node.url),
          onError: (e: Error) => errors.push(e.message),
        });

        await ts.init();
        expect(errors).toEqual([]);
        expect(seen.length).toBeGreaterThan(0);
        for (const url of seen) expect(url).toMatch(/^https?:\/\//); // 不能残留 ./ 或相对路径
      });
    }

    test('解析器直连：从相对 URL 取瓦片并读出头部', async () => {
      const url = new URL(
        '../../s3m-spec/S3M_SDK/S3M_JS/data/comModel/Tile_-166159_525382_0000/Tile_-166159_525382_0000.s3mb',
        BASE
      );
      const buf = await (await fetch(url)).arrayBuffer();
      const tile = await parseS3MB(buf, { inflate: inflateSync });
      expect(tile.version).toBeGreaterThan(0);
      expect(Object.keys(tile.geoPackage).length).toBeGreaterThan(0);
      expect(tile.bytesRead).toBe(tile.bytesTotal);
    });
  });
}
