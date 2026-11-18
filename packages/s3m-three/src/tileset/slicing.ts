/**
 * 加载期的主线程让出原语（时间切片）。
 *
 * 为什么需要：一块瓦片「落地」是一条不可分割的同步链 —— 解块图集 → 建几何 → 建纹理 →
 * 首次编译着色器。实测 7 个数据集的 smart-city 在 30 秒里出现 31 个长任务、累计 9.4 秒，
 * 最长一次 1824ms 完全冻结；期间鼠标事件排不上队，页面等于卡死。这不是 GPU 慢
 * （4070 Ti 上一样），是 JS 单线程被占满。
 *
 * 解决思路不是「让这些工作变快」，而是**允许它们被打断**：每花掉一个帧预算就让出一次，
 * 让输入事件、rAF、渲染先跑，下一轮再继续。总时长不变（甚至略长），但页面全程可交互。
 *
 * 为什么不用 `setTimeout(fn, 0)`：嵌套超过 5 层后浏览器强制 4ms 最小间隔，
 * 一次加载几百块瓦片会累积出几秒的额外空转。`MessageChannel` 是宏任务但不吃这个钳制，
 * 落到下一轮事件循环的同时几乎零成本；`scheduler.yield()` 更好（Chrome 129+），
 * 它会把让出排在其它同级任务之前，避免饿死加载。
 */

/** 让出事件循环一次（宏任务），期间浏览器可以处理输入与渲染 */
export function yieldToBrowser(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched && typeof sched.yield === 'function') {
    try {
      return sched.yield();
    } catch {
      /* 落回下面的实现 */
    }
  }
  if (typeof MessageChannel !== 'undefined') {
    return new Promise<void>((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * 帧预算切片器。
 *
 * 用法是在每个**可能很长**的同步阶段之后调 `breathe()`：本片花掉的累计时间超过预算就让出，
 * 否则直接返回（同步返回，不产生微任务）。所以小块瓦片完全不受影响 —— 预算没超就不会
 * 有任何额外开销，这也是默认打开它还算安全的原因。
 */
export class LoadSlicer {
  /** 每个切片最多占用主线程多少毫秒，超过就让出 */
  private _budgetMs: number;
  private _sliceStart = 0;
  private _yields = 0;

  constructor(budgetMs = 8) {
    // 0 / 负数 / NaN 一律按「不让出」处理（关掉切片），便于单测与排查
    this._budgetMs = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
  }

  get budgetMs(): number {
    return this._budgetMs;
  }

  /**
   * 运行时改预算。相机在动的时候调小（比如 2~3ms）：那会儿每帧的 16ms 里
   * 要留出时间给动画和输入，加载只配拿一小片；停下来再调大。
   *
   * 注意这是「调小」而不是「暂停」—— 暂停会在松手/停住的那一刻把所有积压的
   * 请求一次性放闸，看起来就是「一停就狂加载」。
   */
  setBudget(budgetMs: number): void {
    this._budgetMs = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
  }

  /** 本片已经花掉的毫秒数（诊断用） */
  get sliceCostMs(): number {
    return this._sliceStart === 0 ? 0 : now() - this._sliceStart;
  }

  /** 已经让出过多少次（诊断用） */
  get yields(): number {
    return this._yields;
  }

  /** 开始一个新切片。每块瓦片开始时调一次。 */
  begin(): void {
    this._sliceStart = now();
  }

  /**
   * 超预算就让出并开启新切片；没超预算直接返回。
   *
   * 返回的 Promise 在超预算时是「让出后」才 resolve，调用方 `await` 即可。
   */
  async breathe(): Promise<void> {
    if (this.budgetMs <= 0) return;
    if (this._sliceStart === 0) this._sliceStart = now();
    if (now() - this._sliceStart < this.budgetMs) return;
    await yieldToBrowser();
    this._sliceStart = now();
    this._yields++;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
