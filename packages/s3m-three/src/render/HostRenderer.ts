/**
 * 宿主无关渲染底座（HostRenderer）
 *
 * 把「宿主协议 ↔ s3m-three 渲染内核」的**宿主无关**部分抽出来，作为所有地图适配层
 * （MapLibre / Mapbox / 未来的 ArcGIS / Cesium）的共同基类。它只做三件事：
 *
 *   1. 持有并构造 `S3MViewer`（渲染内核，宿主无关）；
 *   2. 提供每帧驱动（把宿主给的 world→clip 矩阵喂给内核，并按需请求下一帧）、
 *      生命周期（mount / restore / unmount）、投影模式状态与近平面缩放状态；
 *   3. 把「宿主能力」做成两个抽象钩子 `requestRepaint()` / `getBearing()`，
 *      由具体适配器实现（maplibre → `triggerRepaint()`，arcgis → `requestRender()`）。
 *
 * 凡是依赖具体地图 API 的东西（CustomLayerInterface 形态、从宿主 render 参数里抽矩阵、
 * 事件绑定、上下文恢复重加图层、经纬度→墨卡托的 WorldCoordinateHelper 提取）都**不在这里**——
 * 那是各适配层自己的事。这样「绕开墨卡托」也成为可能：非墨卡托宿主（ECEF / 局部米制）只要
 * 实现 `requestRepaint` 并提供返回自己坐标系的 GeoAdapter，内核就完全不碰墨卡托。
 *
 * 设计约束（对应 AGENTS.md 不变式①）：本类不引入任何默认行为变更；maplibre 适配器继承它后，
 * 默认路径与改动前逐字一致。
 */
import { S3MViewer } from './S3MViewer.js';
import type { S3MViewerOptions, PickResult } from './S3MViewer.js';
import type { ProjectionMode } from './OrthoProjection.js';
import type { TransitionOptions } from '../anim/Animator.js';
import type { Stats } from '../core/types.js';
import type { S3MDatasetEntry } from './DatasetManager.js';

/** HostRenderer 构造选项：渲染内核选项 + 三个适配器层专属开关 */
export interface HostRendererOptions extends S3MViewerOptions {
  /** 图层 / 适配器 id，默认 's3m' */
  id?: string;
  /** 投影模式，默认 'perspective'（跟随宿主） */
  projection?: ProjectionMode;
  /** 近裁剪面缩放系数（0 < scale < 1，默认 1 = 不改） */
  nearPlaneScale?: number;
  /**
   * 复用已有的渲染内核，而不是新建一个（默认不传 = 保持旧行为，每层各建一个）。
   *
   * 用于「多个数据集共用一个地图图层」的场景：`S3MViewer` 本来就能挂多个数据集
   * （`addDataset`），却因为 `S3MLayer` 是一数据集一实例，被迫建 N 个内核。
   * 而每个内核 `mount()` 都会在同一个宿主 GL 上下文上 `new THREE.WebGLRenderer()`：
   *
   *   - three 的 programCache 挂在 renderer 上 → 同一套材质编译 N 次；
   *   - N 个 renderer 交替 render 会互相打脸 GL 状态缓存，**每帧**重复重设；
   *   - 每帧 N 次 renderFrame、N 套光照。
   *
   * **谁负责创建、谁负责销毁**：传入 `viewer` 的图层不持有内核所有权 ——
   * 第一个挂载它的图层成为 owner，`onRemove` 时才真正 `unmount`；
   * 其余图层卸载时只摘自己的数据集，不会把共用的内核拆掉。
   *
   * **注意**：投影模式、`getBearing` / `requestRepaint` 这类宿主钩子、拾取 id 池
   * 都是**内核级**状态，共享后即为所有数据集共用（同一个地图上通常正是想要的）。
   */
  viewer?: S3MViewer;
}

/** 每帧喂给内核的矩阵输入（宿主无关；适配器负责从宿主 render 参数里抽出来） */
export interface HostFrame {
  /** world→clip 矩阵（宿主坐标系下） */
  mvp: ArrayLike<number>;
  /** 相机在场景 ENU 中的位置（米，相对场景锚点） */
  cameraEnu: [number, number, number];
  /** 垂直视场角（弧度），用于 LOD 屏幕误差 */
  fovRad: number;
  /** 绘图缓冲高度（像素），LOD 判定用 */
  canvasHeight: number;
}

/**
 * 宿主无关渲染底座。具体地图适配器（如 S3MLayer）继承它，只补宿主专属胶水。
 */
export abstract class HostRenderer {
  readonly id: string;
  readonly options: HostRendererOptions;
  readonly pickable: boolean;

