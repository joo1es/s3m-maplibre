/**
 * 实例化单体的回归测试（用仓库里的 comModel 样例，官方导出的实例化白模）
 *
 * 实例化几何和普通单体是两套东西：
 *   - 顶点是 base mesh 的，单体粒度落在**实例**上，逐顶点属性 aBatchId 对它没有意义；
 *   - 控制位走 InstancedBufferAttribute（aInstanceBatchId），拾取编码的是实例序号。
 * 这个测试把「解析 → 建几何 → 状态纹理 → 拾取反查」四条链路都钉住。
 */
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseS3MB } from '../dist/core/S3MBParser.js';
import { buildTileObjects } from '../dist/render/GeometryBuilder.js';
import { buildInstanceLookup, pickEntryId, resolveFeature } from '../dist/core/FeatureInfo.js';
import { S3MLayer } from '../dist/index.js';

const ROOT = 'demo/data/comModel/Tile_-166159_525382_0000';

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  √ ${msg}`);
};

/* ---------------------------------------------- 1. 解析：逐实例控制位 */

const files = readdirSync(ROOT)
  .filter((f) => f.endsWith('.s3mb'))
  .map((f) => join(ROOT, f));
assert.ok(files.length > 0, '找不到 comModel 样例瓦片');

const tiles = [];
for (const f of files) {
  const buf = readFileSync(f);
  tiles.push(await parseS3MB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
}

let instancedGeo = null;
for (const tile of tiles) {
  for (const [name, geo] of Object.entries(tile.geoPackage)) {
    const vp = geo.vertexPackage;
    if (vp.instanceIndex === -1 || !geo.pickInfo) continue;
    if (!instancedGeo || vp.instanceCount > instancedGeo.vp.instanceCount) {
      instancedGeo = { name, geo, vp, tile };
    }
  }
}
assert.ok(instancedGeo, '样例里应当有实例化骨架');

{
  const { geo, vp } = instancedGeo;
  const entries = Object.entries(geo.pickInfo);

  assert.ok(vp.instanceBatchIds instanceof Float32Array, '实例化骨架应当带 instanceBatchIds');
  assert.strictEqual(vp.instanceBatchIds.length, vp.instanceCount, 'instanceBatchIds 长度必须等于实例数');
  assert.ok(!vp.vertexAttributes.some((a) => a.semantic === 'batchId'), '实例化几何不该有逐顶点 batchId');

  const seen = new Set();
  for (const [smid, entry] of entries) {
    assert.ok(Array.isArray(entry.instanceIds) && entry.instanceIds.length > 0, `SMID ${smid} 应落在实例上`);
    assert.strictEqual(entry.batchId, undefined, '实例化单体不该有顶点区间 batchId');
    assert.ok(entry.instanceBatchId >= 0, `SMID ${smid} 应当有控制位`);
    for (const idx of entry.instanceIds) {
      assert.ok(vp.instanceBatchIds[idx] === entry.instanceBatchId, `实例 ${idx} 的控制位要写回数组`);
      assert.ok(!seen.has(idx), `实例 ${idx} 不能同时属于两个单体`);
      seen.add(idx);
    }
  }
  // 未被任何单体覆盖的实例保持 -1（真实数据里确实存在，这类实例点不选中任何单体）
  const uncovered = Array.from(vp.instanceBatchIds).filter((v) => v < 0).length;
  assert.strictEqual(
    vp.instanceBatchIds.filter((v) => v >= 0).length,
    seen.size,
    '写回数组的实例数应等于单体覆盖的实例数'
  );
  ok(
    `解析：${entries.length} 个 SMID 覆盖 ${seen.size}/${vp.instanceCount} 个实例（${uncovered} 个实例无单体），` +
      '逐顶点 batchId 已不再出现'
  );
}

/* ---------------------------------------------- 2. 建几何：instanced attributes */

const built = await buildTileObjects(instancedGeo.tile);
const instancedMeshes = built.objects.filter((o) => o.isInstancedMesh);
assert.ok(instancedMeshes.length > 0, '应当生成 InstancedMesh');

{
  const mesh = instancedMeshes.find((m) => m.userData.geoRef === instancedGeo.geo);
  assert.ok(mesh, '目标几何应当生成 InstancedMesh');
  assert.ok(mesh.geometry.getAttribute('aInstanceBatchId'), '实例化几何必须带 aInstanceBatchId');

  const batchAttr = mesh.geometry.getAttribute('aInstanceBatchId');
  const indexAttr = mesh.geometry.getAttribute('aInstanceIndex');
  assert.ok(batchAttr.isInstancedBufferAttribute, 'aInstanceBatchId 必须是 instanced attribute（逐顶点会错位）');
  assert.ok(indexAttr?.isInstancedBufferAttribute, 'aInstanceIndex 必须是 instanced attribute');
  assert.strictEqual(batchAttr.count, mesh.count, '实例属性长度必须等于实例数');
  assert.strictEqual(indexAttr.count, mesh.count);

  const ids = Array.from(batchAttr.array);
  for (const [i, v] of Array.from(indexAttr.array).entries()) assert.strictEqual(v, i, '实例序号应为 0..n-1');
  // 控制位 = pickInfo 枚举序：一个单体可能覆盖多个实例（会重复），但必须连续编号
  const uniq = [...new Set(ids.filter((v) => v >= 0))].sort((a, b) => a - b);
  assert.strictEqual(uniq[0], 0, '控制位应从 0 开始');
  assert.strictEqual(uniq[uniq.length - 1], uniq.length - 1, '控制位应当是 0..n-1 连续编号');
  const smids = Object.keys(instancedGeo.geo.pickInfo).length;
  assert.strictEqual(uniq.length, smids, '控制位数量应等于单体数量');

  const perVertex = mesh.geometry.getAttribute('aBatchId');
  assert.strictEqual(perVertex.count, mesh.geometry.getAttribute('position').count, 'aBatchId 仍是逐顶点，长度对');

  // 验证实例矩阵结构：必须是纯仿射变换，底部投影行 [3, 7, 11, 15] 必须为 [0, 0, 0, 1]
  const instM4 = new THREE.Matrix4();
  mesh.getMatrixAt(0, instM4);
  const el = instM4.elements;
  assert.strictEqual(el[3], 0, '实例矩阵 elements[3] 应为 0（不能把平移误塞进投影行造成透视尖锥畸变）');
  assert.strictEqual(el[7], 0, '实例矩阵 elements[7] 应为 0');
  assert.strictEqual(el[11], 0, '实例矩阵 elements[11] 应为 0');
  assert.strictEqual(el[15], 1, '实例矩阵 elements[15] 应为 1');
  assert.ok(Math.abs(el[12]) > 10, '实例矩阵 elements[12] 应包含真实的 X 轴平移量');

  ok(`建几何：${instancedMeshes.length} 个 InstancedMesh，实例矩阵纯正仿射无畸变，逐顶点 aBatchId 保留兜底`);
}

/* ---------------------------------------------- 3. 状态纹理：按实例改色 / 抬高 / 隐藏 */

{
  const { geo, vp } = instancedGeo;
  const smid = Number(Object.keys(geo.pickInfo)[2]); // 取第 3 个单体
  const controlId = pickEntryId(geo.pickInfo[smid]);
  const mesh = instancedMeshes.find((m) => m.userData.geoRef === geo) ?? instancedMeshes[0];

  const layer = new S3MLayer({});
  // 按生产路径注册（TileNode 装载时做的就是这三步），只塞 _smidMeshes 的话
  // setFilter 的全量脏标记走 _pickables 会漏掉这个网格
  mesh.userData.pickId = layer._allocPickId();
  layer._pickables.set(mesh.userData.pickId, {
    datasetId: 'test',
    mesh,
    tile: null,
    skeletonName: 'test',
  });
  layer._indexMeshSmids(mesh);

  layer.setFeatureStyle(smid, { color: '#ff0000', elevation: 12 });
  layer.flushOverrides();

  const tex = mesh.material.userData.uBatchTex.value;
  const data = tex.image.data;
  const maxControl = Math.max(...Object.values(geo.pickInfo).map((e) => pickEntryId(e)));
  assert.strictEqual(
    mesh.material.userData.uBatchTexWidth.value,
    maxControl + 1,
    '状态纹理宽度 = 控制位数量（不是实例数）'
  );
  const base = controlId * 4;
  assert.ok(Math.abs(data[base] - 1) < 1e-6 && Math.abs(data[base + 1]) < 1e-6, '按实例写入的颜色应落在控制位上');
  assert.strictEqual(data[base + 3], 12, '抬高量写在 alpha 通道');
  assert.strictEqual(data[(controlId + 1) * 4 + 3], 0, '其他实例不受影响');

  // 过滤隐藏：alpha 写 -1，着色器里 discard
  layer.setFilter({ exclude: [smid] });
  layer.flushOverrides();
  assert.strictEqual(data[base + 3], -1, '被过滤的实例应标记隐藏（alpha = -1）');
  layer.clearFilter();
  layer.flushOverrides();
  assert.notStrictEqual(data[base + 3], -1, '取消过滤后应恢复');

  ok(`状态纹理：SMID ${smid} → 控制位 ${controlId}，改色 / 抬高 / 隐藏都按实例生效`);
}

/* ---------------------------------------------- 4. 拾取反查：实例序号 → SMID */

{
  const { geo } = instancedGeo;
  const lookup = buildInstanceLookup(geo.pickInfo);
  // 一个 SMID 可能覆盖多个实例（comModel 实测 18 个单体 → 36 个实例），
  // 所以反查表大小 = 被覆盖的实例总数，不是单体数
  const covered = Object.values(geo.pickInfo).reduce((n, e) => n + e.instanceIds.length, 0);
  assert.strictEqual(lookup.size, covered, '每个被覆盖的实例都应在反查表里');

  for (const [smid, entry] of Object.entries(geo.pickInfo)) {
    const hit = lookup.get(entry.instanceIds[0]);
    assert.ok(hit, `实例 ${entry.instanceIds[0]} 应能反查到单体`);
    assert.strictEqual(hit.smid, Number(smid), '反查出的 SMID 要对');
    assert.strictEqual(hit.batchId, entry.instanceBatchId, '反查出的控制位要对');
  }
  assert.strictEqual(lookup.get(instancedGeo.vp.instanceCount + 10), undefined, '越界实例应查不到');

  // resolveFeature 两种形态都要认：顶点区间型按 batchId，实例化型按控制位
  const smid0 = Number(Object.keys(geo.pickInfo)[0]);
  const viaInstance = resolveFeature(geo, pickEntryId(geo.pickInfo[smid0]));
  assert.strictEqual(viaInstance.smid, smid0, 'resolveFeature 要能按实例控制位反查 SMID');
  assert.strictEqual(viaInstance.segments.length, 0, '实例化单体没有顶点区间');
  ok(`拾取反查：${lookup.size} 个实例 → SMID 全部对得上，越界安全`);
}

/* ---------------------------------------------- 5. 实例矩阵：包围盒跟随实例 */

{
  const { geo } = instancedGeo;
  const smid = Number(Object.keys(geo.pickInfo)[0]);
  const entry = geo.pickInfo[smid];
  const mesh = instancedMeshes.find((m) => m.userData.geoRef === geo);
  const layer = new S3MLayer({});

  const box = layer._instanceBox(mesh, entry.instanceIds[0]);
  assert.ok(box, '实例应当能算出包围盒');
  assert.ok(box.maxX > box.minX && box.maxZ > box.minZ, '实例包围盒不能退化成点');

  const m = new THREE.Matrix4();
  mesh.getMatrixAt(entry.instanceIds[0], m);
  assert.ok(Math.abs(box.minX - m.elements[12]) < 1e6, '包围盒应当平移到了实例位置');
  ok(`实例包围盒：SMID ${smid} → z 范围 ${box.minZ.toFixed(2)}~${box.maxZ.toFixed(2)}m`);
}

console.log(`\n实例化单体：${n} 组断言全部通过（解析 / 几何 / 状态纹理 / 拾取反查 / 包围盒）`);
