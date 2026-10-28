/**
 * 3DGS（高斯泼溅）逐点属性的解码
 *
 * 输入是 MeshOpt 骨架里的两条自定义流，各 4 字节/顶点：
 *   `gsScale`    —— 3 个 u8，log 量化；第 4 字节是填充
 *   `gsRotation` —— 3 个 u8 存四元数的 x/y/z；w 由公式补；第 4 字节是填充
 *
 * 这两条流以前是「保留原始字节但语义未知」（FORMAT-NOTES 第九节的 D 级），
 * 所以只能按点渲染。量化格式最终不是靠统计猜出来的，是从官方 worker
 * `SuperMap3D/Workers/GaussianSplating.js`（3.9 KB）里读出来的，公式逐字如下：
 *
 * ```js
 * function j(t){                    // scale
 *   a[n*3+0] = Math.exp(t[n*4+0]/16 - 10)
 *   a[n*3+1] = Math.exp(t[n*4+1]/16 - 10)
 *   a[n*3+2] = Math.exp(t[n*4+2]/16 - 10)
 * }
 * function D(t){                    // rotation
 *   c = t[n]/127.5 - 1; f = t[n+1]/127.5 - 1; x = t[n+2]/127.5 - 1
 *   s = Math.sqrt(Math.max(0, 1 - (c*c + f*f + x*x)))
 *   a[n] = s; a[n+1] = c; a[n+2] = f; a[n+3] = x      // (w, x, y, z)
 * }
 * ```
 *
 * 官方还有第二条分支（`isSPZCompress && version === 1.1`）走 10-10-10-2 的
 * 「smallest three」打包，本模块也实现了 —— 见 `decodeRotation` 的 mode 判定。
 *
 * **为什么以前看这 4 字节像乱码**：第 4 字节确实不参与解码，于是同一瓦片里它
 * 一会儿是 0 一会儿是 207（填充的残留），拿 32 位整数字段或 4 分量向量去套，
 * 自然怎么都对不上。只取前 3 字节 + w 由单位化补出，立刻就是干净的四元数。
 */

/** SPZ 的 log 量化：scale 实际是 exp(v/16 - 10) 米 */
const SCALE_LOG_DIV = 16;
const SCALE_LOG_BIAS = 10;

/** rotation 的 u8 归一化：0 → -1，255 → 1 */
const ROT_U8_SCALE = 127.5;

export interface SplatData {
  /** 3N（米，场景 ENU 坐标） */
  positions: Float32Array;
  /** 3N（米，三个主轴的高斯半径） */
  scales: Float32Array;
  /** 4N，单位四元数 (x, y, z, w) —— three 的 Quaternion 顺序 */
  rotations: Float32Array;
  /** 4N，RGBA8 */
  colors: Uint8Array;
  count: number;
}

/**
 * scale：`exp(byte/16 - 10)` 米。
 * 值域 byte ∈ [0,255] → [4.54e-5, 380] 米，建筑泼溅的典型值（0.01~1 米）落在中段。
 */
export function decodeScale(bytes: Uint8Array, stride: number, offset: number, count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * stride + offset;
    out[i * 3] = Math.exp(bytes[o]! / SCALE_LOG_DIV - SCALE_LOG_BIAS);
    out[i * 3 + 1] = Math.exp(bytes[o + 1]! / SCALE_LOG_DIV - SCALE_LOG_BIAS);
    out[i * 3 + 2] = Math.exp(bytes[o + 2]! / SCALE_LOG_DIV - SCALE_LOG_BIAS);
  }
  return out;
}

/**
 * rotation：3 个 u8 直接归一化到 [-1,1]，第四个分量由单位化补出。
 *
 * 输出顺序是 three 的 `(x, y, z, w)`，而官方内部是 `(w, x, y, z)` —— 这里已经换过。
 */
