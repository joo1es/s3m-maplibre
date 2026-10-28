/**
 * 光照预设单测。
 *
 * 目标：`lightingPreset: 'supermap'` 只动光源、不动材质，且**默认行为一个数都不变**。
 * 数值依据见 render/lightingPreset.ts 里的对照表：官方在 sRGB 空间直乘，
 * 因子 0.7 ~ 1.5，换算到我们的线性管线是 0.7^2.2 ≈ 0.46 到 1.5^2.2 ≈ 2.44。
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LIGHT_PRESET,
  SUPERMAP_LIGHT_PRESET,
  resolveLightingPreset,
  presetLinearRange,
} from '../../packages/s3m-three/src/render/lightingPreset';

describe('默认预设必须保持原值（回归保护）', () => {
  test('四个强度与改动前一致', () => {
    expect(DEFAULT_LIGHT_PRESET).toEqual({
      ambientIntensity: 0.4,
      hemisphereIntensity: 0.8,
      keyLightIntensity: 1.0,
      fillLightIntensity: 0.35,
    });
  });

  test('不传 / 传 default / 传未知值，都拿到默认预设', () => {
    expect(resolveLightingPreset()).toEqual(DEFAULT_LIGHT_PRESET);
    expect(resolveLightingPreset('default')).toEqual(DEFAULT_LIGHT_PRESET);
    expect(resolveLightingPreset('nope')).toEqual(DEFAULT_LIGHT_PRESET);
  });
});

describe("lightingPreset: 'supermap'", () => {
  test('拿得到专用预设', () => {
    expect(resolveLightingPreset('supermap')).toEqual(SUPERMAP_LIGHT_PRESET);
    expect(SUPERMAP_LIGHT_PRESET).not.toEqual(DEFAULT_LIGHT_PRESET);
  });

  test('★ 背光线性总量 ≈ 0.7^2.2（官方暗部），不高于 0.5', () => {
    const { shadow } = presetLinearRange(SUPERMAP_LIGHT_PRESET);
    expect(shadow).toBeGreaterThan(0.9 * Math.pow(0.7, 2.2)); // ≈ 0.42
    expect(shadow).toBeLessThan(0.5);
  });

  test('★ 受光线性总量 ≈ 1.5^2.2（官方亮部），落在 [2.35, 2.45]', () => {
    const { lit } = presetLinearRange(SUPERMAP_LIGHT_PRESET);
    expect(lit).toBeGreaterThan(2.35);
    expect(lit).toBeLessThan(2.45);
  });

  test('对比度高于默认预设（这正是"饱和发灰"的成因）', () => {
    const d = presetLinearRange(DEFAULT_LIGHT_PRESET);
    const s = presetLinearRange(SUPERMAP_LIGHT_PRESET);
    expect(s.lit / s.shadow).toBeGreaterThan(d.lit / d.shadow);
  });

  test('主光占绝对权重（官方只有太阳 + 环境，没有补光）', () => {
    const p = SUPERMAP_LIGHT_PRESET;
    const total = p.ambientIntensity + p.hemisphereIntensity + p.keyLightIntensity + p.fillLightIntensity;
    expect(p.keyLightIntensity / total).toBeGreaterThan(0.75);
    expect(p.hemisphereIntensity).toBeLessThan(p.ambientIntensity + p.hemisphereIntensity);
    expect(p.fillLightIntensity).toBeLessThanOrEqual(p.hemisphereIntensity);
  });
});
