/**
 * 细化判定用的是**子瓦片**的 rangeValue，不是当前这块的
 *
 * 区间语义：一块瓦片声明的 rangeValue 是「它自己在什么范围内值得画」。
 * 所以「要不要往下一层细化」= 「子瓦片该不该出现」，必须拿子瓦片的阈值判。
 *
 * 实测 `6_01.s3mblock`（Project 里的真实数据）：
 *   组0 6_01      rv=586.8  r=293.4  child=6_0100
 *   组1 6_0100    rv=1024.0 r=293.4  child=6_010000
 *
 *   H=1080 时 pix = 2607 × r / dist
 *   用父判：pix > 586.8 → dist < 1303m 就开始细化
 *   用子判：pix > 1024  → dist < 747m  才细化
 *
 * 差这 1.74 倍就是「官方拉得很近才加载子瓦片、我们 1.3km 外就提前拉一批」的来源。
 * 官方做法是遍历 `_childrenPageLod` 时逐个调 `calcPixFromCam`，用子节点自己的
 * `rangeList` 判 `_isLessLodDis`。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

/** 6_01 的真实几何参数 */
const R = 293.4;
const SELF_RV = 586.8;
const CHILD_RV = 1024;

function makeNode(url: string, extra: Record<string, unknown> = {}) {
  return {
    url,
    childUrls: [`${url}-child`],
    childUrl: `${url}-child`,
    rangeMode: 1, // PIXEL_SIZE_ON_SCREEN
    rangeValue: SELF_RV,
    sphere: { center: { x: 0, y: 0, z: 0 }, radius: R },
    group: new THREE.Group(),
    state: 'ready',
    stats: { meshes: 0, vertices: 0, triangles: 0, memory: 0 },
    ...extra,
  };
}

function makeTileset(nodes: ReturnType<typeof makeNode>[]) {
  const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', lodRangeScale: 1 });
  (ts as any)._enqueue = () => {};
  for (const n of nodes) ts.nodes.set(n.url, n as never);
  return ts;
}

describe('细化阈值取子瓦片的 rangeValue', () => {
  test('1km 外：用父阈值会细化，用子阈值不会 —— 这一档就是「官方保守得多」', () => {
    // 同一个相机位置，两个节点只差 childRangeValue
    const withChildRv = makeNode('http://example.com/a', { childRangeValue: CHILD_RV });
    const legacy = makeNode('http://example.com/b');

    const ts = makeTileset([withChildRv, legacy]);
    ts.update([0, 0, 1000], Math.PI / 4, 1080);

    // pix = 2607 × 293.4 / 1000 ≈ 765：过了 586.8，但没到 1024
    expect(legacy.needRefine).toBe(true);
    expect(withChildRv.needRefine).toBe(false);
  });

  test('700m 内两块都细化：子阈值也过了', () => {
    const withChildRv = makeNode('http://example.com/a', { childRangeValue: CHILD_RV });
    const legacy = makeNode('http://example.com/b');

    const ts = makeTileset([withChildRv, legacy]);
    ts.update([0, 0, 700], Math.PI / 4, 1080);

    // pix ≈ 1093 > 1024
    expect(legacy.needRefine).toBe(true);
    expect(withChildRv.needRefine).toBe(true);
  });

  test('没有 childRangeValue 时回退到自身 rangeValue：老数据与单测构造的节点行为不变', () => {
    const n = makeNode('http://example.com/a');
    const ts = makeTileset([n]);
    ts.update([0, 0, 1000], Math.PI / 4, 1080);
    expect(n.needRefine).toBe(true);
  });

  test('childRangeValue 为 0 / 负数时同样回退，不会把细化锁死', () => {
    for (const bad of [0, -1, Number.NaN]) {
      const n = makeNode('http://example.com/a', { childRangeValue: bad });
      const ts = makeTileset([n]);
      ts.update([0, 0, 1000], Math.PI / 4, 1080);
      expect(n.needRefine, `childRangeValue=${bad} 应该回退`).toBe(true);
    }
  });

  test('lastSeen 仍然按自身 rangeValue 算：别把「在不在用」和「要不要细化」混成一个量', () => {
    const n = makeNode('http://example.com/a', { childRangeValue: CHILD_RV });
    const ts = makeTileset([n]);
    ts.update([0, 0, 1000], Math.PI / 4, 1080);

    // 自身阈值 586.8：inRange 判 metric > threshold × 0.5 = 293.4，765 > 293.4 成立
    expect(n.lastSeen).toBe((ts as any)._frame);
  });
});
