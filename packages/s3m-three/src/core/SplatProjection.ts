/**
 * 高斯泼溅的屏幕空间 EWA 投影（纯数学，供单测与顶点着色器共用同一套公式）
 *
 * 旧做法是把两个主轴投到「垂直于视线」的平面上、丢掉 z 分量。薄片高斯侧对
 * 相机时被丢的那根轴直接归零，四边形塌成一条线 → 满墙空洞；远处高斯不足
 * 一个像素时又会被光栅化漏掉。这里换成标准 EWA：
 *
 *   Σ′ = J · (W R S Sᵀ Rᵀ Wᵀ) · Jᵀ      （3D 协方差 → 屏幕 2×2）
 *
 * J 是 ndc 对视图坐标的雅可比，**直接用投影矩阵的元素**求，不假设它是标准
 * 针孔透视 —— 本项目的 projectionMatrix 是 ENU→clip 的完整矩阵（w 行不是
 * 恒等的 (0,0,-1,0)），套用教科书简式会算错。
 *
 * 得到的 2×2 做特征分解，两个特征向量 × 3σ 就是四边形在 ndc 里的两根半轴。
 * 另有两道像素级处理，口径都照抄官方顶点着色器：
 *   - 低通：协方差对角加 0.3px 的方差（3DGS 论文的抗锯齿口径）；
 *   - 亚像素剔除：两根半轴都短于 2px 就整片丢弃（官方 covVectors<2 判据）。
 *     这一条是「彩色马赛克」的对症解：泼溅数据被细化到亚像素时，一个像素上
 *     压着几十个高斯，逐个画出来就是满屏噪点。
 *
 * 半轴**不会被放大**到可见尺寸。早先版本有个 minPixels 把细轴抬到 0.7px，
 * 那等于把每片薄高斯都变成一个硬点，噪点依旧、覆盖还失真 —— 已删除。
 *
 * 着色器（render/SplatMaterial.ts）里是这套公式的逐行 GLSL 版，改公式两边同步。
 */
import type * as THREE from 'three';

/** 3σ 覆盖 99.7% 的能量，与 3DGS 论文的裁剪口径一致 */
export const SPLAT_SIGMA = 3.0;
/** 抗锯齿低通的标准差（像素），3DGS 论文取 0.3 */
export const SPLAT_LOW_PASS_PIXELS = 0.3;
/**
 * 半轴的最小像素长度（≈ 官方 lambda2 下限 0.1px² 对应的 sqrt(2*0.1)）。
 * 只防完全退化，绝不是「抬成可见尺寸」—— 后者是彩色噪点的来源。
 */
export const SPLAT_MIN_AXIS_PIXELS = 0.45;
/** 两根轴都短于这个像素数就整片丢弃（官方：dot(cov, cov) < 4.0 两轴同时成立） */
export const SPLAT_CULL_PIXELS = 2.0;
/**
 * 半轴的像素上限。EWA 在中心贴近相机平面时会数值爆炸（实测近距离 max 4.2e6 px）：
 * 一个 quad 跨满整屏、只跟视锥相交出一个角，看上去就是锐角三角面和放射状拉丝。
 * 1024px 只砍这些异常投影，正常建筑（放大到贴脸看也就几百 px）碰不到。
 */
export const SPLAT_MAX_AXIS_PIXELS = 1024;

export interface SplatScreenAxesOptions {
  /** 视图空间中心（已乘过 modelViewMatrix） */
  center: ArrayLike<number>;
  /** 单位四元数 (x, y, z, w) */
  quat: ArrayLike<number>;
  /** 三个主轴半径（米） */
  scale: ArrayLike<number>;
  /** 只取旋转/缩放部分，用于把协方差带进视图空间 */
  modelView: THREE.Matrix4;
  /** 视图→clip 的完整矩阵（不要求是标准透视） */
  projection: THREE.Matrix4;
  viewportWidth: number;
  viewportHeight: number;
  /** 两根轴都短于这个像素数就剔除（返回 null）；0 = 不剔除 */
  cullPixels: number;
  /** 半轴像素上限，超过则整体等比缩小；0 / 不传 = 不封顶 */
  maxPixels?: number;
}

