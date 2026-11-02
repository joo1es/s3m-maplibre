/**
 * 单元测试：瓦片级放置（issue #12）。
 *
 * 背景：场景只有**一个**切平面，`_enuMatrix` 用场景锚点纬度的**常量**
 * `meterInMercator` 缩放整个场景。Web 墨卡托的比例随纬度变化，所以每块瓦片的
 * 真实尺度是 `s(瓦片中心纬度)` 而不是 `s(场景锚点纬度)`。
 *
 * 「真值」在这里独立构造：按球面 ENU 定义（1 米 = 1/R 弧度，与
 * `mercatorFromLngLat` 的口径一致）把 ENU 偏移换成经纬度，再走真实墨卡托投影。
 * 它不依赖被测代码的中间量（不乘任何「锚点尺度常量」），所以能区分
 * 「逐顶点精确投影」与「整场景线性缩放」。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { mercatorFromLngLat } from '../../packages/s3m-three/src/render/GeoAdapter';
import { computeTilePlacement } from '../../packages/s3m-three/src/render/tilePlacement';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

/* ---------------------------------------------------------------- 参考 */

const R = 6378137;
const DEG = Math.PI / 180;

const ANCHOR = { lon: 116, lat: 40, height: 0 };
const SCENE = mercatorFromLngLat(ANCHOR.lon, ANCHOR.lat, ANCHOR.height);
const S_SCENE = SCENE.meterInMercator;

/** 球面 ENU → 真实墨卡托（真值：逐个顶点独立投影，不做任何线性缩放） */
function truthMercator(east: number, north: number, up = 0): { x: number; y: number } {
  const latRad = ANCHOR.lat * DEG + north / R;
  const lon = ANCHOR.lon + east / (R * Math.cos(latRad)) / DEG;
  const w = mercatorFromLngLat(lon, latRad / DEG, ANCHOR.height + up);
  return { x: w.x, y: w.y };
}

/** 墨卡托坐标差 → 地面米数（用目标点纬度的尺度还原） */
function mercErrorMetres(got: { x: number; y: number }, want: { x: number; y: number }): number {
  const latOfWant = (Math.atan(Math.sinh(Math.PI * (1 - 2 * want.y))) * 180) / Math.PI;
  const s = mercatorFromLngLat(0, latOfWant).meterInMercator;
  return Math.hypot(got.x - want.x, got.y - want.y) / s;
}

/** 当前实现口径：整个场景共用一个常量 s */
function placeLinear(east: number, north: number, offset: readonly [number, number, number] = [0, 0, 0]) {
  return {
    x: SCENE.x + S_SCENE * (east + offset[0]),
    y: SCENE.y - S_SCENE * (north + offset[1]),
  };
}

/** 把 computeTilePlacement 的结果套到某个顶点上，回到墨卡托 */
function placeWith(p: { position: readonly number[]; pivot: readonly number[]; scale: number }, east: number, north: number) {
  const x = p.position[0] + p.scale * (east - p.pivot[0]);
  const y = p.position[1] + p.scale * (north - p.pivot[1]);
  return { x: SCENE.x + S_SCENE * x, y: SCENE.y - S_SCENE * y };
}

function placementAt(center: { x: number; y: number; z: number }, offset: readonly [number, number, number] = [0, 0, 0]) {
  return computeTilePlacement({
    center,
    datasetAnchor: ANCHOR,
    sceneAnchor: { x: SCENE.x, y: SCENE.y, z: SCENE.z, meterInMercator: S_SCENE },
    datasetOffset: offset,
    geo: null,
  });
}

/* ---------------------------------------------------------------- 用例 */

