/**
 * 单元测试：HostRenderer 宿主无关底座抽取后的行为锁定
 *
 * 背景：S3MLayer 原来自持 S3MViewer 与投影/近平面状态，现在这些全部上移到
 * s3m-three 的 HostRenderer 基类（宿主无关），S3MLayer 只剩 MapLibre 专属胶水
 * （CustomLayerInterface 形态、矩阵抽取、事件绑定、上下文恢复重加图层）。
 *
 * 锁定的不变式（对应 AGENTS.md 不变式①）：
 *   1. 构造默认值逐项不变（id / projection / projectionT / nearPlaneScale / pickable）；
 *   2. 宿主能力钩子接线正确：viewer 内部的 onRequestRepaint → map.triggerRepaint，
 *      getBearing → map.getBearing；
 *   3. mountViewer / unmountViewer 生命周期路径与抽取前一致；
 *   4. driveFrame 在内核要求续帧时触发宿主重绘；
 *   5. S3MLayer 仍具备 CustomLayerInterface 的鸭子形态（type / renderingMode /
 *      onAdd / render / onRemove），MapLibre addLayer 不挑类型。
 */
import { describe, expect, test } from 'bun:test';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';
import { HostRenderer } from '../../packages/s3m-three/src/render/HostRenderer';

const fakeGl = {} as WebGLRenderingContext;

/** 桩 viewer：记录 mount / unmount / renderFrame 调用，避免真实 WebGL 上下文 */
function makeStubViewer(renderFrameResult = false) {
  const v: any = {
    renderer: null as unknown,
    geo: null,
    animator: {
      has: () => false,
      cancel: () => {},
      register: () => {},
      to: () => {},
    },
    mountCalls: 0,
    unmountCalls: 0,
    renderFrameCalls: 0,
    lastFrame: null as unknown,
    mount() {
      v.mountCalls++;
      v.renderer = {}; // 置真，模拟「已挂载」
    },
    restoreContext() {},
    unmount() {
      v.unmountCalls++;
    },
    renderFrame(frame: unknown) {
      v.renderFrameCalls++;
      v.lastFrame = frame;
      return renderFrameResult;
    },
    recomputeAnchors() {},
    sceneAnchor: null,
  };
  return v;
}

/** 假 map：记录事件监听与 triggerRepaint 次数 */
function makeFakeMap(bearing?: number) {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const map: any = {
    _repaints: 0,
    getCanvas: () => ({ getContext: () => fakeGl, width: 800, height: 600 }),
    triggerRepaint: () => {
      map._repaints++;
    },
    on(type: string, fn: (...a: any[]) => void) {
      (listeners[type] ||= []).push(fn);
    },
    off(type: string, fn: (...a: any[]) => void) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    ...(bearing === undefined ? {} : { getBearing: () => bearing }),
    listeners,
  };
  return map;
}

