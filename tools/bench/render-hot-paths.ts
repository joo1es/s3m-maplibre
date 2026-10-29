/**
 * 渲染热路径基准：两个「每帧 / 每瓦片」都要跑、又容易悄悄退化的地方。
 *
 *   bun run bench:render            打印耗时
 *   bun run bench:render --check    超阈值退出码 1（CI 用）
 *
 * 阈值不是性能目标，是**防退化护栏**：留了 3~4 倍余量，正常机器波动不会误报，
 * 但一旦有人把 O(n) 改回 O(n log n) 的 JS 比较排序、或者去掉缓冲复用，立刻会红。
 *
 * 为什么这两个：
 *   - 泼溅排序：相机一动就每帧重排，10 万点原来 38 ms/帧，是唯一会让用户直接
 *     感觉到卡顿的地方；
 *   - 共面去重：每个瓦片都跑，10 万三角形原来 90 ms，Worker 崩溃降级后落在主线程。
 */
import * as THREE from 'three';
import { splatDepthOrder } from '../../packages/s3m-three/src/core/SplatSort';
import { dropCoincidentTriangles } from '../../packages/s3m-three/src/core/TileGeometry';

const CHECK = process.argv.includes('--check');
const ROUNDS = 15;

/**
 * 用**中位数**而不是平均值：这两个函数都是毫秒级、且内部有复用缓冲，
 * 偶尔撞上一次 GC 就能把平均值拉高一倍，中位数才反映稳定开销。
 */
function bench(name: string, fn: () => void, budgetMs: number): boolean {
  for (let i = 0; i < 3; i++) fn(); // 预热：让 JIT 和模块级 scratch 就位
  const times: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const ms = times[ROUNDS >> 1]!;
  const ok = ms <= budgetMs;
  const mark = ok ? 'ok  ' : 'SLOW';
  console.log(`${mark} ${name.padEnd(34)} ${ms.toFixed(2).padStart(8)} ms   (预算 ${budgetMs} ms)`);
  return ok;
}

/** 确定性伪随机，保证每轮数据一致，测的是算法不是运气 */
function seeded(count: number, seed: number): Float32Array {
  let s = seed;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    out[i] = (s / 4294967296 - 0.5) * 2000;
  }
  return out;
}

/** 真实量级的瓦片：每 3 条三角形里有 2 条是重复副本 */
function overlapTile(tris: number) {
  const verts = tris * 3;
  const pos = new Float32Array(verts * 3);
  const index = new Uint32Array(verts);
  for (let t = 0; t < tris; t++) {
    const src = t - (t % 3);
    const shift = t % 3;
    for (let k = 0; k < 3; k++) {
      const v = t * 3 + k;
      const s = src * 3 + ((k + shift) % 3);
      index[v] = v;
      pos[v * 3] = s * 0.37;
      pos[v * 3 + 1] = s * 0.11;
      pos[v * 3 + 2] = s * 0.53;
    }
  }
  return { pos, index };
}

const view = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.3, 0.7, 0.1)).invert();
const sorted20k = seeded(20_000, 1);
const sorted100k = seeded(100_000, 7);
const orderBuf = new Uint32Array(100_000);

// 深度高度集中：正对相机的墙面，所有点视深几乎相同（桶排序会退化的形状）
const flat100k = new Float32Array(100_000 * 3);
for (let i = 0; i < 100_000; i++) {
  flat100k[i * 3] = (i % 500) * 0.1;
  flat100k[i * 3 + 1] = ((i / 500) | 0) * 0.1;
}

const tile7k = overlapTile(7_156);
const tile100k = overlapTile(100_000);

let ok = true;
console.log('\n— 泼溅排序（每帧）—');
ok = bench('20k 点', () => splatDepthOrder(sorted20k, 20_000, view), 8) && ok;
ok = bench('100k 点', () => splatDepthOrder(sorted100k, 100_000, view), 20) && ok;
ok = bench('100k 点 · 复用 out 缓冲', () => splatDepthOrder(sorted100k, 100_000, view, orderBuf), 20) && ok;
ok = bench('100k 点 · 同深度（墙面）', () => splatDepthOrder(flat100k, 100_000, view), 20) && ok;

console.log('\n— 共面去重（每瓦片）—');
ok = bench('7,156 三角形（BIM 真实量级）', () => dropCoincidentTriangles(tile7k.index, tile7k.pos, null), 30) && ok;
ok = bench('100,000 三角形', () => dropCoincidentTriangles(tile100k.index, tile100k.pos, null), 250) && ok;

if (CHECK && !ok) {
  console.error('\n有项目超出预算。若不是机器抖动，检查这两条路径是否被改回了高复杂度实现。');
  process.exit(1);
}
console.log(ok ? '\n全部在预算内。' : '\n有项目超出预算（未开 --check，仅提示）。');
