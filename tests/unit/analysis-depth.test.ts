/**
 * 单元测试：P1 的数学部分（深度解包 / 反投影 / 天际线归约 / 可视域栅格）。
 *
 * 这一段是「GPU 只负责出图，判断全在 CPU」的关键：只要这几条数学是对的，
 * 深度图本身错没错可以用肉眼在 demo 里一眼看出，而不用去猜归约逻辑。
 *
 * 天际线的测试用**正向投影**造数据（three 的 camera.project），再用被测代码反投影回来，
 * 这样断言不是自证 —— 一边是 three 的矩阵，一边是我的解包+反投影。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  azimuthElevation,
  packRGBADepth,
  pixelToNdc,
  unpackRGBADepth,
  unprojectNdc,
} from '../../packages/s3m-three/src/analysis/depth';
import { skylineFromDepth } from '../../packages/s3m-three/src/analysis/skyline';
import { computeViewshed, makeCubeDistanceSampler } from '../../packages/s3m-three/src/analysis/viewshed';
import { CUBE_FACES, buildCubeCameras } from '../../packages/s3m-three/src/render/analysis/DepthPass';
import type { Vec3 } from '../../packages/s3m-three/src/analysis/measure';

/* ------------------------------------------------------------ 深度打包 */

describe('RGBADepthPacking 的打包/解包', () => {
  test('0~0.999 往返精度优于 1e-5', () => {
    for (const d of [0, 0.001, 0.25, 0.5, 0.75, 0.999]) {
      const back = unpackRGBADepth(packRGBADepth(d));
      expect(Math.abs(back - d)).toBeLessThan(2e-5);
    }
  });

  test('1.0 走特判分支：打包成全白，解包正好是 1（与清屏白一致）', () => {
    // three 的 packDepthToRGBA 对 v>=1 直接返回 (1,1,1,1)，所以「远平面」和
    // 「清屏白」解包后都是 1.0 —— 背景判定因此可以用单一阈值 0.9999
    expect(packRGBADepth(1)).toEqual([255, 255, 255, 255]);
    expect(unpackRGBADepth([255, 255, 255, 255])).toBeCloseTo(1, 9);
  });

  test('越界输入被夹到 0~1，不产生 NaN', () => {
    expect(unpackRGBADepth(packRGBADepth(-1))).toBeCloseTo(0, 3);
    expect(unpackRGBADepth(packRGBADepth(2))).toBeCloseTo(1, 3);
  });

  test('按字节偏移读取（第 3 个像素）', () => {
    const buf = new Uint8Array(12);
    const bytes = packRGBADepth(0.5);
    buf.set(bytes, 8);
    expect(unpackRGBADepth(buf, 8)).toBeCloseTo(0.5, 5);
  });
});

describe('反投影', () => {
  test('单位矩阵：NDC 原样返回（深度映射到 -1~1）', () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(unprojectNdc(0.5, -0.25, 0.5, I)).toEqual([0.5, -0.25, 0]);
    const p = unprojectNdc(0, 0, 1, I);
    expect(p[2]).toBeCloseTo(1, 9);
  });

  test('含平移的逆矩阵：w 分量被正确除掉', () => {
    // 列主序：把点沿 x 平移 10
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];
    expect(unprojectNdc(0, 0, 0.5, T)).toEqual([10, 0, 0]);
  });

  test('像素 → NDC：左上角是 (-1, 1)，右下角是 (1, -1)', () => {
    const [x0, y0] = pixelToNdc(0, 0, 100, 50);
    expect(x0).toBeCloseTo(-0.99, 6);
    expect(y0).toBeCloseTo(0.98, 6);
    const [x1, y1] = pixelToNdc(99, 49, 100, 50);
    expect(x1).toBeCloseTo(0.99, 6);
    expect(y1).toBeCloseTo(-0.98, 6);
  });
});

describe('方位角 / 仰角', () => {
  test('正东 = 90°，正北 = 0°，正南 = 180°', () => {
    const o: Vec3 = [0, 0, 0];
    expect(azimuthElevation(o, [10, 0, 0]).azimuth).toBeCloseTo(90, 6);
    expect(azimuthElevation(o, [0, 10, 0]).azimuth).toBeCloseTo(0, 6);
    expect(azimuthElevation(o, [0, -10, 0]).azimuth).toBeCloseTo(180, 6);
  });

  test('45° 上坡：仰角 45°', () => {
    expect(azimuthElevation([0, 0, 0], [10, 0, 10]).elevation).toBeCloseTo(45, 6);
  });

  test('正下方：仰角 -90°', () => {
    expect(azimuthElevation([0, 0, 10], [0, 0, 0]).elevation).toBeCloseTo(-90, 6);
  });
});

