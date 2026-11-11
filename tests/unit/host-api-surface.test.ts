import { describe, expect, it } from 'bun:test';
import type { S3MHost } from '../../packages/s3m-three/src/render/S3MHost.js';
import type { MapLike } from '../../packages/s3m-maplibre/src/MapLibreGeoAdapter.js';
import { HostRenderer } from '../../packages/s3m-three/src/render/HostRenderer.js';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer.js';

describe('S3MHost 通用接口契约与 MapLike 兼容性 (Phase 1)', () => {
  it('MapLike 继承并满足 S3MHost 核心契约', () => {
    // 构造一个满足 S3MHost 的最小地图对象
    const fakeCanvas = { width: 800, height: 600 } as HTMLCanvasElement;
    let repaintCount = 0;
    const listeners: Record<string, Array<(...a: any[]) => void>> = {};

    const host: S3MHost = {
      getCanvas: () => fakeCanvas,
      triggerRepaint: () => {
        repaintCount++;
      },
      on: (type, fn) => {
        (listeners[type] ||= []).push(fn);
      },
      off: (type, fn) => {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      getCenter: () => [116.4, 39.9],
      getZoom: () => 16,
      getPitch: () => 60,
      getBearing: () => 45,
    };

    expect(host.getCanvas()).toBe(fakeCanvas);
    host.triggerRepaint();
    expect(repaintCount).toBe(1);
    expect(host.getCenter?.()).toEqual([116.4, 39.9]);
    expect(host.getZoom?.()).toBe(16);
    expect(host.getPitch?.()).toBe(60);
    expect(host.getBearing?.()).toBe(45);

    // MapLike 赋值给 S3MHost
    const maplike: MapLike = {
      ...host,
      transform: { fov: 60, fovInRadians: 1.047 },
    };
    const asHost: S3MHost = maplike;
    expect(asHost.getBearing?.()).toBe(45);
  });

  it('HostRenderer 与 S3MLayer 对 S3MHost 宿主事件与渲染驱动无缝衔接', () => {
    const fakeGl = {} as WebGLRenderingContext;
    const canvas = {
      width: 800,
      height: 600,
      clientWidth: 800,
      clientHeight: 600,
      getContext: () => fakeGl,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as any;

    let repainted = 0;
    const listeners: Record<string, any[]> = {};

    const host: MapLike = {
      getCanvas: () => canvas,
      triggerRepaint: () => {
        repainted++;
      },
      on: (type, fn) => {
        (listeners[type] ||= []).push(fn);
      },
      off: (type, fn) => {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      getBearing: () => 90,
      getPitch: () => 45,
      getCenter: () => ({ lng: 120.0, lat: 30.0 }),
      getZoom: () => 15,
    };

    const layer = new S3MLayer({ id: 'host-layer' });

    // 桩化 viewer mount
    (layer as any).viewer = {
      mount() {},
      unmount() {},
      geo: null,
      recomputeAnchors() {},
    };

    layer.onAdd(host, fakeGl);
    expect(layer.map).toBe(host);
    expect((layer as any).getBearing()).toBe(90);

    (layer as any).requestRepaint();
    expect(repainted).toBe(1);

    layer.onRemove();
    expect(layer.map).toBeNull();
  });
});
