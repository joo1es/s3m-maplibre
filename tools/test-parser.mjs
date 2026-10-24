/**
 * 解析层单测：用官方样例逐项断言，而不是「跑通不崩」。
 *
 * 覆盖：字节消费完整性、顶点属性布局与跨距、索引类型与越界、
 * 三角形索引数、法线归一化、DXT 纹理块对齐、单体化 batchId 合法性、截断输入报错。
 *
 * 样例仓库是可选依赖：没有就跳过（CI 里默认跳过），可用 S3M_SAMPLE_DIR 指定。
 */
import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { parseS3MB } from '../packages/s3m-three/dist/core/S3MBParser.js';

const DEFAULT_ROOT = fileURLToPath(new URL('../../s3m-spec/S3M_SDK/S3M_JS/data/', import.meta.url));
const ROOT = process.env.S3M_SAMPLE_DIR ?? DEFAULT_ROOT;

if (!existsSync(ROOT)) {
  console.log(`跳过解析单测：没有找到 ${ROOT}
（克隆 SuperMap/s3m-spec 到同级目录，或用 S3M_SAMPLE_DIR 指定）`);
  process.exit(0);
}

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const inflate = (b) => inflateSync(b);
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.s3mb')) out.push(p);
  }
  return out;
};

/** DXT 系列：像素格式 → 每 4×4 块的字节数 */
const DXT_BLOCK = { 17: 8, 19: 16, 20: 16, 21: 16 };

const files = walk(ROOT).sort();
console.log(`=== 解析单测：${files.length} 个官方样例 ===`);

let tiles = 0;
let geodes = 0;
let verts = 0;
let tris = 0;
let textureCount = 0;
const failures = [];

