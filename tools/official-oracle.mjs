/**
 * 用官方 S3ModelParser 解析样例，作为本项目的对照 oracle。
 * 官方解析器依赖 XMLHttpRequest 加载 draco wasm，Node 里给个空实现即可
 * （样例数据不含 Draco 压缩，不会真正用到解码器）。
 */
import { readFileSync } from 'node:fs';

globalThis.XMLHttpRequest = class {
  open() {}
  setRequestHeader() {}
  send() {}
};

const file = process.argv[2];
const { default: S3ModelParser } = await import(
  new URL('../../s3m-spec/S3M_SDK/S3M_JS/S3M_module/S3MParser/S3ModelParser.js', import.meta.url).href
);

const b = readFileSync(file);
const r = S3ModelParser.parseBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

console.log('version', r.version);
console.log(
  'pageLods',
  r.groupNode.pageLods.length,
  JSON.stringify(
    r.groupNode.pageLods.map((p) => ({
      mode: p.rangeMode,
      range: p.rangeList,
      child: p.childTile,
      geodes: p.geodes.length,
    }))
  )
);
for (const [n, g] of Object.entries(r.geoPackage)) {
  const vp = g.vertexPackage;
  console.log(
    ' skeleton',
    n,
    'verts',
    vp.verticesCount,
    'attrs',
    vp.vertexAttributes.map((a) => `${a.index}:${a.componentsPerAttribute}`).join(','),
    'idxPacks',
    g.arrIndexPackage.map((p) => `${p.indicesCount}/${p.primitiveType}/${p.materialCode}`).join(' ')
  );
}
console.log(
  'textures',
  Object.values(r.texturePackage).map(
    (t) => `${t.id} ${t.width}x${t.height} ct=${t.compressType} fmt=${t.nFormat} ${t.arrayBufferView.length}B`
  )
);
console.log('materials', JSON.stringify(r.matrials).slice(0, 600));
