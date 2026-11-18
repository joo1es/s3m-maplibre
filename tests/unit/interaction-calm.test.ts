/**
 * 手势期间「静默」策略的单测（smart-city 体验专项）。
 *
 * 三条要钉住的行为：
 *
 * 1. **`pauseRefine` 冻结新请求**：`TileVisibility.update()` 里唯一的入队点是
 *    `host.enqueue()`，一帧里它可能连着排几十个。拖拽时这些请求会和宿主渲染抢
 *    主线程 —— 越拖越卡，松手才恢复。这是新增能力，默认关闭（不变式①）。
 * 2. **纯策略、不动画面**：冻结的是「要不要为新瓦片入队」，已经落地的瓦片、
 *    可见性判定、淘汰预算都不受影响。否则拖到一半画面会开洞。
 * 3. **淡入可以跳过**：`startTileFade` 在手势期间直接显示，不注册动画通道 ——
 *    否则一批瓦片各自从 0 淡到 1，几百毫秒里满屏碎块各自呼吸。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { TileRegistry } from '../../packages/s3m-three/src/render/viewer/TileRegistry';

/* ------------------------------------------------------------------ 瓦片树桩 */

function mockNode(url: string, rangeValue: number, childUrls: string[], parentUrl: string | null = null) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
  return {
    url,
    tile: { geoPackage: {} },
    group,
    sphere: { center: { x: 0, y: 0, z: 0 }, radius: 100 },
    rangeValue,
    rangeMode: 1,
    childUrls,
    childUrl: childUrls[0] ?? null,
    parentUrl,
    state: 'ready',
    needRefine: false,
    distance: 100,
    stats: { meshes: 1, vertices: 3, triangles: 1 },
  };
}

function makeTileset(): any {
  const ts = new S3MTileset({ configUrl: 'https://example.com/ds/config' } as any) as any;
  ts._load = () => Promise.resolve();
  return ts;
}

/** 一棵「相机贴近 → 根瓦该细化」的最小树：root 有子瓦 c1，但 c1 还没落地 */
function treeWithRefinableRoot(): any {
  const ts = makeTileset();
  const root = mockNode('root', 50, ['c1']);
  ts.nodes.set('root', root);
  ts.rootUrls.push('root');
  return ts;
}

/**
 * 把入队拦在 `_enqueue` 上记账。
 * 不去看 `pending` / `_queue`：`_pump` 是异步的，同步断言时 URL 已经离开队列、
 * 还没进 pending，看到的是 0 —— 那不是「没入队」，是「还没走到那一步」。
 */
function spyEnqueue(ts: any): string[] {
  const calls: string[] = [];
  ts._enqueue = (url: string | null) => {
    if (!url) return;
    calls.push(url);
    // 记得占住「在途」：否则下一帧同一块会被当成没排过，重复入队
    ts.pending.add(url);
  };
  return calls;
}

/* ------------------------------------------------------------------ 1. pauseRefine */

