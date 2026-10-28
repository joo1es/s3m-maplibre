/**
 * S3MB 材质透明判定。
 *
 * 官方把 alphaMode 定义成三个**小写**枚举（`S3MTiles/Enum/AlphaMode.js`）：
 * ```
 * OPAQUE: 'opaque'   BLEND: 'blend'   MASK: 'mask'
 * ```
 * 而 S3M 规范文档里写的是 `AM_OPAQUE / AM_BLEND / AM_MASK`。线上数据用的是前者
 * （`3D-BIMbuilding-2` 的 `WhiteMaterial_1` 就是 `"alphaMode": "blend"`），
 * 所以两种写法都要认，否则 blend 材质会被当成不透明 —— 表现就是「透明度不见了」。
 *
 * 另外还有一条官方没写进规范、但数据里真实存在的透明度来源：**顶点色 alpha**。
 * SMID 4421 的材质无纹理、`diffuse.a = 1`，顶点色是 u8 `(0,128,192,63)`，
 * 也就是 alpha ≈ 0.247。官方片元 `outColor = baseColorWithAlpha * uDiffuseColor`
 * 里 `baseColorWithAlpha = vColor`（vec4），alpha 就靠这条路传下去。
 */

export type S3MAlphaMode = 'opaque' | 'blend' | 'mask';

/** 归一化 alphaMode：兼容小写枚举与规范里的 `AM_` 前缀，未知值一律按不透明处理 */
export function resolveAlphaMode(raw: unknown): S3MAlphaMode {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^am_/, '');
  return s === 'blend' || s === 'mask' ? s : 'opaque';
}

export interface MaterialAlphaInput {
  /** 材质原始 alphaMode（'blend' / 'AM_BLEND' / 'mask' / 'opaque' …） */
  alphaMode?: unknown;
  /** 材质 diffuse.a，缺省视为 1 */
  diffuseAlpha?: number;
  /** 材质 transparentsorting（配置开启透明度优化时官方也按透明处理） */
  transparentSorting?: boolean;
  /** 该几何顶点色 alpha 的最小值：<1 说明有半透明顶点 */
  vertexAlphaMin?: number;
  /** 内置水面材质且块里没有像素（我们自己的兜底上色） */
  isWaterWithoutMap?: boolean;
}

/**
 * 是否走透明（alpha 混合）管线。
 *
 * - `blend`：官方 `isTransparent = true`，进 TRANSLUCENT pass；
 * - `mask`：官方也算透明，但它是**镂空**语义（alphaTest）。我们保持不透明队列 +
 *   alphaTest，否则树叶/栏杆之间会因 `depthWrite: false` 互相穿透；
 * - 顶点色 alpha < 1：4421 这类"材质不透明但顶点半透明"的数据必须走混合。
 */
export function isTransparentMaterial(input: MaterialAlphaInput): boolean {
  const mode = resolveAlphaMode(input.alphaMode);
  if (mode === 'blend') return true;
  if (mode === 'mask') return false;
  if (input.transparentSorting === true) return true;
  if (input.isWaterWithoutMap === true) return true;
  if ((input.diffuseAlpha ?? 1) < 0.999) return true;
  if ((input.vertexAlphaMin ?? 1) < 0.999) return true;
  return false;
}

/**
 * 顶点色 alpha 的最小值：材质要不要开混合，取决于这块几何里有没有半透明顶点。
 *
 * 顶点数在几千到几万量级，一次线性扫描即可；只在建材质时算一次（每个 primitive 一次）。
 * 没有 alpha 分量（老数据的 RGB）按 1 处理 —— 不能因为读不到就当成 0，那会整片全透明。
 */
export function minVertexAlpha(color: { array: ArrayLike<number>; components?: number } | undefined): number {
  if (!color || !color.array || color.array.length === 0) return 1;
  const comp = color.components ?? 4;
  if (comp < 4) return 1;
  let min = 1;
  for (let i = 3; i < color.array.length; i += comp) {
    const a = color.array[i]!;
    if (a < min) min = a;
    if (min <= 0.999) return min; // 已经确定要透明，提前退出
  }
  return min;
}
