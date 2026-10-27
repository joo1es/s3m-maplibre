/**
 * 动画调度器
 *
 * 设计要点（详见 docs/ANIMATION.md）：
 *
 *   1. **单一写者**：一帧内同一通道只由 tick() 写一次。公开 API 只写目标值，
 *      渲染器永远不去猜「现在该显示什么」。
 *   2. **同键合并**：Map<channelKey, Track>，重复调用只换目标、不叠队列。
 *   3. **从当前值续走**：打断时起点取通道的**实际显示值**，不取逻辑终值，
 *      所以连续调用不会跳回起点。
 *   4. **空闲零成本**：没有 track 时 tick() 第一行就返回 false。
 *   5. **预算可中断**：单帧写入超时就把剩下的留到下一帧——因为推进是按绝对
 *      时间算的，跳一帧不丢状态，只是晚一帧显示。
 *
 * 不依赖 three / DOM：通道的读写由调用方注入，所以可以直接在 Node 里跑单测。
 */
import { easing, type EasingFn, type EasingName } from './easing.js';

/** 通道：把「某个属性」抽象成一段可读可写的浮点向量 */
export interface Channel {
  /** 维度：1 = 标量（透明度 / 强度），3 = 向量（颜色 / 平移） */
  readonly dim: 1 | 3;
  /** 读当前显示值，写进 out[0..dim-1]。用于打断时取起点 */
  read(out: Float32Array): void;
  /** 写一帧的值。实现必须是 O(1) 且不分配——它会在每帧被调用 */
  write(v: Float32Array): void;
}

export interface SpringSpec {
  /** 刚度，越大越快（典型 80~300） */
  stiffness: number;
  /** 阻尼，越小越弹（典型 10~30；= 2√stiffness 为临界阻尼） */
  damping: number;
  /** 收敛阈值，位移与速度同时小于该值即判定结束 */
  epsilon?: number;
}

export interface TransitionOptions {
  /** 时长（毫秒）。0 / 不传 = 立即生效 */
  duration?: number;
  /** 延迟（毫秒） */
  delay?: number;
  /** 缓动曲线：内置名或自定义函数 */
  easing?: EasingName | EasingFn;
  /**
   * 打断策略：
   * - 'proportional'（默认）按剩余距离等比缩短时长，表现为恒速跟随
   * - 'fixed' 每次都用完整时长
   */
  retarget?: 'proportional' | 'fixed';
  /** 改用弹簧：有它就忽略 duration / easing */
  spring?: SpringSpec;
  /**
   * 批量错峰间隔（毫秒）。只有 `animateFeatures` 这类批量接口会消费它：
   * 一万个单体错峰 8ms，总时长不变，但每帧只动一小批，峰值天然摊平。
   */
  stagger?: number;
  /** 本次动画结束（或被 finish）时回调 */
  onComplete?: () => void;
}