describe('TileVisibility — pauseRefine', () => {
  test('默认不暂停：需要细化时照常入队（旧行为逐字不变）', () => {
    const ts = treeWithRefinableRoot();
    const calls = spyEnqueue(ts);
    ts.update([0, 0, 5], Math.PI / 4, 1080);
    expect(calls).toEqual(['c1']);
  });

  test('pauseRefine 为 true 时不新建任何请求', () => {
    const ts = treeWithRefinableRoot();
    const calls = spyEnqueue(ts);
    ts.update([0, 0, 5], Math.PI / 4, 1080, undefined, { pauseRefine: true });
    expect(calls).toEqual([]);
  });

  test('恢复后下一帧补上，不需要额外通知', () => {
    const ts = treeWithRefinableRoot();
    const calls = spyEnqueue(ts);
    ts.update([0, 0, 5], Math.PI / 4, 1080, undefined, { pauseRefine: true });
    expect(calls).toEqual([]);
    ts.update([0, 0, 5], Math.PI / 4, 1080);
    expect(calls).toEqual(['c1']);
  });

  test('暂停时可见性判定不受影响：已落地的瓦片照常显示', () => {
    const ts = treeWithRefinableRoot();
    const c1 = mockNode('c1', 25, [], 'root');
    ts.nodes.set('c1', c1);
    spyEnqueue(ts);
    ts.update([0, 0, 5], Math.PI / 4, 1080, undefined, { pauseRefine: true });
    expect(c1.group.visible).toBe(true);
  });

  test('maxEnqueuePerFrame 给单帧入队数封顶（治「一停就狂加载」）', () => {
    const ts = makeTileset();
    const root = mockNode('root', 50, ['c1', 'c2', 'c3', 'c4', 'c5']);
    ts.nodes.set('root', root);
    ts.rootUrls.push('root');
    const calls = spyEnqueue(ts);

    ts.update([0, 0, 5], Math.PI / 4, 1080, undefined, { maxEnqueuePerFrame: 2 });
    expect(calls).toEqual(['c1', 'c2']);

    // 下一帧继续补，不会因为上一帧的配额丢掉剩下的
    ts.update([0, 0, 5], Math.PI / 4, 1080, undefined, { maxEnqueuePerFrame: 2 });
    expect(calls).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  test('不传 maxEnqueuePerFrame 时一帧全排（旧行为不变）', () => {
    const ts = makeTileset();
    const root = mockNode('root', 50, ['c1', 'c2', 'c3']);
    ts.nodes.set('root', root);
    ts.rootUrls.push('root');
    const calls = spyEnqueue(ts);
    ts.update([0, 0, 5], Math.PI / 4, 1080);
    expect(calls).toEqual(['c1', 'c2', 'c3']);
  });
});

/* ------------------------------------------------------------------ 2. 淡入跳过 */

/** TileRegistry.startTileFade 只碰这几处宿主成员，桩够用 */
function fadeHost(opts: { fadeIn: number; interacting: boolean; calm: boolean }) {
  const registered: string[] = [];
  return {
    registered,
    host: {
      style: { fadeIn: opts.fadeIn, depthWrite: true },
      animator: {
        register: (k: string) => registered.push(k),
        unregister: () => {},
        to: () => {},
      },
      nextTileFadeSeq: () => 1,
      opacityTransparent: () => false,
      requestRepaint: () => {},
      featureStyles: { applyOverridesToMesh: () => {} },
      // 本测试关心的两个宿主查询
      interacting: () => opts.interacting,
      calmWhileInteracting: () => opts.calm,
    },
  };
}

function fadeMaterial() {
  return {
    userData: { uTileFade: { value: 0 } },
    transparent: false,
    depthWrite: true,
  } as any;
}

describe('TileRegistry.startTileFade — 手势期间直接显示', () => {
  const mesh = { userData: {} } as any;

  test('不在手势中：照常注册淡入通道', () => {
    const { host, registered } = fadeHost({ fadeIn: 900, interacting: false, calm: true });
    const mat = fadeMaterial();
    new TileRegistry(host as any).startTileFade(mesh, mat);
    expect(registered.length).toBe(1);
    expect(mat.userData.uTileFade.value).toBe(0);
  });

  test('手势中 + 开启静默：不注册通道，直接不透明', () => {
    const { host, registered } = fadeHost({ fadeIn: 900, interacting: true, calm: true });
    const mat = fadeMaterial();
    new TileRegistry(host as any).startTileFade(mesh, mat);
    expect(registered.length).toBe(0);
    expect(mat.userData.uTileFade.value).toBe(1);
  });

  test('手势中但没开静默：保持旧行为（不变式①）', () => {
    const { host, registered } = fadeHost({ fadeIn: 900, interacting: true, calm: false });
    const mat = fadeMaterial();
    new TileRegistry(host as any).startTileFade(mesh, mat);
    expect(registered.length).toBe(1);
  });

  test('fadeIn 为 0 时不注册，也不碰材质（原有语义）', () => {
    const { host, registered } = fadeHost({ fadeIn: 0, interacting: false, calm: true });
    const mat = fadeMaterial();
    new TileRegistry(host as any).startTileFade(mesh, mat);
    expect(registered.length).toBe(0);
    expect(mat.userData.uTileFade.value).toBe(0);
  });
});

/* ------------------------------------------------------------------ 3. S3MViewer 状态 */

describe('S3MViewer — 静默开关默认开启', () => {
  // 默认值在 0.4.x 从 false 改成 true：动画/交互优先。
  // 旧默认是「先做功能、没考虑手感」的产物，拖拽时继续细化会直接抢渲染线程。
  test('不传选项时 calmWhileInteracting 为 true，interacting 仍为 false', async () => {
    const { S3MViewer } = await import('../../packages/s3m-three/src/render/S3MViewer');
    const v = new S3MViewer({} as any);
    expect(v.calmWhileInteracting).toBe(true);
    expect(v.interacting).toBe(false);
  });

  test('显式传 false 可以退回旧行为（边拖边细化）', async () => {
    const { S3MViewer } = await import('../../packages/s3m-three/src/render/S3MViewer');
    const v = new S3MViewer({ calmWhileInteracting: false } as any);
    expect(v.calmWhileInteracting).toBe(false);
  });

  test('显式传入 true 仍为 true', async () => {
    const { S3MViewer } = await import('../../packages/s3m-three/src/render/S3MViewer');
    const v = new S3MViewer({ calmWhileInteracting: true } as any);
    expect(v.calmWhileInteracting).toBe(true);
  });

  test('setInteracting 可切换，且不改变其它开关', async () => {
    const { S3MViewer } = await import('../../packages/s3m-three/src/render/S3MViewer');
    const v = new S3MViewer({ calmWhileInteracting: true } as any);
    v.setInteracting(true);
    expect(v.interacting).toBe(true);
    v.setInteracting(false);
    expect(v.interacting).toBe(false);
    expect(v.cullRefine).toBe(false);
  });
});
