/**
 * 单元测试：`S3MViewer` 上的三维空间分析入口（量算 / 通视 / 裁剪）。
 *
 * 内核数学已在 analysis-kernel.test.ts 钉住，这里只验「经纬度 ↔ 场景 ENU 换算
 * 是否把口径接对了」——这是最容易错的一环（y 轴取反、meterInMercator 尺度）。
 *
 * 不依赖 WebGL：`setClipping` 在没有 renderer 时只记配置，不影响断言。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';
import { lngLatFromMercator, mercatorFromLngLat } from '../../packages/s3m-three/src/render/GeoAdapter';
import type { LngLatAlt } from '../../packages/s3m-three/src/analysis/measure';

/** 锚点定在 (0,0)，赤道上 1 米对应的墨卡托尺度是常数，构造精确的 ENU 位移很方便 */
const ANCHOR = mercatorFromLngLat(0, 0);
const S = ANCHOR.meterInMercator;

/** 场景 ENU 米 → 经纬度（与 viewer 内部互逆，用来造测试数据） */
function at(ex: number, ey: number, altitude = 0): LngLatAlt {
  const [lng, lat] = lngLatFromMercator(ANCHOR.x + ex * S, ANCHOR.y - ey * S);
  return { lng, lat, altitude };
}

function makeViewer(): S3MViewer {
  const v = new S3MViewer({ canvas: null as never, container: null as never } as ConstructorParameters<
    typeof S3MViewer
  >[0]);
  v.sceneAnchor = { x: ANCHOR.x, y: ANCHOR.y, z: 0, meterInMercator: S };
  return v;
}

function registerMesh(viewer: S3MViewer, smid: number, size = 10): THREE.Mesh {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(size, size, size);
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: viewer.uniforms }));
  mesh.userData = { geoRef: { pickInfo: { [smid]: { batchId: 0 } } } };
  group.add(mesh);
  (viewer as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
    { group, tile: null },
    { id: 'd', root: new THREE.Group() }
  );
  return mesh;
}

/* ------------------------------------------------------------------ 量算 */

describe('S3MViewer 量算', () => {
  test('东向 100 米：三维距离与水平距离都是 100，高差 0', () => {
    const v = makeViewer();
    const r = v.measureDistance(at(0, 0), at(100, 0));
    expect(r.distance3D).toBeCloseTo(100, 1);
    expect(r.distanceHorizontal).toBeCloseTo(100, 1);
    expect(r.heightDiff).toBeCloseTo(0, 6);
    v.dispose();
  });

  test('纯高程差：水平距离 0，三维距离 = 高差', () => {
    const v = makeViewer();
    const r = v.measureDistance(at(0, 0, 10), at(0, 0, 40));
    expect(r.distanceHorizontal).toBeCloseTo(0, 6);
    expect(r.distance3D).toBeCloseTo(30, 4);
    expect(r.heightDiff).toBeCloseTo(30, 4);
    v.dispose();
  });

  test('折线：两段各 100 米，总长 200', () => {
    const v = makeViewer();
    const r = v.measurePolyline([at(0, 0), at(100, 0), at(200, 0)]);
    expect(r.length3D).toBeCloseTo(200, 1);
    expect(r.lengthHorizontal).toBeCloseTo(200, 1);
    v.dispose();
  });

  test('多边形：100×100 的方形，面积 10000，周长 400', () => {
    const v = makeViewer();
    const r = v.measurePolygon([at(0, 0), at(100, 0), at(100, 100), at(0, 100)]);
    expect(r.area3D).toBeCloseTo(10000, 0);
    expect(r.areaHorizontal).toBeCloseTo(10000, 0);
    expect(r.perimeter).toBeCloseTo(400, 1);
    v.dispose();
  });

  test('没有场景锚点时给 0 而不是抛错', () => {
    const v = new S3MViewer({ canvas: null as never, container: null as never } as ConstructorParameters<
      typeof S3MViewer
    >[0]);
    expect(() => v.measureDistance({ lng: 0, lat: 0, altitude: 0 }, { lng: 1, lat: 1, altitude: 0 })).not.toThrow();
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 通视 */

describe('S3MViewer 通视', () => {
  test('穿过 10×10×10 的盒子：在近端面处被挡', () => {
    const v = makeViewer();
    registerMesh(v, 950);
    const r = v.lineOfSight(at(-100, 0), at(100, 0));
    expect(r.visible).toBe(false);
    // 盒子中心在原点、边长 10，近端面在 x = -5
    expect(r.blockedDistance!).toBeCloseTo(95, 0);
    expect(r.visibleRatio).toBeCloseTo(0.475, 1);
    v.dispose();
  });

  test('从盒子上方掠过：通视', () => {
    const v = makeViewer();
    registerMesh(v, 951);
    const r = v.lineOfSight(at(-100, 0, 20), at(100, 0, 20));
    expect(r.visible).toBe(true);
    expect(r.blockedPoint).toBeNull();
    v.dispose();
  });

  test('终点在盒子另一侧、但视线绕开盒子：通视', () => {
    const v = makeViewer();
    registerMesh(v, 952);
    const r = v.lineOfSight(at(-100, 50), at(100, 50));
    expect(r.visible).toBe(true);
    v.dispose();
  });

  test('场景里没有几何时一律通视', () => {
    const v = makeViewer();
    const r = v.lineOfSight(at(-100, 0), at(100, 0));
    expect(r.visible).toBe(true);
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 裁剪 */

describe('S3MViewer 裁剪', () => {
  test('设置后能读回，传 null 清空', () => {
    const v = makeViewer();
    const opt = { type: 'box' as const, a: [0, 0, 0] as [number, number, number], b: [10, 10, 10] as [number, number, number] };
    v.setClipping(opt);
    expect(v.clipping).toEqual(opt);
    v.setClipping(null);
    expect(v.clipping).toBeNull();
    v.dispose();
  });

  test('没 mount（没有 renderer）时设置不抛错', () => {
    const v = makeViewer();
    expect(() => v.setClipping({ type: 'plane', normal: [0, 0, 1], point: [0, 0, 0] })).not.toThrow();
    v.dispose();
  });
});
