/**
 * 给 MapLibre 换正交投影的数学验证。
 *
 * 核心断言只有一条：**中心平面（z=0 的地面）上的点，正交与透视投影结果逐点相同**。
 * 满足它，就说明换投影没有改变视野范围与取景，只是去掉了「近大远小」；
 * 瓦片位置、瓦片之间的拼接也随之一致（同一条矩阵链）。
 *
 * 另外钉住几件事：
 *   - mercator → 像素 的比例恰好是 worldSize（正交下 1 世界单位 = 1 像素）
 *   - 高处（z>0）在正交下不改 x/y，透视下会外扩（这就是近大远小）
 *   - 缺少 helper / 尺寸为 0 时返回 false，让调用方保持透视
 */
import { Matrix4 } from 'three';
import { describe, expect, test } from 'bun:test';
import { applyOrthoMatrices } from '../../packages/s3m-maplibre/src/maplibreOrtho.js';

const W = 1280;
const H = 800;
const FOV = (60 * Math.PI) / 180;
const WORLD_SIZE = 512 * Math.pow(2, 16);
/** MapLibre: cameraToCenterDistance = 0.5 / tan(fov/2) * height */
const CAM_DIST = (0.5 / Math.tan(FOV / 2)) * H;

function makeTransform(over: Record<string, unknown> = {}) {
  return {
    center: { lng: 116.5, lat: 39.9 },
    worldSize: WORLD_SIZE,
    centerOffset: { x: 0, y: 0 },
    elevation: 0,
    pitchInRadians: 0,
    bearingInRadians: 0,
    rollInRadians: 0,
    clipSpaceToPixelsMatrix: new Matrix4().elements,
    _clearMatrixCaches() {},
    _helper: {
      _width: W,
      _height: H,
      _nearZ: 0.1,
      _farZ: 1000,
      cameraToCenterDistance: CAM_DIST,
      _pixelPerMeter: WORLD_SIZE / 111320, // 粗略值，平面底图下只影响 z
    },
    ...over,
  } as any;
}

/** 复用同一条 view 链，只是把第一步的投影矩阵换成给定的 P */
function buildViewProj(P: Matrix4, t: any): Matrix4 {
  const lat = t.center.lat;
  const s = Math.sin((lat * Math.PI) / 180);
  const mx = ((t.center.lng + 180) / 360) * WORLD_SIZE;
  const my = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD_SIZE;

  return P.clone()
    .multiply(new Matrix4().makeScale(1, -1, 1))
    .multiply(new Matrix4().makeTranslation(0, 0, -CAM_DIST))
    .multiply(new Matrix4().makeRotationZ(-t.rollInRadians))
    .multiply(new Matrix4().makeRotationX(t.pitchInRadians))
    .multiply(new Matrix4().makeRotationZ(-t.bearingInRadians))
    .multiply(new Matrix4().makeTranslation(-mx, -my, 0))
    .multiply(new Matrix4().makeTranslation(0, 0, -t.elevation));
}

/** three 的 Matrix4.makePerspective 是 6 参数视锥版（不是 fov 版），别喂 4 个参数 */
function perspectiveMatrix(near: number, far: number): Matrix4 {
  const top = near * Math.tan(FOV / 2);
  const h = 2 * top;
  const w = (W / H) * h;
  return new Matrix4().makePerspective(-w / 2, w / 2, top, -top, near, far);
}

function ndc(m: Matrix4, x: number, y: number, z: number): [number, number, number] {
  const e = m.elements;
  const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const cz = e[2] * x + e[6] * y + e[10] * z + e[14];
  const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
  return [cx / cw, cy / cw, cz / cw];
}

