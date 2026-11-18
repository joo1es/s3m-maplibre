/**
 * 交互期「暂缓提交」：手势进行中不把新瓦片塞进场景，抬手后每帧放几个。
 *
 * 为什么需要：瓦片的建几何已经做过时间切片，但「进场景」这一步（纹理上传、
 * program 首次编译、棱线生成）全是同步且不可切分的。拖拽时这些工作落进任何一帧
 * 都是 100~600ms 的停顿 —— 实测加载期拖拽有一次 638ms 的卡顿就发生在这里。
 *
 * 三条约束：
 *   ① 没有 gate（默认）时行为逐字不变，`_onTile` 立刻调用；
 *   ② gate 打开时只排队、不提交，且不能再被调度器当成「未加载」重复入队；
 *   ③ 放闸按帧限流，一次只提交 max 个；已被淘汰的瓦片不能复活。
 */
import { describe, expect, test } from 'bun:test';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

function mk() {
  const ts = new S3MTileset({
    configUrl: 'https://example.com/ds/config',
    maxTiles: 100,
    maxConcurrent: 1,
    buildTile: (async () => ({ group: null, stats: {} })) as never,
    onError: () => {},
  }) as any;
  const committed: string[] = [];
  ts._onTile = (node: { url: string }) => { committed.push(node.url); };
  return { ts, committed };
}

/** 直接塞一条「已建好」的 node，模拟 _load 成功路径的后半段 */
function push(ts: any, url: string) {
  const node = { url, tile: {}, group: {}, childUrls: [] as string[] };
  ts.nodes.set(url, node);
  ts._commitOrHold(node);
  return node;
}

describe('交互期暂缓提交', () => {
  test('默认路径：没有 gate 时立刻提交（不变式 ①）', () => {
    const { ts, committed } = mk();
    push(ts, 'a');
    expect(committed).toEqual(['a']);
    expect(ts.heldCommits).toBe(0);
  });

  test('gate 打开时只排队，不提交', () => {
    const { ts, committed } = mk();
    ts.setCommitGate(() => true);
    push(ts, 'a');
    push(ts, 'b');
    expect(committed).toEqual([]);
    expect(ts.heldCommits).toBe(2);
  });

  test('flushHeldCommits 按上限放闸，剩下的继续排队', () => {
    const { ts, committed } = mk();
    ts.setCommitGate(() => true);
    push(ts, 'a'); push(ts, 'b'); push(ts, 'c');
    expect(ts.flushHeldCommits(2)).toBe(2);
    expect(committed).toEqual(['a', 'b']);
    expect(ts.heldCommits).toBe(1);
    expect(ts.flushHeldCommits(2)).toBe(1);
    expect(committed).toEqual(['a', 'b', 'c']);
  });

  test('gate 关掉后恢复「到场即提交」，队列里的也能放出来', () => {
    const { ts, committed } = mk();
    let holding = true;
    ts.setCommitGate(() => holding);
    push(ts, 'a');
    holding = false;
    push(ts, 'b');
    expect(committed).toEqual(['b']);
    ts.flushHeldCommits(Infinity);
    expect(committed).toEqual(['b', 'a']);
  });

  test('已被淘汰（nodes 里换了一条）的瓦片不复活', () => {
    const { ts, committed } = mk();
    ts.setCommitGate(() => true);
    push(ts, 'a');
    ts.nodes.delete('a'); // 预算把它淘汰了
    ts.flushHeldCommits(Infinity);
    expect(committed).toEqual([]);
  });

  test('排队期间节点已在 nodes 里：调度器不会把它当成未加载', () => {
    const { ts } = mk();
    ts.setCommitGate(() => true);
    push(ts, 'a');
    expect(ts.nodes.has('a')).toBe(true);
    expect(ts.pending.has('a')).toBe(false);
  });

  test('排队中的节点标记 committed=false，放闸后才变 true', () => {
    // 这条守的是「先消失再出现」：LOD 调度看到子节点时，如果它只是 built
    // 而没 committed，就不能让父瓦片隐藏 —— 否则父片没了、子片还没进场景。
    const { ts } = mk();
    ts.setCommitGate(() => true);
    const node = push(ts, 'a');
    expect(node.committed).toBe(false);
    ts.flushHeldCommits(1);
    expect(node.committed).toBe(true);
  });

  test('不排队时立刻就是 committed=true（默认路径不变）', () => {
    const { ts } = mk();
    const node = push(ts, 'a');
    expect(node.committed).toBe(true);
  });
});
