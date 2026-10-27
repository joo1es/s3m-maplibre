/**
 * 缓动曲线库
 *
 * 纯函数，不依赖 three / DOM，可以单独在 Worker 或 Node 里跑。
 *
 * 三类：
 *   1. 命名曲线 —— CSS 那套 easeIn/Out/InOut × Quad…Bounce，覆盖 90% 场景
 *   2. cubicBezier(x1,y1,x2,y2) —— 与 CSS `cubic-bezier()` 数值对齐，用来做产品级调校
 *   3. steps(n, position) —— 离散跳变，做逐帧动画或「咔哒」感
 *
 * spring 不在这里：它没有「时长」概念，靠物理收敛，所以实现为 Animator 里的一种
 * Track 类型，而不是 (t) => number 的曲线。
 */

export type EasingFn = (t: number) => number;

/* ------------------------------------------------------------------ 基础 */

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;
const n1 = 7.5625;
const d1 = 2.75;

function outBounce(t: number): number {
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    const x = t - 1.5 / d1;
    return n1 * x * x + 0.75;
  }
  if (t < 2.5 / d1) {
    const x = t - 2.25 / d1;
    return n1 * x * x + 0.9375;
  }
  const x = t - 2.625 / d1;
  return n1 * x * x + 0.984375;
}

function inBounce(t: number): number {
  return 1 - outBounce(1 - t);
}

/* ------------------------------------------------------------------ 曲线表 */

const CURVES = {
  linear: (t) => t,

  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),

  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),

  easeInQuart: (t) => t * t * t * t,
  easeOutQuart: (t) => 1 - Math.pow(1 - t, 4),
  easeInOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),

  easeInQuint: (t) => t * t * t * t * t,
  easeOutQuint: (t) => 1 - Math.pow(1 - t, 5),
  easeInOutQuint: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),

  easeInSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,

  easeInExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInOutExpo: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,

  easeInCirc: (t) => 1 - Math.sqrt(1 - t * t),
  easeOutCirc: (t) => Math.sqrt(1 - Math.pow(t - 1, 2)),
  easeInOutCirc: (t) =>
    t < 0.5
      ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
      : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2,

  easeInBack: (t) => c3 * t * t * t - c1 * t * t,
  easeOutBack: (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  easeInOutBack: (t) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,

  easeInElastic: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4),
  easeOutElastic: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1,
  easeInOutElastic: (t) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
          : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1,

  easeInBounce: inBounce,
  easeOutBounce: outBounce,
  easeInOutBounce: (t) => (t < 0.5 ? (1 - inBounce(1 - 2 * t)) / 2 : (1 + inBounce(2 * t - 1)) / 2),
} satisfies Record<string, EasingFn>;

/** 全部内置曲线名（顺序稳定，方便做下拉框 / 遍历自检） */
export const EASING_NAMES = Object.keys(CURVES) as EasingName[];

export type EasingName = keyof typeof CURVES;

/** 按名字取曲线；名字不存在直接抛错，不做静默降级（拼错会变成「没动画」，很难查） */
export function easing(name: EasingName | EasingFn): EasingFn {
  if (typeof name === 'function') return name;
  const fn = (CURVES as Record<string, EasingFn>)[name];
  if (!fn) throw new Error(`[s3m] 未知的缓动曲线: ${String(name)}`);
  return fn;
}

/* ------------------------------------------------------------------ 贝塞尔 */

const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 12;

const bezA = (a1: number, a2: number): number => 1 - 3 * a2 + 3 * a1;
const bezB = (a1: number, a2: number): number => 3 * a2 - 6 * a1;
const bezC = (a1: number): number => 3 * a1;

/** 三次贝塞尔在参数 t 处的值（x 或 y 用同一组公式，只是控制点不同） */
function bezierAt(t: number, a1: number, a2: number): number {
  return ((bezA(a1, a2) * t + bezB(a1, a2)) * t + bezC(a1)) * t;
}

function bezierSlope(t: number, a1: number, a2: number): number {
  return 3 * bezA(a1, a2) * t * t + 2 * bezB(a1, a2) * t + bezC(a1);
}

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` 的等价实现。
 *
 * 与浏览器一致：先解 `x(t) = 输入进度` 得到参数 t，再取 `y(t)`。
 * 用牛顿迭代，斜率过小时退化为二分——退化控制点（比如 (0,0,1,1)）也稳定。
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  // 线性特例：控制点落在对角线上时不必迭代
  if (x1 === y1 && x2 === y2) return (t) => t;

  const solveT = (x: number): number => {
    let t = x;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const slope = bezierSlope(t, x1, x2);
      if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
      const err = bezierAt(t, x1, x2) - x;
      if (Math.abs(err) < SUBDIVISION_PRECISION) return t;
      t -= err / slope;
    }
    // 牛顿不收敛：二分兜底
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < SUBDIVISION_MAX_ITERATIONS; i++) {
      const v = bezierAt(t, x1, x2);
      if (Math.abs(v - x) < SUBDIVISION_PRECISION) return t;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return bezierAt(solveT(t), y1, y2);
  };
}

/* ------------------------------------------------------------------ 离散 */

/**
 * 阶梯曲线。
 *
 * @param count    档数
 * @param position 'end' 表示「走完一档才跳」，'start' 表示「一进档就跳」
 */
export function steps(count: number, position: 'start' | 'end' = 'end'): EasingFn {
  const n = Math.max(1, Math.floor(count));
  return (t: number): number => {
    const clamped = Math.min(1, Math.max(0, t));
    if (position === 'start') return Math.min(1, (Math.floor(clamped * n) + 1) / n);
    return Math.min(1, Math.floor(clamped * n) / n);
  };
}
