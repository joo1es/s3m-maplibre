import { describe, expect, it } from 'bun:test';
import { Matrix4, PerspectiveCamera } from 'three';
import { AMapS3MLayer } from '../../examples/amap/AMapS3MLayer.js';

describe('AMapS3MLayer 高德地图适配层测试 (Phase 2)', () => {
  function makeFakeAMap() {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    let repaintCount = 0;
    const canvas = {
      width: 1024,
      height: 768,
      clientWidth: 1024,
      clientHeight: 768,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }),
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
        up: [0, 1, 0],
        lookAt: [0, 0, 0],
        position: [0, -1000, 1000],
      }),
    };

    const map = {
      customCoords,
      getCanvas: () => canvas,
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
    return { map, canvas, customCoords };
  }

  it('初始化与挂载：init 设置 autoClear = false 并创建 AMapGeoAdapter', () => {
    const { map } = makeFakeAMap();
    const layer = new AMapS3MLayer({ id: 'amap-s3m' });

    expect(layer.id).toBe('amap-s3m');
    expect(layer.projection).toBe('perspective');

    let mounted = false;
    let autoClearVal: boolean | null = null;
    const fakeViewer: any = {
      renderer: null,
      mount: () => {
        mounted = true;
        fakeViewer.renderer = {
          get autoClear() {
            return autoClearVal;
          },
          set autoClear(v: boolean) {
            autoClearVal = v;
          },
          resetState: () => {},
        };
      },
      unmount: () => {},
      restoreContext: () => {},
      geo: null,
      sceneAnchor: null,
    };
    (layer as any).viewer = fakeViewer;

    const fakeGl = {} as WebGLRenderingContext;
    layer.init(map, fakeGl);

    expect(mounted).toBe(true);
    expect(autoClearVal).toBe(false); // 必须为 false，防止擦除高德底图
    expect(layer.viewer.geo).not.toBeNull();
  });

  it('正交模式显式禁用并保持透视（发出警告，不静默降级）', () => {
    const layer = new AMapS3MLayer();
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

  it('render 周期：正确提取相机参数、调用前后 resetState 并驱动帧', () => {
    const { map } = makeFakeAMap();
    const layer = new AMapS3MLayer();

    let resetCount = 0;
    let drivenFrame: any = null;

    (layer as any).viewer = {
      mount: () => {},
      unmount: () => {},
      restoreContext: () => {},
      renderer: {
        autoClear: true,
        resetState: () => {
          resetCount++;
        },
        getContext: () => ({ isContextLost: () => false }),
      },
      sceneAnchor: {
        x: 0,
        y: 0,
        z: 0,
        meterInMercatorEast: 1.3,
        meterInMercatorNorth: 1.3,
        meterInMercatorUp: 1.0,
        meterInMercator: 1.3,
      },
      renderFrame: (frame: any) => {
        drivenFrame = frame;
        return false;
      },
    };

    layer.init(map, {} as WebGLRenderingContext);
    layer.render();

    // 必须调用两次 resetState：渲染前一次，渲染后一次
    expect(resetCount).toBe(2);

    // 驱动帧参数正确
    expect(drivenFrame).not.toBeNull();
    expect(drivenFrame.mvp).toBeDefined();
    expect(drivenFrame.cameraEnu).toBeDefined();
    expect(drivenFrame.canvasHeight).toBe(768);
    expect(drivenFrame.fovRad).toBeCloseTo((60 * Math.PI) / 180, 5);
  });
});
