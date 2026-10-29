/**
 * 单元测试：三维空间分析内核（量算 / 通视 / 裁剪半空间）。
 *
 * 这三块都是纯数学，不碰 WebGL —— 按项目规矩先钉住数值口径，
 * 后面接 `S3MViewer` 的 GPU 部分才有可回归的基准。
 *
 * 重点覆盖「容易算错但没人发现」的地方：
 * - 面积要区分「坡面真实面积」与「水平投影面积」；
 * - 通视要处理「起点就在表面上」的自遮挡；
 * - 裁剪法线方向（three 的口径是保留 normal 指向的一侧）。
 */
import { describe, expect, test } from 'bun:test';
import {
  boxClipping,
  buildClipPlanes,
  crossClipping,
  isPointKept,
  planeFromPointNormal,
  type PlaneLike,
} from '../../packages/s3m-three/src/analysis/clipping';
import { lineOfSight, type RayCast } from '../../packages/s3m-three/src/analysis/lineOfSight';
import {
  distance3D,
  distanceHorizontal,
  heightDifference,
  measureSegment,
  polygonArea,
  polygonAreaHorizontal,
  polygonPerimeter,
  polylineLength,
  polylineLengthHorizontal,
  type Vec3,
} from '../../packages/s3m-three/src/analysis/measure';

/* ------------------------------------------------------------------ 量算 */

describe('距离与高差', () => {
  test('三维距离：3-4-12 勾股', () => {
    expect(distance3D([0, 0, 0], [3, 4, 12])).toBeCloseTo(13, 6);
  });

  test('水平距离忽略高程差', () => {
    expect(distanceHorizontal([0, 0, 100], [3, 4, 0])).toBeCloseTo(5, 6);
  });

  test('高差有符号：b 比 a 低为负', () => {
    expect(heightDifference([0, 0, 10], [0, 0, 2.5])).toBeCloseTo(-7.5, 6);
  });

  test('measureSegment 一次给全三种口径', () => {
    const r = measureSegment([0, 0, 0], [3, 4, 12]);
    expect(r.distance3D).toBeCloseTo(13, 6);
    expect(r.distanceHorizontal).toBeCloseTo(5, 6);
    expect(r.heightDiff).toBeCloseTo(12, 6);
  });
});

describe('折线长度', () => {
  test('逐段求和，空/单点返回 0', () => {
    expect(polylineLength([])).toBe(0);
    expect(polylineLength([[1, 1, 1]])).toBe(0);
    expect(polylineLength([[0, 0, 0], [3, 4, 0], [3, 4, 12]])).toBeCloseTo(17, 6);
  });

  test('水平折线长度不含高程', () => {
    expect(polylineLengthHorizontal([[0, 0, 0], [0, 0, 100]])).toBe(0);
    expect(polylineLengthHorizontal([[0, 0, 0], [3, 4, 9]])).toBeCloseTo(5, 6);
  });
});

describe('多边形面积', () => {
  const square: Vec3[] = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
  ];

  test('水平正方形：面积 100，与绕向无关', () => {
    expect(polygonArea(square)).toBeCloseTo(100, 6);
    expect(polygonArea([...square].reverse())).toBeCloseTo(100, 6);
  });

  test('周长自动闭合（不要重复传首点）', () => {
    expect(polygonPerimeter(square)).toBeCloseTo(40, 6);
  });

  test('三点以下为 0，不抛错', () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([[0, 0, 0], [1, 0, 0]])).toBe(0);
  });

  test('绕 y 轴倾斜 45° 的正方形：坡面面积仍是 100，水平投影 = 100·cos45°', () => {
    const c = Math.cos(Math.PI / 4);
    const s = Math.sin(Math.PI / 4);
    // 边长 10 的正方形绕 y 轴转 45°：x 方向压缩到 cos45，z 方向抬起来
    const slope: Vec3[] = [
      [0, 0, 0],
      [10 * c, 0, 10 * s],
      [10 * c, 10, 10 * s],
      [0, 10, 0],
    ];
    expect(polygonArea(slope)).toBeCloseTo(100, 4);
    expect(polygonAreaHorizontal(slope)).toBeCloseTo(100 * c, 4);
  });

  test('坡面面积 > 水平投影面积（同一条边斜上去的情况）', () => {
    // 底边沿 x 走 10，另一边斜向上走 45°：真实面积 100√2，投影 100
    const slope: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 10],
      [0, 10, 10],
    ];
    expect(polygonArea(slope)).toBeCloseTo(100 * Math.SQRT2, 4);
    expect(polygonAreaHorizontal(slope)).toBeCloseTo(100, 6);
  });

  test('三角形面积', () => {
    expect(polygonArea([[0, 0, 0], [10, 0, 0], [0, 10, 0]])).toBeCloseTo(50, 6);
  });
});

/* ------------------------------------------------------------------ 通视 */

