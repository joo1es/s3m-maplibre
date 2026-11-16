import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

/**
 * Stats 真进度（issue #51）。
 *
 * 宿主画进度条需要「本屏已就绪多少 / 还欠多少」，而 `Stats` 原本只有
 * `tiles`（已落地总数）与 `loading`（在途数），拿不到分母 —— 首屏一开始
 * 两者都是 0，只能退化成时间插值。
 *
 * 口径（刻意如此，别改）：
 *   ready    = 本轮已分配显示职责的瓦片数（primary + fallback）
 *   required = ready + 在途数
 *
 * `required === ready` 等价于「这一帧没有在途」，宿主据此可以收遮罩，
 * 不必再自己写静默窗口计时器。
 *
 * 为什么不是「视锥内应该有多少块」：S3M 是懒加载，父瓦没下来就不知道
 * 子瓦存在，这个数字**原理上算不出来**。用「就绪 + 在途」是唯一精确的口径。
 */
describe('Stats 真进度：required / ready', () => {
  interface NodeSpec {
    url: string;
    childUrls?: string[];
    sphereY?: number;
    rangeValue?: number;
  }

  function makeNode(spec: NodeSpec) {
    return {
      url: spec.url,
      childUrls: spec.childUrls ?? [],
      rangeMode: 0,
      rangeValue: spec.rangeValue ?? 500,
      sphere: { center: { x: 0, y: spec.sphereY ?? 100, z: 0 }, radius: 50 },
      group: new THREE.Group(),
      state: 'ready' as const,
      stats: { meshes: 1, vertices: 10, triangles: 5, memory: 100 },
    };
  }

  function makeTileset(specs: NodeSpec[]) {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', maxTiles: 40 });
    const nodes = specs.map((s) => makeNode(s));
    for (const n of nodes) ts.nodes.set(n.url, n);
    ts.rootUrls = nodes.map((n) => n.url);
    return { ts, nodes };
  }

  test('1. 初始未 update 时两个字段都是 0，不会出现 undefined', () => {
    const { ts } = makeTileset([{ url: 'http://example.com/a.s3mb' }]);

    expect(ts.stats.ready).toBe(0);
    expect(ts.stats.required).toBe(0);
  });

  test('2. 一块就绪瓦片、无在途：ready 与 required 相等（等价于 settled）', () => {
    const { ts } = makeTileset([{ url: 'http://example.com/a.s3mb' }]);

    ts.update([0, 0, 0], Math.PI / 4, 800);

    expect(ts.stats.ready).toBe(1);
    expect(ts.stats.required).toBe(1);
    expect(ts.stats.required).toBe(ts.stats.ready);
  });

  test('3. 有在途瓦片时 required = ready + 在途数（宿主据此算进度，不会到 100%）', () => {
    const { ts } = makeTileset([{ url: 'http://example.com/a.s3mb' }]);
    ts.pending.add('http://example.com/b.s3mb');
    ts.pending.add('http://example.com/c.s3mb');

    ts.update([0, 0, 0], Math.PI / 4, 800);

    expect(ts.stats.ready).toBe(1);
    expect(ts.stats.required).toBe(3);
    // 进度 = 1/3，而不是「已加载 1 块就 100%」
    expect(ts.stats.ready / ts.stats.required).toBeCloseTo(1 / 3, 5);
  });

  test('4. 父瓦兜底 + 子瓦就绪：fallback 与 primary 都计入 ready', () => {
    const childReady = 'http://example.com/parent_child_ready.s3mb';
    const childMissing = 'http://example.com/parent_child_missing.s3mb';
    // v2 范围 2 = 一直细化，保证父瓦一定 needRefine
    const { ts } = makeTileset([
      { url: 'http://example.com/parent.s3mb', childUrls: [childReady, childMissing] },
      { url: childReady },
      { url: childMissing },
    ]);
    // 模拟「子瓦一块就绪、一块缺失」：缺失的那块还没有节点
    ts.nodes.delete(childMissing);
    // fallbackNodes 只在增量细化模式下维护（binary 模式只写 primaryNodes）
    ts.setLodTransition('incremental');

    ts.update([0, 0, 0], Math.PI / 4, 800);

    // parent 进 fallback（有子瓦缺失时仍要兜底显示），childReady 进 primary
    expect(ts.fallbackNodes.has('http://example.com/parent.s3mb')).toBe(true);
    expect(ts.primaryNodes.has(childReady)).toBe(true);
    expect(ts.stats.ready).toBe(2);
  });

  test('5. 在途清空后 required 回落到与 ready 相等（宿主可以收遮罩）', () => {
    const { ts } = makeTileset([{ url: 'http://example.com/a.s3mb' }]);
    ts.pending.add('http://example.com/b.s3mb');

    ts.update([0, 0, 0], Math.PI / 4, 800);
    expect(ts.stats.required).toBeGreaterThan(ts.stats.ready);

    ts.pending.clear();
    ts.update([0, 0, 0], Math.PI / 4, 800);
    expect(ts.stats.required).toBe(ts.stats.ready);
  });
});
