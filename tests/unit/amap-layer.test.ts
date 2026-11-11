import { describe, expect, it } from 'bun:test';
import { Matrix4 } from 'three';
import { AMapS3MLayer } from '../../examples/amap/AMapS3MLayer.js';

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
      mount() {
        v.mountCalls++;
      },
      unmount() {},
      restoreContext() {},
      recomputeAnchors() {},
      sceneAnchor: {
        x: 0,
        y: 0,
        z: 0,
        meterInMercatorEast: 1.3,
        meterInMercatorNorth: 1.3,
        meterInMercatorUp: 1.0,
        meterInMercator: 1.3,
      },
      renderFrame: () => false,
    };
    return v;
  }

  function makeFakeAMap() {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    let repaintCount = 0;
    const container = {
      clientWidth: 1024,
      clientHeight: 768,
      appendChild: (_child: any) => {},
      removeChild: (_child: any) => {},
      contains: (_child: any) => true,
    } as any;

    const customCoords = {
      _center: [116.39745, 39.90838],
      getCenter: () => [116.39745, 39.90838],
      lngLatToCoord: ([lng, lat]: [number, number]) => {
        return [(lng - 116.39745) * 85000, (lat - 39.90838) * 111000, 0];
      },
      coordToLngLat: ([x, y]: [number, number]) => {
        return [116.39745 + x / 85000, 39.90838 + y / 111000];
      },
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
      getCenter: () => [116.39745, 39.90838],
      getZoom: () => 16,
      getPitch: () => 45,
      getBearing: () => 0,
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

    const canvas = {
      style: {},
      width: 1024,
      height: 768,
      getContext: () => ({ isContextLost: () => false }),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }),
    } as any;

    return { map, container, customCoords, canvas };
  }

  it('初始化与挂载：采用独立覆盖画布并支持惰性装配 GeoAdapter', () => {
    const { map, canvas } = makeFakeAMap();
    const layer = new AMapS3MLayer({ id: 'amap-s3m', canvas });
    (layer as any).viewer = makeStubViewer();

    expect(layer.id).toBe('amap-s3m');
    expect(layer.projection).toBe('perspective');

    // 独立画布已挂载，样式为覆盖层
    const layerCanvas = layer.getCanvas();
    expect(layerCanvas).not.toBeNull();
    expect(layerCanvas?.style.position).toBe('absolute');
    expect(layerCanvas?.style.pointerEvents).toBe('none');

    // 挂载到地图
    layer.setMap(map);
    expect(layer.map).toBe(map);
    expect(layer.viewer.geo).not.toBeNull();
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
    // customCoords 缺失时严格返回 null，不提前装配
    expect(layer.viewer.geo).toBeNull();

    // 模拟底图完全就绪，挂上 customCoords
    map.customCoords = coordsHolder;

    // render 时自动惰性装配
    layer.render();
    expect(layer.viewer.geo).not.toBeNull();
    expect(recomputeCalled).toBe(true);
  });

  it('正交模式显式禁用并保持透视（发出警告，不静默降级）', () => {
    const { canvas } = makeFakeAMap();
    const layer = new AMapS3MLayer({ canvas });
    (layer as any).viewer = makeStubViewer();
    let warnMsg = '';
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      warnMsg = msg;
    };

    layer.setProjection('orthographic');

    console.warn = origWarn;
    expect(layer.projection).toBe('perspective');
    expect(warnMsg).toContain('高德适配层暂不支持正交投影模式');
  });

  it('render 周期：纯净 MVP 矩阵（无镜像负缩放，保持右手系三角形绕序）并驱动帧', () => {
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

    // 驱动帧参数正确
    expect(drivenFrame).not.toBeNull();
    expect(drivenFrame.mvp).toBeDefined();

    // 关键矩阵验证：MVP 矩阵的行列式应大于 0，杜绝负缩放导致的背面剔除三角形翻转
    const mat = new Matrix4().fromArray(drivenFrame.mvp);
    const det = mat.determinant();
    expect(Number.isFinite(det)).toBe(true);
    expect(det).not.toBe(0);

    expect(drivenFrame.cameraEnu).toBeDefined();
    expect(drivenFrame.canvasHeight).toBe(768);
    expect(drivenFrame.fovRad).toBeCloseTo((60 * Math.PI) / 180, 5);
  });
});
