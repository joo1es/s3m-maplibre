/**
 * 高斯泼溅：屏幕空间 EWA 投影 + back-to-front 排序
 *
 * 这两个是「空洞」和「彩色噪点」的对症修复：
 *
 *   1. 旧的顶点着色器把两个主轴投到垂直视线的平面上、丢掉 z 分量。薄片高斯
 *      侧对相机时被丢的那个轴直接归零，四边形退化成一条线 → 满墙空洞；
 *      远处高斯不足一个像素时又被光栅化漏掉。这里钉的是标准 EWA 做法：
 *      3D 协方差经投影雅可比变成 2×2，再取特征轴，且有最小像素半径。
 *   2. alpha 混合是顺序相关的，实例不按视深排序就会出彩色噪点。
 *      排序键是视图空间 z（相机前方为负），远的先画 = 升序。
 *
 * 数学断言一律对着解析解钉（标准透视矩阵下手算），不是复述实现输出。
 */
import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { splatScreenAxes } from '../../packages/s3m-three/src/core/SplatProjection';
import { splatDepthOrder } from '../../packages/s3m-three/src/core/SplatSort';
import { sortSplatMesh } from '../../packages/s3m-three/src/render/SplatSorter';
import { createSplatMaterial, createQuadGeometry, createSplatPickMaterial, splatRaycast, splatCenterBounds, SPLAT_VIEWPORT } from '../../packages/s3m-three/src/render/SplatMaterial';

const PERSP = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
PERSP.updateProjectionMatrix();
const P = PERSP.projectionMatrix;
const FOCAL = 1 / Math.tan((45 / 2) * (Math.PI / 180)); // 标准透视的 x/y 焦距系数
const IDENTITY = new THREE.Matrix4();
const VP = 1000; // 正方形视口，ndc→像素系数 = 500

const UNIT_Q = [0, 0, 0, 1];

function axes(center: number[], quat: number[], scale: number[], cullPixels = 0, maxPixels = 0) {
  return splatScreenAxes({
    center,
    quat,
    scale,
    modelView: IDENTITY,
    projection: P,
    viewportWidth: VP,
    viewportHeight: VP,
    cullPixels,
    maxPixels,
  });
}

const len = (x: number, y: number) => Math.hypot(x, y);

/* ---------------------------------------------------------------- 投影 */

test('球形高斯正视：两轴等长正交，半径等于解析值 3σ·f/|z|', () => {
  const a = axes([0, 0, -10], UNIT_Q, [1, 1, 1])!;
  expect(a).not.toBeNull();

  const expected = (3 * FOCAL) / 10; // ndc 半径
  const la = len(a.ax, a.ay);
  const lb = len(a.bx, a.by);
  expect(la).toBeCloseTo(expected, 5);
  expect(lb).toBeCloseTo(expected, 5);
  // 正交：点积 ≈ 0
  expect(a.ax * a.bx + a.ay * a.by).toBeCloseTo(0, 5);
  // 换成像素量级感受一下：≈ 372 px
  expect(la * (VP / 2)).toBeGreaterThan(100);
});

test('薄片高斯侧对相机：细轴由抗锯齿低通兜底（约 0.9px），不会被放大成肉眼可见的硬点', () => {
  // 高斯在 y 轴只有 1 毫米（真实数据里就是这种扁盘），相机沿 -z 看 →
  // 细轴正好在屏幕竖直方向上，真实尺寸远小于一个像素。
  // 3DGS 论文的低通（方差 +0.3px²）会把它兜到亚像素，但**绝不放大**：
  // 早期实现把它抬到 minPixels 再画，一片薄高斯就是一个硬点。
  const a = axes([0, 0, -10], UNIT_Q, [1, 0.001, 1], 0)!;
  expect(a).not.toBeNull();

  const la = len(a.ax, a.ay) * (VP / 2); // 像素
  const lb = len(a.bx, a.by) * (VP / 2);
  expect(la).toBeGreaterThan(10);
  // 亚像素：低通决定下限，官方对应 sqrt(2*0.3)=0.775px
  expect(lb).toBeGreaterThan(0.5);
  expect(lb).toBeLessThan(1.2);
  // 面积（行列式）必须为正：退化成线时行列式为 0
  expect(Math.abs(a.ax * a.by - a.ay * a.bx)).toBeGreaterThan(0);
});

