/**
 * 回归测试：几条「看起来没事、实际上会串/会卡死」的路径
 *
 * 1. 材质不能跨 mesh 共享 —— 单体状态（隐藏 / 改色 / 抬高 / 选中）挂在材质自己的
 *    uniform 上，一旦共享就是「多个 mesh 抢一份 uBatchTex」，只有最后写的生效。
 * 2. 瓦片数到上限要淘汰，而不是拒绝加载（原来会永久停止出图）。
 * 3. 单块瓦片失败要退避重试，不能一次网络抖动就永久留洞。
 * 4. 拾取 ID 只有 2 字节，必须回收复用。
 *
 * 运行：node tools/test-regressions.mjs（需先 npm run build）
 */
import assert from 'node:assert';
import * as THREE from 'three';
import { buildTileObjects } from '../dist/render/GeometryBuilder.js';
import { S3MTileset } from '../dist/tileset/S3MTileset.js';
import { S3MLayer } from '../dist/index.js';

const quad = () => ({
  vertexPackage: {
    verticesCount: 3,
    vertexAttributes: [
      { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer) },
      { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 1, 0, 0, 1]).buffer) },
    ],
    instanceIndex: -1,
  },
  indexPackages: [
    { primitiveType: 4, indexCount: 3, indices: new Uint16Array([0, 1, 2]), passNames: ['Mtr_Shared'] },
  ],
});

/* ------------------------------------------------------------------ 1. 材质隔离 */

console.log('=== 1. 同材质码的多个 mesh 必须各持一份材质 ===');
{
  const tile = {
    groupNode: {
      pageLods: [
        {
          geodes: [
            { matrix: null, skeletonNames: ['skelA'] },
            { matrix: null, skeletonNames: ['skelB'] },
            { matrix: null, skeletonNames: ['skelC'] },
          ],
        },
      ],
    },
    geoPackage: { skelA: quad(), skelB: quad(), skelC: quad() },
    textures: {},
    materials: { materials: [{ material: { id: 'Mtr_Shared' } }] },
  };

  // batching:false 才会保留「多个 mesh + 同一个材质码」的形态，正是白模瓦片的实际情形
  const res = await buildTileObjects(tile, { batching: false });
  assert.strictEqual(res.stats.meshes, 3, `应生成 3 个 mesh，实际 ${res.stats.meshes}`);

  const mats = res.objects.filter((o) => o.isMesh).map((m) => m.material);
  assert.strictEqual(new Set(mats).size, mats.length, '三个 mesh 不能共用同一个材质实例');

  const texUniforms = mats.map((m) => m.userData.uBatchTex);
  assert.strictEqual(new Set(texUniforms).size, texUniforms.length, 'uBatchTex uniform 必须各持一份');

  // 往其中一个材质写状态，不能影响其他材质
  mats[0].userData.uBatchTexActive.value = 1;
  assert.strictEqual(mats[1].userData.uBatchTexActive.value, 0);
  console.log('  √ 3 个 mesh 各持独立材质与 uBatchTex，写状态互不影响');
}

/* ------------------------------------------------------------------ 2. 淘汰 */

console.log('\n=== 2. 超过 maxTiles 时淘汰最久没用的瓦片，而不是停止加载 ===');
{
  const removed = [];
  const ts = new S3MTileset({
    configUrl: 'http://example.com/a.scp',
    maxTiles: 2,
    buildTile: async () => ({ group: new THREE.Group(), stats: {} }),
    onTileRemoved: (node) => removed.push(node.url),
  });

  const mkNode = (url, lastSeen, distance) => ({
    url,
    tile: {},
    group: new THREE.Group(),
    sphere: null,
    rangeValue: 100,
    rangeMode: 1,
    childUrl: null,
    state: 'done',
    lastSeen,
    distance,
  });
  ts.nodes.set('old', mkNode('old', 1, 900));
  ts.nodes.set('recent', mkNode('recent', 9, 50));

  // 塞一个永不 resolve 的 fetch，避免真的发请求
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});

  ts._enqueue('http://example.com/new.s3mb');

  globalThis.fetch = realFetch;

  assert.deepStrictEqual(removed, ['old'], `应淘汰最久没用的 old，实际 ${JSON.stringify(removed)}`);
  // 新瓦片还在 pending（fetch 永不 resolve），所以「驻留 + 在途」应回到 maxTiles
  assert.strictEqual(ts.nodes.size + ts.pending.size, 2, '淘汰 1 块后总量应回到 maxTiles');
  assert.ok(ts.nodes.has('recent'), '最近在用的不能被淘汰');
  console.log('  √ 淘汰 lastSeen 最旧的瓦片并回调，最近使用的保留');
}

/* ------------------------------------------------------------------ 3. 重试 */

