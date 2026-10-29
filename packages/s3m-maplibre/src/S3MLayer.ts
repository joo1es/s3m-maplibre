/**
 * S3M × MapLibre / Mapbox 图层（薄适配层）
 *
 * 这个文件只做「宿主协议 ↔ s3m-three 渲染内核」的翻译，不含任何渲染逻辑：
 *
 *   onAdd(map, gl)      → 建 GeoAdapter、经 HostRenderer.mountViewer 挂载内核、挂地图事件
 *   render(gl, arg)     → 从 MapLibre 每帧输入里抽出 world→clip 矩阵与相机位置
 *                         （近平面缩放 / 正交混合是 MapLibre 专属拼接），
 *                         交给 HostRenderer.driveFrame 喂内核并按需续帧
 *   click / projectiontransition → 转成 viewer 的拾取与锚点重算
 *
 * 宿主无关的部分（持有 S3MViewer、投影模式、近平面缩放、requestRepaint / getBearing
 * 钩子接线、生命周期 mount / unmount）全部在 s3m-three 的 HostRenderer 基类里；
 * 渲染、样式、拾取、选中、棱线、单体状态在 S3MViewer 里。
 * 接入其他地图（ArcGIS / Cesium…）时继承 HostRenderer，只补各家专属胶水。
 * 纯 three 宿主（不接地图）请直接用 S3MViewer。
 *
 * 兼容性：图层只依赖 `MapLike` 这组鸭子类型接口，MapLibre GL JS v4/v5 与
 * Mapbox GL JS v2/v3 都可以直接 `map.addLayer(layer)`，不引入任一方的类型依赖。
 */
import { HostRenderer } from 's3m-three';
import type { S3MViewer } from 's3m-three';
import type {
  S3MViewerOptions,
  S3MStyle,
  EdgesOption,
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
  LightingPreset,
  TransitionOptions,
  Path,
  PathFollowOptions,
  GPUPathOptions,
  GPUPathManager,
  LngLatAlt,
  MeasureResult,
  LineOfSightOptions,
  LineOfSightResult,
  ClipOptions,
  SkylineResult,
  ViewshedResult,
} from 's3m-three';
import type { Object3D, Ray, ToneMapping } from 'three';
import { Matrix4 } from 'three';
import {
  buildOrthoMVP,
  buildBlendedMVP,
  buildNearScaledMVP,
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
  /**
   * 近裁剪面缩放系数（0 < scale < 1，默认 1 = 不改，行为与旧版一致）。
   *
   * MapLibre 的近裁剪面是硬编码的 `nearZ = canvasHeight / 50`（CSS 像素单位），
   * zoom 16.5 / 纬度 31° 时约合**离相机 13 米**——相机推进到楼体十几米以内，
   * 楼面整片被裁掉，画面变成空白。MapLibre 没有公开 API 改这个值，所以只能
   * 在本层换一个投影矩阵：只改透视矩阵的 near，视场角与远平面完全不动，
   * 画面与原画面逐点重合，只是近处不再被裁。
   *
   * ```js
   * new S3MLayer({ nearPlaneScale: 0.1 })   // 13 m → 1.3 m，可以贴脸看
   * ```
   *
   * **代价（必须知道）**：near/far 比值变小会让深度缓冲的非线性变陡，远处可用
   * 的深度精度下降，极端值下远景可能出现 z-fighting；同时本层写入的深度值与
   * MapLibre 地形/底图不再完全同尺度，近处的地形遮挡判定会有偏差（远处几乎无差）。
   * 只影响透视模式——正交模式的 near 由它自己的视锥构造决定。
   */
  nearPlaneScale?: number;
}

export class S3MLayer extends HostRenderer {
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  /** 宿主地图。赋值时自动同步 viewer 的地理坐标适配器（0.2.x 允许直接赋值的兼容行为） */
  private _map: MapLike | null = null;

