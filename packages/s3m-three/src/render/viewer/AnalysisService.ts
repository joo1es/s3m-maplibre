/**
 * 空间分析：量算、通视、裁剪、天际线、可视域。
 *
 * 从 `S3MViewer.ts` 搬出来（issue #27 的 P6 阶段），行为逐字未变。
 *
 * 这块和视图状态完全正交：输入是经纬度和几何，输出是数字或栅格，
 * 需要的宿主能力只有四个取值函数（ENU 换算、射线求交、renderer/scene/camera）。
 * 它自己只持有一个 `clip` 配置 —— 因为裁剪要能在 mount 之前就设好，
 * 那时 renderer 还不存在，只能先把配置记着、等 `applyClipping()` 的时候再挂上去。
 *
 * 范围边界（写在这里，避免使用者误解）：**只认 S3M 场景里的几何**。
 * MapLibre 底图地形与 MVT 建筑不在这个场景里，不参与遮挡。
 */
import * as THREE from 'three';
import {
  buildClipPlanes,
  lineOfSight as computeLineOfSight,
  measureSegment,
  polygonArea,
  polygonAreaHorizontal,
  polygonPerimeter,
  polylineLength,
  polylineLengthHorizontal,
} from '../../analysis/index.js';
import type {
  ClipOptions,
  LineOfSightOptions,
  LineOfSightResult,
  LngLatAlt,
  MeasureResult,
  SkylineResult,
  Vec3,
  ViewshedResult,
} from '../../analysis/index.js';
import { skylineFromDepth } from '../../analysis/skyline.js';
import { computeViewshed, makeCubeDistanceSampler } from '../../analysis/viewshed.js';
import { captureRadialCube, captureSkylineDepth } from '../analysis/DepthPass.js';
import type { DepthCaptureContext } from '../analysis/DepthPass.js';

/** `AnalysisService` 需要的宿主能力。全是取值函数，没有控制流回调 */
export interface AnalysisHost {
  /** 经纬度 + 绝对高程 → 场景 ENU 米（含瓦片级放置的反解） */
  sceneFromLngLat(p: LngLatAlt): Vec3;
  /**
   * 沿方向打一条射线，返回最近的 S3M 几何命中。
   *
   * 参数是 `maxDistance`，超过这个距离的命中直接忽略（通视分析用它截断）。
   */
  raycastDistance(
    origin: Vec3,
    dir: Vec3,
    maxDistance: number
  ): { distance: number; point: Vec3 } | null;
  /** 需要重绘时调（走宿主的公共 triggerRepaint，不要在子模块里绕） */
  requestRepaint(): void;
  /** renderer / scene / camera 都可能为空（未 mount），所以是取值函数而不是字段 */
  renderer(): THREE.WebGLRenderer | null;
  scene(): THREE.Scene | null;
  camera(): THREE.Camera | null;
}

export class AnalysisService {
  /** 当前裁剪配置；renderer 就绪前后都要能设，所以单独存一份 */
  private _clip: ClipOptions | null = null;

  constructor(private readonly host: AnalysisHost) {}

  /** 两点量算：三维距离 / 水平距离 / 高差 */
  measureDistance(a: LngLatAlt, b: LngLatAlt): MeasureResult {
    return measureSegment(this.host.sceneFromLngLat(a), this.host.sceneFromLngLat(b));
  }

  /** 折线长度（三维 + 水平投影两套口径） */
  measurePolyline(points: readonly LngLatAlt[]): { length3D: number; lengthHorizontal: number } {
    const scene = points.map((p) => this.host.sceneFromLngLat(p));
    return { length3D: polylineLength(scene), lengthHorizontal: polylineLengthHorizontal(scene) };
  }

  /**
   * 多边形量算：坡面真实面积 / 水平投影面积 / 周长。
   *
   * 建筑面积、用地面积按 `areaHorizontal` 算；坡面覆盖面积按 `area3D`。
   */
  measurePolygon(points: readonly LngLatAlt[]): {
    area3D: number;
    areaHorizontal: number;
    perimeter: number;
  } {
    const scene = points.map((p) => this.host.sceneFromLngLat(p));
    return {
      area3D: polygonArea(scene),
      areaHorizontal: polygonAreaHorizontal(scene),
      perimeter: polygonPerimeter(scene),
    };
  }

  /**
   * 通视分析：两点之间是否被已加载的 S3M 几何挡住。
   *
   * 走 CPU 射线求交（`Raycaster` 打全部 pickable mesh），几十万面量级是几十毫秒，
   * 适合点击式查询；要拖拽时逐帧刷新，得等深度图版本的批量采样。
   */
  lineOfSight(a: LngLatAlt, b: LngLatAlt, opts: LineOfSightOptions = {}): LineOfSightResult {
    const from = this.host.sceneFromLngLat(a);
    const to = this.host.sceneFromLngLat(b);
    return computeLineOfSight(
      from,
      to,
      (origin, dir, maxDistance) => {
        const hit = this.host.raycastDistance(origin, dir, maxDistance);
        if (!hit) return null;
        return { distance: hit.distance, point: hit.point };
      },
      opts
    );
  }

