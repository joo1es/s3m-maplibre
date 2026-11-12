import { describe, expect, it } from 'bun:test';
import { Matrix4 } from 'three';
import { HostRenderer } from '../../packages/s3m-three/src/render/HostRenderer';
import { AMapS3MLayer } from '../../examples/amap/AMapS3MLayer';

describe('AMapS3MLayer 高德地图适配层测试 (Phase 2)', () => {
  function makeStubViewer() {
    const v: any = {
      renderer: {
        autoClear: true,
        resetState: () => {},
        setSize: () => {},
        getContext: () => ({ isContextLost: () => false }),
      },
      geo: null,
      mountCalls: 0,
      restoreCalls: 0,
      unmountCalls: 0,
      disposeCalls: 0,
      pickCalls: [] as Array<[number, number]>,
      selected: undefined as any,
      mount() {
        v.mountCalls++;
      },
      restoreContext() {
        v.restoreCalls++;
      },
      unmount() {
        v.unmountCalls++;
      },
      dispose() {
        v.disposeCalls++;
      },
      recomputeAnchors() {},
      pick(x: number, y: number) {
        v.pickCalls.push([x, y]);
        return { objectId: 42, batchId: 7 };
      },
      select(res: any) {
        v.selected = res;
      },
      sceneAnchor: {
        x: 0,
        y: 0,
        z: 0,
        meterInMercatorEast: 1.3,
        meterInMercatorNorth: 1.3,
        meterInMercatorUp: 1.3,
        meterInMercator: 1.3,
      },
      renderFrame: () => false,
    };
    return v;
  }

  function makeFakeAMap() {
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const canvasListeners: Record<string, Array<(e: any) => void>> = {};
    let repaintCount = 0;
    const container = {
      clientWidth: 1024,
      clientHeight: 768,
      appendChild: (_child: any) => {},
      removeChild: (_child: any) => {},
      contains: (_child: any) => true,
    } as any;

    const customCoords = {
      _center: [116.4625, 39.915287] as [number, number],
      setCenter(c: [number, number]) {
        customCoords._center = [...c];
      },
      getCenter: () => customCoords._center,
      lngLatToCoord: ([lng, lat]: [number, number]): [number, number, number] => [
        (lng - 116.4625) * 111000,
        (lat - 39.915287) * 111000,
        0,
      ],
      coordToLngLat: ([x, y]: [number, number]): [number, number] => [
        116.4625 + x / 111000,
        39.915287 + y / 111000,
      ],
      getCameraParams: () => ({
        near: 1,
        far: 50000,
        fov: 60,
        up: [0, 1, 0] as [number, number, number],
        lookAt: [0, 0, 0] as [number, number, number],
        position: [0, -1000, 1000] as [number, number, number],
      }),
    };

    const map = {
      customCoords,
      getContainer: () => container,
      getCenter: () => [116.4625, 39.915287],
      getZoom: () => 17.5,
      getPitch: () => 50,
      getRotation: () => -30,
      render: () => {
        repaintCount++;
      },
      triggerRepaint: () => {
        repaintCount++;
      },
      on: (type: string, fn: any) => {
        (listeners[type] ||= []).push(fn);
      },
      off: (type: string, fn: any) => {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      listeners,
      get repaints() {
        return repaintCount;
      },
    };

    const fakeGl = { isContextLost: () => false };
    const canvas = {
      style: {} as Record<string, string>,
      width: 1024,
      height: 768,
      parentElement: container,
      getContext: () => fakeGl,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 1024, height: 768 }),
      addEventListener: (type: string, fn: any) => {
        (canvasListeners[type] ||= []).push(fn);
      },
      removeEventListener: (type: string, fn: any) => {
        if (canvasListeners[type]) canvasListeners[type] = canvasListeners[type].filter((f) => f !== fn);
      },
      canvasListeners,
    } as any;

    return { map, container, customCoords, canvas, fakeGl };
  }

  it('继承 HostRenderer，挂接 S3MHost 与独立覆盖画布', () => {
    const { map, canvas } = makeFakeAMap();
    const layer = new AMapS3MLayer({ id: 'amap-s3m', canvas });
    expect(layer instanceof HostRenderer).toBe(true);
    (layer as any).viewer = makeStubViewer();

    expect(layer.id).toBe('amap-s3m');
    expect(layer.projection).toBe('perspective');
    expect(layer.getCanvas()?.style.position).toBe('absolute');
    expect(layer.getCanvas()?.style.pointerEvents).toBe('none');

    layer.setMap(map);
    expect(layer.map).toBe(map);
    expect(layer.host).toBe(map);
    expect(layer.viewer.geo).not.toBeNull();
    // 高德 getRotation() 与顺时针 bearing 符号相反，同步给 LightRig
    expect((layer as any).getBearing()).toBe(30);
  });

  it('惰性装配：在 customCoords 未就绪时不崩溃，就绪后自动装配 GeoAdapter 并重算锚点', () => {
    const { map, canvas } = makeFakeAMap();
    const coordsHolder = map.customCoords;
    delete (map as any).customCoords;

    const layer = new AMapS3MLayer({ canvas });
    const stub = makeStubViewer();
    let recomputeCalled = false;
    stub.recomputeAnchors = () => {
      recomputeCalled = true;
    };
    (layer as any).viewer = stub;

    layer.setMap(map);
    expect(layer.viewer.geo).toBeNull();

    map.customCoords = coordsHolder;
    layer.render();
    expect(layer.viewer.geo).not.toBeNull();
    expect(recomputeCalled).toBe(true);
  });

  it('正交模式显式禁用并保持透视（仅告警一次，不静默降级）', () => {
    const { canvas } = makeFakeAMap();
    const layer = new AMapS3MLayer({ canvas });
    (layer as any).viewer = makeStubViewer();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };

    try {
      layer.setProjection('orthographic');
      layer.setProjection('orthographic');
    } finally {
      console.warn = origWarn;
    }

    expect(layer.projection).toBe('perspective');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('正交');
  });

  it('render 周期：纯净右手系 MVP（det < 0）且 cameraEnu 垂直与水平同尺', () => {
    const { map, canvas } = makeFakeAMap();
    const layer = new AMapS3MLayer({ canvas });
    const stub = makeStubViewer();

    let drivenFrame: any = null;
    stub.renderFrame = (frame: any) => {
      drivenFrame = frame;
      return false;
    };
    (layer as any).viewer = stub;

    layer.setMap(map);
    layer.render();

    expect(drivenFrame).not.toBeNull();
    const mat = new Matrix4().fromArray(drivenFrame.mvp);
    const enuMatrix = new Matrix4().set(
      1.3, 0, 0, stub.sceneAnchor.x,
      0, -1.3, 0, stub.sceneAnchor.y,
      0, 0, 1.3, stub.sceneAnchor.z,
      0, 0, 0, 1
    );
    const total = mat.clone().multiply(enuMatrix);
    expect(total.determinant()).toBeLessThan(0);

    // position = [0, -1000, 1000], sUp = 1.3 -> z = 1000 / 1.3
    expect(drivenFrame.cameraEnu[2]).toBeCloseTo(1000 / 1.3, 4);
    expect(drivenFrame.canvasHeight).toBe(768);
    expect(drivenFrame.fovRad).toBeCloseTo((60 * Math.PI) / 180, 5);
  });

  it('点击拾取、上下文恢复与 destroy 清理链路正确', () => {
    const { map, canvas } = makeFakeAMap();
    const picked: any[] = [];
    const layer = new AMapS3MLayer({
      canvas,
      onPick: (hit) => picked.push(hit),
    });
    const stub = makeStubViewer();
    (layer as any).viewer = stub;

    layer.setMap(map);
    // 模拟高德 click 事件（包含 DOM clientX/clientY，canvas left=10, top=20）
    map.listeners.click?.[0]?.({ originalEvent: { clientX: 110, clientY: 220 } });
    expect(stub.pickCalls).toEqual([[100, 200]]);
    expect(stub.selected).toEqual({ objectId: 42, batchId: 7 });
    expect(picked).toEqual([{ objectId: 42, batchId: 7 }]);

    // 模拟 WebGL 上下文恢复
    canvas.canvasListeners.webglcontextrestored?.[0]?.({});
    expect(stub.restoreCalls).toBe(1);

    layer.destroy();
    expect(layer.map).toBeNull();
    expect(layer.host).toBeNull();
    expect(stub.disposeCalls).toBe(1);
    expect(map.listeners.click?.length ?? 0).toBe(0);
  });
});
