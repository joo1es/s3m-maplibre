/**
 * 加载期时间切片的单测（smart-city 卡顿专项 · A）。
 *
 * 要钉住的是「加载时页面还能不能响应」，所以断言的不是耗时，而是**事件循环有没有让出**：
 * 一个 setTimeout(0) 能在加载期间跑起来，就说明输入事件也有机会跑。
 *
 * 三个边界：
 * 1. 预算没超 → 不让出（小块瓦片零额外开销，这也是默认打开还安全的原因）；
 * 2. 预算超了 → 让出一次，且让出期间宏任务确实执行了；
 * 3. 预算 0 → 关闭切片，行为回到「一口气做完」。
 */
import { describe, expect, test } from 'bun:test';
import { LoadSlicer, yieldToBrowser } from '../../packages/s3m-three/src/tileset/slicing';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 让出是否真的发生了，用「另一个宏任务是否先跑」来判定。
 *
 * 不用 setTimeout(0) 当探针：MessageChannel 与 timer 是不同的任务队列阶段，
 * MessageChannel 让出之后 timer 未必立刻跑（实测 false），拿它判会误报。
 * 而同为 MessageChannel 的另一条消息一定先于我们的 resolve 执行 —— 这才是
 * 「控制权交回过事件循环」的确切证据。
 */
function probeMacrotaskOrder(): { order: string[]; probe: Promise<void> } {
  const order: string[] = ['start'];
  const ch = new MessageChannel();
  const probe = new Promise<void>((resolve) => {
    ch.port1.onmessage = () => {
      order.push('macrotask');
      ch.port1.close();
      resolve();
    };
  });
  ch.port2.postMessage(0);
  return { order, probe };
}

describe('LoadSlicer', () => {
  test('预算没超：不让出，也不计数', async () => {
    const s = new LoadSlicer(1000);
    s.begin();
    await s.breathe();
    await s.breathe();
    expect(s.yields).toBe(0);
  });

  test('预算超了：让出一次，期间排队的宏任务先跑', async () => {
    const s = new LoadSlicer(1);
    s.begin();
    await sleep(5);
    const { order } = probeMacrotaskOrder();
    await s.breathe();
    expect(order).toEqual(['start', 'macrotask']);
    expect(s.yields).toBe(1);
  });

  test('让出之后重新计时：紧接着的第二次不会连续让出', async () => {
    const s = new LoadSlicer(5);
    s.begin();
    await sleep(8);
    await s.breathe();
    expect(s.yields).toBe(1);
    await s.breathe();
    expect(s.yields).toBe(1);
  });

  test('预算 0 = 关闭切片：超时也不让出', async () => {
    const s = new LoadSlicer(0);
    expect(s.budgetMs).toBe(0);
    s.begin();
    await sleep(5);
    await s.breathe();
    expect(s.yields).toBe(0);
  });

  test('非法预算按关闭处理，不抛', async () => {
    for (const v of [Number.NaN, -1, Infinity]) {
      const s = new LoadSlicer(v as number);
      expect(s.budgetMs).toBe(0);
      await s.breathe();
      expect(s.yields).toBe(0);
    }
  });

  test('setBudget 运行时改预算（相机运动时压小）', async () => {
    const s = new LoadSlicer(1000);
    s.begin();
    await sleep(3);
    await s.breathe();
    expect(s.yields).toBe(0);
    // 镜头开始动：预算降到 1ms，下一次就让出
    s.setBudget(1);
    expect(s.budgetMs).toBe(1);
    await s.breathe();
    expect(s.yields).toBe(1);
  });

  test('yieldToBrowser 一定把控制权交回事件循环', async () => {
    const { order } = probeMacrotaskOrder();
    await yieldToBrowser();
    expect(order).toEqual(['start', 'macrotask']);
  });
});