console.log('\n=== 3. 瓦片失败退避重试，超次数才进 failed ===');
{
  const ts = new S3MTileset({
    configUrl: 'http://example.com/a.scp',
    maxRetries: 2,
    buildTile: async () => ({ group: new THREE.Group(), stats: {} }),
    onError: () => {},
  });

  const realFetch = globalThis.fetch;
  const realNow = performance.now;
  let fakeNow = 1000;
  performance.now = () => fakeNow;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('network down');
  };

  try {
    await ts._load('http://example.com/t.s3mb');
    assert.strictEqual(ts.failed.size, 0, '第一次失败不应直接进 failed');
    assert.strictEqual(calls, 1);

    // 退避期内再入队应被拒绝
    ts._enqueue('http://example.com/t.s3mb');
    assert.strictEqual(calls, 1, '退避期内不该发起请求');

    // 退避结束后还能再试
    fakeNow += 10000;
    await ts._load('http://example.com/t.s3mb');
    assert.strictEqual(calls, 2, '退避结束后应重试一次');

    fakeNow += 10000;
    await ts._load('http://example.com/t.s3mb');
    assert.strictEqual(calls, 3, '第三次仍应重试');
    assert.ok(ts.failed.has('http://example.com/t.s3mb'), '超过重试次数后才永久标记失败');

    assert.strictEqual(ts.retryFailed(), 1, 'retryFailed 应清掉 1 条失败记录');
    assert.strictEqual(ts.failed.size, 0);
    console.log(`  √ 失败 3 次（2 次重试）后才进 failed，retryFailed() 可手动恢复`);
  } finally {
    performance.now = realNow;
    globalThis.fetch = realFetch;
  }
}

/* ------------------------------------------------------------------ 4. 拾取 ID */

console.log('\n=== 4. 拾取 ID 回收复用（2 字节上限）===');
{
  const layer = new S3MLayer({ configUrl: 'http://example.com/a.scp' });
  const a = layer._allocPickId();
  const b = layer._allocPickId();
  assert.deepStrictEqual([a, b], [0, 1]);
  layer._releasePickId(a);
  const c = layer._allocPickId();
  assert.strictEqual(c, a, '释放过的 ID 应被复用');
  console.log('  √ 释放的 ID 会被下一个网格复用，不会无限增长');
}


/* ------------------------------------------------------- 5. 单体状态脏标记合并 */

