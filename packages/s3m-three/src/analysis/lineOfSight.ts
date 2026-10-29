/**
 * 通视分析（单条视线）。
 *
 * 求交本体由调用方注入 —— 内核只负责「沿视线找第一个遮挡、算可见比例」，
 * 这样不依赖 three，也能在单测里用解析几何伪造求交结果。
 *
 * 场景里实际用的求交是 `THREE.Raycaster` 打全部 pickable mesh（与
 * `PickService.drillPick` 同一条路径），由 `S3MViewer.lineOfSight` 装配。
 */
import { distance3D, type Vec3 } from './measure.js';

/** 一次射线求交的结果：只关心「最近的交点距离」 */
export interface RayHit {
  /** 沿射线的距离（米） */
  distance: number;
  /** 交点位置（可选，用于画遮挡点标记） */
  point?: Vec3;
}

/**
 * 射线求交函数。
 *
 * @param origin 起点（场景 ENU 米）
 * @param dir 单位方向
 * @param maxDistance 只关心这个距离内的交点，超出可以返回 null（实现可据此提前剪枝）
 */
export type RayCast = (origin: Vec3, dir: Vec3, maxDistance: number) => RayHit | null;

export interface LineOfSightOptions {
  /**
   * 起点外推距离（米，默认 0.05）。
   *
   * 从建筑表面起步时，起点就落在三角面上，浮点误差会让射线立刻打中自己所在的
   * 那个三角面，于是「永远不可见」。沿视线方向先推一小段再求交即可避开。
   */
  originOffset?: number;
  /**
   * 终点内缩距离（米，默认 0.05）。同理：终点若贴在目标表面，不要把目标自身
   * 当成遮挡物。
   */
  targetOffset?: number;
}

export interface LineOfSightResult {
  /** 起终点之间是否通视 */
  visible: boolean;
  /** 起点到终点的直线距离（米） */
  distance: number;
  /** 第一个遮挡点距起点的距离（米）；通视时为 null */
  blockedDistance: number | null;
  /** 第一个遮挡点的位置；通视时为 null */
  blockedPoint: Vec3 | null;
  /** 可见段占全长的比例（0~1，1 = 完全通视）—— 直接用来画「绿段 / 红段」 */
  visibleRatio: number;
}

/**
 * 计算两点之间的通视情况。
 *
 * @param from 起点（场景 ENU 米）
 * @param to 终点
 * @param cast 射线求交函数
 */
export function lineOfSight(
  from: Vec3,
  to: Vec3,
  cast: RayCast,
  opts: LineOfSightOptions = {}
): LineOfSightResult {
  const total = distance3D(from, to);
  if (total <= 1e-6) {
    return { visible: true, distance: 0, blockedDistance: null, blockedPoint: null, visibleRatio: 1 };
  }

  const dir: Vec3 = [
    (to[0] - from[0]) / total,
    (to[1] - from[1]) / total,
    (to[2] - from[2]) / total,
  ];

  const startOffset = Math.max(0, opts.originOffset ?? 0.05);
  const endOffset = Math.max(0, opts.targetOffset ?? 0.05);
  // 两端各缩一点；太短的视线就不缩了，免得区间翻负
  const shrink = Math.min(startOffset + endOffset, total * 0.5);
  const origin: Vec3 = [
    from[0] + dir[0] * startOffset,
    from[1] + dir[1] * startOffset,
    from[2] + dir[2] * startOffset,
  ];
  const limit = Math.max(0, total - shrink);

  const hit = cast(origin, dir, limit);
  if (hit && hit.distance < limit) {
    // 距离要把起点外推量加回去，才是「从真实起点算起」
    const blockedDistance = Math.min(total, hit.distance + startOffset);
    return {
      visible: false,
      distance: total,
      blockedDistance,
      blockedPoint: hit.point ?? [
        from[0] + dir[0] * blockedDistance,
        from[1] + dir[1] * blockedDistance,
        from[2] + dir[2] * blockedDistance,
      ],
      visibleRatio: Math.max(0, Math.min(1, blockedDistance / total)),
    };
  }

  return { visible: true, distance: total, blockedDistance: null, blockedPoint: null, visibleRatio: 1 };
}