export interface SplatScreenAxes {
  /** ndc 半轴 A（对应四边形的 x 方向），已含 3σ 与钳制 */
  ax: number;
  ay: number;
  /** ndc 半轴 B */
  bx: number;
  by: number;
}

/**
 * 返回四边形在 ndc 里的两根半轴；相机后方（w<=0）返回 null。
 * 调用方用 `clip.xy += (position.x*A + position.y*B) * clip.w` 出顶点。
 */
export function splatScreenAxes(o: SplatScreenAxesOptions): SplatScreenAxes | null {
  const p = o.projection.elements; // 列主序
  const cx = o.center[0]!, cy = o.center[1]!, cz = o.center[2]!;

  const clipX = p[0]! * cx + p[4]! * cy + p[8]! * cz + p[12]!;
  const clipY = p[1]! * cx + p[5]! * cy + p[9]! * cz + p[13]!;
  const w = p[3]! * cx + p[7]! * cy + p[11]! * cz + p[15]!;
  if (!(w > 1e-6)) return null;

  // M = W · R · diag(s)，行向量取出后 Σ = M Mᵀ 只需要 6 个点积
  const m = o.modelView.elements;
  const [qx, qy, qz, qw] = [o.quat[0]!, o.quat[1]!, o.quat[2]!, o.quat[3]!];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  // R 的列（列主序）：R[col][row]
  const r00 = 1 - 2 * (yy + zz), r01 = 2 * (xy - wz), r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz), r11 = 1 - 2 * (xx + zz), r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy), r21 = 2 * (yz + wx), r22 = 1 - 2 * (xx + yy);
  const sx = o.scale[0]!, sy = o.scale[1]!, sz = o.scale[2]!;

  // W · R · diag(s)：W 的第 i 列乘 R 的第 j 列再乘 s_j —— 直接展开成 M 的列
  // M[col] = W * (R[col] * s_col)
  const m00 = (m[0]! * r00 + m[4]! * r10 + m[8]! * r20) * sx;
  const m10 = (m[1]! * r00 + m[5]! * r10 + m[9]! * r20) * sx;
  const m20 = (m[2]! * r00 + m[6]! * r10 + m[10]! * r20) * sx;
  const m01 = (m[0]! * r01 + m[4]! * r11 + m[8]! * r21) * sy;
  const m11 = (m[1]! * r01 + m[5]! * r11 + m[9]! * r21) * sy;
  const m21 = (m[2]! * r01 + m[6]! * r11 + m[10]! * r21) * sy;
  const m02 = (m[0]! * r02 + m[4]! * r12 + m[8]! * r22) * sz;
  const m12 = (m[1]! * r02 + m[5]! * r12 + m[9]! * r22) * sz;
  const m22 = (m[2]! * r02 + m[6]! * r12 + m[10]! * r22) * sz;

  // Σ 的上三角：行 i · 行 j
  const v00 = m00 * m00 + m01 * m01 + m02 * m02;
  const v01 = m00 * m10 + m01 * m11 + m02 * m12;
  const v02 = m00 * m20 + m01 * m21 + m02 * m22;
  const v11 = m10 * m10 + m11 * m11 + m12 * m12;
  const v12 = m10 * m20 + m11 * m21 + m12 * m22;
  const v22 = m20 * m20 + m21 * m21 + m22 * m22;

  // 雅可比：ndc = clip.xy / w，对视图坐标求偏导
  const w2 = w * w;
  const j00 = (p[0]! * w - clipX * p[3]!) / w2;
  const j01 = (p[4]! * w - clipX * p[7]!) / w2;
  const j02 = (p[8]! * w - clipX * p[11]!) / w2;
  const j10 = (p[1]! * w - clipY * p[3]!) / w2;
  const j11 = (p[5]! * w - clipY * p[7]!) / w2;
  const j12 = (p[9]! * w - clipY * p[11]!) / w2;

  // C = J Σ Jᵀ（2×2 对称）
  const c00 =
    j00 * (v00 * j00 + v01 * j01 + v02 * j02) +
    j01 * (v01 * j00 + v11 * j01 + v12 * j02) +
    j02 * (v02 * j00 + v12 * j01 + v22 * j02);
  const c01 =
    j00 * (v00 * j10 + v01 * j11 + v02 * j12) +
    j01 * (v01 * j10 + v11 * j11 + v12 * j12) +
    j02 * (v02 * j10 + v12 * j11 + v22 * j12);
  const c11 =
    j10 * (v00 * j10 + v01 * j11 + v02 * j12) +
    j11 * (v01 * j10 + v11 * j11 + v12 * j12) +
    j12 * (v02 * j10 + v12 * j11 + v22 * j12);

  // 抗锯齿低通：对角各加一个亚像素方差
  const lpx = (2 * SPLAT_LOW_PASS_PIXELS) / o.viewportWidth;
  const lpy = (2 * SPLAT_LOW_PASS_PIXELS) / o.viewportHeight;
  const d00 = c00 + lpx * lpx;
  const d11 = c11 + lpy * lpy;

  // 2×2 特征分解（解析解，无迭代）
  const mid = 0.5 * (d00 + d11);
  const half = 0.5 * (d00 - d11);
  const disc = Math.sqrt(Math.max(half * half + c01 * c01, 0));
  const l1 = mid + disc;
  const l2 = Math.max(mid - disc, 0);

  let v1x = c01, v1y = l1 - d00;
  const vlen = Math.hypot(v1x, v1y);
  if (vlen > 1e-20) {
    v1x /= vlen;
    v1y /= vlen;
  } else {
    v1x = 1;
    v1y = 0;
  }

  let r1 = SPLAT_SIGMA * Math.sqrt(Math.max(l1, 0));
  let r2 = SPLAT_SIGMA * Math.sqrt(l2);

  let ax = v1x * r1, ay = v1y * r1;
  let bx = -v1y * r2, by = v1x * r2;

  // 两道像素级处理，数值口径逐字照抄官方顶点着色器：
  //
  // ① 细轴下限。官方 `lambda2 = max(mid - radius, 0.1)`，即方差不低于 0.1px²，
  //    对应半轴 sqrt(2*0.1) ≈ 0.447px。它只防「完全退化」，**不会**把一根
  //    本来只有 1mm 的薄轴放大到肉眼可见 —— 放大才是噪点的来源。
  // ② 亚像素剔除。官方 `if (dot(cov.xy,cov.xy) < 4.0 && dot(cov.zw,cov.zw) < 4.0)
  //    discard`：两根轴都短于 2px 的高斯直接不画。泼溅数据被过度细化时，
  //    一个像素上会压着几十个亚像素高斯，逐个抬成 1px 硬点就是满屏彩色马赛克；
  //    丢掉它们，粗层的大高斯自然接管，画面才干净。
  const px = o.viewportWidth / 2;
  const py = o.viewportHeight / 2;

  // ③ 上限封顶（先于下限）。中心贴近相机平面时雅可比爆炸，半轴能到几百万像素。
  //    等比缩小两根轴，长宽比保持不变 —— 各向异性形状不能被压圆。
  //    不做这一步的表现是：一个 quad 跨满屏、与视锥只相交出一个角，
  //    画面上就是散落的锐角三角面和放射状拉丝。
  if (o.maxPixels && o.maxPixels > 0) {
    const la0 = Math.hypot(ax * px, ay * py);
    const lb0 = Math.hypot(bx * px, by * py);
    const biggest = Math.max(la0, lb0);
    if (biggest > o.maxPixels) {
      const k = o.maxPixels / biggest;
      ax *= k;
      ay *= k;
      bx *= k;
      by *= k;
    }
  }

  const floorPx = SPLAT_MIN_AXIS_PIXELS;
  const la = Math.hypot(ax * px, ay * py);
  const lb = Math.hypot(bx * px, by * py);
  if (la < floorPx) {
    if (la > 1e-20) {
      const k = floorPx / la;
      ax *= k;
      ay *= k;
    } else {
      ax = (2 * floorPx) / o.viewportWidth;
      ay = 0;
    }
  }
  if (lb < floorPx) {
    if (lb > 1e-20) {
      const k = floorPx / lb;
      bx *= k;
      by *= k;
    } else {
      bx = 0;
      by = (2 * floorPx) / o.viewportHeight;
    }
  }

  if (o.cullPixels > 0) {
    const ca = Math.hypot(ax * px, ay * py);
    const cb = Math.hypot(bx * px, by * py);
    if (ca < o.cullPixels && cb < o.cullPixels) return null;
  }

  return { ax, ay, bx, by };
}
