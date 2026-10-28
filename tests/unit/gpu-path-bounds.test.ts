/**
 * 单元测试：GPU 路径下的「JS 侧位置」
 *
 * GPU 路径的位移发生在顶点着色器里，JS 侧要拿到「屏幕上现在在哪」只能按同一套公式
 * 复算。这里钉住两件事：
 *
 *   1. 拾取材质能读到路径相关 uniform（否则 PICK_VERT 里的路径分支永远不生效）
 *   2. `getFeatureBounds` 会跟着路径推进，且和等价的 translation 结果一致
 *
 * 不依赖 WebGL：只验证数据链路与 CPU 复算，着色器本身由 typecheck + 人工 review 保证。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

/* ------------------------------------------------------------------ 工具 */

function makeViewer(): S3MViewer {
  const v = new S3MViewer({ canvas: null as never, container: null as never } as ConstructorParameters<typeof S3MViewer>[0]);
  // 造一个能算出经纬度的锚点（1 米 = 1 墨卡托单位，换算可逆）
  v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };
  return v;
}

/** 注册一块带单体信息的 10×10×10 网格，返回 mesh */
function registerMesh(viewer: S3MViewer, smid: number): THREE.Mesh {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(10, 10, 10);
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: viewer.uniforms }));
  mesh.userData = { geoRef: { pickInfo: { [smid]: { batchId: 0 } } } };
  group.add(mesh);
  (viewer as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
    { group, tile: null },
    { id: 'd', root: new THREE.Group() }
  );
  return mesh;
}

