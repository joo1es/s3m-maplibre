/**
 * 三维空间分析的 CPU 侧成本基准。
 *
 *   bun run bench:analysis            打印耗时
 *   bun run bench:analysis --check    超阈值退出码 1（CI 用）
 *
 * 为什么单独一条：
 *   `render-hot-paths.ts` 只测泼溅排序与共面去重（每帧 / 每瓦片），
 *   测不到分析链路。而分析里真正会拖慢交互的是**通视的 CPU 射线求交**——
 *   它的成本是 O(可见三角面)，10 万面和 100 万面差一个数量级，
 *   这个数字决定 API 要不要默认降采样、以及能不能绑 hover。
 *
 * 测的是「一次点击」的成本，不是每帧成本：分析 API 都是按需调用，
 * 只要单次调用在几十毫秒内，交互就是可接受的。
 *
 * 阈值同样是**防退化护栏**，不是性能目标：留 3~4 倍余量，
 * 一旦有人把包围球粗筛去掉、或者把 O(n) 改回 O(n log n)，立刻会红。
 */
import * as THREE from 'three';
import {
  boxClipping,
  buildClipPlanes,
  crossClipping,
  isPointKept,
  planeClipping,
} from '../../packages/s3m-three/src/analysis/clipping';
import { lineOfSight, type RayCast } from '../../packages/s3m-three/src/analysis/lineOfSight';
import {
  measureSegment,
  polygonArea,
  polygonAreaHorizontal,
  polylineLength,
  type Vec3,
} from '../../packages/s3m-three/src/analysis/measure';

const CHECK = process.argv.includes('--check');
const ROUNDS = 15;

/** 中位数：分析函数是毫秒级，偶尔一次 GC 就能把平均值拉高一倍 */
function bench(name: string, fn: () => void, budgetMs: number): boolean {
  for (let i = 0; i < 3; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const ms = times[ROUNDS >> 1]!;
  const ok = ms <= budgetMs;
  console.log(`${ok ? 'ok  ' : 'SLOW'} ${name.padEnd(40)} ${ms.toFixed(2).padStart(8)} ms   (预算 ${budgetMs} ms)`);
  return ok;
}

/* ------------------------------------------------------------------ 场景构造 */

/**
 * 造一片「楼房」：每栋是一个 12 面的盒子，沿网格铺开。
 *
 * 用盒子而不是随机三角面，是因为通视的耗时对**包围球分布**很敏感
 * （three 先做包围球粗筛，随机散点几乎全部粗筛失败，测出来会虚假地快）。
 */
function buildingScene(count: number): { meshes: THREE.Mesh[]; triangles: number } {
  const geo = new THREE.BoxGeometry(20, 40, 20);
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const meshes: THREE.Mesh[] = [];
  const mat = new THREE.MeshBasicMaterial();
  const perMesh = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  const side = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set((i % side) * 30 - (side * 30) / 2, ((i / side) | 0) * 30 - (side * 30) / 2, 0);
    m.updateMatrixWorld();
    meshes.push(m);
  }
  return { meshes, triangles: Math.round(perMesh * count) };
}

/** 与 `PickService.raycastDistance` 同一条路径：Raycaster 打全部 mesh */
function makeCast(meshes: THREE.Mesh[]): RayCast {
  const raycaster = new THREE.Raycaster();
  return (origin, dir, maxDistance) => {
    raycaster.set(
      new THREE.Vector3(origin[0], origin[1], origin[2]),
      new THREE.Vector3(dir[0], dir[1], dir[2]).normalize()
    );
    raycaster.near = 0;
    raycaster.far = maxDistance;
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const h = hits[0]!;
    return { distance: h.distance, point: [h.point.x, h.point.y, h.point.z] };
  };
}

/* ------------------------------------------------------------------ 数据 */

const scene1k = buildingScene(1_000); // ~12k 三角面：单块精模瓦片的量级
const scene10k = buildingScene(10_000); // ~120k 三角面：一个街区的量级
const scene40k = buildingScene(40_000); // ~480k 三角面：一个片区的量级

const cast1k = makeCast(scene1k.meshes);
const cast10k = makeCast(scene10k.meshes);
const cast40k = makeCast(scene40k.meshes);

// 一条横穿场景、大概率被挡住的视线（最坏情况：要走到很远才撞上）
const A: Vec3 = [-400, -400, 30];
const B: Vec3 = [400, 400, 30];

// 量算用：100 个点的折线、64 边形的面
const polyline100: Vec3[] = Array.from({ length: 100 }, (_, i) => [i * 2, Math.sin(i / 5) * 3, i * 0.1]);
const poly64: Vec3[] = Array.from({ length: 64 }, (_, i) => {
  const a = (i / 64) * Math.PI * 2;
  return [Math.cos(a) * 50, Math.sin(a) * 50, Math.sin(a * 3) * 2];
});

// 裁剪：交互拖拽时每帧都会重建一次半空间
const box = { type: 'box' as const, a: [0, 0, 0] as Vec3, b: [100, 100, 100] as Vec3 };
const planes6 = boxClipping({ a: [0, 0, 0], b: [100, 100, 100] });

let ok = true;

console.log('\n— 通视：一次射线（点击触发，不进每帧）—');
ok = bench(`12k 面`, () => lineOfSight(A, B, cast1k), 1) && ok;
ok = bench(`120k 面`, () => lineOfSight(A, B, cast10k), 6) && ok;
ok = bench(`480k 面`, () => lineOfSight(A, B, cast40k), 40) && ok;

console.log('\n— 量算：纯数学（O(点数)）—');
ok = bench('两点量算 × 1000 次', () => {
  for (let i = 0; i < 1000; i++) measureSegment(A, B);
}, 0.5) && ok;
ok = bench('折线 100 点 × 100 次', () => {
  for (let i = 0; i < 100; i++) polylineLength(polyline100);
}, 0.6) && ok;
ok = bench('64 边形面积 × 100 次', () => {
  for (let i = 0; i < 100; i++) {
    polygonArea(poly64);
    polygonAreaHorizontal(poly64);
  }
}, 0.5) && ok;

console.log('\n— 裁剪：交互拖拽时每帧重建半空间 —');
ok = bench('单平面 × 1000 次', () => {
  for (let i = 0; i < 1000; i++) planeClipping({ normal: [0, 0, 1], point: [0, 0, i] });
}, 0.8) && ok;
ok = bench('Box（6 平面）× 1000 次', () => {
  for (let i = 0; i < 1000; i++) buildClipPlanes({ ...box, a: [i, 0, 0], b: [100 + i, 100, 100] });
}, 3) && ok;
ok = bench('十字（2 平面）× 1000 次', () => {
  for (let i = 0; i < 1000; i++) crossClipping({ center: [i, 0, 0], keepX: -1, keepY: -1 });
}, 1.5) && ok;
ok = bench('盒内判定 × 10000 次', () => {
  for (let i = 0; i < 10000; i++) isPointKept(planes6, [50, 50, (i % 200) - 50]);
}, 3) && ok;

if (CHECK && !ok) {
  console.error('\n有项目超出预算。优先怀疑：包围球粗筛被去掉、或量算退化成 O(n²)。');
  process.exit(1);
}
console.log(ok ? '\n全部在预算内。' : '\n有项目超出预算（未开 --check，仅提示）。');
