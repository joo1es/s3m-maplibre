/**
 * 回归测试：近裁剪面缩放（`buildNearScaledMVP`）
 *
 * 背景：MapLibre 的 near 是硬编码的 `canvasHeight / 50`（CSS 像素），zoom 16.5、
 * 纬度 31° 时 1px ≈ 0.72m，即近平面离相机约 13 米 —— 相机推进到楼体十几米以内，
 * 楼面整片被裁掉。这里只改透视矩阵的 e[10]/e[14]，等价于把视锥的四边按 near
 * 的比例等比缩放，所以**视场角与画面完全不变**，只有近处不再被裁。
 *
 * 必须钉住的两件事：
 *   1. x/y 的 NDC 逐点不变（否则画面会缩放/错位，那就不是「无感修复」了）；
 *   2. 原本落在 near 之外的点，缩放后进入可见范围。
 */
import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { buildNearScaledMVP } from '../../packages/s3m-three/src/render/OrthoProjection';

const NEAR = 18;
const FAR = 5000;

/** 造一份标准透视投影矩阵（e[11] = -1，与 MapLibre 的 makePerspective 同构） */
function perspective() {
  const cam = new THREE.PerspectiveCamera(36.87, 1440 / 900, NEAR, FAR);
  cam.updateProjectionMatrix();
  return cam.projectionMatrix.clone();
}

function ndc(m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] {
  const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(m);
  return [v.x / v.w, v.y / v.w, v.z / v.w];
}

test('scale 不在 (0,1) 区间时返回 null（调用方保持原 MVP）', () => {
  const P = perspective();
  const input = { projectionMatrix: P.elements, mvp: P.elements, nearZ: NEAR, farZ: FAR };
  expect(buildNearScaledMVP(input, 1)).toBeNull();
  expect(buildNearScaledMVP(input, 0)).toBeNull();
  expect(buildNearScaledMVP(input, -0.5)).toBeNull();
  expect(buildNearScaledMVP(input, 2)).toBeNull();
});

test('x / y 的 NDC 逐点不变：只动 near，视场角完全一致', () => {
  const P = perspective();
  const out = buildNearScaledMVP(
    { projectionMatrix: P.elements, mvp: P.elements, nearZ: NEAR, farZ: FAR },
    0.1
  );
  expect(out).not.toBeNull();

  // 相机朝 -z，取几个不同深度的点
  for (const z of [-30, -50, -200, -1000]) {
    const a = ndc(P, 12, -7, z);
    const b = ndc(out!, 12, -7, z);
    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  }
});

test('原来被近平面裁掉的点，缩放后进入可见范围', () => {
  const P = perspective();
  const out = buildNearScaledMVP(
    { projectionMatrix: P.elements, mvp: P.elements, nearZ: NEAR, farZ: FAR },
    0.1
  )!;

  // 相机朝 -z，near = 18 对应 pz = -18，更近的 -10 应被裁掉
  expect(ndc(P, 0, 0, -10)[2]).toBeLessThan(-1);
  // 缩放后 near = 1.8，同一个点落回 [-1, 1]
  const after = ndc(out, 0, 0, -10)[2];
  expect(after).toBeGreaterThanOrEqual(-1);
  expect(after).toBeLessThanOrEqual(1);
});

test('远平面不动：远处点仍在可见范围，只是深度值分布更靠后', () => {
  const P = perspective();
  const out = buildNearScaledMVP(
    { projectionMatrix: P.elements, mvp: P.elements, nearZ: NEAR, farZ: FAR },
    0.1
  )!;
  const before = ndc(P, 0, 0, -4000)[2];
  const after = ndc(out, 0, 0, -4000)[2];
  expect(before).toBeLessThan(1);
  expect(after).toBeLessThan(1);
  // near 变小 → 同样深度的 NDC z 更趋近 1（非线性变陡，这就是深度精度的代价）
  expect(after).toBeGreaterThan(before);
});

test('宿主没给 nearZ/farZ 时从矩阵反解，结果与给了的一致', () => {
  const P = perspective();
  const withHint = buildNearScaledMVP(
    { projectionMatrix: P.elements, mvp: P.elements, nearZ: NEAR, farZ: FAR },
    0.1
  )!;
  const inferred = buildNearScaledMVP({ projectionMatrix: P.elements, mvp: P.elements }, 0.1)!;
  for (let i = 0; i < 16; i++) {
    expect(inferred.elements[i]).toBeCloseTo(withHint.elements[i] as number, 8);
  }
});

test('非透视矩阵（正交）不处理，避免误伤', () => {
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, NEAR, FAR);
  ortho.updateProjectionMatrix();
  const out = buildNearScaledMVP(
    { projectionMatrix: ortho.projectionMatrix.elements, mvp: ortho.projectionMatrix.elements },
    0.1
  );
  expect(out).toBeNull();
});

test('缺少投影矩阵时返回 null', () => {
  const P = perspective();
  expect(buildNearScaledMVP({ projectionMatrix: null, mvp: P.elements }, 0.1)).toBeNull();
});
