/**
 * 瓦片调度续帧（keep-alive）—— Mapbox 按需渲染下「只加载到根瓦片」的回归测试。
 *
 * 现象（真实数据 CBD，根瓦片在服务端就是 404）：
 *   - MapLibre：自己会出帧（加载 / 惯性 / idle），调度被顺带推进到 3 个节点；
 *   - Mapbox：按需渲染，没人 `triggerRepaint()` 就一帧都不出。而 `renderFrame()` 的
 *     `needsNextFrame` 里与瓦片有关的条件只有 `stats.loading > 0`，**退避重试中的瓦片不在其中**：
 *     根瓦片 404 → `loading` 归零 → 返回 false → 再没有下一帧 → `tileset.update()` 不再跑 →
 *     子瓦片永远不入队，画面永远停在根级粗模（看起来「楼变大 / 位置怪 / 拉近才看得见」）。
 *
 * 这里钉三件事：
 *   1. `S3MTileset.pendingWork` 把「排队 + 在途 + 退避待重试」都算成还有活；
 *   2. 真实的 404 失败路径上出现「loading === 0 但 pendingWork > 0」——正是断链那一步；
 *   3. 这种状态下 `S3MViewer.renderFrame()` 必须返回 true（宿主据此再请求一帧）。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

const asAny = (v: unknown) => v as any;

/* ---------------------------------------------------------------- 1. pendingWork 语义 */

describe('S3MTileset.pendingWork：三种「还有活」都要算', () => {
  test('新建的 tileset 没有活', () => {
    const ts = new S3MTileset({ configUrl: 'http://localhost/config.json' });
    expect(ts.pendingWork).toBe(0);
  });

  test('排队待请求 + 在途 + 退避待重试，逐项计入', () => {
    const ts = asAny(new S3MTileset({ configUrl: 'http://localhost/config.json' }));

    ts._queue.push('a');
    expect(ts.pendingWork).toBe(1);

    ts.pending.add('b');
    expect(ts.pendingWork).toBe(2);

    ts._retryAt.set('c', performance.now() + 5000);
    expect(ts.pendingWork).toBe(3);
  });

  test('退避时间过了也还算活：它只是「等下一帧再来一轮」，不是放弃', () => {
    // 退避到期后 _enqueue 会重新放行，但到期那一刻仍然没有新帧 —— 必须继续计数，
    // 否则还是断在同一处。
    const ts = asAny(new S3MTileset({ configUrl: 'http://localhost/config.json' }));
    ts._retryAt.set('c', performance.now() - 1);
    expect(ts.pendingWork).toBe(1);
  });

  test('已经彻底失败、已经加载完成的 url 不再计入', () => {
    const ts = asAny(new S3MTileset({ configUrl: 'http://localhost/config.json' }));
    ts.failed.add('bad');
    ts._retryAt.set('bad', performance.now() + 1000);
    ts.nodes.set('ok', { url: 'ok' });
    ts._retryAt.set('ok', performance.now() + 1000);

    expect(ts.pendingWork).toBe(0);
  });
});

/* ---------------------------------------------------------------- 2. 真实失败路径 */

/**
 * 失败分类是这条链路的另一半，两者必须分开钉：
 *   - 404 / 410 → `MissingTileError.permanent = true`，**不退还**，直接判 failed；
 *   - 其余状态码（5xx / 超时 / 网关抖动）→ 普通 Error，进 `_retryAt` 退避，等 `update()` 下一轮。
 * 只有后者会制造「loading 归零但活没干完」的窗口。
 */
async function initWithTileStatus(status: number, body = ''): Promise<S3MTileset> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('.scp') || url.includes('.scp?')) {
      return new Response(JSON.stringify({ rootTiles: [{ url: 'root.s3mb' }] }), { status: 200 });
    }
    return new Response(body || 'oops', { status });
  }) as unknown as typeof fetch;
  try {
    const ts = new S3MTileset({ configUrl: 'http://localhost/data/a.scp' });
    await ts.init();
    await new Promise((r) => setTimeout(r, 20));
    return ts;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('失败分类：可重试的必须续帧，永久失败的不许拖着', () => {
  test('500 → loading 归零，但 pendingWork > 0（退避中，等下一帧重新入队）', async () => {
    const ts = await initWithTileStatus(500);
    expect(ts.stats.loading).toBe(0);
    expect(ts.pendingWork).toBeGreaterThan(0);
    // 退避期间不写 failed：宿主不能靠 failed 判断「已经结束了」
    expect(ts.failed.size).toBe(0);
  });

  test('404（permanent）→ 直接计 failed，pendingWork 归零', async () => {
    const ts = await initWithTileStatus(404, 'not found');
    expect(ts.stats.loading).toBe(0);
    expect(ts.failed.size).toBe(1);
    // 永久失败的瓦片不该继续驱动宿主，否则一张死图能让地图永远重绘
    expect(ts.pendingWork).toBe(0);
  });
});

/* ---------------------------------------------------------------- 3. 宿主帧链 */

function makeViewer(): S3MViewer {
  const v = new S3MViewer({
    canvas: null as never,
    container: null as never,
  } as ConstructorParameters<typeof S3MViewer>[0]);
  v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };

  (v as unknown as { canvas: unknown }).canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100 };
  (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();
  (v as unknown as { renderer: unknown }).renderer = {
    getContext: () => ({ isContextLost: () => false }),
    setViewport: () => {},
    resetState: () => {},
    render: () => {},
    dispose: () => {},
  };
  return v;
}

function frame(v: S3MViewer): boolean {
  return v.renderFrame({
    mvp: new THREE.Matrix4().identity().toArray(),
    cameraEnu: [0, 0, 1000],
    fovRad: 0.6,
    canvasHeight: 100,
  });
}

/** 往 datasets 里塞一个只有 tileset 的假数据集 */
function withTileset(v: S3MViewer, tileset: { pendingWork: number }): void {
  (v.datasets as Map<string, unknown>).set('d', {
    id: 'd',
    name: 'd',
    options: { id: 'd', name: 'd', configUrl: 'x' },
    root: new THREE.Group(),
    tileset: { dispose: () => {}, ...tileset },
    anchor: null,
    baseAlignOffset: 0,
    userOffset: 0,
    heightOffset: 0,
    offset: [0, 0, 0],
  });
}

describe('renderFrame：退避中的瓦片必须续帧', () => {
  test('loading === 0 但 tileset.pendingWork > 0 → 返回 true', () => {
    const v = makeViewer();
    try {
      withTileset(v, { pendingWork: 1 });
      expect(v.stats.loading).toBe(0);
      expect(frame(v)).toBe(true);
    } finally {
      v.dispose();
    }
  });

  test('真的没活时仍然返回 false：不能把宿主拖成永动机', () => {
    const v = makeViewer();
    try {
      withTileset(v, { pendingWork: 0 });
      expect(frame(v)).toBe(false);
    } finally {
      v.dispose();
    }
  });
});
