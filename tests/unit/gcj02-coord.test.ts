import { describe, expect, it } from 'bun:test';
import {
  isInsideChina,
  wgs84ToGcj02,
  gcj02ToWgs84,
  createAMapGeoAdapter,
} from '../../packages/s3m-three/src/render/GeoAdapter';

describe('GCJ-02 坐标系转换与边界处理 (Phase 0)', () => {
  it('中国境内识别与境外原样透传', () => {
    // 北京天安门：境内
    expect(isInsideChina(116.39126, 39.907)).toBe(true);
    // 上海外滩：境内
    expect(isInsideChina(121.4903, 31.2337)).toBe(true);
    // 伦敦、纽约、东京：境外
    expect(isInsideChina(-0.1276, 51.5072)).toBe(false);
    expect(isInsideChina(-74.006, 40.7128)).toBe(false);
    expect(isInsideChina(139.6917, 35.6895)).toBe(false);
    // 边界外 & 非法数
    expect(isInsideChina(71.9, 30.0)).toBe(false);
    expect(isInsideChina(138.0, 30.0)).toBe(false);
    expect(isInsideChina(Number.NaN, 39.9)).toBe(false);
    expect(isInsideChina(116.4, Number.POSITIVE_INFINITY)).toBe(false);

    // 境外不发生偏移
    expect(wgs84ToGcj02(139.6917, 35.6895)).toEqual([139.6917, 35.6895]);
    expect(gcj02ToWgs84(-74.006, 40.7128)).toEqual([-74.006, 40.7128]);
    // 非法输入原样返回
    const nanPair = wgs84ToGcj02(Number.NaN, 39.9);
    expect(Number.isNaN(nanPair[0])).toBe(true);
  });

  it('WGS84 → GCJ-02 产生预期百米级偏移，正逆向往返精度优于 1e-6 度（厘米级）', () => {
    const cases: Array<[number, number]> = [
      [116.39126, 39.907],   // 北京
      [121.4903, 31.2337],   // 上海
      [113.2644, 23.1291],   // 广州
      [104.0665, 30.5728],   // 成都
      [87.6177, 43.7928],    // 乌鲁木齐
    ];

    for (const [wgsLng, wgsLat] of cases) {
      const [gcjLng, gcjLat] = wgs84ToGcj02(wgsLng, wgsLat);
      // 偏移量在 0.001 ~ 0.01 度（约 100~800 米）范围内
      const dLng = Math.abs(gcjLng - wgsLng);
      const dLat = Math.abs(gcjLat - wgsLat);
      expect(dLng).toBeGreaterThan(0.0005);
      expect(dLng).toBeLessThan(0.02);
      expect(dLat).toBeGreaterThan(0.0002);
      expect(dLat).toBeLessThan(0.02);

      // 逆转换往返误差
      const [backLng, backLat] = gcj02ToWgs84(gcjLng, gcjLat);
      expect(Math.abs(backLng - wgsLng)).toBeLessThan(1e-6);
      expect(Math.abs(backLat - wgsLat)).toBeLessThan(1e-6);
    }
  });
});

describe('高德 customCoords 尺度定标与 GeoAdapter (Phase 0)', () => {
  const makeMockCustomCoords = (centerLon: number, centerLat: number) => {
    // 模拟高德 customCoords：输出为相对参考点的 Web 墨卡托米（+x 东，+y 北，尺度 ≈ 1/cosφ）
    const R = 6378137.0;
    const project = (lng: number, lat: number): [number, number] => {
      const x = R * ((lng * Math.PI) / 180);
      const y = R * Math.log(Math.tan(Math.PI / 4 + ((lat * Math.PI) / 180) / 2));
      return [x, y];
    };
    const [cx, cy] = project(centerLon, centerLat);
    return {
      lngLatToCoord([lng, lat]: [number, number]): [number, number] {
        const [px, py] = project(lng, lat);
        return [px - cx, py - cy];
      },
      coordToLngLat([x, y]: [number, number]): [number, number] {
        const px = cx + x;
        const py = cy + y;
        const lng = (px / R) * (180 / Math.PI);
        const lat = (2 * Math.atan(Math.exp(py / R)) - Math.PI / 2) * (180 / Math.PI);
        return [lng, lat];
      },
    };
  };

  it('缺少 customCoords 或 lngLatToCoord 时返回 null', () => {
    expect(createAMapGeoAdapter(null)).toBeNull();
    expect(createAMapGeoAdapter(undefined)).toBeNull();
    expect(createAMapGeoAdapter({})).toBeNull();
    expect(createAMapGeoAdapter({ customCoords: {} })).toBeNull();
  });

  it('水平与垂直同为墨卡托尺度（≈1/cosφ），不做二次放大，Y 轴朝南取反', () => {
    const centerLon = 116.4625;
    const centerLat = 39.915287;
    const customCoords = makeMockCustomCoords(centerLon, centerLat);
    const adapter = createAMapGeoAdapter({ customCoords });
    expect(adapter).not.toBeNull();

    const wgsLng = 116.4625;
    const wgsLat = 39.915287;
    const [gcjLng, gcjLat] = wgs84ToGcj02(wgsLng, wgsLat);
    const rawPt = customCoords.lngLatToCoord([gcjLng, gcjLat]);

    const res = adapter!.worldFromLngLat(wgsLng, wgsLat, 100);
    // Y 轴归一：+y 朝南（高德原生 +y 朝北，因此取负）
    expect(res.x).toBeCloseTo(rawPt[0], 6);
    expect(res.y).toBeCloseTo(-rawPt[1], 6);

    const cosLat = Math.cos((gcjLat * Math.PI) / 180);
    const expectedScale = 1 / cosLat; // 北京约 1.304
    expect(res.meterInMercatorEast).toBeCloseTo(expectedScale, 2);
    expect(res.meterInMercatorNorth).toBeCloseTo(expectedScale, 2);
    expect(res.meterInMercatorEast).toBeLessThan(1.4); // 绝不做二次 ×1/cosφ（否则 > 1.65）

    // 高德 3D 世界（含 getCameraParams）整体在 EPSG:3857 米空间，垂直必须与水平同尺
    expect(res.meterInMercatorUp).toBeCloseTo(res.meterInMercatorEast, 6);
    expect(res.z).toBeCloseTo(100 * res.meterInMercatorEast, 4);

    // 逆算验证：lngLatFromWorld 传回原始 WGS84 坐标
    const [backLng, backLat] = adapter!.lngLatFromWorld(res.x, res.y);
    expect(backLng).toBeCloseTo(wgsLng, 5);
    expect(backLat).toBeCloseTo(wgsLat, 5);
  });

  it('直接传入 customCoords 对象时也能构造，差分异常时回退椭球解析尺度', () => {
    const brokenThenFixed = {
      calls: 0,
      lngLatToCoord([lng, lat]: [number, number]): [number, number] {
        this.calls++;
        if (this.calls > 1) throw new Error('mock diff error');
        return [lng * 1000, lat * 1000];
      },
    };
    const adapter = createAMapGeoAdapter(brokenThenFixed);
    expect(adapter).not.toBeNull();
    const res = adapter!.worldFromLngLat(116.4, 39.9, 50);
    const cosLat = Math.cos((39.9 * Math.PI) / 180);
    expect(res.meterInMercatorEast).toBeGreaterThan(1 / cosLat - 0.05);
    expect(res.meterInMercatorUp).toBeCloseTo(res.meterInMercatorEast, 6);
    expect(res.z).toBeCloseTo(50 * res.meterInMercatorUp, 4);
    expect(adapter!.lngLatFromWorld(1, 2)).toEqual([0, 0]);
  });
});
