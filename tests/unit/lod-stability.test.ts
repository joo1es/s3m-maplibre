/**
 * LOD 稳定性仿真（可判定，不靠猜）：
 * 合成一棵四叉树，模拟滚轮由远及近改视距，逐档观察可见集合。
 *
 * 三条不变量：
 *   1. 静止相机下必须收敛 —— 连续几帧的可见集合不许变来变去（= 闪烁）；
 *   2. 由远及近时，一块瓦片的可见性只能「显示 → 被子瓦接替后隐藏」，不得回翻；
 *   3. 任何一档视距都至少有一块可见瓦片（不许空场）。
 */
import { afterEach, expect, test } from 'bun:test';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

let realFetch: typeof globalThis.fetch;
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
});

/** 合成瓦片树：每块 4 个子瓦，半径与 rangeValue 逐层减半 */
interface Sim {
  ts: any;
  add: (url: string, center: [number, number, number], radius: number, rangeValue: number, children: string[], parent: string | null) => void;
}

function mkSim(maxTiles: number): Sim {
  realFetch = globalThis.fetch;
  // 树是手工造的，不需要真的下载；卡死 fetch 以免测试里混进网络
  globalThis.fetch = (() => new Promise(() => {})) as never;
  const ts = new S3MTileset({
    configUrl: 'https://example.com/ds/config',
    maxTiles,
    buildTile: (async () => ({ group: null, stats: {} })) as never,
    onError: () => {},
  }) as any;
  return {
    ts,
    add(url, center, radius, rangeValue, children, parent) {
      ts.nodes.set(url, {
        url,
        tile: { geoPackage: {} },
        group: { visible: false, parent: null },
        sphere: { center: { x: center[0], y: center[1], z: center[2] }, radius },
        rangeValue,
        rangeMode: 1,
        childUrls: children,
        childUrl: children[0] ?? null,
        parentUrl: parent,
        state: 'ready',
        lastSeen: 0,
      });
      if (parent) ts._parentOf.set(url, parent);
    },
  };
}

/** 造一棵 3 层四叉树：R → 4 → 16，共 21 块 */
function buildQuadTree(sim: Sim, rootUrl = 'R'): string[] {
  const all: string[] = [];
  const rec = (url: string, cx: number, cy: number, radius: number, rangeValue: number, depth: number, parent: string | null) => {
    all.push(url);
    if (depth === 0) {
      sim.add(url, [cx, cy, 0], radius, rangeValue, [], parent);
      return;
    }
    const kids = [`${url}a`, `${url}b`, `${url}c`, `${url}d`];
    sim.add(url, [cx, cy, 0], radius, rangeValue, kids, parent);
    const q = radius / 2;
    rec(kids[0], cx - q, cy - q, q, rangeValue / 2, depth - 1, url);
    rec(kids[1], cx + q, cy - q, q, rangeValue / 2, depth - 1, url);
    rec(kids[2], cx - q, cy + q, q, rangeValue / 2, depth - 1, url);
    rec(kids[3], cx + q, cy + q, q, rangeValue / 2, depth - 1, url);
  };
  rec(rootUrl, 0, 0, 50, 1, 2, null);
  return all;
}

const visibleSet = (ts: any) =>
  [...ts.nodes.values()].filter((n: any) => n.group.visible).map((n: any) => n.url).sort().join(',');

const CAM_FOV = (60 * Math.PI) / 180;

test('不变量 1：静止相机连续 8 帧，可见集合必须收敛（不抖）', () => {
  const sim = mkSim(100);
  buildQuadTree(sim);
  sim.ts.rootUrls.push('R');

  const seen: string[] = [];
  for (let frame = 0; frame < 8; frame++) {
    sim.ts.update([0, 0, 60], CAM_FOV, 1080);
    seen.push(visibleSet(sim.ts));
  }
  // 第 3 帧之后必须完全稳定
  const tail = seen.slice(3);
  expect(new Set(tail).size).toBe(1);
});

