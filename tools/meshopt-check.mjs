/**
 * MeshOpt 压缩几何的回归校验
 *
 *   node tools/meshopt-check.mjs --preset shenyin          # 内置演示服务，5 个数据集
 *   node tools/meshopt-check.mjs <tile.s3mb> [more...]     # 本地瓦片
 *   node tools/meshopt-check.mjs https://host/xxx.s3mb     # 远程瓦片
 *   node tools/meshopt-check.mjs --scp https://host/jingmo.scp
 *
 * 校验项（任何一项挂了都说明二进制偏移或解量化读错了）：
 *   1. bytesRead === bytesTotal —— 逐段偏移对齐
 *   2. 每个索引包的 max(index) < vertexCount —— 索引位宽读错会立刻越界
 *   3. 三角形包的 indexCount % 3 === 0
 *   4. 顶点位置 / 法线 / UV 全部有限，法线模长接近 1
 *   5. 单骨架瓦片额外对比 OBB 包围盒（多骨架瓦片的 OBB 是整块的，不做对照）
 */
import { readFileSync } from 'node:fs';
import { parseS3MB } from '../packages/s3m-three/dist/core/S3MBParser.js';

const BASE = 'https://yyxk-cs.sggs.sh.cn/iserver/services/shenyinzhilian/rest/realspace/datas';
const PRESET_SHENYIN = ['zhoubian', 'jingmo', 'cheng', 'fang', 'tiao'].map((n) => `${BASE}/${n}/data/path/${n}.scp`);

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const opts = { scps: [], tiles: [], limit: 3, depth: 1, quiet: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--preset' && argv[i + 1] === 'shenyin') {
    opts.scps.push(...PRESET_SHENYIN);
    i++;
  } else if (a === '--scp') {
    opts.scps.push(argv[++i]);
  } else if (a === '--limit') {
    opts.limit = Number(argv[++i]);
  } else if (a === '--depth') {
    opts.depth = Number(argv[++i]);
  } else if (a === '-q' || a === '--quiet') {
    opts.quiet = true;
  } else if (a === '-h' || a === '--help') {
    console.log('用法：node tools/meshopt-check.mjs [--preset shenyin] [--scp <url>]... [--limit N] [--depth N] [<url|file>]...');
    process.exit(0);
  } else {
    opts.tiles.push(a);
  }
}

if (!opts.scps.length && !opts.tiles.length) opts.scps.push(...PRESET_SHENYIN);

/* ------------------------------------------------------------------ 工具 */

