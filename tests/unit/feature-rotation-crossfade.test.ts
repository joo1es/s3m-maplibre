/**
 * P1 (双纹理 GPU 交叉淡化) 与 P2 (单体 5 行状态纹理姿态旋转) 单元测试
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  S3MViewer,
  resolveRotationMatrix,
  extractEulerAngles,
  createSharedUniforms,
  createStyledMaterial,
} from '../../packages/s3m-three/src/index.js';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer.js';

function makeViewer(): S3MViewer {
  let t = 0;
  const v = new S3MViewer();
  (v.animator as unknown as { _now: () => number })._now = () => t;
  (v as unknown as { _testSetNow: (n: number) => void })._testSetNow = (n) => (t = n);
  return v;
}

function stepTo(v: S3MViewer, t: number): boolean {
  (v as unknown as { _testSetNow: (n: number) => void })._testSetNow(t);
  return v.animator.tick(t);
}

function registerMesh(viewer: S3MViewer, smid: number, batchId = 0): THREE.Mesh {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(10, 10, 10);
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: viewer.uniforms }));
  mesh.userData = { geoRef: { pickInfo: { [smid]: { batchId } } } };
  group.add(mesh);
  (viewer as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
    { group, tile: null },
    { id: 'd', root: new THREE.Group() }
  );
  return mesh;
}

describe('P2. 单体姿态旋转 (5 行状态纹理与 3x3 矩阵)', () => {
  test('resolveRotationMatrix 支持数字 (Yaw)、欧拉角数组、四元数数组与 Three.js 对象', () => {
    // 1. 纯数字：绕 Z 轴旋转 90 度
    const rotZ90 = resolveRotationMatrix(Math.PI / 2);
    expect(rotZ90).toBeTruthy();
    expect(Math.abs(rotZ90![0])).toBeLessThan(1e-6); // cos(pi/2) ≈ 0
    expect(rotZ90![1]).toBeCloseTo(-1, 5); // -sin(pi/2) = -1
    expect(rotZ90![3]).toBeCloseTo(1, 5);  // sin(pi/2) = 1
    expect(Math.abs(rotZ90![4])).toBeLessThan(1e-6); // cos(pi/2) ≈ 0
    expect(rotZ90![8]).toBe(1);

    // 2. 欧拉角数组 [0, 0, Math.PI / 2]
    const rotEulerArr = resolveRotationMatrix([0, 0, Math.PI / 2]);
    expect(rotEulerArr).toBeTruthy();
    expect(rotEulerArr![1]).toBeCloseTo(-1, 5);
    expect(rotEulerArr![3]).toBeCloseTo(1, 5);

    // 3. 四元数数组
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const rotQuatArr = resolveRotationMatrix([q.x, q.y, q.z, q.w]);
    expect(rotQuatArr).toBeTruthy();
    expect(rotQuatArr![1]).toBeCloseTo(-1, 5);
    expect(rotQuatArr![3]).toBeCloseTo(1, 5);

    // 4. THREE.Euler
    const rotEuler = resolveRotationMatrix(new THREE.Euler(0, 0, Math.PI / 2));
    expect(rotEuler).toBeTruthy();
    expect(rotEuler![1]).toBeCloseTo(-1, 5);

    // 5. THREE.Quaternion
    const rotQuat = resolveRotationMatrix(q);
    expect(rotQuat).toBeTruthy();
    expect(rotQuat![1]).toBeCloseTo(-1, 5);

    // 6. null / undefined 返回 null
    expect(resolveRotationMatrix(null)).toBeNull();
    expect(resolveRotationMatrix(undefined)).toBeNull();
  });

  test('extractEulerAngles 正确提取各个表示的欧拉角分量', () => {
    expect(extractEulerAngles(Math.PI / 3)).toEqual([0, 0, Math.PI / 3]);
    expect(extractEulerAngles([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
    expect(extractEulerAngles(null)).toEqual([0, 0, 0]);
  });

  test('状态纹理扩展为 5 行，默认单位矩阵，有旋转与轴心时正确写入 Row 2~4', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 201, 0);

    // 初始状态：无旋转无样式时 uBatchTexActive = 0
    expect((mesh.material as any).userData.uBatchTexActive.value).toBe(0);

    // 设置旋转 90 度与轴心 [10, 20, 30]
    v.setFeatureStyle(201, {
      rotation: Math.PI / 2,
      pivot: [10, 20, 30],
    });
    (v as any)._applyOverridesToMesh(mesh);

    const tex = (mesh.material as any).userData.uBatchTex.value as THREE.DataTexture;
    expect(tex).toBeTruthy();
    expect(tex.image.height).toBe(6);

    const data = tex.image.data as unknown as Float32Array;
    const w = tex.image.width;

    // Row 2: [R00, R01, R02, pivot.x]
    const r2 = (w * 2 + 0) * 4;
    expect(Math.abs(data[r2 + 0])).toBeLessThan(1e-6);
    expect(data[r2 + 1]).toBeCloseTo(-1, 5);
    expect(data[r2 + 2]).toBe(0);
    expect(data[r2 + 3]).toBe(10); // pivot.x

    // Row 3: [R10, R11, R12, pivot.y]
    const r3 = (w * 3 + 0) * 4;
    expect(data[r3 + 0]).toBeCloseTo(1, 5);
    expect(Math.abs(data[r3 + 1])).toBeLessThan(1e-6);
    expect(data[r3 + 2]).toBe(0);
    expect(data[r3 + 3]).toBe(20); // pivot.y

    // Row 4: [R20, R21, R22, pivot.z]
    const r4 = (w * 4 + 0) * 4;
    expect(data[r4 + 0]).toBe(0);
    expect(data[r4 + 1]).toBe(0);
    expect(data[r4 + 2]).toBe(1);
    expect(data[r4 + 3]).toBe(30); // pivot.z
  });

  test('rotateFeature 逐帧动画推进与视锥剔除控制', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 301, 0);

    expect(mesh.frustumCulled).toBe(true);

    // 启动旋转动画：从 0 到 Math.PI，时长 100ms
    v.rotateFeature(301, Math.PI, [0, 0, 0], { duration: 100, easing: 'linear' });

    // 旋转中：自动关闭视锥剔除
    stepTo(v, 50);
    v.flushOverrides();
    expect(mesh.frustumCulled).toBe(false);

    const midSt = v.getFeatureStyle(301);
    expect(midSt?.rotation).toBeTruthy();
    const midEuler = extractEulerAngles(midSt?.rotation);
    expect(midEuler[2]).toBeCloseTo(Math.PI / 2, 2);

    // 走完 100ms
    stepTo(v, 100);
    v.flushOverrides();
    const endEuler = extractEulerAngles(v.getFeatureStyle(301)?.rotation);
    expect(endEuler[2]).toBeCloseTo(Math.PI, 4);

    // 旋转回 0 时恢复视锥剔除
    v.rotateFeature(301, 0, undefined, { duration: 50, easing: 'linear' });
    stepTo(v, 150);
    v.flushOverrides();
    expect(mesh.frustumCulled).toBe(true);
  });

  test('rotateFeatureBy 便捷增量旋转', () => {
    const v = makeViewer();
    registerMesh(v, 401, 0);

    v.setFeatureStyle(401, { rotation: 0.2 });
    v.rotateFeatureBy(401, 0.3); // 瞬时增加 0.3
    const st = v.getFeatureStyle(401);
    const euler = extractEulerAngles(st?.rotation);
    expect(euler[2]).toBeCloseTo(0.5, 4);
  });
});

describe('P1. GPU 双纹理交叉淡化 (crossFadeStyles)', () => {
  test('StyleMaterial 与 uniforms 包含 uBatchMix 与 uBatchTex2', () => {
    const shared = createSharedUniforms();
    expect(shared.uBatchMix).toBeTruthy();
    expect(shared.uBatchMix!.value).toBe(0);

    const mat = createStyledMaterial({ uniforms: shared });
    expect(mat.userData.uBatchTex).toBeTruthy();
    expect(mat.userData.uBatchTex2).toBeTruthy();
  });

  test('crossFadeStyles 在无过渡时长时立即生效', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 501, 0);

    v.setFeatureStyle(501, { color: '#ff0000' });
    (v as any)._applyOverridesToMesh(mesh);

    // 交叉淡化到绿色
    v.crossFadeStyles({ 501: { color: '#00ff00' } });

    expect(v.uniforms.uBatchMix!.value).toBe(0);
    const cur = v.getFeatureStyle(501);
    expect(cur?.color).toBe('#00ff00');
  });

  test('crossFadeStyles 带时长时逐帧驱动 uBatchMix，并在结束时提交目标状态', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 601, 0);

    v.setFeatureStyle(601, { color: '#ff0000' });
    (v as any)._applyOverridesToMesh(mesh);

    let completed = false;
    v.crossFadeStyles(
      { 601: { color: '#0000ff' } },
      { duration: 200, easing: 'linear', onComplete: () => { completed = true; } }
    );

    // 动画启动：uBatchTex2 已绑定
    const mat = mesh.material as any;
    expect(mat.userData.uBatchTex2.value).toBeTruthy();
    expect(v.animator.has('batch.mix')).toBe(true);

    // 推进到一半 100ms
    stepTo(v, 100);
    expect(v.uniforms.uBatchMix!.value).toBeCloseTo(0.5, 2);
    expect(completed).toBe(false);

    // 推进结束 200ms
    stepTo(v, 200);
    expect(completed).toBe(true);
    // 结束后 uBatchMix 复位为 0
    expect(v.uniforms.uBatchMix!.value).toBe(0);
    // featureStyles 已更新为目标状态
    expect(v.getFeatureStyle(601)?.color).toBe('#0000ff');
  });

  test('S3MLayer 透传 crossFadeStyles, rotateFeature 与 rotateFeatureBy', () => {
    const layer = new S3MLayer({ id: 'test-maplibre-api' });
    registerMesh(layer.viewer, 701, 0);

    layer.setFeatureStyle(701, { color: '#ffffff' });
    layer.rotateFeature(701, Math.PI / 4);
    const r = extractEulerAngles(layer.getFeatureStyle(701)?.rotation);
    expect(r[2]).toBeCloseTo(Math.PI / 4, 4);

    layer.rotateFeatureBy(701, Math.PI / 4);
    const r2 = extractEulerAngles(layer.getFeatureStyle(701)?.rotation);
    expect(r2[2]).toBeCloseTo(Math.PI / 2, 4);

    layer.crossFadeStyles({ 701: { color: '#123456' } });
    expect(layer.getFeatureStyle(701)?.color).toBe('#123456');
  });

  test('棱线跟随：单体旋转平移时，棱线材质同步绑定 5 行状态纹理与 uBatchMix', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 801, 0);

    // 开启棱线
    v.setEdges(true);
    (v as any)._ensureEdges(mesh);

    const edgeLine = (mesh.userData as any).edges as THREE.Mesh;
    expect(edgeLine).toBeTruthy();

    const edgeMat = edgeLine.material as any;
    expect(edgeMat.uniforms.uBatchTex).toBe((mesh.material as any).userData.uBatchTex);
    expect(edgeMat.uniforms.uBatchTex2).toBe((mesh.material as any).userData.uBatchTex2);
    expect(edgeMat.uniforms.uBatchMix).toBe(v.uniforms.uBatchMix);

    // 旋转并平移单体
    v.setFeatureStyle(801, {
      translation: [10, 20, 30],
      rotation: Math.PI / 2,
      pivot: [5, 5, 0],
    });
    (v as any)._applyOverridesToMesh(mesh);

    const tex = edgeMat.uniforms.uBatchTex.value as THREE.DataTexture;
    expect(tex.image.height).toBe(6);

    const data = tex.image.data as unknown as Float32Array;
    const w = tex.image.width;

    // Row 1 平移验证
    const r1 = (w * 1 + 0) * 4;
    expect(data[r1 + 0]).toBe(10);
    expect(data[r1 + 1]).toBe(20);
    expect(data[r1 + 2]).toBe(30);

    // Row 2 旋转矩阵与轴心验证
    const r2 = (w * 2 + 0) * 4;
    expect(Math.abs(data[r2 + 0])).toBeLessThan(1e-6);
    expect(data[r2 + 1]).toBeCloseTo(-1, 5);
    expect(data[r2 + 3]).toBe(5); // pivot.x
  });
});
