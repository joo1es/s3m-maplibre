/**
 * #30 trimBudget 增量统计
 *
 * 现状：开了 maxTriangles / maxMemory 之后，while 每轮判断都要重新全表统计
 * （residentTriangles / residentGeometryBytes / residentTextureBytes），
 * 连踢 K 块就是 K 轮三四次 O(N)。改成进循环前算一次、淘汰时按 footprint 增量扣。
 *
 * 两条必须守住：
 *   - 双上限都是 Infinity 时，一次额外统计都不能有（默认路径逐字不变）；
 *   - 增量扣完的值必须和实算一模一样，扣多了会少裁（仍超额），扣少了会多裁（画面缺块）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

let realFetch: typeof globalThis.fetch;
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
});

function mk(opts: { maxTiles?: number; maxTriangles?: number; maxMemory?: number } = {}) {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => {})) as never;
  const ts = new S3MTileset({
    configUrl: 'https://example.com/ds/config',
    maxTiles: opts.maxTiles ?? 100,
    maxTriangles: opts.maxTriangles,
    maxConcurrent: 1,
    buildTile: (async () => ({ group: null, stats: {} })) as never,
    onError: () => {},
  }) as any;
  if (opts.maxMemory !== undefined) ts.setMaxMemory(opts.maxMemory);
  return ts;
}

const mkNode = (
  url: string,
  triangles: number,
  opts: Partial<{ visible: boolean; lastSeen: number; memory: number }> = {}
) => ({
  url,
  tile: { geoPackage: {} },
  // traverse 喂一个空对象：estimateObjectGeometryBytes 走不到任何 geometry，
  // 几何字节只来自显式的 stats.memory，方便按整数推演
  group: { visible: opts.visible ?? false, parent: null, traverse: (fn: any) => fn({}) },
  sphere: { center: { x: 0, y: 0, z: 0 }, radius: 50 },
  rangeValue: 1,
  rangeMode: 1,
  childUrls: [],
  childUrl: null,
  parentUrl: null,
  state: 'ready',
  lastSeen: opts.lastSeen ?? 0,
  distance: 0,
  stats: {
    meshes: 1,
    vertices: triangles * 3,
    triangles,
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
  },
});

/** generateMipmaps=false → estimateTextureBytes 精确等于 w*h*4 */
const fakeTexture = (w = 16, h = 16) => ({
  image: { width: w, height: h },
  generateMipmaps: false,
  dispose() {},
});

/** 给 budget 的两个统计方法挂计数器，返回读取函数 */
function spyStats(ts: any) {
  const budget = ts._budget;
  let triangles = 0;
  let memory = 0;
  const origTri = budget.residentTriangles.bind(budget);
  const origMem = budget.residentMemory.bind(budget);
  budget.residentTriangles = () => { triangles++; return origTri(); };
  budget.residentMemory = () => { memory++; return origMem(); };
  return { budget, counts: () => ({ triangles, memory }) };
}

