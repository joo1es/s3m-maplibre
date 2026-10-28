/**
 * 正交投影的数学单测（合成矩阵，不需要 GL / 不需要 MapLibre）
 *
 * 钉住四件事：
 *   1. 从 MapLibre 输入反推视图矩阵：V = P⁻¹ × MVP，逐元素还原；
 *   2. 正交与透视在「目标深度」平面上逐点重合 —— 这正是俯视时地面能和
 *      透视底图对齐的根据（俯视 pitch=0 时地面垂直于视线，深度恒为 d）；
 *   3. 正交语义：同一横向、不同深度的点投影后横向不变（透视会变）；
 *   4. zoom 语义：相机距离减半 → 同一点屏幕坐标翻倍（放大一倍）。
 * 另加拒绝路径：拿不到独立投影矩阵、两个矩阵不同源时必须返回 null，
 * 由调用方保持透视，绝不静默画错。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  buildOrthoMVP,
  buildBlendedMVP,
  extractFovRadians,
  extractProjectionMatrix,
  extractNearFar,
} from '../../packages/s3m-three/src/render/OrthoProjection';
import { S3MLayer } from '../../packages/s3m-maplibre/src/index';

const FOV = 0.6435011087932844; // MapLibre 默认垂直视场角（弧度）
const ASPECT = 16 / 9;
const NEAR = 100;
const FAR = 1e7;
const DISTANCE = 1000;

/** 造一个「MapLibre 会给出的」透视投影 + 刚体视图矩阵 + MVP */
function makePerspectiveFrame(eye: THREE.Vector3, target: THREE.Vector3) {
  const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOV), ASPECT, NEAR, FAR);
  cam.position.copy(eye);
  cam.lookAt(target);
  cam.updateMatrixWorld(); // 同时刷新 matrixWorldInverse，即视图矩阵
  const mvp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  return { P: cam.projectionMatrix, V: cam.matrixWorldInverse, mvp };
}

/** 世界点 → NDC（w 归一化） */
function projectNdc(m: THREE.Matrix4, p: THREE.Vector3): THREE.Vector3 {
  const v = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(m);
  return new THREE.Vector3(v.x / v.w, v.y / v.w, v.z / v.w);
}

/** 矩阵逐元素最大相对差（比布尔比较好定位：失败时会打印实际偏差） */
function matrixDiff(a: THREE.Matrix4, b: THREE.Matrix4): number {
  const x = a.elements;
  const y = b.elements;
  let worst = 0;
  for (let i = 0; i < 16; i++) {
    const scale = Math.max(1, Math.abs(x[i]), Math.abs(y[i]));
    worst = Math.max(worst, Math.abs(x[i] - y[i]) / scale);
  }
  return worst;
}

function expectedOrtho(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(
    -DISTANCE * Math.tan(FOV / 2) * ASPECT,
    DISTANCE * Math.tan(FOV / 2) * ASPECT,
    DISTANCE * Math.tan(FOV / 2),
    -DISTANCE * Math.tan(FOV / 2),
    NEAR,
    FAR
  );
  cam.updateProjectionMatrix();
  return cam;
}

const frame = makePerspectiveFrame(
  new THREE.Vector3(0, -DISTANCE * 0.6, DISTANCE * 0.8), // 斜上方，模拟 pitch
  new THREE.Vector3(0, 0, 0)
);
const params = { distance: DISTANCE, fov: FOV, aspect: ASPECT };
const frameInput = { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements, nearZ: NEAR, farZ: FAR };

describe('1. 反推视图矩阵', () => {
  test('V = P⁻¹ × MVP 逐元素还原，正交 MVP 与手搓的一致', () => {
    const r = buildOrthoMVP(frameInput, params)!;
    expect(r).toBeTruthy();
    expect(matrixDiff(r.view, frame.V)).toBeLessThan(1e-6);
    expect(matrixDiff(r.matrix, expectedOrtho().projectionMatrix.clone().multiply(frame.V))).toBeLessThan(1e-6);
  });
});

