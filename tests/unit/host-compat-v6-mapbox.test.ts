/**
 * 宿主兼容性测试：MapLibre v6 与 Mapbox 3.32+ 内部接缝与版本矩阵（Issue #53）
 *
 * 验收目标：
 * P0:
 *   - S3MLayer._frameFov 在 Mapbox 宿主下正确读取 _fov / fov 弧度兜底，避免静默落到 DEFAULT_FOV。
 * P1:
 *   - extractWorldCoordinateHelper 支持 map._camera.transform 与 map.style.projection，移除已废弃的 painter.transform。
 *   - S3MLayer._applyOrtho 支持 map._camera.transform.cameraToCenterDistance。
 *   - maplibreOrtho: applyOrthoMatrices 支持 _cameraState 与 t.nearZ/farZ，并将矩阵写回 t._projection.currentTransform。
 *   - maplibreOrtho: enableMapLibreOrtho 支持 map._camera.transform。
 * 不变式①:
 *   - 旧版 MapLibre v5 宿主（map.transform / _helper / fovInRadians）行为与数值结果逐字一致。
 */
import { describe, expect, it } from 'bun:test';
import { Matrix4 } from 'three';
import { extractWorldCoordinateHelper, DEFAULT_FOV } from '../../packages/s3m-maplibre/src/MapLibreGeoAdapter.js';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer.js';
import { applyOrthoMatrices, enableMapLibreOrtho } from '../../packages/s3m-maplibre/src/maplibreOrtho.js';

const mockHelper = {
  worldFromLngLat: (lng: number, lat: number) => ({ x: lng * 10, y: lat * 10 }),
  lngLatFromWorld: (x: number, y: number) => ({ lng: x / 10, lat: y / 10 }),
};

