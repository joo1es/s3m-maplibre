/**
 * S3M 的 uv 第三分量（顶点属性 `custom0`，官方叫 `aTextureCoordMatrix`）。
 *
 * 为什么需要它：官方引擎对普通（非 S3MBLOCK）S3M 瓦片并不是「有纹理就整张平铺」。
 * 每个顶点在 uv 之外还带一个 z，iClient3D 在**顶点着色器**里拿它解出一个纹理矩阵：
 *
 *   `getTextureMatrixFromZValue( floor(z), xTran, yTran, scale )`
 *     bit[0:7]   → yTran     （图集列号）
 *     bit[8:15]  → xTran     （图集行号）
 *     bit[16:19] → level     （scale = 1 / 2^level，即图集是 2^level × 2^level 格）
 *   三档哨兵（官方 bundle getTextureColor / getUV 实测）：
 *     z < -99900 → `return vec4(1.0)` 纯白不采样（平涂顶点色面，值 -99999）
 *     z < -9000  → 「uv 原样平铺整图」：calculateTexCoord 里 `out = inTexCoord.xy`
 *                   （不 fract 不缩放），普通 texture2D（自动 mip）采样
 *     其余       → 图集子区域公式
 *
 * 片元侧是 `calculateMipLevel` + `calculateTexCoord`：
 *
 *   fTile = scale * texWidth                       // 一格在图里的像素宽
 *   mip   = clamp( 0.5*log2(d), 0, log2(fTile) - 1.62 )
 *   f     = clamp( fract(uv), 2^mip/fTile, 1 - 2^mip/fTile )   // 越糊越往格子中心收缩
 *   out   = ( f + T ) * scale
 *
 * 实测 SuperMap Online 的 `3D-BIMbuilding-2`（OSGB 转 S3M，全部 7 个根瓦片）：
 *   z ∈ { -99999, 0, 65536, 65537, 65792, 65793, 262144, 327680 }
 *   uv 是米制世界坐标（1 单位 ≈ 1 m），每米一个纹理周期。
 *
 * 本文件是这段数学的**唯一可执行版本**：着色器里是它的 GLSL 直译
 * （见 render/StyleMaterial.ts 的 VERT_TEXCOORD_Z / s3mTexCoordZUnit），
 * 单测 tests/unit/texcoord-z-math.test.ts 钉住两边必须一致。
 */

/** 官方哨兵：`inTexCoord.z < -9000` 走「uv 原样平铺」分支（getTexColorForS3M / calculateTexCoord） */
export const TEX_COORD_Z_DISABLED_BELOW = -9000;

/**
 * 官方白色哨兵：`texCoordZ < -99900` 时 getTextureColor 直接 `return vec4(1.0)`，
 * **完全不采样纹理**（数据里是 -99999）。最终颜色 = 白 × 材质 diffuse × 顶点色，
 * 即「平涂顶点色面」—— BIM 场景的地面标线 / 色块就是这类（SMID 3464：灰色地面 +
 * 黄色标线 + 暗红区域，全靠顶点色）。
 *
 * 注意与 -9000 平铺哨兵的区分：-99999 一旦按平铺处理，uv（-85..85 这类米制值）
 * 会把整张纹理平铺上百次，表现为「uv 整图」——这正是三档语义漏掉白色档的教训。
 */
export const TEX_COORD_Z_WHITE_BELOW = -99900;

/** 官方 calculateMipLevel 里那个上限收缩量 */
export const MIP_LIMIT_BIAS = 1.62;

/** 该顶点是否走「uv 原样平铺」分支。没有这条属性的数据 z 取 0，返回 false，行为不变。 */
export function isTexCoordDisabled(z: number): boolean {
  return z < TEX_COORD_Z_DISABLED_BELOW;
}

/** 该顶点是否走「纯白、不采样」分支（z < -99900，实测值 -99999）。优先级高于平铺。 */
export function isTexCoordWhite(z: number): boolean {
  return z < TEX_COORD_Z_WHITE_BELOW;
}

