/**
 * 单元测试：GeoAdapter WGS84 椭球与各向异性尺度（Issue #17）
 *
 * 验收目标：
 * 1. meterInMercatorEast/North 与独立实现的 N(φ) / M(φ) 在 0–90° 上逐度比对，相对误差 < 1e-9
 * 2. 沿经线走 20 km、沿纬线走 20 km，两种方向回到经纬度的偏差都 < 1 cm（旧球面北向差 51 m @ 40°N）
 * 3. 一个 1 km × 1 km 的正方形在 40°N / 70°N 都不被拉成长方形（各向同性检查）
 * 4. MapLibreGeoAdapter 差分反推各向异性尺度校验
 * 5. S3MViewer 逆矩阵/拾取/量算/放置在椭球下的无缝衔接
 */
import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import {
  WGS84_A,
  WGS84_E2,
  primeVerticalRadius,
  meridianRadius,
  mercatorFromLngLat,
  enuToLngLat,
  lngLatToEnu,
  worldFromLngLat,
  lngLatFromWorld,
} from '../../packages/s3m-three/src/render/GeoAdapter.js';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer.js';
import { createMapLibreGeoAdapter, type WorldCoordinateHelperLike } from '../../packages/s3m-maplibre/src/MapLibreGeoAdapter.js';

const DEG = Math.PI / 180;

/* 独立基准函数实现（不依赖待测模块内部代码） */
function independentN(latDeg: number): number {
  const phi = latDeg * DEG;
  const sin = Math.sin(phi);
  return WGS84_A / Math.sqrt(1 - WGS84_E2 * sin * sin);
}

function independentM(latDeg: number): number {
  const phi = latDeg * DEG;
  const sin = Math.sin(phi);
  const w2 = 1 - WGS84_E2 * sin * sin;
  return (WGS84_A * (1 - WGS84_E2)) / (w2 * Math.sqrt(w2));
}

// 辛普森高精度数值积分计算子午线弧长
function meridianDistance(lat0Deg: number, lat1Deg: number, steps = 2000): number {
  const phi0 = lat0Deg * DEG;
  const phi1 = lat1Deg * DEG;
  const h = (phi1 - phi0) / steps;
  let sum = independentM(lat0Deg) + independentM(lat1Deg);
  for (let i = 1; i < steps; i++) {
    const phi = phi0 + i * h;
    const sin = Math.sin(phi);
    const w2 = 1 - WGS84_E2 * sin * sin;
    const m = (WGS84_A * (1 - WGS84_E2)) / (w2 * Math.sqrt(w2));
    sum += m * (i % 2 === 0 ? 2 : 4);
  }
  return (sum * h) / 3;
}