console.log('\n=== 5. 批量改单体样式只重写一次状态纹理 ===');
{
  const { createSharedUniforms, createStyledMaterial } = await import('../dist/render/StyleMaterial.js');

  /** 造一块装了 n 个单体的网格 */
  const makeMesh = (smids) => {
    const pos = [];
    const batch = [];
    smids.forEach((_, i) => {
      const x = i * 2;
      pos.push(x, 0, 0, x + 1, 0, 0, x, 0, 1);
      batch.push(i, i, i);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aBatchId', new THREE.Float32BufferAttribute(batch, 1));
    geo.computeBoundingBox();
    const mat = createStyledMaterial({ uniforms: createSharedUniforms() });
    const mesh = new THREE.Mesh(geo, mat);
    const pickInfo = {};
    smids.forEach((smid, i) => {
      pickInfo[smid] = { batchId: i };
    });
    mesh.userData.geoRef = { pickInfo, entities: [] };
    return mesh;
  };

  const layer = new S3MLayer({});
  const smids = Array.from({ length: 300 }, (_, i) => i + 1);
  const mesh = makeMesh(smids);
  layer._pickables.set(1, { datasetId: 'd', mesh, tile: {}, skeletonName: '' });
  layer._indexMeshSmids(mesh);

  let calls = 0;
  const original = layer._applyOverridesToMesh.bind(layer);
  layer._applyOverridesToMesh = (m) => {
    calls++;
    original(m);
  };

  for (const smid of smids) layer.setFeatureStyle(smid, { color: '#ff0000' });
  assert.strictEqual(calls, 0, '同步块内的 300 次调用不应立刻重算任何网格');
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(calls, 1, '300 次调用应合并成 1 次重算，实际 ' + calls + ' 次');

  const data = mesh.material.userData.uBatchTex.value.image.data;
  assert.strictEqual(mesh.material.userData.uBatchTexActive.value, 1, '有样式时要打开状态纹理');
  assert.ok(data[0] > 0.9 && data[1] < 0.05, '第一个单体应该被写成红色');

  // 只改其中一个单体时，不该碰不含它的网格
  const other = makeMesh([9001, 9002]);
  layer._pickables.set(2, { datasetId: 'd', mesh: other, tile: {}, skeletonName: '' });
  layer._indexMeshSmids(other);
  calls = 0;
  layer.setFeatureStyle(9001, { color: '#00ff00' });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(calls, 1, '只有装着 9001 的那块网格该重算，实际 ' + calls + ' 次');
  console.log('  √ 300 次 setFeatureStyle 合并成 1 次重算；单改一个单体只碰它所在的网格');
}

/* --------------------------------------------------------- 6. 高度范围增量维护 */

console.log('\n=== 6. uHeightMin / uHeightMax 增量维护 ===');
{
  const layer = new S3MLayer({});
  const boxAt = (z0, z1) => {
    const geo = new THREE.BoxGeometry(1, 1, z1 - z0);
    geo.translate(0, 0, (z0 + z1) / 2);
    geo.computeBoundingBox();
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  };

  const a = boxAt(0, 10);
  const b = boxAt(5, 80);
  const c = boxAt(-2, 30);
  for (const m of [a, b, c]) layer._addMeshHeight(m);

  const near = (x, y) => Math.abs(x - y) < 1e-6;
  assert.ok(near(layer.uniforms.uHeightMin.value, -2), 'min 应为 -2，实际 ' + layer.uniforms.uHeightMin.value);
  assert.ok(near(layer.uniforms.uHeightMax.value, 80), 'max 应为 80，实际 ' + layer.uniforms.uHeightMax.value);

  // 淘汰非边界网格：不动全局值
  layer._removeMeshHeight(a);
  assert.ok(
    near(layer.uniforms.uHeightMin.value, -2) && near(layer.uniforms.uHeightMax.value, 80),
    '非边界淘汰不该改变范围'
  );

  // 淘汰顶到边界的网格：必须回退到次大值，不能留着 80
  layer._removeMeshHeight(b);
  assert.ok(
    near(layer.uniforms.uHeightMax.value, 30),
    '淘汰边界网格后 max 应回退到 30，实际 ' + layer.uniforms.uHeightMax.value
  );

  // 清空后回到兜底范围
  layer._removeMeshHeight(c);
  assert.deepStrictEqual(
    [layer.uniforms.uHeightMin.value, layer.uniforms.uHeightMax.value],
    [0, 100],
    '清空后应回到兜底范围 0~100'
  );
  console.log('  √ 进出网格只做 O(1) 滚动，淘汰边界值时才 O(n) 重算');
}

/* ------------------------------------------------------ 7. 拾取只渲染一个像素 */

console.log('\n=== 7. 拾取渲染目标缩到 1×1，靠平移 viewport 定位 ===');
{
  const { Picker } = await import('../dist/render/Picker.js');

  const captured = { reads: [] };
  const fakeRenderer = {
    domElement: { width: 200, height: 100, clientWidth: 200, clientHeight: 100 },
    toneMapping: 1,
    outputColorSpace: 'srgb',
    autoClear: false,
    getRenderTarget: () => null,
    setRenderTarget: (t) => {
      // finally 里会切成 null 还原，只记真正的离屏目标
      if (t) captured.target = t;
    },
    getViewport: (v) => v.set(0, 0, 200, 100),
    setViewport: () => {},
    getClearColor: (c) => c,
    getClearAlpha: () => 1,
    setClearColor: () => {},
    resetState: () => {},
    clear: () => {},
    render: () => {},
    readRenderTargetPixels: (_t, x, y, w, h, buf) => {
      captured.reads.push([x, y, w, h]);
      // 编码：objectId 0 → R=1, G=0；batchId 0 → B=1, A=0
      buf[0] = 1;
      buf[1] = 0;
      buf[2] = 1;
      buf[3] = 0;
    },
  };

  const scene = new THREE.Scene();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geo.setAttribute('aBatchId', new THREE.Float32BufferAttribute([0, 0, 0], 1));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  mesh.userData.pickId = 3;
  scene.add(mesh);

  const picker = new Picker(fakeRenderer);
  const hit = picker.pick(scene, new THREE.Camera(), 50, 30);

  assert.strictEqual(captured.target.width, 1, '拾取目标应为 1×1');
  assert.strictEqual(captured.target.height, 1);
  // 点击点 (50, 30) → WebGL 行 100-1-30 = 69 → viewport 原点平移成 (-50, -69)
  const vp = captured.target.viewport;
  assert.deepStrictEqual(
    [vp.x, vp.y, vp.z, vp.w],
    [-50, -69, 200, 100],
    'viewport 应为 (-50,-69,200,100)，实际 (' + vp.x + ',' + vp.y + ',' + vp.z + ',' + vp.w + ')'
  );
  assert.deepStrictEqual(captured.reads[0], [0, 0, 1, 1], '只读目标里的 1 个像素');
  assert.deepStrictEqual(hit, { objectId: 0, batchId: 0 }, '编码解析仍然正确');
  console.log('  √ 1×1 渲染目标 + 平移 viewport，读回单像素；命中解析不变');
}

console.log('\n全部通过');
