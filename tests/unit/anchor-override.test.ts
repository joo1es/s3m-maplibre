/**
 * 非地理坐标系数据集的锚点覆盖（issue: sculpture.scp 是纯局部米，旧实现把米当度）
 *
 * 官方 S3M 规范的 .scp 带 `crs`（epsg: / wkt:，见 Specification/scp.json.md:22），
 * `position.unit` 决定数值是 Degree 还是 Meter。超图官方样例里既有经纬度数据
 * （CBD / comModel），也有纯平面工程坐标（gaussianSplatting/sculpture.scp：
 * crs=epsg:0、unit=Meter、extensions.crs=Planar Coordinate System---m）。
 *
 * 库不做 EPSG 反算（没有 proj4 依赖，生产端负责投影），但至少要：
 *   1. 把 crs / unit 解析出来，让上层看得到；
 *   2. 非地理数据没给锚点时明确告警，不再静默把米当经纬度；
 *   3. 允许 App 用 `anchorOverride` 显式指定「这份局部米数据该摆在哪」。
 *
 * 覆盖口径是 opt-in：不传时 config 与 anchor 的解析路径与旧版逐字一致（不变式 ①）。
 */
import { describe, expect, test } from 'bun:test';
import {
  applyAnchorOverride,
  parseConfigText,
  readSpatialReference,
  resolveAnchor,
  usableGeoBounds,
  type AnchorOverride,
} from '../../packages/s3m-three/src/tileset/config.js';
import { normalizeDatasetOptions } from '../../packages/s3m-three/src/render/DatasetManager.js';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset.js';

/** 官方 gaussianSplatting/sculpture.scp 的关键字段（纯局部米，无经纬度） */
const PLANAR_SCP = {
  asset: 'SuperMap',
  version: '3.01',
  crs: 'epsg:0',
  dataType: 'GaussianSplatting3D',
  extensions: {
    's3m:FileType': 'PointCloudFile',
    crs:
      '<sml:CoordinateReferenceSystem>\r\n<sml:Name>Planar Coordinate System---m</sml:Name>\r\n' +
      '<sml:Type>0</sml:Type>\r\n<sml:Units>METER</sml:Units>\r\n</sml:CoordinateReferenceSystem>\r\n',
  },
  geoBounds: { bottom: 4.992952346801758, left: -3.01630973815918, right: -1.97561776638031, top: 6.15802001953125 },
  heightRange: { max: 679.276245, min: 678.567688 },
  position: { point3D: { x: -2.495963752269745, y: 5.575486183166504, z: 678.9219665527344 }, unit: 'Meter' },
  rootTiles: [{ url: './1.s3mb' }],
};

/** 官方 CBD/cbd.scp（crs 填 epsg:0 占位，但坐标其实是度） */
const GEO_SCP = {
  crs: 'epsg:0',
  geoBounds: { bottom: 39.90288464646415, left: 116.4444634480989, right: 116.4717575064941, top: 39.9217123559968 },
  position: { units: 'Degree', x: 116.4581104772965, y: 39.91229850123048, z: 0 },
  tiles: [{ url: './Tile.s3mb' }],
};

const BEIJING: AnchorOverride = { lon: 116.4581, lat: 39.9123, height: 0 };

describe('readSpatialReference —— crs / unit 解析', () => {
  test('平面米制样例：识别 Meter、epsg:0 与 extensions.crs 的 WKT', () => {
    const ref = readSpatialReference(PLANAR_SCP);
    expect(ref.crs).toBe('epsg:0');
    expect(ref.epsg).toBe(0);
    expect(ref.unit).toBe('Meter');
    expect(ref.isGeographic).toBe(false);
    expect(ref.wkt).toContain('Planar Coordinate System---m');
  });

  test('v3.01 的 unit 与老版 units 都要认（否则米会被当度）', () => {
    expect(readSpatialReference(GEO_SCP).unit).toBe('Degree');
    expect(readSpatialReference(GEO_SCP).isGeographic).toBe(true);
    expect(readSpatialReference({ position: { point3D: { x: 1, y: 2 }, unit: 'Meter' } }).unit).toBe('Meter');
  });

  test('epsg 码从 "epsg:4490" 这类前缀里抠出来；wkt 形式没有码', () => {
    expect(readSpatialReference({ crs: 'epsg:4490' }).epsg).toBe(4490);
    expect(readSpatialReference({ crs: 'wkt:PROJCS[...]' }).epsg).toBeNull();
    expect(readSpatialReference({ crs: 4326 }).crs).toBe('epsg:4326');
  });

  test('缺字段 / 脏值兜底：不抛错，且默认按地理数据看待', () => {
    expect(readSpatialReference({})).toMatchObject({ crs: null, epsg: null, unit: null, wkt: null, isGeographic: true });
    expect(readSpatialReference({ crs: null, position: null, extensions: 'bad' }).unit).toBeNull();
    expect(readSpatialReference({ crs: 'EPSG:3857' }).epsg).toBe(3857);
  });
});

