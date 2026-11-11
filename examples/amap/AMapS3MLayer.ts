/**
 * S3M × 高德地图 (AMap) 适配层 (Phase 2)
 *
 * 继承宿主无关基类 `HostRenderer`，适配高德地图 JS API v2：
 *   1. 独立 WebGL2 画布覆盖层：由于 Three.js 从 r163 起彻底移除 WebGL1 支持，而高德地图底层
 *      共享上下文为 WebGL1，因此本适配层采用独立的 WebGL2 画布覆盖在地图上，实现现代 Three.js 的
 *      完整渲染能力；
 *   2. 惰性坐标系装配：高德的 `customCoords` 在地图完全就绪后才初始化，本层检测到就绪后自动装配
 *      `createAMapGeoAdapter` 并重新计算锚点；
 *   3. 坐标与相机对齐：通过高德 `customCoords.getCameraParams()` 提取真实透视相机参数，结合
 *      GeoAdapter 出口处 Y 轴归一（+y 取负），计算出纯净的 MVP 矩阵（无镜像负缩放，不破坏三角形绕序与背面剔除）；
 *   4. 单体拾取与事件联动：通过地图点击事件坐标进行 GPU 离屏单体拾取与高亮。
 */
import { Matrix4, PerspectiveCamera } from 'three';
import {
  HostRenderer,
  createAMapGeoAdapter,
  type HostRendererOptions,
  type ProjectionMode,
  type TransitionOptions,
  type PickResult,
  type S3MHost,
} from 's3m-three';

export interface AMapCameraParams {
  near: number;
  far: number;
  fov: number;
  up: [number, number, number];
  lookAt: [number, number, number];
  position: [number, number, number];
}

export interface AMapCustomCoords {
  getCenter?(): [number, number];
  setCenter?(center: [number, number]): void;
  lngLatToCoord?(lngLat: [number, number]): [number, number] | [number, number, number];
  coordToLngLat?(coord: [number, number]): [number, number];
  getCameraParams(): AMapCameraParams;
}

export interface AMapLike extends S3MHost {
  getContainer(): HTMLElement;
  getSize?(): { width: number; height: number };
  on(type: string, listener: (...args: any[]) => void): unknown;
  off(type: string, listener: (...args: any[]) => void): unknown;
  getBearing?(): number;
  getPitch?(): number;
  getZoom?(): number;
  getCenter?(): any;
  render?(): void;
  customCoords?: AMapCustomCoords;
  add?(layer: any): void;
  remove?(layer: any): void;
}

export interface AMapS3MLayerOptions extends HostRendererOptions {
  map?: AMapLike;
  zIndex?: number;
  zooms?: [number, number];
  opacity?: number;
  canvas?: HTMLCanvasElement;
}

export class AMapS3MLayer extends HostRenderer {
  readonly zIndex: number;
  readonly zooms: [number, number];
  readonly opacity: number;

  private _amap: AMapLike | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _cameraHelper = new PerspectiveCamera();
  private _listenersAttached = false;
  private _customLayer: any = null;

  constructor(options: AMapS3MLayerOptions = {}) {
    super(options);
    this.zIndex = options.zIndex ?? 120;
    this.zooms = options.zooms ?? [2, 20];
    this.opacity = options.opacity ?? 1;

    if (options.canvas) {
      this._canvas = options.canvas;
      this._canvas.style.position = 'absolute';
      this._canvas.style.top = '0';
      this._canvas.style.left = '0';
      this._canvas.style.width = '100%';
      this._canvas.style.height = '100%';
      this._canvas.style.pointerEvents = 'none';
      this._canvas.style.zIndex = String(this.zIndex);
    }

    if (options.map) {
      this.setMap(options.map);
    }
  }

  get map(): AMapLike | null {
    return this._amap;
  }

  set map(map: AMapLike | null) {
    this.setMap(map);
  }

  /**
   * 绑定或解绑高德地图实例
   */
  setMap(map: AMapLike | null): void {
    if (this._amap === map) return;

    if (this._amap) {
      this._detachFromMap();
    }

    this._amap = map;
    this._host = map;

    if (map) {
      this._attachToMap(map);
    }
  }

  /** 兼容 AMap.GLCustomLayer / AMap.CustomLayer 的 init 方法签名 */
  init(arg1: any, arg2?: any): void {
    const map = (arg2 ? arg1 : arg1?.getContainer ? arg1 : this._amap) as AMapLike | null;
    if (map) {
      this.setMap(map);
    }
  }

  /** 获取独立渲染 Canvas 元素 */
  getCanvas(): HTMLCanvasElement | null {
    return this._canvas;
  }

  /** 请求下一帧重绘（转发高德 render 或触发自身重绘） */
  protected override requestRepaint(): void {
    if (this._amap) {
      if (typeof this._amap.render === 'function') {
        this._amap.render();
      } else if (typeof this._amap.triggerRepaint === 'function') {
        this._amap.triggerRepaint();
      } else {
        this.render();
      }
    }
  }