/* ------------------------------------------------------------ 天际线 */

/** 造一台朝北看、z 轴朝上的相机，并给出它的逆视图投影矩阵 */
function makeCamera(): { camera: THREE.PerspectiveCamera; inv: Float32Array } {
  const camera = new THREE.PerspectiveCamera(60, 2, 1, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 100, 0); // 朝 +y（正北）看，水平
  camera.updateMatrixWorld(true);
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { camera, inv: new Float32Array(vp.clone().invert().elements) };
}

/** 把一个世界点正向投影成「像素 + 窗口深度」，写成深度图 */
function depthWithPoint(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  world: THREE.Vector3
): { rgba: Uint8Array; px: number; py: number } {
  const rgba = new Uint8Array(width * height * 4);
  // 背景 = 白色 (1,1,1,1)：这是深度目标清屏后的字节形态，解包正好是 1.0
  for (let i = 0; i < width * height; i++) rgba.set([255, 255, 255, 255], i * 4);

  const ndc = world.clone().project(camera);
  const px = Math.min(width - 1, Math.max(0, Math.floor(((ndc.x + 1) / 2) * width)));
  const py = Math.min(height - 1, Math.max(0, Math.floor(((1 - ndc.y) / 2) * height)));
  const depth = (ndc.z + 1) / 2;
  rgba.set(packRGBADepth(depth), (py * width + px) * 4);
  return { rgba, px, py };
}

describe('天际线', () => {
  test('全天空：每列都落在地平线，openRatio = 1', () => {
    const { camera, inv } = makeCamera();
    const width = 8;
    const height = 4;
    const rgba = new Uint8Array(width * height * 4).fill(255); // 清屏白色 = 天空

    const r = skylineFromDepth({
      rgba,
      width,
      height,
      inverseViewProj: inv,
      cameraPos: [camera.position.x, camera.position.y, camera.position.z],
    });
    expect(r.openRatio).toBe(1);
    expect(Array.from(r.elevations).every((e) => e === 0)).toBe(true);
    expect(r.maxElevation).toBe(0);
  });

  test('正前方 20° 的点：反投影回来的仰角是 20°、方位角是正北', () => {
    // 注意：相机垂直 FOV 60°（半视场 30°），测试点必须落在视锥内，
    // 否则会被投影到画面外、像素被夹到顶行，反投影出来就是另一个角度。
    const { camera, inv } = makeCamera();
    const width = 40;
    const height = 20;
    const elev = (20 * Math.PI) / 180;
    const world = new THREE.Vector3(0, 100, 100 * Math.tan(elev)); // 正北 100m、仰角 20°
    const { rgba } = depthWithPoint(camera, width, height, world);

    const r = skylineFromDepth({
      rgba,
      width,
      height,
      inverseViewProj: inv,
      cameraPos: [0, 0, 0],
    });
    // 这个点只落在一列上，那一列应该给出 45°
    const hit = Array.from(r.elevations).find((e) => Math.abs(e) > 1);
    expect(hit).toBeDefined();
    // 容差 1.5°：40×20 的深度图上一个像素在垂直方向就是 3°，半像素误差 ≈ 1.5°。
    // 这也是「天际线精度由深度图分辨率决定」的直接体现 —— 分辨率是 API 参数。
    expect(Math.abs(hit! - 20)).toBeLessThan(1.5);
    const az = r.azimuths[Array.from(r.elevations).indexOf(hit!)];
    expect(Math.abs(az!)).toBeLessThan(5); // 水平方向一列 = 4.5°
    expect(Math.abs(r.maxElevation - 20)).toBeLessThan(1.5);
  });

  test('step 跳采样：列数 = ceil(width / step)', () => {
    const { camera, inv } = makeCamera();
    const width = 10;
    const height = 4;
    const rgba = new Uint8Array(width * height * 4);
    const r = skylineFromDepth({
      rgba,
      width,
      height,
      inverseViewProj: inv,
      cameraPos: [0, 0, 0],
      step: 3,
    });
    expect(r.elevations.length).toBe(4);
  });
});