const EPS = 1e-4;
const MIN_DURATION_RATIO = 0.15;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 两个向量的最大分量距离，用来算「剩余距离 / 总距离」 */
function maxDist(a: Float32Array, b: Float32Array, dim: number): number {
  let m = 0;
  for (let i = 0; i < dim; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

/* ------------------------------------------------------------------ Track */

abstract class Track {
  readonly key: string;
  readonly channel: Channel;
  readonly dim: 1 | 3;
  readonly to = new Float32Array(3);
  protected readonly _cur = new Float32Array(3);
  done = false;
  onComplete?: () => void;

  constructor(key: string, channel: Channel) {
    this.key = key;
    this.channel = channel;
    this.dim = channel.dim;
  }

  /** 推进到 now 并写入通道；返回是否已结束 */
  abstract advance(now: number): void;
  abstract retarget(to: Float32Array, now: number, opts: TransitionOptions): void;
  abstract get progress(): number;
}

/** 时间驱动的补间：from → to，按缓动曲线映射进度 */
class TweenTrack extends Track {
  private readonly _from = new Float32Array(3);
  private _start = 0;
  private _duration = 0;
  private _delay = 0;
  private _ease: EasingFn = easing('linear');
  private _retarget: 'proportional' | 'fixed' = 'proportional';
  /** 本次补间的原始总距离，用来做等比缩时长 */
  private _span = 0;
  private _progress = 0;

  get progress(): number {
    return this._progress;
  }

  start(now: number, opts: TransitionOptions, from?: Float32Array): void {
    if (from) this._from.set(from.subarray(0, this.dim));
    else this.channel.read(this._from);
    this._start = now;
    this._delay = Math.max(0, opts.delay ?? 0);
    this._duration = Math.max(0, opts.duration ?? 0);
    this._ease = opts.easing ? easing(opts.easing) : easing('linear');
    this._retarget = opts.retarget ?? 'proportional';
    this._span = maxDist(this._from, this.to, this.dim);
    this._progress = 0;
    this.done = false;
  }

  advance(now: number): void {
    const elapsed = now - this._start - this._delay;
    const t = this._duration <= 0 ? 1 : clamp01(elapsed / this._duration);
    this._progress = t;
    const k = this._ease(t);
    for (let i = 0; i < this.dim; i++) {
      this._cur[i] = this._from[i] + (this.to[i] - this._from[i]) * k;
    }
    this.channel.write(this._cur);
    if (t >= 1) this.done = true;
  }

  retarget(to: Float32Array, now: number, opts: TransitionOptions): void {
    // 起点取通道实际显示值——这是「不跳回起点」的关键
    this.channel.read(this._from);
    this.to.set(to.subarray(0, this.dim));

    const base = Math.max(0, opts.duration ?? this._duration);
    let duration = base;
    if ((opts.retarget ?? this._retarget) !== 'fixed' && this._span > EPS) {
      const remain = maxDist(this._from, this.to, this.dim);
      const ratio = remain / this._span;
      duration = Math.min(base, Math.max(base * MIN_DURATION_RATIO, base * ratio));
    }

    this._start = now;
    this._delay = Math.max(0, opts.delay ?? 0);
    this._duration = duration;
    this._ease = opts.easing ? easing(opts.easing) : this._ease;
    this._span = maxDist(this._from, this.to, this.dim);
    this._progress = 0;
    this.done = false;
  }
}

/**
 * 弹簧：没有时长概念，靠物理收敛。
 *
 * 用**解析解**而不是逐帧欧拉积分：帧率抖动、切标签页回来、单帧 dt 很大，
 * 结果都一样，且不累积误差。中断时只换 target，位置和速度天然连续。
 */
class SpringTrack extends Track {
  private readonly _x0 = new Float32Array(3);
  private readonly _v0 = new Float32Array(3);
  private readonly _vel = new Float32Array(3);
  private _start = 0;
  private _k = 120;
  private _c = 14;
  private _eps = 1e-3;
  private _progress = 0;

  get progress(): number {
    // 弹簧没有天然进度，用「距离收敛比例」近似，仅用于调试展示
    return this._progress;
  }

  start(now: number, opts: TransitionOptions, from?: Float32Array): void {
    const sp = opts.spring ?? { stiffness: 120, damping: 14 };
    this._k = Math.max(1e-3, sp.stiffness);
    this._c = Math.max(0, sp.damping);
    this._eps = sp.epsilon ?? 1e-3;

    if (from) this._x0.set(from.subarray(0, this.dim));
    else this.channel.read(this._x0);
    this._v0.fill(0);
    this._vel.fill(0);
    this._start = now;
    this.done = false;
    this._progress = 0;
  }

  advance(now: number): void {
    const t = Math.max(0, (now - this._start) / 1000);
    let settled = true;
    for (let i = 0; i < this.dim; i++) {
      const { x, v } = springAt(this._x0[i] - this.to[i], this._v0[i], this._k, this._c, t);
      this._cur[i] = this.to[i] + x;
      this._vel[i] = v;
      if (Math.abs(x) > this._eps || Math.abs(v) > this._eps) settled = false;
    }
    this.channel.write(this._cur);
    if (settled) {
      for (let i = 0; i < this.dim; i++) this._cur[i] = this.to[i];
      this.channel.write(this._cur);
      this.done = true;
      this._progress = 1;
    }
  }

  retarget(to: Float32Array, now: number, opts: TransitionOptions): void {
    // 把当前位置与速度搬成新的初始条件：速度不清零，所以不会顿一下
    this.channel.read(this._cur);
    const sp = opts.spring;
    if (sp) {
      this._k = Math.max(1e-3, sp.stiffness);
      this._c = Math.max(0, sp.damping);
      this._eps = sp.epsilon ?? this._eps;
    }
    const t = Math.max(0, (now - this._start) / 1000);
    for (let i = 0; i < this.dim; i++) {
      const s = springAt(this._x0[i] - this.to[i], this._v0[i], this._k, this._c, t);
      this._x0[i] = this._cur[i] - to[i];
      this._v0[i] = s.v;
    }
    this.to.set(to.subarray(0, this.dim));
    this._start = now;
    this.done = false;
  }
}

/**
 * 阻尼弹簧解析解（质量 = 1）。
 * @param x0 初始位移（相对目标）
 * @param v0 初始速度
 */
function springAt(x0: number, v0: number, k: number, c: number, t: number): { x: number; v: number } {
  const w0 = Math.sqrt(k);
  const zeta = c / (2 * w0);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w0 * t);
    const cos = Math.cos(wd * t);
    const sin = Math.sin(wd * t);
    const A = x0;
    const B = (v0 + zeta * w0 * x0) / wd;
    return {
      x: decay * (A * cos + B * sin),
      v: decay * ((B * wd - zeta * w0 * A) * cos + (-A * wd - zeta * w0 * B) * sin),
    };
  }
  // 临界 / 过阻尼：用临界解近似（过阻尼不会振荡，视觉差异可忽略）
  const decay = Math.exp(-w0 * t);
  const C = v0 + w0 * x0;
  return {
    x: (x0 + C * t) * decay,
    v: (v0 - w0 * C * t) * decay,
  };
}

