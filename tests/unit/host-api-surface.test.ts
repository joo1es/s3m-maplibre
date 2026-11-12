import { describe, expect, it } from 'bun:test';
import type { S3MHost, S3MHostMouseEvent } from '../../packages/s3m-three/src/render/S3MHost.js';
import type { MapLike, MapMouseEventLike } from '../../packages/s3m-maplibre/src/MapLibreGeoAdapter.js';
import { HostRenderer } from '../../packages/s3m-three/src/render/HostRenderer.js';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer.js';
import type { GeoAdapter } from '../../packages/s3m-three/src/render/GeoAdapter.js';

describe('S3MHost 通用接口契约与 MapLike 兼容性 (Phase 1)', () => {
  it('MapLike 继承 S3MHost，MapMouseEventLike 兼容 S3MHostMouseEvent', () => {
    const fakeCanvas = { width: 800, height: 600 } as HTMLCanvasElement;
    let repaintCount = 0;
    const listeners: Record<string, Array<(e: MapMouseEventLike) => void>> = {};

    const host: S3MHost = {
      getCanvas: () => fakeCanvas,
      triggerRepaint: () => {
        repaintCount++;
      },
      on: (type, fn) => {
        (listeners[type] ||= []).push(fn as (e: MapMouseEventLike) => void);
      },
      off: (type, fn) => {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      getCenter: () => [116.4, 39.9],
      getZoom: () => 16,
      getPitch: () => 60,
      getBearing: () => 45,
    };

    expect(host.getCanvas?.()).toBe(fakeCanvas);
    host.triggerRepaint();
    expect(repaintCount).toBe(1);
    expect(host.getCenter?.()).toEqual([116.4, 39.9]);
    expect(host.getZoom?.()).toBe(16);
    expect(host.getPitch?.()).toBe(60);
    expect(host.getBearing?.()).toBe(45);

    // MapLike 可安全赋值给 S3MHost
    const maplike: MapLike = {
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
      getBearing: () => 45,
      transform: { fov: 60, fovInRadians: 1.047 },
    };
    const asHost: S3MHost = maplike;
    expect(asHost.getBearing?.()).toBe(45);

    const mouseEvent: MapMouseEventLike = { originalEvent: { clientX: 10, clientY: 20 }, point: { x: 10, y: 20 } };
    const hostEvent: S3MHostMouseEvent = mouseEvent;
    expect(hostEvent.originalEvent?.clientX).toBe(10);
  });

  it('HostRenderer 基类通过 _host 自动提供 host 与默认 getBearing()', () => {
    class MinimalHostRenderer extends HostRenderer {
      setHost(h: S3MHost | null): void {
        this._host = h;
      }
      protected requestRepaint(): void {
        this._host?.triggerRepaint();
      }
    }

    let repainted = 0;
    const renderer = new MinimalHostRenderer();
    expect(renderer.host).toBeNull();
    expect((renderer.viewer as any)._getBearing?.()).toBe(0);

    const host: S3MHost = {
      triggerRepaint: () => {
        repainted++;
      },
      getBearing: () => 123,
    };
    renderer.setHost(host);
    expect(renderer.host).toBe(host);
    expect((renderer.viewer as any)._getBearing?.()).toBe(123);

    (renderer.viewer as any)._onRequestRepaint();
    expect(repainted).toBe(1);
  });

  it('S3MLayer 挂载 S3MHost 且完整保留 options.geo / setGeoAdapter 注入能力', () => {
    const fakeGl = {} as WebGLRenderingContext;
    const canvas = {
      width: 800,
      height: 600,
      clientWidth: 800,
      clientHeight: 600,
      getContext: () => fakeGl,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement;

    let repainted = 0;
    const host: MapLike = {
      getCanvas: () => canvas,
      triggerRepaint: () => {
        repainted++;
      },
      on: () => {},
      off: () => {},
      getBearing: () => 90,
      getPitch: () => 45,
      getCenter: () => ({ lng: 120.0, lat: 30.0 }),
      getZoom: () => 15,
    };

    const customGeo: GeoAdapter = {
      worldFromLngLat: () => ({
        x: 1,
        y: 2,
        z: 3,
        meterInMercator: 1,
        meterInMercatorEast: 1,
        meterInMercatorNorth: 1,
        meterInMercatorUp: 1,
        altitude: 0,
      }),
      lngLatFromWorld: () => [120, 30],
    };

    const layer = new S3MLayer({ id: 'host-layer', geo: customGeo });
    let recomputes = 0;
    (layer as any).viewer = {
      mount() {},
      unmount() {},
      geo: null,
      recomputeAnchors() {
        recomputes++;
      },
    };

    layer.onAdd(host, fakeGl);
    expect(layer.map).toBe(host);
    expect(layer.host).toBe(host);
    // 保留 origin/main PR #47 行为：用户注入的 geo 优先于宿主推断
    expect(layer.viewer.geo).toBe(customGeo);
    expect((layer as any).getBearing()).toBe(90);

    layer.setGeoAdapter(null);
    expect(layer.viewer.geo).toBeNull();
    expect(recomputes).toBe(1);

    (layer as any).requestRepaint();
    expect(repainted).toBe(1);

    layer.onRemove();
    expect(layer.map).toBeNull();
    expect(layer.host).toBeNull();
  });
});
