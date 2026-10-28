/**
 * 单元测试：金属度 / 粗糙度（pbr 自定义着色）
 *
 * 动机：材质是 `MeshStandardMaterial`，但 `metalness` 以前写死 0、`roughness` 只由
 * 数据的 shininess 映射，「自定义复合」等着色模式只能改 diffuseColor，金属质感无从设置。
 *
 * 现在改成共享 uniform 覆盖：
 *   `uMetalness` / `uRoughness` < 0 表示不覆盖（保持材质自身的值）
 *   >= 0 时在 `metalnessmap_fragment` 之后直接改写 metalnessFactor / roughnessFactor
 *
 * 为什么注入点必须在 metalnessmap_fragment 之后：`roughnessmap_fragment` 声明
 * roughnessFactor、`metalnessmap_fragment` 声明 metalnessFactor，提前引用是「变量未声明」；
 * 晚于 `lights_physical_fragment` 则这帧的 GGX 已经算完了。
 *
 * 全部无头验证：onBeforeCompile 只是改 JS 对象，喂 three 官方模板即可断言，不需要 GL。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { createSharedUniforms, createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

function makeViewer(): S3MViewer {
  return new S3MViewer({ canvas: null as never, container: null as never } as ConstructorParameters<typeof S3MViewer>[0]);
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

describe('金属度 / 粗糙度', () => {
  test('默认不覆盖：uMetalness / uRoughness 都是 -1，材质仍是 metalness=0', () => {
    const uniforms = createSharedUniforms();
    expect(uniforms.uMetalness!.value).toBe(-1);
    expect(uniforms.uRoughness!.value).toBe(-1);

    const mat = createStyledMaterial({ uniforms }) as THREE.MeshStandardMaterial;
    // 数据自带的口径不变：metalness 恒 0，roughness 来自 shininess 映射
    expect(mat.metalness).toBe(0);
  });

  test('注入点在 metalnessmap_fragment 之后，且两个 factor 都已声明', () => {
    const mat = createStyledMaterial({ uniforms: createSharedUniforms(), roughness: 0.6 });
    const shader = compileHeadless(mat);

    const frag = shader.fragmentShader;
    expect(frag).toContain('uniform float uMetalness');
    expect(frag).toContain('uniform float uRoughness');
    expect(frag).toContain('metalnessFactor = clamp( uMetalness, 0.0, 1.0 )');
    expect(frag).toContain('roughnessFactor = clamp( uRoughness, 0.04, 1.0 )');

    const at = frag.indexOf('metalnessFactor = clamp( uMetalness');
    expect(at).toBeGreaterThan(frag.indexOf('#include <metalnessmap_fragment>'));
    // 必须在光照累加之前（否则这一帧的 GGX 已经用旧值算完）
    expect(at).toBeLessThan(frag.indexOf('#include <lights_physical_fragment>'));
    // 覆盖是运行期分支，不是新的编译变体
    expect(mat.customProgramCacheKey?.()).toBe(
      createStyledMaterial({ uniforms: createSharedUniforms() }).customProgramCacheKey?.()
    );
  });

  test('setStyle 写共享 uniform；不传时回到 -1（保持数据口径）', () => {
    const v = makeViewer();
    expect(v.uniforms.uMetalness!.value).toBe(-1);

    v.setStyle({ metalness: 0.8, roughness: 0.25 });
    expect(v.uniforms.uMetalness!.value).toBe(0.8);
    expect(v.uniforms.uRoughness!.value).toBe(0.25);
    expect(v.getStyle().metalness).toBe(0.8);

    // 只改粗糙度不应把金属度带回 -1
    v.setStyle({ roughness: 0.5 });
    expect(v.uniforms.uMetalness!.value).toBe(0.8);
    expect(v.uniforms.uRoughness!.value).toBe(0.5);

    v.dispose();
  });

  test('metalness / roughness 可插值（进 STYLE_SCALAR_KEYS，拖滑块不重建材质）', () => {
    const v = makeViewer();
    v.setStyle({ metalness: 1, roughness: 0.1 }, { duration: 1 });
    // 有过渡时走动画通道：目标值立刻可见，材质本身不变
    expect(v.getStyle().metalness).toBe(1);
    v.dispose();
  });
});
