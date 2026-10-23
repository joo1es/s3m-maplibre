/**
 * 端到端验证：模拟浏览器环境（document.baseURI + fetch + DecompressionStream），
 * 从相对 configUrl 出发走完整链路，确认 URL 解析与瓦片加载没有回归。
 *
 *   node tools/e2e.mjs [baseUrl]
 */
import { inflateSync } from 'node:zlib';

const BASE = process.argv[2] ?? 'http://localhost:8123/s3m-maplibre/demo/index.html';

// 伪装成浏览器：toAbsolute 依赖 document.baseURI
globalThis.document = { baseURI: BASE };

const { S3MTileset } = await import('../dist/tileset/S3MTileset.js');
const { parseS3MB } = await import('../dist/core/S3MBParser.js');

// 用桩替代渲染层，验证 URL 解析 + 解析器本身，不引入 three
const stubBuild = async (tile) => ({
  group: { traverse() {}, children: Object.keys(tile.geoPackage) },
  stats: {
    meshes: Object.keys(tile.geoPackage).length,
    vertices: Object.values(tile.geoPackage).reduce((s, g) => s + (g.vertexPackage.verticesCount || 0), 0),
    triangles: 0,
    textures: Object.keys(tile.textures).length,
    instanced: 0,
    skipped: [],
  },
});

const CASES = [
  ['cbd', '../../s3m-spec/S3M_SDK/S3M_JS/data/CBD/cbd.scp'],
  ['comModel', '../../s3m-spec/S3M_SDK/S3M_JS/data/comModel/comModel.scp'],
];

let failed = 0;

for (const [name, rel] of CASES) {
  process.stdout.write(`\n[${name}] configUrl = ${rel}\n`);

  const seen = [];
  const ts = new S3MTileset({
    configUrl: rel,
    buildTile: stubBuild,
    onTile: (node) => seen.push(node.url),
    onError: (e) => {
      console.log('  ✗', e.message);
      failed++;
    },
  });

  try {
    await ts.init();
  } catch (e) {
    console.log('  ✗ init:', e.message);
    failed++;
    continue;
  }

  console.log('  配置 →', ts.configUrl);
  console.log('  锚点 →', ts.anchor);
  for (const url of seen) {
    console.log('  瓦片 →', url.replace(/^https?:\/\/[^/]+/, ''));
    if (/^\.\.?\//.test(url) || !/^https?:/.test(url)) {
      console.log('  ✗ URL 未解析成绝对地址');
      failed++;
    }
  }
  console.log('  统计 →', JSON.stringify(ts.stats));
}

// 顺带确认解析器仍能吃掉样例
const sample = await fetch(new URL('../../s3m-spec/S3M_SDK/S3M_JS/data/comModel/Tile_-166159_525382_0000/Tile_-166159_525382_0000.s3mb', BASE));
const buf = await sample.arrayBuffer();
const tile = await parseS3MB(buf, { inflate: (b) => inflateSync(b) });
console.log(`\n解析器直连 → v${tile.version}，${Object.keys(tile.geoPackage).length} 个骨架，读取 ${tile.bytesRead}/${tile.bytesTotal}B`);

console.log(failed === 0 ? '\n通过：URL 解析与加载链路正常' : `\n失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
