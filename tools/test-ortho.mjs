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
import assert from 'node:assert';
import * as THREE from 'three';
import {
  buildOrthoMVP,
  extractFovRadians,
  extractProjectionMatrix,
  extractNearFar,
} from '../dist/render/OrthoProjection.js';
import { S3MLayer } from '../dist/index.js';

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  √ ${msg}`);
};

const FOV = 0.6435011087932844; // MapLibre 默认垂直视场角（弧度）
const ASPECT = 16 / 9;
const NEAR = 100;
const FAR = 1e7;
const DISTANCE = 1000;

/** 造一个「MapLibre 会给出的」透视投影 + 刚体视图矩阵 + MVP */
function makePerspectiveFrame(eye, target, up = new THREE.Vector3(0, 0, 1)) {
  const cam = new THREE.PerspectiveCamera(
    THREE.MathUtils.radToDeg(FOV),
    ASPECT,
    NEAR,
    FAR
  );
  cam.position.copy(eye);
  cam.lookAt(target);
  cam.updateMatrixWorld(); // 同时刷新 matrixWorldInverse，即视图矩阵
  const mvp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  return { P: cam.projectionMatrix, V: cam.matrixWorldInverse, mvp };
}

/** 世界点 → NDC（w 归一化） */
function projectNdc(m, p) {
  const v = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(m);
  return new THREE.Vector3(v.x / v.w, v.y / v.w, v.z / v.w);
}

/** 矩阵逐元素近似相等 */
function matrixClose(a, b, eps = 1e-6) {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) {
    const scale = Math.max(1, Math.abs(x[i]), Math.abs(y[i]));
    if (Math.abs(x[i] - y[i]) > eps * scale) return false;
  }
  return true;
}

const frame = makePerspectiveFrame(
  new THREE.Vector3(0, -DISTANCE * 0.6, DISTANCE * 0.8), // 斜上方，模拟 pitch
  new THREE.Vector3(0, 0, 0)
);
const params = { distance: DISTANCE, fov: FOV, aspect: ASPECT };

/* ---------------------------------------------- 1. 反推视图矩阵 */

{
  const r = buildOrthoMVP(
    { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements, nearZ: NEAR, farZ: FAR },
    params
  );
  assert.ok(r, '正常输入必须能构建正交 MVP');
  assert.ok(matrixClose(r.view, frame.V), '反推的视图矩阵必须和相机视图矩阵一致');

  const expected = new THREE.OrthographicCamera(
    -DISTANCE * Math.tan(FOV / 2) * ASPECT,
    DISTANCE * Math.tan(FOV / 2) * ASPECT,
    DISTANCE * Math.tan(FOV / 2),
    -DISTANCE * Math.tan(FOV / 2),
    NEAR,
    FAR
  );
  expected.updateProjectionMatrix();
  const expectedMvp = expected.projectionMatrix.clone().multiply(frame.V);
  assert.ok(matrixClose(r.matrix, expectedMvp), '正交 MVP 必须等于 正交投影 × 解出的视图矩阵');
  ok('反推：V = P⁻¹ × MVP 逐元素还原，正交 MVP 与手搓的一致');
}

/* ---------------------------------------------- 2. 目标平面重合 */

{
  const r = buildOrthoMVP(
    { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements, nearZ: NEAR, farZ: FAR },
    params
  );
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
    assert.ok(Math.abs(-view.z - DISTANCE) < 1e-6, '测试点必须在目标平面上');
    const a = projectNdc(frame.mvp, p); // 透视
    const b = projectNdc(r.matrix, p); // 正交
    assert.ok(
      Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6,
      '目标平面上正交/透视的 x,y 必须逐点重合'
    );
  }
  ok('目标平面：正交与透视在目标深度逐点重合（俯视时地面与底图对齐的根据）');
}

/* ---------------------------------------------- 3. 正交语义 */

{
  const r = buildOrthoMVP(
    { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements, nearZ: NEAR, farZ: FAR },
    params
  );
  // 同一横向 x0、不同视深的两个视空间点 → 世界点
  const vinv = frame.V.clone().invert();
  const world = (vx, vy, vz) => new THREE.Vector3(vx, vy, vz).applyMatrix4(vinv);
  const p1 = world(200, 0, -DISTANCE / 2);
  const p2 = world(200, 0, -DISTANCE * 2);
  const o1 = projectNdc(r.matrix, p1);
  const o2 = projectNdc(r.matrix, p2);
  assert.ok(Math.abs(o1.x - o2.x) < 1e-6, '正交：同一横向不同深度的点投影后横向必须相同');
  const v1 = projectNdc(frame.mvp, p1);
  const v2 = projectNdc(frame.mvp, p2);
  assert.ok(Math.abs(v1.x - v2.x) > 1e-3, '透视：远近点的横向必须不同（对照组）');
  ok('正交语义：同一横向、视深 0.5d 与 2d 的点投影后横向一致（透视不一致）');
}

/* ---------------------------------------------- 4. zoom 映射 */

{
  const r1 = buildOrthoMVP(
    { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements, nearZ: NEAR, farZ: FAR },
    params
  );
  const r2 = buildOrthoMVP(
    { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements, nearZ: NEAR, farZ: FAR },
    { ...params, distance: DISTANCE / 2 }
  );
  const p = new THREE.Vector3(150, 80, 40);
  const a = projectNdc(r1.matrix, p);
  const b = projectNdc(r2.matrix, p);
  assert.ok(Math.abs(b.x / a.x - 2) < 1e-3 && Math.abs(b.y / a.y - 2) < 1e-3, '相机距离减半 → 屏幕坐标必须翻倍（放大一倍）');
  ok('zoom：相机距离减半 → 同一点屏幕坐标翻倍，与透视的 zoom 语义一致');
}

/* ---------------------------------------------- 4b. MapLibre 真实形态 */

{
  // 真实数据里 MVP = P · A，A 是投影之后的一串：y 翻转、相机平移、姿态旋转、
  // scale(1,1,pixelPerMeter) 非均匀缩放、高程平移，P 上还带着像素对齐偏移。
  // 这一串显然不刚体，但必须是仿射——曾经按刚体校验，把真实数据全误杀了。
  const ppm = 0.37; // pixelPerMeter，故意取非 1
  const P = new THREE.PerspectiveCamera(
    THREE.MathUtils.radToDeg(FOV),
    ASPECT,
    NEAR,
    FAR
  ).projectionMatrix.clone();
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

  const r = buildOrthoMVP(
    { projectionMatrix: P.elements, mvp: mvp.elements, nearZ: NEAR, farZ: FAR },
    params
  );
  assert.ok(r, 'MapLibre 形态（y 翻转 + 非均匀缩放）必须能构建，不能被误判成不同源');
  assert.ok(matrixClose(r.view, A), '反推结果必须还原投影之后的仿射链');

  const expected = new THREE.OrthographicCamera(
    -DISTANCE * Math.tan(FOV / 2) * ASPECT,
    DISTANCE * Math.tan(FOV / 2) * ASPECT,
    DISTANCE * Math.tan(FOV / 2),
    -DISTANCE * Math.tan(FOV / 2),
    NEAR,
    FAR
  );
  expected.updateProjectionMatrix();
  assert.ok(
    matrixClose(r.matrix, expected.projectionMatrix.clone().multiply(A)),
    '必须等于 正交投影 × 仿射链'
  );

  // 目标平面仍（亚像素级）重合——容差放宽是因为正交矩阵不带像素对齐偏移
  const target = new THREE.Vector3(0, 0, -DISTANCE).applyMatrix4(A.clone().invert());
  const a = projectNdc(mvp, target);
  const b = projectNdc(r.matrix, target);
  assert.ok(
    Math.abs(a.x - b.x) < 2e-3 && Math.abs(a.y - b.y) < 2e-3,
    '目标平面上必须亚像素级重合'
  );
  ok('MapLibre 真实形态：y 翻转 + 非均匀 z 缩放 + 像素偏移下反推与替换都正确');
}

/* ---------------------------------------------- 5. near/far 与拒绝路径 */

{
  // nearZ/farZ 决定深度映射：视深 near → ndc z = -1，视深 far → +1
  const r = buildOrthoMVP(
    { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements, nearZ: NEAR, farZ: FAR },
    params
  );
  const vinv = frame.V.clone().invert();
  const nearPt = new THREE.Vector3(0, 0, -NEAR).applyMatrix4(vinv);
  const farPt = new THREE.Vector3(0, 0, -FAR).applyMatrix4(vinv);
  assert.ok(Math.abs(projectNdc(r.matrix, nearPt).z + 1) < 1e-4, '近裁剪面必须映射到 ndc z = -1');
  assert.ok(Math.abs(projectNdc(r.matrix, farPt).z - 1) < 1e-4, '远裁剪面必须映射到 ndc z = +1');

  // 缺失 nearZ/farZ：用兜底值，仍然要给出合法矩阵
  const r2 = buildOrthoMVP(
    { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements },
    params
  );
  assert.ok(r2, '缺 nearZ/farZ 时要用兜底值建出矩阵');

  // 拒绝路径一：拿不到独立投影矩阵（MapLibre v4 只给合并矩阵）
  assert.strictEqual(
    buildOrthoMVP({ projectionMatrix: null, mvp: frame.mvp.elements }, params),
    null,
    '没有投影矩阵必须返回 null'
  );
  assert.strictEqual(
    buildOrthoMVP({ projectionMatrix: new Array(4).fill(0), mvp: frame.mvp.elements }, params),
    null,
    '投影矩阵长度不够必须返回 null'
  );

  // 拒绝路径二：投影矩阵和本帧 fov 对不上（换个 fov 的透视矩阵冒充）。
  // 只换 fov 时反推结果仍是仿射的，靠 matchesFov 拦
  const other = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOV * 1.7), ASPECT, NEAR, FAR);
  assert.strictEqual(
    buildOrthoMVP({ projectionMatrix: other.projectionMatrix.elements, mvp: frame.mvp.elements }, params),
    null,
    '投影矩阵与 fov 不符时必须拒绝'
  );

  // 拒绝路径三：投影矩阵本身不是透视（竖直向量不含 1/tan(fov/2)）
  const notPerspective = new THREE.Matrix4().makeScale(2, 2, 2);
  assert.strictEqual(
    buildOrthoMVP(
      { projectionMatrix: notPerspective.elements, mvp: frame.mvp.elements },
      params
    ),
    null,
    '非透视投影矩阵必须拒绝'
  );

  // 拒绝路径三：参数非法
  assert.strictEqual(
    buildOrthoMVP(
      { projectionMatrix: frame.P.elements, mvp: frame.mvp.elements },
      { ...params, distance: 0 }
    ),
    null,
    'distance 为 0 必须返回 null'
  );
  ok('near/far 深度映射正确；三类非法输入全部被拒（返回 null，不静默画错）');
}

/* ---------------------------------------------- 6. render() 入参提取 */

{
  const P = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  // MapLibre ≥5 对象形态：defaultProjectionData 优先
  const v5 = {
    defaultProjectionData: { mainMatrix: P, projectionMatrix: P },
    modelViewProjectionMatrix: P,
    projectionMatrix: P,
    nearZ: 12,
    farZ: 5000,
  };
  assert.strictEqual(extractProjectionMatrix(v5), P, '应取 defaultProjectionData.projectionMatrix');
  assert.deepStrictEqual(extractNearFar(v5), { nearZ: 12, farZ: 5000 });

  // 只有顶层字段
  const top = { projectionMatrix: P, nearZ: 3, farZ: 9 };
  assert.strictEqual(extractProjectionMatrix(top), P);
  assert.deepStrictEqual(extractNearFar(top), { nearZ: 3, farZ: 9 });

  // 嵌套里的 nearZ
  const nested = { defaultProjectionData: { nearZ: 7 } };
  assert.deepStrictEqual(extractNearFar(nested), { nearZ: 7, farZ: null });

  // MapLibre v4 数组形态：取不到投影矩阵
  assert.strictEqual(extractProjectionMatrix([...P, 0]), null, 'v4 数组形态取不到投影矩阵');
  assert.deepStrictEqual(extractNearFar([...P]), { nearZ: null, farZ: null });
  assert.strictEqual(extractProjectionMatrix(null), null);

  // fov：入参给的是弧度，直接信；数组形态没有
  assert.strictEqual(extractFovRadians({ fov: 0.9 }), 0.9, '入参 fov（弧度）应直接采用');
  assert.strictEqual(extractFovRadians({}, 0.6), 0.6, '入参没有 fov 时用 fallback');
  assert.strictEqual(extractFovRadians([...P]), null, '数组形态没有 fov');
  ok('入参提取：v5 对象（含嵌套）/ v4 数组 / null 全部符合预期');
}

/* ---------------------------------------------- 7. fov 单位（v5 起 transform.fov 是「度」） */

{
  const layer = new S3MLayer({});
  layer.map = {
    getCanvas: () => ({ width: 1600, height: 900 }),
    triggerRepaint() {},
    transform: { fov: THREE.MathUtils.radToDeg(FOV), fovInRadians: FOV, cameraToCenterDistance: DISTANCE },
  };
  // 入参带 fov（弧度）→ 用它，与 transform 无关
  assert.strictEqual(layer._frameFov({ fov: 0.9 }), 0.9, '入参 fov（弧度）必须优先');
  // 入参没有 → 退回 fovInRadians，而不是把「度」当弧度
  assert.strictEqual(layer._frameFov({}), FOV, 'fallback 必须是弧度（fovInRadians）');
  // 只有 v5 的 transform.fov（度）时 → 落到默认弧度，绝不能把 36.87 当弧度
  layer.map = {
    getCanvas: () => ({ width: 1600, height: 900 }),
    triggerRepaint() {},
    transform: { fov: 36.87, cameraToCenterDistance: DISTANCE },
  };
  assert.strictEqual(
    layer._frameFov({}),
    0.6435011087932844,
    'transform.fov（度）不得当弧度用；应落到 DEFAULT_FOV'
  );
  ok('fov 单位：入参弧度优先，v5 的 transform.fov（度）不会被当成弧度');
}

/* ---------------------------------------------- 7. 接线：真实类上的行为 */

{
  const layer = new S3MLayer({ projection: 'orthographic' });
  assert.strictEqual(layer.projection, 'orthographic', '构造后投影模式应为 orthographic');
  layer.setProjection('perspective');
  assert.strictEqual(layer.projection, 'perspective', 'setProjection 应能切回透视');
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
  };

  // 复刻 MapLibre v5.0.0 的真实输入：
  //   - defaultProjectionData.mainMatrix = _viewProjMatrix · diag(worldSize, worldSize, worldSize/ppm)
  //     （getProjectionDataForCustomLayer 的装配，且它没有 projectionMatrix 字段）
  //   - 顶层 projectionMatrix = _projectionMatrix（透视 + 像素对齐偏移）
  //   - 顶层 modelViewProjectionMatrix = _viewProjMatrix
  // _extractMatrix 取 mainMatrix，extractProjectionMatrix 落回顶层——必须配对成功
  const ppm = 0.37;
  const P = new THREE.PerspectiveCamera(
    THREE.MathUtils.radToDeg(FOV),
    ASPECT,
    NEAR,
    FAR
  ).projectionMatrix.clone();
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

  const wired = layer._applyOrtho(input, new THREE.Matrix4().fromArray(mainMatrix.elements));
  assert.ok(wired, '真实 v5 输入形态必须产出正交矩阵（mainMatrix + 顶层投影矩阵配对）');

  const expected = new THREE.OrthographicCamera(
    -DISTANCE * Math.tan(FOV / 2) * ASPECT,
    DISTANCE * Math.tan(FOV / 2) * ASPECT,
    DISTANCE * Math.tan(FOV / 2),
    -DISTANCE * Math.tan(FOV / 2),
    NEAR,
    FAR
  );
  expected.updateProjectionMatrix();
  const expectedMvp = expected.projectionMatrix
    .clone()
    .multiply(A)
    .multiply(new THREE.Matrix4().makeScale(worldSize, worldSize, worldSize / ppm));
  assert.ok(matrixClose(wired, expectedMvp), '接线结果必须等于 正交投影 × 仿射链 × worldSize 缩放');

  // MapLibre v4 的数组形态：拿不到投影矩阵 → 退回透视（null），且只告警一次
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const a = layer._applyOrtho([...mainMatrix.elements], new THREE.Matrix4());
    const b = layer._applyOrtho([...mainMatrix.elements], new THREE.Matrix4());
    assert.strictEqual(a, null, 'v4 形态必须返回 null（保持透视）');
    assert.strictEqual(b, null, 'v4 形态必须返回 null（保持透视）');
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(warnings.length, 1, '不可用时只告警一次，不要每帧刷屏');
  assert.ok(/没有独立的投影矩阵/.test(warnings[0]), 'v4 的告警应点明缺投影矩阵');
  ok('接线：真实 v5 输入（mainMatrix + 顶层投影矩阵）配对成功；v4 数组退回透视且只告警一次');
}

console.log(`\n正交投影数学单测：${n} 组全部通过`);