describe('#30 trimBudget 增量统计', () => {
  test('默认（双 Infinity）不走任何额外统计，瓦片数裁剪结果不变', () => {
    const ts = mk({ maxTiles: 2 });
    const { counts } = spyStats(ts);
    for (let i = 0; i < 5; i++) ts.nodes.set(`t${i}`, mkNode(`t${i}`, 100, { lastSeen: i }));
    ts._trimBudget();
    expect(counts()).toEqual({ triangles: 0, memory: 0 });
    expect(ts.nodes.size).toBe(2);
  });

  test('maxTriangles 有限：整轮裁剪只全量统计一次，连踢多块后余量与实算一致', () => {
    const ts = mk({ maxTiles: 100, maxTriangles: 550 });
    const { counts } = spyStats(ts);
    for (let i = 0; i < 10; i++) ts.nodes.set(`t${i}`, mkNode(`t${i}`, 100, { lastSeen: i }));

    ts._trimBudget();

    // 当前实现每轮 while 条件都重扫一次全表，这里会是 6 次左右
    expect(counts()).toEqual({ triangles: 1, memory: 0 });
    // 1000 → 550 要踢 5 块；扣多扣少都会让这个数字偏掉
    expect(ts.nodes.size).toBe(5);
    expect(ts._residentTriangles()).toBe(500);
  });

  test('maxMemory 有限：统计一次，独占纹理随瓦片释放，最终显存精确', () => {
    const ts = mk({ maxTiles: 100, maxMemory: 6500 });
    const { budget, counts } = spyStats(ts);
    for (let i = 0; i < 6; i++) {
      const url = `t${i}`;
      ts.nodes.set(url, mkNode(url, 100, { lastSeen: i, memory: 1000 }));
      budget.registerTileTextures(url, [`tex_${i}`]);
      ts.textureCache.set(`tex_${i}`, fakeTexture() as never);
    }
    // 每块 = 1000 几何 + 16×16×4 纹理 = 2024，6 块共 12144

    ts._trimBudget();

    expect(counts().memory).toBe(1);
    // 12144 → 踢 3 块后 6072 <= 6500；踢 2 块还剩 8096 不够
    expect(ts.nodes.size).toBe(3);
    expect(ts.residentMemory()).toBe(6072);
  });

  test('共享纹理：淘汰其中一块只扣几何，纹理字节等引用归零才扣', () => {
    const ts = mk({ maxTiles: 100, maxMemory: 3000 });
    const { budget, counts } = spyStats(ts);
    for (let i = 0; i < 2; i++) {
      const url = `t${i}`;
      ts.nodes.set(url, mkNode(url, 100, { lastSeen: i, memory: 1000 }));
      budget.registerTileTextures(url, ['tex_shared']);
    }
    ts.textureCache.set('tex_shared', fakeTexture() as never);
    // 总显存 = 1000×2 + 1024 = 3024

    ts._trimBudget();

    expect(counts().memory).toBe(1);
    expect(ts.nodes.size).toBe(1);
    expect(ts.textureCache.has('tex_shared')).toBe(true);
    expect(ts.residentMemory()).toBe(2024);
  });

  test('evictTileNode 返回的 footprint 与淘汰前后实算差值一致', () => {
    const ts = mk({ maxTiles: 100 });
    const { budget } = spyStats(ts);
    const a = mkNode('a', 300, { memory: 1000 });
    const b = mkNode('b', 200, { memory: 500 });
    ts.nodes.set('a', a);
    ts.nodes.set('b', b);
    budget.registerTileTextures('a', ['tex_a', 'tex_shared']);
    budget.registerTileTextures('b', ['tex_shared']);
    ts.textureCache.set('tex_a', fakeTexture() as never);
    ts.textureCache.set('tex_shared', fakeTexture(8, 8) as never); // 8×8×4 = 256

    const beforeTri = ts._residentTriangles();
    const beforeMem = ts.residentMemory();
    const fp = budget.evictTileNode(a);

    expect(fp.triangles).toBe(beforeTri - ts._residentTriangles());
    expect(fp.geometryBytes + fp.textureBytes).toBe(beforeMem - ts.residentMemory());
    // tex_shared 还被 b 引用，不能算进这次释放
    expect(fp.textureBytes).toBe(1024);
    expect(ts.textureCache.has('tex_shared')).toBe(true);
  });

  test('没有安全候选时允许暂时超额，不会把场景清空', () => {
    const ts = mk({ maxTiles: 100, maxTriangles: 100 });
    const { counts } = spyStats(ts);
    for (let i = 0; i < 3; i++) ts.nodes.set(`t${i}`, mkNode(`t${i}`, 400, { visible: true }));

    ts._trimBudget();

    expect(ts.nodes.size).toBe(3);
    expect(counts().triangles).toBe(1);
  });

  test('上限为 NaN 时不触发有限预算分支', () => {
    const ts = mk({ maxTiles: 2, maxTriangles: NaN as never });
    const { counts } = spyStats(ts);
    for (let i = 0; i < 4; i++) ts.nodes.set(`t${i}`, mkNode(`t${i}`, 100, { lastSeen: i }));
    ts._trimBudget();
    expect(counts().triangles).toBe(0);
    expect(ts.nodes.size).toBe(2);
  });
});
