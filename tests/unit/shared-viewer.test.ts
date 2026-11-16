import { describe, expect, test } from 'bun:test';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';

/**
 * 共享内核（issue #51）。
 *
 * 背景：`S3MLayer` 每实例独占一个 `S3MViewer`，而 `S3MViewer` 在 `mount()` 里
 * 会 `new THREE.WebGLRenderer({ context: gl })`。多个图层共用同一个宿主 GL 上下文时，
 * 就等于在一个上下文上叠了 N 个 renderer：
 *
 *   - three 的 programCache 挂在 renderer 上，同一套 PBR 材质要编译 N 次；
 *   - N 个 renderer 交替 render 会互相打脸 GL 状态缓存，**每帧**重复重设；
 *   - 每帧 N 次 renderFrame、N 套光照。
 *
 * 而 `S3MViewer` 本来就支持多数据集（`addDataset`），所以正确的用法是
 * **一个内核挂多个数据集**，而不是一个数据集一个新内核。
 */
const fakeGl = {} as WebGLRenderingContext;

/** 桩 viewer：记录 mount / restoreContext / unmount 调用 */
function makeStubViewer() {
  const v: any = {
    renderer: null as unknown,
    geo: null,
    mountCalls: 0,
    restoreCalls: 0,
    unmountCalls: 0,
    mount() {
      v.mountCalls++;
      v.renderer = {};
    },
    restoreContext() {
      v.restoreCalls++;
    },
    unmount() {
      v.unmountCalls++;
      v.renderer = null;
    },
    recomputeAnchors() {},
  };
  return v;
}

function makeFakeMap() {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const layers: Record<string, unknown> = {};
  const map: any = {
    getCanvas: () => ({ getContext: () => fakeGl }),
    triggerRepaint: () => {},
    on(type: string, fn: (...a: any[]) => void) {
      (listeners[type] ||= []).push(fn);
    },
    off(type: string, fn: (...a: any[]) => void) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    getLayer: (id: string) => layers[id],
    addLayer: (layer: any) => {
      layers[layer.id] = layer;
      if (typeof layer.onAdd === 'function') layer.onAdd(map, fakeGl);
    },
    listeners,
    layers,
  };
  return map;
}

describe('共享内核：viewer 注入', () => {
  test('1. 默认行为不变：不传 viewer 时每个图层各有自己的内核', () => {
    const a = new S3MLayer({ id: 'a' });
    const b = new S3MLayer({ id: 'b' });

    expect(a.viewer).toBeDefined();
    expect(b.viewer).toBeDefined();
    expect(a.viewer).not.toBe(b.viewer);
  });

  test('2. 传入同一个 viewer 时，两个图层用的是同一个内核实例', () => {
    const shared = makeStubViewer();

    const a = new S3MLayer({ id: 'a', viewer: shared });
    const b = new S3MLayer({ id: 'b', viewer: shared });

    expect(a.viewer).toBe(shared);
    expect(b.viewer).toBe(shared);
  });

  test('3. 共享内核时只 mount 一次：第二个图层既不重复 mount，也不误走上下文恢复', () => {
    const shared = makeStubViewer();
    const map = makeFakeMap();

    const a = new S3MLayer({ id: 'a', viewer: shared });
    const b = new S3MLayer({ id: 'b', viewer: shared });

    a.onAdd(map, fakeGl);
    b.onAdd(map, fakeGl);

    expect(shared.mountCalls).toBe(1);
    expect(shared.restoreCalls).toBe(0);
  });

  test('4. 共享内核时，非创建者卸载不会卸掉内核（其他图层还在用）', () => {
    const shared = makeStubViewer();
    const map = makeFakeMap();

    const a = new S3MLayer({ id: 'a', viewer: shared });
    const b = new S3MLayer({ id: 'b', viewer: shared });
    a.onAdd(map, fakeGl);
    b.onAdd(map, fakeGl);

    b.onRemove();

    expect(shared.unmountCalls).toBe(0);
    expect(shared.renderer).toBeTruthy();
  });

  test('5. 创建者卸载时才真正卸掉内核', () => {
    const shared = makeStubViewer();
    const map = makeFakeMap();

    const a = new S3MLayer({ id: 'a', viewer: shared });
    a.onAdd(map, fakeGl);

    a.onRemove();

    expect(shared.unmountCalls).toBe(1);
  });

  test('6. 同一图层重复 onAdd（上下文恢复）仍然走 restoreContext，不受共享逻辑影响', () => {
    const shared = makeStubViewer();
    const map = makeFakeMap();

    const a = new S3MLayer({ id: 'a', viewer: shared });
    a.onAdd(map, fakeGl);
    a.onAdd(map, fakeGl);

    expect(shared.mountCalls).toBe(1);
    expect(shared.restoreCalls).toBe(1);
  });

  test('7. 卸载顺序无关：先卸创建者，内核也不会被拆（还有人在用）', () => {
    const shared = makeStubViewer();
    const map = makeFakeMap();

    const a = new S3MLayer({ id: 'a', viewer: shared });
    const b = new S3MLayer({ id: 'b', viewer: shared });
    a.onAdd(map, fakeGl);
    b.onAdd(map, fakeGl);

    // 宿主先摘创建者 —— 只认 owner 的实现会在这一步把 b 的画面一起拆掉
    a.onRemove();
    expect(shared.unmountCalls).toBe(0);

    b.onRemove();
    expect(shared.unmountCalls).toBe(1);
  });

  test('8. 同一个图层重复 onRemove 不会把引用数减穿', () => {
    const shared = makeStubViewer();
    const map = makeFakeMap();

    const a = new S3MLayer({ id: 'a', viewer: shared });
    const b = new S3MLayer({ id: 'b', viewer: shared });
    a.onAdd(map, fakeGl);
    b.onAdd(map, fakeGl);

    b.onRemove();
    b.onRemove();

    expect(shared.unmountCalls).toBe(0);
    a.onRemove();
    expect(shared.unmountCalls).toBe(1);
  });
});