describe('issue #12：单锚点切平面的尺度误差', () => {
  test('当前实现：20 km 外的偏差在 20 m 量级（bug 确实存在）', () => {
    const err = mercErrorMetres(placeLinear(0, 20000), truthMercator(0, 20000));
    // 表征测试：钉住旧口径的误差量级。修复不改变旧口径，所以这条改前改后都成立。
    expect(err).toBeGreaterThan(15);
    expect(err).toBeLessThan(100);
  });

  test('瓦片级放置：中心精确落位（< 0.01 m）', () => {
    const p = placementAt({ x: 0, y: 20000, z: 0 })!;
    expect(p).not.toBeNull();
    expect(mercErrorMetres(placeWith(p, 0, 20000), truthMercator(0, 20000))).toBeLessThan(0.01);
  });

  test('瓦片级放置：距中心 2 km 的顶点误差 < 1 m（旧口径 26 m 量级）', () => {
    // 顶点取在中心东北，同时踩到纬度变化与经度变化
    const center = { x: 0, y: 20000, z: 0 };
    const vEast = 2000;
    const vNorth = 22000;

    const p = placementAt(center)!;
    const got = placeWith(p, vEast, vNorth);
    const want = truthMercator(vEast, vNorth);

    const oldErr = mercErrorMetres(placeLinear(vEast, vNorth), want);
    const newErr = mercErrorMetres(got, want);

    expect(oldErr).toBeGreaterThan(20);
    expect(newErr).toBeLessThan(1);
  });

  test('缩放系数：锚点处为 1，向北单调增大', () => {
    const near = placementAt({ x: 0, y: 0, z: 0 })!;
    const far = placementAt({ x: 0, y: 20000, z: 0 })!;

    expect(near.scale).toBeCloseTo(1, 9);
    expect(far.scale).toBeGreaterThan(near.scale);
    // 北纬 40° 走 20 km：k = cos φ₀ / cos(φ₀+Δφ) ≈ 1 + tan φ₀·Δφ ≈ 1.0026
    expect(far.scale).toBeGreaterThan(1.002);
    expect(far.scale).toBeLessThan(1.0032);

    const south = placementAt({ x: 0, y: -20000, z: 0 })!;
    expect(south.scale).toBeLessThan(1);
  });

  test('枢轴落在数据集锚点上时退化为恒等', () => {
    const p = placementAt({ x: 0, y: 0, z: 0 })!;
    expect(p.scale).toBeCloseTo(1, 9);
    expect(p.position[0]).toBeCloseTo(0, 6);
    expect(p.position[1]).toBeCloseTo(0, 6);
    expect(p.position[2]).toBeCloseTo(0, 6);
  });

  test('父级偏移从 position 里扣掉（root 会再加回来）', () => {
    const p = placementAt({ x: 0, y: 0, z: 0 }, [500, -300, 20])!;
    expect(p.position[0]).toBeCloseTo(-500, 6);
    expect(p.position[1]).toBeCloseTo(300, 6);
  });

  test('异常输入返回 null（不把瓦片甩到别处）', () => {
    expect(
      computeTilePlacement({
        center: { x: 0, y: 0, z: 0 },
        datasetAnchor: ANCHOR,
        sceneAnchor: { x: 0, y: 0, z: 0, meterInMercator: 0 },
        datasetOffset: [0, 0, 0],
        geo: null,
      }),
    ).toBeNull();
    expect(placementAt({ x: NaN, y: 0, z: 0 })).toBeNull();
  });
});

/**
 * 已知残差（不在本 issue 范围）。
 *
 * `meterInMercator` 用的是**球面**半径 R = 6378137，而真实地面米在东向上对应的是
 * 椭球的卯酉圈半径 N(φ) ≈ 6387 km（40°）。R/N ≈ 0.9986，于是仍有约 0.14% 的系统性
 * 比例误差——2 km 处约 2.8 m。
 *
 * 这条影响面覆盖放置、拾取、量算，属于「球面 vs 椭球」的建模口径问题，修它要动
 * `GeoAdapter` 的语义，会整体平移所有既有场景，所以单独跟踪。
 * 这里只把量级钉住，防止有人以为 PER-TILE 已经把精度做满了。
 */