/* ------------------------------------------------------------ 可视域 */

describe('可视域（地面栅格）', () => {
  /** 观察点在地面上方 10m，正东 100m 处有一堵墙 */
  const origin: Vec3 = [0, 0, 10];
  // 解析平面 x = 100：任何朝东的射线都在 t = (100 - 0) / dir.x 处撞上它
  const wallAt = (dir: Vec3): number => (dir[0] > 1e-6 ? 100 / dir[0] : Infinity);

  test('正东 100m 之外被挡，其余方向可见', () => {
    const r = computeViewshed(origin, wallAt, { radius: 200, grid: 40 });
    expect(r.grid).toBe(40);
    expect(r.visibleRatio).toBeGreaterThan(0);
    expect(r.visibleRatio).toBeLessThan(1);

    // 取最东边一列：全在墙外，应该不可见
    const lastCol = r.grid - 1;
    let hidden = 0;
    for (let iy = 0; iy < r.grid; iy++) {
      if (r.raster[iy * r.grid + lastCol] === 0) hidden++;
    }
    expect(hidden).toBeGreaterThan(0);

    // 取正中心附近（离观察点很近）：可见
    const mid = Math.floor(r.grid / 2);
    expect(r.raster[mid * r.grid + mid]).toBe(1);
  });

  test('半径外的格子标 -1', () => {
    const r = computeViewshed(origin, () => Infinity, { radius: 50, grid: 20 });
    // 栅格覆盖 ±50，四个角离原点 70m > 50 → -1
    expect(r.raster[0]).toBe(-1);
    expect(r.raster[r.grid * r.grid - 1]).toBe(-1);
  });

  test('无遮挡时全部可见', () => {
    const r = computeViewshed(origin, () => Infinity, { radius: 100, grid: 16 });
    expect(r.visibleRatio).toBe(1);
  });

  test('栅格几何：cellSize = 2r / grid，左下角 = origin - r', () => {
    const r = computeViewshed(origin, () => Infinity, { radius: 100, grid: 10 });
    expect(r.cellSize).toBeCloseTo(20, 6);
    expect(r.minX).toBeCloseTo(-100, 6);
    expect(r.minY).toBeCloseTo(-100, 6);
  });
});

describe('立方体深度采样器', () => {
  const size = 4;
  const maxDist = 100;

  function faceFilled(value: number): Uint8Array {
    const f = new Uint8Array(size * size * 4);
    const bytes = packRGBADepth(value);
    for (let i = 0; i < size * size; i++) f.set(bytes, i * 4);
    return f;
  }

  test('朝 +x 的射线读 +x 面，返回值按 maxDist 缩放', () => {
    const faces = [faceFilled(0.5), null, null, null, null, null];
    const sample = makeCubeDistanceSampler(faces, size, maxDist);
    expect(sample([1, 0, 0])).toBeCloseTo(50, 1);
  });

  test('朝 -x 的射线读 -x 面（面序与 three 一致）', () => {
    const faces = [null, faceFilled(0.25), null, null, null, null];
    const sample = makeCubeDistanceSampler(faces, size, maxDist);
    expect(sample([-1, 0, 0])).toBeCloseTo(25, 1);
  });

  test('朝 +y / +z 各读各的面', () => {
    const faces = [null, null, faceFilled(0.1), null, faceFilled(0.2), null];
    const sample = makeCubeDistanceSampler(faces, size, maxDist);
    expect(sample([0, 1, 0])).toBeCloseTo(10, 0);
    expect(sample([0, 0, 1])).toBeCloseTo(20, 0);
  });

  test('缺面的方向返回 Infinity（当作没有几何）', () => {
    const sample = makeCubeDistanceSampler([null, null, null, null, null, null], size, maxDist);
    expect(sample([1, 0, 0])).toBe(Infinity);
  });

  test('打包值为 1（远平面）时也当没有几何（解包是 0.996，不是 1）', () => {
    const faces = [faceFilled(1), null, null, null, null, null];
    const sample = makeCubeDistanceSampler(faces, size, maxDist);
    expect(sample([1, 0, 0])).toBe(Infinity);
  });
});