  /** 公开回调，可被使用方运行时重新赋值 */
  onStats: (stats: Stats) => void;
  onReady: (entry: S3MDatasetEntry) => void;
  onPick: (result: PickResult | null) => void;
  onError: (error: unknown) => void;

  /** 渲染内核（宿主无关） */
  readonly viewer: S3MViewer;

  /** 当前投影模式 */
  protected _projection: ProjectionMode = 'perspective';
  /** 正交插值比例（0 = 纯透视，1 = 纯正交）；过渡期间由 animator 平滑推进 */
  protected _projectionT = 0;
  /** 正交不可用只告警一次 */
  protected _orthoWarned = false;
  /** 近裁剪面缩放系数，1 = 不改（默认） */
  protected _nearPlaneScale = 1;

  constructor(options: HostRendererOptions = {}) {
    this.id = options.id ?? 's3m';
    this.options = options;
    this.pickable = options.pickable !== false;
    this._projection = options.projection === 'orthographic' ? 'orthographic' : 'perspective';
    this._nearPlaneScale = HostRenderer.normalizeNearPlaneScale(options.nearPlaneScale);
    this._projectionT = this._projection === 'orthographic' ? 1 : 0;

    this.onStats = options.onStats ?? (() => {});
    this.onReady = options.onReady ?? (() => {});
    this.onPick = options.onPick ?? (() => {});
    this.onError = options.onError ?? ((e) => console.warn('[s3m]', e));

    // 把宿主能力做成钩子，内核不碰任何地图 API
    const {
      id: _id,
      projection: _projection,
      nearPlaneScale: _nearPlaneScale,
      viewer,
      ...viewerOptions
    } = options;
    // 注入内核时不再新建（多个数据集共用一个内核，见 `HostRendererOptions.viewer`）；
    // 此时宿主钩子（requestRepaint / getBearing / 回调）以**创建它的那一层**为准，
    // 因为钩子是构造期一次性绑死的，后续注入方改不了。
    this.viewer = viewer ?? new S3MViewer({
      ...viewerOptions,
      onRequestRepaint: () => this.requestRepaint(),
      getBearing: () => this.getBearing(),
      onStats: (s) => this.onStats(s),
      onReady: (e) => this.onReady(e),
      onPick: (r) => this.onPick(r),
      onError: (e) => this.onError(e),
    });
  }

  /**
   * 内核的**挂载登记表**（按内核实例）：谁先挂的、现在有几个图层在用它。
   *
   * 不能只看 `viewer.renderer` 判断「挂过没有」：那分不清「同一个图层因上下文丢失
   * 重新 onAdd」（应走 restoreContext 原地换新 renderer）与「另一个图层第一次挂
   * 同一个共享内核」（应什么都不做）—— 两者 renderer 都非空，混为一谈会把共用
   * 内核的 renderer 反复重建，那比当初建 N 个还糟。
   *
   * 记引用数而不是只记 owner，是因为**卸载顺序不可控**：宿主先摘哪个图层是它自己的
   * 事，只认 owner 的话，创建者先走就会把别人还在用的内核一起拆掉。
   */
  private static readonly _mounts = new WeakMap<S3MViewer, { owner: HostRenderer; refs: number }>();

  /** 本实例是否已登记在这个内核的引用里（onAdd 可能被重复触发，必须幂等） */
  private _viewerMounted = false;

  /**
   * 宿主能力的钩子：请求下一帧重绘。
   * maplibre → `map.triggerRepaint()`；arcgis → `externalRenderers.requestRender(view)`。
   */
  protected abstract requestRepaint(): void;

  /** 宿主方位角（度）；宿主无关默认 0（灯光不跟随视角） */
  protected getBearing(): number {
    return 0;
  }

  /* ----------------------------------------------------------------- 生命周期 */

  /** 挂载渲染内核到宿主的 canvas + 共享 GL 上下文（上下文恢复时原地换新 renderer） */
  protected mountViewer(canvas: HTMLCanvasElement, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const entry = HostRenderer._mounts.get(this.viewer);

    if (entry) {
      if (entry.owner === this) {
        // 上下文恢复路径：onAdd 被再次触发（map.addLayer），原地换新 renderer，
        // 保留已加载的场景与瓦片，不重建、不重拉。
        this.viewer.restoreContext(gl);
        return;
      }
      // 另一个图层已经挂上了这个共享内核：直接复用，既不 mount 也不 restore
      // （restoreContext 会重建 renderer，等于把「省下来的那份」又还回去了）。
      // onAdd 可能被重复触发，引用数只加一次。
      if (!this._viewerMounted) {
        entry.refs++;
        this._viewerMounted = true;
      }
      return;
    }

    if (this.viewer.renderer) {
      // 兜底：内核已被挂载过但没走这条登记（如外部直接替换了 viewer 实例）。
      // 维持旧语义 —— 有 renderer 就走上下文恢复，而不是重复 mount。
      this.viewer.restoreContext(gl);
      HostRenderer._mounts.set(this.viewer, { owner: this, refs: 1 });
      this._viewerMounted = true;
      return;
    }

    this.viewer.mount(canvas, gl);
    HostRenderer._mounts.set(this.viewer, { owner: this, refs: 1 });
    this._viewerMounted = true;
  }

