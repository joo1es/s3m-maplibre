/**
 * 单元测试：shading 由共享 uniform 驱动（零重编译）
 *
 * 动机：旧实现 flat / smooth 是 three 的 `flatShading` define（编译期变体），
 * 切换必重编译——只能靠 prewarm「翻变体→编译→翻回来」把卡顿藏起来，而且
 * `customProgramCacheKey` 不含 flatShading，flat/smooth 两个变体在缓存里互相
 * 覆盖，预热其实是无效的。现在改成 `uFlatShading` 共享 uniform 的运行期分支，
 * program 只有一个，切换退化成一次 float 赋值。
 *
 * 全部无头验证：onBeforeCompile 只是改一个 JS 对象，用 three 官方模板喂进去
 * 就能断言注入结果，不需要 GL 上下文。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { createSharedUniforms, createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

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

/** 用 three 官方 standard 模板跑一遍 onBeforeCompile，拿到注入后的着色器文本 */
function compileHeadless(mat: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  (mat as unknown as { onBeforeCompile: (s: unknown, r: unknown) => void }).onBeforeCompile(shader, null);
  return shader;
}

describe('shading = uFlatShading 共享 uniform', () => {
  test('材质恒为 flatShading=false（program 稳定），默认 flat 由 uniform 表达', () => {
    const uniforms = createSharedUniforms();
    const mat = createStyledMaterial({ uniforms });
    expect(mat.flatShading).toBe(false);
    expect(mat.userData.uFlatShading).toBe(uniforms.uFlatShading); // 挂共享引用，改一次全场景生效
    expect(uniforms.uFlatShading.value).toBe(1); // 默认平面着色，语义与旧版一致
  });

  test('onBeforeCompile 注入 uFlatShading uniform 与导数法线分支', () => {
    const mat = createStyledMaterial({ uniforms: createSharedUniforms() });
    const shader = compileHeadless(mat);
    expect(shader.uniforms.uFlatShading).toBeDefined();
    expect(shader.vertexShader).toContain('vS3MViewPos'); // 顶点写视图位置 varying
    expect(shader.fragmentShader).toContain('varying vec3 vS3MViewPos'); // 片元读同一 varying
    expect(shader.fragmentShader).toContain('uniform float uFlatShading');
    // flat 分支：导数叉积法线，数学与 three 的 FLAT_SHADED 一致
    expect(shader.fragmentShader).toContain('cross( dFdx( vS3MViewPos ), dFdy( vS3MViewPos ) )');
    expect(shader.fragmentShader).toContain('normal = s3mFlatN');
    // smooth 分支不破坏 three 原生法线：注入挂在 normal_fragment_begin 之后
    expect(shader.fragmentShader).toContain('#include <normal_fragment_begin>');
  });

  test('customProgramCacheKey 与 atlas 宏仍正确分桶，且不随 shading 变化', () => {
    const plain = createStyledMaterial({ uniforms: createSharedUniforms() });
    const atlas = createStyledMaterial({ uniforms: createSharedUniforms(), atlas: true, map: new THREE.Texture() });
    expect(plain.customProgramCacheKey?.()).not.toBe(atlas.customProgramCacheKey?.());

    const v = makeViewer();
    const mesh = registerMesh(v, 901);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const before = mat.customProgramCacheKey?.();
    v.setStyle({ shading: 'smooth' });
    expect(mat.customProgramCacheKey?.()).toBe(before); // #5：key 与 shading 无关，不再撞也不再分叉
    v.dispose();
  });

  test('viewer 切 shading：uniform 翻转，决定 program 的属性不动（零重编译）', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 902);
    const mat = mesh.material as THREE.MeshStandardMaterial;

    v.setStyle({ shading: 'smooth' });
    expect(mat.userData.uFlatShading.value).toBe(0);
    // flatShading 是唯一的 program 决定项：恒 false 意味着切换不触发重编译
    expect(mat.flatShading).toBe(false);

    v.setStyle({ shading: 'flat' });
    expect(mat.userData.uFlatShading.value).toBe(1);
    expect(mat.flatShading).toBe(false);
    v.dispose();
  });
});