test('两轴都小于 2px 的高斯被剔除，而不是被抬成一像素硬点（官方 covVectors<2 的判据）', () => {
  // 3σ·f/|z| 换算成像素：半径 1e-4 m、z=10 m、f=2.41、视口 1000 → 约 0.036 px
  expect(axes([0, 0, -10], UNIT_Q, [1e-4, 1e-4, 1e-4], 2.0)).toBeNull();

  // 单轴大于 2px 时保留：thin 片侧看成一条细线，仍然要画（否则会在墙面上开缝）
  const q = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  expect(axes([0, 0, -10], q, [1, 1e-6, 1], 2.0)).not.toBeNull();
});

test('cullPixels=0 时不剔除：半径只剩 3σ×0.3px 的低通项', () => {
  const a = axes([0, 0, -10], UNIT_Q, [1e-6, 1e-6, 1e-6], 0)!;
  expect(a).not.toBeNull();
  // 高斯本身≈0，剩下的是抗锯齿低通：0.3px 标准差 × 3σ = 0.9px
  expect(len(a.ax, a.ay)).toBeCloseTo((3 * 0.3 * 2) / VP, 6);
});

test('相机后方的点返回 null（w<=0，不做透视除法也就不会炸）', () => {
  expect(axes([0, 0, 10], UNIT_Q, [1, 1, 1])).toBeNull();
});