describe('通视分析', () => {
  const from: Vec3 = [0, 0, 10];
  const to: Vec3 = [100, 0, 10];

  test('没有任何交点 → 通视', () => {
    const cast: RayCast = () => null;
    const r = lineOfSight(from, to, cast);
    expect(r.visible).toBe(true);
    expect(r.blockedDistance).toBeNull();
    expect(r.visibleRatio).toBe(1);
    expect(r.distance).toBeCloseTo(100, 6);
  });

  test('中途有遮挡 → 不可见，比例按遮挡点位置算', () => {
    const cast: RayCast = () => ({ distance: 50 });
    const r = lineOfSight(from, to, cast);
    expect(r.visible).toBe(false);
    expect(r.blockedDistance).toBeCloseTo(50.05, 2); // 含起点外推量
    expect(r.visibleRatio).toBeCloseTo(0.5, 2);
  });

  test('交点落在终点之外（比视线还远）→ 不算遮挡', () => {
    const cast: RayCast = () => ({ distance: 120 });
    expect(lineOfSight(from, to, cast).visible).toBe(true);
  });

  test('交点正好在 limit 上 → 视为通视（终点自身表面不算遮挡）', () => {
    const cast: RayCast = () => ({ distance: 100 - 0.1 });
    expect(lineOfSight(from, to, cast).visible).toBe(true);
  });

  test('起点外推：传给求交的原点已沿视线前移，避免打中自己所在的面', () => {
    let seenOrigin: Vec3 | null = null;
    const cast: RayCast = (origin) => {
      seenOrigin = origin;
      return null;
    };
    lineOfSight([0, 0, 0], [10, 0, 0], cast, { originOffset: 0.5 });
    expect(seenOrigin![0]).toBeCloseTo(0.5, 6);
  });

  test('遮挡点位置：没给 point 时按方向反推', () => {
    const cast: RayCast = () => ({ distance: 25 });
    const r = lineOfSight([0, 0, 0], [100, 0, 0], cast);
    expect(r.blockedPoint![0]).toBeCloseTo(25.05, 2);
    expect(r.blockedPoint![1]).toBeCloseTo(0, 6);
  });

  test('零长度视线直接判通视，不除零', () => {
    const r = lineOfSight([1, 2, 3], [1, 2, 3], () => ({ distance: 0 }));
    expect(r.visible).toBe(true);
    expect(r.distance).toBe(0);
    expect(Number.isFinite(r.visibleRatio)).toBe(true);
  });

  test('极短视线：两端内缩量自动收敛，不会翻负区间', () => {
    const cast: RayCast = (_o, _d, max) => {
      expect(max).toBeGreaterThanOrEqual(0);
      return null;
    };
    const r = lineOfSight([0, 0, 0], [0.01, 0, 0], cast, { originOffset: 1, targetOffset: 1 });
    expect(r.visible).toBe(true);
  });
});

/* ------------------------------------------------------------------ 裁剪 */

/** three 的判据：normal·p + constant >= 0 保留 */
function kept(planes: readonly PlaneLike[], p: Vec3): boolean {
  return isPointKept(planes, p);
}

describe('裁剪半空间', () => {
  test('平面裁剪：法线指向的一侧保留', () => {
    const planes = planeFromPointNormal([1, 0, 0], [5, 0, 0]);
    expect(kept([planes], [6, 0, 0])).toBe(true);
    expect(kept([planes], [4, 0, 0])).toBe(false);
    expect(kept([planes], [5, 0, 0])).toBe(true); // 边界保留
  });

  test('平面法线自动单位化（传 (2,0,0) 与 (1,0,0) 等价）', () => {
    const a = planeFromPointNormal([2, 0, 0], [5, 0, 0]);
    const b = planeFromPointNormal([1, 0, 0], [5, 0, 0]);
    expect(a.constant).toBeCloseTo(b.constant, 9);
    expect(a.normal[0]).toBeCloseTo(1, 9);
  });

  test('Box 裁剪：盒内保留，盒外丢弃（对角点顺序无所谓）', () => {
    const planes = boxClipping({ a: [10, 10, 10], b: [0, 0, 0] });
    expect(planes.length).toBe(6);
    expect(kept(planes, [5, 5, 5])).toBe(true);
    expect(kept(planes, [-1, 5, 5])).toBe(false);
    expect(kept(planes, [11, 5, 5])).toBe(false);
    expect(kept(planes, [5, 5, -0.1])).toBe(false);
    expect(kept(planes, [5, 5, 10.1])).toBe(false);
  });

  test('Box 边界上的点保留（不会漏掉贴边的面）', () => {
    const planes = boxClipping({ a: [0, 0, 0], b: [10, 10, 10] });
    expect(kept(planes, [0, 0, 0])).toBe(true);
    expect(kept(planes, [10, 10, 10])).toBe(true);
  });

  test('十字剖切：切掉一个象限，保留另外三个', () => {
    const planes = crossClipping({ center: [0, 0, 0], keepX: -1, keepY: -1 });
    expect(planes.length).toBe(2);
    expect(kept(planes, [-5, -5, 3])).toBe(true); // 保留象限
    expect(kept(planes, [5, 5, 3])).toBe(false); // 被切掉的象限
    expect(kept(planes, [-5, 5, 3])).toBe(false); // 另一侧同样被切
  });

  test('十字剖切加水平面：切掉一个角', () => {
    const planes = crossClipping({ center: [0, 0, 0], keepX: -1, keepY: -1, horizontal: true, keepZ: -1 });
    expect(planes.length).toBe(3);
    expect(kept(planes, [-5, -5, -5])).toBe(true);
    expect(kept(planes, [-5, -5, 5])).toBe(false);
  });

  test('buildClipPlanes 按 type 分派', () => {
    expect(buildClipPlanes({ type: 'plane', normal: [0, 0, 1], point: [0, 0, 0] }).length).toBe(1);
    expect(buildClipPlanes({ type: 'box', a: [0, 0, 0], b: [1, 1, 1] }).length).toBe(6);
    expect(buildClipPlanes({ type: 'cross', center: [0, 0, 0], keepX: 1, keepY: 1 }).length).toBe(2);
  });

  test('退化输入不产生 NaN（法线传零向量时兜底成 +z）', () => {
    const pl = planeFromPointNormal([0, 0, 0], [1, 2, 3]);
    expect(Number.isFinite(pl.constant)).toBe(true);
    expect(pl.normal).toEqual([0, 0, 1]);
  });
});