/** 中心点的**像素空间**坐标（viewProj 的输入尺度，不是 0..1 的 mercator） */
function centerMercator(t: any): [number, number] {
  const s = Math.sin((t.center.lat * Math.PI) / 180);
  return [
    ((t.center.lng + 180) / 360) * WORLD_SIZE,
    (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD_SIZE,
  ];
}

describe('MapLibre 正交接管', () => {
  test('中心点投到屏幕正中', () => {
    const t = makeTransform();
    expect(applyOrthoMatrices(t)).toBe(true);
    const [mx, my] = centerMercator(t);
    const [x, y] = ndc(new Matrix4().fromArray(t._viewProjMatrix), mx, my, 0);
    expect(Math.abs(x)).toBeLessThan(1e-12);
    expect(Math.abs(y)).toBeLessThan(1e-12);
  });

  test('地面上的点：正交与透视结果逐点相同（1e-9）', () => {
    const t = makeTransform();
    applyOrthoMatrices(t);

    const persp = perspectiveMatrix(t._helper._nearZ, t._helper._farZ);
    const perspViewProj = buildViewProj(persp, t);
    const orthoViewProj = new Matrix4().fromArray(t._viewProjMatrix);

    const [mx, my] = centerMercator(t);
    for (const [dx, dy] of [
      [0, 0],
      [500, 0],
      [-300, 200],
      [0, -380],
      [1200, 700],
    ]) {
      const px = mx + dx;
      const py = my - dy;
      const a = ndc(orthoViewProj, px, py, 0);
      const b = ndc(perspViewProj, px, py, 0);
      expect(a[0]).toBeCloseTo(b[0], 9);
      expect(a[1]).toBeCloseTo(b[1], 9);
    }
  });

  test('正交下 1 个 world 单位正好等于 1 像素', () => {
    const t = makeTransform();
    applyOrthoMatrices(t);
    const m = new Matrix4().fromArray(t._viewProjMatrix);
    const [mx, my] = centerMercator(t);
    const a = ndc(m, mx, my, 0);
    const b = ndc(m, mx + 1, my, 0);
    // NDC 差 × width/2 = 像素差
    expect(Math.abs((b[0] - a[0]) * (W / 2) - 1)).toBeLessThan(1e-9);
  });

  test('近大远小被去掉：高处点的 x/y 不再外扩', () => {
    const t = makeTransform({ elevation: 0 });
    applyOrthoMatrices(t);
    const ortho = new Matrix4().fromArray(t._viewProjMatrix);

    const persp = perspectiveMatrix(t._helper._nearZ, t._helper._farZ);
    const perspM = buildViewProj(persp, t);

    const [mx, my] = centerMercator(t);
    // worldSize = 512 × 2^16，zoom 16 下 1px ≈ 1.83m，50 米 ≈ 27px
    const h = 27;
    const [xa] = ndc(ortho, mx + 200, my, h);
    const [xb] = ndc(perspM, mx + 200, my, h);
    // 正交下与地面完全一致；透视下被推远（值变小）
    const [xg] = ndc(ortho, mx + 200, my, 0);
    expect(Math.abs(xa - xg)).toBeLessThan(1e-9);
    expect(xb).not.toBeCloseTo(xg, 6);
  });

  test('pixelMatrix 与 viewProj 同一套坐标系', () => {
    const t = makeTransform();
    applyOrthoMatrices(t);
    const pix = new Matrix4().fromArray(t._pixelMatrix);
    const [mx, my] = centerMercator(t);
    // clipSpaceToPixels 的平移是 (width/2, height/2)，所以中心点应落在画布中心
    const [mx2, my2] = ndc(pix, mx, my, 0);
    expect(Math.abs(mx2)).toBeLessThan(1e-9);
    expect(Math.abs(my2)).toBeLessThan(1e-9);
  });

  test('条件不满足时返回 false（保持透视）', () => {
    expect(applyOrthoMatrices(makeTransform({ _helper: null }))).toBe(false);
    expect(applyOrthoMatrices(makeTransform({ _helper: { _width: 0, _height: 0 } }))).toBe(false);
  });
});
