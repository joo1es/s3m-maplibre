/**
 * 光照预设。
 *
 * 默认那套（ambient 0.4 / hemi 0.8 / key 1.0 / fill 0.35）是为「线性 PBR 管线」
 * 调的，亮部线性总量约 2.55。超图官方 iClient3D 走的是完全不同的着色模型
 * （`S3MTiles/Shaders/S3MTilesFS.js`）：
 *
 * ```glsl
 * const vec3 SunLightColor     = vec3(0.8);
 * const vec3 AmbientLightColor = vec3(0.7);
 * return uDiffuseColor.rgb * (SunLightColor * max(dot(n, L), 0.0) + AmbientLightColor * uAmbientColor.rgb);
 * ```
 *
 * 也就是**在 sRGB 数值空间里直接做 Lambert**，因子范围 0.7 ~ 1.5，没有 gamma 编码、
 * 没有 tonemap。我们在线性空间乘、最后再做 linear→sRGB，同一个中间灰（sRGB 0.5）：
 *
 * | | 官方 | 我们（默认） |
 * |---|---|---|
 * | 背光 | 0.5 × 0.7 = 0.35 | (0.214 × 0.8)^(1/2.2) ≈ 0.455 |
 * | 受光 | 0.5 × 1.5 = 0.75 | (0.214 × 2.55)^(1/2.2) ≈ 0.76 |
 *
 * 暗部被 gamma 抬亮 30%，动态范围被压到 0.7~1.0，于是「发灰、饱和度低」。
 *
 * `'supermap'` 预设把线性光照总量重新压到与官方 sRGB 因子等效的区间：
 * 0.7^2.2 ≈ 0.46（背光）到 1.5^2.2 ≈ 2.44（受光）。这不是逐像素复刻官方的
 * sRGB 直乘（那需要放弃 PBR、改 `outputColorSpace = LinearSRGB`），
 * 而是只动光源、可逆、不碰材质。
 */
export type LightingPreset = 'default' | 'supermap';

export interface PresetLightIntensities {
  ambientIntensity: number;
  hemisphereIntensity: number;
  keyLightIntensity: number;
  fillLightIntensity: number;
}

/** 现有默认值，一字节不改 */
export const DEFAULT_LIGHT_PRESET: PresetLightIntensities = {
  ambientIntensity: 0.4,
  hemisphereIntensity: 0.8,
  keyLightIntensity: 1.0,
  fillLightIntensity: 0.35,
};

/**
 * 对齐官方观感：几乎只留平行光 + 极低环境光。
 *
 * 背光总和 = 0.12 + 0.20 + 0.15 = 0.47（≈ 0.7^2.2）
 * 受光总和 = 0.47 + 1.95       = 2.42（≈ 1.5^2.2）
 */
export const SUPERMAP_LIGHT_PRESET: PresetLightIntensities = {
  ambientIntensity: 0.12,
  hemisphereIntensity: 0.2,
  keyLightIntensity: 1.95,
  fillLightIntensity: 0.15,
};

export const LIGHT_PRESETS: Record<LightingPreset, PresetLightIntensities> = {
  default: DEFAULT_LIGHT_PRESET,
  supermap: SUPERMAP_LIGHT_PRESET,
};

/** 预设名 → 强度组合；未知值回落默认，避免拼错名字把场景变全黑 */
export function resolveLightingPreset(preset?: string | null): PresetLightIntensities {
  if (preset && Object.prototype.hasOwnProperty.call(LIGHT_PRESETS, preset)) {
    return LIGHT_PRESETS[preset as LightingPreset];
  }
  return DEFAULT_LIGHT_PRESET;
}

/** 线性总辐照度（供测试与调试：受光面 / 背光面） */
export function presetLinearRange(p: PresetLightIntensities): { shadow: number; lit: number } {
  const shadow = p.ambientIntensity + p.hemisphereIntensity + p.fillLightIntensity;
  return { shadow, lit: shadow + p.keyLightIntensity };
}