  /**
   * 裁剪 / 剖切（平面、Box、十字）。
   *
   * 平面列表挂在**本图层的 renderer** 上（每个 `S3MLayer` 一个 `WebGLRenderer`），
   * 所以天然是图层级：同页别的图层不受影响。传 `null` 取消裁剪。
   *
   * 已知边界：只做「切掉」，不做**封口**——剖开后看到的是空壳/背面；
   * 凹多边形裁剪需要多组半空间并集，three 的 `clippingPlanes` 表达不了（只能凸）。
   */
  setClipping(opt: ClipOptions | null): void {
    this._clip = opt;
    this.applyClipping();
    this.host.requestRepaint();
  }

  /** 当前裁剪配置（`null` = 未裁剪） */
  get clipping(): ClipOptions | null {
    return this._clip;
  }

  /** 把当前裁剪配置挂到 renderer 上；renderer 还没就绪就先跳过，等 mount 后补 */
  applyClipping(): void {
    const r = this.host.renderer();
    if (!r) return; // mount 前先记着，`_createRenderer` 之后会补一次
    if (!this._clip) {
      r.clippingPlanes = [];
      return;
    }
    r.clippingPlanes = buildClipPlanes(this._clip).map(
      (p) => new THREE.Plane(new THREE.Vector3(p.normal[0], p.normal[1], p.normal[2]), p.constant)
    );
  }

  /** 分析用的离屏采集上下文（renderer / scene / camera 都可能在 mount 前为空） */
  private depthCtx(): DepthCaptureContext {
    return {
      renderer: () => this.host.renderer(),
      scene: () => this.host.scene(),
      camera: () => this.host.camera(),
    };
  }

  /**
   * 天际线分析：用当前视角渲染一张深度图，按列抽出「方位角 → 仰角」曲线。
   *
   * 一次调用 = 一趟额外渲染 + 一次全图回读，**不要每帧调**。
   * 典型用法是相机停下来（`moveend`）后算一次。
   *
   * @param opts.width 采集分辨率（默认 640）。精度由它决定：
   *   640 宽 ≈ 0.56°/列，1280 宽 ≈ 0.28°/列。
   */
  skyline(opts: {
    width?: number;
    height?: number;
    step?: number;
    /** 额外参与遮挡的代理几何（底图建筑 / 地形网格），只在这一趟深度渲染里存在 */
    include?: readonly THREE.Object3D[];
  } = {}): SkylineResult | null {
    const cap = captureSkylineDepth(
      this.depthCtx(),
      opts.width ?? 640,
      opts.height ?? 360,
      opts.include
    );
    if (!cap) return null;
    return skylineFromDepth({
      rgba: cap.rgba,
      width: cap.width,
      height: cap.height,
      inverseViewProj: cap.inverseViewProj,
      cameraPos: cap.cameraPos,
      step: opts.step,
    });
  }

  /**
   * 360° 可视域（地面栅格版）：从观察点朝 6 个方向各渲染一次深度，
   * 再在 CPU 上对地面网格逐格判定可见性。
   *
   * 一次调用 = 6 趟额外渲染 + 6 次回读，成本明显高于天际线，
   * 只在点击/松手时算。返回的 `raster` 可以直接当贴图画在地面上。
   */
  viewshed(opts: {
    /** 观察点（经纬度 + 地面高程；眼高由 `eyeHeight` 另加） */
    origin: LngLatAlt;
    /** 分析半径（米） */
    radius: number;
    /** 栅格边长（默认 96） */
    grid?: number;
    /** 眼高（米，默认 1.7） */
    eyeHeight?: number;
    /** 立方体深度图分辨率（默认 128；越大边缘越准，回读越慢） */
    size?: number;
    /** 额外参与遮挡的代理几何（底图建筑 / 地形网格），只在这一趟深度渲染里存在 */
    include?: readonly THREE.Object3D[];
  }): ViewshedResult | null {
    const eye = opts.eyeHeight ?? 1.7;
    const origin = this.host.sceneFromLngLat({ ...opts.origin, altitude: opts.origin.altitude + eye });
    const size = opts.size ?? 128;
    const faces = captureRadialCube(this.depthCtx(), origin, size, opts.radius, opts.include);
    if (!faces) return null;
    return computeViewshed(origin, makeCubeDistanceSampler(faces, size, opts.radius), {
      radius: opts.radius,
      grid: opts.grid,
      groundZ: 0,
    });
  }
}
