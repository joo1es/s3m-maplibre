/**
 * LOD 链路探针：模拟相机贴近，观察细化是否触发，以及每级纹理分辨率的真实上限。
 *   node tools/lod-probe.mjs [baseUrl]
 */
import { inflateSync } from 'node:zlib';

const BASE = process.argv[2] ?? 'http://localhost:8123/s3m-maplibre/demo/index.html';
globalThis.document = { baseURI: BASE };

const { S3MTileset } = await import('../dist/tileset/S3MTileset.js');

const stubBuild = async (tile) => ({
  group: { traverse() {} },
  stats: { meshes: 0, vertices: 0, triangles: 0, textures: 0, instanced: 0, skipped: [] },
});

const ts = new S3MTileset({
  configUrl: '../../s3m-spec/S3M_SDK/S3M_JS/data/CBD/cbd.scp',
  buildTile: stubBuild,
  onError: (e) => console.log('  ✗', e.message),
});

await ts.init();

function report(node, depth) {
  const t = node.tile;
  const texs = Object.values(t.textures);
  const maxTex = texs.reduce((m, x) => Math.max(m, Math.max(x.width, x.height)), 0);
  const minTex = texs.reduce((m, x) => Math.min(m, Math.min(x.width, x.height)), Infinity);
  const verts = Object.values(t.geoPackage).reduce((s, g) => s + (g.vertexPackage.verticesCount || 0), 0);
  const tris = Object.values(t.geoPackage).reduce(
    (s, g) => s + g.indexPackages.reduce((a, p) => a + (p.primitiveType === 4 ? p.indexCount / 3 : 0), 0), 0
  );
  const skel = Object.keys(t.geoPackage).length;
  console.log(
    `  L${depth} ${node.url.split('/').pop().padEnd(42)} ` +
      `骨架 ${String(skel).padStart(3)} 顶点 ${String(verts).padStart(6)} 三角面 ${String(Math.round(tris)).padStart(6)} ` +
      `纹理 ${texs.length} 张 ${minTex === Infinity ? '-' : minTex}~${maxTex}px ` +
      `range=${node.rangeValue.toFixed(1)} r=${node.sphere?.radius.toFixed(1) ?? '-'}`
  );
  return node.childUrl;
}

const root = [...ts.nodes.values()][0];
let url = root.url;
let depth = 0;
const chain = [root];
report(root, depth);

// 相机贴近到锚点附近 30 米高空，逐级触发细化
for (let i = 0; i < 6; i++) {
  ts.update([0, 0, 30], 0.6435, 900);
  await new Promise((r) => setTimeout(r, 400));
  const next = [...ts.nodes.values()].find((n) => !chain.includes(n));
  if (!next) break;
  chain.push(next);
  report(next, ++depth);
}

console.log(`\n共 ${ts.nodes.size} 个瓦片，加载队列 ${ts.stats.loading}，失败 ${ts.stats.failed}`);