describe('2. 目标平面重合', () => {
  test('正交与透视在目标深度逐点重合（俯视时地面与底图对齐的根据）', () => {
    const r = buildOrthoMVP(frameInput, params)!;
    // 从视图矩阵取相机基（世界坐标）：列 0/1/2 反向即相机右/上方向
    const e = frame.V.elements;
    const axisRight = new THREE.Vector3(-e[0], -e[4], -e[8]);
    const axisUp = new THREE.Vector3(-e[1], -e[5], -e[9]);
    const pts = [
      new THREE.Vector3(0, 0, 0),
      axisRight.clone().multiplyScalar(300),
      axisUp.clone().multiplyScalar(300),
      axisRight.clone().multiplyScalar(-250).add(axisUp.clone().multiplyScalar(180)),
    ];
    for (const p of pts) {
      // 确认这些点确实在目标深度上（视深 = DISTANCE）
      const view = p.clone().applyMatrix4(frame.V);
      expect(Math.abs(-view.z - DISTANCE)).toBeLessThan(1e-6);

      const persp = projectNdc(frame.mvp, p);
      const ortho = projectNdc(r.matrix, p);
      expect(Math.abs(persp.x - ortho.x)).toBeLessThan(1e-6);
      expect(Math.abs(persp.y - ortho.y)).toBeLessThan(1e-6);
    }
  });
});

describe('3. 正交语义', () => {
  test('同一横向、视深 0.5d 与 2d 的点投影后横向一致（透视不一致）', () => {
    const r = buildOrthoMVP(frameInput, params)!;
    const vinv = frame.V.clone().invert();
    const world = (vx: number, vy: number, vz: number) => new THREE.Vector3(vx, vy, vz).applyMatrix4(vinv);
    const p1 = world(200, 0, -DISTANCE / 2);
    const p2 = world(200, 0, -DISTANCE * 2);

    const o1 = projectNdc(r.matrix, p1);
    const o2 = projectNdc(r.matrix, p2);
    expect(Math.abs(o1.x - o2.x)).toBeLessThan(1e-6);

    // 对照组：透视的远近点横向必须不同
    const v1 = projectNdc(frame.mvp, p1);
    const v2 = projectNdc(frame.mvp, p2);
    expect(Math.abs(v1.x - v2.x)).toBeGreaterThan(1e-3);
  });
});

describe('4. zoom 映射', () => {
  test('相机距离减半 → 同一点屏幕坐标翻倍，与透视的 zoom 语义一致', () => {
    const r1 = buildOrthoMVP(frameInput, params)!;
    const r2 = buildOrthoMVP(frameInput, { ...params, distance: DISTANCE / 2 })!;
    const p = new THREE.Vector3(150, 80, 40);
    const a = projectNdc(r1.matrix, p);
    const b = projectNdc(r2.matrix, p);
    expect(Math.abs(b.x / a.x - 2)).toBeLessThan(1e-3);
    expect(Math.abs(b.y / a.y - 2)).toBeLessThan(1e-3);
  });
});