describe('HostRenderer 抽取后的行为锁定', () => {
  test('1. 构造默认值逐项不变', () => {
    const layer = new S3MLayer({});
    expect(layer.id).toBe('s3m');
    expect(layer.projection).toBe('perspective');
    expect(layer.projectionT).toBe(0);
    expect(layer.nearPlaneScale).toBe(1);
    expect(layer.pickable).toBe(true);
    // CustomLayerInterface 鸭子形态
    expect(layer.type).toBe('custom');
    expect(layer.renderingMode).toBe('3d');
    expect(typeof layer.onAdd).toBe('function');
    expect(typeof layer.render).toBe('function');
    expect(typeof layer.onRemove).toBe('function');
  });

  test('2. S3MLayer 是 HostRenderer 的子类（继承契约）', () => {
    const layer = new S3MLayer({ id: 'x', nearPlaneScale: 0.1 });
    expect(layer instanceof HostRenderer).toBe(true);
    expect(layer.id).toBe('x');
    expect(layer.nearPlaneScale).toBe(0.1);
  });

  test('3. nearPlaneScale 合法化语义不变（非法值一律 = 1）', () => {
    expect(HostRenderer.normalizeNearPlaneScale(undefined)).toBe(1);
    expect(HostRenderer.normalizeNearPlaneScale(Number.NaN)).toBe(1);
    expect(HostRenderer.normalizeNearPlaneScale(0)).toBe(1);
    expect(HostRenderer.normalizeNearPlaneScale(1)).toBe(1);
    expect(HostRenderer.normalizeNearPlaneScale(2)).toBe(1);
    expect(HostRenderer.normalizeNearPlaneScale(0.5)).toBe(0.5);
    expect(new S3MLayer({ nearPlaneScale: 2 }).nearPlaneScale).toBe(1);
  });

  test('4. 钩子接线：viewer 内部 requestRepaint → 子类钩子，getBearing → 子类钩子', () => {
    // 接线发生在 S3MViewer 构造期（HostRenderer 构造器注入），不需要 onAdd。
    // 用最小具体子类验证基类契约，再用 S3MLayer 验证 maplibre 实现。
    class TestHost extends HostRenderer {
      repaints = 0;
      protected requestRepaint(): void {
        this.repaints++;
      }
      protected override getBearing(): number {
        return 42;
      }
    }
    const host = new TestHost({});
    (host.viewer as any)._onRequestRepaint();
    expect(host.repaints).toBe(1);
    expect((host.viewer as any)._getBearing?.()).toBe(42);

    // S3MLayer 的 requestRepaint 实现 → map.triggerRepaint；未挂 map 时安全空操作
    const layer = new S3MLayer({});
    (layer as any).requestRepaint(); // 不抛错、不重绘
    const map = makeFakeMap(7);
    (layer as any).map = map; // 走 setter：同步 geo 适配器（不需要 GL）
    (layer as any).requestRepaint();
    expect(map._repaints).toBe(1);
    expect((layer.viewer as any)._getBearing?.()).toBe(7);
  });

  test('5. mountViewer / unmountViewer 生命周期路径与抽取前一致', () => {
    const layer = new S3MLayer({});
    const viewer = makeStubViewer();
    (layer as any).viewer = viewer;
    const map = makeFakeMap();

    layer.onAdd(map, fakeGl);
    expect(viewer.mountCalls).toBe(1); // 首次走 mount

    layer.onRemove();
    expect(viewer.unmountCalls).toBe(1); // 卸载走 unmount

    // 上下文恢复：再次 onAdd 时 renderer 已存在 → 原地 restore，不重新 mount
    const restoreViewer = makeStubViewer();
    (layer as any).viewer = restoreViewer;
    layer.onAdd(map, fakeGl);
    expect(restoreViewer.mountCalls).toBe(1);
    layer.onAdd(map, fakeGl); // renderer 已存在（stub mount 里置真）→ restore 路径
    expect(restoreViewer.mountCalls).toBe(1);
  });

  test('6. driveFrame：内核要求续帧时触发宿主重绘', () => {
    const layer = new S3MLayer({});
    const map = makeFakeMap();
    (layer as any).map = map;
    const viewer = makeStubViewer(true);
    (layer as any).viewer = viewer;

    const frame = { mvp: new Float64Array(16), cameraEnu: [0, 0, 0] as [number, number, number], fovRad: 1, canvasHeight: 600 };
    const needs = (layer as any).driveFrame(frame);
    expect(needs).toBe(true);
    expect(viewer.renderFrameCalls).toBe(1);
    expect(map._repaints).toBe(1); // renderFrame 返回 true → triggerRepaint

    const viewer2 = makeStubViewer(false);
    (layer as any).viewer = viewer2;
    const needs2 = (layer as any).driveFrame(frame);
    expect(needs2).toBe(false);
    expect(map._repaints).toBe(1); // 不需要续帧则不重绘
  });

  test('7. setProjection 走基类：切换后触发宿主重绘（行为不变）', () => {
    const layer = new S3MLayer({});
    const map = makeFakeMap();
    (layer as any).map = map;
    const viewer = makeStubViewer();
    (layer as any).viewer = viewer;

    const before = map._repaints;
    layer.setProjection('orthographic');
    expect(layer.projection).toBe('orthographic');
    expect(layer.projectionT).toBe(1);
    expect(map._repaints).toBe(before + 1);

    layer.setProjection('perspective');
    expect(layer.projection).toBe('perspective');
    expect(layer.projectionT).toBe(0);
  });

  test('8. 回调默认值与透传不变', () => {
    let statsCalls = 0;
    const layer = new S3MLayer({ onStats: () => statsCalls++ });
    expect(typeof layer.onStats).toBe('function');
    expect(typeof layer.onReady).toBe('function');
    expect(typeof layer.onPick).toBe('function');
    expect(typeof layer.onError).toBe('function');
    // options 里的 onStats 被透传给基类公开回调
    layer.onStats({} as any);
    expect(statsCalls).toBe(1);
  });
});