// 二分法寻找指定子午线弧长对应的终点纬度
function findTargetLatForMeridianDist(lat0Deg: number, targetDistMeters: number): number {
  let low = lat0Deg;
  let high = lat0Deg + (targetDistMeters / 60000) * (180 / Math.PI);
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    const d = meridianDistance(lat0Deg, mid);
    if (d < targetDistMeters) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

describe('Issue #17: GeoAdapter WGS84 椭球与各向异性换算', () => {
  it('验收 1: meterInMercatorEast/North 与独立实现的 N(φ) / M(φ) 在 0–90° 上逐度比对，相对误差 < 1e-9', () => {
    for (let lat = 0; lat < 90; lat++) {
      const res = mercatorFromLngLat(0, lat);
      const cosLat = Math.cos(lat * DEG);

      // 从 meterInMercatorEast/North 反解出来的 N 与 M
      const recoveredN = 1 / (2 * Math.PI * res.meterInMercatorEast * cosLat);
      const recoveredM = 1 / (2 * Math.PI * res.meterInMercatorNorth * cosLat);

      const trueN = independentN(lat);
      const trueM = independentM(lat);

      const relErrN = Math.abs(recoveredN - trueN) / trueN;
      const relErrM = Math.abs(recoveredM - trueM) / trueM;

      expect(relErrN).toBeLessThan(1e-9);
      expect(relErrM).toBeLessThan(1e-9);

      // 验证向后兼容字段 meterInMercator 等同于 meterInMercatorEast
      expect(res.meterInMercator).toBe(res.meterInMercatorEast);
    }
  });

  it('验收 2: 沿经线走 20 km、沿纬线走 20 km，两种方向回到经纬度的偏差都 < 1 cm（旧球面北向差 51 m @ 40°N）', () => {
    const anchor = { lon: 116.0, lat: 40.0, height: 0 };

    // 2.1 沿纬线走 20 km (East = 20,000 m, North = 0)
    const [eastLon, eastLat] = enuToLngLat(anchor.lon, anchor.lat, 20000, 0);
    // 纬度保持不变
    expect(Math.abs(eastLat - anchor.lat)).toBeLessThan(1e-9);
    // 经度变化理论值：dLon = 20000 / (N(40°) * cos(40°)) 弧度
    const trueEastDLon = (20000 / (independentN(40.0) * Math.cos(40.0 * DEG))) / DEG;
    const eastLonDiff = eastLon - anchor.lon;
    // 换算成地面米误差
    const eastErrMeters = Math.abs(eastLonDiff - trueEastDLon) * DEG * independentN(40.0) * Math.cos(40.0 * DEG);
    expect(eastErrMeters).toBeLessThan(0.01); // < 1 cm

    // 2.2 沿经线走 20 km (East = 0, North = 20,000 m)
    const [northLon, northLat] = enuToLngLat(anchor.lon, anchor.lat, 0, 20000);
    // 经度保持不变
    expect(Math.abs(northLon - anchor.lon)).toBeLessThan(1e-9);
    // 理论精确终点纬度（通过辛普森积分反求）
    const trueTargetLat = findTargetLatForMeridianDist(40.0, 20000);
    // 实际走到的子午线距离与 20000m 的偏差
    const actualDist = meridianDistance(40.0, northLat);
    const northErrMeters = Math.abs(actualDist - 20000);

    // 旧球面模型下此处偏差为 50.87 米 (~51 米)，修复后必须严格 < 1 cm
    expect(northErrMeters).toBeLessThan(0.01); // < 1 cm (0.01 m)

    // 2.3 往返互逆测试：lngLatToEnu 回到局部米制坐标，偏差 < 1 cm
    const [backEast, backNorth] = lngLatToEnu(anchor.lon, anchor.lat, eastLon, eastLat);
    expect(Math.abs(backEast - 20000)).toBeLessThan(0.01);
    expect(Math.abs(backNorth - 0)).toBeLessThan(0.01);

    const [backNorthE, backNorthN] = lngLatToEnu(anchor.lon, anchor.lat, northLon, northLat);
    expect(Math.abs(backNorthE - 0)).toBeLessThan(0.01);
    expect(Math.abs(backNorthN - 20000)).toBeLessThan(0.01);
  });

  it('验收 3: 一个 1 km × 1 km 的正方形在 40°N / 70°N 都不被拉成长方形（各向同性检查）', () => {
    for (const lat of [40.0, 70.0]) {
      const anchor = { lon: 100.0, lat, height: 0 };
      const side = 1000.0; // 1 km

      // 正方形在局部 ENU 中的顶点：(0,0), (1000, 0), (1000, 1000), (0, 1000)
      const pEast = enuToLngLat(anchor.lon, anchor.lat, side, 0);
      const pNorth = enuToLngLat(anchor.lon, anchor.lat, 0, side);

      // 计算东向边在地面上的真实距离
      const eastDist = (pEast[0] - anchor.lon) * DEG * independentN(lat) * Math.cos(lat * DEG);
      // 计算北向边在地面上的真实距离 (辛普森积分)
      const northDist = meridianDistance(lat, pNorth[1]);

      // 边长相对误差必须小于 0.001% (1 mm / 1000 m = 1e-6)
      expect(Math.abs(eastDist - side)).toBeLessThan(0.01);
      expect(Math.abs(northDist - side)).toBeLessThan(0.01);

      // 各向异性比率（长宽比）必须严格为 1.0 (偏差 < 1e-5，旧口径差 0.4% 即 4 米)
      const ratio = eastDist / northDist;
      expect(Math.abs(ratio - 1.0)).toBeLessThan(1e-5);
    }
  });

  it('验收 4: MapLibreGeoAdapter 差分反推各向异性尺度校验', () => {
    // 模拟一个高精度的宿主 WorldCoordinateHelper（以 Web 墨卡托为例）
    const mockHelper: WorldCoordinateHelperLike = {
      worldFromLngLat(lng: number, lat: number, altitude = 0) {
        const rad = (lat * Math.PI) / 180;
        const sin = Math.sin(rad);
        return {
          x: (180 + lng) / 360,
          y: 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI,
          z: altitude * (1 / (2 * Math.PI * WGS84_A)),
        };
      },
      lngLatFromWorld(x: number, y: number) {
        return [
          x * 360 - 180,
          (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
        ];
      },
    };

    const mockMap = {
      getCanvas: () => null as never,
      triggerRepaint: () => {},
      on: () => {},
      off: () => {},
      transform: {
        worldCoordinateHelper: mockHelper,
      },
    };

    const adapter = createMapLibreGeoAdapter(mockMap as never);
    expect(adapter).not.toBeNull();

    const lat = 40.0;
    const res = adapter!.worldFromLngLat(116.0, lat, 100);

    // 差分反推的 meterInMercatorEast 与 meterInMercatorNorth 应该具有椭球的各向异性比率
    const trueEast = 1 / (2 * Math.PI * independentN(lat) * Math.cos(lat * DEG));
    const trueNorth = 1 / (2 * Math.PI * independentM(lat) * Math.cos(lat * DEG));

    expect(res.meterInMercatorEast).toBeCloseTo(trueEast, 12);
    expect(res.meterInMercatorNorth).toBeCloseTo(trueNorth, 12);
    // 两者存在约 0.4% 的真实各向异性差
    expect(res.meterInMercatorEast).not.toBe(res.meterInMercatorNorth);
    expect(Math.abs(res.meterInMercatorEast / res.meterInMercatorNorth - independentM(lat) / independentN(lat))).toBeLessThan(1e-4);
  });

  it('验收 5: S3MViewer 矩阵与坐标反解全链路无缝衔接', () => {
    const v = new S3MViewer({
      canvas: null as never,
      container: null as never,
    } as ConstructorParameters<typeof S3MViewer>[0]);

    (v as unknown as { canvas: unknown }).canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 };
    (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();
    (v as unknown as { renderer: unknown }).renderer = {
      getContext: () => ({ isContextLost: () => false }),
      setViewport: () => {},
      resetState: () => {},
      render: () => {},
    };

    const anchorLon = 116.4;
    const anchorLat = 39.9;
    const anchorMerc = mercatorFromLngLat(anchorLon, anchorLat, 50);

    v.sceneAnchor = {
      x: anchorMerc.x,
      y: anchorMerc.y,
      z: anchorMerc.z,
      meterInMercatorEast: anchorMerc.meterInMercatorEast,
      meterInMercatorNorth: anchorMerc.meterInMercatorNorth,
      meterInMercator: anchorMerc.meterInMercator,
      altitude: 50,
    };

    // 5.1 lngLatToPoint 与 pointToLngLat 往返互逆
    const testPoint = { lng: 116.45, lat: 39.95, altitude: 120 };
    const enu = v.lngLatToPoint(testPoint);
    const back = v.pointToLngLat(enu);

    expect(back.lng).toBeCloseTo(testPoint.lng, 8);
    expect(back.lat).toBeCloseTo(testPoint.lat, 8);
    expect(back.altitude).toBeCloseTo(testPoint.altitude, 4);

    // 5.2 渲染矩阵包含正确的各向异性对角项
    const dummyMvp = new THREE.Matrix4().identity();
    v.renderFrame({
      mvp: dummyMvp.elements as unknown as number[],
      cameraEnu: [0, 0, 100],
    });

    const enuMatrix = (v as unknown as { _enuMatrix: THREE.Matrix4 })._enuMatrix;
    const e = enuMatrix.elements;
    // 对角项 x 为 sEast, y 为 -sNorth, z 为 sEast
    expect(e[0]).toBe(anchorMerc.meterInMercatorEast);
    expect(e[5]).toBe(-anchorMerc.meterInMercatorNorth);
    expect(e[10]).toBe(anchorMerc.meterInMercatorEast);

    v.dispose();
  });
});
