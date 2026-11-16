/**
 * `S3MViewer` 上两块"没有测试"的运行时行为：
 *
 *   1. `setEnvironment` —— 新公开 API（`S3MLayer.setEnvironment` 直接转发）。
 *      PMREM 那一半需要真实 WebGL，这里只钉不依赖 GPU 的三条路径：
 *      未 mount 静默返回、`null` 关闭并释放旧 RT、反复关闭不炸。
 *
 *   2. `_sortSplats` 的**跳过条件** —— 相机没动时必须整帧不重排。
 *      这是性能开关：跳过失效不会报错，只会悄悄把每帧排序的代价加回来。
 *      用 `BufferAttribute.version` 观察是否真的写了 attribute（`needsUpdate`
 *      会自增 version），不需要 mock 模块导出。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

/* ------------------------------------------------------------ setEnvironment */

describe('setEnvironment', () => {
  test('未 mount（没有 renderer）时静默返回，不抛错也不加载纹理', async () => {
    const v = new S3MViewer();
    expect(v.renderer).toBeNull();
    await expect(v.setEnvironment('https://example.com/env.jpg')).resolves.toBeUndefined();
    expect(v.scene?.environment ?? null).toBeNull();
  });

  test('传 null 关闭：清掉 scene.environment 并释放旧 RT', async () => {
    const v = new S3MViewer();
    // 只测关闭路径，renderer 只当"已 mount"的标记
    (v as unknown as { renderer: unknown }).renderer = {};

    const fakeTex = new THREE.Texture();
    v.scene!.environment = fakeTex;
    let disposed = 0;
    const rt = { dispose: () => void disposed++, texture: fakeTex };
    const rig = (v as unknown as { _lights: { envRT: unknown } })._lights;
    rig.envRT = rt;

    await v.setEnvironment(null);
    expect(v.scene!.environment).toBeNull();
    expect(disposed).toBe(1);
    expect(rig.envRT).toBeNull();
  });

  test('反复传 null 不炸（没有旧 RT 时什么都不做）', async () => {
    const v = new S3MViewer();
    (v as unknown as { renderer: unknown }).renderer = {};
    await v.setEnvironment(null);
    await v.setEnvironment(null);
    expect(v.scene!.environment).toBeNull();
  });

  test('强度会被夹到非负（负值不会把环境压成反向光照）', async () => {
    const v = new S3MViewer();
    (v as unknown as { renderer: unknown }).renderer = {};
    await v.setEnvironment(null, -3);
    expect(v.scene!.environmentIntensity).toBe(0);
    await v.setEnvironment(null, 2.5);
    expect(v.scene!.environmentIntensity).toBe(2.5);
  });
});

/* ------------------------------------------------------------ 泼溅排序跳过 */

function makeSplatPoints(zs: number[]): THREE.Points {
  const geo = new THREE.InstancedBufferGeometry();
  geo.instanceCount = zs.length;
  const centers = new Float32Array(zs.length * 3);
  zs.forEach((z, i) => {
    centers[i * 3] = 0;
    centers[i * 3 + 1] = 0;
    centers[i * 3 + 2] = z;
  });
  geo.setAttribute('iCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(zs.length * 3).fill(0.1), 3));
  geo.setAttribute('iQuat', new THREE.InstancedBufferAttribute(new Float32Array(zs.length * 4).fill(0), 4));
  geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(zs.length * 4).fill(1), 4));
  const points = new THREE.Points(geo, new THREE.PointsMaterial());
  (points.userData as { isGaussianSplat?: boolean }).isGaussianSplat = true;
  return points;
}

const centerOf = (p: THREE.Points) =>
  (p.geometry as THREE.InstancedBufferGeometry).getAttribute('iCenter') as THREE.InstancedBufferAttribute;

describe('_sortSplats 的跳过条件', () => {
  const setup = () => {
    const v = new S3MViewer();
    const cam = new THREE.PerspectiveCamera();
    (v as unknown as { camera: THREE.Camera }).camera = cam;
    // 逆序深度：第一次排序一定会重写 attribute
    const points = makeSplatPoints([3, 2, 1, 0]);
    (v as unknown as { _pointClouds: Set<THREE.Points> })._pointClouds.add(points);
    const sort = () => (v as unknown as { _sortSplats: () => void })._sortSplats();
    return { v, cam, points, sort };
  };

  test('相机不动时第二次调用不重写 attribute（整帧跳过）', () => {
    const { points, sort } = setup();
    const attr = centerOf(points);

    sort();
    expect(attr.version).toBeGreaterThan(0); // 第一次真的排了
    const afterFirst = attr.version;

    sort();
    sort();
    expect(attr.version).toBe(afterFirst); // 相机没动 → 一次都没重写
  });

  // 排序键只取 view 的第 3 行（`splatDepthOrder`），而内核里 view 只有平移：
  // 对每个点同加一个常数不改变顺序，所以「纯平移」在数学上不可能改变 back-to-front 次序。
  // 这条不是可选项而是事实：真实的相机姿态（pitch/bearing）全在宿主 MVP 里，
  // 要让泼溅按真实视深排序，得把宿主 view 矩阵单独喂进 `SplatLayer.sort()`。
  test('沿任意方向平移相机都不改变深度顺序（纯平移不重写 attribute）', () => {
    const { cam, points, sort } = setup();
    const attr = centerOf(points);
    sort();
    const afterFirst = attr.version;

    cam.position.set(100, 200, 100);
    sort();
    expect(attr.version).toBe(afterFirst);
  });

  test('非泼溅点云不参与排序（isGaussianSplat 未标记时直接跳过）', () => {
    const { points, sort } = setup();
    (points.userData as { isGaussianSplat?: boolean }).isGaussianSplat = false;
    const attr = centerOf(points);
    sort();
    expect(attr.version).toBe(0);
  });
});
