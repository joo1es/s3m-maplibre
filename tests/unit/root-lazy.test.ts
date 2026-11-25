/**
 * 根瓦片按需加载（懒根）
 *
 * 旧行为是 `for (const r of rootUrls.slice(1)) this._enqueue(r)` —— 191 个根块无条件
 * 全下发。7 个数据集 × 6 并发全挤在 openresty 的 6 条 HTTP/1.1 连接上，光根层就要
 * 三十来轮 RTT。所以按需加载是 **bug 修复**，默认开启，不是 opt-in 的新能力。
 *
 * ★ 这里曾经照抄官方 `calcPixFromCam` 做**逐块距离判定**，结果是画面碎掉：同一个
 *   视锥里，离得近的根被请求、远一点的没有，地面和楼就变成几块悬浮的孤岛（远景
 *   尤其明显，Ground 只剩一块，整块地皮消失）。官方的根块与相机尺度匹配，我们的
 *   7 个数据集 191 块按行政范围切、单块大小差几十倍，逐块判必然挑出"缺件"。
 *
 *   所以根层只保留一条判据：**视锥外不请求**。距离上的取舍交给子瓦片
 *   （`childRangeValue`）和回收（`_reclaimFarSubtiles`），那才是数量爆炸的层。
 *
 * 回收的方向也一并对齐：**只退子瓦，根层永不因距离卸载**。卸根不是"变糊"，
 * 是"这一块地面/这排楼直接不存在"。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

function makeRoots() {
  return [
    { url: 'http://example.com/near.s3mblock', center: { x: 0, y: 0, z: 0 }, radius: 100, rangeValue: 100 },
    { url: 'http://example.com/mid.s3mblock', center: { x: 0, y: 0, z: 5000 }, radius: 100, rangeValue: 100 },
    { url: 'http://example.com/far.s3mblock', center: { x: 0, y: 0, z: 20000 }, radius: 100, rangeValue: 100 },
  ];
}

function makeTileset(roots = makeRoots()) {
  // lodRangeScale 显式给 1：构造函数默认是 3.0，那会把阈值压到 K/3 ≈ 644 米，
  // 这里要验证的是判据本身，不是默认缩放。
  const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', maxTiles: 64, lodRangeScale: 1 });
  const enqueued: string[] = [];
  (ts as any)._rootCandidates = roots;
  (ts as any)._rootUrlSet = new Set(roots.map((r) => r.url));
  // 真正的 _enqueue 会做去重、写 _queue 再 _pump（发请求）；这里只记录并记账，
  // 否则 _pumpRoots 的「到底有没有被接收」判定会把所有候选都当成没进队。
  (ts as any)._enqueue = (url: string) => {
    if (enqueued.includes(url)) return;
    enqueued.push(url);
    (ts as any)._queue.push(url);
  };
  return { ts, enqueued };
}

describe('根瓦片按需加载', () => {
  test('默认开启：不传 lazyRoots 时按需判定，不是全量下发', () => {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json' });
    expect((ts as any)._lazyRoots).toBe(true);
  });

  test('视锥内的根全部请求：不能按距离逐块挑，挑剩下的就是「缺件」', () => {
    const { ts, enqueued } = makeTileset();
    // 三个都在视锥内（含 20km 外那块）。远景如果只请求最近的，画面会碎成孤岛。
    const isVisible = () => true;

    ts.update([0, 0, 500], Math.PI / 4, 800, isVisible);

    expect(enqueued.sort()).toEqual([
      'http://example.com/far.s3mblock',
      'http://example.com/mid.s3mblock',
      'http://example.com/near.s3mblock',
    ]);
    expect((ts as any)._rootCandidates.length).toBe(0);
  });

  test('视锥外的根一个都不请求：这是懒根唯一该省的部分', () => {
    const { ts, enqueued } = makeTileset();
    const isVisible = (center: { x: number }) => center.x > 0;

    ts.update([0, 0, 500], Math.PI / 4, 800, isVisible);

    expect(enqueued).toEqual([]);
    // 全部留在池里等镜头转过去，不能丢
    expect((ts as any)._rootCandidates.length).toBe(3);
  });

  test('宿主没给可见性判定时全部请求：宁可多下，也不要出现「只有几块」的缺口', () => {
    const { ts, enqueued } = makeTileset();

    ts.update([0, 0, 500], Math.PI / 4, 800);

    expect(enqueued.length).toBe(3);
  });

  test('lazyRoots: false 回到旧的全量口径（排查用，不是默认）', () => {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', lazyRoots: false });
    expect((ts as any)._lazyRoots).toBe(false);
  });
});

/* ---------------------------------------------------------------- 反向回收 */

/** 造一块「已经落地」的根瓦片，够走完 _evictTileNode */
function loadedRoot(url: string, center: { x: number; y: number; z: number }, radius: number) {
  return {
    url,
    group: new THREE.Group(),
    sphere: { center, radius },
    rangeValue: radius,
    rangeMode: 1,
    childUrl: null,
    childUrls: [] as string[],
    state: 'ready',
    stats: { meshes: 0, vertices: 0, triangles: 0, memory: 0 },
  };
}

