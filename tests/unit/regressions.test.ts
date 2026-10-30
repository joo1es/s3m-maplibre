/**
 * 回归测试：几条「看起来没事、实际上会串/会卡死」的路径
 *
 * 1. 材质不能跨 mesh 共享 —— 单体状态（隐藏 / 改色 / 抬高 / 选中）挂在材质自己的
 *    uniform 上，一旦共享就是「多个 mesh 抢一份 uBatchTex」，只有最后写的生效。
 * 2. 瓦片数到上限要淘汰，而不是拒绝加载（原来会永久停止出图）。
 * 3. 单块瓦片失败要退避重试，不能一次网络抖动就永久留洞。
 * 4. 拾取 ID 只有 2 字节，必须回收复用。
 * 5. 批量改单体样式要合并成一次状态纹理重写。
 * 6. uHeightMin/Max 增量维护。
 * 7. 拾取只渲染 1 个像素。
 * 8. 多 SMID 共用 batchId 不互相覆盖。
 * 9. CRN 解码器魔数先行拦截。
 * 10. 没有「叶子」可淘汰时不能永久卡死。
 * 11. 瓦片层级可见性互斥（HLOD）。
 *
 * 注意：bun test 默认所有测试文件跑在同一个进程、共享同一个 global，
 * 所以这里对 fetch / performance.now / console.warn 的替换都在每个用例内成对还原。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';
import { S3MTileset, classifyDatasetKind, parseConfigText } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { S3MLayer } from '../../packages/s3m-maplibre/src/index';
import { createSharedUniforms, createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';
import { Picker } from '../../packages/s3m-three/src/render/Picker';
import { transcodeCRN } from '../../packages/s3m-three/src/core/CRNDecode';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

let realFetch: typeof globalThis.fetch;
let realNow: typeof performance.now;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realNow = performance.now;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  performance.now = realNow;
});

/** 永不 resolve 的 fetch：避免用例真的发请求 */
const stallFetch = () => {
  globalThis.fetch = (() => new Promise<void>(() => {})) as unknown as typeof fetch;
};

const f32 = (arr: number[]) => new Uint8Array(new Float32Array(arr).buffer);