  get map(): MapLike | null {
    return this._map;
  }

  set map(map: MapLike | null) {
    this._map = map;
    this.viewer.geo = map ? createMapLibreGeoAdapter(map) : null;
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

  /**
   * 构造适配器。所有渲染内核选项与宿主开关（id / projection / nearPlaneScale）
   * 都上抛给 `HostRenderer` 基类：基类会创建 `S3MViewer` 并把宿主能力钩子
   * （requestRepaint / getBearing）注入内核，内核不碰任何地图 API。
   */
  constructor(options: S3MLayerOptions = {}) {
    super(options);
  }

  /** 宿主能力钩子：请求下一帧重绘（MapLibre / Mapbox → triggerRepaint） */
  protected requestRepaint(): void {
    this.map?.triggerRepaint();
  }

  /** 宿主方位角（度）：MapLibre v5+ 跟随视角，灯光随之旋转 */
  protected override getBearing(): number {
    return this.map?.getBearing?.() ?? 0;
  }

  /* ---------------------------------------------------------------- 生命周期 */

  onAdd(map: MapLike, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    // setter 会顺带把宿主地理坐标能力（MapLibre v5+ 任意 CRS / 自定义投影，
    // 老版本回退标准墨卡托）同步进 viewer
    this.map = map;

    // mountViewer 内部处理「上下文恢复（已挂载则原地换新 renderer，保留瓦片）」
    // 与「首次挂载」两条路径。
    this.mountViewer(map.getCanvas(), gl);

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
    this.unmountViewer();
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

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, arg: unknown): void {
    const map = this.map;
    const anchor = this.viewer.sceneAnchor;
    if (!map || !anchor) return;
    // 上下文丢失期间（丢失→恢复之间）不要渲染：renderer 指向失效的 gl，
    // 真正恢复由 _onContextRestored → restoreContext 接管。
    if (this._contextLost) return;

    const matrix = this._extractMatrix(arg);
    if (!matrix) return;

    let mvpMat = new Matrix4().fromArray(matrix as number[]);

    // 近平面缩放：MapLibre 的 nearZ 是写死的 canvasHeight/50，贴近模型时会把
    // 整面墙裁掉。这里只在纯透视下换一个 near 更小的投影矩阵，fov / far 不动，
    // 画面与原画面逐点重合；正交模式的 near 由 buildOrthoMVP 自己决定。
    if (this._nearPlaneScale < 1 && this._projectionT < 0.0001) {
      const scaled = buildNearScaledMVP(
        {
          projectionMatrix: extractProjectionMatrix(arg),
          mvp: mvpMat.elements,
          ...extractNearFar(arg),
        },
        this._nearPlaneScale
      );
      if (scaled) mvpMat = scaled;
    }

    // 正交模式：视图矩阵从 MapLibre 输入反推（P⁻¹×MVP），不是自建相机，
    // 支持按 _projectionT 在透视与正交之间平滑插值过渡。
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

    // 矩阵拼接（近缩放 / 正交混合 / 相机 ENU 反推）是 MapLibre 专属，留在上面；
    // 「喂内核 + 按需请求下一帧」是宿主无关逻辑，交给基类的 driveFrame——
    // 内部 requestRepaint() 即本适配器的 map.triggerRepaint()。
    // 动态着色 / 瓦片加载中 / 瓦片层级或可见性改变时内核会要求继续驱动。
    this.driveFrame({
      mvp: mvpMat.elements,
      cameraEnu: camEnu,
      fovRad: this._frameFov(arg),
      canvasHeight: canvas.height,
    });
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

  /** 切换光照预设：'default' 保持现状，'supermap' 对齐 iClient3D 观感 */
  setLightingPreset(preset: LightingPreset): void {
    this.viewer.setLightingPreset(preset);
  }

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

  /**
   * 运行时切换**本图层**的材质质感（`'pbr'` | `'lambert'`）：原位重建本层的 styled
   * 材质，不重拉瓦片、不重建几何。lambert 开销更低，低端设备 / 白模场景适用。
   *
   * 档位是图层级的：同页别的图层不受影响，所以可以「这一层 pbr、那一层 lambert」。
   */
  setMaterialQuality(q: 'pbr' | 'lambert'): void {
    this.viewer.setMaterialQuality(q);
  }

  /** 当前材质质感档位（本层没指定过就是模块级默认） */
  get materialQuality(): 'pbr' | 'lambert' {
    return this.viewer.materialQuality;
  }

  /**
   * 运行时切换**本图层**的颜色管线（`'linear'` | `'direct'`）。
   *
   * `'direct'` = 官方 iClient3D 的 sRGB 直乘管线（`lightingPreset: 'supermap'` 就是它）。
   * 传 `duration > 0` 走 fade-through：压暗 → 换管线（重建材质 + 重传纹理）→ 亮回来，
   * 不重新下载瓦片。不传 = 立即生效。
   *
   * 同页其它图层不受影响 —— 管线和纹理解码都是图层级的。
   */
  setColorPipeline(
    q: 'linear' | 'direct',
    opts?: { duration?: number; dim?: number }
  ): Promise<void> {
    return this.viewer.setColorPipeline(q, opts);
  }

  /** 当前颜色管线（本层没指定过就是模块级默认） */
  get colorPipeline(): 'linear' | 'direct' {
    return this.viewer.colorPipeline;
  }

  /* ------------------------------------------------------------ 三维空间分析 */

  /**
   * 两点量算（三维距离 / 水平距离 / 高差）。
   *
   * 入参直接用 `pickPosition(x, y)` 的返回值，交互（取点、画线、标签）留给应用层。
   */
  measureDistance(a: LngLatAlt, b: LngLatAlt): MeasureResult {
    return this.viewer.measureDistance(a, b);
  }

  /**
   * 经纬度 + 绝对高程 → 场景 ENU 米制坐标。
   * 外围画自定义几何（例如给分析用的底图建筑代理）时要用它做换算。
   */
  lngLatToPoint(p: LngLatAlt): [number, number, number] {
    return this.viewer.lngLatToPoint(p);
  }

  /** 场景 ENU 米制坐标 → 经纬度 + 绝对高程 */
  pointToLngLat(v: [number, number, number]): LngLatAlt {
    return this.viewer.pointToLngLat(v);
  }

  /** 折线长度（三维 + 水平投影） */
  measurePolyline(points: readonly LngLatAlt[]): { length3D: number; lengthHorizontal: number } {
    return this.viewer.measurePolyline(points);
  }

  /** 多边形量算（坡面面积 / 水平投影面积 / 周长） */
  measurePolygon(points: readonly LngLatAlt[]): {
    area3D: number;
    areaHorizontal: number;
    perimeter: number;
  } {
    return this.viewer.measurePolygon(points);
  }

  /**
   * 通视分析。只认本图层已加载的 S3M 几何，底图地形与 MVT 建筑不参与遮挡。
   */
  lineOfSight(a: LngLatAlt, b: LngLatAlt, opts?: LineOfSightOptions): LineOfSightResult {
    return this.viewer.lineOfSight(a, b, opts);
  }

  /**
   * 裁剪 / 剖切（平面、Box、十字）。只影响本图层；传 `null` 取消。
   * 不做封口，剖开后是空壳。
   */
  setClipping(opt: ClipOptions | null): void {
    this.viewer.setClipping(opt);
  }

  /** 当前裁剪配置 */
  get clipping(): ClipOptions | null {
    return this.viewer.clipping;
  }

  /**
   * 天际线分析：用当前视角渲染一次深度图，返回「方位角 → 仰角」曲线。
   * 一次调用 = 一趟额外渲染 + 一次回读，**不要每帧调**（相机停下后算一次即可）。
   * 呈现（2D 曲线 / 遮罩）由应用层画。
   */
  skyline(opts?: {
    width?: number;
    height?: number;
    step?: number;
    include?: readonly Object3D[];
  }): SkylineResult | null {
    return this.viewer.skyline(opts);
  }

  /**
   * 360° 可视域（地面栅格版）：从观察点 6 个方向各渲染一次，返回地面可见性栅格。
   * 一次调用成本明显高于天际线，只在点击 / 松手时算。
   */
  viewshed(opts: {
    origin: LngLatAlt;
    radius: number;
    grid?: number;
    eyeHeight?: number;
    size?: number;
    include?: readonly Object3D[];
  }): ViewshedResult | null {
    return this.viewer.viewshed(opts);
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

  /**
   * 挂 / 摘环境贴图。
   *
   * `setStyle({ metalness })` 想有金属质感必须先有环境图：PBR 的金属几乎没有漫反射，
   * 场景没有 `environment` 时金属度一高就整片发黑。
   *
   * @param source 等距柱状图（2:1 的 .hdr / .jpg / .png）地址或已加载的 three 纹理，`null` = 关闭
   * @param intensity 环境光强度，默认 1
   */
  setEnvironment(
    source: Parameters<S3MViewer['setEnvironment']>[0],
    intensity = 1
  ): Promise<void> {
    return this.viewer.setEnvironment(source, intensity);
  }

  /**
   * 全局棱线开关，可带淡入淡出。
   *
   * 传 `true` / `'line'` 是折边线，`'hull'` 是背面外扩轮廓，`'offset'` 是折边线
   * 沿边法线外推，数组可叠加（如 `['line', 'hull']`）。见 `EdgesOption`。
   */
  setEdges(edges: EdgesOption, transition?: TransitionOptions): void {
    this.viewer.setEdges(edges, transition);
  }

  /**
   * 手动预热另一种 `shading` 变体（`flat` / `smooth`）。
   *
   * 构造选项 `prewarmShading` 默认已开，首帧后会自动做一次；只有在你关掉自动预热、
   * 又想在某个时机（比如进入编辑模式前）自己预热时才需要调它。
   */
  prewarmShading(): Promise<void> {
    return this.viewer.prewarmShading();
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

  /**
   * 注册 GPU 路径到路径库
   * @param points 折线点数组或 Path 实例
   * @param opts 选项（可指定路径 ID 或闭合）
   * @returns 路径 ID
   */
  registerGPUPath(
    points: Path | ArrayLike<number> | Array<[number, number, number]>,
    opts?: { id?: number; name?: string; closed?: boolean }
  ): number {
    return this.viewer.registerGPUPath(points, opts);
  }

  /**
   * 注销 GPU 路径
   */
  unregisterGPUPath(id: number): boolean {
    return this.viewer.unregisterGPUPath(id);
  }

  /**
   * 获取 GPUPathManager 实例
   */
  getGPUPathManager(): GPUPathManager {
    return this.viewer.getGPUPathManager();
  }

  /**
   * 将单体绑定到 GPU 路径动画（智慧交通车流 / 大批量巡检无人机）
   * @param smid 单体 ID
   * @param path 路径 ID 或新的路径折线
   * @param options 动画配置（速度、相位、循环模式、自动朝向等）
   */
  bindGPUPath(
    smid: number,
    path: number | Path | ArrayLike<number> | Array<[number, number, number]>,
    options?: Omit<GPUPathOptions, 'pathId'>
  ): number {
    return this.viewer.bindGPUPath(smid, path, options);
  }

  /**
   * 解绑单体的 GPU 路径动画
   */
  unbindGPUPath(smid: number): void {
    this.viewer.unbindGPUPath(smid);
  }

  /**
   * 手动设置单体在 GPU 路径上的归一化进度（0.0 ~ 1.0）
   */
  setGPUPathProgress(smid: number, progress: number): void {
    this.viewer.setGPUPathProgress(smid, progress);
  }

  /**
   * 设置全局 GPU 路径时间（秒）
   */
  setGPUPathTime(time: number, autoAdvance = false): void {
    this.viewer.setGPUPathTime(time, autoAdvance);
  }

  /**
   * 获取全局 GPU 路径时间（秒）
   */
  getGPUPathTime(): number {
    return this.viewer.getGPUPathTime();
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

  /** 当前 LOD 判定屏幕高度的 DPR 上限。Infinity = 不截断 */
  get lodPixelRatioCap(): number {
    return this.viewer.lodPixelRatioCap;
  }

  /**
   * 动态调整 LOD 判定屏幕高度的 DPR 上限（默认 Infinity = 不截断，行为与旧版一致）。
   *
   * 3x DPR 手机上 LOD 是按物理像素高度算的，细化层数与瓦片数都远多于桌面；
   * 传 2 即「按 CSS 高度 × 2 截断」，砍掉超采样余量。代价是每块瓦片的屏幕投影
   * 放大同样倍数，几何与纹理精度同步变差，所以默认不开、由接入方按设备档位决定。
   */
  setLodPixelRatioCap(cap: number): void {
    this.viewer.setLodPixelRatioCap(cap);
  }

  /** 当前纹理缓存条数上限 */
  get maxImageCache(): number {
    return this.viewer.maxImageCache;
  }

  /**
   * 动态调整纹理缓存条数（默认 128）。
   * 一条对应一张已解码的瓦片纹理，1024² RGBA 约 4MB；低端设备建议 32~48。
   * 与 `maxTextureSize` 配合：后者降单张尺寸，这条降张数。
   */
  setMaxImageCache(n: number, datasetId?: string): void {
    this.viewer.setMaxImageCache(n, datasetId);
  }

  /** 当前每个数据集的驻留面数预算。Infinity = 不限制 */
  get maxTriangles(): number {
    return this.viewer.maxTriangles;
  }

  /**
   * 动态调整每个数据集驻留三角形总数的软上限（默认 Infinity = 不限制）。
   * 与 `maxTiles` 并行生效：瓦片数管不住的场景（精模大面片）用这条做刹车。
   */
  setMaxTriangles(n: number, datasetId?: string): void {
    this.viewer.setMaxTriangles(n, datasetId);
  }

  /** 当前每个数据集的驻留显存/内存字节预算。Infinity = 不限制 */
  get maxMemory(): number {
    return this.viewer.maxMemory;
  }

  /**
   * 动态调整每个数据集驻留显存/内存字节总数的软上限（默认 Infinity = 不限制）。
   * 瓦片几何与纹理显存超限时触发主动 make-before-break 淘汰。
   */
  setMaxMemory(bytes: number, datasetId?: string): void {
    this.viewer.setMaxMemory(bytes, datasetId);
  }

  /** 当前各向异性过滤上限。Infinity = 取 GPU 最大值 */
  get anisotropyCap(): number {
    return this.viewer.anisotropyCap;
  }

  /**
   * 调整各向异性过滤上限（默认 Infinity = 取 GPU 最大值，通常 16）。
   * 移动端封到 4 或 8 肉眼通常无差，采样成本明显下降。只影响之后创建的纹理。
   */
  setAnisotropyCap(cap: number): void {
    this.viewer.setAnisotropyCap(cap);
  }

  /** 当前纹理长边像素上限。Infinity = 不限制 */
  get maxTextureSize(): number {
    return this.viewer.maxTextureSize;
  }

  /**
   * 调整纹理长边像素上限（默认 Infinity = 不限制）。
   * 非图集的 RGBA / WebP 纹理会按 2× 盒式滤波减半到上限内，DXT 压缩直传与图集不受影响。
   */
  setMaxTextureSize(n: number): void {
    this.viewer.setMaxTextureSize(n);
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