test('不变量 2：由远及近扫 24 档，每块瓦片的可见性不得回翻', () => {
  const sim = mkSim(100);
  const all = buildQuadTree(sim);
  sim.ts.rootUrls.push('R');

  const flips = new Map<string, number>(); // url → 可见性翻转次数
  const wasVisible = new Map<string, boolean>();
  for (const url of all) wasVisible.set(url, false);

  for (let i = 0; i < 24; i++) {
    const dist = 2000 * Math.pow(0.75, i); // 滚轮逐档拉近
    sim.ts.update([0, 0, dist], CAM_FOV, 1080);
    sim.ts.update([0, 0, dist], CAM_FOV, 1080); // 同档两帧，等它稳定
    for (const url of all) {
      const now = !!sim.ts.nodes.get(url)?.group.visible;
      if (now !== wasVisible.get(url)) {
        flips.set(url, (flips.get(url) ?? 0) + 1);
        wasVisible.set(url, now);
      }
    }
  }

  // 只允许 0→1（首次显示）和 1→0（被子瓦接替）各一次；超过 1 次就是回翻=闪烁
  const bad = [...flips.entries()].filter(([, n]) => n > 1);
  expect(bad).toEqual([]);
});

test('不变量 3：任何一档视距都不许空场', () => {
  const sim = mkSim(100);
  sim.ts.rootUrls.push('R');
  buildQuadTree(sim);

  for (let i = 0; i < 24; i++) {
    const dist = 2000 * Math.pow(0.75, i);
    sim.ts.update([0, 0, dist], CAM_FOV, 1080);
    sim.ts.update([0, 0, dist], CAM_FOV, 1080);
    const vis = [...sim.ts.nodes.values()].filter((n: any) => n.group.visible);
    expect(vis.length, `视距 ${dist.toFixed(1)}m 时空场`).toBeGreaterThan(0);
  }
});

test('不变量 4：预算吃紧时静止相机也必须收敛，不能反复淘汰/回补', () => {
  const sim = mkSim(8); // 树有 21 块，预算只有 8
  buildQuadTree(sim);
  sim.ts.rootUrls.push('R');

  const series: string[] = [];
  let evictions = 0;
  sim.ts._onTileRemoved = () => {
    evictions++;
  };
  for (let frame = 0; frame < 10; frame++) {
    sim.ts.update([0, 0, 20], CAM_FOV, 1080);
    series.push(visibleSet(sim.ts));
  }
  const tail = series.slice(5);
  expect(new Set(tail).size).toBe(1);
  // 收敛之后不该还在持续淘汰
  const before = evictions;
  for (let frame = 0; frame < 5; frame++) sim.ts.update([0, 0, 20], CAM_FOV, 1080);
  expect(evictions).toBe(before);
});

test('不变量 5：共享子瓦的 LOD 图（非严格树）也不许空场', () => {
  // 同一个子瓦被两个父瓦引用时，可见性递归「先访问先决定」可能把它判在隐藏分支里，
  // 于是两条分支都不显示它 → 整片消失。兜底规则必须把它救回来。
  const sim = mkSim(100);
  const mk = (url: string, children: string[], parent: string | null) =>
    sim.add(url, [0, 0, 0], 50, 1, children, parent);

  sim.ts.rootUrls.push('P1', 'P2');
  mk('P1', ['S'], null);
  mk('P2', ['S'], null);
  mk('S', [], 'P1');
  (sim.ts as any)._parentOf.set('S', 'P1');

  // 相机极近 → 两个父瓦都想细化；S 只有一个，被先访问的分支判为「已接手」后
  // 另一条分支的父瓦会被隐藏，S 又已显示 → 不该出现零可见
  sim.ts.update([0, 0, 2], 0.6, 1080);
  const vis = [...sim.ts.nodes.values()].filter((n: any) => n.group.visible);
  expect(vis.length).toBeGreaterThan(0);
});

test('不变量 6：预算小于工作集时，可见集合不得塌成空', () => {
  const sim = mkSim(3); // 21 块树，预算只给 3
  buildQuadTree(sim);
  sim.ts.rootUrls.push('R');

  for (let frame = 0; frame < 12; frame++) {
    sim.ts.update([0, 0, 6], 0.6, 1080);
    const vis = [...sim.ts.nodes.values()].filter((n: any) => n.group.visible);
    expect(vis.length, `第 ${frame + 1} 帧空场`).toBeGreaterThan(0);
  }
});
