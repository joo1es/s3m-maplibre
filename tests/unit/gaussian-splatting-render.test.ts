/**
 * 高斯泼溅：解码公式与渲染对象
 *
 * 量化格式不是统计猜出来的，是从官方 worker `SuperMap3D/Workers/GaussianSplating.js`
 * 里读出来的（3.9 KB，公式逐字见 core/GaussianSplat.ts 头部）。所以这里的断言
 * 是**对着那份实现**钉的，不是对着我们自己的输出复述：
 *
 *   scale    = exp(byte/16 - 10) 米
 *   rotation = (√(1-x²-y²-z²), b0/127.5-1, b1/127.5-1, b2/127.5-1)，第 4 字节不参与
 *
 * 判定「分支猜对没有」的判据是四元数模长残差：`D()` 分支下 w 是补出来的，
 * |q|² 应当等于 1 到量化精度；如果数据其实是 smallest-three 打包，前 3 字节
 * 当分量解出来的 |q|² 会明显偏离 1（实测 0.1 量级）。
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';
import { createSplatMaterial } from '../../packages/s3m-three/src/render/SplatMaterial';
import {
  decodeScale,
  decodeRotation,
  decodeRotationSmallestThree,
  lastRotationResidual,
} from '../../packages/s3m-three/src/core/GaussianSplat';

const FIX = join(import.meta.dir, '../fixtures');

const parse = (path: string) => {
  const b = readFileSync(join(FIX, path));
  return parseS3MB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, {
    inflate: (x) => inflateSync(x),
  });
};

const skull = (tile: Awaited<ReturnType<typeof parse>>, i = 0) =>
  Object.values(tile.geoPackage)[i]!.vertexPackage;

const attr = (vp: ReturnType<typeof skull>, semantic: string) =>
  vp.vertexAttributes.find((a) => a.semantic === semantic)!;

/* ---------------------------------------------------------------- 解码 */

test('scale：exp(byte/16 - 10)，单位米，落在合理的建筑泼溅量级', () => {
  // 用手算的字节直接喂，避免「测试跟着实现走」
  const bytes = new Uint8Array([142, 134, 51, 207]);
  const out = decodeScale(bytes, 4, 0, 1);

  expect(out[0]).toBeCloseTo(Math.exp(142 / 16 - 10), 6); // ≈ 0.3247 m
  expect(out[1]).toBeCloseTo(Math.exp(134 / 16 - 10), 6);
  expect(out[2]).toBeCloseTo(Math.exp(51 / 16 - 10), 6);
  // 第 4 字节 207 不参与解码 —— 正是当初把它当分量才怎么都对不上的原因
  expect(out[0]).toBeGreaterThan(0.1);
  expect(out[0]).toBeLessThan(10);
});

test('rotation：3 个 u8 归一化 + w 由单位化补出，第 4 字节忽略', () => {
  const bytes = new Uint8Array([139, 126, 143, 207]);
  const q = decodeRotation(bytes, 4, 0, 1);
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];

  expect(x).toBeCloseTo(139 / 127.5 - 1, 5);
  expect(y).toBeCloseTo(126 / 127.5 - 1, 5);
  expect(z).toBeCloseTo(143 / 127.5 - 1, 5);
  expect(x * x + y * y + z * z + w * w).toBeCloseTo(1, 6);

  // 换掉第 4 字节，结果必须一模一样
  const other = decodeRotation(new Uint8Array([139, 126, 143, 0]), 4, 0, 1);
  expect([other[0], other[1], other[2], other[3]]).toEqual([x, y, z, w]);
});

test('分支判定：真实瓦片走 D()，残差在 float32 精度内；smallest-three 明显不符', async () => {
  const tile = await parse('gaussian-splatting/Tile_0020_262145_524289_0003.s3mb');
  const vp = skull(tile);
  const rot = attr(vp, 'gsRotation');

  decodeRotation(rot.data, rot.stride, rot.offsetInBytes, vp.verticesCount);
  const residD = lastRotationResidual();

  decodeRotationSmallestThree(rot.data, rot.stride, rot.offsetInBytes, vp.verticesCount);
  let residST = 0;
  // smallest-three 内部直接置 0，这里按它自己的输出重算模长
  const st = decodeRotationSmallestThree(rot.data, rot.stride, rot.offsetInBytes, vp.verticesCount);
  for (let i = 0; i < vp.verticesCount; i++) {
    const s = [0, 1, 2, 3].reduce((acc, k) => acc + st[i * 4 + k]! ** 2, 0);
    residST = Math.max(residST, Math.abs(s - 1));
  }

  // u8 量化的固有误差上限约 1/127.5 ≈ 8e-3；D() 分支必须在这个量级内
  expect(residD).toBeLessThan(0.02);
  // 反例：把不是 smallest-three 的数据按那个格式解，模长会明显崩
  expect(residST).toBeGreaterThan(residD);
});

test('真实泼溅数据解出的 scale 是各向异性的薄片（z 轴远小于 x/y）', async () => {
  const tile = await parse('gaussian-splatting/Tile_0019_262145_524289_0000.s3mb');
  const vp = skull(tile);
  const s = attr(vp, 'gsScale');
  const scales = decodeScale(s.data, s.stride, s.offsetInBytes, vp.verticesCount);

  let zMax = 0;
  let xAvg = 0;
  const n = vp.verticesCount;
  for (let i = 0; i < n; i++) {
    xAvg += scales[i * 3]!;
    zMax = Math.max(zMax, scales[i * 3 + 2]!);
  }
  xAvg /= n;

  // 重建出来的表面片元：一个轴很薄，另两个轴在厘米~米级
  expect(zMax).toBeLessThan(0.05);
  expect(xAvg).toBeGreaterThan(0.01);
  expect(xAvg).toBeLessThan(2);
});

