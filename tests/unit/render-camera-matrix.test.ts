/**
 * 单元测试：渲染矩阵里不能有第二份视图变换
 *
 * ## 背景（实测）
 *
 * `renderFrame()` 里 `camera.projectionMatrix` 被换成了**完整**的 `MVP · ENU`，
 * 也就是 world→clip 已经含了视图分量。所以 three 渲染时的
 * `modelViewMatrix = camera.matrixWorldInverse × object.matrixWorld`
 * 必须只承担「物体自身的模型变换」——`matrixWorldInverse` 只能是单位矩阵。
 *
 * 旧实现把 `camera.matrixWorld` 设成 `T(camEnu)`、`matrixWorldInverse` 设成
 * `T(−camEnu)`，于是渲染多乘了一次视图：
 *
 *     gl_Position = MVP·ENU · T(−camEnu) · v     // 模型整体被平移 −camEnu（ENU 米）
 *
 * 这在 `camEnu ≈ 0` 的宿主（MapLibre 拿不到 FreeCameraOptions）上恰好是单位矩阵，
 * 所以长期没暴露；Mapbox 能给出真实相机位置（实测 camEnu = [788, −1686, 1567] m），
 * 模型当场被推出画面（按 0.627 px/m 约 1167 px 水平 + 竖向偏移）。
 *
 * 同一份 `matrixWorldInverse` 还被 `GeometryBuilder` 的注释（#36）拿来解释
 * 「three 自算视锥整体平移了相机到锚点的距离」——那是同一个 bug 的另一面。
 */
import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer.js';
import { mercatorFromLngLat } from '../../packages/s3m-three/src/render/GeoAdapter.js';

/** 只够 `renderFrame()` 跑通的最小内核（与 geo-adapter-ellipsoid 验收 5 同款 stub） */
function makeViewer(): S3MViewer {
  const v = new S3MViewer({
    canvas: null as never,
    container: null as never,
  } as ConstructorParameters<typeof S3MViewer>[0]);
  const self = v as unknown as Record<string, unknown>;
  self.canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 };
  self.camera = new THREE.PerspectiveCamera();
  self.renderer = {
    getContext: () => ({ isContextLost: () => false }),
    setViewport: () => {},
    resetState: () => {},
    render: () => {},
  };
  const a = mercatorFromLngLat(116.4581, 39.9123, 0);
  v.sceneAnchor = {
    x: a.x,
    y: a.y,
    z: a.z,
    meterInMercatorEast: a.meterInMercatorEast,
    meterInMercatorNorth: a.meterInMercatorNorth,
    meterInMercator: a.meterInMercator,
    altitude: 0,
  };
  return v;
}

const frame = (v: S3MViewer, cameraEnu: [number, number, number]): void => {
  v.renderFrame({
    mvp: new THREE.Matrix4().identity().elements,
    cameraEnu,
    fovRad: 0.6435011087932844,
    canvasHeight: 100,
  });
};

describe('渲染矩阵不含第二份视图变换', () => {
  it('camEnu 非零时 matrixWorld / matrixWorldInverse 仍是单位矩阵', () => {
    const v = makeViewer();
    // 实测的 Mapbox 值
    frame(v, [788.3795761218064, -1685.7554062628376, 1567.0896664708912]);

    const world = v.camera.matrixWorld.elements;
    const inv = v.camera.matrixWorldInverse.elements;
    for (const i of [12, 13, 14]) {
      expect(world[i]).toBe(0); // 不能把相机位置写进 matrixWorld
      expect(inv[i]).toBe(0); // 更不能让 T(−camEnu) 参与 modelViewMatrix
    }
    expect(inv[0]).toBe(1);
    expect(inv[5]).toBe(1);
    expect(inv[10]).toBe(1);
    v.dispose();
  });

  it('camEnu 不影响 world→clip：两个不同机位的投影结果逐位相同', () => {
    const project = (camEnu: [number, number, number]): number[] => {
      const v = makeViewer();
      frame(v, camEnu);
      // three 的渲染口径：projectionMatrix × matrixWorldInverse × (模型矩阵)
      const m = new THREE.Matrix4()
        .multiplyMatrices(v.camera.projectionMatrix, v.camera.matrixWorldInverse)
        .multiply(new THREE.Matrix4().makeTranslation(0, 0, 50));
      const out = [0, 0, 50, 1].map((_, row) => m.elements[row]! * 0 + m.elements[row + 4]! * 0 + m.elements[row + 8]! * 50 + m.elements[row + 12]!);
      v.dispose();
      return out;
    };

    const a = project([0, 0, 0]);
    const b = project([788.3795761218064, -1685.7554062628376, 1567.0896664708912]);
    for (let i = 0; i < 4; i++) expect(b[i]).toBeCloseTo(a[i]!, 9);
  });
});
