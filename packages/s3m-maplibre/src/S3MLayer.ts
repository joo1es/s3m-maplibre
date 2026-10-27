/**
 * S3M × MapLibre / Mapbox 图层（薄适配层）
 *
 * 这个文件只做「宿主协议 ↔ s3m-three 渲染内核」的翻译，不含任何渲染逻辑：
 *
 *   onAdd(map, gl)      → 建 GeoAdapter、viewer.mount(canvas, gl)、挂地图事件
 *   render(gl, arg)     → 从 MapLibre 每帧输入里取出 world→clip 矩阵与相机位置，
 *                         喂给 viewer.renderFrame()，按返回值决定是否继续 triggerRepaint
 *   click / projectiontransition → 转成 viewer 的拾取与锚点重算
 *
 * 渲染、样式、拾取、选中、棱线、单体状态全部在 s3m-three 的 S3MViewer 里，
 * 纯 three 宿主（不接地图）请直接用 S3MViewer。
 *
 * 兼容性：图层只依赖 `MapLike` 这组鸭子类型接口，MapLibre GL JS v4/v5 与
 * Mapbox GL JS v2/v3 都可以直接 `map.addLayer(layer)`，不引入任一方的类型依赖。
 */
import { S3MViewer } from 's3m-three';
import type {
  S3MViewerOptions,
  S3MStyle,
  PickResult,
  Stats,
  S3MDatasetOptions,
  S3MDatasetEntry,
  DatasetAlignment,
  FeatureStyle,
  AttributeQueryOptions,
  ColorByFieldOptions,
  FieldFilterOptions,
  FieldFilterResult,
  FieldElevationOptions,
  FieldElevationResult,
  S3MFilter,
  ThematicResult,
  BatchAudit,
  GroundMode,
  LightOptions,
  TransitionOptions,
  Path,
  PathFollowOptions,
} from 's3m-three';
import type { Ray, ToneMapping } from 'three';
import { Matrix4 } from 'three';
import {
  buildOrthoMVP,
  buildBlendedMVP,
  extractFovRadians,
  extractNearFar,
  extractProjectionMatrix,
} from 's3m-three';
import type { ProjectionMode } from 's3m-three';
import {
  DEFAULT_FOV,
  createMapLibreGeoAdapter,
  extractWorldCoordinateHelper,
  type MapLike,
  type MapMouseEventLike,
  type WorldCoordinateHelperLike,
} from './MapLibreGeoAdapter.js';

/* 兼容再导出：0.2.x 起这些符号就从 s3m-maplibre 根出口暴露，老代码不用改 */
export * from 's3m-three';
export type { MapLike, MapMouseEventLike, WorldCoordinateHelperLike } from './MapLibreGeoAdapter.js';
export { DEFAULT_FOV, createMapLibreGeoAdapter, extractWorldCoordinateHelper } from './MapLibreGeoAdapter.js';

export interface S3MLayerOptions extends S3MViewerOptions {
  id?: string;
  /**
   * 投影模式，默认 `'perspective'`（跟随 MapLibre，与底图严格对齐）。
   * `'orthographic'` 让本层按正交投影重画：视图矩阵从 MapLibre 每帧输入反推，
   * pan / zoom / pitch / rotate 与拾取、选中描边全部照常。
   * 注意正交只覆盖本层——底图、地形、DOM Marker 仍走 MapLibre 的透视投影，
   * 会与本层对不齐，需要 App 自行退出，详见 README「正交投影」。
   */
  projection?: ProjectionMode;
}

export class S3MLayer {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  readonly options: S3MLayerOptions;
  readonly pickable: boolean;
  onStats: (stats: Stats) => void;
  onReady: (entry: S3MDatasetEntry) => void;
  onPick: (result: PickResult | null) => void;
  onError: (error: unknown) => void;

  /** 宿主地图。赋值时自动同步 viewer 的地理坐标适配器（0.2.x 允许直接赋值的兼容行为） */
  private _map: MapLike | null = null;

  get map(): MapLike | null {
    return this._map;
  }

  set map(map: MapLike | null) {
    this._map = map;
    this.viewer.geo = map ? createMapLibreGeoAdapter(map) : null;
  }