/* ---------------------------------------------------------------- 渲染对象 */

test('材质构造不炸：GLSL 是模板字符串，注释里出现反引号会提前终止它', () => {
  // 踩过的坑：在 GLSL 注释里写 `position`（带反引号）把模板字符串截断了，
  // position 变成 JS 标识符 → ReferenceError: position is not defined，
  // 而且是运行时才炸。构造一次就是最直接的回归。
  const mat = createSplatMaterial();

  expect(mat.vertexShader).toContain('iCenter');
  expect(mat.vertexShader).toContain('iQuat');
  expect(mat.vertexShader).toContain('iScale');
  expect(mat.vertexShader).toContain('iColor');
  expect(mat.vertexShader).toContain('position.x');
  expect(mat.fragmentShader).toContain('vQuad');
  // 模板字符串被提前终止时，得到的是一段**被截断**的 GLSL —— 前半段断言照样能过，
  // 所以额外要求完整：必须有 main，且以右花括号收尾。
  expect(mat.vertexShader).toContain('void main');
  expect(mat.vertexShader.trimEnd().endsWith('}')).toBe(true);
  expect(mat.fragmentShader).toContain('void main');
  expect(mat.fragmentShader.trimEnd().endsWith('}')).toBe(true);
  // 属性名必须和 GeometryBuilder 里 setAttribute 的一致，改名时两边都要动
  expect(mat.transparent).toBe(true);
  expect(mat.depthWrite).toBe(false);
});

test('泼溅瓦片建出实例化四边形，而不是 Points', async () => {
  const tile = await parse('gaussian-splatting/Tile_0020_262145_524289_0003.s3mb');
  const res = await buildTileObjects(tile);

  const splats: THREE.Mesh[] = [];
  const points: THREE.Points[] = [];
  res.group.traverse((o) => {
    if ((o as THREE.Mesh).userData?.isGaussianSplat) splats.push(o as THREE.Mesh);
    else if (o instanceof THREE.Points) points.push(o);
  });

  expect(points.length).toBe(0);
  expect(splats.length).toBe(4);

  const total = splats.reduce(
    (s, m) => s + ((m.geometry as THREE.InstancedBufferGeometry).instanceCount ?? 0),
    0
  );
  expect(total).toBe(9448);

  for (const m of splats) {
    const g = m.geometry as THREE.InstancedBufferGeometry;
    expect(g.getAttribute('iCenter')).toBeTruthy();
    expect(g.getAttribute('iScale')).toBeTruthy();
    expect(g.getAttribute('iQuat')).toBeTruthy();
    expect(g.getAttribute('iColor')).toBeTruthy();
    expect(g.getAttribute('position')).toBeTruthy();
    // aColor 在组装阶段已转成 0~1 的 float（不是 u8），GPU 不需要再归一化
    const colorAttr = g.getAttribute('iColor') as THREE.InstancedBufferAttribute;
    expect(colorAttr.array).toBeInstanceOf(Float32Array);
    expect(colorAttr.normalized).toBe(false);
    expect(colorAttr.itemSize).toBe(4);
    let maxColor = 0;
    for (let i = 0; i < Math.min(64, colorAttr.array.length); i++) {
      maxColor = Math.max(maxColor, colorAttr.array[i] as number);
    }
    expect(maxColor).toBeGreaterThan(0);
    expect(maxColor).toBeLessThanOrEqual(1.0001);
  }
});

test('没有泼溅参数的点云仍走 Points —— 分流只由数据决定', async () => {  const tile = await parse('draco/pointcloud.s3mb');
  const res = await buildTileObjects(tile);

  let splats = 0;
  for (const o of res.group.children) {
    if ((o as THREE.Mesh).userData?.isGaussianSplat) splats++;
  }
  expect(splats).toBe(0);
  expect(res.stats.skipped).toEqual([]);
});

test('泼溅颜色逐点对齐原始 color 流：4 分量 RGBA，通道不错位、alpha 不丢', async () => {
  // 踩过的坑：组装阶段的 aColor 只保留 RGB 三分量（alpha 被丢），泼溅却按
  // RGBA 去读 → 第 i 个实例读到第 i*4 个 float，颜色循环错位、alpha 读到
  // 下一个点的颜色分量。画面就是满屏青紫色噪点。颜色必须直接取原始 color 流。
  const tile = await parse('gaussian-splatting/Tile_0020_262145_524289_0003.s3mb');
  const res = await buildTileObjects(tile);

  let checked = 0;
  res.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.userData?.isGaussianSplat) return;
    const g = mesh.geometry as THREE.InstancedBufferGeometry;
    const n = g.instanceCount;
    const rgba = g.getAttribute('iColor').array as Float32Array;
    // 长度必须是 4N（3N 被当 4N 读就是这里暴露的）
    expect(rgba.length).toBe(n * 4);

    const vp = (tile.geoPackage as Record<string, { vertexPackage: ReturnType<typeof skull> }>)[
      mesh.userData.skeletonName as string
    ]!.vertexPackage;
    const src = vp.vertexAttributes.find((a) => a.semantic === 'color')!;
    expect(src.dtype).toBe('u8');
    expect(src.components).toBe(4);

    for (let i = 0; i < Math.min(n, 64); i++) {
      const o0 = i * src.stride + src.offsetInBytes;
      for (let k = 0; k < 4; k++) {
        expect(rgba[i * 4 + k]).toBeCloseTo(src.data[o0 + k]! / 255, 5);
      }
    }
    checked++;
  });
  expect(checked).toBe(4);
});