const quad = () => ({
  vertexPackage: {
    verticesCount: 3,
    vertexAttributes: [
      { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
      { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: f32([0, 0, 1, 0, 0, 1]) },
    ],
    instanceIndex: -1,
  },
  indexPackages: [{ primitiveType: 4, indexCount: 3, indices: new Uint16Array([0, 1, 2]), passNames: ['Mtr_Shared'] }],
});

const mkNode = (url: string, childUrl: string | null, lastSeen: number, distance: number) => ({
  url,
  tile: {},
  group: new THREE.Group(),
  sphere: null,
  rangeValue: 100,
  rangeMode: 1,
  childUrl,
  state: 'done',
  lastSeen,
  distance,
});

const mkTileset = (opts: Record<string, unknown> = {}) =>
  new S3MTileset({
    configUrl: 'http://example.com/a.scp',
    buildTile: async () => ({ group: new THREE.Group(), stats: {} }),
    ...opts,
  });

describe('1. 同材质码的多个 mesh 必须各持一份材质', () => {
  test('3 个 mesh 各持独立材质与 uBatchTex，写状态互不影响', async () => {
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
    const res = await buildTileObjects(tile as never, { batching: false });
    expect(res.stats.meshes).toBe(3);

    const mats = res.objects.filter((o: any) => o.isMesh).map((m: any) => m.material);
    expect(new Set(mats).size).toBe(mats.length); // 不能共用同一个材质实例

    const texUniforms = mats.map((m: any) => m.userData.uBatchTex);
    expect(new Set(texUniforms).size).toBe(texUniforms.length);

    // 往其中一个材质写状态，不能影响其他材质
    mats[0].userData.uBatchTexActive.value = 1;
    expect(mats[1].userData.uBatchTexActive.value).toBe(0);
  });
});

describe('2. 预算满时不停止加载，但绝不踢「正在显示且没人接手」的瓦片', () => {
  test('入队不淘汰（make-before-break）；超额部分等子瓦接手显示后由 update() 裁', () => {
    const removed: string[] = [];
    const ts = mkTileset({ maxTiles: 2, onTileRemoved: (node: any) => removed.push(node.url) });

    ts.nodes.set('old', mkNode('old', null, 1, 900) as never);
    ts.nodes.set('recent', mkNode('recent', null, 9, 50) as never);

    stallFetch();
    (ts as any)._enqueue('http://example.com/new.s3mb');

    // 旧策略在这里就会为了塞新瓦片删掉 lastSeen 最旧的「old」—— 而它正在显示、
    // 位置没有任何子瓦接手，删掉立刻是一个洞，下一帧还得回补 → 反复就是闪烁。
    expect(removed).toEqual([]);
    expect(ts.nodes.has('old')).toBe(true);
    // 新瓦片照常进入加载队列，预算不再靠「先删后加」来腾地方
    expect(ts.pending.size + (ts as any)._queue.length).toBeGreaterThan(0);
  });

  test('子瓦接手显示后，父瓦才是安全候选（由 _trimBudget 裁掉）', () => {
    const removed: string[] = [];
    const ts = mkTileset({ maxTiles: 1, onTileRemoved: (node: any) => removed.push(node.url) });
    const parent = mkNode('p', 'c', 1, 10) as any;
    const child = mkNode('c', null, 9, 5) as any;
    ts.nodes.set('p', parent);
    ts.nodes.set('c', child);
    // 现状：子瓦在显示、父瓦已交棒（不可见）→ 父瓦没人依赖，可以裁
    parent.group.visible = false;
    child.group.visible = true;

    (ts as any)._trimBudget();
    expect(removed).toEqual(['p']);
    expect(ts.nodes.has('c')).toBe(true); // 正在显示的绝不动
  });
});

describe('3. 瓦片失败退避重试，超次数才进 failed', () => {
  test('失败 3 次（2 次重试）后才进 failed，retryFailed() 可手动恢复', async () => {
    const ts = mkTileset({ maxRetries: 2, onError: () => {} });

    let fakeNow = 1000;
    performance.now = () => fakeNow;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('network down');
    }) as never;

    await (ts as any)._load('http://example.com/t.s3mb');
    expect(ts.failed.size).toBe(0); // 第一次失败不应直接进 failed
    expect(calls).toBe(1);

    // 退避期内再入队应被拒绝
    (ts as any)._enqueue('http://example.com/t.s3mb');
    expect(calls).toBe(1);

    // 退避结束后还能再试
    fakeNow += 10000;
    await (ts as any)._load('http://example.com/t.s3mb');
    expect(calls).toBe(2);

    fakeNow += 10000;
    await (ts as any)._load('http://example.com/t.s3mb');
    expect(calls).toBe(3);
    expect(ts.failed.has('http://example.com/t.s3mb')).toBe(true); // 超次数后才永久标记

    expect(ts.retryFailed()).toBe(1);
    expect(ts.failed.size).toBe(0);
  });
});

describe('4. 拾取 ID 回收复用（2 字节上限）', () => {
  test('释放的 ID 会被下一个网格复用，不会无限增长', () => {
    const layer = new S3MLayer({ configUrl: 'http://example.com/a.scp' });
    const a = (layer.viewer as any)._allocPickId();
    const b = (layer.viewer as any)._allocPickId();
    expect([a, b]).toEqual([0, 1]);

    (layer.viewer as any)._releasePickId(a);
    expect((layer.viewer as any)._allocPickId()).toBe(a);
  });
});

