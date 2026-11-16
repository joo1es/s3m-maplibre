/**
 * 渲染后端能力探测的单测（#49 第 0 步）。
 *
 * 这条闸门以前判的是 `capabilities.isWebGL2`，但真正决定 HalfFloat RT 能不能用的是扩展
 * `EXT_color_buffer_float`：three 在 `WebGLTextures.js` 里只对它做 `extensions.get()`，
 * 拿不到就 warn 且 RT 不完整 —— 缺扩展的设备上拖影 / presenter 会静默黑屏，闸门却照样放行。
 *
 * 同时钉住旧 three 的语义：`peerDependencies` 允许 `three >= 0.155.0`，r155–r162 上
 * `isWebGL2` 是真实值，WebGL1 上下文（`false`）必须继续被拦下 —— 不能因为 r163 之后它恒为
 * `true` 就把判断删掉。
 */
import { describe, expect, test } from 'bun:test';
import {
  supportsFragDepth,
  supportsHalfFloatTargets,
} from '../../packages/s3m-three/src/render/viewer/gpuCaps';

/** three WebGLRenderer 的最小桩 */
function webgl(isWebGL2: boolean, hasExt: (name: string) => boolean = () => true) {
  return {
    isWebGLRenderer: true,
    capabilities: { isWebGL2 },
    extensions: { has: hasExt },
  };
}

/** three WebGPURenderer 的最小桩：没有 capabilities / extensions，只有 isWebGPURenderer 标记 */
function webgpu() {
  return { isWebGPURenderer: true };
}

describe('supportsFragDepth', () => {
  test('WebGL2 → true，WebGL1 → false（旧 three 的真实分支）', () => {
    expect(supportsFragDepth(webgl(true))).toBe(true);
    expect(supportsFragDepth(webgl(false))).toBe(false);
  });

  test('WebGPU 后端没有 capabilities，但能力上等价于 WebGL2+', () => {
    expect(supportsFragDepth(webgpu())).toBe(true);
    expect(supportsFragDepth({ backend: { isWebGPUBackend: true } })).toBe(true);
  });

  test('空对象不猜，按不支持处理', () => {
    expect(supportsFragDepth({})).toBe(false);
    expect(supportsFragDepth(null)).toBe(false);
  });
});

describe('supportsHalfFloatTargets', () => {
  test('WebGL2 + EXT_color_buffer_float → true', () => {
    expect(supportsHalfFloatTargets(webgl(true))).toBe(true);
  });

  test('WebGL2 但缺扩展 → false（这正是以前漏判的场景）', () => {
    expect(supportsHalfFloatTargets(webgl(true, () => false))).toBe(false);
  });

  test('只有 EXT_color_buffer_half_float 不算：three 只查 float，跟着 three 走', () => {
    const only = webgl(true, (n) => n === 'EXT_color_buffer_half_float');
    expect(supportsHalfFloatTargets(only)).toBe(false);
  });

  test('WebGL1 即便拿到扩展也 false：half-float RT 走 OES_texture_half_float 另一条路径，不押注', () => {
    expect(supportsHalfFloatTargets(webgl(false))).toBe(false);
  });

  test('WebGPU 后端 → true（rgba16float 是核心可渲染格式，无需扩展）', () => {
    expect(supportsHalfFloatTargets(webgpu())).toBe(true);
  });

  test('extensions 缺失时不默认放行', () => {
    expect(supportsHalfFloatTargets({ capabilities: { isWebGL2: true } })).toBe(false);
    expect(supportsHalfFloatTargets({})).toBe(false);
  });
});