describe('issue #12：已知残差（球面 vs 椭球，另行跟踪）', () => {
  const E2 = 6.69437999014e-3;
  const N = R / Math.sqrt(1 - E2 * Math.sin(40 * DEG) ** 2);

  test('东向 2 km 仍有约 0.14% 的比例误差（≈ 2.8 m）', () => {
    const p = placementAt({ x: 0, y: 0, z: 0 })!;
    // 球面口径下完全精确
    expect(mercErrorMetres(placeWith(p, 2000, 0), truthMercator(2000, 0))).toBeLessThan(0.01);

    // 椭球口径下的真实东向位置
    const lonEllip = ANCHOR.lon + 2000 / (N * Math.cos(40 * DEG)) / DEG;
    const wantEllip = mercatorFromLngLat(lonEllip, 40);
    const got = placeWith(p, 2000, 0);
    const err = mercErrorMetres(got, wantEllip);

    expect(err).toBeGreaterThan(2.5);
    expect(err).toBeLessThan(3.2);
  });
});

describe('issue #15 / #12：perTilePlacement 默认启用与回退开关', () => {
  function makeViewer(perTilePlacement?: boolean): S3MViewer {
    const v = new S3MViewer({
      canvas: null as never,
      container: null as never,
      perTilePlacement,
    } as ConstructorParameters<typeof S3MViewer>[0]);
    v.sceneAnchor = { x: SCENE.x, y: SCENE.y, z: SCENE.z, meterInMercator: S_SCENE };
    return v;
  }

  function register(
    v: S3MViewer,
    sphere: { center: { x: number; y: number; z: number }; radius: number } | null,
    anchor: { lon: number; lat: number; height: number } | null = ANCHOR,
  ): { group: THREE.Group; entry: { id: string; root: THREE.Group; anchor: unknown; offset: number[] } } {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial()));
    // 走真实的 DatasetManager 注册，`_reapplyTilePlacements` 才遍历得到
    const entry = (
      v as unknown as { _datasetManager: { registerDataset: (o: { id: string }) => unknown } }
    )._datasetManager.registerDataset({ id: 'd' }) as {
      id: string;
      root: THREE.Group;
      anchor: unknown;
      offset: number[];
    };
    entry.anchor = anchor;
    entry.offset = [0, 0, 0];
    (v as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
      { group, tile: null, sphere },
      entry,
    );
    return { group, entry };
  }

    test('不传 perTilePlacement（默认开）：等价于 true，自动启用瓦片级放置并缓存逆矩阵', () => {
    const v = makeViewer();
    const center = { x: 0, y: 20000, z: 0 };
    const { group: g } = register(v, { center, radius: 100 });
    expect(g.matrixAutoUpdate).toBe(false);
    expect(g.matrix.equals(new THREE.Matrix4())).toBe(false);
    expect(g.userData.tileCenter).toEqual(center);

    // 逆矩阵缓存验证
    const inv = g.userData.placementInverse as THREE.Matrix4 | undefined;
    expect(inv).toBeDefined();
    const product = new THREE.Matrix4().multiplyMatrices(inv!, g.matrix);
    expect(product.elements[0]).toBeCloseTo(1, 5);
    expect(product.elements[5]).toBeCloseTo(1, 5);
    expect(product.elements[10]).toBeCloseTo(1, 5);
    expect(product.elements[15]).toBeCloseTo(1, 5);
    v.dispose();
  });

  test('显式传 perTilePlacement: false（回退旧行为）：矩阵保持单位，matrixAutoUpdate 仍为 true', () => {
    const v = makeViewer(false);
    const { group: g } = register(v, { center: { x: 0, y: 20000, z: 0 }, radius: 100 });
    expect(g.matrixAutoUpdate).toBe(true);
    expect(g.matrix.equals(new THREE.Matrix4())).toBe(true);
    expect(g.position.y).toBe(0);
    expect(g.userData.tileCenter).toBeUndefined();
    expect(g.userData.placementInverse).toBeUndefined();
    v.dispose();
  });

  test('开启后：矩阵 = T(position)·S(k)·T(-pivot)，枢轴精确落位', () => {
    const v = makeViewer(true);
    const center = { x: 0, y: 20000, z: 0 };
    const { group: g } = register(v, { center, radius: 100 });
    expect(g.matrixAutoUpdate).toBe(false);
    expect(g.matrix.equals(new THREE.Matrix4())).toBe(false);

    const p = placementAt(center)!;
    const landed = new THREE.Vector3(center.x, center.y, center.z).applyMatrix4(g.matrix);
    expect(landed.x).toBeCloseTo(p.position[0], 6);
    expect(landed.y).toBeCloseTo(p.position[1], 6);
    expect(landed.z).toBeCloseTo(p.position[2], 6);

    const e = g.matrix.elements;
    expect(e[0]).toBeCloseTo(p.scale, 9);
    expect(e[5]).toBeCloseTo(p.scale, 9);
    expect(e[10]).toBeCloseTo(p.scale, 9);
    v.dispose();
  });

  test('没有包围球 / 没有数据集锚点时不动矩阵', () => {
    const v = makeViewer(true);
    expect(register(v, null).group.matrixAutoUpdate).toBe(true);
    expect(
      register(v, { center: { x: 0, y: 20000, z: 0 }, radius: 1 }, null).group.matrixAutoUpdate,
    ).toBe(true);
    v.dispose();
  });

  test('重锚点后已注册瓦片会重算（k 随场景锚点变化）', () => {
    const v = makeViewer(true);
    const center = { x: 0, y: 20000, z: 0 };
    const { group: g } = register(v, { center, radius: 100 });
    const before = g.matrix.elements[0];
    expect(before).toBeGreaterThan(1);

    // 把场景锚点挪到瓦片中心所在的纬线上：k 应回到 1
    const SCENE2 = mercatorFromLngLat(ANCHOR.lon, 40.18, 0);
    v.sceneAnchor = {
      x: SCENE2.x,
      y: SCENE2.y,
      z: SCENE2.z,
      meterInMercator: SCENE2.meterInMercator,
    };
    (v as unknown as { _reapplyTilePlacements: () => void })._reapplyTilePlacements();

    expect(g.matrix.elements[0]).toBeCloseTo(1, 3);
    v.dispose();
  });
  test('重锚点后已注册瓦片的逆矩阵缓存同步刷新', () => {
    const v = makeViewer();
    const center = { x: 0, y: 20000, z: 0 };
    const { group: g } = register(v, { center, radius: 100 });
    const inv1 = (g.userData.placementInverse as THREE.Matrix4).clone();

    const SCENE2 = mercatorFromLngLat(ANCHOR.lon, 40.18, 0);
    v.sceneAnchor = {
      x: SCENE2.x,
      y: SCENE2.y,
      z: SCENE2.z,
      meterInMercator: SCENE2.meterInMercator,
    };
    (v as unknown as { _reapplyTilePlacements: () => void })._reapplyTilePlacements();

    const inv2 = g.userData.placementInverse as THREE.Matrix4;
    expect(inv2.equals(inv1)).toBe(false);
    const product = new THREE.Matrix4().multiplyMatrices(inv2, g.matrix);
    expect(product.elements[0]).toBeCloseTo(1, 5);
    v.dispose();
  });

  test('城市级大规模瓦片（2000 块）重锚点更新耗时 < 15ms', () => {
    const v = makeViewer();
    for (let i = 0; i < 2000; i++) {
      register(v, { center: { x: (i % 50) * 100, y: 20000 + Math.floor(i / 50) * 100, z: 0 }, radius: 50 });
    }
    const SCENE2 = mercatorFromLngLat(ANCHOR.lon, 40.05, 0);
    v.sceneAnchor = {
      x: SCENE2.x,
      y: SCENE2.y,
      z: SCENE2.z,
      meterInMercator: SCENE2.meterInMercator,
    };

    const t0 = performance.now();
    (v as unknown as { _reapplyTilePlacements: () => void })._reapplyTilePlacements();
    const elapsed = performance.now() - t0;

    // 2000 块瓦片必须在 15ms 内完成（实测通常在 1~3ms），无需拆帧阻塞渲染
    expect(elapsed).toBeLessThan(15);
    v.dispose();
  });

});

