/**
 * 「自带透明」材质在运行期被误关的回归测试。
 *
 * 现象（3D-BIMbuilding-2 / SMID 4421）：刚进场景看不到透明度，
 * 切换材质质感（setMaterialQuality → _rebuildStyledMaterials）后透明度又出现。
 *
 * 根因：瓦片淡入（_startTileFade）会临时把 mat.transparent 置 true，
 * 淡入结束 / 清除单体淡化时，恢复逻辑只看「图层全局透明度」：
 *   `if (mat.transparent && !layerTransparent) mat.transparent = false;`
 * 它不知道材质**自身**就是透明的（alphaMode blend / 顶点色 alpha < 1 / 水面，
 * 创建时记在 userData.s3mOpts.transparent），于是一刀切成不透明；
 * 而重建材质按 s3mOpts 原样来，透明度就「回来了」。
 *
 * 修复：恢复混合状态统一走 restoreBaseBlendState ——
 * transparent = 材质自身透明 || 图层透明；depthWrite 跟随
 * （自身 blend 材质保持 false，淡入/全局淡出场景尊重 keepDepthWrite）。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  createStyledMaterial,
  restoreBaseBlendState,
  createSharedUniforms,
} from '../../packages/s3m-three/src/render/StyleMaterial';

const uniforms = createSharedUniforms();

/** 模拟 SMID 4421：顶点色 alpha < 1 → 材质创建时 transparent = true（记进 s3mOpts） */
function makeVertexAlphaMaterial() {
  return createStyledMaterial({
    uniforms,
    map: null,
    transparent: true,
    opacity: 1,
  });
}

/** 普通不透明材质（绝大多数 BIM 构件） */
function makeOpaqueMaterial() {
  return createStyledMaterial({ uniforms, map: null, transparent: false, opacity: 1 });
}

describe('restoreBaseBlendState', () => {
  test('淡入结束（图层不透明）：自身透明的材质保持 transparent，不被一刀切成 false', () => {
    const mat = makeVertexAlphaMaterial();
    // 模拟 _startTileFade 的临时状态（此时被强制 true）
    expect(mat.transparent).toBe(true);
    restoreBaseBlendState(mat, false);
    expect(mat.transparent).toBe(true); // ← 旧逻辑在这里变 false，就是 bug
    expect(mat.depthWrite).toBe(false); // 自身 blend 材质创建时就是 depthWrite=false
  });

  test('淡入结束（图层不透明）：普通不透明材质正常还原为不透明', () => {
    const mat = makeOpaqueMaterial();
    mat.transparent = true; // 淡入期间被强制开
    restoreBaseBlendState(mat, false);
    expect(mat.transparent).toBe(false);
    expect(mat.depthWrite).toBe(true);
  });

  test('图层全局半透明时：无论自身与否都 transparent，depthWrite 尊重 keepDepthWrite', () => {
    const mat = makeOpaqueMaterial();
    restoreBaseBlendState(mat, true, true);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(true);
    restoreBaseBlendState(mat, true, false);
    expect(mat.depthWrite).toBe(false);
  });

  test('透明材质切回全局不透明：自身透明的保留，不透明的还原', () => {
    const blend = makeVertexAlphaMaterial();
    const opaque = makeOpaqueMaterial();
    // 图层从半透明滑回 1（_applyOpacity 场景）
    restoreBaseBlendState(blend, false);
    restoreBaseBlendState(opaque, false);
    expect(blend.transparent).toBe(true);
    expect(opaque.transparent).toBe(false);
  });
});
