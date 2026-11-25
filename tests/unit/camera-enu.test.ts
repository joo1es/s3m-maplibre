/**
 * 相机 ENU 位置：MapLibre 5 没有 `getFreeCameraOptions`
 *
 * 背景（这条是既有 bug，不是某次改动引入的）：
 * `S3MLayer` 原来这样取相机位置 ——
 *
 *     const p = map.getFreeCameraOptions?.()?.position;
 *     camEnu = p ? [...] : [0, 0, 0];
 *
 * 但 maplibre-gl 5.24.0 里 `getFreeCameraOptions` 在 d.ts 和运行时都不存在
 * （`grep -c getFreeCameraOptions maplibre-gl.js` = 0），所以 `camEnu` **恒为 [0,0,0]**。
 *
 * 后果不是"LOD 精度差一点"，而是整条距离判据失效：
 *   - 每块瓦片的 dist 恒等于「它到数据集原点的距离」，随相机完全不变；
 *   - 拉远时 `_reclaimFarRoots` 判不出变化 → 不回收，材质一直留着；
 *   - 回收掉的瓦片下一帧又被判回"近处" → 立刻装回来，装卸互相抵消；
 *   - 细化判据同样恒定 → 缩到哪儿都在请求子瓦片。
 * 三条现象（永远精细 / 拉远没效果 / 一直加载）都指向同一个 0。
 *
 * 修法：从 `transform` 反算。maplibre 5 提供 `cameraToCenterDistance`（像素）、
 * `worldSize`、`center`、`pitch`、`bearing`，这是公开且稳定的。
 *
 *     metersPerPixel = 40075016.686 × cos(lat) / worldSize
 *     D              = cameraToCenterDistance × metersPerPixel     // 相机到地图中心的距离
 *     up             = centerEnu.z + D × cos(pitch)
 *     east           = centerEnu.x − D × sin(pitch) × sin(bearing)
 *     north          = centerEnu.y − D × sin(pitch) × cos(bearing)
 *
 * 相机在中心点的**反向**：bearing=0（朝北）时相机在南边，所以 north 是减。
 */
import { describe, expect, test } from 'bun:test';
import { cameraEnuFromDistance, resolveCameraEnu } from '../../packages/s3m-maplibre/src/cameraEnu';

const DEG = Math.PI / 180;
/** 赤道周长（Web Mercator 的基准） */
const EARTH_CIRCUMFERENCE = 40075016.686;

/** 北京 CBD 纬度、zoom 15 的 worldSize */
const LAT = 39.9123;
const WORLD_SIZE = 512 * 2 ** 15;
const METERS_PER_PIXEL = (EARTH_CIRCUMFERENCE * Math.cos(LAT * DEG)) / WORLD_SIZE;

describe('cameraEnuFromDistance', () => {
  test('pitch = 0：相机在中心正上方，水平偏移为 0', () => {
    const d = 1620; // 1080p、fov 36.9° 时的 cameraToCenterDistance 量级
    const enu = cameraEnuFromDistance({
      centerEnu: [0, 0, 0],
      cameraToCenterDistance: d,
      worldSize: WORLD_SIZE,
      latRad: LAT * DEG,
      pitchRad: 0,
      bearingRad: 0,
    });

    expect(enu[0]).toBeCloseTo(0, 6);
    expect(enu[1]).toBeCloseTo(0, 6);
    expect(enu[2]).toBeCloseTo(d * METERS_PER_PIXEL, 3);
  });

  test('pitch = 90°：高度归零，水平退到 D，bearing 0 时相机在南侧', () => {
    const d = 1000;
    const enu = cameraEnuFromDistance({
      centerEnu: [0, 0, 0],
      cameraToCenterDistance: d,
      worldSize: WORLD_SIZE,
      latRad: LAT * DEG,
      pitchRad: 90 * DEG,
      bearingRad: 0,
    });
    const D = d * METERS_PER_PIXEL;

    expect(enu[0]).toBeCloseTo(0, 3);
    expect(enu[1]).toBeCloseTo(-D, 3); // 朝北看 → 相机在南
    expect(enu[2]).toBeCloseTo(0, 3);
  });

  test('bearing = 90°（朝东看）：相机在西侧', () => {
    const d = 1000;
    const enu = cameraEnuFromDistance({
      centerEnu: [0, 0, 0],
      cameraToCenterDistance: d,
      worldSize: WORLD_SIZE,
      latRad: LAT * DEG,
      pitchRad: 45 * DEG,
      bearingRad: 90 * DEG,
    });
    const D = d * METERS_PER_PIXEL;
    const horiz = D * Math.sin(45 * DEG);

    expect(enu[0]).toBeCloseTo(-horiz, 3);
    expect(enu[1]).toBeCloseTo(0, 3);
    expect(enu[2]).toBeCloseTo(D * Math.cos(45 * DEG), 3);
  });

  test('地图中心不在锚点上时，结果叠加中心的 ENU 偏移', () => {
    const d = 1000;
    const enu = cameraEnuFromDistance({
      centerEnu: [500, -300, 20], // 中心在锚点东 500m、南 300m、高 20m
      cameraToCenterDistance: d,
      worldSize: WORLD_SIZE,
      latRad: LAT * DEG,
      pitchRad: 0,
      bearingRad: 0,
    });

    expect(enu[0]).toBeCloseTo(500, 6);
    expect(enu[1]).toBeCloseTo(-300, 6);
    expect(enu[2]).toBeCloseTo(20 + d * METERS_PER_PIXEL, 3);
  });

  test('量级校验：zoom 15、pitch 60° 时的相机高度落在 1~3km', () => {
    const enu = cameraEnuFromDistance({
      centerEnu: [0, 0, 0],
      cameraToCenterDistance: 1620,
      worldSize: WORLD_SIZE,
      latRad: LAT * DEG,
      pitchRad: 60 * DEG,
      bearingRad: 0,
    });

    expect(enu[2]).toBeGreaterThan(1000);
    expect(enu[2]).toBeLessThan(3000);
  });
});