describe('4b. MapLibre 真实形态', () => {
  test('y 翻转 + 非均匀 z 缩放 + 像素偏移下反推与替换都正确', () => {
    // 真实数据里 MVP = P · A，A 是投影之后的一串：y 翻转、相机平移、姿态旋转、
    // scale(1,1,pixelPerMeter) 非均匀缩放、高程平移，P 上还带着像素对齐偏移。
    // 这一串显然不刚体，但必须是仿射——曾经按刚体校验，把真实数据全误杀了。
    const ppm = 0.37; // pixelPerMeter，故意取非 1
    const P = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOV), ASPECT, NEAR, FAR).projectionMatrix.clone();
    P.elements[8] = (2 * 0.31) / 1600; // 像素对齐偏移
    P.elements[9] = (-2 * 0.44) / 900;
    const A = new THREE.Matrix4()
      .makeScale(1, -1, 1) // 墨卡托 y 朝南
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -DISTANCE)) // 相机到中心
      .multiply(new THREE.Matrix4().makeRotationZ(-0.15)) // -roll
      .multiply(new THREE.Matrix4().makeRotationX(0.62)) // pitch
      .multiply(new THREE.Matrix4().makeRotationZ(0.41)) // -bearing
      .multiply(new THREE.Matrix4().makeTranslation(-8123.4, -5210.9, 0)) // 场景锚点
      .multiply(new THREE.Matrix4().makeScale(1, 1, ppm)) // 米 → 像素
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -8.5)); // 高程
    const mvp = P.clone().multiply(A);

    const r = buildOrthoMVP({ projectionMatrix: P.elements, mvp: mvp.elements, nearZ: NEAR, farZ: FAR }, params);
    // 必须能构建，不能被误判成不同源
    expect(r).toBeTruthy();
    expect(matrixDiff(r!.view, A)).toBeLessThan(1e-6);
    expect(matrixDiff(r!.matrix, expectedOrtho().projectionMatrix.clone().multiply(A))).toBeLessThan(1e-6);

    // 目标平面仍（亚像素级）重合——容差放宽是因为正交矩阵不带像素对齐偏移
    const target = new THREE.Vector3(0, 0, -DISTANCE).applyMatrix4(A.clone().invert());
    const a = projectNdc(mvp, target);
    const b = projectNdc(r!.matrix, target);
    expect(Math.abs(a.x - b.x)).toBeLessThan(2e-3);
    expect(Math.abs(a.y - b.y)).toBeLessThan(2e-3);
  });
});

describe('5. near/far 与拒绝路径', () => {
  test('近裁剪面映射到 ndc z = -1，远裁剪面映射到 +1', () => {
    const r = buildOrthoMVP(frameInput, params)!;
    const vinv = frame.V.clone().invert();
    const nearPt = new THREE.Vector3(0, 0, -NEAR).applyMatrix4(vinv);
    const farPt = new THREE.Vector3(0, 0, -FAR).applyMatrix4(vinv);
    expect(Math.abs(projectNdc(r.matrix, nearPt).z + 1)).toBeLessThan(1e-4);
    expect(Math.abs(projectNdc(r.matrix, farPt).z - 1)).toBeLessThan(1e-4);
  });

  test('缺 nearZ/farZ 时用兜底值建出矩阵', () => {
    expect(buildOrthoMVP({ projectionMatrix: frame.P.elements, mvp: frame.mvp.elements }, params)).toBeTruthy();
  });

  test('拿不到独立投影矩阵时返回 null（MapLibre v4 只给合并矩阵）', () => {
    expect(buildOrthoMVP({ projectionMatrix: null, mvp: frame.mvp.elements }, params)).toBeNull();
    expect(buildOrthoMVP({ projectionMatrix: new Array(4).fill(0), mvp: frame.mvp.elements }, params)).toBeNull();
  });

  test('投影矩阵与本帧 fov 对不上（换 fov 的透视矩阵冒充）时拒绝', () => {
    const other = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOV * 1.7), ASPECT, NEAR, FAR);
    expect(
      buildOrthoMVP({ projectionMatrix: other.projectionMatrix.elements, mvp: frame.mvp.elements }, params)
    ).toBeNull();
  });

  test('投影矩阵本身不是透视（竖直向量不含 1/tan(fov/2)）时拒绝', () => {
    const notPerspective = new THREE.Matrix4().makeScale(2, 2, 2);
    expect(
      buildOrthoMVP({ projectionMatrix: notPerspective.elements, mvp: frame.mvp.elements }, params)
    ).toBeNull();
  });

  test('distance 为 0 时返回 null', () => {
    expect(
      buildOrthoMVP({ projectionMatrix: frame.P.elements, mvp: frame.mvp.elements }, { ...params, distance: 0 })
    ).toBeNull();
  });
});

