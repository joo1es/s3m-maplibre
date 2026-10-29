/**
 * 360° 可视域：地面栅格版。
 *
 * 思路与「从观察点做阴影贴图」一致，但**判定在 CPU 上做**：
 * GPU 只负责产出一个 `方向 → 最近遮挡距离` 的采样函数（6 面立方体深度图），
 * 这里拿它在观察点周围的地面网格上逐格比较距离。
 *
 * 为什么不在片元里逐像素判定（建筑立面着色版）：
 * 那要把立方体深度注入到每种材质（pbr / lambert / 棱线 / 点云 / 泼溅）的 shader 里，
 * 成本和风险高一个量级；地面栅格版能覆盖绝大多数规划类需求，且结果可以直接
 * 当成一张贴图/热力图叠在地面上。
 *
 * 纯数学，不碰 WebGL：采样函数由 `render/analysis/DepthPass` 提供，单测里用假的。
 */
import { unpackRGBADepth } from './depth.js';
import type { Vec3 } from './measure.js';

export interface ViewshedOptions {
  /** 分析半径（米） */
  radius: number;
  /** 栅格边长（格数，默认 96；96² = 9216 个采样点，CPU 侧约 1~3 ms） */
  grid?: number;
  /**
   * 遮挡容差（米，默认 0.5）。
   *
   * 采样点到观察点的距离要**小于等于**该方向上的遮挡距离才算可见；
   * 留一点容差是为了吸收深度图的离散化误差与地面自身的起伏。
   */
  bias?: number;
  /** 地面高程（场景 ENU 的 z，默认 0） */
  groundZ?: number;
}

export interface ViewshedResult {
  /**
   * `grid × grid` 的可见性，行优先（`y * grid + x`）：
   * `1` = 可见，`0` = 被遮挡，`-1` = 超出半径或没有数据。
   */
  raster: Float32Array;
  grid: number;
  /** 栅格左下角（场景 ENU 米） */
  minX: number;
  minY: number;
  /** 每格边长（米） */
  cellSize: number;
  /** 有效格子里可见的比例（0~1） */
  visibleRatio: number;
}

/**
 * @param origin 观察点（场景 ENU 米，已含眼高）
 * @param sampleDistance 沿单位方向取「最近的遮挡距离」；该方向没有几何时返回 `Infinity`
 */
export function computeViewshed(
  origin: Vec3,
  sampleDistance: (dir: Vec3) => number,
  opts: ViewshedOptions
): ViewshedResult {
  const radius = Math.max(1e-3, opts.radius);
  const grid = Math.max(2, Math.floor(opts.grid ?? 96));
  const bias = Math.max(0, opts.bias ?? 0.5);
  const groundZ = opts.groundZ ?? 0;

  const cellSize = (radius * 2) / grid;
  const minX = origin[0] - radius;
  const minY = origin[1] - radius;
  const raster = new Float32Array(grid * grid);

  let visible = 0;
  let counted = 0;

  for (let iy = 0; iy < grid; iy++) {
    const wy = minY + (iy + 0.5) * cellSize;
    for (let ix = 0; ix < grid; ix++) {
      const wx = minX + (ix + 0.5) * cellSize;
      const dx = wx - origin[0];
      const dy = wy - origin[1];
      const dz = groundZ - origin[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const idx = iy * grid + ix;

      if (dist > radius || dist < 1e-6) {
        raster[idx] = -1;
        continue;
      }

      const dir: Vec3 = [dx / dist, dy / dist, dz / dist];
      const blockedAt = sampleDistance(dir);
      const ok = dist <= blockedAt + bias;
      raster[idx] = ok ? 1 : 0;
      counted++;
      if (ok) visible++;
    }
  }

  return {
    raster,
    grid,
    minX,
    minY,
    cellSize,
    visibleRatio: counted > 0 ? visible / counted : 0,
  };
}

/**
 * 从 6 面立方体深度图构造 `sampleDistance`。
 *
 * 立方体每个面是 `size × size` 的 RGBA8，存的是 `距离 / maxDist` 的打包值
 * （打包方式同 three 的 `packDepthToRGBA`，与 `RGBADepthPacking` 一致）。
 * 采样用最近邻 —— 可视域本身是栅格化的，插值不会让结果更准。
 *
 * 面序与 three 的 `WebGLCubeRenderTarget` / `CubeCamera` 一致：
 * `+x, -x, +y, -y, +z, -z`。
 */
export function makeCubeDistanceSampler(
  faces: readonly (ArrayLike<number> | null | undefined)[],
  size: number,
  maxDist: number
): (dir: Vec3) => number {
  return (dir) => {
    const [x, y, z] = dir;
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);

    // 主轴决定落在哪个面：|x| 最大 → ±x 面，依此类推
    let faceIndex: number;
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) {
      faceIndex = x >= 0 ? 0 : 1;
      const d = ax;
      // three 的立方体面约定：+x 面 u = -z/d, v = -y/d
      u = x >= 0 ? -z / d : z / d;
      v = -y / d;
    } else if (ay >= az) {
      faceIndex = y >= 0 ? 2 : 3;
      const d = ay;
      u = x / d;
      v = y >= 0 ? z / d : -z / d;
    } else {
      faceIndex = z >= 0 ? 4 : 5;
      const d = az;
      // 面朝向相反时 u 轴也翻向，否则 -z 面会左右镜像（可视域会镜像到错误一侧）
      u = z >= 0 ? x / d : -x / d;
      v = -y / d;
    }

    const face = faces[faceIndex];
    if (!face) return Infinity;
    const px = Math.min(size - 1, Math.max(0, Math.floor(((u + 1) / 2) * size)));
    const py = Math.min(size - 1, Math.max(0, Math.floor(((v + 1) / 2) * size)));
    const d = unpackRGBADepth(face, (py * size + px) * 4);
    // 打包值是归一化距离：1 = 远平面（该方向没有几何）。three 的 pack 对 v>=1
    // 直接返回全白，解包正好是 1.0，所以阈值取 0.9999 就够。
    if (d >= 0.9999) return Infinity;
    return d * maxDist;
  };
}
