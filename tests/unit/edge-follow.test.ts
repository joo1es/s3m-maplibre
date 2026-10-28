/**
 * 单元测试：棱线跟随单体状态
 *
 * 单体的平移 / 拔高 / 隐藏写在每块网格自己的状态纹理里，主材质和拾取材质都采样它；
 * 棱线（全局棱线 + 选中棱线）以前不采样，单体一动棱线留在原地、隐藏了棱线还在。
 *
 * 这里钉住的契约：
 *   1. 棱线几何带 aBatchId（逐段归属单体）
 *   2. 棱线材质逐网格一份，但「外观」uniform 与全局共享同一批对象 —— 改一次全局生效
 *   3. 棱线材质的「单体状态」uniform 直接复用主材质 userData 里那几个对象 —— 自动跟随
 *   4. 选中棱线整批填选中单体的 batchId
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer, type PickResult } from '../../packages/s3m-three/src/render/S3MViewer';
import { buildThickLineGeometry } from '../../packages/s3m-three/src/render/EdgeLines';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

/** 造一块带 aBatchId 与单体信息的立方体网格（有棱可抽） */
function makeFeatureMesh(viewer: S3MViewer, smid: number, batchId: number): THREE.Mesh {
  const geo = new THREE.BoxGeometry(10, 10, 10);
  const n = geo.attributes.position.count;
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(n).fill(batchId), 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  const mat = createStyledMaterial({ uniforms: viewer.uniforms });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = {
    geoRef: {
      pickInfo: {
        [smid]: { batchId, segments: [{ vertexOffset: 0, vertexCount: n }] },
      },
    },
  };
  return mesh;
}

/** 锁死动画时钟，否则 to() 以 performance.now() 起步，tick(100) 的进度随进程启动时间漂移 */
function lockClock(viewer: S3MViewer): void {
  (viewer.animator as unknown as { _now: () => number })._now = () => 0;
}

function register(viewer: S3MViewer, mesh: THREE.Mesh): void {
  const group = new THREE.Group();
  group.add(mesh);
  (viewer as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
    { group, tile: null },
    { id: 'd', root: new THREE.Group() }
  );
}

const edgesOf = (mesh: THREE.Mesh): THREE.Mesh =>
  (mesh.userData as { edges?: THREE.Mesh }).edges as THREE.Mesh;

describe('1. buildThickLineGeometry 的 aBatchId', () => {
  const segs = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0]);

  test('按段填 batchId（每段 4 个顶点共享）', () => {
    const geo = buildThickLineGeometry(segs, [5, 7]);
    expect(Array.from(geo.getAttribute('aBatchId').array)).toEqual([5, 5, 5, 5, 7, 7, 7, 7]);
  });

  test('不传 batchIds 全填 -1，着色器跳过采样', () => {
    const geo = buildThickLineGeometry(segs);
    expect(Array.from(geo.getAttribute('aBatchId').array)).toEqual([-1, -1, -1, -1, -1, -1, -1, -1]);
  });
});

describe('2. 全局棱线：逐网格材质 + 共享外观', () => {
  test('棱线材质不再共用全局材质实例，但外观 uniform 是同一批对象', () => {
    const v = new S3MViewer();
    v.setEdges(true);
    const mesh = makeFeatureMesh(v, 101, 0);
    register(v, mesh);

    const edges = edgesOf(mesh);
    expect(edges).toBeTruthy();
    // 材质必须独立（要绑各自的 batch 纹理）
    expect(edges.material).not.toBe(v.edgeMaterial);
    // 外观必须是同一批对象：改一次全局，所有棱线生效
    expect((edges.material as THREE.ShaderMaterial).uniforms.uColor).toBe(v.edgeMaterial.uniforms.uColor);
    expect((edges.material as THREE.ShaderMaterial).uniforms.uOpacity).toBe(v.edgeMaterial.uniforms.uOpacity);
    expect((edges.material as THREE.ShaderMaterial).uniforms.uWidth).toBe(v.edgeMaterial.uniforms.uWidth);
  });

  test('改全局棱线颜色，逐网格材质同步生效', () => {
    const v = new S3MViewer();
    v.setEdges(true);
    const mesh = makeFeatureMesh(v, 102, 0);
    register(v, mesh);

    v.setStyle({ edgeColor: '#ff0000' });
    const edges = edgesOf(mesh);
    expect((edges.material as THREE.ShaderMaterial).uniforms.uColor.value.getHexString()).toBe('ff0000');
  });

  test('棱线的单体状态 uniform 直接复用主材质的对象，自动跟随', () => {
    const v = new S3MViewer();
    v.setEdges(true);
    const mesh = makeFeatureMesh(v, 103, 0);
    register(v, mesh);

    const styled = mesh.material as unknown as {
      userData: { uBatchTex: { value: unknown }; uBatchTexActive: { value: number } };
    };
    const edges = edgesOf(mesh);
    expect((edges.material as THREE.ShaderMaterial).uniforms.uBatchTex).toBe(styled.userData.uBatchTex);
    expect((edges.material as THREE.ShaderMaterial).uniforms.uBatchTexActive).toBe(styled.userData.uBatchTexActive);
  });

  test('移动单体：状态纹理写进平移量，棱线采样同一份纹理', () => {
    const v = new S3MViewer();
    v.setEdges(true);
    const mesh = makeFeatureMesh(v, 104, 0);
    lockClock(v);
    register(v, mesh);

    v.moveFeature(104, [50, 0, 0], { duration: 100 });
    v.animator.tick(100);
    // 通道写的是 featureStyles，状态纹理要等 flush 才重烘
    v.flushOverrides();

    const styled = mesh.material as unknown as {
      userData: { uBatchTex: { value: { image: { data: Float32Array; width: number } } } };
    };
    const data = styled.userData.uBatchTex.value.image.data;
    // Row 2 x 分量（w + batchId) * 4 + 0
    expect(data[4 + 0]).toBeCloseTo(50, 4);
    // 棱线材质采的就是同一个纹理对象，所以它自然会跟着移动
    const edges = edgesOf(mesh);
    expect((edges.material as THREE.ShaderMaterial).uniforms.uBatchTex.value).toBe(styled.userData.uBatchTex.value);
  });

  test('_ensureEdges 回填的 aBatchId 与 pickInfo 一致', () => {
    const v = new S3MViewer();
    v.setEdges(true);
    const mesh = makeFeatureMesh(v, 105, 3);
    register(v, mesh);

    const edges = edgesOf(mesh);
    const arr = Array.from(edges.geometry.getAttribute('aBatchId').array as Float32Array);
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.every((x) => x === 3)).toBe(true);
  });

  test('隐藏单体：棱线材质读到同一个 active 标记，顶点着色器据此丢弃', () => {
    const v = new S3MViewer();
    v.setEdges(true);
    const mesh = makeFeatureMesh(v, 106, 0);
    register(v, mesh);

    v.setFeatureStyle(106, { hidden: true });
    v.flushOverrides();

    const styled = mesh.material as unknown as { userData: { uBatchTexActive: { value: number } } };
    expect(styled.userData.uBatchTexActive.value).toBe(1);
    const edges = edgesOf(mesh);
    expect((edges.material as THREE.ShaderMaterial).uniforms.uBatchTexActive.value).toBe(1);
  });
});

