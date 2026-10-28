/**
 * 单元测试：materialQuality 运行时切换（pbr ↔ lambert）
 *
 * 动机：`materialQuality` 原来只在构造时生效（模块级 setMaterialQuality），
 * 运行时切换只影响之后新建的材质，已加载瓦片保持旧质感。新增
 * `S3MViewer.setMaterialQuality(q)`：设全局档位 + 原位重建现有 styled 材质
 * （不重拉瓦片、不重建几何），并保留逐材质状态（选中编号、瓦片淡入）。
 *
 * 不依赖 WebGL：用 makeViewer + registerMesh 的既有模式验证。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { createStyledMaterial, getMaterialQuality } from '../../packages/s3m-three/src/render/StyleMaterial';

function makeViewer(): S3MViewer {
  return new S3MViewer({ canvas: null as never, container: null as never });
}

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

describe('setMaterialQuality 运行时切换', () => {
  test('pbr → lambert：材质类变为 MeshLambert，全局档位同步', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 910);
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial); // 默认 pbr

    v.setMaterialQuality('lambert');
    expect(getMaterialQuality()).toBe('lambert');
    expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    v.dispose();
  });

  test('lambert → pbr：切回 MeshStandard，且是换新材质而不是原地改类', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 911);
    v.setMaterialQuality('lambert');
    const lambert = mesh.material as THREE.Material;
    v.setMaterialQuality('pbr');
    const back = mesh.material as THREE.Material;
    expect(back).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(back).not.toBe(lambert);
    v.dispose();
  });

  test('重建保留逐材质状态：瓦片淡入系数不丢', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 912);
    const before = mesh.material as THREE.MeshStandardMaterial;
    (before.userData.uTileFade as { value: number }).value = 0.42;

    v.setMaterialQuality('lambert');
    const after = mesh.material as THREE.MeshLambertMaterial;
    expect((after.userData.uTileFade as { value: number }).value).toBe(0.42);
    v.dispose();
  });

  test('重建后共享 uniform 仍是同一引用（shading/透明度等全局状态不失效）', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 913);
    v.setMaterialQuality('lambert');
    const after = mesh.material as THREE.MeshLambertMaterial;
    expect(after.userData.uFlatShading).toBe(v.uniforms.uFlatShading);
    v.dispose();
  });

  test('场上没有材质时安全调用，不抛错', () => {
    const v = makeViewer();
    expect(() => v.setMaterialQuality('lambert')).not.toThrow();
    v.dispose();
  });
});