/* ------------------------------------------------------------ 接线可测性 */

/** 1 米 = 多少墨卡托单位（东向），与 MapLibreGeoAdapter 的 sEast 同量级 */
const S_EAST = 1 / (2 * Math.PI * 6378137 * Math.cos(LAT * DEG));

describe('resolveCameraEnu', () => {
  test('transform 完整时给出非零相机位置（旧实现在这里恒为 [0,0,0]）', () => {
    const enu = resolveCameraEnu({
      transform: {
        cameraToCenterDistance: 1620,
        worldSize: WORLD_SIZE,
        center: { lng: 116.4581, lat: LAT },
        pitch: 60,
        bearing: 0,
      },
      anchor: { x: 0.3, y: 0.4 },
      sEast: S_EAST,
      sNorth: S_EAST * 1.3,
    });

    expect(enu).not.toBeNull();
    expect(Math.abs(enu![0]) + Math.abs(enu![1]) + Math.abs(enu![2])).toBeGreaterThan(100);
  });

  test('缺 cameraToCenterDistance / worldSize / center 时返回 null，由调用方退回原点', () => {
    const base = { anchor: { x: 0.3, y: 0.4 }, sEast: S_EAST, sNorth: S_EAST };
    const full = {
      cameraToCenterDistance: 1620,
      worldSize: WORLD_SIZE,
      center: { lng: 116.4581, lat: LAT },
      pitch: 60,
      bearing: 0,
    };

    expect(resolveCameraEnu({ ...base, transform: undefined })).toBeNull();
    expect(
      resolveCameraEnu({ ...base, transform: { ...full, cameraToCenterDistance: undefined } })
    ).toBeNull();
    expect(resolveCameraEnu({ ...base, transform: { ...full, worldSize: 0 } })).toBeNull();
    expect(resolveCameraEnu({ ...base, transform: { ...full, center: undefined } })).toBeNull();
  });

  test('比例尺为 0 时返回 null：宁可退回原点，也不要算出 NaN 距离', () => {
    expect(
      resolveCameraEnu({
        transform: {
          cameraToCenterDistance: 1620,
          worldSize: WORLD_SIZE,
          center: { lng: 116.4581, lat: LAT },
        },
        anchor: { x: 0.3, y: 0.4 },
        sEast: 0,
        sNorth: S_EAST,
      })
    ).toBeNull();
  });

  test('地图中心就压在锚点上时，水平偏移为 0、高度为 D', () => {
    const enu = resolveCameraEnu({
      transform: {
        cameraToCenterDistance: 1600,
        worldSize: WORLD_SIZE,
        center: { lng: 116.4581, lat: LAT },
        pitch: 0,
        bearing: 0,
      },
      anchor: { x: 0.5, y: 0.5 },
      sEast: S_EAST,
      sNorth: S_EAST,
      // 宿主 helper：中心世界坐标与锚点完全相同
      worldFromLngLat: () => ({ x: 0.5, y: 0.5 }),
    });

    expect(enu![0]).toBeCloseTo(0, 3);
    expect(enu![1]).toBeCloseTo(0, 3);
    expect(enu![2]).toBeGreaterThan(0);
  });
});
