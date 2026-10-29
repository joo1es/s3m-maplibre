import { describe, expect, it } from 'bun:test';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer.js';

const fakeGl = {} as WebGLRenderingContext;

function makeFakeMap() {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const map: any = {
    _repaints: 0,
    getCanvas: () => ({
      width: 800,
      height: 600,
      clientWidth: 800,
      clientHeight: 600,
      getContext: () => fakeGl,
    }),
    getBearing: () => 45,
    triggerRepaint: () => {
      map._repaints++;
    },
    on(type: string, fn: (...a: any[]) => void) {
      (listeners[type] ||= []).push(fn);
    },
    off(type: string, fn: (...a: any[]) => void) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    listeners,
  };
  return map;
}

describe('S3MLayer API 表面与适配器生命周期', () => {
  it('配置 id、projection 与 nearPlaneScale 并支持 getter/setter', () => {
    const layer = new S3MLayer({
      id: 'custom-s3m',
      projection: 'orthographic',
      nearPlaneScale: 0.2,
    });

    expect(layer.id).toBe('custom-s3m');
    expect(layer.projection).toBe('orthographic');
    expect(layer.nearPlaneScale).toBe(0.2);

    // 动态切换 projection
    layer.setProjection('perspective');
    expect(layer.projection).toBe('perspective');

    // 动态调整 nearPlaneScale
    layer.setNearPlaneScale(0.5);
    expect(layer.nearPlaneScale).toBe(0.5);

    // 传 1 / 0 / 非法值恢复默认 1（不缩放）
    layer.setNearPlaneScale(-1);
    expect(layer.nearPlaneScale).toBe(1);
  });

  it('生命周期：onAdd 注册监听器与地图，onRemove 完全解绑并释放', () => {
    const layer = new S3MLayer({ id: 'layer-1' });
    const map = makeFakeMap();

    // 桩化 viewer 以避免真实 WebGL 上下文
    (layer as any).viewer = {
      mount() {},
      unmount() {},
      geo: null,
      recomputeAnchors() {},
    };

    layer.onAdd(map, fakeGl);
    expect(layer.map).toBe(map);
    expect(layer.getBearing()).toBe(45);
    expect(map.listeners['click']).toHaveLength(1);
    expect(map.listeners['projectiontransition']).toHaveLength(1);
    expect(map.listeners['webglcontextlost']).toHaveLength(1);
    expect(map.listeners['webglcontextrestored']).toHaveLength(1);

    // 卸载图层
    layer.onRemove();
    expect(layer.map).toBeNull();
    expect(map.listeners['click']).toHaveLength(0);
    expect(map.listeners['projectiontransition']).toHaveLength(0);
    expect(map.listeners['webglcontextlost']).toHaveLength(0);
    expect(map.listeners['webglcontextrestored']).toHaveLength(0);
  });

  it('_extractMatrix：支持 MapLibre/Mapbox 各种 MVP 矩阵签名格式', () => {
    const layer = new S3MLayer({ id: 'matrix-test' });
    const extract = (layer as any)._extractMatrix.bind(layer);

    // 1. 普通数字数组
    const arr = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(extract(arr)).toBe(arr);

    // 2. Float64Array / Float32Array
    const f32 = new Float32Array(16);
    expect(extract(f32)).toBe(f32);
    const f64 = new Float64Array(16);
    expect(extract(f64)).toBe(f64);

    // 3. MapLibre v5: defaultProjectionData.mainMatrix
    const v5Obj = { defaultProjectionData: { mainMatrix: f32 } };
    expect(extract(v5Obj)).toBe(f32);

    // 4. Mapbox / MapLibre v4: modelViewProjectionMatrix
    const v4Obj = { modelViewProjectionMatrix: arr };
    expect(extract(v4Obj)).toBe(arr);

    // 5. 无效对象或 null
    expect(extract(null)).toBeNull();
    expect(extract(undefined)).toBeNull();
    expect(extract({})).toBeNull();
  });
});