describe('5. 批量改单体样式只重写一次状态纹理', () => {
  test('300 次 setFeatureStyle 合并成 1 次重算；单改一个单体只碰它所在的网格', async () => {
    /** 造一块装了 n 个单体的网格 */
    const makeMesh = (smids: number[]) => {
      const pos: number[] = [];
      const batch: number[] = [];
      smids.forEach((_, i) => {
        const x = i * 2;
        pos.push(x, 0, 0, x + 1, 0, 0, x, 0, 1);
        batch.push(i, i, i);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('aBatchId', new THREE.Float32BufferAttribute(batch, 1));
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: createSharedUniforms() }));
      const pickInfo: Record<string, unknown> = {};
      smids.forEach((smid, i) => {
        pickInfo[smid] = { batchId: i };
      });
      mesh.userData.geoRef = { pickInfo, entities: [] };
      return mesh;
    };

    const layer = new S3MLayer({});
    const smids = Array.from({ length: 300 }, (_, i) => i + 1);
    const mesh = makeMesh(smids);
    (layer.viewer as any)._pickables.set(1, { datasetId: 'd', mesh, tile: {}, skeletonName: '' } as never);
    (layer.viewer as any)._indexMeshSmids(mesh);

    let calls = 0;
    const original = (layer.viewer as any)._applyOverridesToMesh.bind(layer.viewer);
    (layer.viewer as any)._applyOverridesToMesh = (m: any) => {
      calls++;
      original(m);
    };

    for (const smid of smids) layer.setFeatureStyle(smid, { color: '#ff0000' });
    expect(calls).toBe(0); // 同步块内不该立刻重算
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1); // 300 次调用应合并成 1 次

    const data = mesh.material.userData.uBatchTex.value.image.data;
    expect(mesh.material.userData.uBatchTexActive.value).toBe(1); // 有样式时要打开状态纹理
    expect(data[0]).toBeGreaterThan(0.9);
    expect(data[1]).toBeLessThan(0.05); // 第一个单体写成红色

    // 只改其中一个单体时，不该碰不含它的网格
    const other = makeMesh([9001, 9002]);
    (layer.viewer as any)._pickables.set(2, { datasetId: 'd', mesh: other, tile: {}, skeletonName: '' } as never);
    (layer.viewer as any)._indexMeshSmids(other);
    calls = 0;
    layer.setFeatureStyle(9001, { color: '#00ff00' });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
  });
});

describe('6. uHeightMin / uHeightMax 增量维护', () => {
  test('进出网格只做 O(1) 滚动，淘汰边界值时才 O(n) 重算', () => {
    const layer = new S3MLayer({});
    const boxAt = (z0: number, z1: number) => {
      const geo = new THREE.BoxGeometry(1, 1, z1 - z0);
      geo.translate(0, 0, (z0 + z1) / 2);
      geo.computeBoundingBox();
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    };

    const a = boxAt(0, 10);
    const b = boxAt(5, 80);
    const c = boxAt(-2, 30);
    for (const m of [a, b, c]) (layer.viewer as any)._addMeshHeight(m);

    const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
    expect(near(layer.uniforms.uHeightMin.value, -2)).toBe(true);
    expect(near(layer.uniforms.uHeightMax.value, 80)).toBe(true);

    // 淘汰非边界网格：不动全局值
    (layer.viewer as any)._removeMeshHeight(a);
    expect(near(layer.uniforms.uHeightMin.value, -2)).toBe(true);
    expect(near(layer.uniforms.uHeightMax.value, 80)).toBe(true);

    // 淘汰顶到边界的网格：必须回退到次大值，不能留着 80
    (layer.viewer as any)._removeMeshHeight(b);
    expect(near(layer.uniforms.uHeightMax.value, 30)).toBe(true);

    // 清空后回到兜底范围
    (layer.viewer as any)._removeMeshHeight(c);
    expect([layer.uniforms.uHeightMin.value, layer.uniforms.uHeightMax.value]).toEqual([0, 100]);
  });
});

