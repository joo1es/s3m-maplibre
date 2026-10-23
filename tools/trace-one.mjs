/** 逐字段追踪单个 s3mb 的骨架解析，用于和官方实现对齐 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const f = process.argv[2] ?? '../s3m-spec/S3M_SDK/S3M_JS/data/comModel/Tile_-166159_525382_0000/Tile_-166159_525382_0000.s3mb';
const b = readFileSync(f);
const cs = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true);
const raw = inflateSync(b.subarray(8, 8 + cs));
const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
let o = 0;

const u8 = () => { const x = dv.getUint8(o); o += 1; return x; };
const u16 = () => { const x = dv.getUint16(o, true); o += 2; return x; };
const u32 = () => { const x = dv.getUint32(o, true); o += 4; return x; };
const f32 = () => { const x = dv.getFloat32(o, true); o += 4; return x; };
const f64 = () => { const x = dv.getFloat64(o, true); o += 8; return x; };
const str = () => { const n = u32(); const s = raw.subarray(o, o + n).toString('utf8'); o += n; return s; };
const align = (rel = 0) => { const m = (o - rel) % 4; if (m) o += 4 - m; };
const log = (...a) => console.log(String(o).padStart(5), ...a);

log('options', u32());
log('group streamSize', u32(), 'count', u32());
log('rangeValue', f32(), 'rangeMode', u16());
log('bs', [f64(), f64(), f64(), f64()]);
log('childTile', str());
const geodeCount = u32();
for (let g = 0; g < geodeCount; g++) {
  for (let i = 0; i < 16; i++) f64();
  const n = u32(); const names = []; for (let i = 0; i < n; i++) names.push(str());
  log(` geode${g}`, names);
}
align();
log('=== skeleton streamSize', u32(), 'count', u32());

const name = str(); align();
log('name', name, 'tag', u32());

const vcount = u32();
const dim = u16(); u16();
log('vertices', vcount, 'dim', dim);
o += vcount * dim * 4;
log('positions done');

const nc = u32();
if (nc > 0) { const d = u16(), s = u16(); o += nc * d * 4; log('normals', nc, 'dim', d, 'stride', s); }
else log('normals none');

const cc = u32();
if (cc > 0) { const s = u16(); o += 2; o += cc * 4; log('colors', cc, 'stride', s); }
else log('colors none');

const sc = u32();
if (sc > 0) { const s = u16(); o += 2; o += sc * 4; log('secondColors', sc, 'stride', s); }
else log('secondColors none');

const tc = u16(); o += 2;
log('texCoordCount', tc);
for (let i = 0; i < tc; i++) {
  const n = u32(); const d = u16(); const s = u16();
  o += n * d * 4;
  log(`  uv${i}`, n, 'dim', d, 'stride', s);
}

const ic = u16(); o += 2;
log('instanceInfoCount', ic);

log('indexPackageCount', u32());
const pcount = u32();
log('  indexPackages', pcount);
for (let i = 0; i < pcount; i++) {
  const idxCount = u32();
  const idxType = u8();
  const useIdx = u8();
  const prim = u8();
  o += 1;
  log(`  idx${i}`, 'count', idxCount, 'type', idxType, 'use', useIdx, 'prim', prim);
  if (idxCount > 0) {
    const wide = idxType === 1 || idxType === 3;
    o += idxCount * (wide ? 4 : 2);
    if (!wide && idxCount % 2 !== 0) o += 2;
  }
  const passCount = u32();
  const passes = []; for (let j = 0; j < passCount; j++) passes.push(str());
  log(`  idx${i} passes`, passes);
  align();
}

log('=== skeleton end');
const extra = u32();
log('extra size', extra);
o += extra + 4;
log('after extra');
log('texture streamSize', u32(), 'count', u32());
