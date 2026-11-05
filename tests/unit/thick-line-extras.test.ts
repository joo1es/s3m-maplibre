/**
 * 单元测试：等宽线材质的着色器注入点
 *
 * 存在的理由：飞线 / 光柱这些形态只差一个片元，但屏幕空间等宽、近平面裁剪、
 * 端点外延那套顶点逻辑不该让使用者抄一遍。锁定三件事：
 *   1. 不传 extras 时**逐字不变**（不变式①：默认路径不受影响）；
 *   2. 三个注入点各自插在正确位置（attribute 在 aNormal 之后、varying 在 main 之前、
 *      vertexTail 在 gl_Position 之后）；
 *   3. 自定义 uniform 与内置的合并，不是覆盖整个 uniforms 表。
 */
import { describe, expect, test } from 'bun:test';
import { createLineSharedUniforms, createThickLineMaterial } from '../../packages/s3m-three/src/render/EdgeLines';

const shared = createLineSharedUniforms();

describe('等宽线材质注入 / 默认路径', () => {
  test('不传 extras 与传空对象结果逐字一致', () => {
    const a = createThickLineMaterial(shared, {});
    const b = createThickLineMaterial(shared, {}, undefined, undefined, {});
    expect(b.vertexShader).toBe(a.vertexShader);
    expect(b.fragmentShader).toBe(a.fragmentShader);
  });

  test('默认材质不含任何注入痕迹', () => {
    const m = createThickLineMaterial(shared, {});
    expect(m.vertexShader).not.toContain('aAlong');
    expect(m.vertexShader).toContain('attribute vec3 aOther;');
  });
});

describe('等宽线材质注入 / 三个锚点', () => {
  test('attribute 声明插在 aNormal 之后', () => {
    const m = createThickLineMaterial(shared, {}, undefined, undefined, {
      attributeDeclarations: 'attribute float aAlong;',
    });
    const at = m.vertexShader.indexOf('attribute float aAlong;');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(m.vertexShader.indexOf('attribute vec3 aNormal;'));
    // 必须还在 main 之前，否则 GLSL 编译不过
    expect(at).toBeLessThan(m.vertexShader.indexOf('void main()'));
  });

  test('varying 声明插在 main 之前', () => {
    const m = createThickLineMaterial(shared, {}, undefined, undefined, {
      varyingDeclarations: 'varying float vAlong;',
    });
    const at = m.vertexShader.indexOf('varying float vAlong;');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(m.vertexShader.indexOf('void main()'));
  });

  test('vertexTail 插在 gl_Position 之后', () => {
    const m = createThickLineMaterial(shared, {}, undefined, undefined, {
      attributeDeclarations: 'attribute float aAlong;',
      varyingDeclarations: 'varying float vAlong;',
      vertexTail: 'vAlong = aAlong;',
    });
    const tail = m.vertexShader.indexOf('vAlong = aAlong;');
    const glAt = m.vertexShader.indexOf('gl_Position = vec4( ndc * clipA.w, clipA.z, clipA.w );');
    expect(glAt).toBeGreaterThan(0);
    expect(tail).toBeGreaterThan(glAt);
  });
});

describe('等宽线材质注入 / 片元与 uniform', () => {
  test('自定义片元整体替换内置片元', () => {
    const frag = 'void main() { gl_FragColor = vec4(0.0, 1.0, 1.0, 1.0); }';
    const m = createThickLineMaterial(shared, {}, undefined, undefined, { fragmentShader: frag });
    expect(m.fragmentShader).toBe(frag);
    // 内置片元里的 uColor 不该再出现
    expect(m.vertexShader).toContain('attribute vec3 aOther;');
  });

  test('自定义 uniform 与内置合并，内置的不丢', () => {
    const m = createThickLineMaterial(shared, { color: '#ff0000' }, undefined, undefined, {
      uniforms: { uTime: { value: 0 }, uSpeed: { value: 0.5 } },
    });
    expect(m.uniforms.uTime.value).toBe(0);
    expect(m.uniforms.uSpeed.value).toBe(0.5);
    expect(m.uniforms.uColor.value.getHexString()).toBe('ff0000');
    expect(m.uniforms.uResolution).toBe(shared.uResolution);
  });

  test('自定义 uniform 可以覆盖内置同名项', () => {
    const m = createThickLineMaterial(shared, { width: 2 }, undefined, undefined, {
      uniforms: { uWidth: { value: 9 } },
    });
    expect(m.uniforms.uWidth.value).toBe(9);
  });
});