describe('6. render() 入参提取', () => {
  const P = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  test('MapLibre ≥5 对象形态：defaultProjectionData 优先', () => {
    const v5 = {
      defaultProjectionData: { mainMatrix: P, projectionMatrix: P },
      modelViewProjectionMatrix: P,
      projectionMatrix: P,
      nearZ: 12,
      farZ: 5000,
    };
    expect(extractProjectionMatrix(v5)).toBe(P);
    expect(extractNearFar(v5)).toEqual({ nearZ: 12, farZ: 5000 });
  });

  test('只有顶层字段时取顶层', () => {
    const top = { projectionMatrix: P, nearZ: 3, farZ: 9 };
    expect(extractProjectionMatrix(top)).toBe(P);
    expect(extractNearFar(top)).toEqual({ nearZ: 3, farZ: 9 });
  });

  test('嵌套里的 nearZ 也能取到', () => {
    expect(extractNearFar({ defaultProjectionData: { nearZ: 7 } })).toEqual({ nearZ: 7, farZ: null });
  });

  test('MapLibre v4 数组形态取不到投影矩阵', () => {
    expect(extractProjectionMatrix([...P, 0])).toBeNull();
    expect(extractNearFar([...P])).toEqual({ nearZ: null, farZ: null });
    expect(extractProjectionMatrix(null)).toBeNull();
  });

  test('fov：入参给的是弧度就直接信，数组形态没有', () => {
    expect(extractFovRadians({ fov: 0.9 })).toBe(0.9);
    expect(extractFovRadians({}, 0.6)).toBe(0.6);
    expect(extractFovRadians([...P])).toBeNull();
  });
});

describe('7. fov 单位（v5 起 transform.fov 是「度」）', () => {
  const mkMap = (transform: object) => ({
    getCanvas: () => ({ width: 1600, height: 900 }),
    triggerRepaint() {},
    transform,
  });

  test('入参弧度优先；v5 的 transform.fov（度）不会被当成弧度', () => {
    const layer = new S3MLayer({});
    layer.map = mkMap({
      fov: THREE.MathUtils.radToDeg(FOV),
      fovInRadians: FOV,
      cameraToCenterDistance: DISTANCE,
    }) as never;
    expect((layer as any)._frameFov({ fov: 0.9 })).toBe(0.9);

    // 入参没有 → 退回 fovInRadians，而不是把「度」当弧度
    expect((layer as any)._frameFov({})).toBe(FOV);

    // 只有 v5 的 transform.fov（度）时 → 落到默认弧度，绝不能把 36.87 当弧度
    layer.map = mkMap({ fov: 36.87, cameraToCenterDistance: DISTANCE }) as never;
    expect((layer as any)._frameFov({})).toBe(0.6435011087932844);
  });
});

