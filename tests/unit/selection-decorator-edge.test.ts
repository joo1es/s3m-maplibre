import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import { SelectionDecorator, type SelectionHost } from '../../packages/s3m-three/src/render/viewer/SelectionDecorator.js';
import type { PickResult } from '../../packages/s3m-three/src/render/S3MViewer.js';
import type { S3MStyle } from '../../packages/s3m-three/src/render/StyleMaterial.js';

function createMockHost(style: S3MStyle = {}): {
  host: SelectionHost;
  pcStyles: Array<{ pc: THREE.Points; selected?: boolean }>;
  repaints: number;
} {
  const pcStyles: Array<{ pc: THREE.Points; selected?: boolean }> = [];
  let repaints = 0;

  const uniforms = {
    uSelMix: { value: 0 },
    uDim: { value: 0 },
    uEdgeWidth: { value: 2 },
    uEdgeColor: { value: new THREE.Color() },
  } as any;

  const outlineMaterial = {
    uniforms: {
      uSelBatch: { value: -1 },
      uSelWhole: { value: 0 },
      uElevation: { value: 0 },
      uBatchTex: { value: null },
      uBatchTexWidth: { value: 0 },
      uBatchTexActive: { value: 0 },
      uOutlineColor: { value: new THREE.Color() },
      uOutlineWidth: { value: 1 },
    },
  } as any;

  const selectionEdgeMaterial = {
    uniforms: {
      uColor: { value: new THREE.Color() },
      uWidth: { value: 2 },
      uScreenSize: { value: new THREE.Vector2() },
    },
  } as any;

  const host: SelectionHost = {
    uniforms,
    style,
    outlineMaterial,
    selectionEdgeMaterial,
    featureStyleManager: {
      featureStyles: new Map(),
      thematicElevation: new Map(),
    } as any,
    smidMeshes: new Map(),
    pointClouds: new Set(),
    applyPointCloudStyle: (pc, selected) => {
      pcStyles.push({ pc, selected });
    },
    onPick: () => {},
    requestRepaint: () => {
      repaints++;
    },
    createSelectionEdgeMaterial: () => ({ ...selectionEdgeMaterial }),
  };

  return { host, pcStyles, repaints };
}

describe('SelectionDecorator 选中修饰与轮廓分支', () => {
  it('点云对象的选中与取消选中', () => {
    const { host, pcStyles } = createMockHost();
    const decorator = new SelectionDecorator(host);

    const pc = new THREE.Points(new THREE.BufferGeometry());
    (pc as any).isPoints = true;
    const pcMat = new THREE.PointsMaterial();
    pcMat.userData = {
      isStyled: true,
      uSelBatch: { value: -1 },
      uSelWhole: { value: 0 },
    };
    pc.material = pcMat;

    const pickResult: PickResult = {
      mesh: pc as any,
      datasetId: 'pc-ds',
      batchId: -1,
      point: new THREE.Vector3(),
    };

    // 选中点云
    decorator.select(pickResult);
    expect(pcStyles.length).toBe(1);
    expect(pcStyles[0]).toEqual({ pc, selected: true });
    expect(decorator.selectedMeshes).toContain(pc);

    // 取消选中（传 null）-> 触发点云恢复
    decorator.select(null);
    expect(pcStyles.length).toBe(2);
    expect(pcStyles[1]).toEqual({ pc, selected: false });
    expect(decorator.selectedMeshes.length).toBe(0);
  });

  it('outlineStyle = "hull" 模式下生成外扩轮廓并挂载为子节点', () => {
    const { host } = createMockHost({
      outline: true,
      outlineStyle: 'hull',
      selectElevation: 10,
    });
    const decorator = new SelectionDecorator(host);

    const geom = new THREE.BoxGeometry(2, 2, 2);
    const mesh = new THREE.Mesh(geom);
    // 给材质打上 isStyled
    const mat = new THREE.MeshBasicMaterial();
    mat.userData = {
      isStyled: true,
      uSelBatch: { value: -1 },
      uSelWhole: { value: 0 },
    };
    mesh.material = mat;

    const pickResult: PickResult = {
      mesh,
      datasetId: 'bldg-ds',
      batchId: 5,
      point: new THREE.Vector3(),
    };

    decorator.select(pickResult);

    // 检查 outline material 的 uniforms 设置
    expect(host.outlineMaterial.uniforms.uSelBatch.value).toBe(5);
    expect(host.outlineMaterial.uniforms.uElevation.value).toBe(10);
    // mesh 的子节点应该包含了外扩轮廓
    expect(mesh.children.length).toBe(1);
    const outlineMesh = mesh.children[0] as THREE.Mesh;
    expect(outlineMesh.renderOrder).toBe(3);
    expect(outlineMesh.frustumCulled).toBe(false);

    // 取消选择时轮廓被移除
    decorator.select(null);
    expect(mesh.children.length).toBe(0);
  });

  it('实例化 Mesh 选中时执行 applyInstanceTransform', () => {
    const { host } = createMockHost({
      outline: true,
      outlineStyle: 'hull',
    });
    const decorator = new SelectionDecorator(host);

    const geom = new THREE.BoxGeometry(1, 1, 1);
    const im = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial(), 2);
    // 设置 instance 1 的位置在 (20, 30, 40)
    const m = new THREE.Matrix4().makeTranslation(20, 30, 40);
    im.setMatrixAt(1, m);
    im.instanceMatrix.needsUpdate = true;

    const pickResult: PickResult = {
      mesh: im as any,
      datasetId: 'tree-ds',
      batchId: 0,
      instanceIndex: 1,
      point: new THREE.Vector3(),
    };

    decorator.select(pickResult);

    // 检查轮廓 mesh 的位置是否继承了实例 1 的 (20, 30, 40)
    expect(im.children.length).toBe(1);
    const outline = im.children[0] as THREE.Mesh;
    expect(outline.position.x).toBeCloseTo(20);
    expect(outline.position.y).toBeCloseTo(30);
    expect(outline.position.z).toBeCloseTo(40);
  });

  it('reset 重置内部所有数组和选择状态', () => {
    const { host } = createMockHost();
    const decorator = new SelectionDecorator(host);

    decorator.selection = {} as any;
    decorator.selectedMeshes = [new THREE.Mesh()];
    decorator.reset();

    expect(decorator.selection).toBeNull();
    expect(decorator.selectedMeshes.length).toBe(0);
    expect(decorator.selectionEdgeMeshes.length).toBe(0);
  });
});
