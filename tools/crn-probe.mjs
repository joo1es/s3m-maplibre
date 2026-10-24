/**
 * 找带 CRN 纹理的 S3M 数据，并把 CRN 解码链路在真实瓦片上跑一遍
 *
 *   node tools/crn-probe.mjs --services                     # 扫 SuperMap Online 全部公有三维服务
 *   node tools/crn-probe.mjs --service <realspace 根地址>    # 扫单个服务的数据集
 *   node tools/crn-probe.mjs --tiles <s3m 根地址|.scp>       # 下瓦片，统计 pixelFormat 直方图
 *   node tools/crn-probe.mjs --crn <s3m 根地址|.scp|.s3mb>   # 对 CRN 纹理做转码 + 解码校验
 *
 * `--services` / `--service` 只读数据集的 config（里面的 `s3m:TextureCompressionType`
 * 直接写明 DXT / WEBP / CRN / NONE），不用下瓦片，适合先摸底再挑目标。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import DXTTextureDecode from '../packages/s3m-three/dist/core/DXTTextureDecode.js';
import { transcodeCRN } from '../packages/s3m-three/dist/core/CRNDecode.js';
import { parseS3MB } from '../packages/s3m-three/dist/core/S3MBParser.js';
import { resolveTextureKind } from '../packages/s3m-three/dist/core/TextureFormat.js';

/* ------------------------------------------------------------------ 参数 */

const opts = { services: null, service: [], tiles: [], crn: [], limit: 3, depth: 1, concurrency: 8, timeout: 20000 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--services') opts.services = argv[i + 1]?.startsWith('http') ? argv[++i] : 'https://www.supermapol.com/realspace/services.json';
  else if (a === '--service') opts.service.push(argv[++i]);
  else if (a === '--tiles') opts.tiles.push(argv[++i]);
  else if (a === '--crn') opts.crn.push(argv[++i]);
  else if (a === '--limit') opts.limit = Number(argv[++i]);
  else if (a === '--depth') opts.depth = Number(argv[++i]);
  else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
  else if (a === '-h' || a === '--help') {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    process.exit(0);
  } else console.error(`未知参数 ${a}`);
}

/* ------------------------------------------------------------------ 工具 */

async function get(url, as = 'text') {
  const r = await fetch(url, { signal: AbortSignal.timeout(opts.timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return as === 'json' ? r.json() : as === 'buf' ? r.arrayBuffer() : r.text();
}

/** 简易并发池：任务失败不影响其它任务 */
async function pool(items, worker, concurrency = opts.concurrency) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await worker(items[i], i);
        } catch (e) {
          out[i] = { error: e.message };
        }
      }
    })
  );
  return out;
}