describe('拉远回收：只退子瓦，根层保留', () => {
  test('根瓦片永不因距离卸载：卸根不是「变糊」，是画面碎成几块孤岛', () => {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', lodRangeScale: 1 });
    const roots = [
      loadedRoot('http://example.com/a.s3mblock', { x: 0, y: 0, z: 0 }, 900),
      loadedRoot('http://example.com/b.s3mblock', { x: 0, y: 3000, z: 0 }, 900),
      loadedRoot('http://example.com/c.s3mblock', { x: 0, y: 0, z: 8000 }, 900),
    ];
    for (const r of roots) ts.nodes.set(r.url, r as never);
    (ts as any)._rootUrlSet = new Set(roots.map((r) => r.url));
    (ts as any)._enqueue = () => {};
    const removed: string[] = [];
    (ts as any)._onTileRemoved = (n: { url: string }) => {
      removed.push(n.url);
    };

    // 相机 20km 外：三块的 pix 都远低于阈值，但根层必须一块都不许摘
    ts.update([0, 0, 20000], Math.PI / 4, 800);

    expect(ts.nodes.size).toBe(3);
    expect(removed).toEqual([]);
  });

  test('子瓦片出范围就退掉：这才是「拉远变糊」而不是「拉远消失」', () => {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', lodRangeScale: 1 });
    const root = loadedRoot('http://example.com/a.s3mblock', { x: 0, y: 0, z: 0 }, 900);
    const child1 = {
      ...loadedRoot('http://example.com/a_00.s3mblock', { x: 0, y: 0, z: 0 }, 300),
      parentUrl: root.url,
    };
    const child2 = {
      ...loadedRoot('http://example.com/a_01.s3mblock', { x: 100, y: 0, z: 0 }, 300),
      parentUrl: root.url,
    };

    for (const n of [root, child1, child2]) ts.nodes.set(n.url, n as never);
    (ts as any)._rootUrlSet = new Set([root.url]);
    (ts as any)._enqueue = () => {};
    const removed: string[] = [];
    (ts as any)._onTileRemoved = (n: { url: string }) => {
      removed.push(n.url);
    };

    ts.update([0, 0, 20000], Math.PI / 4, 800);

    expect(ts.nodes.has(root.url)).toBe(true);
    expect(ts.nodes.has(child1.url)).toBe(false);
    expect(ts.nodes.has(child2.url)).toBe(false);
    expect(removed.sort()).toEqual([child1.url, child2.url]);
  });

  test('候选池已空也照样回收子瓦：池子空了不代表没人管', () => {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', lodRangeScale: 1 });
    const root = loadedRoot('http://example.com/a.s3mblock', { x: 0, y: 0, z: 0 }, 900);
    const child = {
      ...loadedRoot('http://example.com/a_00.s3mblock', { x: 0, y: 0, z: 0 }, 300),
      parentUrl: root.url,
    };
    for (const n of [root, child]) ts.nodes.set(n.url, n as never);
    (ts as any)._rootUrlSet = new Set([root.url]);
    (ts as any)._rootCandidates = [];
    (ts as any)._enqueue = () => {};

    ts.update([0, 0, 20000], Math.PI / 4, 800);

    expect(ts.nodes.size).toBe(1);
    expect(ts.nodes.has(root.url)).toBe(true);
  });

  test('临界距离上不抖动：回收阈值比加载更严格，落在同一侧就不动', () => {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', lodRangeScale: 1 });
    // 半径 100、距离 2100：pix = 1931×100/2100 = 92，
    // 回收判据是 pix <= 100×0.8 = 80 —— 92 > 80，所以既不该装也不该卸。
    const root = loadedRoot('http://example.com/a.s3mblock', { x: 0, y: 0, z: 0 }, 900);
    const child = {
      ...loadedRoot('http://example.com/a_00.s3mblock', { x: 0, y: 0, z: 0 }, 100),
      parentUrl: root.url,
    };
    ts.nodes.set(root.url, root as never);
    ts.nodes.set(child.url, child as never);
    (ts as any)._rootUrlSet = new Set([root.url]);
    (ts as any)._enqueue = () => {};

    ts.update([0, 0, 2100], Math.PI / 4, 800);

    expect(ts.nodes.size).toBe(2);
  });

  test('子树必须整棵摘：父被回收后子瓦不能变成「无父的根」继续画', () => {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', lodRangeScale: 1 });
    const root = loadedRoot('http://example.com/a.s3mblock', { x: 0, y: 0, z: 0 }, 900);
    const child = {
      ...loadedRoot('http://example.com/a_00.s3mblock', { x: 0, y: 0, z: 0 }, 300),
      parentUrl: root.url,
    };
    // grand 自身判据说「我还很该画」（rangeValue 故意给得很小），
    // 但它挂在已出范围的 child 下面 —— 必须跟着一起摘。
    const grand = {
      ...loadedRoot('http://example.com/a_0000.s3mblock', { x: 0, y: 0, z: 0 }, 1500),
      rangeValue: 1,
      parentUrl: child.url,
    };

    for (const n of [root, child, grand]) ts.nodes.set(n.url, n as never);
    (ts as any)._rootUrlSet = new Set([root.url]);
    (ts as any)._enqueue = () => {};
    const removed: string[] = [];
    (ts as any)._onTileRemoved = (n: { url: string }) => {
      removed.push(n.url);
    };

    ts.update([0, 0, 20000], Math.PI / 4, 800);

    expect(ts.nodes.has(root.url)).toBe(true);
    expect(removed).toContain(child.url);
    expect(removed).toContain(grand.url);
  });
});