function center(bounds: [[number, number], [number, number]] | null): [number, number] {
  if (!bounds) throw new Error('bounds 为 null');
  return [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
}

/* ------------------------------------------------------------------ 1. 拾取材质的数据链路 */

describe('1. 拾取材质能拿到路径 uniform', () => {
  test('styled 材质把共享 uniform 挂到 userData 上（拾取按引用读，无需逐帧同步）', () => {
    const v = makeViewer();
    const mat = createStyledMaterial({ uniforms: v.uniforms }) as THREE.MeshStandardMaterial & {
      userData: Record<string, { value: unknown }>;
    };

    expect(mat.userData.uPathTex?.value).toBe(v.uniforms.uPathTex!.value);
    expect(mat.userData.uPathTexActive).toBe(v.uniforms.uPathTexActive);
    expect(mat.userData.uPathCount).toBe(v.uniforms.uPathCount);
    expect(mat.userData.uPathTime).toBe(v.uniforms.uPathTime);
    expect(mat.userData.uBatchMix).toBe(v.uniforms.uBatchMix);
    expect(mat.userData.uSelElevation).toBe(v.uniforms.uSelElevation);

    // 必须是同一个 uniform 对象，否则路径推进后拾取还停在旧值
    v.setGPUPathTime(3.5);
    expect(mat.userData.uPathTime.value).toBe(3.5);
    v.dispose();
  });

  test('绑定 GPU 路径后 uPathTexActive 置 1，路径库清空后回落', () => {
    const v = makeViewer();
    registerMesh(v, 701);
    expect(v.uniforms.uPathTexActive!.value).toBe(0);

    const pathId = v.registerGPUPath([0, 0, 0, 100, 0, 0]);
    v.bindGPUPath(701, pathId, { speed: 0.1 });
    expect(v.uniforms.uPathTexActive!.value).toBe(1);
    expect(v.uniforms.uPathCount!.value).toBeGreaterThanOrEqual(1);

    // 解绑只摘掉单体的 pathId（row5 归零），路径库还在，所以纹理仍处于激活态
    v.unbindGPUPath(701);
    expect(v.getFeatureStyle(701)?.gpuPath).toBeUndefined();
    expect(v.uniforms.uPathTexActive!.value).toBe(1);

    // 路径库清空才真正关掉分支
    v.unregisterGPUPath(pathId);
    expect(v.uniforms.uPathTexActive!.value).toBe(0);
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 2. 包围盒复算 */

describe('2. getFeatureBounds 跟随 GPU 路径', () => {
  test('路径推进后包围盒跟着移动，且与等价 translation 的结果一致', () => {
    const v = makeViewer();
    registerMesh(v, 702);

    const pathId = v.registerGPUPath([0, 0, 0, 1000, 0, 0]);
    // speed = 0.1 → t = 0.5 时走到 500m 处
    v.bindGPUPath(702, pathId, { speed: 0.1, phase: 0, loop: 'clamp' });
    v.setGPUPathTime(5);

    const byPath = v.getFeatureBounds(702);
    expect(byPath).not.toBeNull();

    // 换成等价的静态平移，两条路径应当算出同一个包围盒
    v.unbindGPUPath(702);
    v.setFeatureStyle(702, { translation: [500, 0, 0] });
    v.flushOverrides();
    const byTranslation = v.getFeatureBounds(702);

    const c1 = center(byPath);
    const c2 = center(byTranslation);
    expect(c1[0]).toBeCloseTo(c2[0], 6);
    expect(c1[1]).toBeCloseTo(c2[1], 6);
    v.dispose();
  });

  test('clamp 模式走完后位置不再变化；loop 模式会绕回起点', () => {
    const v = makeViewer();
    registerMesh(v, 703);

    const pathId = v.registerGPUPath([0, 0, 0, 1000, 0, 0]);
    v.bindGPUPath(703, pathId, { speed: 1, phase: 0, loop: 'clamp' });
    v.setGPUPathTime(2); // t 超过 1 → 夹到终点
    const end = center(v.getFeatureBounds(703));
    v.setGPUPathTime(9);
    const stillEnd = center(v.getFeatureBounds(703));
    expect(stillEnd[0]).toBeCloseTo(end[0], 6);

    v.unbindGPUPath(703);
    v.bindGPUPath(703, pathId, { speed: 1, phase: 0, loop: 'loop' });
    v.setGPUPathTime(1); // t = 1 → 绕回起点
    const start = center(v.getFeatureBounds(703));
    v.setGPUPathTime(0);
    const startAgain = center(v.getFeatureBounds(703));
    expect(start[0]).toBeCloseTo(startAgain[0], 6);
    expect(Math.abs(start[0] - end[0])).toBeGreaterThan(1e-6);
    v.dispose();
  });

  test('pingpong 模式在 1.2 处回到 0.8 的位置', () => {
    const v = makeViewer();
    registerMesh(v, 704);

    const pathId = v.registerGPUPath([0, 0, 0, 1000, 0, 0]);
    v.bindGPUPath(704, pathId, { speed: 1, phase: 0, loop: 'pingpong' });

    v.setGPUPathTime(0.8);
    const at08 = center(v.getFeatureBounds(704));
    v.setGPUPathTime(1.2); // t = 1.2 → 折返到 0.8
    const at12 = center(v.getFeatureBounds(704));
    expect(at12[0]).toBeCloseTo(at08[0], 6);
    v.dispose();
  });

  test('setGPUPathProgress 手动定位也会反映到包围盒', () => {
    const v = makeViewer();
    registerMesh(v, 705);

    const pathId = v.registerGPUPath([0, 0, 0, 1000, 0, 0]);
    v.bindGPUPath(705, pathId, { speed: 0.1 });
    v.setGPUPathProgress(705, 0.25);

    const byPath = v.getFeatureBounds(705);
    v.unbindGPUPath(705);
    v.setFeatureStyle(705, { translation: [250, 0, 0] });
    v.flushOverrides();

    const c1 = center(byPath);
    const c2 = center(v.getFeatureBounds(705));
    expect(c1[0]).toBeCloseTo(c2[0], 6);
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 3. 自动朝向的矩阵口径 */

describe('3. autoHeading 的旋转矩阵口径', () => {
  /**
   * GLSL 的 `mat3(...)` 是**列优先**，three 的 `Matrix3.set(...)` 是**行优先**。
   * 这两套写法一旦混淆，模型会左右镜像着走——而且是「看起来能跑」的那种错：
   * 沿 +X 的直线完全正常，一拐弯就朝反方向。
   *
   * 所以这里直接读四处着色器源码，钉住「第 0 列 = (c, s)」这个口径。
   */
  const SITES = [
    { file: '../../packages/s3m-three/src/render/StyleMaterial.ts', count: 2 },
    { file: '../../packages/s3m-three/src/render/EdgeLines.ts', count: 1 },
    { file: '../../packages/s3m-three/src/render/Picker.ts', count: 1 },
  ];

  test('四处着色器都用「第 0 列 = (c, s)」，即绕 Z 转 +yaw', () => {
    const re = /mat3\(\s*c,\s*(-?)s,\s*0\.0,\s*(-?)s,\s*c,\s*0\.0,\s*0\.0,\s*0\.0,\s*1\.0\s*\)/g;
    for (const site of SITES) {
      const src = readFileSync(new URL(site.file, import.meta.url), 'utf8');
      const found = [...src.matchAll(re)];
      expect(`${site.file}:${found.length}`).toBe(`${site.file}:${site.count}`);
      for (const m of found) {
        // (c, +s) 是第 0 列，(c, -s) 是第 1 列；反过来就是镜像
        expect(m[1]).toBe('');
        expect(m[2]).toBe('-');
      }
    }
  });

  test('这个矩阵把 +X 转到切线方向（+yaw），与 Path 烘焙的 yaw 同源', () => {
    const yaw = Math.PI / 4;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // 按 GLSL 的列优先顺序构造：col0 = (c, s, 0), col1 = (-s, c, 0), col2 = (0, 0, 1)
    const m = new THREE.Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
    const v = new THREE.Vector3(1, 0, 0).applyMatrix3(m);
    expect(v.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(v.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(v.z).toBeCloseTo(0, 6);
  });

  test('CPU 复算的 yaw 与路径切线同向：拐弯后从 0 变 +π/2', () => {
    const v = makeViewer();
    registerMesh(v, 901);

    // 先沿 +X 走 1000m，再沿 +Y 走 1000m：两段等长，t=0.25 在第一段，t=0.75 在第二段
    const pathId = v.registerGPUPath([0, 0, 0, 1000, 0, 0, 1000, 1000, 0]);
    v.bindGPUPath(901, pathId, { speed: 1, phase: 0, loop: 'clamp' });

    const poseAt = (t: number): { pos: number[]; yaw: number } => {
      v.setGPUPathTime(t);
      return (v as unknown as { _gpuPathPoseAt: (s: number) => { pos: number[]; yaw: number } })
        ._gpuPathPoseAt(901);
    };

    const first = poseAt(0.25);
    expect(first.pos[0]).toBeCloseTo(500, 4);
    expect(first.yaw).toBeCloseTo(0, 4); // +X 方向

    const second = poseAt(0.75);
    expect(second.pos[1]).toBeCloseTo(500, 4);
    expect(second.yaw).toBeCloseTo(Math.PI / 2, 4); // +Y 方向：+90°，不是 -90°

    // 关掉自动朝向就不该有 yaw
    v.unbindGPUPath(901);
    v.bindGPUPath(901, pathId, { speed: 1, phase: 0, loop: 'clamp', autoHeading: false });
    expect(poseAt(0.75).yaw).toBe(0);
    v.dispose();
  });
});
