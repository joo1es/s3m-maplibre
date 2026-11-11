/**
 * 回归：发光线框立方体从内部抬头看时，天空那片变纯黑。
 *
 * 根因是 GLSL 的 `pow(x, 2.0)` 在 x<0 时属于未定义行为（返回 NaN），而镀光层走
 * additive blending，NaN 混进 framebuffer 会把整片像素写成黑色。这个 bug 在
 * tsc 里完全看不见 —— shader 只是模板字符串，也没有 WebGL 单测能编译它。
 * 所以用源码级结构断言钉住，重点不是复述实现，而是禁止那类写法再回来。
 *
 * 对应实现：site/src/examples/glow-cube.ts
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../../site/src/examples/glow-cube.ts', import.meta.url)),
  'utf8'
);

/** 平方用 pow(x, 2.0) 是 NaN 源；pow(x, 2.5) 之类的底数非负写法不受影响 */
const POW_SQUARE = /pow\s*\([^;]*,\s*2(?:\.0)?\s*\)/;

// 去掉注释再查：说明文字里本来就写着 pow(x, 2.0) 这个反例
const blocks = [...src.matchAll(/const (\w+) = \/\* glsl \*\/ `([\s\S]*?)`;/g)].map(
  ([, name, body]) => ({
    name,
    body: body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''),
  })
);

describe('发光线框 shader 的 NaN 防线', () => {
  test('四个片元 + 三个共用块都在（少一个说明示例被改坏了）', () => {
    expect(blocks.map((b) => b.name).sort()).toEqual(
      [
        'COMMON',
        'CORE_FRAG',
        'HALO_FRAG',
        'NAN_GUARD',
        'POOL_FRAG',
        'POOL_VERT',
        'SHELL_FRAG',
        'SHELL_VERT',
      ].sort()
    );
  });

  test('断言本身有效：确实能抓到 pow(x, 2.0)，不是一条空测试', () => {
    expect('float e = exp( -pow( ( x - 0.5 ) * 9.0, 2.0 ) );').toMatch(POW_SQUARE);
    expect('float f = pow( 1.0 - abs( d ), 2.5 );').not.toMatch(POW_SQUARE);
  });

  test('所有 shader 块里平方一律写 x*x', () => {
    for (const b of blocks) {
      expect(b.body, `${b.name} 含 pow(x, 2.0)`).not.toMatch(POW_SQUARE);
    }
  });

  test('相机在立方体内部时内壁不画，顶盖不会糊住整片天空', () => {
    const shell = blocks.find((b) => b.name === 'SHELL_FRAG');
    expect(shell?.body).toContain('gl_FrontFacing');
  });

  test('地面光池只画朝上的正面，不会翻到天空那一侧', () => {
    expect(src).toMatch(/side:\s*THREE\.FrontSide/);
  });

  test('四个片元出口都有 NaN 守卫，异常值不会进 additive 混合', () => {
    expect(src).toContain('const NAN_GUARD');
    for (const name of ['HALO_FRAG', 'CORE_FRAG', 'POOL_FRAG', 'SHELL_FRAG']) {
      const frag = blocks.find((b) => b.name === name);
      expect(frag?.body, `${name} 缺 NAN_GUARD`).toContain('${NAN_GUARD}');
    }
  });

  test('内壁是开放的四个侧面，没有能横跨天空的顶盖', () => {
    expect(src).toContain('function buildShell(');
    expect(src).not.toMatch(/new THREE\.BoxGeometry\(\s*width\s*,\s*depth/);
  });
});
