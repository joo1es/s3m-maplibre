/**
 * 泼溅瓦片的细化判据（点云 LOD）
 *
 * 钉住的是「按**屏幕上的高斯尺寸**细化」，不是按包围球像素误差、也不是按覆盖率。
 * 夹具用寿宁阁的真实数值（实测遍历瓦片链得到）：
 *
 *   根 0019：1888 个高斯、半径 10.455 m、σ=0.210 m
 *   子 0020：9448 个高斯、半径 3.70 m、σ=0.072 m
 *   孙 0021：2538 个高斯、半径 2.19 m、σ=0.077 m
 *   叶 0022：1752 个高斯、半径 1.12 m、σ=0.077 m（`lodType: Replace`）
 *
 * 注意 σ 从第二层起就稳定在 0.077 m —— 细化带来的是「同一片表面上的点更多」，
 * 而不是「高斯更小」。所以判据只能问一件事：这些高斯在我屏幕上占多少像素。
 */
import { expect, test } from 'bun:test';
import {
  splatLodDecision,
  SPLAT_REFINE_PX,
} from '../../packages/s3m-three/src/core/SplatLod';

const H = 900; // 绘图缓冲高度
const ROOT = { splats: 1888, radius: 10.45, sigma: 0.21, screenHeight: H, hasChild: true };
const CHILD = { splats: 9448, radius: 3.7, sigma: 0.072, screenHeight: H, hasChild: true };

test('真实根瓦片：30m 处 3σ 半轴 ~22px → 必须细化', () => {
  const r = splatLodDecision({ ...ROOT, distance: 30 });
  expect(r.splatPx).toBeGreaterThan(15);
  expect(r.splatPx).toBeLessThan(30);
  expect(r.needRefine).toBe(true);
});

test('子瓦片在 30m 处仍有 ~7.8px → 继续细化（旧覆盖率判据在这里就停了）', () => {
  const r = splatLodDecision({ ...CHILD, distance: 30 });
  expect(r.splatPx).toBeGreaterThan(SPLAT_REFINE_PX);
  expect(r.needRefine).toBe(true);
  // 覆盖率在这里已经远大于目标值：它衡量的是「屏幕被盖满没有」，盖满了也可能
  // 全是 20cm 的粗高斯 —— 那正是柱子被糊掉的直接原因，所以它不能当判据。
  expect(r.coverage).toBeGreaterThan(5);
});

test('高斯缩到阈值以下就停：再细一层屏幕上也看不出来', () => {
  const r = splatLodDecision({ ...CHILD, distance: 80 });
  expect(r.splatPx).toBeLessThan(SPLAT_REFINE_PX);
  expect(r.needRefine).toBe(false);
});

test('屏幕尺寸随距离线性变，不随平方变：远处该停、近处该细', () => {
  const a = splatLodDecision({ ...CHILD, distance: 20 }).splatPx;
  const b = splatLodDecision({ ...CHILD, distance: 40 }).splatPx;
  expect(a / b).toBeCloseTo(2, 3);
});

test('没有子瓦片就不细化（叶子节点）', () => {
  expect(splatLodDecision({ ...ROOT, distance: 30, hasChild: false }).needRefine).toBe(false);
});

test('3σ 半轴到亚像素线以下就不再细化：再下一层会被着色器剔除', () => {
  const far = splatLodDecision({
    splats: 1000,
    radius: 200,
    sigma: 0.05,
    screenHeight: H,
    hasChild: true,
    distance: 500,
  });
  expect(far.splatPx).toBeLessThan(SPLAT_REFINE_PX);
  expect(far.needRefine).toBe(false);

  // 同一瓦片拉近到 20 m，高斯涨到像素级 → 该细化
  const near = splatLodDecision({
    splats: 1000,
    radius: 200,
    sigma: 0.05,
    screenHeight: H,
    hasChild: true,
    distance: 20,
  });
  expect(near.splatPx).toBeGreaterThan(SPLAT_REFINE_PX);
  expect(near.needRefine).toBe(true);
});

test('缺 sigma / radius 时退回「不细化」，由调用方走通用判据', () => {
  expect(splatLodDecision({ ...ROOT, distance: 30, sigma: 0 }).needRefine).toBe(false);
  expect(splatLodDecision({ ...ROOT, distance: 30, radius: 0 }).needRefine).toBe(false);
});
