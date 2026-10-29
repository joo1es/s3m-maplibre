import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import { HeightIndex } from '../../packages/s3m-three/src/render/viewer/HeightIndex.js';
import type { StyleUniforms } from '../../packages/s3m-three/src/core/types.js';

function createMockUniforms(): StyleUniforms {
  return {
    uHeightMin: { value: 0 },
    uHeightMax: { value: 0 },
  } as unknown as StyleUniforms;
}

function makeMeshWithHeight(minZ: number, maxZ: number): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, 0, minZ),
    new THREE.Vector3(1, 1, maxZ)
  );
  return new THREE.Mesh(geom);
}

describe('HeightIndex', () => {
  it('初始化时 size 为 0，range 为 Infinity / -Infinity', () => {
    const uniforms = createMockUniforms();
    const index = new HeightIndex(uniforms);

    expect(index.size).toBe(0);
    expect(index.range.min).toBe(Infinity);
    expect(index.range.max).toBe(-Infinity);
  });

  it('add 无效 mesh（无 boundingBox 或坐标 NaN）不入表', () => {
    const uniforms = createMockUniforms();
    const index = new HeightIndex(uniforms);

    const meshNoBB = new THREE.Mesh(new THREE.BufferGeometry());
    index.add(meshNoBB);
    expect(index.size).toBe(0);

    const meshNaN = makeMeshWithHeight(NaN, 10);
    index.add(meshNaN);
    expect(index.size).toBe(0);
  });

  it('add 正常 mesh 并维护 min / max 写入 uniforms', () => {
    const uniforms = createMockUniforms();
    const index = new HeightIndex(uniforms);

    const m1 = makeMeshWithHeight(10, 50);
    const m2 = makeMeshWithHeight(5, 40);
    const m3 = makeMeshWithHeight(20, 80);

    index.add(m1);
    expect(index.size).toBe(1);
    expect(index.range).toEqual({ min: 10, max: 50 });
    expect(uniforms.uHeightMin.value).toBe(10);
    expect(uniforms.uHeightMax.value).toBe(50);

    index.add(m2);
    expect(index.size).toBe(2);
    expect(index.range).toEqual({ min: 5, max: 50 });

    index.add(m3);
    expect(index.size).toBe(3);
    expect(index.range).toEqual({ min: 5, max: 80 });
    expect(uniforms.uHeightMin.value).toBe(5);
    expect(uniforms.uHeightMax.value).toBe(80);
  });

  it('remove 中间元素无需 recompute，移除边界元素触发 recompute', () => {
    const uniforms = createMockUniforms();
    const index = new HeightIndex(uniforms);

    const mMin = makeMeshWithHeight(0, 20);
    const mMid = makeMeshWithHeight(10, 30);
    const mMax = makeMeshWithHeight(5, 50);

    index.add(mMin);
    index.add(mMid);
    index.add(mMax);
    expect(index.range).toEqual({ min: 0, max: 50 });

    // 移除不在边界上的 mMid
    index.remove(mMid);
    expect(index.size).toBe(2);
    expect(index.range).toEqual({ min: 0, max: 50 });

    // 移除未添加的 mesh
    const mOther = makeMeshWithHeight(100, 200);
    index.remove(mOther);
    expect(index.size).toBe(2);

    // 移除处于极值的 mMin -> 触发 recompute，新的 min 变成 5
    index.remove(mMin);
    expect(index.size).toBe(1);
    expect(index.range).toEqual({ min: 5, max: 50 });
    expect(uniforms.uHeightMin.value).toBe(5);

    // 移除处于极值的 mMax -> 变空，min/max 重置
    index.remove(mMax);
    expect(index.size).toBe(0);
    expect(index.range).toEqual({ min: Infinity, max: -Infinity });
  });

  it('refreshAll 在矩阵或高程调整后重新遍历计算', () => {
    const uniforms = createMockUniforms();
    const index = new HeightIndex(uniforms);

    const m1 = makeMeshWithHeight(10, 20);
    index.add(m1);
    expect(index.range).toEqual({ min: 10, max: 20 });

    // 修改 m1 的世界矩阵平移 Z + 50
    m1.position.z = 50;
    m1.updateMatrixWorld();

    index.refreshAll();
    expect(index.size).toBe(1);
    expect(index.range).toEqual({ min: 60, max: 70 });
    expect(uniforms.uHeightMin.value).toBe(60);
    expect(uniforms.uHeightMax.value).toBe(70);

    // 空 index 调 refreshAll 安全无操作
    index.clear();
    index.refreshAll();
    expect(index.size).toBe(0);
  });

  it('clear 重置高度索引和缓存', () => {
    const uniforms = createMockUniforms();
    const index = new HeightIndex(uniforms);

    index.add(makeMeshWithHeight(10, 20));
    expect(index.size).toBe(1);

    index.clear();
    expect(index.size).toBe(0);
    expect(index.range).toEqual({ min: Infinity, max: -Infinity });
  });
});