  /** 高德方位角（度，正北为 0，顺时针） */
  protected override getBearing(): number {
    return this._amap?.getBearing?.() ?? 0;
  }

  /**
   * 正交投影模式限制：高德适配层第一版保持透视模式
   */
  override setProjection(mode: ProjectionMode, transition?: TransitionOptions): void {
    if (mode === 'orthographic') {
      if (!this._orthoWarned) {
        this._orthoWarned = true;
        console.warn('[s3m-amap] 高德适配层暂不支持正交投影模式，已保持透视模式');
      }
      return;
    }
    super.setProjection(mode, transition);
  }

  /* ---------------------------------------------------------------- 生命周期挂载与卸载 */

  private _attachToMap(map: AMapLike): void {
    const container = map.getContainer();
    if (!container) return;

    if (!this._canvas && typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.className = 'amap-s3m-layer-canvas';
      this._canvas = canvas;
    }

    if (this._canvas) {
      this._canvas.style.position = 'absolute';
      this._canvas.style.top = '0';
      this._canvas.style.left = '0';
      this._canvas.style.width = '100%';
      this._canvas.style.height = '100%';
      this._canvas.style.pointerEvents = 'none'; // 地图手势交互自然穿透
      this._canvas.style.zIndex = String(this.zIndex);
    }

    if (this._canvas && !this.viewer.renderer) {
      const gl = typeof this._canvas.getContext === 'function' ? this._canvas.getContext('webgl2') : null;
      if (gl) {
        this.mountViewer(this._canvas, gl as WebGL2RenderingContext);
        const renderer = (this.viewer as any).renderer;
        if (renderer) {
          renderer.autoClear = true;
        }
      }
    }

    // 优先尝试与高德 AMap.CustomLayer 集成，若无全局 AMap 则直接挂入容器
    if (typeof window !== 'undefined' && typeof (window as any).AMap?.CustomLayer === 'function' && this._canvas) {
      try {
        this._customLayer = new (window as any).AMap.CustomLayer(this._canvas, {
          zIndex: this.zIndex,
          zooms: this.zooms,
          alwaysRender: true,
          render: () => this.render(),
        });
        if (typeof map.add === 'function') {
          map.add(this._customLayer);
        }
      } catch {
        this._customLayer = null;
      }
    }

    if (!this._customLayer && this._canvas && !container.contains(this._canvas)) {
      container.appendChild(this._canvas);
    }

    // 绑定地图事件同步
    if (!this._listenersAttached) {
      this._listenersAttached = true;
      map.on('viewchange', this._onViewChange);
      map.on('move', this._onViewChange);
      map.on('zoomchange', this._onViewChange);
      map.on('rotatechange', this._onViewChange);
      map.on('pitchchange', this._onViewChange);
      map.on('resize', this._onResize);
      map.on('click', this._onClick);
    }

    // 若 customCoords 已可用则立刻装配，未就绪则在 render 中惰性装配
    if (map.customCoords) {
      this.viewer.geo = createAMapGeoAdapter(map);
      this.viewer.recomputeAnchors();
    }

    this._syncCanvasSize();
    this.requestRepaint();
  }

  private _detachFromMap(): void {
    if (this._amap && this._listenersAttached) {
      this._listenersAttached = false;
      this._amap.off('viewchange', this._onViewChange);
      this._amap.off('move', this._onViewChange);
      this._amap.off('zoomchange', this._onViewChange);
      this._amap.off('rotatechange', this._onViewChange);
      this._amap.off('pitchchange', this._onViewChange);
      this._amap.off('resize', this._onResize);
      this._amap.off('click', this._onClick);
    }

    if (this._customLayer && this._amap && typeof this._amap.remove === 'function') {
      try {
        this._amap.remove(this._customLayer);
      } catch {}
      this._customLayer = null;
    }

    if (this._canvas && this._canvas.parentElement) {
      this._canvas.parentElement.removeChild(this._canvas);
    }

    this.viewer.geo = null;
  }

  private _onViewChange = (): void => {
    this.render();
  };

  private _onResize = (): void => {
    this._syncCanvasSize();
    this.render();
  };

  private _syncCanvasSize(): void {
    if (!this._canvas || !this._amap) return;
    const container = this._amap.getContainer();
    if (!container) return;

    const width = container.clientWidth || 300;
    const height = container.clientHeight || 150;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);