/** 解码结果。`disabled` 为真时其余字段无意义（着色器里对应 scale = -1；`white` 时 scale = -2） */
export interface TexMatrix {
  disabled: boolean;
  /** z < -99900：纯白不采样（见 TEX_COORD_Z_WHITE_BELOW） */
  white: boolean;
  /** 一格占整张纹理的比例，1/2^level */
  scale: number;
  /** 图集列号 */
  xTran: number;
  /** 图集行号 */
  yTran: number;
}

/**
 * 官方 `getTextureMatrixFromZValue` 的逐行移植。
 *
 * 注意 `nZ <= 0` 时官方直接 return，**不改**外部初值 —— 也就是单位变换
 * `scale=1, T=(0,0)`，等价于整张纹理按 uv 平铺。
 *
 * 着色器侧的档位编码：scale = -2 → 白；-1 → 平铺；>0 → 图集公式。
 */
export function decodeTexMatrix(z: number): TexMatrix {
  if (isTexCoordWhite(z)) {
    return { disabled: true, white: true, scale: -2, xTran: 0, yTran: 0 };
  }
  if (isTexCoordDisabled(z)) {
    return { disabled: true, white: false, scale: -1, xTran: 0, yTran: 0 };
  }
  const nz = Math.floor(z);
  if (nz <= 0) {
    return { disabled: false, white: false, scale: 1, xTran: 0, yTran: 0 };
  }
  const nDel8 = Math.floor(nz / 256);
  const nDel16 = Math.floor(nDel8 / 256);
  const nDel20 = Math.floor(nDel16 / 16);
  return {
    disabled: false,
    white: false,
    xTran: nDel8 - nDel16 * 256,
    yTran: nz - nDel8 * 256,
    scale: 1 / Math.pow(2, nDel16 - nDel20 * 16),
  };
}

/** 官方 `vTexMatrix.w = log2( uTexture0Width * vTexMatrix.z )` */
export function texMaxMip(texWidth: number, scale: number): number {
  return Math.log2(texWidth * scale);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * 官方 `calculateMipLevel` 的逐行移植。
 *
 * 四个导数参数是 `dFdx(u) / dvDx / duDy / dFdy(v)`（uv 单位每像素），
 * 内部乘 `fTile = scale*texWidth` 换成纹素单位 —— 与官方
 * `dFdx( inTexCoord * vecTile )` 完全一致。
 *
 * ★ 必须用**未 fract 的 uv** 求导：先 fract 再求导会在平铺接缝处炸出一个
 *   巨大导数，硬件会把整块面采成最糊的 mip，表现为每条接缝一条暗带。
 */
export function texMipLevel(
  duDx: number,
  dvDx: number,
  duDy: number,
  dvDy: number,
  fTile: number,
  maxMip: number
): number {
  const xU = duDx * fTile;
  const xV = dvDx * fTile;
  const yU = duDy * fTile;
  const yV = dvDy * fTile;
  const dotX = xU * xU + xV * xV;
  const dotY = yU * yU + yV * yV;
  const dMax = Math.max(dotX, dotY);
  const dMin = Math.min(dotX, dotY);
  const off = clamp((dMax - dMin) / Math.max(dMax + dMin, 1e-8), 0, 1);
  const d = dMax * (1 - off) + dMin * off;
  return clamp(0.5 * Math.log2(Math.max(d, 1e-8)), 0, maxMip - MIP_LIMIT_BIAS);
}

/**
 * 官方 `calculateTexCoord` 的逐行移植：fract → 按 mip 内缩 → 平移 + 缩放。
 *
 * `mip` 必须已经过 `texMipLevel` 的上限裁剪（≤ maxMip - 1.62），
 * 否则 `2^mip/fTile > 0.5` 时 clamp 的上下界会翻转，官方同样会出问题。
 */
export function sampleTexCoord(
  m: TexMatrix,
  u: number,
  v: number,
  texWidth: number,
  mip: number
): { u: number; v: number } {
  const fTile = Math.max(m.scale * texWidth, 1);
  const inner = Math.pow(2, mip) / fTile;
  const fu = clamp(u - Math.floor(u), inner, 1 - inner);
  const fv = clamp(v - Math.floor(v), inner, 1 - inner);
  return { u: (fu + m.xTran) * m.scale, v: (fv + m.yTran) * m.scale };
}
