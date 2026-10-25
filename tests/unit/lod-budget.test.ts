/**
 * 回归测试：瓦片预算的裁剪时机与选择规则（make-before-break）
 *
 * 旧策略错在两处（用户指出）：
 *   1. 为了塞新瓦片，在「新的还没下载完」时就把旧的删掉 → 画面立刻开洞；
 *   2. 洞下一帧又要回补 → 「删 → 补 → 再删」无限循环 = 屏幕不停闪烁。
 *
 * 新策略：
 *   - 入队时不淘汰，只受硬上限（maxTiles + 余量）约束请求量；
 *   - 淘汰统一放在 update() 末尾、可见性分配完之后：此时「谁负责显示这块地」已确定；
 *   - 只踢「当前不显示」或「位置已被可见子瓦接手」的瓦片；挑不出安全候选就允许暂时超额。
 */
import { afterEach, expect, test } from 'bun:test';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

let realFetch: typeof globalThis.fetch;
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
});

function mk(maxTiles: number, maxConcurrent: number) {
  realFetch = globalThis.fetch;
  // fetch 永不 resolve：只观察调度器的记账，不掺入真实加载
  globalThis.fetch = (() => new Promise(() => {})) as never;
  return new S3MTileset({
    configUrl: 'https://example.com/ds/config',
    maxTiles,
    maxConcurrent,
    buildTile: (async () => ({ group: null, stats: {} })) as never,
    onError: () => {},
  }) as any;
}

const node = (url: string, opts: Partial<{ visible: boolean; children: string[]; parent: string | null }> = {}) => ({
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
  lastSeen: 0,
  distance: 0,
});

test('入队不再踢正在显示、无人接手的瓦片（宁可暂时超额，也不开洞）', () => {
  const ts = mk(2, 1);
  const removed: string[] = [];
  ts._onTileRemoved = (n: any) => removed.push(n.url);
  ts.nodes.set('a', node('a'));
  ts.nodes.set('b', node('b'));

  ts._enqueue('c');
  expect(removed).toEqual([]); // 关键：没有为了塞 c 而删掉正在显示的块
  expect(ts.nodes.size).toBe(2);
});

test('请求量仍受硬上限约束：队列+在途+驻留不会无限膨胀', () => {
  for (const maxConcurrent of [1, 2, 4, 8]) {
    const ts = mk(4, maxConcurrent);
    for (let i = 0; i < 60; i++) ts._enqueue(`t${i}`);
    const total = ts.nodes.size + ts.pending.size + ts._queue.length;
    expect(total).toBeLessThanOrEqual(ts.hardCap);
    // 硬上限必须比软上限宽，否则又回到「边加载边删」
    expect(ts.hardCap).toBeGreaterThan(4);
  }
});

test('裁预算发生在 update() 之后，且只裁「不显示」或「已被子瓦接手」的', () => {
  const ts = mk(2, 1);
  const removed: string[] = [];
  ts._onTileRemoved = (n: any) => removed.push(n.url);
  // 三块都驻留，超出 maxTiles=2
  ts.rootUrls.push('show');
  ts.nodes.set('show', node('show', { visible: true }));
  ts.nodes.set('hidden', node('hidden', { visible: false }));
  // covered：父瓦不显示，子瓦在显示 → 父瓦是安全候选
  ts.nodes.set('cov', node('cov', { visible: false, children: ['covc'] }));
  ts.nodes.set('covc', node('covc', { visible: true, parent: 'cov' }));

  ts._trimBudget();
  // 先裁不显示/已被接手的，绝不裁 show
  expect(removed).not.toContain('show');
  expect(ts.nodes.has('show')).toBe(true);
  expect(removed.length).toBeGreaterThan(0);
});

test('没有安全候选时允许暂时超额，而不是把画面裁空', () => {
  const ts = mk(1, 1);
  const removed: string[] = [];
  ts._onTileRemoved = (n: any) => removed.push(n.url);
  ts.rootUrls.push('r1', 'r2');
  ts.nodes.set('r1', node('r1'));
  ts.nodes.set('r2', node('r2'));

  ts._trimBudget();
  expect(removed).toEqual([]); // 两块都在显示且没人接手 → 一块都不能踢
  expect(ts.nodes.size).toBe(2);
});

test('父瓦被淘汰后，子孙必须还能显示（不能整片消失）', () => {
  const ts = mk(100, 4);
  ts.rootUrls.push('R');
  ts.nodes.set('R', node('R', { children: ['A', 'B'] }));
  ts.nodes.set('A', node('A', { parent: 'R' }));
  ts.nodes.set('B', node('B', { parent: 'R' }));
  ts._parentOf.set('A', 'R');
  ts._parentOf.set('B', 'R');

  ts.update([0, 0, 5], 0.6, 1080);
  expect(ts.nodes.get('R').group.visible).toBe(false); // 子瓦已就绪 → R 交棒
  expect(ts.nodes.get('A').group.visible).toBe(true);

  // R 被淘汰：A/B 变成无父，必须仍然显示（修复前会被「游离瓦片一律隐藏」一起抹掉）
  ts.nodes.delete('R');
  ts.update([0, 0, 5], 0.6, 1080);
  expect(ts.nodes.get('A').group.visible).toBe(true);
  expect(ts.nodes.get('B').group.visible).toBe(true);
});
