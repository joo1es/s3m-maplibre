/**
 * 回归测试：移动端 / 差设备的两个可选刹车（默认都不启用）
 *
 *   1. `maxTriangles` —— 瓦片数之外的按面数预算。`maxTiles` 数不了「一块精模几十万面」，
 *      这条按实际驻留面数裁，必须复用同一套 make-before-break（只踢安全候选）。
 *   2. `lodPixelRatioCap` —— LOD 判定屏幕高度的 DPR 上限。默认沿用物理像素高度
 *      （官方 calcPixFromCam 口径），配了才按 CSS 高度 × cap 截断。
 *
 * 关键约束：两者默认值都必须让旧行为逐字不变。
 */
import { afterEach, expect, test } from 'bun:test';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

let realFetch: typeof globalThis.fetch;
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
});

function mk(opts: { maxTiles?: number; maxTriangles?: number } = {}) {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => {})) as never;
  return new S3MTileset({
    configUrl: 'https://example.com/ds/config',
    maxTiles: opts.maxTiles ?? 100,
    maxTriangles: opts.maxTriangles,
    maxConcurrent: 1,
    buildTile: (async () => ({ group: null, stats: {} })) as never,
    onError: () => {},
  }) as any;
}

const mkNode = (
  url: string,
  triangles: number,
  opts: Partial<{ visible: boolean; children: string[]; parent: string | null; lastSeen: number }> = {}
) => ({
  url,
  tile: { geoPackage: {} },
  group: { visible: opts.visible ?? true, parent: null, traverse: (fn: any) => fn({}) },
  sphere: { center: { x: 0, y: 0, z: 0 }, radius: 50 },
  rangeValue: 1,
  rangeMode: 1,
  childUrls: opts.children ?? [],
  childUrl: (opts.children ?? [])[0] ?? null,
  parentUrl: opts.parent ?? null,
  state: 'ready',
  lastSeen: opts.lastSeen ?? 0,
  distance: 0,
  stats: { meshes: 1, vertices: triangles * 3, triangles },
});

/* ---------------------------------------------------------------- 面数预算 */

test('maxTriangles 默认为 Infinity：只挨瓦片数预算，面数多大都不裁', () => {
  const ts = mk({ maxTiles: 100 });
  expect(ts.maxTriangles).toBe(Infinity);

  for (let i = 0; i < 5; i++) ts.nodes.set(`t${i}`, mkNode(`t${i}`, 1_000_000, { visible: false }));
  ts._trimBudget();
  // 面数 500 万远超任何合理预算，但没配预算 → 一块都不该被踢
  expect(ts.nodes.size).toBe(5);
});

test('超过面数预算时按最久未用裁掉安全候选，且绝不裁正在显示的独立瓦片', () => {
  const ts = mk({ maxTiles: 100, maxTriangles: 1000 });
  const removed: string[] = [];
  ts._onTileRemoved = (n: any) => removed.push(n.url);

  ts.rootUrls.push('shown');
  ts.nodes.set('shown', mkNode('shown', 400, { visible: true, lastSeen: 99 }));
  ts.nodes.set('old', mkNode('old', 400, { visible: false, lastSeen: 1 }));
  ts.nodes.set('new', mkNode('new', 400, { visible: false, lastSeen: 50 }));

  ts._trimBudget();

  // 1200 → 需要踢掉一块；先踢 lastSeen 最小的
  expect(removed).toEqual(['old']);
  expect(ts.nodes.has('shown')).toBe(true);
  expect(ts._residentTriangles()).toBe(800);
});

test('面数超预算却没有安全候选时允许暂时超额（不开洞）', () => {
  const ts = mk({ maxTiles: 100, maxTriangles: 500 });
  const removed: string[] = [];
  ts._onTileRemoved = (n: any) => removed.push(n.url);

  ts.rootUrls.push('a', 'b');
  ts.nodes.set('a', mkNode('a', 400, { visible: true }));
  ts.nodes.set('b', mkNode('b', 400, { visible: true }));

  ts._trimBudget();
  expect(removed).toEqual([]);
  expect(ts.nodes.size).toBe(2);
});

test('setMaxTriangles 传 0 / 负数等价于恢复不限制', () => {
  const ts = mk({ maxTriangles: 1000 });
  expect(ts.maxTriangles).toBe(1000);
  ts.setMaxTriangles(2048);
  expect(ts.maxTriangles).toBe(2048);
  ts.setMaxTriangles(0);
  expect(ts.maxTriangles).toBe(Infinity);
  ts.setMaxTriangles(-5);
  expect(ts.maxTriangles).toBe(Infinity);
});

/* ------------------------------------------------------------ LOD 高度截断 */

test('lodPixelRatioCap 默认 Infinity：LOD 用物理像素高度，行为与旧版一致', () => {
  const viewer = new S3MViewer({}) as any;
  expect(viewer.lodPixelRatioCap).toBe(Infinity);
  expect(viewer._lodScreenHeight(2556)).toBe(2556);
});

test('配了 lodPixelRatioCap 后按 CSS 高度 × cap 截断（3x 屏）', () => {
  const viewer = new S3MViewer({ lodPixelRatioCap: 2 }) as any;
  viewer.canvas = { clientHeight: 852 } as any;
  // 2556 物理像素 → 852 × 2 = 1704
  expect(viewer._lodScreenHeight(2556)).toBe(1704);
  // 物理像素本来就低于上限时保持不动
  expect(viewer._lodScreenHeight(1200)).toBe(1200);
});

test('离屏 canvas（没有布局尺寸）时退回物理像素口径，不能把高度算成 0', () => {
  const viewer = new S3MViewer({ lodPixelRatioCap: 2 }) as any;
  viewer.canvas = { clientHeight: 0 } as any;
  expect(viewer._lodScreenHeight(2556)).toBe(2556);
  viewer.canvas = null;
  expect(viewer._lodScreenHeight(2556)).toBe(2556);
});

test('setLodPixelRatioCap 可运行时开关，传非法值等价于关闭截断', () => {
  const viewer = new S3MViewer({}) as any;
  viewer.canvas = { clientHeight: 852 } as any;
  viewer.setLodPixelRatioCap(2);
  expect(viewer.lodPixelRatioCap).toBe(2);
  expect(viewer._lodScreenHeight(2556)).toBe(1704);
  viewer.setLodPixelRatioCap(Infinity);
  expect(viewer._lodScreenHeight(2556)).toBe(2556);
  viewer.setLodPixelRatioCap(0);
  expect(viewer.lodPixelRatioCap).toBe(Infinity);
});