  /** 底层渲染内核（s3m-three）。直接暴露，方便高级用法绕过图层自己喂帧 */
  readonly viewer: S3MViewer;

  /** 正交不可用只告警一次 */
  private _orthoWarned = false;
  private _projection: ProjectionMode = 'perspective';
  /** 正交插值参数：0 = 纯透视，1 = 纯正交，过渡期间由 animator 平滑推进 */
  private _projectionT = 0;

  private _ensureProjectionChannel(): void {
    if (this.viewer.animator.has('projection.t')) return;
    this.viewer.animator.register('projection.t', {
      dim: 1,
      read: (out) => {
        out[0] = this._projectionT;
      },
      write: (v) => {
        this._projectionT = v[0];
        this.map?.triggerRepaint();
      },
    });
  }

  private readonly _onProjectionChange = (): void => {
    // MapLibre v6 起 setProjection() 会 fire 'projectiontransition'。
    // CRS 换了，世界坐标体系也换了，GeoAdapter 与锚点必须重建。
    if (this.map) this.viewer.geo = createMapLibreGeoAdapter(this.map);
    this.viewer.recomputeAnchors();
  };

  /**
   * WebGL 上下文是否处于丢失状态（丢失→恢复之间为 true）。
   * 期间 render 会被 S3MViewer 内部短路，避免刷一堆 GL 错误。
   */
  private _contextLost = false;

  /** 地图事件监听器是否已挂载，避免上下文恢复重加图层时重复绑定 */
  private _listenersAttached = false;

  private readonly _onContextLost = (): void => {
    this._contextLost = true;
  };

  private readonly _onContextRestored = (): void => {
    this._contextLost = false;
    const map = this.map;
    if (!map) return;
    // MapLibre 在 webglcontextlost 时销毁 style 并丢弃自定义图层（自定义图层
    // 无法序列化进 style），恢复后不会自动加回。这里手动重新 addLayer；onAdd 会识别
    // 「已挂载」并原地换新 renderer，保留已加载的瓦片，不重新拉取。
    try {
      const getLayer = map.getLayer;
      const addLayer = map.addLayer;
      const has = typeof getLayer === 'function' ? getLayer.call(map, this.id) : undefined;
      if (!has) {
        if (typeof addLayer === 'function') addLayer.call(map, this);
      } else {
        // 极端情况下图层仍在（理论上不会）：确保 renderer 指向新上下文
        const gl = this._mapGl();
        if (gl) this.viewer.restoreContext(gl);
      }
    } catch (e) {
      console.warn('[s3m] WebGL 上下文恢复后重加图层失败，请手动 map.addLayer(layer)', e);
    }
    map.triggerRepaint();
  };

