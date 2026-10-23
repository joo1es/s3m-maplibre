/**
 * 用官方样例数据验证解析器：node tools/parse-sample.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { parseS3MB } from '../dist/core/S3MBParser.js';

const ROOT = fileURLToPath(new URL('../../s3m-spec/S3M_SDK/S3M_JS/data/', import.meta.url));

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.s3mb')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.log(`样例 s3mb 文件：${files.length} 个\n`);

let ok = 0;
let fail = 0;
let totalVerts = 0;
let totalTris = 0;
let totalTexBytes = 0;

for (const file of files) {
  const buf = readFileSync(file);
  const label = file.slice(ROOT.length).replace(/\\/g, '/');
  try {
    const tile = await parseS3MB(toArrayBuffer(buf), { inflate: (b) => inflateSync(b) });

    let verts = 0;
    let tris = 0;
    const skelInfo = [];
    for (const [name, geo] of Object.entries(tile.geoPackage)) {
      const vp = geo.vertexPackage;
      verts += vp.verticesCount || 0;
      const prims = geo.indexPackages.map((p) => {
        if (p.primitiveType === 4) tris += p.indexCount / 3;
        return `prim=${p.primitiveType} idx=${p.indexCount}`;
      });
      skelInfo.push(
        `      ${name}: ${vp.verticesCount} vtx [${vp.vertexAttributes.map((a) => a.semantic).join(',')}]` +
          (vp.instanceIndex !== -1 ? ` inst=${vp.instanceCount}x${vp.instanceMode}` : '') +
          (prims.length ? ` | ${prims.join(' / ')}` : '')
      );
    }

    const texInfo = Object.values(tile.textures).map(
      (t) => `${t.code} ${t.width}x${t.height} ct=${t.compressType} pf=${t.pixelFormat} ${t.data.length}B`
    );

    totalVerts += verts;
    totalTris += tris;
    totalTexBytes += Object.values(tile.textures).reduce((s, t) => s + t.data.length, 0);

    console.log(`OK  ${label}  v${tile.version}  读取 ${tile.bytesRead}/${tile.bytesTotal}B`);
    console.log(
      `    LOD 包 ${tile.groupNode.pageLods.length} 个：` +
        tile.groupNode.pageLods
          .map((p) => `[mode=${p.rangeMode} range=${p.rangeValue} child=${p.childTile || '-'} geodes=${p.geodes.length}]`)
          .join(' ')
    );
    if (skelInfo.length) console.log(skelInfo.join('\n'));
    if (texInfo.length) console.log(`      纹理: ${texInfo.join(' | ')}`);
    console.log(
      `      材质 ${Array.isArray(tile.materials) ? tile.materials.length : Object.keys(tile.materials).length} 条` +
        (tile.pickInfo ? ` | 单体化几何 ${Object.keys(tile.pickInfo).length} 组` : '')
    );
    ok++;
  } catch (e) {
    console.log(`FAIL ${label}`);
    console.log(`     ${e.message}`);
    fail++;
  }
}

console.log(`\n结果：成功 ${ok} / 失败 ${fail}`);
console.log(`合计 顶点 ${totalVerts}，三角面 ${totalTris}，纹理数据 ${(totalTexBytes / 1024).toFixed(1)} KB`);