describe('3. 选中棱线跟随', () => {
  function pick(viewer: S3MViewer, mesh: THREE.Mesh, smid: number, batchId: number): PickResult {
    return {
      datasetId: 'd',
      datasetName: 'd',
      objectId: (mesh.userData as { pickId: number }).pickId,
      batchId,
      smid,
      skeletonName: '',
      centerLngLat: null,
      point: [0, 0, 0],
      lngLat: null,
      altitude: 0,
      mesh,
    };
  }

  test('选中棱线整批填选中单体的 batchId', () => {
    const v = new S3MViewer();
    const mesh = makeFeatureMesh(v, 201, 2);
    register(v, mesh);
    v.select(pick(v, mesh, 201, 2));

    const sel = (v as unknown as { _selectionEdgeMeshes: THREE.Mesh[] })._selectionEdgeMeshes[0];
    expect(sel).toBeTruthy();
    const arr = Array.from(sel.geometry.getAttribute('aBatchId').array as Float32Array);
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.every((x) => x === 2)).toBe(true);
  });

  test('选中棱线外观共享、状态纹理共享主材质', () => {
    const v = new S3MViewer();
    const mesh = makeFeatureMesh(v, 202, 0);
    register(v, mesh);
    v.select(pick(v, mesh, 202, 0));

    const sel = (v as unknown as { _selectionEdgeMeshes: THREE.Mesh[] })._selectionEdgeMeshes[0];
    expect((sel.material as THREE.ShaderMaterial).uniforms.uColor).toBe(v.selectionEdgeMaterial.uniforms.uColor);

    const styled = mesh.material as unknown as {
      userData: { uBatchTex: { value: unknown } };
    };
    expect((sel.material as THREE.ShaderMaterial).uniforms.uBatchTex).toBe(styled.userData.uBatchTex);
  });

  test('选中后平移单体，选中棱线采样同一份状态纹理', () => {
    const v = new S3MViewer();
    const mesh = makeFeatureMesh(v, 203, 0);
    lockClock(v);
    register(v, mesh);
    v.select(pick(v, mesh, 203, 0));

    const sel = (v as unknown as { _selectionEdgeMeshes: THREE.Mesh[] })._selectionEdgeMeshes[0];
    const styled = mesh.material as unknown as {
      userData: { uBatchTex: { value: { image: { data: Float32Array; width: number } } } };
    };
    v.moveFeature(203, [30, 0, 0], { duration: 100 });
    v.animator.tick(100);
    v.flushOverrides();

    const data = styled.userData.uBatchTex.value.image.data;
    expect(data[4 + 0]).toBeCloseTo(30, 4);
    expect((sel.material as THREE.ShaderMaterial).uniforms.uBatchTex.value).toBe(styled.userData.uBatchTex.value);
  });

  test('选中棱线只加全局 selectElevation，单体自身拔高由状态纹理带出（不双重拔高）', () => {
    const v = new S3MViewer();
    const mesh = makeFeatureMesh(v, 204, 0);
    register(v, mesh);
    v.select(pick(v, mesh, 204, 0));
    v.setStyle({ selectElevation: 30 });

    const sel = (v as unknown as { _selectionEdgeMeshes: THREE.Mesh[] })._selectionEdgeMeshes[0];
    expect((sel.material as THREE.ShaderMaterial).uniforms.uElevation.value).toBe(30);
  });
});