describe('默认不生效 —— 不传 anchorOverride 时旧路径逐字不变', () => {
  test('平面米制数据的锚点仍是原始数值（这是旧行为，作为基线钉住）', () => {
    expect(resolveAnchor(PLANAR_SCP)).toEqual({
      lon: -2.495963752269745,
      lat: 5.575486183166504,
      height: 678.9219665527344,
    });
    expect(usableGeoBounds(PLANAR_SCP.geoBounds)).toBeTruthy();
  });

  test('经纬度数据的锚点不受影响', () => {
    expect(resolveAnchor(GEO_SCP)).toEqual({ lon: 116.4581104772965, lat: 39.91229850123048, height: 0 });
  });

  test('normalizeDatasetOptions 不带 anchorOverride 时不凭空造字段', () => {
    const [ds] = normalizeDatasetOptions({ configUrl: './CBD/cbd.scp' });
    expect(ds.anchorOverride).toBeUndefined();
  });
});

describe('applyAnchorOverride —— 锚点与 geoBounds 一起搬', () => {
  test('平面米数据：锚点换成指定经纬度，局部米跨度换算成度', () => {
    const out = applyAnchorOverride(PLANAR_SCP, BEIJING);
    const b = usableGeoBounds(out.geoBounds)!;

    expect(resolveAnchor(out)).toEqual({ lon: BEIJING.lon, lat: BEIJING.lat, height: 0 });
    // 结构不变量：框中心贴着新锚点，且仍是一张经纬度范围内的合法小框
    expect((b.left + b.right) / 2).toBeCloseTo(BEIJING.lon, 8);
    expect((b.bottom + b.top) / 2).toBeCloseTo(BEIJING.lat, 8);
    expect(b.right).toBeGreaterThan(b.left);
    expect(b.top).toBeGreaterThan(b.bottom);
    expect(Math.abs(b.left)).toBeLessThan(180);
    expect(Math.abs(b.top)).toBeLessThan(90);
    // 1 米跨度在纬度 39.9° 上约 1/(111320·cosφ) 度，不能出现「米当度」的整框
    expect(b.right - b.left).toBeLessThan(1e-4);
  });

  test('地理数据：按度平移，跨度保持度值而不是被当成米缩放', () => {
    const out = applyAnchorOverride(GEO_SCP, { lon: 120, lat: 30 });
    const b = usableGeoBounds(out.geoBounds)!;
    expect(b.right - b.left).toBeCloseTo(GEO_SCP.geoBounds.right - GEO_SCP.geoBounds.left, 10);
    expect(b.top - b.bottom).toBeCloseTo(GEO_SCP.geoBounds.top - GEO_SCP.geoBounds.bottom, 10);
    expect((b.left + b.right) / 2).toBeCloseTo(120, 8);
  });

  test('不修改入参（纯函数，App 拿到的原 config 还可用于诊断）', () => {
    const before = JSON.stringify(PLANAR_SCP.geoBounds);
    applyAnchorOverride(PLANAR_SCP, BEIJING);
    expect(JSON.stringify(PLANAR_SCP.geoBounds)).toBe(before);
  });

  test('geoBounds 缺失/退化时不编造范围，只换锚点', () => {
    const out = applyAnchorOverride({ position: { point3D: { x: 1, y: 2 }, unit: 'Meter' } }, BEIJING);
    expect(resolveAnchor(out)).toEqual({ lon: BEIJING.lon, lat: BEIJING.lat, height: 0 });
    expect(usableGeoBounds(out.geoBounds)).toBeNull();
  });

  test('XML 形态（units / x,y,z）也能覆盖', () => {
    const xml = parseConfigText(
      '<SuperMapCache><sml:Position><sml:X>116.4</sml:X><sml:Y>39.9</sml:Y><sml:Z>0</sml:Z>' +
        '</sml:Position><sml:BoundingBox><sml:MinX>-50</sml:MinX><sml:MaxX>50</sml:MaxX>' +
        '<sml:MinY>-50</sml:MinY><sml:MaxY>50</sml:MaxY></sml:BoundingBox>' +
        '<sml:FileName>./a.s3mb</sml:FileName></SuperMapCache>'
    );
    const out = applyAnchorOverride(xml, BEIJING);
    expect(resolveAnchor(out)).toEqual({ lon: BEIJING.lon, lat: BEIJING.lat, height: 0 });
    expect(usableGeoBounds(out.geoBounds)).toBeTruthy();
  });
});

