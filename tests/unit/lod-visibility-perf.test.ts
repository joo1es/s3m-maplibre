/**
 * 单元测试：TileVisibility 容器复用、稳定的 childUrls 缓存与 GC 抖动优化（Issue #31）
 *
 * 验证目标：
 * 1. 容器复用：`update()` 在连续帧中复用内部 Set/Map（visited, roots, nextPrimary, nextFallback, nodeDepths），
 *    每帧通过 clear() 重置，而不是每帧 new 新容器；
 * 2. 连续帧结果一致性与真实淘汰路径：通过真实 `ts._evictOne()` 淘汰中间层瓦片并改写父节点 childUrls 后，
 *    可见性递归能正确识别最新子节点，无画面缺块且多帧状态收敛；
 * 3. 零冗余数组分配：未指定 childUrls 的节点首次访问后 childUrls 被稳定归一化缓存，多帧 update 不再重复构造临时数组；
 * 4. 递归判据不产生 filter/every 临时数组：通过单步循环短路替代 filter；
 * 5. PolygonOffset 目标值一致时跳过无变化 traverse：仅在状态切换（进入/退出 fallback）或深度推移时 traverse；
 * 6. 跨瓦片共享材质正确性：多个瓦片节点共享材质时，增量细化的 fallback 与 restore 能正确维护并完全还原；
 * 7. Debug 标志未开启时零全局对象读写：__S3M_LOD_DEBUG 为 false 时不触摸 __S3M_LOD_SEEN。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { getNodeChildUrls } from '../../packages/s3m-three/src/tileset/TileVisibility';

let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => {})) as never;
});

afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  delete (globalThis as any).__S3M_LOD_DEBUG;
  delete (globalThis as any).__S3M_LOD_SEEN;
});

function createMockMesh(): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  return new THREE.Mesh(geo, mat);
}

function createMockNode(url: string, rangeValue: number, childUrls?: string[], childUrl?: string | null, parentUrl: string | null = null) {
  const group = new THREE.Group();
  const mesh = createMockMesh();
  group.add(mesh);

  return {
    url,
    tile: { geoPackage: {} },
    group,
    sphere: { center: { x: 0, y: 0, z: 0 }, radius: 100 },
    rangeValue,
    rangeMode: 1, // 屏幕像素模式
    childUrls,
    childUrl: childUrl !== undefined ? childUrl : (childUrls ? childUrls[0] ?? null : null),
    parentUrl,
    state: 'ready',
    needRefine: false,
    distance: 100,
    stats: { meshes: 1, vertices: 3, triangles: 1 },
  };
}

function createTileset(opts: any = {}): any {
  const ts = new S3MTileset({
    configUrl: 'https://example.com/ds/config',
    ...opts,
  } as any) as any;
  ts._load = () => Promise.resolve();
  return ts;
}

describe('Issue #31 - 可见性更新容器复用与 GC 抖动优化', () => {
  test('1. 容器复用：连续多帧 update() 中内部 Set/Map 引用保持稳定', () => {
    const ts = createTileset();
    const visibility = (ts as any)._visibility as any;
    expect(visibility).toBeDefined();

    const root = createMockNode('root', 50, ['c1'], null);
    const c1 = createMockNode('c1', 25, [], null, 'root');
    ts.nodes.set('root', root);
    ts.nodes.set('c1', c1);
    ts.rootUrls.push('root');

    // 第一帧
    ts.update([0, 0, 100], Math.PI / 4, 1080);
    const visitedSet = visibility._visited;
    const rootsSet = visibility._roots;
    expect(visitedSet instanceof Set).toBe(true);
    expect(rootsSet instanceof Set).toBe(true);

    // 第二帧与第三帧
    ts.update([0, 0, 100], Math.PI / 4, 1080);
    expect(visibility._visited).toBe(visitedSet);
    expect(visibility._roots).toBe(rootsSet);

    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(visibility._visited).toBe(visitedSet);
    expect(visibility._roots).toBe(rootsSet);
  });

  test('2. 真实路径淘汰父瓦片与连续多帧收敛（真实走 TileBudget._evictOne）', () => {
    // 设置 maxTiles 为 6（总共 7 块瓦片），使预算淘汰逻辑真实触发
    const ts = createTileset({ maxTiles: 6 });
    // 构建层级：R -> (N1, N2), N1 -> (L1, L2), N2 -> (L3, L4)
    const r = createMockNode('R', 10, ['N1', 'N2'], null);
    const n1 = createMockNode('N1', 20, ['L1', 'L2'], null, 'R');
    const n2 = createMockNode('N2', 20, ['L3', 'L4'], null, 'R');
    const l1 = createMockNode('L1', 40, [], null, 'N1');
    const l2 = createMockNode('L2', 40, [], null, 'N1');
    const l3 = createMockNode('L3', 40, [], null, 'N2');
    const l4 = createMockNode('L4', 40, [], null, 'N2');

    ts.rootUrls.push('R');
    for (const node of [r, n1, n2, l1, l2, l3, l4]) {
      ts.nodes.set(node.url, node);
      if (node.parentUrl) ts._parentOf.set(node.url, node.parentUrl);
    }

    // 相机近距离：全部细化，只有 L1~L4 应当显示
    ts.update([0, 0, 5], Math.PI / 4, 1080);
    expect(r.group.visible).toBe(false);
    expect(n1.group.visible).toBe(false);
    expect(n2.group.visible).toBe(false);
    expect(l1.group.visible).toBe(true);
    expect(l2.group.visible).toBe(true);
    expect(l3.group.visible).toBe(true);
    expect(l4.group.visible).toBe(true);

    // 真实走 TileBudget 的 _evictOne 路径淘汰中间层已接管父节点
    const evicted = ts._evictOne(false);
    expect(evicted).toBe(true);

    // 此时 N1 或 N2 其中一个已被真实淘汰，其子瓦已自动重挂到 R，R.childUrls 也由 evictOne 原地改写
    const victimUrl = ts.nodes.has('N1') ? 'N2' : 'N1';
    expect(ts.nodes.has(victimUrl)).toBe(false);

    // 下一帧更新：可见性递归通过 getNodeChildUrls 读取 R 最新的子节点列表，叶子瓦片必须依然全覆盖无空洞
    ts.update([0, 0, 5], Math.PI / 4, 1080);
    expect(l1.group.visible).toBe(true);
    expect(l2.group.visible).toBe(true);
    expect(l3.group.visible).toBe(true);
    expect(l4.group.visible).toBe(true);
    expect(r.group.visible).toBe(false);

    // 连续运行多帧，状态必须收敛稳定
    const c1 = ts.update([0, 0, 5], Math.PI / 4, 1080);
    const c2 = ts.update([0, 0, 5], Math.PI / 4, 1080);
    expect(c1).toBe(false);
    expect(c2).toBe(false);
  });

  test('3. getNodeChildUrls 稳定缓存：旧口径一致且不重复分配数组', () => {
    // 1) 提供了空 childUrls: [] 的节点，必须保持空数组，绝不能误取 fallback childUrl
    const emptyChildNode = createMockNode('empty_node', 50, [], 'fallback_url');
    const emptyResult = getNodeChildUrls(emptyChildNode as any);
    expect(emptyResult).toEqual([]);

    // 2) 仅提供了 childUrl，未传 childUrls 的 mock node
    const nodeWithoutChildUrls = createMockNode('test_node', 50, undefined, 'child_1');
    expect(nodeWithoutChildUrls.childUrls).toBeUndefined();

    const arr1 = getNodeChildUrls(nodeWithoutChildUrls as any);
    expect(arr1).toEqual(['child_1']);
    // 就地写回 node.childUrls
    expect(nodeWithoutChildUrls.childUrls).toBe(arr1 as any);

    const arr2 = getNodeChildUrls(nodeWithoutChildUrls as any);
    expect(arr2).toBe(arr1); // 同一个数组引用，零临时分配

    // 3) 完全无子节点且 childUrl 为 null 的情况
    const leafNode = createMockNode('leaf', 50, undefined, null);
    const leafUrls1 = getNodeChildUrls(leafNode as any);
    const leafUrls2 = getNodeChildUrls(leafNode as any);
    expect(leafUrls1).toEqual([]);
    expect(leafUrls2).toBe(leafUrls1);
  });

  test('4. incremental 模式下 polygonOffset 目标值一致时跳过 traverse', () => {
    const ts = createTileset({ lodTransition: 'incremental' });
    const pNode = createMockNode('root', 50, ['c1', 'c2'], null);
    pNode.needRefine = true;
    ts.nodes.set('root', pNode);
    ts.rootUrls.push('root');

    // 只到达 c1，c2 还在途 -> pNode 成为 fallback
    const c1 = createMockNode('c1', 25, [], null, 'root');
    ts.nodes.set('c1', c1);

    let traverseCount = 0;
    const origTraverse = pNode.group.traverse.bind(pNode.group);
    pNode.group.traverse = (cb: any) => {
      traverseCount++;
      return origTraverse(cb);
    };

    // 第一次 update：pNode 首次应用 fallback 深度偏移，必须 traverse
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(traverseCount).toBe(1);

    // 第二次 update：相机位置未变，pNode 依然为 fallback 且深度与目标偏移一致，应跳过 traverse
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(traverseCount).toBe(1); // 未增加！

    // 第三次 update：依然跳过
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(traverseCount).toBe(1); // 保持为 1

    // 当 c2 到达时，pNode 细化完成不再作为 fallback，而是恢复原始 polygonOffset
    const c2 = createMockNode('c2', 25, [], null, 'root');
    ts.nodes.set('c2', c2);

    ts.update([0, 0, 50], Math.PI / 4, 1080);
    // 退出 fallback 状态，恢复偏移 traverse 一次
    expect(traverseCount).toBe(2);

    // 下一帧更新：已处于恢复状态，且不是 fallback，不再重复 traverse
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(traverseCount).toBe(2);
  });

  test('5. Debug 标志关时，不触摸 __S3M_LOD_SEEN 全局对象', () => {
    delete (globalThis as any).__S3M_LOD_DEBUG;
    delete (globalThis as any).__S3M_LOD_SEEN;

    const ts = createTileset();
    const node = createMockNode('tile_debug', 50, [], null);
    ts.nodes.set('tile_debug', node);
    ts.rootUrls.push('tile_debug');

    ts.update([0, 0, 50], Math.PI / 4, 1080);

    // __S3M_LOD_SEEN 不应当被隐式创建
    expect((globalThis as any).__S3M_LOD_SEEN).toBeUndefined();
  });

  test('6. 跨瓦片共享材质时，incremental 模式 fallback 与 restore 正确维护且无残留', () => {
    const ts = createTileset({ lodTransition: 'incremental' });
    const sharedMat = new THREE.MeshBasicMaterial({ color: 0x123456 });
    sharedMat.polygonOffset = false;
    sharedMat.polygonOffsetFactor = 0;
    sharedMat.polygonOffsetUnits = 0;

    const makeNodeWithSharedMat = (url: string, rangeValue: number, childUrls: string[], parentUrl: string | null) => {
      const group = new THREE.Group();
      const geom = new THREE.BufferGeometry();
      const mesh = new THREE.Mesh(geom, sharedMat);
      group.add(mesh);
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
    };

    const root = makeNodeWithSharedMat('root', 50, ['c1', 'c2'], null);
    root.needRefine = true;
    ts.nodes.set('root', root);
    ts.rootUrls.push('root');

    // 只到达 c1，c2 还在途 -> root 成为 fallback
    const c1 = makeNodeWithSharedMat('c1', 25, [], 'root');
    ts.nodes.set('c1', c1);

    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(ts.fallbackNodes.has('root')).toBe(true);
    // 共享材质应用了 fallback 偏移
    expect(sharedMat.polygonOffset).toBe(true);
    expect(sharedMat.polygonOffsetFactor).not.toBe(0);

    // c2 到达 -> root 细化完成，变为 primary/hidden，偏移必须被还原
    const c2 = makeNodeWithSharedMat('c2', 25, [], 'root');
    ts.nodes.set('c2', c2);
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(ts.fallbackNodes.size).toBe(0);
    expect(sharedMat.polygonOffset).toBe(false);
    expect(sharedMat.polygonOffsetFactor).toBe(0);
    expect(sharedMat.polygonOffsetUnits).toBe(0);

    // 切回 binary 模式，验证 restoreAllPolygonOffsets 不会因材质共享或跳过导致残留
    ts.setLodTransition('binary');
    expect(sharedMat.polygonOffset).toBe(false);
    expect(sharedMat.polygonOffsetFactor).toBe(0);
    expect(sharedMat.polygonOffsetUnits).toBe(0);
  });
});