/* ------------------------------------------------------------------ Animator */

export class Animator {
  private readonly _channels = new Map<string, Channel>();
  private readonly _tracks = new Map<string, Track>();
  private readonly _buf = new Float32Array(3);
  private readonly _finished: Track[] = [];
  private _now: () => number;
  private _budgetMs = 2.5;
  /** 最近一次 tick 用的时间戳：新建 / 打断 track 时以它为下限，避免混用时钟导致起点落在过去 */
  private _lastTick = -Infinity;
  /** 上一帧因超预算被跳过的通道数（调试 / 降级判断用） */
  private _skipped = 0;
  /**
   * 有动画启动时的回调。
   *
   * 宿主渲染是**按需驱动**的：MapLibre 空闲时不渲染，只有 triggerRepaint 才画，
   * 而 tick() 只在渲染帧里被调用——如果启动动画时不去踢一下帧循环，第一帧永远
   * 等不来，动画就「卡住不动」，直到别的什么碰巧触发了重绘。
   */
  onActive?: () => void;

  constructor(now: () => number = () => performance.now()) {
    this._now = now;
  }

  /** 单帧写入预算（毫秒）。超了就推到下一帧，保证不掉帧 */
  set budgetMs(ms: number) {
    this._budgetMs = Math.max(0, ms);
  }

  get budgetMs(): number {
    return this._budgetMs;
  }

  /** 上一帧因超预算未写入的通道数 */
  get skippedLastTick(): number {
    return this._skipped;
  }

  get activeCount(): number {
    return this._tracks.size;
  }

  get active(): boolean {
    return this._tracks.size > 0;
  }

  register(key: string, channel: Channel): void {
    this._channels.set(key, channel);
  }

  unregister(key: string): void {
    this._channels.delete(key);
    this._tracks.delete(key);
  }

  /** 按前缀批量注销通道（场景清空时回收瓦片淡入这类「用完即弃」的通道） */
  unregisterPrefix(prefix: string): void {
    for (const key of [...this._channels.keys()]) {
      if (key.startsWith(prefix)) {
        this._channels.delete(key);
        this._tracks.delete(key);
      }
    }
  }