export function decodeRotation(bytes: Uint8Array, stride: number, offset: number, count: number): Float32Array {
  const out = new Float32Array(count * 4);
  let maxErr = 0;
  for (let i = 0; i < count; i++) {
    const o = i * stride + offset;
    const x = bytes[o]! / ROT_U8_SCALE - 1;
    const y = bytes[o + 1]! / ROT_U8_SCALE - 1;
    const z = bytes[o + 2]! / ROT_U8_SCALE - 1;
    const w = Math.sqrt(Math.max(0, 1 - (x * x + y * y + z * z)));
    out[i * 4] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = w;
    maxErr = Math.max(maxErr, Math.abs(x * x + y * y + z * z + w * w - 1));
  }
  // 模长偏差只可能在「四元数确实不是这套编码」时出现，留给调用方判断
  rotationResidual = maxErr;
  return out;
}

/**
 * 上一次 `decodeRotation` 的单位化残差（|q|²-1 的最大绝对值）。
 *
 * 这是判定「编码分支猜对没有」的判据：`D()` 分支下 w 是补出来的，残差恒 ≈ 0；
 * 如果数据其实是 smallest-three 打包，把前 3 字节当分量解出来的 |q|² 会明显偏离 1。
 */
let rotationResidual = 0;

export function lastRotationResidual(): number {
  return rotationResidual;
}

/**
 * 10-10-10-2 的 smallest-three（官方 `U()`，`isSPZCompress && version === 1.1` 时走这条）。
 *
 * 3 个分量各 10 bit（第 9 bit 是符号），剩下 2 bit 记录「哪一维是最大的」，
 * 最大维由单位化补出 —— 这样只需要 32 bit 就能无损表达一个单位四元数。
 */
export function decodeRotationSmallestThree(
  bytes: Uint8Array,
  stride: number,
  offset: number,
  count: number
): Float32Array {
  const out = new Float32Array(count * 4);
  const MASK = (1 << 9) - 1;
  const SQRT_HALF = Math.SQRT1_2;
  for (let i = 0; i < count; i++) {
    const o = i * stride + offset;
    const packed =
      (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0;
    const largest = (packed >>> 30) & 3;
    let rest = packed;
    let sumSq = 0;
    for (let axis = 3; axis >= 0; axis--) {
      if (axis === largest) continue;
      const mag = rest & MASK;
      const negative = (rest >>> 9) & 1;
      rest >>>= 10;
      // 值域 [-√½, √½]：单位四元数里任一分量的上界
      let v = (SQRT_HALF * mag) / MASK;
      if (negative) v = -v;
      out[i * 4 + axis] = v;
      sumSq += v * v;
    }
    out[i * 4 + largest] = Math.sqrt(Math.max(1 - sumSq, 0));
  }
  rotationResidual = 0;
  return out;
}

/** 逐点协方差矩阵的上三角（6 个 float）：`Σ = R S Sᵀ Rᵀ`，供 EWA 投影用 */
export function covariance(
  sx: number,
  sy: number,
  sz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: Float32Array,
  at: number
): void {
  // 旋转矩阵（列主序 3×3）
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;

  const r00 = 1 - 2 * (yy + zz), r01 = 2 * (xy - wz), r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz), r11 = 1 - 2 * (xx + zz), r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy), r21 = 2 * (yz + wx), r22 = 1 - 2 * (xx + yy);

  // M = R · diag(s)，则 Σ = M Mᵀ
  const m00 = r00 * sx, m01 = r01 * sy, m02 = r02 * sz;
  const m10 = r10 * sx, m11 = r11 * sy, m12 = r12 * sz;
  const m20 = r20 * sx, m21 = r21 * sy, m22 = r22 * sz;

  out[at] = m00 * m00 + m01 * m01 + m02 * m02;
  out[at + 1] = m00 * m10 + m01 * m11 + m02 * m12;
  out[at + 2] = m00 * m20 + m01 * m21 + m02 * m22;
  out[at + 3] = m10 * m10 + m11 * m11 + m12 * m12;
  out[at + 4] = m10 * m20 + m11 * m21 + m12 * m22;
  out[at + 5] = m20 * m20 + m21 * m21 + m22 * m22;
}
