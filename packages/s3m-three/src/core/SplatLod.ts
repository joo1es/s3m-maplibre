/**
 * 泼溅 / 点云瓦片的细化判据
 *
 * 判据只有一条：**单个高斯在屏幕上有多大**。3σ 半轴超过 `SPLAT_REFINE_PX` 像素
 * 就再细化一层 —— 一个高斯铺出十几二十个像素时，它已经把整片屋顶/柱子糊成一坨，
 * 细节全在「这一片高斯自己」里，再远的层级也换不回来。
 *
 * 走过两轮弯路，都不要再回去：
 *
 *   1. **包围球投影像素 vs rangeValue**（网格 LOD 的判据）。泼溅每层的 σ 是同一个
 *      物理量，包围球半径和 rangeValue 跟「画面够不够密」没有因果关系。实测寿宁阁
 *      的 rangeMode=2、rangeValue≈0.066·半径，按它算在任何距离都远大于阈值，等于
 *      「永远细化到叶子」。
 *
 *   2. **屏幕覆盖率**（`高斯数/包围球投影面积 × 单个高斯面积`）。看起来很有道理，
 *      但实测下来是个陷阱：根瓦片 σ=0.21 m、1888 个点，覆盖率就已经算到 1.7；
 *      子瓦片直接跳到 8 —— 于是**在第二层就停了**，最终只画了 35.6 万个高斯，
 *      占总量 2.3%。而官方是画到叶子层。21 cm 的高斯画不出 30 cm 宽的柱子，
 *      画面上就是「柱子没了、到处是一坨坨横着的糊斑」。
 *      覆盖率回答的是「屏幕盖满了没有」，盖满了也完全可能全是粗高斯。
 *
 * 所以现在改成屏幕尺寸判据。它天然自带下限：`splatPx` 已经小到着色器会剔除的量级
 * （见 SplatProjection 的 `SPLAT_CULL_PIXELS`）时不再细化，再下一层只是白下载。
 */
import { SPLAT_SIGMA } from './SplatProjection.js';

/**
 * 3σ 半轴超过这个像素数就继续细化。
 *
 * 4 px 意味着单个高斯在屏幕上约 8 px 宽 —— 再细下去肉眼分辨不出，却要多占几倍显存
 * （每深一层点数约 ×5）。着色器的亚像素剔除线是 2 px 半径，这里留了一倍余量。
 */
export const SPLAT_REFINE_PX = 4.0;

/** 垂直视场角写死 45°，与 LOD 其它路径、官方 PageLod 口径一致 */
const HALF_FOV_TAN = Math.tan(Math.PI / 8);

/** 高斯实际可见面积相对 π(3σ)² 的比例（exp(-4r²) 衰减下的等效半径） */
const EFFECTIVE_AREA_RATIO = 0.25;

export interface SplatLodInput {
  /** 该瓦片里的高斯数 */
  splats: number;
  /** 包围球半径（米） */
  radius: number;
  /** 相机到球心距离（米） */
  distance: number;
  /** 该瓦片高斯的代表性半轴（米）；0/缺省 = 未知，退回调用方的通用判据 */
  sigma: number;
  /** 绘图缓冲高度（像素） */
  screenHeight: number;
  /** 是否还有子瓦片 */
  hasChild: boolean;
}

export interface SplatLodResult {
  /** 3σ 半轴在屏幕上的长度（像素）—— 判据本体 */
  splatPx: number;
  /** 每像素高斯数（诊断用） */
  density: number;
  /** 屏幕覆盖率（诊断用；**不是**判据，原因见文件头） */
  coverage: number;
  needRefine: boolean;
}

/**
 * 决定泼溅瓦片要不要再细化一层。
 * `sigma <= 0` 时返回 `needRefine: false`，调用方应退回原判据。
 */
export function splatLodDecision(o: SplatLodInput): SplatLodResult {
  const dist = Math.max(o.distance, 1e-6);
  const ppm = o.screenHeight / 2 / HALF_FOV_TAN / dist;
  const splatPx = SPLAT_SIGMA * Math.max(o.sigma, 0) * ppm;
  if (!(o.sigma > 0) || !(o.radius > 0)) {
    return { splatPx, density: 0, coverage: 0, needRefine: false };
  }

  const areaPx = Math.PI * (ppm * o.radius) ** 2;
  const density = areaPx > 1e-6 ? o.splats / areaPx : 0;
  const coverage = density * Math.PI * splatPx * splatPx * EFFECTIVE_AREA_RATIO;
  const needRefine = o.hasChild && splatPx > SPLAT_REFINE_PX;
  return { splatPx, density, coverage, needRefine };
}