async function load(target) {
  if (/^https?:\/\//.test(target)) {
    const r = await fetch(target);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${target}`);
    return r.arrayBuffer();
  }
  const buf = readFileSync(target);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function attrArray(vp, semantic) {
  const a = vp.vertexAttributes.find((x) => x.semantic === semantic);
  if (!a) return null;
  const Ctor = { f32: Float32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array }[a.dtype];
  if (!Ctor) return null;
  return new Ctor(a.data.buffer, a.data.byteOffset, a.data.byteLength / Ctor.BYTES_PER_ELEMENT);
}

function finite(arr) {
  if (!arr) return true;
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

function bounds3(pos) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** OBB 的三个全尺寸。extent 是带符号轴向量，投影到世界轴上的全宽 = 2·Σ|axis[k]| */
function obbSize(obb) {
  const axes = [obb.xExtent, obb.yExtent, obb.zExtent].map((v) => [v.x, v.y, v.z]);
  return [0, 1, 2].map((k) => 2 * (Math.abs(axes[0][k]) + Math.abs(axes[1][k]) + Math.abs(axes[2][k])));
}

/* ------------------------------------------------------------------ 单瓦片 */

const results = { tiles: 0, ok: 0, fail: 0, meshopt: 0, verts: 0, tris: 0, lines: 0, worstMs: 0, messages: [] };

async function checkTile(url, label = url) {
  const t0 = performance.now();
  results.tiles++;
  try {
    const tile = await parseS3MB(await load(url));
    const ms = performance.now() - t0;
    if (ms > results.worstMs) results.worstMs = ms;

    if (tile.bytesRead !== tile.bytesTotal) {
      throw new Error(`偏移错位：读取 ${tile.bytesRead}/${tile.bytesTotal}B`);
    }

    const notes = [];
    const entries = Object.entries(tile.geoPackage);
    let verts = 0;
    let tris = 0;
    let lines = 0;
    let meshoptSkeletons = 0;

    for (const [name, g] of entries) {
      const vp = g.vertexPackage;
      verts += vp.verticesCount || 0;
      if (vp.compressOptions !== undefined) meshoptSkeletons++;

      const pos = attrArray(vp, 'position');
      if (!pos) throw new Error(`${name}: 没有 position 属性`);
      if (!finite(pos)) throw new Error(`${name}: position 含 NaN/Inf`);

      const nrm = attrArray(vp, 'normal');
      if (nrm && !finite(nrm)) throw new Error(`${name}: normal 含 NaN/Inf`);
      if (nrm && nrm.length >= 3) {
        const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
        if (Math.abs(len - 1) > 0.02) throw new Error(`${name}: normal 未归一化 (|n|=${len.toFixed(3)})`);
      }

      const uv = attrArray(vp, 'uv');
      if (uv && !finite(uv)) throw new Error(`${name}: uv 含 NaN/Inf`);

      for (const p of g.indexPackages) {
        if (p.primitiveType === 4) {
          tris += p.indexCount / 3;
          if (p.indexCount % 3 !== 0) throw new Error(`${name}: 三角形索引数 ${p.indexCount} 不是 3 的倍数`);
        }
        // primitiveType 13 是数据自带的棱线包（线段对），不能当三角面画
        if (p.primitiveType === 13) lines += p.indexCount / 2;
        if (!p.indices) continue;
        const width = Math.floor(p.indices.byteLength / p.indexCount);
        const idx =
          width === 4
            ? new Uint32Array(p.indices.buffer, p.indices.byteOffset, p.indexCount)
            : new Uint16Array(p.indices.buffer, p.indices.byteOffset, p.indexCount);
        let max = 0;
        for (let i = 0; i < idx.length; i++) if (idx[i] > max) max = idx[i];
        if (max >= vp.verticesCount) {
          throw new Error(`${name}: 索引越界 max=${max} ≥ 顶点数 ${vp.verticesCount}（位宽 ${width}B）`);
        }
      }

      // OBB 描述的是**全精度**包围盒。根瓦片是简化代理，本来就比 OBB 小一圈，
      // 只对叶子瓦片（无 childTile）做尺寸对照；且 OBB 与顶点不在同一坐标系
      //（差一个 Geode 平移），所以只比平移不变的「尺寸」。
      const lod0 = tile.groupNode.pageLods[0];
      if (entries.length === 1 && tile.groupNode.pageLods.length === 1 && !lod0.childTile && lod0.obb) {
        const b = bounds3(pos);
        const got = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
        const ref = obbSize(lod0.obb);
        const err = Math.max(...[0, 1, 2].map((k) => Math.abs(got[k] - ref[k])));
        const tol = Math.max(0.05, Math.max(...ref) * 0.02);
        notes.push(
          `尺寸 ${got.map((v) => v.toFixed(2)).join('×')} vs OBB ${ref.map((v) => v.toFixed(2)).join('×')} ` +
            `偏差 ${err.toFixed(4)}m ${err <= tol ? '✓' : '✗'}`
        );
        if (err > tol) throw new Error(`${name}: 解量化尺寸与 OBB 不符`);
      }
    }

    results.verts += verts;
    results.tris += tris;
    results.lines += lines;
    results.meshopt += meshoptSkeletons;
    results.ok++;

    if (!opts.quiet) {
      console.log(`OK   ${label}`);
      console.log(
        `     v${tile.version} ${tile.bytesRead}/${tile.bytesTotal}B ${ms.toFixed(0)}ms ` +
          `verts=${verts} tris=${tris} 棱线段=${lines} skels=${entries.length}` +
          (meshoptSkeletons ? ` meshopt=${meshoptSkeletons}` : '')
      );
      for (const n of notes) console.log(`     ${n}`);
    }
    return tile;
  } catch (e) {
    results.fail++;
    results.messages.push(`${label} → ${e.message}`);
    if (!opts.quiet) {
      console.log(`FAIL ${label}`);
      console.log(`     ${e.message}`);
    }
    return null;
  }
}

/* ------------------------------------------------------------------ 走 .scp */

async function walkScp(scpUrl, depth = 1) {
  const cfg = await (await fetch(scpUrl)).json();
  const all = cfg.rootTiles ?? cfg.tiles ?? [];
  const roots = all.slice(0, opts.limit);
  console.log(`\n=== ${scpUrl.split('/datas/')[1] ?? scpUrl}  根瓦片 ${all.length} 个，取前 ${roots.length} ===`);

  for (const rt of roots) {
    const url = new URL(rt.url, scpUrl).href;
    const tile = await checkTile(url, rt.url);
    if (!tile || depth <= 0) continue;
    const child = tile.groupNode.pageLods.find((p) => p.childTile)?.childTile;
    if (child) await checkTile(new URL(child, url).href, `  ↳ ${child}`);
  }
}

/* ------------------------------------------------------------------ main */

const started = performance.now();

for (const scp of opts.scps) {
  try {
    await walkScp(scp, opts.depth);
  } catch (e) {
    results.fail++;
    console.log(`FAIL ${scp} → ${e.message}`);
  }
}

for (const t of opts.tiles) await checkTile(t);

const totalMs = performance.now() - started;
console.log(
  `\n结果：瓦片 ${results.tiles}  成功 ${results.ok}  失败 ${results.fail}  ` +
    `MeshOpt 骨架 ${results.meshopt}  顶点 ${results.verts}  三角面 ${results.tris}  棱线段 ${results.lines}  ` +
    `单瓦片最慢 ${results.worstMs.toFixed(0)}ms  总耗时 ${totalMs.toFixed(0)}ms`
);
if (results.fail) {
  for (const m of results.messages) console.log(`  ${m}`);
  process.exitCode = 1;
}