  has(key: string): boolean {
    return this._channels.has(key);
  }

  isActive(key: string): boolean {
    return this._tracks.has(key);
  }

  /**
   * 把通道推向目标值。
   *
   * @param target 标量（dim=1）或三元数组（dim=3）
   */
  to(key: string, target: number | ArrayLike<number>, opts: TransitionOptions = {}): void {
    const channel = this._channels.get(key);
    if (!channel) throw new Error(`[s3m] 未注册的动画通道: ${key}`);

    const to = this._buf;
    if (channel.dim === 1) {
      to[0] = typeof target === 'number' ? target : Number(target[0]);
      to[1] = 0;
      to[2] = 0;
    } else {
      if (typeof target === 'number') throw new Error(`[s3m] 通道 ${key} 需要三元数组目标值`);
      for (let i = 0; i < 3; i++) to[i] = Number(target[i] ?? 0);
    }

    const isSpring = !!opts.spring;
    const duration = Math.max(0, opts.duration ?? 0);

    // 无时长、无弹簧 → 立即写，不建 track（保持旧行为）
    if (!isSpring && duration <= 0 && !opts.delay) {
      this._tracks.delete(key);
      channel.write(to);
      // 值变了就得重画，否则按需驱动的宿主看不到
      this.onActive?.();
      opts.onComplete?.();
      return;
    }

    const now = Math.max(this._now(), this._lastTick);
    let track = this._tracks.get(key);
    const wantSpring = isSpring;
    const isSpringTrack = track instanceof SpringTrack;
    const kindChanged = track != null && isSpringTrack !== wantSpring;

    if (track && kindChanged) {
      this._tracks.delete(key);
      track = undefined;
    }

    // 新建 track = 动画真正启动，必须把空闲的帧循环踢起来，否则第一帧等不来
    if (!track) this.onActive?.();
    if (!track) {
      const created = wantSpring ? new SpringTrack(key, channel) : new TweenTrack(key, channel);
      created.to.set(to.subarray(0, channel.dim));
      created.onComplete = opts.onComplete;
      created.start(now, opts);
      this._tracks.set(key, created);
      return;
    }

    track.to.set(to.subarray(0, channel.dim));
    track.onComplete = opts.onComplete;
    track.retarget(to, now, opts);
  }

  /** 停在当前值：不写终值、不回弹 */
  cancel(key: string): void {
    this._tracks.delete(key);
  }

  /** 直接跳到终值并结束 */
  finish(key: string): void {
    const track = this._tracks.get(key);
    if (!track) return;
    this._tracks.delete(key);
    track.channel.write(track.to);
    this.onActive?.();
    track.onComplete?.();
  }

  /** 取消全部通道（切换数据集 / 卸载时用） */
  clear(): void {
    this._tracks.clear();
  }

  /**
   * 推进一帧。
   *
   * @param now 当前时间（毫秒），不传则用构造时注入的时钟
   * @returns 是否还有活跃动画（宿主据此决定要不要继续重绘）
   */
  tick(now: number = this._now()): boolean {
    if (this._tracks.size === 0) {
      this._lastTick = Math.max(this._lastTick, now);
      return false;
    }

    this._lastTick = Math.max(this._lastTick, now);
    const startedAt = performance.now();
    let advanced = 0;

    for (const track of this._tracks.values()) {
      track.advance(now);
      advanced++;
      if (track.done) this._finished.push(track);
      // 预算用完：剩下的留到下一帧（推进按绝对时间算，跳一帧不丢状态）
      if (performance.now() - startedAt >= this._budgetMs) break;
    }

    if (this._finished.length > 0) {
      for (const track of this._finished) {
        if (this._tracks.get(track.key) === track) this._tracks.delete(track.key);
      }
      // 回调里可能再起新动画，所以先摘出来再执行
      const list = this._finished.splice(0, this._finished.length);
      for (const track of list) track.onComplete?.();
    }

    this._skipped = Math.max(0, this._tracks.size - advanced);
    return this._tracks.size > 0;
  }
}
