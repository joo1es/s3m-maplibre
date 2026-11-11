import { describe, expect, it } from 'bun:test';
import {
  wgs84ToGcj02,
  gcj02ToWgs84,
  isInsideChina,
  createAMapGeoAdapter,
} from '../../packages/s3m-three/src/render/GeoAdapter.js';

describe('GCJ-02 坐标系转换与边界处理 (Phase 0)', () => {
  it('境外坐标不转换，原样返回', () => {
    // 伦敦
    const london: [number, number] = [-0.1278, 51.5074];
    expect(isInsideChina(london[0], london[1])).toBe(false);
    expect(wgs84ToGcj02(london[0], london[1])).toEqual(london);
    expect(gcj02ToWgs84(london[0], london[1])).toEqual(london);

    // 纽约
    const nyc: [number, number] = [-74.006, 40.7128];
    expect(isInsideChina(nyc[0], nyc[1])).toBe(false);
    expect(wgs84ToGcj02(nyc[0], nyc[1])).toEqual(nyc);
    expect(gcj02ToWgs84(nyc[0], nyc[1])).toEqual(nyc);

    // 悉尼（南半球）
    const sydney: [number, number] = [151.2093, -33.8688];
    expect(isInsideChina(sydney[0], sydney[1])).toBe(false);
    expect(wgs84ToGcj02(sydney[0], sydney[1])).toEqual(sydney);

    // 东京
    const tokyo: [number, number] = [139.6917, 35.6895];
    expect(isInsideChina(tokyo[0], tokyo[1])).toBe(false);
    expect(wgs84ToGcj02(tokyo[0], tokyo[1])).toEqual(tokyo);
  });

  it('境内坐标正常产生偏转（约 300~700 米）', () => {
    // 北京天安门
    const bjWgs: [number, number] = [116.39126, 39.90700];
    expect(isInsideChina(bjWgs[0], bjWgs[1])).toBe(true);

    const bjGcj = wgs84ToGcj02(bjWgs[0], bjWgs[1]);
    expect(bjGcj[0]).not.toBe(bjWgs[0]);
    expect(bjGcj[1]).not.toBe(bjWgs[1]);

    // 偏转距离在 300m ~ 700m 之间
    // 纬度 1 度约 111km，经度在 40° 约 111*cos(40°) ≈ 85km
    const dLonMeters = (bjGcj[0] - bjWgs[0]) * 85000;
    const dLatMeters = (bjGcj[1] - bjWgs[1]) * 111000;
    const dist = Math.hypot(dLonMeters, dLatMeters);
    expect(dist).toBeGreaterThan(300);
    expect(dist).toBeLessThan(700);

    // 偏转已知参考值：高德天安门坐标约在 [116.39745, 39.90838] 附近
    expect(bjGcj[0]).toBeCloseTo(116.39745, 3);
    expect(bjGcj[1]).toBeCloseTo(39.90838, 3);
  });

  it('境内多城市往返误差断言（WGS84 → GCJ02 → WGS84 精度优于 1e-7 度，合毫米级）', () => {
    const testCities: [string, [number, number]][] = [
      ['北京', [116.4074, 39.9042]],
      ['上海', [121.4737, 31.2304]],
      ['广州', [113.2644, 23.1291]],
      ['成都', [104.0665, 30.5723]],
      ['哈尔滨', [126.5350, 45.8038]],
      ['乌鲁木齐', [87.6168, 43.8256]],
      ['拉萨', [91.1172, 29.6469]],
      ['三亚', [109.5119, 18.2528]],
    ];

    for (const [name, [lon, lat]] of testCities) {
      const gcj = wgs84ToGcj02(lon, lat);
      const backWgs = gcj02ToWgs84(gcj[0], gcj[1]);

      const errLon = Math.abs(backWgs[0] - lon);
      const errLat = Math.abs(backWgs[1] - lat);

      expect(errLon).toBeLessThan(1e-7);
      expect(errLat).toBeLessThan(1e-7);
    }
  });

  it('边界异常值与非法输入防御', () => {
    // NaN / Infinity 输入不崩溃，安全返回
    expect(wgs84ToGcj02(NaN, 39.9)).toEqual([NaN, 39.9]);
    expect(wgs84ToGcj02(116.4, Infinity)).toEqual([116.4, Infinity]);
    expect(gcj02ToWgs84(NaN, NaN)).toEqual([NaN, NaN]);

    // 边界极值：[0, 0] 不在境内
    expect(isInsideChina(0, 0)).toBe(false);
    expect(wgs84ToGcj02(0, 0)).toEqual([0, 0]);

    // 刚好在边界框外部
    expect(isInsideChina(72.0, 35.0)).toBe(false);
    expect(isInsideChina(138.0, 35.0)).toBe(false);
    expect(isInsideChina(100.0, 0.5)).toBe(false);
    expect(isInsideChina(100.0, 56.0)).toBe(false);
  });
});

describe('高德 customCoords 尺度定标与 GeoAdapter (Phase 0)', () => {
  it('定标高德 customCoords 水平/垂直比例：水平为墨卡托尺度，垂直为 1.0 (米制)', () => {
    const centerLon = 116.39745;
    const centerLat = 39.90838;

    // 模拟高德 customCoords 对象的行为（基于 Web 墨卡托米制坐标系，原点在 center）
    const R = 6378137.0;
    const centerMercX = (centerLon * Math.PI * R) / 180;
    const centerMercY = R * Math.log(Math.tan(Math.PI / 4 + (centerLat * Math.PI) / 360));

    const fakeCustomCoords = {
      lngLatToCoord([lng, lat]: [number, number]) {
        const mx = (lng * Math.PI * R) / 180;
        const my = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
        return [mx - centerMercX, my - centerMercY];
      },
      coordToLngLat([x, y]: [number, number]): [number, number] {
        const mx = x + centerMercX;
        const my = y + centerMercY;
        const lng = (mx / (Math.PI * R)) * 180;
        const lat = ((2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180) / Math.PI;
        return [lng, lat];
      },
    };

    const adapter = createAMapGeoAdapter({ customCoords: fakeCustomCoords, center: [centerLon, centerLat] });
    expect(adapter).not.toBeNull();

    // 在北京（lat ≈ 39.9°），cos(39.9°) ≈ 0.767
    // 东西向与南北向尺度 1 米对应的 customCoords 增量应该约为 1 / cos(lat) ≈ 1.303
    const res = adapter!.worldFromLngLat(116.39126, 39.90700, 100);

    const cosLat = Math.cos((39.90838 * Math.PI) / 180);
    const expectedHorizontalScale = 1 / cosLat;

    expect(res.meterInMercatorEast).toBeCloseTo(expectedHorizontalScale, 1);
    expect(res.meterInMercatorNorth).toBeCloseTo(expectedHorizontalScale, 1);

    // 关键定标断言：高德 3D 体系下，高度 z 是真实的地面米制高度，meterInMercatorUp 必须是 1.0！
    expect(res.meterInMercatorUp).toBe(1.0);
    expect(res.z).toBeCloseTo(100, 1); // 100 米高程对应 100 单位高度

    // 逆算验证：world 坐标转回经纬度应为输入的 WGS84 坐标
    const [backLng, backLat] = adapter!.lngLatFromWorld(res.x, res.y);
    expect(backLng).toBeCloseTo(116.39126, 5);
    expect(backLat).toBeCloseTo(39.90700, 5);
  });
});
