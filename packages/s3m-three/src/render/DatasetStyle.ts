/**
 * 数据集级样式：把图层级的共享 uniform 派生成「本数据集自己的一份」。
 *
 * 为什么必须这样做：所有样式都写在共享 uniform 对象上（`S3MViewer.uniforms` 一份，
 * 逐层下发到 `S3MTileset` → `buildTileObjects` → `createStyledMaterial`），而材质在
 * 创建时就把 `uniforms.uColorA` 这些对象**引用**进了 shader。事后换
 * `mat.userData.uColorA` 不会重新绑定，所以在材质创建之后没法再按数据集改样式。
 * 唯一可行的位置是**建材质之前**：给这个数据集另一份 uniform 对象。
 *
 * 关键做法是**只分裂被覆盖的键**：
 *
 * ```ts
 * const out = { ...base };                       // 所有键仍指向同一份 { value }
 * out.uColorA = { value: new Color('#8fa3b8') };  // 只有 patch 里出现的键才新建
 * ```
 *
 * 于是：
 *   - 图层级 `setStyle` 改到数据集没覆盖的键 → 数据集自动跟着变（同一个 `{ value }`），
 *     不需要任何同步代码，也不引入逐帧成本；
 *   - 数据集覆盖的键 → 图层怎么改都不影响它（patch 优先）；
 *   - 交互类 uniform（`uSelMix` / `uDim` / `uFilter*` / `uTime` / `uBatchMix` / `uPath*`）
 *     永远共享，不逐帧镜像。
 *
 * 不支持的键：`edges`（棱线材质是图层级一份）、选中态（`selectColor` / `selectMode` /
 * `selectOpacity` / `selectEmissive` / `outline*` / `dimOthers`）、`shading`。
 * `shading` 不是 uniform 而是逐材质的 `uFlatShading`，在 `TileRegistry` 注册瓦片时处理。
 */
import * as THREE from 'three';
import type { StyleUniforms } from '../core/types.js';
import type { S3MStyle } from './StyleMaterial.js';
import { clampOpacity } from './viewer/materialHelpers.js';

/**
 * 数值型样式键 → uniform 键。
 *
 * 只挑「写一次就是改一个 uniform」的项；`mode` 是整数枚举，其余是标量。
 * `metalness` / `roughness` 允许负数（shader 里 <0 表示不覆盖，保持数据自身的值）。
 */
const SCALAR_UNIFORMS = {
  mode: 'uMode',
  floorHeight: 'uFloorHeight',
  texMix: 'uTexMix',
  roofThreshold: 'uRoofThreshold',
  ambientGain: 'uAmbientGain',
  metalness: 'uMetalness',
  roughness: 'uRoughness',
  dimFactor: 'uDimFactor',
} as const satisfies Partial<Record<keyof S3MStyle, keyof StyleUniforms>>;

/** 颜色型样式键 → uniform 键（字符串 → THREE.Color，与 `applyStyleUniforms` 同一条解析路径） */
const COLOR_UNIFORMS = {
  colorA: 'uColorA',
  colorB: 'uColorB',
  colorC: 'uColorC',
} as const satisfies Partial<Record<keyof S3MStyle, keyof StyleUniforms>>;

/**
 * 生成数据集自己的 uniform 对象。
 *
 * @param base  图层级共享 uniform（`S3MViewer.uniforms`）
 * @param patch 数据集 `style`，只认上面两张表里的键；其余键忽略（由图层级负责）
 */
export function createDatasetUniforms(base: StyleUniforms, patch: Partial<S3MStyle>): StyleUniforms {
  const out: StyleUniforms = { ...base };
  // 只在真有覆盖时才写，避免无谓地分裂 uniform（空 patch 与图层那份完全等价）
  const target = out as unknown as Record<string, { value: unknown }>;

  for (const [styleKey, uniformKey] of Object.entries(SCALAR_UNIFORMS)) {
    const v = patch[styleKey as keyof typeof SCALAR_UNIFORMS];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    target[uniformKey] = { value: v };
  }

  // 不透明度单独走 clampOpacity：与 `StyleController.applyStyleUniforms` 的口径一致
  const opacity = patch.opacity;
  if (typeof opacity === 'number' && Number.isFinite(opacity)) {
    target.uOpacity = { value: clampOpacity(opacity) };
  }

  for (const [styleKey, uniformKey] of Object.entries(COLOR_UNIFORMS)) {
    const v = patch[styleKey as keyof typeof COLOR_UNIFORMS];
    if (typeof v !== 'string' || v === '') continue;
    target[uniformKey] = { value: new THREE.Color(v) };
  }

  return out;
}

/**
 * 数据集自身的透明度覆盖（未写则 undefined）。
 *
 * 单独抽出来是因为「透明度」不只是 uniform：`material.transparent`（混合开关）由
 * `restoreBaseBlendState` 按**图层** opacity 单方面决定，注册瓦片 / 淡入结束 /
 * 图层改透明度三处都会写它。数据集想半透明，必须让这三处都认这个覆盖值，
 * 否则材质被踩回不透明、alpha 直接被忽略。
 */
export function datasetOpacityOverride(style: Partial<S3MStyle> | undefined): number | undefined {
  const o = style?.opacity;
  return typeof o === 'number' && Number.isFinite(o) ? clampOpacity(o) : undefined;
}