for (const file of files) {
  const label = file.slice(ROOT.length).replace(/\\/g, '/');
  const buf = readFileSync(file);
  let tile;
  try {
    tile = await parseS3MB(toArrayBuffer(buf), { inflate });
  } catch (e) {
    failures.push(`${label}: 解析抛错 ${e.message}`);
    continue;
  }
  const check = (cond, msg) => {
    if (!cond) failures.push(`${label}: ${msg}`);
  };

  // 1. 字节消费完整性：多读少读都说明某段偏移算错了
  check(tile.bytesRead === tile.bytesTotal, `bytesRead ${tile.bytesRead} != bytesTotal ${tile.bytesTotal}`);
  check(tile.bytesRead > 0, 'bytesRead 为 0');
  check(tile.version > 0, `version = ${tile.version}`);

  // 2. 几何
  const geoNames = Object.keys(tile.geoPackage);
  check(geoNames.length > 0, '没有任何几何包');
  for (const [name, geo] of Object.entries(tile.geoPackage)) {
    const vp = geo.vertexPackage;
    const n = vp.verticesCount;
    check(n > 0, `${name} 顶点数为 0`);

    const pos = vp.vertexAttributes.find((a) => a.semantic === 'position');
    check(!!pos, `${name} 没有 position 属性`);
    if (pos && n > 0) {
      const comps = pos.components ?? 3;
      // 跨距可能是 16（vec4 补齐），必须按跨距读，不能假设紧凑排列
      const stride = pos.stride ?? comps * 4;
      check(comps >= 3, `${name} position 分量数 ${comps} < 3`);
      check(stride >= comps * 4, `${name} position 跨距 ${stride} < ${comps * 4}`);
      check(pos.data.byteLength === n * stride, `${name} position 字节数 ${pos.data.byteLength} != ${n}×${stride}`);

      const f32 = new Float32Array(pos.data.buffer, pos.data.byteOffset, (n * stride) >> 2);
      const perVertex = stride >> 2;
      let bad = 0;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) if (!Number.isFinite(f32[i * perVertex + c])) bad++;
      }
      check(bad === 0, `${name} position 里有 ${bad} 个非有限值`);
    }

    // 法线要归一化：MeshOpt 反量化算错的话这里立刻会炸
    const nrm = vp.vertexAttributes.find((a) => a.semantic === 'normal');
    if (nrm && n > 0) {
      const stride = nrm.stride ?? (nrm.components ?? 3) * 4;
      const f32 = new Float32Array(nrm.data.buffer, nrm.data.byteOffset, (n * stride) >> 2);
      const perVertex = stride >> 2;
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const len = Math.hypot(f32[i * perVertex], f32[i * perVertex + 1], f32[i * perVertex + 2]);
        worst = Math.max(worst, Math.abs(len - 1));
      }
      check(worst < 1e-3, `${name} 法线未归一化，最大偏差 ${worst}`);
    }

    for (const ip of geo.indexPackages) {
      const itemBytes = ip.indexType === 0 ? 2 : 4;
      check(
        ip.indices.byteLength === ip.indexCount * itemBytes,
        `${name} 索引字节数 ${ip.indices.byteLength} != ${ip.indexCount}×${itemBytes}`
      );
      if (ip.primitiveType === 4) {
        check(ip.indexCount % 3 === 0, `${name} 三角形索引数 ${ip.indexCount} 不是 3 的倍数`);
        tris += ip.indexCount / 3;
      }
      const idx =
        ip.indexType === 0
          ? new Uint16Array(ip.indices.buffer, ip.indices.byteOffset, ip.indexCount)
          : new Uint32Array(ip.indices.buffer, ip.indices.byteOffset, ip.indexCount);
      let maxIdx = 0;
      for (const v of idx) if (v > maxIdx) maxIdx = v;
      check(maxIdx < n, `${name} 索引越界：${maxIdx} >= ${n}`);
    }

    geodes++;
    verts += n;
  }

  // 3. 纹理：块压缩格式的字节数必须整块对齐，且至少容纳第 0 层
  for (const [code, tex] of Object.entries(tile.textures)) {
    const blockSize = DXT_BLOCK[tex.pixelFormat];
    check(tex.width > 0 && tex.height > 0, `纹理 ${code} 尺寸非法 ${tex.width}×${tex.height}`);
    if (blockSize) {
      const level0 = Math.max(1, Math.ceil(tex.width / 4)) * Math.max(1, Math.ceil(tex.height / 4)) * blockSize;
      check(tex.data.length >= level0, `纹理 ${code} 字节数 ${tex.data.length} 小于第 0 层的 ${level0}`);
      check(tex.data.length % blockSize === 0, `纹理 ${code} 字节数 ${tex.data.length} 不是 ${blockSize} 的整数倍`);
    }
    textureCount++;
  }

  // 4. 单体化：batchId 非负整数，且顶点区间必须落在所属几何的顶点范围内
  //    pickInfo 的形状是 { geode: { [smid]: { batchId, segments: [{ vertexOffset, vertexCount }] } } }
  if (tile.pickInfo && typeof tile.pickInfo === 'object') {
    for (const [geode, bySmid] of Object.entries(tile.pickInfo)) {
      if (!bySmid || typeof bySmid !== 'object') continue;
      const n = tile.geoPackage[geode]?.vertexPackage?.verticesCount ?? 0;
      for (const [smid, entry] of Object.entries(bySmid)) {
        // 单体化有两种表达：按 batch 切（精模）或用实例 id（白模实例化）
        if (entry?.batchId != null) {
          check(
            Number.isInteger(entry.batchId) && entry.batchId >= 0,
            `单体 ${geode}/${smid} 的 batchId 非法：${entry.batchId}`
          );
          for (const seg of entry.segments ?? []) {
            check(seg.vertexCount > 0, `单体 ${geode}/${smid} 的顶点区间为空`);
            check(
              seg.vertexOffset >= 0 && seg.vertexOffset + seg.vertexCount <= n,
              `单体 ${geode}/${smid} 的顶点区间越界：${seg.vertexOffset}+${seg.vertexCount} > ${n}`
            );
          }
        } else if (entry?.instanceIds) {
          check(
            Array.isArray(entry.instanceIds) && entry.instanceIds.length > 0,
            `单体 ${geode}/${smid} 的 instanceIds 为空`
          );
          for (const id of entry.instanceIds) {
            check(Number.isInteger(id) && id >= 0, `单体 ${geode}/${smid} 的实例 id 非法：${id}`);
          }
        } else {
          check(false, `单体 ${geode}/${smid} 既没有 batchId 也没有 instanceIds`);
        }
      }
    }
  }

  tiles++;
}

// 5. 截断输入必须报错，而不是静默返回半截数据
if (files[0]) {
  const buf = readFileSync(files[0]);
  const half = toArrayBuffer(buf).slice(0, Math.floor(buf.byteLength / 2));
  await assert.rejects(
    () => parseS3MB(half, { inflate }),
    (e) => !!e,
    '截断的瓦片应当抛错'
  );
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项断言失败：`);
  for (const f of failures.slice(0, 20)) console.error('  -', f);
  process.exit(1);
}

console.log(
  `  √ ${tiles} 个瓦片 / ${geodes} 个几何包 / ${verts} 顶点 / ${tris} 三角形 / ${textureCount} 张纹理：` +
    '字节消费、属性布局与跨距、索引边界、法线归一化、纹理块对齐全部通过'
);
console.log('  √ 截断输入会抛错，不会静默返回半截数据');
