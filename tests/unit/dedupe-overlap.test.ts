/**
 * 数据自重叠（同单体共面重复三角形）的剔除。
 *
 * 背景：`3D-BIMbuilding-2` 的文件里真实存在重复面，按 4 位小数（0.1 mm）统计：
 *
 *   Tile_-85071_248749_0000  geo E2BF30  1276 / 6241 条重复（同 batch）
 *                            geo E2F8F0  2276 / 7156 条重复（同 batch）
 *   Tile_-85071_248750_0000  geo 386340    58 /  156 条重复（全部跨 batch）
 *
 * 同 batch 的重复是两个完全一样的三角形压在一起，深度值只差最后几位，
 * 深度缓冲分不出前后 → 斜向摩尔纹；这就是「模型重叠的斜线」。
 *
 * 这里钉住四件事：
 *   1. 同 batch、同位置、同绕向 → 只保留一条；
 *   2. 同位置但跨 batch → 两条都留（丢任何一个都会让那个 SMID 不可见/不可拾取）；
 *   3. 同位置但绕向相反（双面片）→ 两条都留；
 *   4. 距离超过量化步长的面不能被误判成重复。
 */
import { describe, expect, test } from 'bun:test';
import { assembleTileGeometry, dropCoincidentTriangles } from '../../packages/s3m-three/src/core/TileGeometry';
import type { ParsedTile } from '../../packages/s3m-three/src/core/types';

const f32 = (arr: number[]) => new Uint8Array(new Float32Array(arr).buffer);

/** 每 3 个数一个顶点；triangles 是顶点下标三元组 */
const positions = (verts: number[]) => new Float32Array(verts);
const idx = (arr: number[]) => new Uint16Array(arr);

describe('dropCoincidentTriangles', () => {
  const P = positions([
    0, 0, 0, 1, 0, 0, 0, 1, 0, // 三角形 A
    0, 0, 0, 1, 0, 0, 0, 1, 0, // 与 A 完全重合（同绕向）
    2, 0, 0, 3, 0, 0, 2, 1, 0, // 另一处
  ]);

  test('同位置同绕向：只留一条', () => {
    const { index, dropped } = dropCoincidentTriangles(idx([0, 1, 2, 3, 4, 5, 6, 7, 8]), P, null);
    expect(dropped).toBe(1);
    expect(index.length).toBe(6);
    expect(Array.from(index)).toEqual([0, 1, 2, 6, 7, 8]);
  });

  test('顶点顺序换一个起点仍算同一条（绕向未变）', () => {
    const { dropped } = dropCoincidentTriangles(idx([0, 1, 2, 4, 5, 3]), P, null);
    expect(dropped).toBe(1);
  });

  test('同位置但跨 batch：两条都留（否则有个 SMID 会消失）', () => {
    const batch = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    const { dropped } = dropCoincidentTriangles(idx([0, 1, 2, 3, 4, 5, 6, 7, 8]), P, batch);
    expect(dropped).toBe(0);
  });

  test('同位置但绕向相反（双面片）：两条都留', () => {
    const { dropped } = dropCoincidentTriangles(idx([0, 1, 2, 3, 5, 4]), P, null);
    expect(dropped).toBe(0);
  });

  test('相距 5 mm 的面不算重复（量化步长 1 mm）', () => {
    const Q = positions([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0.005, 1, 0, 0.005, 0, 1, 0.005,
    ]);
    const { dropped } = dropCoincidentTriangles(idx([0, 1, 2, 3, 4, 5]), Q, null);
    expect(dropped).toBe(0);
  });

  test('没有索引数据时原样返回', () => {
    const { index, dropped } = dropCoincidentTriangles(idx([]), P, null);
    expect(dropped).toBe(0);
    expect(index.length).toBe(0);
  });
});

/* ------------------------------------------------------------ 规模与引用语义 */

