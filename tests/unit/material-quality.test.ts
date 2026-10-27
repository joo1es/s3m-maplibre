/**
 * 光照模型降级（pbr / lambert）。
 *
 * 这里钉两件事：
 *
 * 1. `setMaterialQuality` 真的换掉了材质类 —— 否则「省一半片元」只是个说法。
 * 2. **Lambert 的 shader 模板里确实存在我们注入的那几个 include**。
 *    第二条才是关键：注入用的是 `shader.fragmentShader.replace('#include <xxx>')`，
 *    three 一旦改名或挪位置，`replace` 会静默 no-op —— 材质照样能渲染，
 *    只是单体着色 / 按高度 / 图集全部失效，而且没有任何报错。用测试把它固定住。
 */
import * as THREE from 'three';
import { describe, expect, test } from 'bun:test';
import {
  createSharedUniforms,
  createStyledMaterial,
  getMaterialQuality,
  setMaterialQuality,
} from '../../packages/s3m-three/src/render/StyleMaterial.js';

const uniforms = createSharedUniforms();

function make() {
  return createStyledMaterial({ uniforms, color: new THREE.Color(0xffffff) });
}

describe('光照模型降级', () => {
  test('默认是 pbr，切到 lambert 后创建的是 MeshLambertMaterial', () => {
    setMaterialQuality('pbr');
    expect(getMaterialQuality()).toBe('pbr');
    expect((make() as any).isMeshStandardMaterial).toBe(true);

    setMaterialQuality('lambert');
    expect(getMaterialQuality()).toBe('lambert');
    const lambert = make();
    expect((lambert as any).isMeshLambertMaterial).toBe(true);
    expect((lambert as any).isMeshStandardMaterial).toBeUndefined();

    setMaterialQuality('pbr'); // 还原，避免影响同进程其它用例
  });

  test('非法值退回 pbr', () => {
    setMaterialQuality('lambert');
    setMaterialQuality('nope' as any);
    expect(getMaterialQuality()).toBe('pbr');
  });

  test('两种材质都挂了 onBeforeCompile 注入', () => {
    for (const q of ['pbr', 'lambert'] as const) {
      setMaterialQuality(q);
      const m = make();
      expect(typeof m.onBeforeCompile).toBe('function');
      // 每个变体都要有自己的 cache key，否则 Standard / Lambert 会共用一份 program
      expect(typeof m.customProgramCacheKey).toBe('function');
    }
    setMaterialQuality('pbr');
  });

  test('Lambert 模板里包含全部注入锚点（three 升级的回归哨兵）', () => {
    const frag = THREE.ShaderLib.lambert.fragmentShader;
    const vert = THREE.ShaderLib.lambert.vertexShader;

    // fragment: FRAG_PARS / FRAG_COLOR / FRAG_EMISSIVE / 图集采样
    for (const anchor of [
      '#include <common>',
      '#include <color_fragment>',
      '#include <emissivemap_fragment>',
      '#include <map_fragment>',
    ]) {
      expect(frag.includes(anchor)).toBe(true);
    }

    // vertex: VERT_PARS / VERT_SETUP / VERT_ELEVATION / VERT_WORLD
    for (const anchor of [
      '#include <common>',
      '#include <beginnormal_vertex>',
      '#include <begin_vertex>',
      '#include <worldpos_vertex>',
    ]) {
      expect(vert.includes(anchor)).toBe(true);
    }
  });

  test('PBR 模板同样包含注入锚点', () => {
    const frag = THREE.ShaderLib.physical.fragmentShader;
    for (const anchor of [
      '#include <common>',
      '#include <color_fragment>',
      '#include <emissivemap_fragment>',
      '#include <map_fragment>',
    ]) {
      expect(frag.includes(anchor)).toBe(true);
    }
  });
});
