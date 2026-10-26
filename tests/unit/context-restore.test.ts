/**
 * 单元测试：WebGL 上下文丢失后 s3m 自定义图层的自动恢复
 *
 * 背景：MapLibre 在 `webglcontextlost` 时会销毁 style 并丢弃自定义图层
 * （自定义图层无法序列化进 style，所以恢复后不会自动加回，只会告警让你手动重加）。
 * 但这里我们主动监听 `webglcontextrestored`，自动把图层重新 addLayer；
 * onAdd 会识别「已挂载」并原地换新 renderer，保留已加载的场景与瓦片，不重新拉取。
 *
 * 这两个测试不依赖真实 WebGL 上下文：用桩 viewer 记录 mount / restoreContext 调用，
 * 用假 map 记录事件监听与 addLayer 调用，验证恢复链路与监听器不会重复绑定。
 */
import { describe, expect, test } from 'bun:test';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

const fakeGl = {} as WebGLRenderingContext;

/** 桩 viewer：记录 mount / restoreContext 调用，避免真实 WebGL 上下文 */
function makeStubViewer() {
  const v: any = {
    renderer: null as unknown,
    geo: null,
    mountCalls: 0,
    restoreCalls: 0,
    mount() {
      v.mountCalls++;
      v.renderer = {}; // 置真，模拟「已挂载」
    },
    restoreContext() {
      v.restoreCalls++;
    },
    unmount() {},
    recomputeAnchors() {},
  };
  return v;
}

/** 假 map：记录事件监听，并模拟 MapLibre 的 addLayer 会回调用 onAdd */
function makeFakeMap() {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const layers: Record<string, unknown> = {};
  const map: any = {
    _repaints: 0,
    getCanvas: () => ({ getContext: () => fakeGl }),
    triggerRepaint: () => {
      map._repaints++;
    },
    on(type: string, fn: (...a: any[]) => void) {
      (listeners[type] ||= []).push(fn);
    },
    off(type: string, fn: (...a: any[]) => void) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    getLayer: (id: string) => layers[id],
    addLayer: (layer: any) => {
      layers[layer.id] = layer;
      // 模拟 MapLibre：addLayer 会调用自定义图层的 onAdd，并传入新 gl
      if (typeof layer.onAdd === 'function') layer.onAdd(map, fakeGl);
    },
    fire(type: string) {
      (listeners[type] || []).forEach((fn) => fn());
    },
    listeners,
    layers,
  };
  return map;
}

describe('WebGL 上下文丢失后自动恢复', () => {
  test('1. 上下文恢复后自动重加图层，且只换 renderer、不重拉（mount 仅一次）', () => {
    const layer = new S3MLayer({ id: 's3m' });
    const viewer = makeStubViewer();
    (layer as any).viewer = viewer;

    const map = makeFakeMap();

    // 首次 onAdd（正常挂载）
    layer.onAdd(map as any, fakeGl);

    // 监听器已挂载（click / projectiontransition / webglcontextlost / webglcontextrestored）
    expect(map.listeners['click']).toHaveLength(1);
    expect(map.listeners['projectiontransition']).toHaveLength(1);
    expect(map.listeners['webglcontextlost']).toHaveLength(1);
    expect(map.listeners['webglcontextrestored']).toHaveLength(1);

    // 首次走 mount，不是 restore
    expect(viewer.mountCalls).toBe(1);
    expect(viewer.restoreCalls).toBe(0);

    // 模拟上下文丢失
    map.fire('webglcontextlost');
    expect((layer as any)._contextLost).toBe(true);

    // 模拟上下文恢复
    map.fire('webglcontextrestored');
    expect((layer as any)._contextLost).toBe(false);

    // 恢复处理器发现图层不在 style 里（MapLibre 丢弃了自定义图层），于是重新 addLayer
    expect(map.layers['s3m']).toBe(layer);
    // 重新 onAdd 走 restoreContext（renderer 已存在），不再 mount
    expect(viewer.restoreCalls).toBe(1);
    expect(viewer.mountCalls).toBe(1); // 仍然只 mount 过一次，没有重拉瓦片

    // 监听器没有重复绑定
    expect(map.listeners['click']).toHaveLength(1);
    expect(map.listeners['webglcontextrestored']).toHaveLength(1);
    // 恢复后触发了重绘
    expect(map._repaints).toBeGreaterThan(0);
  });

  test('2. onRemove 会移除所有地图事件监听（包括上下文恢复监听）', () => {
    const layer = new S3MLayer({ id: 's3m' });
    const viewer = makeStubViewer();
    (layer as any).viewer = viewer;
    const map = makeFakeMap();

    layer.onAdd(map as any, fakeGl);
    expect(map.listeners['webglcontextrestored']).toHaveLength(1);

    layer.onRemove();
    expect(map.listeners['click']).toHaveLength(0);
    expect(map.listeners['projectiontransition']).toHaveLength(0);
    expect(map.listeners['webglcontextlost']).toHaveLength(0);
    expect(map.listeners['webglcontextrestored']).toHaveLength(0);
    expect((layer as any)._listenersAttached).toBe(false);
  });

  test('3. 极端情况：若图层仍在 style 中，恢复时直接换新 renderer 而非重加', () => {
    const layer = new S3MLayer({ id: 's3m' });
    const viewer = makeStubViewer();
    (layer as any).viewer = viewer;
    const map = makeFakeMap();
    // 预先把图层放进 style，模拟「图层没被 MapLibre 丢弃」的极端路径
    (map as any).layers['s3m'] = layer;

    layer.onAdd(map as any, fakeGl);
    viewer.mountCalls = 0; // 重置，方便断言恢复阶段
    viewer.restoreCalls = 0;

    map.fire('webglcontextlost');
    map.fire('webglcontextrestored');

    // 图层仍在 → 不应再次 addLayer，而是直接 restoreContext
    expect(map.layers['s3m']).toBe(layer);
    expect(viewer.restoreCalls).toBe(1);
    expect(viewer.mountCalls).toBe(0);
  });
});

describe('S3MViewer 上下文丢失守卫', () => {
  test('renderFrame 在上下文丢失时直接返回 false，不触碰 GPU', () => {
    const viewer = new S3MViewer();
    let rendered = false;
    // 注入一个「上下文已丢失」的假 renderer
    (viewer as any).renderer = {
      getContext: () => ({ isContextLost: () => true }),
      resetState() {},
      render() {
        rendered = true;
      },
      setViewport() {},
    };
    (viewer as any).scene = {} as any;
    (viewer as any).camera = {} as any;
    (viewer as any).sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 } as any;
    (viewer as any).canvas = {} as any;

    const needs = viewer.renderFrame({
      mvp: new Array(16).fill(0),
      cameraEnu: [0, 0, 0],
      fovRad: 1,
      canvasHeight: 100,
    });

    expect(needs).toBe(false);
    expect(rendered).toBe(false);
  });
});
