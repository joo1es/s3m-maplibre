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
