/**
 * 单元测试：棱线开关必须随 style.edges 在构造时生效
 *
 * 修复前：构造函数里 this.style 来自 options，但从不调用 setEdges，
 * _edgesEnabled 写死为 false —— 于是 `style: { edges: true }` 形同虚设，
 * 棱线永远不会出现（除非事后手动 setEdges）。这里把这个契约钉死。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { mergeVerticesByPosition } from '../../packages/s3m-three/src/render/MergeVertices';

function makeBoxMesh(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.computeBoundingBox();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
}

function registerBox(viewer: S3MViewer): THREE.Mesh {
  const group = new THREE.Group();
  const mesh = makeBoxMesh();
  group.add(mesh);
  (viewer as any)._registerTile({ group, tile: null }, { id: 'd', root: new THREE.Group() });
  return mesh;
}

describe('棱线开关随 style.edges 在构造时生效', () => {
  test('1. 默认 style.edges=false → _edgesEnabled 为 false，注册 mesh 无棱线', () => {
    const v = new S3MViewer();
    expect((v as any)._edgesEnabled).toBe(false);
    expect(v.style.edges).toBe(false);

    const mesh = registerBox(v);
    expect((mesh.userData as any).edges).toBeFalsy();
  });

  test('2. style.edges=true → 构造时即启用，且之后注册的 mesh 自动建棱线', () => {
    const v = new S3MViewer({ style: { edges: true } });
    expect((v as any)._edgesEnabled).toBe(true);
    expect(v.style.edges).toBe(true);

    const mesh = registerBox(v);
    // CPU 端棱线应被建出来并挂到 mesh.userData.edges
    expect((mesh.userData as any).edges).toBeTruthy();
  });

  test('3. 构造后再调 setEdges(false) 能关掉，且清理已建棱线', () => {
    const v = new S3MViewer({ style: { edges: true } });
    const mesh = registerBox(v);
    expect((mesh.userData as any).edges).toBeTruthy();

    v.setEdges(false);
    expect((v as any)._edgesEnabled).toBe(false);
    expect((mesh.userData as any).edges).toBeFalsy();
  });
});

describe('_ensureEdges：顶点焊合 + 临界角 + 过滤', () => {
  /**
   * 「翻开的书」几何：两个三角形共享 AB 边，两面法线夹角 45°。
   * 注意 winding 必须让共享边被反向遍历（T1 走 A→B、T2 走 B→A），
   * 否则这版 three 的 EdgesGeometry 配不上对，会把共享棱当边界棱、阈值失效。
   * 4 条边界棱永远画；共享棱只在「法线夹角 > threshold」时画：
   * threshold=1° → 5 条棱；threshold=80° → 4 条棱。
   */
  function makeOpenBook(): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 0, 0.5, 0.5, -0.707, -0.707]),
        3
      )
    );
    geo.setIndex([0, 1, 2, 1, 0, 3]);
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  }

  function edgeCount(mesh: THREE.Mesh): number {
    const lines = (mesh.userData as any).edges as THREE.Mesh | null;
    if (!lines) return 0;
    // buildThickLineGeometry 把每条线段摊成 4 顶点四边形（12 个 float / 段）
    return (lines.geometry.getAttribute('position').array as Float32Array).length / 12;
  }

  test('4. style.edgeThreshold 生效：低阈值多画共享棱，高阈值只留边界棱', () => {
    const v = new S3MViewer();
    const mesh = makeOpenBook();

    v.setStyle({ edgeThreshold: 1 });
    (v as any)._ensureEdges(mesh);
    expect(edgeCount(mesh)).toBe(5); // 45° 夹角 > 1°，共享棱保留

    (v as any)._removeEdges(mesh);
    v.setStyle({ edgeThreshold: 80 });
    (v as any)._ensureEdges(mesh);
    expect(edgeCount(mesh)).toBe(4); // 45° < 80°，共享棱被滤掉，只剩 4 条边界棱
  });

  test('5. skeletonName 命中地形/绿地关键字 → 跳过自动描边', () => {
    const v = new S3MViewer({ style: { edges: true } });
    const group = new THREE.Group();
    const mesh = makeBoxMesh();
    (mesh.userData as any).skeletonName = 'Terrain_dem_0'; // 注册前就要设好
    group.add(mesh);
    (v as any)._registerTile({ group, tile: null }, { id: 'd', name: 'city', root: new THREE.Group() });
    expect((mesh.userData as any).edges).toBeFalsy();
  });

  test('6. 数据集 enableEdges=false 强制关闭（即使全局开）；=true 强制开启（即使全局关）', () => {
    // 全局开 + 数据集关
    const v1 = new S3MViewer({ style: { edges: true } });
    const g1 = new THREE.Group();
    const m1 = makeBoxMesh();
    g1.add(m1);
    (v1 as any)._registerTile(
      { group: g1, tile: null },
      { id: 'd1', name: 'roof', options: { enableEdges: false }, root: new THREE.Group() }
    );
    expect((m1.userData as any).edges).toBeFalsy();

    // 全局关 + 数据集开
    const v2 = new S3MViewer();
    const g2 = new THREE.Group();
    const m2 = makeBoxMesh();
    g2.add(m2);
    (v2 as any)._registerTile(
      { group: g2, tile: null },
      { id: 'd2', name: 'building', options: { enableEdges: true }, root: new THREE.Group() }
    );
    expect((m2.userData as any).edges).toBeTruthy();
  });

  test('7. mergeVerticesByPosition：每面独立顶点（各自 UV）也能按位置焊合', () => {
    // 两个三角形共享 AB 边，但 6 个顶点各自独立（S3M 典型形态：每面独立顶点 + 各自 UV）
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([
          0, 0, 0, 1, 0, 0, 0.5, 0, 0.5, // T1: A B C
          1, 0, 0, 0, 0, 0, 0.5, -0.707, -0.707, // T2: B A D（反向遍历共享边）
        ]),
        3
      )
    );
    const welded = mergeVerticesByPosition(geo, 0.005);
    // 6 个原始顶点 → 4 个唯一位置（A、B 各出现两次被合并）
    expect(welded.getAttribute('position').count).toBe(4);
    expect(welded.getIndex()!.count).toBe(6);

    // 焊合后 EdgesGeometry 能识别共享边：阈值 1° → 5 条棱（含共享棱）
    const e = new THREE.EdgesGeometry(welded, 1);
    expect((e.getAttribute('position').array as Float32Array).length / 6).toBe(5);
  });
});