/**
 * 拾取反解：命中点的世界坐标要还原成「数据本身的 ENU」。
 *
 * 开启瓦片级放置后几何是缩放过的，如果拾取直接拿世界坐标算经纬度，同一个屋顶
 * 在 20 km 外就会比 1 km 内偏出几米——渲染对了、拾取反而错了。
 */
describe('issue #12：拾取反解瓦片级放置', () => {
  const OFFSET: [number, number, number] = [500, -300, 20];

  function setup(perTilePlacement?: boolean) {
    const v = new S3MViewer({
      canvas: null as never,
      container: null as never,
      perTilePlacement,
    } as ConstructorParameters<typeof S3MViewer>[0]);
    v.sceneAnchor = { x: SCENE.x, y: SCENE.y, z: SCENE.z, meterInMercator: S_SCENE };

    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial());
    group.add(mesh);
    const entry = (
      v as unknown as { _datasetManager: { registerDataset: (o: { id: string }) => unknown } }
    )._datasetManager.registerDataset({ id: 'pick' }) as {
      root: THREE.Group;
      anchor: unknown;
      offset: number[];
    };
    entry.anchor = ANCHOR;
    entry.offset = [...OFFSET];
    entry.root.position.set(OFFSET[0], OFFSET[1], OFFSET[2]);

    (v as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
      { group, tile: null, sphere: { center: { x: 0, y: 20000, z: 0 }, radius: 100 } },
      entry,
    );

    const toCanonical = (p: THREE.Vector3) =>
      (
        v as unknown as { _toCanonicalScene: (p: THREE.Vector3, m: THREE.Object3D) => THREE.Vector3 }
      )._toCanonicalScene(p, mesh);
    return { v, group, mesh, toCanonical };
  }

    test('显式传 false 关闭时原样返回同一个对象（零运算、零分配）', () => {
    const { v, toCanonical } = setup(false);
    const p = new THREE.Vector3(1, 2, 3);
    expect(toCanonical(p)).toBe(p);
    v.dispose();
  });

  test('不传 perTilePlacement（默认开）：走常态反解路径，复用 placementInverse 缓存', () => {
    const { v, group, toCanonical } = setup();
    expect(group.userData.placementInverse).toBeDefined();

    const local = new THREE.Vector3(800, 20600, 5);
    const world = local.clone().applyMatrix4(group.matrix).add(new THREE.Vector3(...OFFSET));
    const canonical = toCanonical(world);
    expect(canonical.x).toBeCloseTo(local.x + OFFSET[0], 6);
    expect(canonical.y).toBeCloseTo(local.y + OFFSET[1], 6);
    expect(canonical.z).toBeCloseTo(local.z + OFFSET[2], 6);
    v.dispose();
  });

  test('开启后：世界坐标 → 数据集 ENU → 规范场景 ENU，精确可逆', () => {
    const { v, group, toCanonical } = setup(true);

    // 取一个瓦片局部（数据集 ENU）点，算出它在世界里被画到哪
    const local = new THREE.Vector3(800, 20600, 5);
    const world = local.clone().applyMatrix4(group.matrix).add(new THREE.Vector3(...OFFSET));

    // 反解应回到 local + OFFSET
    const canonical = toCanonical(world);
    expect(canonical.x).toBeCloseTo(local.x + OFFSET[0], 6);
    expect(canonical.y).toBeCloseTo(local.y + OFFSET[1], 6);
    expect(canonical.z).toBeCloseTo(local.z + OFFSET[2], 6);

    // 距中心 1 km 处，修正量应在米级（旧口径下这段偏差会直接进到报出的经纬度里）
    expect(canonical.distanceTo(world)).toBeGreaterThan(2);
    v.dispose();
  });

  test('瓦片中心处反解结果不动（放置的枢轴点本来就在正确位置）', () => {
    const { v, group, toCanonical } = setup(true);
    const centerLocal = new THREE.Vector3(0, 20000, 0);
    const world = centerLocal.clone().applyMatrix4(group.matrix).add(new THREE.Vector3(...OFFSET));
    const canonical = toCanonical(world);
    expect(canonical.x).toBeCloseTo(centerLocal.x + OFFSET[0], 6);
    expect(canonical.y).toBeCloseTo(centerLocal.y + OFFSET[1], 6);
    v.dispose();
  });

  test('网格不在已放置的瓦片里时原样返回', () => {
    const { v, toCanonical, mesh } = setup(true);
    // 换一个没有 tileCenter 的父级
    const orphan = new THREE.Group();
    orphan.add(mesh);
    const p = new THREE.Vector3(1, 2, 3);
    expect(toCanonical(p)).toBe(p);
    v.dispose();
  });
});