  /** 从画布取回当前的 WebGL 上下文（恢复后已是新上下文） */
  private _mapGl(): WebGLRenderingContext | WebGL2RenderingContext | null {
    const canvas = this.map?.getCanvas?.();
    if (!canvas) return null;
    return (
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null)
    );
  }

  constructor(options: S3MLayerOptions = {}) {
    this.id = options.id ?? 's3m';
    this.options = options;
    this.pickable = options.pickable !== false;
    this._projection = options.projection === 'orthographic' ? 'orthographic' : 'perspective';
    this._projectionT = this._projection === 'orthographic' ? 1 : 0;
    this.onStats = options.onStats ?? (() => {});
    this.onReady = options.onReady ?? (() => {});
    this.onPick = options.onPick ?? (() => {});
    this.onError = options.onError ?? ((e) => console.warn('[s3m]', e));

    this.viewer = new S3MViewer({
      configUrl: options.configUrl,
      datasets: options.datasets,
      style: options.style,
      ground: options.ground,
      pickable: options.pickable,
      maxTiles: options.maxTiles,
      maxConcurrent: options.maxConcurrent,
      useWorker: options.useWorker,
      lodRangeScale: options.lodRangeScale,
      buildTile: options.buildTile,
      light: options.light,
      toneMapping: options.toneMapping,
      toneMappingExposure: options.toneMappingExposure,
      totalMaxTiles: options.totalMaxTiles,
      attributes: options.attributes,
      // 三个宿主能力全部走回调注入，viewer 不碰任何地图 API
      onRequestRepaint: () => this.map?.triggerRepaint(),
      getBearing: () => this.map?.getBearing?.() ?? 0,
      onStats: (s) => this.onStats(s),
      onReady: (e) => this.onReady(e),
      onPick: (r) => this.onPick(r),
      onError: (e) => this.onError(e),
    });
  }

  /* ---------------------------------------------------------------- 生命周期 */

  onAdd(map: MapLike, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    // setter 会顺带把宿主地理坐标能力（MapLibre v5+ 任意 CRS / 自定义投影，
    // 老版本回退标准墨卡托）同步进 viewer
    this.map = map;

    if (this.viewer.renderer) {
      // 上下文恢复路径：onAdd 被再次触发（map.addLayer），原地换新 renderer，
      // 保留已加载的场景与瓦片，不重建、不重拉。
      this.viewer.restoreContext(gl);
    } else {
      this.viewer.mount(map.getCanvas(), gl);
    }

    // 监听器只在首次挂载时绑定一次；上下文恢复重加图层时不重复绑定，
    // 否则 click / projectiontransition 等会被挂多次。
    if (!this._listenersAttached) {
      map.on('click', this._onClick);
      if (typeof map.on === 'function') {
        map.on('projectiontransition', this._onProjectionChange);
        map.on('webglcontextlost', this._onContextLost);
        map.on('webglcontextrestored', this._onContextRestored);
      }
      this._listenersAttached = true;
    }
  }

  onRemove(): void {
    this.map?.off('click', this._onClick);
    if (typeof this.map?.off === 'function') {
      this.map.off('projectiontransition', this._onProjectionChange);
      this.map.off('webglcontextlost', this._onContextLost);
      this.map.off('webglcontextrestored', this._onContextRestored);
    }
    this._listenersAttached = false;
    this._contextLost = false;
    this.viewer.unmount();
    this.viewer.geo = null;
    this.map = null;
  }

  /* ---------------------------------------------------------------- 渲染 */

  /** 从 render 参数里取出 world→clip 矩阵，兼容 MapLibre v4 / v5 与 Mapbox 两种签名 */
  private _extractMatrix(arg: unknown): ArrayLike<number> | null {
    if (Array.isArray(arg)) return arg as number[];
    if (arg instanceof Float64Array || arg instanceof Float32Array) return arg;
    const o = arg as
      | { defaultProjectionData?: { mainMatrix?: ArrayLike<number> }; modelViewProjectionMatrix?: ArrayLike<number> }
      | null
      | undefined;
    return o?.defaultProjectionData?.mainMatrix ?? o?.modelViewProjectionMatrix ?? null;
  }

  /**
   * 正交模式：把透视 MVP 换成同视角正交 MVP（支持 t 混合）。
   * 返回 null = 本帧保持透视（拿不到独立投影矩阵 / 矩阵不同源），只告警一次。
   */
  private _applyOrtho(arg: unknown, mvp: Matrix4, t = 1): Matrix4 | null {
    if (t <= 0) return mvp;
    const { nearZ, farZ } = extractNearFar(arg);
    const projectionMatrix = extractProjectionMatrix(arg);
    if (!projectionMatrix) {
      this._warnOrtho('render() 输入里没有独立的投影矩阵（需要 MapLibre ≥ 5）');
      return null;
    }
    const built = buildBlendedMVP(
      { projectionMatrix, mvp: mvp.elements, nearZ, farZ },
      {
        distance: this.map?.transform?.cameraToCenterDistance ?? 0,
        fov: this._frameFov(arg),
        aspect: this._canvasAspect(),
      },
      t
    );
    if (!built) {
      this._warnOrtho('拿到的投影矩阵与 MVP 不同源（反推结果不是仿射变换）');
      return null;
    }
    return built.matrix;
  }

  /** 正交不可用只告警一次，不每帧刷屏 */
  private _warnOrtho(reason: string): void {
    if (this._orthoWarned) return;
    this._orthoWarned = true;
    console.warn(`[s3m] 正交模式不可用：${reason}，本帧保持透视`);
  }

  /**
   * 本帧垂直视场角（弧度）。取 render() 入参的 fov（≥5 直接给弧度），
   * 退回 transform.fovInRadians。**不用 transform.fov**：v5 起它是「度」。
   */
  private _frameFov(arg: unknown): number {
    return extractFovRadians(arg, this.map?.transform?.fovInRadians) ?? DEFAULT_FOV;
  }

  private _canvasAspect(): number {
    const canvas = this.map?.getCanvas?.();
    if (!canvas || !canvas.height) return 1;
    return canvas.width / canvas.height;
  }

  /**
   * 切换投影模式，可带平滑过渡。
   *
   * 正交只影响本层：底图瓦片、地形、DOM Marker / 弹窗仍走 MapLibre 的透视
   * 投影，和正交层差 ≈ 楼高 / 相机距（城市尺度几十到上百像素），App 需要
   * 自行把这些层退出。拾取、选中描边、按单体着色/隐藏/抬高不受影响。
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
      this.map?.triggerRepaint();
      return;
    }

    this._ensureProjectionChannel();
    this.viewer.animator.to('projection.t', targetT, {
      ...transition,
      duration,
      easing: transition?.easing ?? 'easeInOutCubic',
      onComplete: () => {
        this._projectionT = targetT;
        this.map?.triggerRepaint();
      },
    });
    this.map?.triggerRepaint();
  }

  /** 当前投影模式 */
  get projection(): ProjectionMode {
    return this._projection;
  }

  /** 当前正交插值比例（0 = 纯透视，1 = 纯正交） */
  get projectionT(): number {
    return this._projectionT;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, arg: unknown): void {
    const map = this.map;
    const anchor = this.viewer.sceneAnchor;
    if (!map || !anchor) return;
    // 上下文丢失期间（丢失→恢复之间）不要渲染：renderer 指向失效的 gl，
    // 真正恢复由 _onContextRestored → restoreContext 接管。
    if (this._contextLost) return;

    const matrix = this._extractMatrix(arg);
    if (!matrix) return;

    // 正交模式：视图矩阵从 MapLibre 输入反推（P⁻¹×MVP），不是自建相机，
    // 支持按 _projectionT 在透视与正交之间平滑插值过渡。
    let mvpMat = new Matrix4().fromArray(matrix as number[]);
    if (this._projectionT > 0.0001) {
      mvpMat = this._applyOrtho(arg, mvpMat, this._projectionT) ?? mvpMat;
    }

    const canvas = map.getCanvas();
    const s = anchor.meterInMercator;

    // 相机在场景 ENU 中的位置（FreeCamera 不可用时退回原点，只影响 LOD 精度）
    let camEnu: [number, number, number] = [0, 0, 0];
    try {
      const p = map.getFreeCameraOptions?.()?.position;
      if (p) {
        camEnu = [(p.x - anchor.x) / s, -(p.y - anchor.y) / s, (p.z - anchor.z) / s];
      }
    } catch {
      /* 忽略 */
    }

    const needsNextFrame = this.viewer.renderFrame({
      mvp: mvpMat.elements,
      cameraEnu: camEnu,
      fovRad: this._frameFov(arg),
      canvasHeight: canvas.height,
    });

    // 动态着色 / 瓦片加载中 / 瓦片层级或可见性改变，都需要继续驱动下一帧
    if (needsNextFrame) map.triggerRepaint();
  }

  /* ---------------------------------------------------------------- 事件与拾取 */

  private _onClick = (e: MapMouseEventLike): void => {
    if (!this.pickable) return;
    const hit = this.pickFromEvent(e);
    if (!hit) {
      this.select(null);
      return;
    }
    this.select(hit);
    this.onPick(hit);
  };

  /** 事件对象（宿主 MouseEvent 或原生事件）→ 拾取结果 */
  pickFromEvent(e: MapMouseEventLike | MouseEvent): PickResult | null {
    const canvas = this.map?.getCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const oe = (e as MapMouseEventLike).originalEvent ?? (e as MouseEvent);
    return this.viewer.pick(oe.clientX - rect.left, oe.clientY - rect.top);
  }

  /** 按 canvas 左上角的 CSS 像素坐标拾取 */
  pick(x: number, y: number): PickResult | null {
    return this.viewer.pick(x, y);
  }

  /** 拾取指定屏幕像素对应的世界坐标与场景位置 */
  pickPosition(x: number, y: number): { lngLat: [number, number]; altitude: number; point: [number, number, number] } | null {
    return this.viewer.pickPosition(x, y);
  }

  /** 沿视线方向穿透拾取多个单体，按由近至远排序返回 */
  drillPick(x: number, y: number, limit = 10): PickResult[] {
    return this.viewer.drillPick(x, y, limit);
  }

  /** 获取指定屏幕像素对应的场景射线 */
  getRayAt(x: number, y: number): Ray | null {
    return this.viewer.getRayAt(x, y);
  }

  /** 选中/取消选中单体 */
  select(result: PickResult | null, opts: { silent?: boolean } = {}): void {
    this.viewer.select(result, opts);
  }

  /** 获取指定 SMID 单体的经纬度包围盒 */
  getFeatureBounds(smid: number): [[number, number], [number, number]] | null {
    return this.viewer.getFeatureBounds(smid);
  }

  /**
   * 视角聚焦飞向指定 SMID 单体。
   * @param smid 单体 SMID
   * @param options 传给宿主 map.fitBounds 的参数（如 padding, maxZoom, duration 等）
   * @returns 是否成功找到并触发飞向
   */
  flyToFeature(smid: number, options?: Record<string, unknown>): boolean {
    const bounds = this.viewer.getFeatureBounds(smid);
    if (!bounds || !this.map) return false;

    const mapAny = this.map as unknown as {
      fitBounds?: (bounds: [[number, number], [number, number]], opts?: Record<string, unknown>) => void;
    };
    if (typeof mapAny.fitBounds === 'function') {
      mapAny.fitBounds(bounds, {
        padding: 50,
        maxZoom: 19,
        duration: 1200,
        ...options,
      });
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- 数据集 */

  /** 追加一个数据集。图层 addLayer 之前调用会抛错。 */
  addDataset(ds: S3MDatasetOptions): Promise<S3MDatasetEntry> {
    return this.viewer.addDataset(ds);
  }

  removeDataset(id: string): void {
    this.viewer.removeDataset(id);
  }

  /** 清空当前所有数据集 */
  clearDatasets(): void {
    this.viewer.clearDatasets();
  }

  setDatasetVisible(id: string, visible: boolean): void {
    this.viewer.setDatasetVisible(id, visible);
  }

  /** 获取指定数据集的垂直高程偏移（米） */
  getDatasetHeight(id?: string): number {
    return this.viewer.getDatasetHeight(id);
  }

  /** 设置指定数据集的垂直高程偏移（米），正数抬升，负数下降 */
  setDatasetHeight(idOrHeight: string | number, heightOffset?: number): void {
    this.viewer.setDatasetHeight(idOrHeight, heightOffset);
  }

  /** 动态设置指定数据集的垂直对齐基准（'origin' | 'bottom' | 'top' | 'center'） */
  setDatasetAlign(
    idOrAlign: string | DatasetAlignment,
    align?: DatasetAlignment
  ): void {
    this.viewer.setDatasetAlign(idOrAlign, align);
  }

  /** @internal 语义高度对齐计算代理，供内部与测试使用 */
  _computeAlignOffset(tileset: unknown, align?: DatasetAlignment): number {
    return this.viewer.computeAlignOffset(tileset as never, align);
  }

  /* ---------------------------------------------------------------- 样式 */

  /** 动态设置光照配置（强度、颜色、朝向模式、太阳方位角/仰角等） */
  setLight(options: Partial<LightOptions>): void {
    this.viewer.setLight(options);
  }

  /** 获取当前光照配置快照 */
  getLight(): LightOptions {
    return this.viewer.getLight();
  }

  /** 动态设置色调映射模式与曝光度（可传 THREE.NoToneMapping 还原真实材质与底图通透度） */
  setToneMapping(toneMapping: ToneMapping, exposure = 1.0): void {
    this.viewer.setToneMapping(toneMapping, exposure);
  }

  /** 获取当前色调映射模式与曝光度 */
  getToneMapping(): { toneMapping: ToneMapping; toneMappingExposure: number } {
    return this.viewer.getToneMapping();
  }

  /** 动态设置图层整体透明度 (0.0 ~ 1.0)，可带过渡 */
  setOpacity(opacity: number, transition?: TransitionOptions): void {
    this.viewer.setOpacity(opacity, transition);
  }

  /** 合并并应用样式。只改 uniform 的项不会触发几何/着色器重建。可带过渡。 */
  setStyle(patch: Partial<S3MStyle> = {}, transition?: TransitionOptions): void {
    this.viewer.setStyle(patch, transition);
  }

  getStyle(): S3MStyle & { modeLabel: string } {
    return this.viewer.getStyle();
  }

  /** 全局棱线开关，可带淡入淡出 */
  setEdges(enabled: boolean, transition?: TransitionOptions): void {
    this.viewer.setEdges(enabled, transition);
  }

  /** 挂载预制棱线缓存（source-creases.f32 这类 Float32 段缓冲），比逐网格现算快得多 */
  loadCreases(url: string): Promise<void> {
    return this.viewer.loadCreases(url);
  }

  /** 移除并释放预制棱线缓存 */
  clearCreases(): void {
    this.viewer.clearCreases();
  }

  /* ---------------------------------------------------------------- 单体样式 & 过滤 */

  setFeatureStyle(smid: number, style: FeatureStyle): void {
    this.viewer.setFeatureStyle(smid, style);
  }

  setFeaturesStyle(smids: number[], style: FeatureStyle): void {
    this.viewer.setFeaturesStyle(smids, style);
  }

  /** 单体平移动画（米，场景 ENU 增量）。平移后拾取 / 描边 / 棱线自动跟随 */
  moveFeature(
    smid: number,
    translation: [number, number, number],
    transition?: TransitionOptions
  ): void {
    this.viewer.moveFeature(smid, translation, transition);
  }

  /** 单体按增量平移（相对当前位置） */
  moveFeatureBy(
    smid: number,
    delta: [number, number, number],
    transition?: TransitionOptions
  ): void {
    this.viewer.moveFeatureBy(smid, delta, transition);
  }

  /**
   * 让单体进行刚体姿态旋转（在 GPU 顶点着色器中以 pivot 轴心进行 3x3 矩阵旋转变换）。
   *
   * @param smid 单体 SMID
   * @param rotation 旋转弧度或姿态：数字（绕 Z 轴 yaw 弧度）| [rx, ry, rz] 欧拉角 | [x,y,z,w] 四元数 | Euler/Quaternion/Matrix
   * @param pivot 旋转中心轴心点 [px, py, pz]（局部坐标，默认 [0, 0, 0]）
   * @param transition 动画过渡参数
   */
  rotateFeature(
    smid: number,
    rotation: NonNullable<FeatureStyle['rotation']>,
    pivot?: [number, number, number],
    transition?: TransitionOptions
  ): void {
    this.viewer.rotateFeature(smid, rotation, pivot, transition);
  }

  /** 让单体增量旋转（相对当前旋转角度） */
  rotateFeatureBy(
    smid: number,
    deltaRotation: number | [number, number, number],
    pivot?: [number, number, number],
    transition?: TransitionOptions
  ): void {
    this.viewer.rotateFeatureBy(smid, deltaRotation, pivot, transition);
  }

  /**
   * 双纹理 GPU 交叉淡化（跨状态 / 专题图平滑过渡）。
   *
   * 采用双纹理 (uBatchTex + uBatchTex2 + uBatchMix) 硬件混合，
   * 即使几千上万栋建筑全量切换配色/高度/显隐/姿态，也无需在 CPU 逐单体创建通道，
   * 由 GPU 顶点与片元着色器以 60FPS 零成本硬件插值完成过渡。
   */
  crossFadeStyles(
    targetStyles: Map<number, FeatureStyle> | Record<string | number, FeatureStyle>,
    transition?: TransitionOptions
  ): void {
    this.viewer.crossFadeStyles(targetStyles, transition);
  }

  /** 单体样式过渡：颜色 / 抬高 / 透明度 / 平移可任意组合 */
  animateFeature(smid: number, style: Partial<FeatureStyle>, transition?: TransitionOptions): void {
    this.viewer.animateFeature(smid, style, transition);
  }

  /** 批量单体样式过渡，支持 `stagger` 错峰 */
  animateFeatures(
    smids: number[],
    style: Partial<FeatureStyle>,
    transition?: TransitionOptions
  ): void {
    this.viewer.animateFeatures(smids, style, transition);
  }

  /** 切换着色模式，用「压暗 → 换 → 亮回来」代替硬切 */
  setMode(mode: S3MStyle['mode'], options?: { duration?: number; dim?: number }): Promise<void> {
    return this.viewer.setMode(mode, options);
  }

  /** 单体沿折线运动（弧长参数化，缓动作用在距离上） */
  followPath(
    smid: number,
    points: Path | ArrayLike<number> | Array<[number, number, number]>,
    options?: PathFollowOptions
  ): void {
    this.viewer.followPath(smid, points, options);
  }

  /** 停下路径运动（停在当前位置） */
  stopPath(smid: number): void {
    this.viewer.stopPath(smid);
  }

  /** 动画调度器：取消 / 直跳 / 改预算都走这里 */
  get animation(): S3MViewer['animator'] {
    return this.viewer.animator;
  }

  getFeatureStyle(smid: number): FeatureStyle | null {
    return this.viewer.getFeatureStyle(smid);
  }

  getFeatureStyles(): Map<number, FeatureStyle> {
    return this.viewer.getFeatureStyles();
  }

  removeFeatureStyle(smid: number): void {
    this.viewer.removeFeatureStyle(smid);
  }

  clearFeatureStyles(): void {
    this.viewer.clearFeatureStyles();
  }

  setAttributeSource(options: AttributeQueryOptions | null): void {
    this.viewer.setAttributeSource(options);
  }

  getLoadedSmids(): number[] {
    return this.viewer.getLoadedSmids();
  }

  auditBatches(): BatchAudit {
    return this.viewer.auditBatches();
  }

  getThematicField(): string | null {
    return this.viewer.getThematicField();
  }

  setThematicColors(colors: Map<number, string> | null, field = 'custom'): void {
    this.viewer.setThematicColors(colors, field);
  }

  clearThematic(): void {
    this.viewer.clearThematic();
  }

  getFilterField(): string | null {
    return this.viewer.getFilterField();
  }

  filterByField(options: FieldFilterOptions): Promise<FieldFilterResult> {
    return this.viewer.filterByField(options);
  }

  clearFieldFilter(): void {
    this.viewer.clearFieldFilter();
  }

  getElevationField(): string | null {
    return this.viewer.getElevationField();
  }

  elevateByField(options: FieldElevationOptions): Promise<FieldElevationResult> {
    return this.viewer.elevateByField(options);
  }

  setThematicElevation(elevations: Map<number, number> | null, field = 'custom'): void {
    this.viewer.setThematicElevation(elevations, field);
  }

  clearThematicElevation(): void {
    this.viewer.clearThematicElevation();
  }

  colorByField(options: ColorByFieldOptions): Promise<ThematicResult> {
    return this.viewer.colorByField(options);
  }

  setFilter(filter: S3MFilter | null): void {
    this.viewer.setFilter(filter);
  }

  getFilter(): S3MFilter | null {
    return this.viewer.getFilter();
  }

  clearFilter(): void {
    this.viewer.clearFilter();
  }

  /* ---------------------------------------------------------------- 3D 物理地表与基坑 */

  /** 设置 3D 物理地表面渲染模式：'none' 关闭 | 'translucent' 半透明透视 | 'excavate' 基坑开挖 */
  setGroundMode(mode: GroundMode): void {
    this.viewer.setGroundMode(mode);
  }

  /** 设置 3D 物理地表面不透明度 (0~1) */
  setGroundOpacity(opacity: number): void {
    this.viewer.setGroundOpacity(opacity);
  }

  /** 设置基坑开挖范围 [minX, minY, maxX, maxY]（米，场景 ENU 坐标） */
  setExcavationBounds(bounds: [number, number, number, number] | null): void {
    this.viewer.setExcavationBounds(bounds);
  }

  /**
   * 开关「物理地表作为深度遮挡源」：开启后地表以下的几何被真正切掉，
   * 而不是透过半透明地表显露。与 MapLibre terrain 共用同一深度缓冲，互不冲突。
   */
  setGroundOcclude(enabled: boolean): void {
    this.viewer.setGroundOcclude(enabled);
  }

  /** @internal 3D 物理地表面管理器（GroundManager 由 viewer 持有） */
  get groundManager(): S3MViewer['groundManager'] {
    return this.viewer.groundManager;
  }

  /* ---------------------------------------------------------------- 内部状态 */

  getAllMeshes(): ReturnType<S3MViewer['getAllMeshes']> {
    return this.viewer.getAllMeshes();
  }

  flushOverrides(): void {
    this.viewer.flushOverrides();
  }

  /** @internal 内部状态纹理烘焙代理，保留供回归单测与钩子使用 */
  _applyOverridesToMesh(mesh: Parameters<S3MViewer['_applyOverridesToMesh']>[0]): void {
    this.viewer._applyOverridesToMesh(mesh);
  }

  /* ---------------------------------------------------------------- LOD */

  /** 当前 LOD 切换距离缩放系数 */
  get lodRangeScale(): number {
    return this.viewer.lodRangeScale;
  }

  /**
   * 动态调整 LOD 切换范围缩放系数。
   * scale > 1 时倾向保留粗模（降低瓦片请求与面数）；scale < 1 时提前细化加载高精瓦片。
   */
  setLodRangeScale(scale: number, datasetId?: string): void {
    this.viewer.setLodRangeScale(scale, datasetId);
  }

  /* ---------------------------------------------------------------- 只读属性 */

  get renderer(): S3MViewer['renderer'] {
    return this.viewer.renderer;
  }

  get scene(): S3MViewer['scene'] {
    return this.viewer.scene;
  }

  get camera(): S3MViewer['camera'] {
    return this.viewer.camera;
  }

  get picker(): S3MViewer['picker'] {
    return this.viewer.picker;
  }

  get uniforms(): S3MViewer['uniforms'] {
    return this.viewer.uniforms;
  }

  get style(): S3MStyle {
    return this.viewer.style;
  }

  get outlineMaterial(): S3MViewer['outlineMaterial'] {
    return this.viewer.outlineMaterial;
  }

  get lineShared(): S3MViewer['lineShared'] {
    return this.viewer.lineShared;
  }

  get edgeMaterial(): S3MViewer['edgeMaterial'] {
    return this.viewer.edgeMaterial;
  }

  get selectionEdgeMaterial(): S3MViewer['selectionEdgeMaterial'] {
    return this.viewer.selectionEdgeMaterial;
  }

  get datasets(): Map<string, S3MDatasetEntry> {
    return this.viewer.datasets;
  }

  /** 场景主锚点（ENU 原点对应的世界坐标） */
  get sceneAnchor(): { x: number; y: number; z: number; meterInMercator: number; altitude?: number } | null {
    return this.viewer.sceneAnchor;
  }

  set sceneAnchor(val: { x: number; y: number; z: number; meterInMercator: number; altitude?: number } | null) {
    this.viewer.sceneAnchor = val;
  }

  get attributeQuery(): S3MViewer['attributeQuery'] {
    return this.viewer.attributeQuery;
  }

  get fps(): number {
    return this.viewer.fps;
  }

  get stats(): Stats {
    return this.viewer.stats;
  }

  /** 所有数据集合并后的经纬度包围盒 */
  getBounds(): [[number, number], [number, number]] | null {
    return this.viewer.getBounds();
  }

  dispose(): void {
    this.onRemove();
  }
}

export { S3MLayer as default };