describe('8. 接线：真实类上的行为', () => {
  test('真实 v5 输入（mainMatrix + 顶层投影矩阵）配对成功；v4 数组退回透视且只告警一次', () => {
    const layer = new S3MLayer({ projection: 'orthographic' });
    expect(layer.projection).toBe('orthographic');
    layer.setProjection('perspective');
    expect(layer.projection).toBe('perspective');
    layer.setProjection('orthographic');

    // render() 只会用到 map 的这几个字段，造个假的就够（v5：transform.fov 是度）
    layer.map = {
      getCanvas: () => ({ width: 1600, height: 900 }),
      triggerRepaint() {},
      transform: {
        fov: THREE.MathUtils.radToDeg(FOV),
        fovInRadians: FOV,
        cameraToCenterDistance: DISTANCE,
      },
    } as never;

    // 复刻 MapLibre v5.0.0 的真实输入：
    //   - defaultProjectionData.mainMatrix = _viewProjMatrix · diag(worldSize, worldSize, worldSize/ppm)
    //     （getProjectionDataForCustomLayer 的装配，且它没有 projectionMatrix 字段）
    //   - 顶层 projectionMatrix = _projectionMatrix（透视 + 像素对齐偏移）
    //   - 顶层 modelViewProjectionMatrix = _viewProjMatrix
    // _extractMatrix 取 mainMatrix，extractProjectionMatrix 落回顶层——必须配对成功
    const ppm = 0.37;
    const P = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOV), ASPECT, NEAR, FAR).projectionMatrix.clone();
    P.elements[8] = (2 * 0.31) / 1600;
    P.elements[9] = (-2 * 0.44) / 900;
    const A = new THREE.Matrix4()
      .makeScale(1, -1, 1)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -DISTANCE))
      .multiply(new THREE.Matrix4().makeRotationX(0.62))
      .multiply(new THREE.Matrix4().makeRotationZ(0.41))
      .multiply(new THREE.Matrix4().makeTranslation(-8123.4, -5210.9, 0))
      .multiply(new THREE.Matrix4().makeScale(1, 1, ppm))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -8.5));
    const worldSize = 512 * Math.pow(2, 16.2);
    const viewProj = P.clone().multiply(A);
    const mainMatrix = viewProj
      .clone()
      .multiply(new THREE.Matrix4().makeScale(worldSize, worldSize, worldSize / ppm));

    const input = {
      defaultProjectionData: { mainMatrix: mainMatrix.elements },
      modelViewProjectionMatrix: viewProj.elements,
      projectionMatrix: P.elements,
      nearZ: NEAR,
      farZ: FAR,
      fov: FOV,
    };

    const wired = (layer as any)._applyOrtho(input as never, new THREE.Matrix4().fromArray(mainMatrix.elements));
    expect(wired).toBeTruthy();

    const expectedMvp = expectedOrtho()
      .projectionMatrix.clone()
      .multiply(A)
      .multiply(new THREE.Matrix4().makeScale(worldSize, worldSize, worldSize / ppm));
    expect(matrixDiff(wired!, expectedMvp)).toBeLessThan(1e-6);

    // MapLibre v4 的数组形态：拿不到投影矩阵 → 退回透视（null），且只告警一次
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      expect((layer as any)._applyOrtho([...mainMatrix.elements] as never, new THREE.Matrix4())).toBeNull();
      expect((layer as any)._applyOrtho([...mainMatrix.elements] as never, new THREE.Matrix4())).toBeNull();
    } finally {
      console.warn = origWarn;
    }
    // 不可用时只告警一次，不要每帧刷屏
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/没有独立的投影矩阵/);
  });

  test('正交/透视平滑过渡：buildBlendedMVP 与 setProjection(mode, transition)', () => {
    const eye = new THREE.Vector3(0, -DISTANCE, 500);
    const target = new THREE.Vector3(0, 0, 0);
    const { P, mvp } = makePerspectiveFrame(eye, target);

    const input = {
      projectionMatrix: P.elements,
      mvp: mvp.elements,
      nearZ: NEAR,
      farZ: FAR,
    };
    const params = { distance: DISTANCE, fov: FOV, aspect: ASPECT };

    // t = 0 时等价透视
    const t0 = buildBlendedMVP(input, params, 0);
    expect(t0).toBeTruthy();
    expect(matrixDiff(t0!.matrix, mvp)).toBeLessThan(1e-6);

    // t = 1 时等价正交
    const t1 = buildBlendedMVP(input, params, 1);
    const pureOrtho = buildOrthoMVP(input, params);
    expect(t1).toBeTruthy();
    expect(matrixDiff(t1!.matrix, pureOrtho!.matrix)).toBeLessThan(1e-6);

    // 0 < t < 1 时平滑连续插值
    const tMid = buildBlendedMVP(input, params, 0.5);
    expect(tMid).toBeTruthy();
    expect(matrixDiff(tMid!.matrix, mvp)).toBeGreaterThan(0.01);
    expect(matrixDiff(tMid!.matrix, pureOrtho!.matrix)).toBeGreaterThan(0.01);

    // S3MLayer setProjection 支持动画过渡参数
    const layer = new S3MLayer({ id: 'layer-ortho-anim' });
    expect(layer.projection).toBe('perspective');
    expect(layer.projectionT).toBe(0);

    layer.setProjection('orthographic', { duration: 100 });
    expect(layer.projection).toBe('orthographic');
    // 开始动画后已注册 projection.t 通道
    expect(layer.viewer.animator.has('projection.t')).toBe(true);
  });
});