describe('7. 拾取渲染目标缩到 1×1，靠平移 viewport 定位', () => {
  test('1×1 渲染目标 + 平移 viewport，读回单像素；命中解析不变', () => {
    const captured: { target?: any; reads: number[][] } = { reads: [] };
    const fakeRenderer = {
      domElement: { width: 200, height: 100, clientWidth: 200, clientHeight: 100 },
      toneMapping: 1,
      outputColorSpace: 'srgb',
      autoClear: false,
      getRenderTarget: () => null,
      setRenderTarget: (t: any) => {
        // finally 里会切成 null 还原，只记真正的离屏目标
        if (t) captured.target = t;
      },
      getViewport: (v: any) => v.set(0, 0, 200, 100),
      setViewport: () => {},
      getClearColor: (c: any) => c,
      getClearAlpha: () => 1,
      setClearColor: () => {},
      resetState: () => {},
      clear: () => {},
      render: () => {},
      readRenderTargetPixels: (_t: any, x: number, y: number, w: number, h: number, buf: any) => {
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

    const picker = new Picker(fakeRenderer as never);
    const hit = picker.pick(scene, new THREE.Camera(), 50, 30);

    expect(captured.target.width).toBe(1);
    expect(captured.target.height).toBe(1);
    // 点击点 (50, 30) → WebGL 行 100-1-30 = 69 → viewport 原点平移成 (-50, -69)
    const vp = captured.target.viewport;
    expect([vp.x, vp.y, vp.z, vp.w]).toEqual([-50, -69, 200, 100]);
    expect(captured.reads[0]).toEqual([0, 0, 1, 1]); // 只读目标里的 1 个像素
    expect(hit).toEqual({ objectId: 0, batchId: 0 });
  });
});

describe('8. 多个 SMID 共用 batchId 时不互相覆盖', () => {
  test('冲突取值确定（首个）、任一隐藏整批隐藏、auditBatches 能列出来', () => {
    const layer = new S3MLayer({});
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
    geo.setAttribute('aBatchId', new THREE.Float32BufferAttribute([0, 0, 0], 1));
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: createSharedUniforms() }));
    // SMID 1 与 2 共用一个 batch（实测「邻店共 batchId」），3 独立
    mesh.userData.geoRef = {
      pickInfo: { 1: { batchId: 0 }, 2: { batchId: 0 }, 3: { batchId: 1 } },
      entities: [],
    };
    (layer.viewer as any)._pickables.set(1, { datasetId: 'd', mesh, tile: {}, skeletonName: '' } as never);
    (layer.viewer as any)._indexMeshSmids(mesh);

    const data = () => mesh.material.userData.uBatchTex.value.image.data;

    // 两个 SMID 给同一个 batch 上不同颜色：不能出现「后写的说了算」
    const realWarn = console.warn;
    let warned = 0;
    console.warn = () => {
      warned++;
    };
    try {
      layer.setFeatureStyle(1, { color: '#ff0000' });
      layer.setFeatureStyle(2, { color: '#00ff00' });
      layer.flushOverrides();
    } finally {
      console.warn = realWarn;
    }

    expect(data()[0]).toBeGreaterThan(0.9);
    expect(data()[1]).toBeLessThan(0.05); // 取首个 SMID 的红，而不是被后写的绿覆盖
    expect(warned).toBe(1); // 冲突只告警一次，不刷屏

    // 任一隐藏则整批隐藏（batch 粒度没法定点藏其中一间）
    layer.setFilter({ include: [3] });
    layer.flushOverrides();
    expect(data()[0 * 4 + 3]).toBe(-1); // SMID 1 被过滤 → batch 0 整批隐藏
    expect(data()[1 * 4 + 3]).toBe(0); // batch 1 不受影响

    // 同一个 batch 既要隐藏又要抬高时，抬高不能把隐藏标记写回去
    layer.setFeatureStyle(1, { color: '#ff0000', elevation: 30 });
    layer.setThematicElevation(new Map([[1, 30]]));
    layer.setFilter({ include: [3] });
    layer.flushOverrides();
    expect(data()[0 * 4 + 3]).toBe(-1); // 隐藏必须压过抬高

    const audit = layer.auditBatches();
    expect(audit.conflicts.length).toBe(1);
    expect(audit.conflicts[0].smids).toEqual([1, 2]);
    expect(audit.batches).toBe(2);
    expect(audit.conflictingSmids).toBe(2);
  });
});