    if (this._canvas.width !== targetW || this._canvas.height !== targetH) {
      this._canvas.width = targetW;
      this._canvas.height = targetH;
      this._canvas.style.width = width + 'px';
      this._canvas.style.height = height + 'px';
      if (this.viewer.renderer) {
        this.viewer.renderer.setSize(width, height, false);
      }
    }
  }

  /* ---------------------------------------------------------------- 逐帧渲染驱动 */

  /**
   * 驱动单帧渲染：从高德地图相机提取参数，换算成 MVP 矩阵喂给 S3MViewer 内核
   */
  render(): void {
    if (!this._amap || !this._canvas) return;

    // 1. 惰性装配 GeoAdapter：等待 map.customCoords 准备就绪
    if (!this.viewer.geo && this._amap.customCoords) {
      const geo = createAMapGeoAdapter(this._amap);
      if (geo) {
        this.viewer.geo = geo;
        this.viewer.recomputeAnchors();
      }
    }

    const customCoords = this._amap.customCoords;
    if (!customCoords || typeof customCoords.getCameraParams !== 'function') {
      return;
    }

    const anchor = this.viewer.sceneAnchor;
    if (!anchor) return;

    const camParams = customCoords.getCameraParams();
    if (!camParams) return;

    this._syncCanvasSize();

    const { fov, near, far, position, lookAt, up } = camParams;
    const canvas = this._canvas;
    const aspect = canvas.width / Math.max(canvas.height, 1);

    // 2. 相机参数对齐：
    // AMap customCoords.getCameraParams() 给出的是高德直角坐标系 (+X 东, +Y 北, +Z 上) 下的原生相机参数。
    // 直接设置 PerspectiveCamera，保证相机坐标系正交无翻转（X 轴保持朝右，杜绝水平镜像）。
    const cam = this._cameraHelper;
    cam.fov = fov;
    cam.aspect = aspect;
    cam.near = near;
    cam.far = far;
    cam.position.set(position[0], position[1], position[2]);
    cam.up.set(up[0], up[1], up[2]);
    cam.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    // 3. 计算折叠 MVP 矩阵：
    // S3MViewer 内部世界矩阵假设 y 为南向（_enuMatrix 第二行为 0, -sNorth, 0, anchor.y）。
    // GeoAdapter 出口处已将 y 转换为南向 (y = -pt[1])。
    // 通过在此处对相机 MVP 矩阵乘以 makeScale(1, -1, 1)，
    // 使得 mvp · _enuMatrix 中的 (-1) · (-sNorth) 恰好对消为正 (+sNorth)，
    // 且整体矩阵行列式与标准 Three.js 透视相机一致（det < 0），
    // 彻底解决两大致命问题：
    //   1. 三角形正面 CCW 绕序不被翻转，背面剔除正常生效，正面玻璃网格不再缺失；
    //   2. 相机不产生镜像负缩放，建筑朝向与高德底图完全吻合（东西向不反转）。
    const camMVP = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const mvp = camMVP.multiply(new Matrix4().makeScale(1, -1, 1));

    // 4. 计算相机在局部场景 ENU 空间中的位置（米），用于 LOD 精度判定
    const sEast = anchor.meterInMercatorEast ?? anchor.meterInMercator;
    const sNorth = anchor.meterInMercatorNorth ?? anchor.meterInMercator;
    const sUp = anchor.meterInMercatorUp ?? 1.0;

    // anchor.x 为 pt_anchor[0], anchor.y 为 -pt_anchor[1]。
    // 相机在 AMap 坐标系中位置为 position[0], position[1], position[2]。
    // 局部 ENU 偏移量（米）：
    const camEnu: [number, number, number] = [
      (position[0] - anchor.x) / sEast,
      (position[1] + anchor.y) / sNorth,
      (position[2] - anchor.z) / sUp,
    ];

    const fovRad = (fov * Math.PI) / 180;

    // 5. 驱动渲染内核
    this.driveFrame({
      mvp: mvp.elements,
      cameraEnu: camEnu,
      fovRad,
      canvasHeight: canvas.height,
    });
  }

  /* ---------------------------------------------------------------- 事件与拾取 */

  private _onClick = (e: any): void => {
    if (!this.pickable) return;
    const hit = this.pickFromEvent(e);
    if (!hit) {
      this.select(null);
      return;
    }
    this.select(hit);
    this.onPick(hit);
  };

  /** 鼠标事件对象 → 拾取结果 */
  pickFromEvent(e: any): PickResult | null {
    const canvas = this._canvas;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const oe = e?.originalEvent ?? e;
    const clientX = oe?.clientX ?? e?.pixel?.x ?? 0;
    const clientY = oe?.clientY ?? e?.pixel?.y ?? 0;
    return this.viewer.pick(clientX - rect.left, clientY - rect.top);
  }

  /** 按画布像素拾取 */
  pick(x: number, y: number): PickResult | null {
    return this.viewer.pick(x, y);
  }

  /** 选中单体高亮 */
  select(result: PickResult | null, opts: { silent?: boolean } = {}): void {
    this.viewer.select(result, opts);
  }

  /** 销毁图层与资源 */
  destroy(): void {
    this._detachFromMap();
    this.viewer.dispose();
  }
}
