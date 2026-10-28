/**
 * 单元测试：无 SMID 单体化瓦片（如索菲亚教堂等倾斜摄影）在 LOD 更新时的选中状态持久性
 *
 * 验证：
 * 1. 无 SMID 瓦片（smid === null / undefined）在选中时，整块网格被标记高亮 (uSelWhole = 1)；
 * 2. 当发生 LOD 细化（新瓦片注册进入 _registerTile）时：
 *    - 空间上覆盖命中点 (sel.point) 的新子瓦片自动继承选中状态 (uSelWhole = 1) 并加入 _selectedMeshes；
 * 3. 当旧父瓦片在 _unregisterTile 中淘汰注销时：
 *    - 选中身份自动平滑转移给接替显示的子网格 (carrier)，_selection 绝不会被置空为 null；
 * 4. 主动调用 select(null) 时正确清空所有选中网格状态。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer, type PickResult } from '../../packages/s3m-three/src/render/S3MViewer';

function createMockStyledMesh(box?: { min: [number, number, number]; max: [number, number, number] }): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  // 简单顶点数据
  const positions = new Float32Array([
    -10, -10, 0,
     10, -10, 0,
     10,  10, 0,
  ]);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (box) {
    geom.boundingBox = new THREE.Box3(
      new THREE.Vector3(...box.min),
      new THREE.Vector3(...box.max)
    );
    geom.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        (box.min[2] + box.max[2]) / 2
      ),
      20
    );
  }

  const mat = new THREE.MeshBasicMaterial() as any;
  mat.userData = {
    isStyled: true,
    uSelBatch: { value: -1 },
    uSelWhole: { value: 0 },
  };

  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData = {
    pickId: Math.floor(Math.random() * 10000),
    datasetId: 'default',
  };
  return mesh;
}

describe('无 SMID 瓦片（倾斜摄影）LOD 选中持久性', () => {
  test('1. 无 SMID 时选中 mesh 整块高亮 (uSelWhole = 1)', () => {
    const viewer = new S3MViewer() as any;
    const mesh = createMockStyledMesh();

    const parentGroup = new THREE.Group();
    parentGroup.add(mesh);
    viewer.scene.add(parentGroup);

    const pickRes: PickResult = {
      datasetId: 'default',
      datasetName: 'default',
      objectId: mesh.userData.pickId,
      batchId: -1,
      smid: null,
      skeletonName: '',
      centerLngLat: null,
      point: [0, 0, 5],
      lngLat: [126.62, 45.76],
      altitude: 125,
      mesh,
    };

    viewer.select(pickRes);

    expect(viewer._selection).not.toBeNull();
    expect(viewer._selection.mesh).toBe(mesh);
    expect(viewer._selectedMeshes).toContain(mesh);
    expect((mesh.material as any).userData.uSelWhole.value).toBe(1);
    expect((mesh.material as any).userData.uSelBatch.value).toBe(-1);
  });

  test('2. LOD 细化注册新子瓦片时，覆盖命中点 (sel.point) 的新 mesh 自动继承高亮', () => {
    const viewer = new S3MViewer() as any;
    const parentMesh = createMockStyledMesh({ min: [-50, -50, 0], max: [50, 50, 20] });
    const parentGroup = new THREE.Group();
    parentGroup.add(parentMesh);
    viewer.scene.add(parentGroup);

    // 选中命中点为 (10, 10, 5)
    const pickRes: PickResult = {
      datasetId: 'default',
      datasetName: 'default',
      objectId: parentMesh.userData.pickId,
      batchId: -1,
      smid: null,
      skeletonName: '',
      centerLngLat: null,
      point: [10, 10, 5],
      lngLat: [126.62, 45.76],
      altitude: 125,
      mesh: parentMesh,
    };
    viewer.select(pickRes);

    // 创建接替显示的子瓦片，包围盒精确覆盖 (10, 10, 5)
    const childMeshMatch = createMockStyledMesh({ min: [0, 0, 0], max: [25, 25, 20] });
    const childGroupMatch = new THREE.Group();
    childGroupMatch.add(childMeshMatch);

    // 另一个兄弟子瓦片，不覆盖命中点
    const childMeshOther = createMockStyledMesh({ min: [-25, -25, 0], max: [-1, -1, 20] });
    const childGroupOther = new THREE.Group();
    childGroupOther.add(childMeshOther);

    const datasetEntry = { id: 'default', root: new THREE.Group() };

    // 模拟子瓦片注册
    viewer._registerTile({ group: childGroupMatch, tile: {} }, datasetEntry);
    viewer._registerTile({ group: childGroupOther, tile: {} }, datasetEntry);

    // 覆盖点位的子网格应自动被标记高亮并加入 _selectedMeshes
    expect((childMeshMatch.material as any).userData.uSelWhole.value).toBe(1);
    expect(viewer._selectedMeshes).toContain(childMeshMatch);

    // 未覆盖的兄弟瓦片不得误高亮
    expect((childMeshOther.material as any).userData.uSelWhole.value).toBe(0);
    expect(viewer._selectedMeshes).not.toContain(childMeshOther);
  });

  test('3. 旧父瓦片注销淘汰时，选中身份自动交给活跃子网格，不被清空', () => {
    const viewer = new S3MViewer() as any;
    let onPickCalledWithNull = false;
    viewer.onPick = (res: any) => {
      if (res === null) onPickCalledWithNull = true;
    };

    const parentMesh = createMockStyledMesh({ min: [-50, -50, 0], max: [50, 50, 20] });
    const parentGroup = new THREE.Group();
    parentGroup.add(parentMesh);
    viewer.scene.add(parentGroup);

    const pickRes: PickResult = {
      datasetId: 'default',
      datasetName: 'default',
      objectId: parentMesh.userData.pickId,
      batchId: -1,
      smid: null,
      skeletonName: '',
      centerLngLat: null,
      point: [10, 10, 5],
      lngLat: [126.62, 45.76],
      altitude: 125,
      mesh: parentMesh,
    };
    viewer.select(pickRes);

    // 子网格已就绪并继承了选中
    const childMesh = createMockStyledMesh({ min: [0, 0, 0], max: [25, 25, 20] });
    const childGroup = new THREE.Group();
    childGroup.add(childMesh);
    viewer.scene.add(childGroup);

    const datasetEntry = { id: 'default', root: new THREE.Group() };
    viewer._registerTile({ group: childGroup, tile: {} }, datasetEntry);
    expect(viewer._selectedMeshes).toContain(childMesh);

    // 此时淘汰注销父瓦片
    viewer._unregisterTile({ group: parentGroup, tile: {} }, datasetEntry);

    // 选中状态绝不能被置空！carrier 应自动更新为 childMesh
    expect(viewer._selection).not.toBeNull();
    expect(viewer._selection.mesh).toBe(childMesh);
    expect(viewer._selectedMeshes).toContain(childMesh);
    expect(viewer._selectedMeshes).not.toContain(parentMesh);
    expect(onPickCalledWithNull).toBe(false);
  });

  test('4. 用户主动 select(null) 时清空所有状态', () => {
    const viewer = new S3MViewer() as any;
    const mesh = createMockStyledMesh();
    const parentGroup = new THREE.Group();
    parentGroup.add(mesh);
    viewer.scene.add(parentGroup);

    viewer.select({
      datasetId: 'default',
      datasetName: 'default',
      objectId: mesh.userData.pickId,
      batchId: -1,
      skeletonName: '',
      centerLngLat: null,
      point: [0, 0, 0],
      lngLat: null,
      altitude: null,
      mesh,
    });

    expect(viewer._selection).not.toBeNull();
    viewer.select(null);

    expect(viewer._selection).toBeNull();
    expect(viewer._selectedMeshes).toHaveLength(0);
    expect((mesh.material as any).userData.uSelWhole.value).toBe(0);
  });
});
