/**
 * 泼溅排序的**结果语义**（不是实现细节）。
 *
 * `SplatSort` 从「JS 比较函数排序」换成桶排序，唯一不能变的是：
 *   1. 输出必须严格按视深**单调不降**（升序 = 远的先画，alpha 混合才正确）；
 *   2. 输出是一个排列（每个下标恰好出现一次），不能丢点、不能重复；
 *   3. 传 `out` 时复用调用方的缓冲（每帧排序不能分配）。
 *
 * 这三条与算法无关，所以测试只钉这三条 —— 将来再换排序算法也不用改测试。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { splatDepthOrder } from '../../packages/s3m-three/src/core/SplatSort';

/** 与实现同一套取值口径：视图矩阵第三行做点积 */
function depthKeys(positions: Float32Array, count: number, view: THREE.Matrix4): Float32Array {
  const e = view.elements;
  const r0 = e[2]!, r1 = e[6]!, r2 = e[10]!, r3 = e[14]!;
  const keys = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    keys[i] = r0 * positions[i * 3]! + r1 * positions[i * 3 + 1]! + r2 * positions[i * 3 + 2]! + r3;
  }
  return keys;
}

function randomPositions(count: number, seed = 1): Float32Array {
  // 确定性伪随机：测试要可复现，不用 Math.random
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const p = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) p[i] = (rnd() - 0.5) * 2000;
  return p;
}

function makeView(): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.makeRotationFromEuler(new THREE.Euler(0.3, 0.7, 0.1));
  m.setPosition(120, -40, 900);
  return m.invert();
}

describe('splatDepthOrder 的结果语义', () => {
  test('1000 个随机点：输出按视深单调不降', () => {
    const count = 1000;
    const pos = randomPositions(count);
    const view = makeView();
    const keys = depthKeys(pos, count, view);

    const order = splatDepthOrder(pos, count, view);
    expect(order.length).toBe(count);
    for (let i = 1; i < count; i++) {
      expect(keys[order[i]!]!).toBeGreaterThanOrEqual(keys[order[i - 1]!]!);
    }
  });

  test('大量相等深度（同位置重复点）时也单调，且不丢不重', () => {
    const count = 500;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // 每 5 个点共用同一坐标 → 大量相等 key，专挑桶边界
      const g = Math.floor(i / 5);
      pos[i * 3] = g * 3;
      pos[i * 3 + 1] = g * 2;
      pos[i * 3 + 2] = g;
    }
    const view = makeView();
    const keys = depthKeys(pos, count, view);
    const order = splatDepthOrder(pos, count, view);

    const seen = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      expect(seen[order[i]!]).toBe(0);
      seen[order[i]!] = 1;
      if (i > 0) expect(keys[order[i]!]!).toBeGreaterThanOrEqual(keys[order[i - 1]!]!);
    }
    expect(seen.every((v) => v === 1)).toBe(true);
  });

  test('输出是排列：每个下标恰好出现一次', () => {
    const count = 3000;
    const pos = randomPositions(count, 42);
    const order = splatDepthOrder(pos, count, makeView());
    const seen = new Uint8Array(count);
    for (const i of order) seen[i] = 1;
    expect(seen.every((v) => v === 1)).toBe(true);
  });

  test('传入 out 时复用同一块缓冲（每帧不分配）', () => {
    const count = 1024;
    const pos = randomPositions(count);
    const out = new Uint32Array(count);
    expect(splatDepthOrder(pos, count, makeView(), out)).toBe(out);
    // 长度不够时不能用：返回新数组，不能越界写
    const small = new Uint32Array(10);
    const fresh = splatDepthOrder(pos, count, makeView(), small);
    expect(fresh).not.toBe(small);
    expect(fresh.length).toBe(count);
  });

  test('边界：count 为 0 / 1 时安全', () => {
    const view = makeView();
    expect(splatDepthOrder(new Float32Array(0), 0, view).length).toBe(0);
    expect(Array.from(splatDepthOrder(new Float32Array([1, 2, 3]), 1, view))).toEqual([0]);
  });

  test('100k 点仍然单调（真实泼溅瓦片量级）', () => {
    const count = 100_000;
    const pos = randomPositions(count, 7);
    const view = makeView();
    const keys = depthKeys(pos, count, view);
    const order = splatDepthOrder(pos, count, view);

    let inversions = 0;
    for (let i = 1; i < count; i++) {
      if (keys[order[i]!]! < keys[order[i - 1]!]!) inversions++;
    }
    expect(inversions).toBe(0);
  });
});