/** config 可能是 JSON 也可能是 XML，统一用正则抓字段 */
function pick(text, key) {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`)) ?? text.match(new RegExp(`<[^>]*${key}>([^<]*)<`));
  return m ? m[1] : '';
}

async function datasetConfig(path) {
  // path 来自 datas.json，已经是绝对地址；config 可能在 dataset 根下
  const text = await get(`${path}/config`);
  return {
    texture: pick(text, 's3m:TextureCompressionType'),
    dataType: pick(text, 'dataType') || 'unknown',
    renderMode: pick(text, 'renderMode'),
  };
}

async function listDatasets(root) {
  const list = await get(`${root.replace(/\/$/, '')}/datas.json`, 'json');
  return list.map((d) => ({ name: d.name, path: d.path.replace(/^https?:\/\/[^/]+/, '') ? d.path : d.path }));
}

/* ---------------------------------------------------- 服务 × 数据集：纹理压缩类型 */

async function scanService(root, label = root) {
  const datasets = await listDatasets(root);
  const rows = await pool(datasets.slice(0, 40), async (d) => {
    const cfg = await datasetConfig(d.path.startsWith('http') ? d.path : new URL(d.path, root).href);
    return { name: d.name, ...cfg };
  });
  return { root, label, rows };
}

function printScan(res) {
  console.log(`\n=== ${res.label}`);
  const counts = new Map();
  for (const r of res.rows) {
    if (r.error) { console.log(`  ! ${r.name}  ${r.error}`); continue; }
    counts.set(r.texture || '(空)', (counts.get(r.texture || '(空)') ?? 0) + 1);
    console.log(`  ${(r.texture || '-').padEnd(6)} ${(r.dataType || '-').padEnd(10)} ${r.name}`);
  }
  return counts;
}

/* ---------------------------------------------------- 瓦片：pixelFormat 直方图 */

/** 以 .s3mb 结尾才算单瓦片，其余当作 config / .scp 去展开 */
const IS_TILE = (t) => /\.s3mb(\?|$)/i.test(t);

async function loadTile(target) {
  if (/^https?:\/\//.test(target)) return parseS3MB(await get(target, 'buf'));
  const buf = readFileSync(target);
  return parseS3MB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** .scp / config 里的根瓦片 + 第一层子瓦片 */
async function* walkTiles(configUrl, limit, depth) {
  const text = await get(configUrl);
  let roots;
  if (text.trim().startsWith('{')) {
    const cfg = JSON.parse(text);
    roots = (cfg.rootTiles ?? cfg.tiles ?? []).map((t) => t.url);
  } else {
    roots = [...text.matchAll(/<[^>]*TileUrl>([^<]+)</g)].map((m) => m[1]);
    if (!roots.length) roots = [...text.matchAll(/<[^>]*Url>([^<]+)</g)].map((m) => m[1]);
  }
  for (const r of roots.slice(0, limit)) {
    const url = new URL(r, configUrl).href;
    yield url;
    if (depth <= 0) continue;
    try {
      const tile = await loadTile(url);
      const child = tile.groupNode.pageLods.find((p) => p.childTile)?.childTile;
      if (child) yield new URL(child, url).href;
    } catch { /* 子瓦片取不到就跳过 */ }
  }
}

async function tileStats(url) {
  const tile = await loadTile(url);
  const hist = new Map();
  for (const t of Object.values(tile.textures ?? {})) {
    const kind = resolveTextureKind(t.compressType ?? 0, t.pixelFormat);
    hist.set(kind, (hist.get(kind) ?? 0) + 1);
  }
  return { tile, hist, url };
}

/* ---------------------------------------------------- CRN 解码校验 */

/** DXT 块 → RGBA8，只为做数值校验 */
function dxtToRGBA(dxt, width, height, dxtFormat) {
  const out = new Uint8Array(width * height * 4);
  DXTTextureDecode.decode(out, width, height, dxt, dxtFormat === 1 ? 17 : dxtFormat === 3 ? 19 : 21);
  return out;
}

/** 平均邻域差：真实贴图相邻像素接近，熵解码错位会明显更「毛」 */
function roughness(rgba, w, h) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const i = (y * w + x) * 4;
      sum += Math.abs(rgba[i] - rgba[i + 4]) + Math.abs(rgba[i + 1] - rgba[i + 5]) + Math.abs(rgba[i + 2] - rgba[i + 6]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}

function lumThumb(rgba, w, h, cols = 32) {
  const rows = Math.max(4, Math.round((cols * h) / w / 2));
  const lines = [];
  const chars = ' .:-=+*#%@';
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx * w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * w) / cols));
      const y0 = Math.floor((ry * h) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * h) / rows));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          n++;
        }
      }
      line += chars[Math.min(9, Math.floor((sum / n / 256) * 10))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const crnReport = { tiles: 0, textures: 0, ok: 0, fail: 0, bytes: 0, examples: [] };

async function checkCRN(url) {
  const { tile } = await tileStats(url);
  crnReport.tiles++;
  const list = Object.values(tile.textures ?? {}).filter(
    (t) => resolveTextureKind(t.compressType ?? 0, t.pixelFormat) === 'crn'
  );
  for (const tex of list) {
    crnReport.textures++;
    const tag = `${url.split('/').slice(-2).join('/')} ${tex.code}`;
    try {
      crnReport.bytes += tex.data.byteLength;
      const out = await transcodeCRN(tex.data);
      const dimsOk = out.width === tex.width && out.height === tex.height;
      const rgba = dxtToRGBA(out.data, out.width, out.height, out.dxtFormat);
      const uniq = new Set();
      for (let i = 0; i < rgba.length; i += 4) uniq.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
      const rough = roughness(rgba, out.width, out.height);
      const note = `${out.width}×${out.height} lv${out.levels} dxt${out.dxtFormat} ` +
        `尺寸${dimsOk ? '吻合' : `不符(声明 ${tex.width}×${tex.height})`} ` +
        `色数 ${uniq.size} 粗糙度 ${rough.toFixed(1)}`;
      if (!dimsOk) throw new Error(`尺寸不符：${note}`);
      crnReport.ok++;
      console.log(`  OK ${tag}  ${note}`);
      if (crnReport.examples.length < 3) {
        crnReport.examples.push({ tag, note, thumb: lumThumb(rgba, out.width, out.height) });
      }
    } catch (e) {
      crnReport.fail++;
      console.log(`  FAIL ${tag}  ${e.message}`);
    }
  }
  return list.length;
}

/* ------------------------------------------------------------------ main */

if (opts.services) {
  const list = await get(opts.services, 'json');
  const base = new URL(opts.services).origin;
  const services = list
    .filter((s) => /Realspace/i.test(s.componentType || ''))
    .map((s) => {
      const name = s.name.replace(/\/rest$/, '');
      const root = opts.services.includes('/realspace/services.json')
        ? `${base}/realspace/services/${name}/rest/realspace`
        : `${base}/iserver/services/${name}/realspace`;
      return { name, root };
    });
  console.log(`服务 ${services.length} 个，并发 ${opts.concurrency}`);
  const found = [];
  const results = await pool(services, async (s) => {
    const res = await scanService(s.root, s.name);
    const hit = res.rows.filter((r) => /CRN/i.test(r.texture || ''));
    if (hit.length) found.push({ name: s.name, root: s.root, datasets: hit });
    const counts = new Map();
    for (const r of res.rows) if (!r.error) counts.set(r.texture || '(空)', (counts.get(r.texture || '(空)') ?? 0) + 1);
    process.stdout.write(`  ${s.name.padEnd(42)} ${[...counts].map(([k, v]) => `${k}:${v}`).join(' ')}\n`);
    return res;
  }, opts.concurrency);
  const failed = results.filter((r) => r.error);
  console.log(`\n完成：服务 ${services.length} 成功 ${services.length - failed.length} 失败 ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  ! ${f.error}`);
  console.log(`\n带 CRN 的服务 ${found.length} 个：`);
  for (const f of found) console.log(`  ${f.name}\n    ${f.root}\n    ${f.datasets.map((d) => `${d.name}(${d.texture})`).join(', ')}`);
}

for (const root of opts.service) {
  const res = await scanService(root);
  printScan(res);
}

for (const t of opts.tiles) {
  const urls = IS_TILE(t) ? [t] : walkTiles(t, opts.limit, opts.depth);
  console.log(`\n=== ${t}`);
  for await (const url of urls) {
    try {
      const { hist, tile } = await tileStats(url);
      const histText = [...hist].map(([k, v]) => `${k}:${v}`).join(' ') || '(无纹理)';
      console.log(`  ${url.split('/').pop()}  v${tile.version}  ${histText}`);
    } catch (e) {
      console.log(`  FAIL ${url}  ${e.message}`);
    }
  }
}

for (const t of opts.crn) {
  const urls = IS_TILE(t) ? [t] : walkTiles(t, opts.limit, opts.depth);
  console.log(`\n=== CRN 校验 ${t}`);
  let seen = 0;
  for await (const url of urls) {
    try {
      seen += await checkCRN(url);
    } catch (e) {
      console.log(`  FAIL ${url}  ${e.message}`);
    }
  }
  if (!seen) console.log('  （这些瓦片里没有 CRN 纹理）');
}

if (opts.crn.length) {
  console.log(
    `\nCRN 结果：瓦片 ${crnReport.tiles}  纹理 ${crnReport.textures}  成功 ${crnReport.ok}  失败 ${crnReport.fail}  ` +
      `源数据 ${(crnReport.bytes / 1024).toFixed(0)}KB`
  );
  for (const e of crnReport.examples) console.log(`\n${e.tag}  ${e.note}\n${e.thumb}`);
  if (crnReport.fail) process.exitCode = 1;
}

// 供 `node -e "import(...)"` 复用
export { scanService, tileStats, checkCRN, pathToFileURL };