describe('9. CRN 解码器：魔数先拦、非法数据能明确拒绝', () => {
  test('空数据 / 非 CRN / 全零被魔数挡住；坏 Hx 头进 wasm 后抛明确错误', async () => {
    // 前三种在进 wasm 之前就该被拦掉（省一次 76KB wasm 的实例化）
    await expect(transcodeCRN(new Uint8Array(0))).rejects.toThrow(/为空/);
    await expect(transcodeCRN(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/CRN 头/);
    await expect(transcodeCRN(new Uint8Array(64))).rejects.toThrow(/CRN 头/);

    // 带 Hx 头但内容非法：这条路才真正进 wasm，必须抛错而不是崩掉或挂住
    const fake = new Uint8Array(64);
    fake.set([0x48, 0x78, 0x00, 0x6e]);
    await expect(transcodeCRN(fake)).rejects.toThrow(/CRN|crunch/);
  });
});

describe('10. 淘汰选择：只裁「已交棒的父瓦」；脏数据（childTile 指回自己）不得永久卡住', () => {
  test('父瓦已把显示交给子瓦 → 裁父瓦；正在显示的叶子不动', () => {
    const makeSet = (removed: string[]) => mkTileset({ maxTiles: 1, onTileRemoved: (n: any) => removed.push(n.url) });
    stallFetch();

    const removedA: string[] = [];
    const tsA = makeSet(removedA);
    const parent = mkNode('parent', 'child', 1, 900) as any;
    const child = mkNode('child', null, 9, 10) as any;
    parent.group.visible = false; // 已交棒
    child.group.visible = true;
    tsA.nodes.set('parent', parent);
    tsA.nodes.set('child', child);

    (tsA as any)._trimBudget();
    expect(removedA).toEqual(['parent']); // 裁掉没人依赖的父瓦
    expect(tsA.nodes.has('child')).toBe(true); // 正在显示的叶子保留

    // 脏数据：childTile 指回自己，历史上会在这里永久拒绝加载
    const removedB: string[] = [];
    const tsB = makeSet(removedB);
    tsB.nodes.set('self', mkNode('self', 'self', 1, 900) as never);
    tsB.nodes.set('other', mkNode('other', 'other', 5, 500) as never);
    (tsB as any)._trimBudget();
    expect(removedB.length).toBe(1); // 至少能裁一块，不会卡死
  });

  test('入队不再靠「先删旧的」腾位置', () => {
    const removed: string[] = [];
    const ts = mkTileset({ maxTiles: 2, onTileRemoved: (n: any) => removed.push(n.url) });
    stallFetch();
    ts.nodes.set('a', mkNode('a', null, 1, 900) as never);
    ts.nodes.set('b', mkNode('b', null, 5, 500) as never);
    (ts as any)._enqueue('http://example.com/new2.s3mb');
    expect(removed).toEqual([]);
    expect(ts.pending.size + (ts as any)._queue.length).toBe(1); // 新瓦片正常进队列
  });
});

describe('11. 瓦片层级可见性切换（HLOD 互斥，防止父子重叠 Z-fighting）', () => {
  test('父子瓦片按 LOD 正确互斥显示，同区域只保留一层网格', () => {
    stallFetch();

    const ts = mkTileset({ maxTiles: 10 });
    const mkNodeWithSphere = (url: string, childUrl: string | null, radius: number, rangeValue: number) => {
      const group = new THREE.Group();
      group.visible = true;
      return {
        url,
        tile: {},
        group,
        sphere: { center: { x: 0, y: 0, z: 0 }, radius },
        rangeValue,
        rangeMode: 1, // pixelSizeOnScreen
        childUrl,
        childUrls: childUrl ? [childUrl] : [],
        state: 'ready',
      };
    };

    const parent = mkNodeWithSphere('http://example.com/parent.s3mb', 'http://example.com/child.s3mb', 50, 20);
    const child = mkNodeWithSphere('http://example.com/child.s3mb', null, 50, 0);
    ts.nodes.set(parent.url, parent as never);
    ts.rootUrls.push(parent.url);

    // 1. 视距较远（视深 20000m，屏幕像素 ≈ 4.3 < rangeValue 20）：父瓦片可见
    //    像素公式与官方一致：pix = ((H/2)/tan(22.5°)) * (r/d) * 2
    ts.update([0, 0, 20000], Math.PI / 3, 1000);
    expect(parent.group.visible).toBe(true);

    // 2. 靠近（视深 100m，像素放大 > 20）但子瓦片尚未载入：父瓦片必须保持显示以防破洞
    ts.update([0, 0, 100], Math.PI / 3, 1000);
    expect(parent.group.visible).toBe(true);

    // 3. 子瓦片就绪后：父隐藏、子显示，彻底杜绝 Z-fighting
    ts.nodes.set(child.url, child as never);
    ts.update([0, 0, 100], Math.PI / 3, 1000);
    expect(parent.group.visible).toBe(false);
    expect(child.group.visible).toBe(true);

    // 4. 再次拉远（dist 20000m，metric ≈ 4.3 < 20）：父瓦片恢复、子瓦片隐藏
    ts.update([0, 0, 20000], Math.PI / 3, 1000);
    expect(parent.group.visible).toBe(true);
    expect(child.group.visible).toBe(false);
  });
});

describe('12. EdgeDecorator 的 host 绑定必须跟 mount 后的活实例走（GPU 描边静默失效）', () => {
  /**
   * 0048a99 拆分 S3MViewer 时，EdgeHost 的 scene / renderer / camera 被写成构造期的
   * **值快照** —— 而 mount() 与 restoreContext() 都会换掉这三个对象，于是
   * `renderGpuEdges` 读到的 renderer 恒为 null、静默 return：`edges: 'gpu'` 完全不画。
   * 这里锁定：mount 之后（renderer / scene / camera 已替换成新实例）GPU 描边
   * 必须真的跑两遍渲染（法线 RT + 全屏 quad）。
   */
  test('edges: gpu 在 mount 后仍然后处理（host 不能拿构造期的 null renderer）', () => {
    stallFetch();
    const v = new S3MViewer({ style: { edges: 'gpu' } });
    v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };
    // 模拟 mount：scene / renderer / camera 全部换成新实例（值快照会全部失联）
    let renders = 0;
    (v as unknown as { canvas: unknown }).canvas = { width: 200, height: 100 };
    (v as unknown as { camera: unknown }).camera = new THREE.PerspectiveCamera();
    (v as unknown as { renderer: unknown }).renderer = {
      getContext: () => ({ isContextLost: () => false }),
      capabilities: { isWebGL2: true },
      setViewport: () => {},
      resetState: () => {},
      setRenderTarget: () => {},
      getClearColor: (c: THREE.Color) => c,
      setClearColor: () => {},
      getClearAlpha: () => 1,
      setClearAlpha: () => {},
      clear: () => {},
      render: () => {
        renders++;
      },
      dispose: () => {},
    };

    v.renderFrame({
      mvp: new THREE.Matrix4().identity().toArray(),
      cameraEnu: [0, 0, 1000],
      fovRad: 0.6,
      canvasHeight: 100,
    });

    // 直渲 1 次 + GPU 描边 2 次（法线 RT + 全屏 quad）= 3。host 绑定失效时只有 1 次。
    expect(renders).toBe(3);
    v.dispose();
  });
});