describe('dropCoincidentTriangles 的规模与引用语义', () => {
  const P = positions([
    0, 0, 0, 1, 0, 0, 0, 1, 0, // 三角形 A
    0, 0, 0, 1, 0, 0, 0, 1, 0, // 与 A 完全重合（同绕向）
    2, 0, 0, 3, 0, 0, 2, 1, 0, // 另一处
  ]);

  /**
   * 真实瓦片的量级（`3D-BIMbuilding-2` 单 geo 7156 三角形、2276 条重复）。
   * 只有 2 个三角形的用例覆盖不到「绕向归一化在大量不同起点下是否一致」。
   */
  test('7156 三角形、1/3 重复：恰好丢掉重复的那些，剩下的顺序与绕向不变', () => {
    const tris = 7156;
    const verts = tris * 3;
    const pos = new Float32Array(verts * 3);
    const index = new Uint32Array(verts);
    // 每 3 个三角形里有 1 个是前一个的副本（起点轮转，绕向不变）
    for (let t = 0; t < tris; t++) {
      const src = t - (t % 3);
      const shift = t % 3;
      for (let k = 0; k < 3; k++) {
        const v = t * 3 + k;
        const s = src * 3 + ((k + shift) % 3); // 副本换起点
        index[v] = v;
        pos[v * 3] = s * 0.37;
        pos[v * 3 + 1] = s * 0.11;
        pos[v * 3 + 2] = s * 0.53;
      }
    }
    const { index: out, dropped } = dropCoincidentTriangles(index, pos, null);
    // 2385 个完整组 × 每组丢 2 条；最后一组只剩 1 条，没有重复可丢
    const groups = Math.floor(tris / 3);
    expect(dropped).toBe(groups * 2);
    expect(out.length).toBe((tris - dropped) * 3);
    // 保留下来的第一条必须是原始的第一条（不是副本），顺序不能被打乱
    expect(Array.from(out.subarray(0, 3))).toEqual([0, 1, 2]);
  });

  /**
   * 没有重复时必须**原样返回入参引用**：这是零拷贝路径。
   * 不锁住的话，将来有人改成"总是 copy 一份"，每个瓦片都会白付一次全量分配。
   */
  test('没有重复时返回同一个数组对象（零拷贝）', () => {
    const index = idx([0, 1, 2, 6, 7, 8]);
    const { index: out, dropped } = dropCoincidentTriangles(index, P, null);
    expect(dropped).toBe(0);
    expect(out).toBe(index);
  });

  /**
   * 开关：默认开（保持现有渲染输出），显式 false 时一个循环都不跑、也不改统计。
   * 数据本身有问题、又不想让去重介入时，业务层需要一个退路。
   */
  test('dedupeCoincident: false 时不做任何剔除（stats 里也不出现 deduped）', () => {
    const { primitives, stats } = assembleTileGeometry(overlapTile(false), { dedupeCoincident: false });
    expect(stats.deduped).toBeUndefined();
    expect(primitives[0]!.indexCount).toBe(6); // 两条重合面都留着
  });

  test('不传开关时默认开启（行为与改动前一致）', () => {
    const { primitives, stats } = assembleTileGeometry(overlapTile(false));
    expect(stats.deduped).toBe(1);
    expect(primitives[0]!.indexCount).toBe(3);
  });
});

/* ------------------------------------------------------------ 组装层 */

/** 6 个顶点、2 条完全重合的三角形，可带 batchId */
function overlapTile(withBatch: boolean): ParsedTile {
  const attrs: unknown[] = [
    { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: f32([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) },
  ];
  if (withBatch) {
    attrs.push({ semantic: 'batchId', byteOffset: 0, comp: 1, dtype: 'f32', data: f32([0, 0, 0, 0, 0, 0]) });
  }
  return {
    version: 3,
    compressedType: 0,
    options: 0,
    groupNode: { pageLods: [{ geodes: [{ matrix: null, skeletonNames: ['skel0'] }] }] },
    geoPackage: {
      skel0: {
        vertexPackage: { verticesCount: 6, vertexAttributes: attrs, instanceIndex: -1 },
        indexPackages: [{ primitiveType: 4, indexCount: 6, indices: new Uint16Array([0, 1, 2, 3, 4, 5]), passNames: ['M'] }],
      },
    },
    textures: {},
    materials: { materials: [{ material: { id: 'M', textureStates: [] } }] },
    pickInfo: {},
    bytesRead: 0,
    bytesTotal: 0,
  } as unknown as ParsedTile;
}

describe('assembleTileGeometry 的重叠剔除', () => {
  test('不带 batchId：重合的两条只留一条，统计进 stats.deduped', () => {
    const { primitives, stats } = assembleTileGeometry(overlapTile(false));
    expect(primitives).toHaveLength(1);
    expect(primitives[0]!.indexCount).toBe(3);
    expect(stats.deduped).toBe(1);
  });

  test('带 batchId（同 batch）：同样剔除', () => {
    const { primitives, stats } = assembleTileGeometry(overlapTile(true));
    expect(primitives[0]!.indexCount).toBe(3);
    expect(stats.deduped).toBe(1);
  });
});