describe('边界归一', () => {
  test('0 / 负数 / 缺省 height 都是合法锚点', () => {
    expect(resolveAnchor(applyAnchorOverride(PLANAR_SCP, { lon: 0, lat: 0 }))).toEqual({ lon: 0, lat: 0, height: 0 });
    expect(resolveAnchor(applyAnchorOverride(PLANAR_SCP, { lon: -73.9, lat: -33.4, height: -12 }))).toEqual({
      lon: -73.9,
      lat: -33.4,
      height: -12,
    });
  });

  test('NaN / Infinity / 超范围一律拒绝，不静默摆到 (0,0)', () => {
    for (const bad of [NaN, Infinity, -Infinity, 999, 'x']) {
      expect(() => applyAnchorOverride(PLANAR_SCP, { lon: bad as number, lat: 39.9 })).toThrow();
      expect(() => applyAnchorOverride(PLANAR_SCP, { lon: 116.4, lat: bad as number })).toThrow();
    }
    expect(() => applyAnchorOverride(PLANAR_SCP, { lon: 116.4, lat: 39.9, height: NaN })).toThrow();
  });

  test('height 非有限值以外的脏值按 0 处理不抛错', () => {
    const out = applyAnchorOverride(PLANAR_SCP, { lon: 116.4, lat: 39.9, height: undefined });
    expect(resolveAnchor(out).height).toBe(0);
  });
});

describe('选项透传', () => {
  test('单数据集简写：图层级 anchorOverride 要带到 dataset', () => {
    const [ds] = normalizeDatasetOptions({ configUrl: './sculpture.scp', anchorOverride: BEIJING });
    expect(ds.anchorOverride).toEqual(BEIJING);
  });

  test('多数据集：数据集自己的覆盖图层级默认', () => {
    const own = { lon: 121, lat: 31 };
    const list = normalizeDatasetOptions({
      datasets: [
        { id: 'a', configUrl: './a.scp' },
        { id: 'b', configUrl: './b.scp', anchorOverride: own },
      ],
      anchorOverride: BEIJING,
    });
    expect(list[0].anchorOverride).toBeUndefined();
    expect(list[1].anchorOverride).toEqual(own);
  });
});

describe('S3MTileset.init 集成 —— 官方 sculpture.scp 走完整链路', () => {
  const scpText = JSON.stringify(PLANAR_SCP);

  async function initWith(anchorOverride?: AnchorOverride) {
    const origFetch = globalThis.fetch;
    const origWarn = console.warn;
    const warns: string[] = [];
    globalThis.fetch = (async () => new Response(scpText)) as unknown as typeof fetch;
    console.warn = (...a: unknown[]) => {
      warns.push(String(a[0]));
    };
    try {
      const ts = new S3MTileset({
        configUrl: 'http://example.com/datas/sculpture.scp',
        anchorOverride,
        useWorker: false,
      });
      await ts.init();
      return { ts, warns };
    } finally {
      globalThis.fetch = origFetch;
      console.warn = origWarn;
    }
  }

  test('不传：锚点仍是米值，但明确告警而不是静默摆到大西洋', async () => {
    const { ts, warns } = await initWith();
    expect(ts.anchor).toEqual({
      lon: -2.495963752269745,
      lat: 5.575486183166504,
      height: 678.9219665527344,
    });
    expect(ts.spatialRef).toMatchObject({ crs: 'epsg:0', unit: 'Meter', isGeographic: false });
    expect(warns.some((w) => w.includes('anchorOverride'))).toBe(true);
  });

  test('传了：锚点 / geoBounds / spatialRef 一致，且不再告警', async () => {
    const { ts, warns } = await initWith(BEIJING);
    expect(ts.anchor).toEqual({ lon: 116.4581, lat: 39.9123, height: 0 });
    const b = usableGeoBounds(ts.config!.geoBounds)!;
    expect((b.left + b.right) / 2).toBeCloseTo(BEIJING.lon, 8);
    expect((b.bottom + b.top) / 2).toBeCloseTo(BEIJING.lat, 8);
    expect(ts.spatialRef).toMatchObject({ crs: 'epsg:0', unit: 'Meter', isGeographic: false });
    expect(ts.rootUrls[0]).toContain('1.s3mb');
    expect(warns.some((w) => w.includes('anchorOverride'))).toBe(false);
  });
});