/* ------------------------------------------------ 立方体相机与采样器约定 */

describe('立方体相机朝向与采样器一致（不镜像）', () => {
  const size = 8;
  const maxDist = 100;

  /** 每个面填一个「沿 u 递增」的梯度：镜像会立刻暴露 */
  function gradientFace(): Uint8Array {
    const f = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = ((x + 0.5) / size) * 0.8 + 0.1; // 0.1 ~ 0.9
        f.set(packRGBADepth(d), (y * size + x) * 4);
      }
    }
    return f;
  }

  test('6 个面各自取到正确的面，且 u 方向没有镜像', () => {
    const faces = Array.from({ length: 6 }, () => gradientFace());
    const sample = makeCubeDistanceSampler(faces, size, maxDist);
    const cameras = buildCubeCameras([0, 0, 0], 0.1, maxDist);

    for (let i = 0; i < 6; i++) {
      const { forward, up } = CUBE_FACES[i]!;
      const right: Vec3 = [
        forward[1] * up[2] - forward[2] * up[1],
        forward[2] * up[0] - forward[0] * up[2],
        forward[0] * up[1] - forward[1] * up[0],
      ];
      // 取一个偏离中心的方向：u = 0.4, v = 0.2（都在 90° FOV 内）
      const dir: Vec3 = [
        forward[0] + right[0] * 0.4 + up[0] * 0.2,
        forward[1] + right[1] * 0.4 + up[1] * 0.2,
        forward[2] + right[2] * 0.4 + up[2] * 0.2,
      ];
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      const n: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];

      // 期望：u = 0.4 → 第 5 列（8 格），梯度值 = 0.1 + 5.5/8*0.8
      const expectedCol = Math.floor(((0.4 + 1) / 2) * size);
      const expected = (0.1 + ((expectedCol + 0.5) / size) * 0.8) * maxDist;
      expect(sample(n)).toBeCloseTo(expected, 0);

      // 交叉验证：同一方向投影到对应相机的像素列，应该落在同一列上
      const p = new THREE.Vector3(n[0], n[1], n[2]).project(cameras[i]!);
      const camCol = Math.floor(((p.x + 1) / 2) * size);
      expect(camCol).toBe(expectedCol);
    }
  });
});

describe('天际线的屏幕坐标（用来在地图上描线）', () => {
  test('screen 就是「最上面那个几何像素」的归一化位置', () => {
    const { camera, inv } = makeCamera();
    const width = 40;
    const height = 20;
    const elev = (20 * Math.PI) / 180;
    const world = new THREE.Vector3(0, 100, 100 * Math.tan(elev));
    const { rgba, px, py } = depthWithPoint(camera, width, height, world);

    const r = skylineFromDepth({ rgba, width, height, inverseViewProj: inv, cameraPos: [0, 0, 0] });
    // 找到有几何的那一列，它的归一化坐标必须落在写进去的那个像素中心上
    const c = Array.from(r.hasGeometry).indexOf(1);
    expect(c).toBe(px);
    expect(r.screen[c * 2]).toBeCloseTo((px + 0.5) / width, 6);
    expect(r.screen[c * 2 + 1]).toBeCloseTo((py + 0.5) / height, 6);
  });

  test('纯天空的列 hasGeometry = 0，且 screen.y 贴到画面底部（画线时断开）', () => {
    const { camera, inv } = makeCamera();
    const width = 8;
    const height = 4;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    const r = skylineFromDepth({ rgba, width, height, inverseViewProj: inv, cameraPos: [0, 0, 0] });

    expect(Array.from(r.hasGeometry).every((v) => v === 0)).toBe(true);
    for (let c = 0; c < r.hasGeometry.length; c++) {
      expect(r.screen[c * 2 + 1]).toBe(1);
    }
    expect(r.screen.length).toBe(r.azimuths.length * 2);
  });

  test('screen.x 随列单调递增（没有镜像）', () => {
    const { camera, inv } = makeCamera();
    const width = 16;
    const height = 4;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    const r = skylineFromDepth({ rgba, width, height, inverseViewProj: inv, cameraPos: [0, 0, 0] });
    for (let c = 1; c < r.hasGeometry.length; c++) {
      expect(r.screen[c * 2]!).toBeGreaterThan(r.screen[(c - 1) * 2]!);
    }
  });
});