  /** 卸载渲染内核（保留已加载的瓦片，下次 mount 可复用） */
  protected unmountViewer(): void {
    const entry = HostRenderer._mounts.get(this.viewer);
    if (!entry) {
      // 没登记过（外部替换过 viewer 等）：维持旧行为，直接卸
      this.viewer.unmount();
      return;
    }

    if (this._viewerMounted) {
      entry.refs--;
      this._viewerMounted = false;
    }
    // 还有别的图层在共用这个内核：只摘自己的数据集（调用方负责），内核不能拆
    if (entry.refs > 0) return;

    HostRenderer._mounts.delete(this.viewer);
    this.viewer.unmount();
  }

  /* ----------------------------------------------------------------- 每帧驱动 */

  /**
   * 把宿主抽好的矩阵喂给内核，并按需请求下一帧。
   * 返回内核是否需要继续驱动（动态着色 / 瓦片加载中 / LOD 变化）。
   */
  protected driveFrame(frame: HostFrame): boolean {
    const needsNext = this.viewer.renderFrame(frame);
    if (needsNext) this.requestRepaint();
    return needsNext;
  }

  /* ----------------------------------------------------------------- 投影模式 */

  /**
   * 切换投影模式，可带平滑过渡。
   * 正交只影响本层：底图瓦片、地形、DOM Marker / 弹窗仍走宿主的透视投影。
   * 拾取、选中描边、按单体着色/隐藏/抬高不受影响。
   */
  setProjection(mode: ProjectionMode, transition?: TransitionOptions): void {
    const next = mode === 'orthographic' ? 'orthographic' : 'perspective';
    const targetT = next === 'orthographic' ? 1 : 0;
    const duration = transition?.duration ?? 0;
    const wantAnim = duration > 0 || !!transition?.spring;

    this._projection = next;
    this._orthoWarned = false;

    if (!wantAnim) {
      if (this.viewer.animator.has('projection.t')) this.viewer.animator.cancel('projection.t');
      this._projectionT = targetT;
      this.requestRepaint();
      return;
    }

    this._ensureProjectionChannel();
    this.viewer.animator.to('projection.t', targetT, {
      ...transition,
      duration,
      easing: transition?.easing ?? 'easeInOutCubic',
      onComplete: () => {
        this._projectionT = targetT;
        this.requestRepaint();
      },
    });
    this.requestRepaint();
  }

  /** 当前投影模式 */
  get projection(): ProjectionMode {
    return this._projection;
  }

  /** 当前正交插值比例（0 = 纯透视，1 = 纯正交） */
  get projectionT(): number {
    return this._projectionT;
  }

  /** 正交插值参数通道：由 animator 平滑推进，写回时请求重绘 */
  protected _ensureProjectionChannel(): void {
    if (this.viewer.animator.has('projection.t')) return;
    this.viewer.animator.register('projection.t', {
      dim: 1,
      read: (out) => {
        out[0] = this._projectionT;
      },
      write: (v) => {
        this._projectionT = v[0];
        this.requestRepaint();
      },
    });
  }

  /* ----------------------------------------------------------------- 近平面缩放 */

  /** 动态调整近裁剪面缩放（0 < scale < 1）。传 1 / 0 / 非法值 = 恢复宿主原始 near */
  setNearPlaneScale(scale: number): void {
    this._nearPlaneScale = HostRenderer.normalizeNearPlaneScale(scale);
    this.requestRepaint();
  }

  /** 当前近裁剪面缩放系数（1 = 不改，用宿主的默认值） */
  get nearPlaneScale(): number {
    return this._nearPlaneScale;
  }

  /** 近裁剪缩放系数的合法化：非数字 / <=0 / >=1 一律视为「不改」 */
  static normalizeNearPlaneScale(v: number | undefined): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
    return v > 0 && v < 1 ? v : 1;
  }
}
