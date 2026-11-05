/**
 * 单元测试：GLSL3 pass 的输出变量
 *
 * 锁一条容易静默翻车的不变式：material 声明 `glslVersion: GLSL3` 之后，
 * three 不再注入 `#define gl_FragColor pc_fragColor`（`WebGLProgram` 里那两个
 * 三元表达式在 GLSL3 分支取空串），片元里再写 `gl_FragColor` 必然编译失败：
 *
 *   ERROR: 'gl_FragColor' : undeclared identifier
 *
 * 这类错误在 bun test 里跑不到（要真实 WebGL 上下文），所以退一步对着源码断言。
 * 同样的道理，`#include <tonemapping_fragment>` / `#include <colorspace_fragment>`
 * 这两个 chunk 内部也硬写 `gl_FragColor`，GLSL3 material 里一样不能用。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RENDER_DIR = fileURLToPath(new URL('../../packages/s3m-three/src/render/', import.meta.url));

/** 去掉行注释再断言：注释里会提到 gl_FragColor，那是解释而不是代码 */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

function glsl3Files(): { file: string; code: string }[] {
  return readdirSync(RENDER_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, code: stripLineComments(readFileSync(RENDER_DIR + f, 'utf8')) }))
    .filter((x) => x.code.includes('glslVersion: THREE.GLSL3'));
}

describe('GLSL3 pass 的片元输出', () => {
  test('确实扫到了用 GLSL3 的 pass（防止文件名改动后这组断言空转）', () => {
    const files = glsl3Files().map((x) => x.file);
    expect(files).toContain('MotionBlurPass.ts');
    expect(files).toContain('GpuEdgePass.ts');
  });

  test('GLSL3 的片元里不出现 gl_FragColor', () => {
    for (const { file, code } of glsl3Files()) {
      expect(`${file}: ${/gl_FragColor\s*[=.]/.test(code)}`).toBe(`${file}: false`);
    }
  });

  test('GLSL3 的片元不 include 内部写 gl_FragColor 的 chunk', () => {
    for (const { file, code } of glsl3Files()) {
      const hasTone = /#include\s*<tonemapping_fragment>/.test(code);
      const hasSpace = /#include\s*<colorspace_fragment>/.test(code);
      expect(`${file}: ${hasTone || hasSpace}`).toBe(`${file}: false`);
    }
  });

  test('上屏合成仍然做色调映射与 linear→输出色彩空间转换', () => {
    // 修编译错误时最容易顺手删掉这两行：能编译、也能出画，只是颜色过亮或发灰。
    // three 只对「渲染到屏幕」的片元自动补这两步，走 RT 中转的合成 pass 必须自己来。
    const src = stripLineComments(readFileSync(RENDER_DIR + 'MotionBlurPass.ts', 'utf8'));
    expect(src).toContain('linearToOutputTexel(');
    expect(src).toContain('toneMapping(');
    expect(src).toContain('TONE_MAPPING');
  });
});