describe('13. 地形/影像缓存（Terrainz / Type=Image）不能伪装成「缺少 root tile」（issue #7）', () => {
  /**
   * 混合服务（模型 + 地形 + 影像共存）里，地形/影像数据集的 config 是按
   * Level0Width/Level0Height + Levels 金字塔寻址的栅格缓存 XML，**没有瓦片清单**。
   * 修复前它们一路走到 `if (!roots.length) throw new Error('配置中缺少 root tile')`，
   * 把「不支持的数据类型」伪装成「配置缺字段」，排查会被带偏。
   *
   * 夹具是真实服务（supermapol 3D-OlympicGreen_Plan）的两个 config，抓取于 2026-10-30：
   *   beijingdem → SuperMapCache XML，FileExtentName = Terrainz（地形，无瓦片清单）
   *   beijingimg → SuperMapCache_Unicode XML，FileExtentName = jpg_png + Type = Image（影像）
   * 注意 issue 里的猜测（影像 = Imagez/Image）与实测不符：影像的 FileExtentName 是
   * 文件扩展名样式（jpg_png），可靠判别字段是 <sml:Type>Image</sml:Type>。
   */
  const TERRAIN_XML = readFileSync(join(import.meta.dir, '../fixtures/osgb/SuperMapCache-Terrainz.xml'), 'utf8');
  const IMAGE_XML = readFileSync(join(import.meta.dir, '../fixtures/osgb/SuperMapCache-Image.xml'), 'utf8');
  const MODEL_XML = readFileSync(join(import.meta.dir, '../fixtures/osgb/SuperMapCache-OSGB.xml'), 'utf8');
  const DEM_CONFIG =
    'https://www.supermapol.com/realspace/services/3D-OlympicGreen_Plan/rest/realspace/datas/beijingdem/config';

  const mockConfigFetch = (body: string) => {
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } })) as unknown as typeof fetch;
  };

  test('parseConfigText 带出 fileExtentName / cacheType：两种栅格缓存都认得出，且都没有瓦片清单', () => {
    const dem = parseConfigText(TERRAIN_XML);
    expect(dem.fileExtentName).toBe('Terrainz');
    expect(dem.cacheType).toBeUndefined();
    expect((dem.rootTiles as unknown[]).length).toBe(0);

    const img = parseConfigText(IMAGE_XML);
    expect(img.fileExtentName).toBe('jpg_png');
    expect(img.cacheType).toBe('Image');
    expect((img.rootTiles as unknown[]).length).toBe(0);
  });

  test('classifyDatasetKind：Terrainz → terrain、Type=Image → imagery、模型 / 无标记 → model', () => {
    expect(classifyDatasetKind(parseConfigText(TERRAIN_XML))).toBe('terrain');
    expect(classifyDatasetKind(parseConfigText(IMAGE_XML))).toBe('imagery');
    // 模型类（OSGB 倾斜摄影 XML、JSON 的 dataType）与没有任何标记的一律按模型走，
    // 保证「不传 / 认不出」时行为与旧版逐字一致（不变式 ①）
    expect(classifyDatasetKind(parseConfigText(MODEL_XML))).toBe('model');
    expect(classifyDatasetKind({ dataType: 'BIM' })).toBe('model');
    expect(classifyDatasetKind({})).toBe('model');
  });

  test('init 拿到地形 config：报「是地形缓存」而不是「缺少 root tile」，也不再先吐锚点 warning', async () => {
    mockConfigFetch(TERRAIN_XML);
    const warns: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    try {
      const ts = mkTileset({ configUrl: DEM_CONFIG });
      let err: unknown;
      try {
        await ts.init();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const msg = String((err as Error).message);
      expect(msg).toContain('beijingdem'); // 数据集名来自 configUrl，一眼能对上服务里的哪个数据集
      expect(msg).toContain('地形');
      expect(msg).toContain('Terrainz');
      expect(msg).toContain('仅支持模型类');
      expect(msg).not.toContain('缺少 root tile'); // 病因说清楚了，别再留误导文案
      expect((err as { datasetKind?: string }).datasetKind).toBe('terrain'); // 程序化判别用
      // 修复前：先吐「position 与 geoBounds 不一致」再抛误导性错误；前置识别后 warning 不该出现
      expect(
        warns.map((w) => String(w[0])).some((s) => s.includes('position 与 geoBounds 不一致'))
      ).toBe(false);
    } finally {
      console.warn = realWarn;
    }
  });

  test('init 拿到影像 config（Type=Image）：同样前置拒绝', async () => {
    mockConfigFetch(IMAGE_XML);
    const ts = mkTileset({
      configUrl:
        'https://www.supermapol.com/realspace/services/3D-OlympicGreen_Plan/rest/realspace/datas/beijingimg/config',
    });
    let err: unknown;
    try {
      await ts.init();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message);
    expect(msg).toContain('beijingimg');
    expect(msg).toContain('影像');
    expect(msg).toContain('Image');
    expect(msg).toContain('仅支持模型类');
    expect(msg).not.toContain('缺少 root tile');
  });

  test('「缺少 root tile」带上类型上下文：能一眼看出 config 是哪种形态', async () => {
    // API.md 记载过的另一个触发面：configUrl 误指向 …/datas 清单 / 桌面导出漏瓦片清单。
    // 病因不同，文案必须能把两种情况区分开。
    mockConfigFetch(JSON.stringify({ dataType: 'BIM' }));
    const ts = mkTileset({ configUrl: 'https://h/iserver/services/3D-x/rest/realspace/datas/Building/config' });
    let err: unknown;
    try {
      await ts.init();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message);
    expect(msg).toContain('缺少 root tile');
    expect(msg).toContain('dataType=BIM'); // 有什么类型标记就带什么，没有就明说「无类型标记」
  });

  test('模型 XML（OSGBFile）不受影响：init 照常走到根瓦加载', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/config(\?|$)/.test(url)) return new Response(MODEL_XML, { status: 200 });
      return new Response('not found', { status: 404 }); // 根瓦 404：_load 内部吞掉，不影响断言
    }) as unknown as typeof fetch;
    const ts = mkTileset({ configUrl: 'https://h/realspace/datas/Config/config' });
    await ts.init(); // 不抛「仅支持模型类」才算通过 —— 前置识别不能误伤模型缓存
    expect(ts.isS3MV1).toBe(true);
  });
});