test('四边形是 6 个顶点（两个三角形）：Mesh 固定用 TRIANGLES，4 顶点只画半个', () => {
  // three 的 renderBufferDirect 对 object.isMesh 一律 gl.TRIANGLES（不是
  // TRIANGLE_STRIP）。4 顶点只会画出前 3 个组成的一个三角形 —— 表现就是
  // 满屏三角片 + 沿对角线的拉丝。
  const geo = createQuadGeometry();
  const pos = geo.getAttribute('position');
  expect(pos.count).toBe(6);
  expect(pos.itemSize).toBe(3);

  // 四个角必须都覆盖。两个三角形共享对角线上的 (-1,1) 与 (1,-1)，
  // 所以这两角出现两次，另外两角各一次 —— 6 个顶点不多不少。
  const corners = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.array[i * 3]},${pos.array[i * 3 + 1]}`;
    corners.set(key, (corners.get(key) ?? 0) + 1);
  }
  expect([...corners.keys()].sort()).toEqual(['-1,-1', '-1,1', '1,-1', '1,1']);
  expect(corners.get('-1,-1')).toBe(1);
  expect(corners.get('1,1')).toBe(1);
  expect(corners.get('-1,1')).toBe(2);
  expect(corners.get('1,-1')).toBe(2);
  expect([...corners.values()].reduce((a, b) => a + b, 0)).toBe(6);
});

test('顶点不共享时三角形覆盖整块 [-1,1]²：六点都落在四个角上', () => {
  const geo = createQuadGeometry();
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    expect(Math.abs(pos.array[i * 3] as number)).toBe(1);
    expect(Math.abs(pos.array[i * 3 + 1] as number)).toBe(1);
  }
});

test('贴脸高斯按 maxPixels 封顶，不再炸成全屏三角（治锐角三角面/放射拉丝）', () => {
  // 中心离相机 0.2 m、半径 1 m：3σ·f/|z| ≈ 36 ndc ≈ 18000 px。真实数据近距离
  // 能到几百万像素（实测 max 4.2e6），quad 跨满屏、只露出一角 → 锐角三角面。
  const a = axes([0, 0, -0.2], UNIT_Q, [1, 1, 1], 0, 600)!;
  expect(len(a.ax, a.ay) * (VP / 2)).toBeCloseTo(600, 3);
  expect(len(a.bx, a.by) * (VP / 2)).toBeCloseTo(600, 3);
});

test('封顶是整体等比缩放，长宽比不变（各向异性形状不能被压圆）', () => {
  const a = axes([0, 0, -0.2], UNIT_Q, [1, 0.1, 1], 0, 600)!;
  const la = len(a.ax, a.ay) * (VP / 2);
  const lb = len(a.bx, a.by) * (VP / 2);
  expect(Math.max(la, lb)).toBeCloseTo(600, 3);
  // 原始 10:1，封顶后仍是 10:1
  expect(Math.max(la, lb) / Math.min(la, lb)).toBeCloseTo(10, 1);
});

test('正常尺寸的高斯不受 maxPixels 影响', () => {
  const a = axes([0, 0, -10], UNIT_Q, [1, 1, 1], 0, 600)!;
  const b = axes([0, 0, -10], UNIT_Q, [1, 1, 1], 0, 0)!;
  expect(a.ax).toBeCloseTo(b.ax, 6);
  expect(a.by).toBeCloseTo(b.by, 6);
});

test('maxPixels=0 不封顶：极端投影保持原样', () => {
  const a = axes([0, 0, -0.2], UNIT_Q, [1, 1, 1], 0, 0)!;
  expect(len(a.ax, a.ay) * (VP / 2)).toBeGreaterThan(10000);
});

/* ---------------------------------------------------------------- 排序 */

test('材质走屏幕空间 EWA：通用雅可比 + 亚像素剔除，不再用丢 z 近似', () => {
  const mat = createSplatMaterial();
  // 雅可比必须读投影矩阵的 w 行（第 3 行），否则在 ENU→clip 完整矩阵下算错
  expect(mat.vertexShader).toContain('projectionMatrix[0][3]');
  expect(mat.vertexShader).toContain('projectionMatrix[2][3]');
  // 旧的「主轴投到垂直视线平面」近似会让侧视薄片塌成线，不能再回来
  expect(mat.vertexShader).not.toContain('cameraPosition');
  // 亚像素剔除阈值 / 低通都要 viewport 才能换算 ndc ↔ 像素
  expect(mat.uniforms.uViewport).toBeTruthy();
  expect(mat.uniforms.uCullPixels?.value).toBeGreaterThan(0);
  expect(mat.vertexShader).toContain('uCullPixels');
  // 把过小的高斯抬高到可见尺寸是噪点来源，不能以 uniform 形式回来
  expect(mat.vertexShader).not.toContain('uMinPixels');
});

test('GLSL 数值安全：相机后方的实例不做透视除法，直接扔出裁剪体', () => {
  const mat = createSplatMaterial();
  // w<=0 的分支必须先于任何 / w2 出现，否则又是放射状彩色拖影
  const guard = mat.vertexShader.indexOf('clip.w <= 0.000001');
  const div = mat.vertexShader.indexOf('/ w2');
  expect(guard).toBeGreaterThan(-1);
  expect(div).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(div);
});


test('back-to-front：视图空间 z 升序（远的先画）', () => {
  const positions = new Float32Array([
    0, 0, -1, // 最近
    0, 0, -10, // 最远
    0, 0, -5, // 中间
  ]);
  const view = new THREE.Matrix4(); // 相机就在原点看向 -z
  const order = splatDepthOrder(positions, 3, view);
  expect([...order]).toEqual([1, 2, 0]);
});

test('排序考虑 view 平移：相机挪到 z=-4 后远近关系改变', () => {
  const positions = new Float32Array([0, 0, -1, 0, 0, -10, 0, 0, -5]);
  const view = new THREE.Matrix4().makeTranslation(0, 0, 4); // view = T(-cam)
  const order = splatDepthOrder(positions, 3, view);
  // 相机在 z=-4：视 z 分别是 3（-1，已在相机后方）、-6（-10）、-1（-5）。
  // 按视 z 升序 = 远的先画：-10 → -5 → -1（3DGS 的标准口径，不是欧氏距离）
  expect([...order]).toEqual([1, 2, 0]);
});

test('sortSplatMesh 按视深重排全部实例属性，且对齐不错位', () => {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3)
  );
  const centers = new Float32Array([0, 0, -1, 0, 0, -10, 0, 0, -5]);
  const scales = new Float32Array([1, 1, 1, 2, 2, 2, 3, 3, 3]);
  const quats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
  geo.setAttribute('iCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(scales, 3));
  geo.setAttribute('iQuat', new THREE.InstancedBufferAttribute(quats, 4));
  geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(colors, 4));
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 3);

  const changed = sortSplatMesh(mesh, new THREE.Matrix4());
  expect(changed).toBe(true);

  const c = geo.getAttribute('iCenter').array as Float32Array;
  const s = geo.getAttribute('iScale').array as Float32Array;
  const col = geo.getAttribute('iColor').array as Float32Array;
  // 顺序：远(-10) → 中(-5) → 近(-1)
  expect([c[2], c[5], c[8]]).toEqual([-10, -5, -1]);
  // scale / color 必须跟着同一个实例走，不能排串
  expect([...s]).toEqual([2, 2, 2, 3, 3, 3, 1, 1, 1]);
  expect([...col]).toEqual([0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1]);
});

test('sortSplatMesh：顺序已经正确时不重写 attribute（返回 false）', () => {
  const geo = new THREE.InstancedBufferGeometry();
  const centers = new Float32Array([0, 0, -10, 0, 0, -5, 0, 0, -1]);
  geo.setAttribute('iCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(9), 3));
  geo.setAttribute('iQuat', new THREE.InstancedBufferAttribute(new Float32Array(12), 4));
  geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(12), 4));
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 3);

  const before = geo.getAttribute('iCenter').array;
  expect(sortSplatMesh(mesh, new THREE.Matrix4())).toBe(false);
  // 同一个 buffer，没有被换掉
  expect(geo.getAttribute('iCenter').array).toBe(before);
});

/* ---------------------------------------------------------------- 拾取 */

test('泼溅拾取材质必须自己拿 iCenter 定位，不能用通用拾取着色器', () => {
  const pm = createSplatPickMaterial(37);
  // 通用拾取着色器只读 position：交给它，所有实例都塌在原点 —— 表现是「模型点不中」
  expect(pm.vertexShader).toContain('iCenter');
  expect(pm.vertexShader).toContain('modelViewMatrix * vec4(iCenter, 1.0)');
  // 像素换成 ndc 要用和显示同一份 viewport
  expect(pm.uniforms.uViewport!.value).toBe(SPLAT_VIEWPORT);
  expect(pm.uniforms.uObjectId!.value).toBe(37);
  // 编码：o = objectId + 1，R/G 两个通道，与 Picker 的解码互为逆运算 o = r + g*256 - 1
  expect(pm.fragmentShader).toContain('uObjectId + 1.0');
});

test('splatRaycast：命中最近的那个高斯，并报出它的实例号', () => {
  const geo = new THREE.InstancedBufferGeometry();
  // 三个高斯都在 -z 方向，x 不同：只有中间那个在射线上
  geo.setAttribute(
    'iCenter',
    new THREE.InstancedBufferAttribute(new Float32Array([2, 0, -5, 0, 0, -3, -2, 0, -9]), 3)
  );
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(9).fill(0.1), 3));
  geo.instanceCount = 3;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -5), 20);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 3);
  mesh.raycast = splatRaycast;

  const ray = new THREE.Ray(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
  const hits = new THREE.Raycaster(ray.origin, ray.direction).intersectObject(mesh, false);
  expect(hits.length).toBe(1);
  expect(hits[0]!.instanceId).toBe(1);
  expect(hits[0]!.point!.z).toBeCloseTo(-3, 5);
});

test('splatRaycast：射线擦不到任何高斯时返回空，不误报原点', () => {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    'iCenter',
    new THREE.InstancedBufferAttribute(new Float32Array([50, 50, -5, -50, 50, -3]), 3)
  );
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(6).fill(0.05), 3));
  geo.instanceCount = 2;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -4), 80);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 2);
  mesh.raycast = splatRaycast;

  const hits = new THREE.Raycaster(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)).intersectObject(mesh, false);
  expect(hits.length).toBe(0);
});

/* ---------------------------------------------------------------- 拾取结果 */

test('泼溅包围盒必须由 iCenter 算，不能由 position 算', () => {
  const geo = new THREE.InstancedBufferGeometry();
  // position 只是 [-1,1] 的四边形角点
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, 1, 0]), 3));
  geo.setAttribute(
    'iCenter',
    new THREE.InstancedBufferAttribute(new Float32Array([100, 200, 5, 110, 190, 9, 105, 195, 7]), 3)
  );
  const b = splatCenterBounds(geo)!;
  expect(b).not.toBeNull();
  expect([b.minX, b.minY, b.minZ]).toEqual([100, 190, 5]);
  expect([b.maxX, b.maxY, b.maxZ]).toEqual([110, 200, 9]);
  expect(b.count).toBe(3);
});

test('没有 iCenter 的几何返回 null（不假装算出一个 [-1,1] 立方体）', () => {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0]), 3));
  expect(splatCenterBounds(geo)).toBeNull();
});
