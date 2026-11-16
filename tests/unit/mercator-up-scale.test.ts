/**
 * 单元测试：竖向尺度走宿主口径（球面 3857），横向走经纬度网格（椭球）
 *
 * ## 为什么两个方向半径不同
 *
 * - **横向**：底图瓦片按经纬度网格铺，模型顶点的经纬度由 `enuToLngLat`（WGS84 椭球积分）
 *   算出，所以「ENU 米 → 墨卡托」这条捷径必须用同一套 `N(φ)` / `M(φ)`。用球面会让模型
 *   与底图错开 0.14%（东西）/ 0.26%（南北）。
 * - **竖向**：高度没有经纬度约束，口径由宿主定。宿主把 z 列乘 `pixelsPerMeter`，而
 *   `pixelsPerMeter = mercatorZfromAltitude(1, lat) · worldSize`，归一化后等于
 *   `1/(2π·R·cosφ)`（R = 6378137）。用椭球 N 会让楼高多出 0.138%。
 *
 * 39.9°N：球面 3.25323e-8，椭球 N 3.24875e-8。
 */
import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer.js';
import {
  MERCATOR_R,
  mercatorFromLngLat,
  mercatorUnitPerMeterUp,
  worldFromLngLat,
} from '../../packages/s3m-three/src/render/GeoAdapter.js';
import { computeTilePlacement } from '../../packages/s3m-three/src/render/tilePlacement.js';

const LAT = 39.9129;
const DEG = Math.PI / 180;

describe('竖向按宿主（球面）口径', () => {
  it('meterInMercatorUp = 1/(2π·R·cosφ)，R 是球面半径', () => {
    const res = mercatorFromLngLat(116.4581, LAT);
    const expected = 1 / (2 * Math.PI * MERCATOR_R * Math.cos(LAT * DEG));
    expect(MERCATOR_R).toBe(6378137);
    expect(res.meterInMercatorUp).toBeCloseTo(expected, 20);
    // 与宿主 pixelsPerMeter / worldSize 同式
    const worldSize = 19271960.420629926;
    const pixelsPerMeter = 1 / (2 * Math.PI * MERCATOR_R * Math.cos(LAT * DEG)) * worldSize;
    expect(pixelsPerMeter / worldSize).toBeCloseTo(res.meterInMercatorUp!, 20);
  });

  it('横向仍是椭球，各向异性保留（0.4% 量级），竖向不再等于东西向', () => {
    const res = mercatorFromLngLat(116.4581, LAT);
    // 东西向：椭球 N，比球面小 0.138%
    expect(res.meterInMercatorEast!).toBeLessThan(res.meterInMercatorUp!);
    expect(res.meterInMercatorUp! / res.meterInMercatorEast! - 1).toBeCloseTo(0.001378, 5);
    // 南北向：椭球 M，比东西向大 0.26%
    expect(res.meterInMercatorNorth!).toBeGreaterThan(res.meterInMercatorEast!);
  });

  it('mercatorUnitPerMeterUp 是纯函数，与 worldFromLngLat 的兜底逐位一致', () => {
    const res = worldFromLngLat(null, 116.4581, LAT, 0);
    expect(res.meterInMercatorUp).toBe(mercatorUnitPerMeterUp(LAT * DEG));
  });
});

describe('竖直方向上的放置要用同一个 sUp', () => {
  const anchor = { lon: 116.4581, lat: LAT, height: 0 };

  it('_enuMatrix 的 z 对角项取 meterInMercatorUp，不是 sEast', () => {
    const v = new S3MViewer({ canvas: null as never, container: null as never } as ConstructorParameters<
      typeof S3MViewer
    >[0]);
    const self = v as unknown as Record<string, unknown>;
    self.canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 };
    self.camera = new THREE.PerspectiveCamera();
    self.renderer = {
      getContext: () => ({ isContextLost: () => false }),
      setViewport: () => {},
      resetState: () => {},
      render: () => {},
    };
    const a = worldFromLngLat(null, anchor.lon, anchor.lat, 0);
    v.sceneAnchor = {
      x: a.x,
      y: a.y,
      z: a.z,
      meterInMercatorEast: a.meterInMercatorEast,
      meterInMercatorNorth: a.meterInMercatorNorth,
      meterInMercatorUp: a.meterInMercatorUp,
      meterInMercator: a.meterInMercator,
      altitude: 0,
    };
    v.renderFrame({
      mvp: new THREE.Matrix4().identity().elements,
      cameraEnu: [0, 0, 0],
      fovRad: 0.6435011087932844,
      canvasHeight: 100,
    });
    const e = (v as unknown as { _enuMatrix: THREE.Matrix4 })._enuMatrix.elements;
    expect(e[10]).toBe(a.meterInMercatorUp);
    expect(e[10]).not.toBe(a.meterInMercatorEast);
    v.dispose();
  });

  it('瓦片中心 z=100 m → position[2] 必须回到 100 m（不是 100.138）', () => {
    const sceneAnchor = worldFromLngLat(null, anchor.lon, anchor.lat, 0);
    const placement = computeTilePlacement({
      center: { x: 0, y: 0, z: 100 },
      datasetAnchor: anchor,
      sceneAnchor: {
        x: sceneAnchor.x,
        y: sceneAnchor.y,
        z: sceneAnchor.z,
        meterInMercatorEast: sceneAnchor.meterInMercatorEast,
        meterInMercatorNorth: sceneAnchor.meterInMercatorNorth,
        meterInMercatorUp: sceneAnchor.meterInMercatorUp,
        meterInMercator: sceneAnchor.meterInMercator,
        altitude: 0,
      },
      datasetOffset: [0, 0, 0],
      geo: null,
    });
    expect(placement).not.toBeNull();
    expect(placement!.position[2]).toBeCloseTo(100, 9);
    // 若错误地拿 sEast 去除，会得到 100 × sUp/sEast ≈ 100.138
    expect(Math.abs(placement!.position[2] - 100)).toBeLessThan(1e-6);
  });
});
