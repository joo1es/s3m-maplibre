/**
 * 实例化单体的回归测试（用仓库里的 comModel 样例，官方导出的实例化白模）
 *
 * 实例化几何和普通单体是两套东西：
 *   - 顶点是 base mesh 的，单体粒度落在**实例**上，逐顶点属性 aBatchId 对它没有意义；
 *   - 控制位走 InstancedBufferAttribute（aInstanceBatchId），拾取编码的是实例序号。
 * 这个测试把「解析 → 建几何 → 状态纹理 → 拾取反查 → 包围盒」五条链路都钉住。
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';
import { buildInstanceLookup, pickEntryId, resolveFeature } from '../../packages/s3m-three/src/core/FeatureInfo';
import { S3MLayer } from '../../packages/s3m-maplibre/src/index';

const ROOT = fileURLToPath(new URL('../../demo/data/comModel/Tile_-166159_525382_0000/', import.meta.url));

describe('实例化单体（comModel 样例）', () => {
  let instancedGeo: { name: string; geo: any; vp: any; tile: any };
  let built: Awaited<ReturnType<typeof buildTileObjects>>;
  let instancedMeshes: any[];

  beforeAll(async () => {
    const files = readdirSync(ROOT)
      .filter((f) => f.endsWith('.s3mb'))
      .map((f) => join(ROOT, f));
    expect(files.length).toBeGreaterThan(0);

    const tiles = [];
    for (const f of files) {
      const buf = readFileSync(f);
      tiles.push(await parseS3MB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
    }

    // 取实例数最多的那个骨架作为样本
    let picked: typeof instancedGeo | null = null;
    for (const tile of tiles) {
      for (const [name, geo] of Object.entries(tile.geoPackage) as [string, any][]) {
        const vp = geo.vertexPackage;
        if (vp.instanceIndex === -1 || !geo.pickInfo) continue;
        if (!picked || vp.instanceCount > picked.vp.instanceCount) picked = { name, geo, vp, tile };
      }
    }
    expect(picked).toBeTruthy();
    instancedGeo = picked!;

    built = await buildTileObjects(instancedGeo.tile);
    instancedMeshes = built.objects.filter((o: any) => o.isInstancedMesh);
    expect(instancedMeshes.length).toBeGreaterThan(0);
  });

  test('解析：逐实例控制位写回 instanceBatchIds，没有逐顶点 batchId', () => {
    const { geo, vp } = instancedGeo;
    const entries = Object.entries(geo.pickInfo) as [string, any][];

    expect(vp.instanceBatchIds instanceof Float32Array).toBe(true);
    expect(vp.instanceBatchIds.length).toBe(vp.instanceCount);
    // 实例化几何不该有逐顶点 batchId
    expect(vp.vertexAttributes.some((a: any) => a.semantic === 'batchId')).toBe(false);

    const seen = new Set<number>();
    for (const [smid, entry] of entries) {
      expect(Array.isArray(entry.instanceIds) && entry.instanceIds.length > 0).toBe(true);
      expect(entry.batchId).toBeUndefined(); // 实例化单体不该有顶点区间 batchId
      expect(entry.instanceBatchId).toBeGreaterThanOrEqual(0);

      for (const idx of entry.instanceIds) {
        expect(vp.instanceBatchIds[idx]).toBe(entry.instanceBatchId); // 控制位要写回数组
        expect(seen.has(idx)).toBe(false); // 实例不能同时属于两个单体
        seen.add(idx);
      }
    }

    // 未被任何单体覆盖的实例保持 -1（真实数据里确实存在，这类实例点不选中任何单体）
    expect(vp.instanceBatchIds.filter((v: number) => v >= 0).length).toBe(seen.size);
  });

  test('建几何：instanced attributes 与纯正仿射的实例矩阵', () => {
    const { geo } = instancedGeo;
    const mesh = instancedMeshes.find((m) => m.userData.geoRef === geo);
    expect(mesh).toBeTruthy();
    expect(mesh.geometry.getAttribute('aInstanceBatchId')).toBeTruthy();

    const batchAttr = mesh.geometry.getAttribute('aInstanceBatchId');
    const indexAttr = mesh.geometry.getAttribute('aInstanceIndex');
    // 逐顶点的 aBatchId 会让属性错位
    expect(batchAttr.isInstancedBufferAttribute).toBe(true);
    expect(indexAttr?.isInstancedBufferAttribute).toBe(true);
    expect(batchAttr.count).toBe(mesh.count);
    expect(indexAttr.count).toBe(mesh.count);

    for (const [i, v] of Array.from(indexAttr.array as Float32Array).entries()) expect(v).toBe(i); // 0..n-1

    // 控制位 = pickInfo 枚举序：一个单体可能覆盖多个实例（会重复），但必须连续编号
    const ids = Array.from(batchAttr.array as Float32Array);
    const uniq = [...new Set(ids.filter((v) => v >= 0))].sort((a, b) => a - b);
    expect(uniq[0]).toBe(0);
    expect(uniq[uniq.length - 1]).toBe(uniq.length - 1);
    expect(uniq.length).toBe(Object.keys(geo.pickInfo).length);

    // aBatchId 仍是逐顶点属性，长度对
    expect(mesh.geometry.getAttribute('aBatchId').count).toBe(mesh.geometry.getAttribute('position').count);

    // 实例矩阵必须是纯仿射：底部投影行 [3, 7, 11, 15] = [0, 0, 0, 1]，
    // 否则平移被误塞进投影行会造成透视尖锥畸变
    const instM4 = new THREE.Matrix4();
    mesh.getMatrixAt(0, instM4);
    const el = instM4.elements;
    expect(el[3]).toBe(0);
    expect(el[7]).toBe(0);
    expect(el[11]).toBe(0);
    expect(el[15]).toBe(1);
    expect(Math.abs(el[12])).toBeGreaterThan(10); // 真实的 X 轴平移量
  });

  test('状态纹理：按实例改色 / 抬高 / 隐藏', () => {
    const { geo } = instancedGeo;
    const smid = Number(Object.keys(geo.pickInfo)[2]); // 取第 3 个单体
    const controlId = pickEntryId(geo.pickInfo[smid]);
    const mesh = instancedMeshes.find((m) => m.userData.geoRef === geo) ?? instancedMeshes[0];

    const layer = new S3MLayer({});
    // 按生产路径注册（TileNode 装载时做的就是这三步），只塞 _smidMeshes 的话
    // setFilter 的全量脏标记走 _pickables 会漏掉这个网格
    mesh.userData.pickId = (layer.viewer as any)._allocPickId();
    (layer.viewer as any)._pickables.set(mesh.userData.pickId, {
      datasetId: 'test',
      mesh,
      tile: null,
      skeletonName: 'test',
    } as never);
    (layer.viewer as any)._indexMeshSmids(mesh);

    layer.setFeatureStyle(smid, { color: '#ff0000', elevation: 12 });
    layer.flushOverrides();

    const data = mesh.material.userData.uBatchTex.value.image.data;
    const maxControl = Math.max(...Object.values(geo.pickInfo).map((e: any) => pickEntryId(e)));
    // 状态纹理宽度 = 控制位数量（不是实例数）
    expect(mesh.material.userData.uBatchTexWidth.value).toBe(maxControl + 1);

    const base = controlId * 4;
    expect(Math.abs(data[base] - 1)).toBeLessThan(1e-6);
    expect(Math.abs(data[base + 1])).toBeLessThan(1e-6);
    expect(data[base + 3]).toBe(12); // 抬高量写在 alpha 通道
    expect(data[(controlId + 1) * 4 + 3]).toBe(0); // 其他实例不受影响

    // 过滤隐藏：alpha 写 -1，着色器里 discard
    layer.setFilter({ exclude: [smid] });
    layer.flushOverrides();
    expect(data[base + 3]).toBe(-1);

    layer.clearFilter();
    layer.flushOverrides();
    expect(data[base + 3]).not.toBe(-1);
  });

  test('拾取反查：实例序号 → SMID，越界安全', () => {
    const { geo, vp } = instancedGeo;
    const lookup = buildInstanceLookup(geo.pickInfo);
    // 一个 SMID 可能覆盖多个实例（comModel 实测 18 个单体 → 36 个实例），
    // 所以反查表大小 = 被覆盖的实例总数，不是单体数
    const covered = Object.values(geo.pickInfo).reduce((n: number, e: any) => n + e.instanceIds.length, 0);
    expect(lookup.size).toBe(covered);

    for (const [smid, entry] of Object.entries(geo.pickInfo) as [string, any][]) {
      const hit = lookup.get(entry.instanceIds[0]);
      expect(hit).toBeTruthy();
      expect(hit!.smid).toBe(Number(smid));
      expect(hit!.batchId).toBe(entry.instanceBatchId);
    }
    expect(lookup.get(vp.instanceCount + 10)).toBeUndefined();

    // resolveFeature 两种形态都要认：顶点区间型按 batchId，实例化型按控制位
    const smid0 = Number(Object.keys(geo.pickInfo)[0]);
    const viaInstance = resolveFeature(geo, pickEntryId(geo.pickInfo[smid0]));
    expect(viaInstance.smid).toBe(smid0);
    expect(viaInstance.segments.length).toBe(0); // 实例化单体没有顶点区间
  });

  test('实例矩阵：包围盒跟随实例位置', () => {
    const { geo } = instancedGeo;
    const smid = Number(Object.keys(geo.pickInfo)[0]);
    const entry = geo.pickInfo[smid];
    const mesh = instancedMeshes.find((m) => m.userData.geoRef === geo);
    const layer = new S3MLayer({});

    const box = (layer.viewer as any)._instanceBox(mesh, entry.instanceIds[0]);
    expect(box).toBeTruthy();
    expect(box!.maxX).toBeGreaterThan(box!.minX);
    expect(box!.maxZ).toBeGreaterThan(box!.minZ); // 不能退化成点

    const m = new THREE.Matrix4();
    mesh.getMatrixAt(entry.instanceIds[0], m);
    expect(Math.abs(box!.minX - m.elements[12])).toBeLessThan(1e6); // 已平移到了实例位置
  });
});