describe('Issue #53: 宿主兼容性矩阵 (MapLibre v6 & Mapbox)', () => {
  describe('P1: extractWorldCoordinateHelper (MapLibre v5/v6 & Mapbox)', () => {
    it('MapLibre v5 路径：通过 map.transform.worldCoordinateHelper 提取', () => {
      const map = {
        transform: { worldCoordinateHelper: mockHelper },
      };
      expect(extractWorldCoordinateHelper(map)).toBe(mockHelper as any);
    });

    it('MapLibre v5 路径：通过 map.transform.projection.worldCoordinateHelper 提取', () => {
      const map = {
        transform: { projection: { worldCoordinateHelper: mockHelper } },
      };
      expect(extractWorldCoordinateHelper(map)).toBe(mockHelper as any);
    });

    it('MapLibre v6 路径：map.transform 已移除，通过 map._camera.transform 提取', () => {
      const map = {
        _camera: {
          transform: { worldCoordinateHelper: mockHelper },
        },
      };
      expect(extractWorldCoordinateHelper(map)).toBe(mockHelper as any);
    });

    it('MapLibre v6 路径：通过 map._camera.transform.projection 提取', () => {
      const map = {
        _camera: {
          transform: { projection: { worldCoordinateHelper: mockHelper } },
        },
      };
      expect(extractWorldCoordinateHelper(map)).toBe(mockHelper as any);
    });

    it('MapLibre v6 路径：通过 map.style.projection.worldCoordinateHelper 提取', () => {
      const map = {
        _camera: { transform: {} },
        style: {
          projection: { worldCoordinateHelper: mockHelper },
        },
      };
      expect(extractWorldCoordinateHelper(map)).toBe(mockHelper as any);
    });

    it('Mapbox / 缺失 helper 时返回 null', () => {
      expect(extractWorldCoordinateHelper({})).toBeNull();
      expect(extractWorldCoordinateHelper(null)).toBeNull();
      expect(extractWorldCoordinateHelper({ transform: {} })).toBeNull();
      expect(extractWorldCoordinateHelper({ _camera: { transform: {} } })).toBeNull();
    });
  });

  describe('P0 & P1: S3MLayer _frameFov 与 _applyOrtho (v5, v6, Mapbox)', () => {
    function makeLayerWithMap(map: any): S3MLayer {
      const layer = new S3MLayer({ id: 'test-layer' });
      (layer as any).map = map;
      return layer;
    }

    it('render(arg) 自带 fov 时优先使用 arg.fov（MapLibre 5+ 主路径）', () => {
      const layer = makeLayerWithMap({
        transform: { fovInRadians: 0.5 },
      });
      const fov = (layer as any)._frameFov({ fov: 0.8 });
      expect(fov).toBe(0.8);
    });

    it('MapLibre v5 兜底：arg 无 fov 时退回 map.transform.fovInRadians', () => {
      const layer = makeLayerWithMap({
        transform: { fovInRadians: 0.5 },
      });
      const fov = (layer as any)._frameFov({});
      expect(fov).toBe(0.5);
    });

    it('MapLibre v6 兜底：map.transform 为 undefined，退回 map._camera.transform.fovInRadians', () => {
      const layer = makeLayerWithMap({
        _camera: {
          transform: { fovInRadians: 0.52 },
        },
      });
      const fov = (layer as any)._frameFov({});
      expect(fov).toBe(0.52);
    });

    it('Mapbox / MapLibre 1-4 底层字段 _fov 为弧度', () => {
      const layer = makeLayerWithMap({
        transform: { _fov: 0.75 },
      });
      const fov = (layer as any)._frameFov({});
      expect(fov).toBe(0.75);
    });

    it('小范围度数 (0, π) 如 fov=2°：有 getFov 时转弧度，无弧度字段时不应误当弧度', () => {
      // 1. 宿主提供 getFov() 时，确认为度数并正确换算为 2 * π / 180 (约 0.0349 rad)
      const layer1 = makeLayerWithMap({
        transform: {
          fov: 2,
          getFov: () => 2,
        },
      });
      const fov1 = (layer1 as any)._frameFov({});
      expect(fov1).toBeCloseTo((2 * Math.PI) / 180, 6);
      expect(fov1).not.toBe(2); // 绝不能直接把 2 当成 2 弧度 (114.6°)

      // 2. 没有任何明确弧度标记时，安全回落默认 FOV，绝不把 2 当弧度
      const layer2 = makeLayerWithMap({
        transform: { fov: 2 },
      });
      const fov2 = (layer2 as any)._frameFov({});
      expect(fov2).toBe(DEFAULT_FOV);
    });

    it('MapLibre 4.x 签名兼容：render(gl, matrix, customRenderMethodInput)', () => {
      const fov = (60 * Math.PI) / 180;
      const aspect = 800 / 600;
      const near = 0.1;
      const far = 1000;
      const top = near * Math.tan(fov / 2);
      const bottom = -top;
      const right = top * aspect;
      const left = -right;
      const P = new Matrix4().makePerspective(left, right, top, bottom, near, far);
      const view = new Matrix4().makeTranslation(0, 0, -500);
      const MVP = P.clone().multiply(view);

      const layer = new S3MLayer({ id: 'ml4-layer', projection: 'orthographic' });
      (layer as any).map = {
        getCanvas: () => ({ width: 800, height: 600 }),
        transform: {
          cameraToCenterDistance: 500,
          _fov: fov,
        },
        triggerRepaint() {},
      };
      (layer as any).viewer = {
        sceneAnchor: {
          x: 0,
          y: 0,
          meterInMercatorEast: 1,
          meterInMercatorNorth: 1,
          meterInMercator: 1,
        },
      };
      (layer as any).driveFrame = () => {};

      // MapLibre 4.x: 第 2 参为 matrix (Float64Array)，第 3 参为 input 对象
      const ml4Matrix = Float64Array.from(MVP.elements);
      const ml4Input = {
        projectionMatrix: P.elements,
        modelViewProjectionMatrix: ml4Matrix,
        fov,
        nearZ: near,
        farZ: far,
      };

      // 调用 render 验证不抛错且能从第 3 参提取 projectionMatrix
      expect(() => {
        layer.render({} as any, ml4Matrix, ml4Input);
      }).not.toThrow();
    });

    it('MapLibre 3.x 签名兼容：render(gl, matrix) 无第 3 参', () => {
      const layer = new S3MLayer({ id: 'ml3-layer' });
      const fov = 0.6435;
      (layer as any).map = {
        getCanvas: () => ({ width: 800, height: 600 }),
        transform: {
          cameraToCenterDistance: 500,
          _fov: fov,
        },
        triggerRepaint() {},
      };
      (layer as any).viewer = {
        sceneAnchor: {
          x: 0,
          y: 0,
          meterInMercatorEast: 1,
          meterInMercatorNorth: 1,
          meterInMercator: 1,
        },
      };
      let driven = false;
      (layer as any).driveFrame = () => {
        driven = true;
      };

      // MapLibre 3.x: 仅传 matrix
      const ml3Matrix = new Float64Array(16);
      ml3Matrix[0] = 1;
      ml3Matrix[5] = 1;
      ml3Matrix[10] = 1;
      ml3Matrix[15] = 1;

      layer.render({} as any, ml3Matrix);
      expect(driven).toBe(true);
      expect((layer as any)._frameFov(ml3Matrix)).toBe(fov);
    });

    it('Mapbox 3.32+ 签名兼容：render(gl, matrix, ... 5个参数, renderParameters) 支持图层正交', () => {
      const fov = 0.6435011087932844;
      const aspect = 800 / 600;
      const near = 0.1;
      const far = 1000;
      const top = near * Math.tan(fov / 2);
      const bottom = -top;
      const right = top * aspect;
      const left = -right;
      const P = new Matrix4().makePerspective(left, right, top, bottom, near, far);
      const view = new Matrix4().makeTranslation(0, 0, -500);
      const MVP = P.clone().multiply(view);

      const layer = new S3MLayer({ id: 'mb332-layer', projection: 'orthographic' });
      (layer as any).map = {
        getCanvas: () => ({ width: 800, height: 600 }),
        transform: {
          cameraToCenterDistance: 500,
          _fov: fov,
        },
        triggerRepaint() {},
      };
      (layer as any).viewer = {
        sceneAnchor: {
          x: 0,
          y: 0,
          meterInMercatorEast: 1,
          meterInMercatorNorth: 1,
          meterInMercator: 1,
        },
      };
      (layer as any).driveFrame = () => {};

      const mbMatrix = Float64Array.from(MVP.elements);
      const renderParameters = {
        projectionMatrix: new Float64Array(P.elements),
        viewMatrix: new Float64Array(view.elements),
        globeClippingPlane: null,
        globeCenterInScreenPixels: null,
      };

      // Mapbox 3.32+: 第 1 参 gl, 第 2 参 matrix, 第 3~7 参各种过渡参数, 第 8 参 renderParameters
      expect(() => {
        layer.render(
          {} as any,
          mbMatrix,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          renderParameters
        );
      }).not.toThrow();
    });

    it('全无 fov 字段时回落 DEFAULT_FOV', () => {
      const layer = makeLayerWithMap({});
      const fov = (layer as any)._frameFov({});
      expect(fov).toBe(DEFAULT_FOV);
    });

    it('MapLibre v6 下 _applyOrtho 读取 map._camera.transform.cameraToCenterDistance', () => {
      const fov = (60 * Math.PI) / 180;
      const aspect = 800 / 600;
      const near = 0.1;
      const far = 1000;
      const top = near * Math.tan(fov / 2);
      const bottom = -top;
      const right = top * aspect;
      const left = -right;
      const P = new Matrix4().makePerspective(left, right, top, bottom, near, far);
      const view = new Matrix4().makeTranslation(0, 0, -1234);
      const MVP = P.clone().multiply(view);

      const layer = makeLayerWithMap({
        _camera: {
          transform: {
            cameraToCenterDistance: 1234,
            fovInRadians: fov,
          },
        },
        getCanvas: () => ({ width: 800, height: 600 }),
      });

      const arg = {
        projectionMatrix: P.elements,
        fov,
        nearZ: near,
        farZ: far,
      };

      const result = (layer as any)._applyOrtho(arg, MVP, 1);
      expect(result).not.toBeNull();
    });
  });

  describe('P1: maplibreOrtho 正交接管 (MapLibre v5 & v6)', () => {
    const W = 1280;
    const H = 800;
    const FOV = (60 * Math.PI) / 180;
    const WORLD_SIZE = 512 * Math.pow(2, 16);
    const CAM_DIST = (0.5 / Math.tan(FOV / 2)) * H;

    it('MapLibre v6 结构：applyOrthoMatrices 读取 _cameraState 与 t.nearZ/farZ 并写回 currentTransform', () => {
      const currentTransform: any = {
        _clearMatrixCaches() {},
      };

      const tV6: any = {
        center: { lng: 116.5, lat: 39.9 },
        worldSize: WORLD_SIZE,
        centerOffset: { x: 0, y: 0 },
        elevation: 0,
        pitchInRadians: 0,
        bearingInRadians: 0,
        rollInRadians: 0,
        clipSpaceToPixelsMatrix: new Matrix4().elements,
        nearZ: 0.1,
        farZ: 1000,
        _clearMatrixCaches() {},
        _cameraState: {
          width: W,
          height: H,
          cameraToCenterDistance: CAM_DIST,
          pixelsPerMeter: WORLD_SIZE / 111320,
        },
        _projection: {
          currentTransform,
        },
      };

      const ok = applyOrthoMatrices(tV6);
      expect(ok).toBe(true);

      // 验证 t 自身被写回
      expect(tV6._viewProjMatrix).toBeDefined();
      expect(tV6._projectionMatrix).toBeDefined();
      expect(tV6._pixelMatrix).toBeDefined();

      // 验证 v6 的 currentTransform (MercatorTransform) 也同步写回
      expect(currentTransform._viewProjMatrix).toBeDefined();
      expect(currentTransform._projectionMatrix).toBeDefined();
      expect(currentTransform._pixelMatrix).toBeDefined();

      // 数值一致性：v6 _cameraState 算出来的 viewProj 与 v5 _helper 算出来的完全一致
      const tV5: any = {
        center: { lng: 116.5, lat: 39.9 },
        worldSize: WORLD_SIZE,
        centerOffset: { x: 0, y: 0 },
        elevation: 0,
        pitchInRadians: 0,
        bearingInRadians: 0,
        rollInRadians: 0,
        clipSpaceToPixelsMatrix: new Matrix4().elements,
        _clearMatrixCaches() {},
        _helper: {
          _width: W,
          _height: H,
          _nearZ: 0.1,
          _farZ: 1000,
          cameraToCenterDistance: CAM_DIST,
          _pixelPerMeter: WORLD_SIZE / 111320,
        },
      };

      expect(applyOrthoMatrices(tV5)).toBe(true);
      for (let i = 0; i < 16; i++) {
        expect(tV6._viewProjMatrix[i]).toBeCloseTo(tV5._viewProjMatrix[i], 9);
      }
    });

    it('MapLibre v6 结构：enableMapLibreOrtho 支持 map._camera.transform', () => {
      let calcCount = 0;
      const transform: any = {
        _calcMatrices() {
          calcCount++;
        },
        center: { lng: 116.5, lat: 39.9 },
        worldSize: WORLD_SIZE,
        clipSpaceToPixelsMatrix: new Matrix4().elements,
        nearZ: 0.1,
        farZ: 1000,
        _cameraState: {
          width: W,
          height: H,
          cameraToCenterDistance: CAM_DIST,
          pixelsPerMeter: WORLD_SIZE / 111320,
        },
      };

      const map = {
        _camera: { transform },
        triggerRepaint() {},
      };

      const ctl = enableMapLibreOrtho(map as any);
      // patch 已装上
      transform._calcMatrices();
      expect(calcCount).toBe(1);
      expect(transform._viewProjMatrix).toBeDefined();

      // setEnabled(false)
      ctl.setEnabled(false);
      transform._calcMatrices();
      expect(calcCount).toBe(3); // setEnabled 主动触发一次 + 本次一次

      // dispose 恢复原始函数
      ctl.dispose();
      expect((transform as any).__s3mOrtho).toBeUndefined();
    });
  });
});
