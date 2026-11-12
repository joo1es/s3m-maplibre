/**
 * S3M × 高德地图 (AMap JS API v2) 适配层 (Phase 2)
 *
 * 继承宿主无关基类 `HostRenderer`：
 *   1. 独立 WebGL2 覆盖画布：Three.js r163+ 已移除 WebGL1，独立画布通过 `AMap.CustomLayer`
 *      叠加到底图上方（`pointerEvents: none` 保持地图手势穿透），并处理上下文丢失恢复；
 *   2. 惰性地理坐标装配：等待高德 `customCoords` 就绪后装配 `createAMapGeoAdapter` 并重算锚点，
 *      固定参考中心以防缩放/平移时参考系漂移；
 *   3. 纯净相机与 MVP：`customCoords.getCameraParams()` 原生 `+y` 朝北，这里右乘 `scale(1, -1, 1)`
 *      与 `S3MViewer._enuMatrix` 的 `-sNorth` 对消，保持正右手系绕序（不破坏背面剔除）；
 *   4. 交互与限制：支持单体 GPU 拾取高亮，第一版按 Issue #43 显式禁用正交模式并告警一次。
 */
import { Matrix4, PerspectiveCamera } from 'three';
import {
  HostRenderer,
  createAMapGeoAdapter,
  type HostRendererOptions,
  type PickResult,
  type ProjectionMode,
  type S3MHost,
  type S3MHostMouseEvent,
  type TransitionOptions,
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
  on(type: string, listener: (e: S3MHostMouseEvent) => void): unknown;
  off(type: string, listener: (e: S3MHostMouseEvent) => void): unknown;
  getBearing?(): number;
  getRotation?(): number;
  getPitch?(): number;
  getZoom?(): number;
  getCenter?(): unknown;
  render?(): void;
  customCoords?: AMapCustomCoords;
  add?(layer: unknown): void;
  remove?(layer: unknown): void;
}

export interface AMapS3MLayerOptions extends HostRendererOptions {
  map?: AMapLike;
  center?: [number, number];
  zIndex?: number;
  zooms?: [number, number];
  opacity?: number;
  canvas?: HTMLCanvasElement;
}

const VIEW_EVENTS = ['viewchange', 'move', 'zoomchange', 'rotatechange', 'pitchchange'] as const;

function readLngLatPair(c: unknown): [number, number] | null {
  if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
    return [c[0], c[1]];
  }
  if (c && typeof c === 'object') {
    const obj = c as { getLng?: () => number; getLat?: () => number; lng?: number; lat?: number };
    if (typeof obj.getLng === 'function' && typeof obj.getLat === 'function') {
      return [obj.getLng(), obj.getLat()];
    }
    if (typeof obj.lng === 'number' && typeof obj.lat === 'number') {
      return [obj.lng, obj.lat];
    }
  }
  return null;
}

export class AMapS3MLayer extends HostRenderer {
  readonly zIndex: number;
  readonly zooms: [number, number];
  readonly opacity: number;

  private _amap: AMapLike | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private readonly _cameraHelper = new PerspectiveCamera();
  private readonly _camMvp = new Matrix4();
  private readonly _yFlip = new Matrix4().makeScale(1, -1, 1);
  private _listenersAttached = false;
  private _canvasListenersAttached = false;
  private _customLayer: unknown = null;
  private _refCenter: [number, number] | null = null;

  constructor(options: AMapS3MLayerOptions = {}) {
    super(options);
    this.zIndex = options.zIndex ?? 120;
    this.zooms = options.zooms ?? [2, 20];
    this.opacity = options.opacity ?? 1;
    this._refCenter = options.center ?? null;

    if (options.canvas) {
      this._canvas = options.canvas;
      this._styleOverlayCanvas(this._canvas);
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

  /** 绑定或解绑高德地图实例 */
  setMap(map: AMapLike | null): void {
    if (this._amap === map) return;
    if (this._amap) this._detachFromMap();

    this._amap = map;
    this._host = map;
    if (map) this._attachToMap(map);
  }

  /** 兼容 AMap.CustomLayer 的初始化签名 */
  init(arg1: unknown, arg2?: unknown): void {
    const candidate = (arg2 ? arg1 : (arg1 as { getContainer?: unknown })?.getContainer ? arg1 : this._amap) as
      | AMapLike
      | null;
    if (candidate) this.setMap(candidate);
  }

  getCanvas(): HTMLCanvasElement | null {
    return this._canvas;
  }

  /** 请求下一帧重绘 */
  protected requestRepaint(): void {
    if (!this._amap) return;
    if (typeof this._amap.render === 'function') {
      this._amap.render();
    } else if (typeof this._amap.triggerRepaint === 'function') {
      this._amap.triggerRepaint();
    } else {
      this.render();
    }
  }

  /** 方位角（度，正北为 0，顺时针为正）；高德原生 getRotation() 方向相反，取反后交给 LightRig */
  protected override getBearing(): number {
    if (!this._amap) return 0;
    if (typeof this._amap.getBearing === 'function') return this._amap.getBearing();
    if (typeof this._amap.getRotation === 'function') return -this._amap.getRotation();
    return 0;
  }

  /** 高德适配层第一版显式禁用正交投影并告警一次 */
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

  /* ---------------------------------------------------------------- 挂载与卸载 */

  private _styleOverlayCanvas(canvas: HTMLCanvasElement): void {
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = String(this.zIndex);
  }

  private _syncGeoFromMap(map: AMapLike): boolean {
    const customCoords = map.customCoords;
    if (!customCoords) return false;
    if (!this._refCenter && typeof map.getCenter === 'function') {
      this._refCenter = readLngLatPair(map.getCenter());
    }
    if (this._refCenter && typeof customCoords.setCenter === 'function') {
      customCoords.setCenter(this._refCenter);
    }
    const geo = createAMapGeoAdapter(map);
    if (!geo) return false;
    this.viewer.geo = geo;
    this.viewer.recomputeAnchors();
    return true;
  }

  private _attachToMap(map: AMapLike): void {
    const container = map.getContainer();
    if (!container) return;

    if (!this._canvas && typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.className = 'amap-s3m-layer-canvas';
      this._canvas = canvas;
    }

    if (this._canvas) {
      this._styleOverlayCanvas(this._canvas);
      if (!this._canvasListenersAttached && typeof this._canvas.addEventListener === 'function') {
        this._canvas.addEventListener('webglcontextlost', this._onContextLost);
        this._canvas.addEventListener('webglcontextrestored', this._onContextRestored);
        this._canvasListenersAttached = true;
      }
      if (!this.viewer.renderer) {
        const gl =
          typeof this._canvas.getContext === 'function' ? this._canvas.getContext('webgl2') : null;
        if (gl) {
          this.mountViewer(this._canvas, gl as WebGL2RenderingContext);
        }
      }
      if (this.viewer.renderer) {
        this.viewer.renderer.autoClear = true;
      }
    }

    const amapNs =
      typeof window !== 'undefined' ? (window as unknown as { AMap?: { CustomLayer?: new (...args: any[]) => any } }).AMap : undefined;
    if (amapNs && typeof amapNs.CustomLayer === 'function' && this._canvas) {
      try {
        this._customLayer = new amapNs.CustomLayer(this._canvas, {
          zIndex: this.zIndex,
          zooms: this.zooms,
          alwaysRender: true,
          render: () => this.render(),
        });
        map.add?.(this._customLayer);
      } catch {
        this._customLayer = null;
      }
    }

    if (!this._customLayer && this._canvas && !container.contains(this._canvas)) {
      container.appendChild(this._canvas);
    }

    if (!this._listenersAttached) {
      this._listenersAttached = true;
      for (const evt of VIEW_EVENTS) map.on(evt, this._onViewChange);
      map.on('resize', this._onResize);
      map.on('click', this._onClick);
    }

    this._syncGeoFromMap(map);
    this._syncCanvasSize();
    this.requestRepaint();
  }

  private _detachFromMap(): void {
    if (this._amap && this._listenersAttached) {
      this._listenersAttached = false;
      for (const evt of VIEW_EVENTS) this._amap.off(evt, this._onViewChange);
      this._amap.off('resize', this._onResize);
      this._amap.off('click', this._onClick);
    }

    if (this._canvas && this._canvasListenersAttached && typeof this._canvas.removeEventListener === 'function') {
      this._canvas.removeEventListener('webglcontextlost', this._onContextLost);
      this._canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
      this._canvasListenersAttached = false;
    }

    if (this._customLayer && this._amap && typeof this._amap.remove === 'function') {
      try {
        this._amap.remove(this._customLayer);
      } catch {
        /* 卸载阶段忽略清理异常 */
      }
      this._customLayer = null;
    }

    if (this._canvas?.parentElement) {
      this._canvas.parentElement.removeChild(this._canvas);
    }

    this.viewer.geo = null;
  }

  private readonly _onViewChange = (): void => {
    this.render();
  };

  private readonly _onResize = (): void => {
    this._syncCanvasSize();
    this.render();
  };

  private readonly _onContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private readonly _onContextRestored = (): void => {
    const gl = this._canvas?.getContext?.('webgl2') as WebGL2RenderingContext | null;
    if (gl) {
      this.viewer.restoreContext(gl);
      this.requestRepaint();
    }
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
      this._canvas.style.width = `${width}px`;
      this._canvas.style.height = `${height}px`;
      this.viewer.renderer?.setSize(width, height, false);
    }
  }

  /* ---------------------------------------------------------------- 逐帧渲染驱动 */

  render(): void {
    if (!this._amap || !this._canvas) return;

    if (!this.viewer.geo) {
      this._syncGeoFromMap(this._amap);
    }

    const customCoords = this._amap.customCoords;
    if (!customCoords || typeof customCoords.getCameraParams !== 'function') return;

    if (this._refCenter && typeof customCoords.setCenter === 'function') {
      customCoords.setCenter(this._refCenter);
    }

    const anchor = this.viewer.sceneAnchor;
    if (!anchor) return;

    const camParams = customCoords.getCameraParams();
    if (!camParams) return;

    this._syncCanvasSize();

    const { fov, near, far, position, lookAt, up } = camParams;
    const canvas = this._canvas;
    const cam = this._cameraHelper;
    cam.fov = fov;
    cam.aspect = canvas.width / Math.max(canvas.height, 1);
    cam.near = near;
    cam.far = far;
    cam.position.set(position[0], position[1], position[2]);
    cam.up.set(up[0], up[1], up[2]);
    cam.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    // GeoAdapter 输出已将高德 +y 朝北取反为 +y 朝南；右乘 scale(1, -1, 1) 与
    // S3MViewer._enuMatrix 的 -sNorth 对消，保持右手绕序并确保 det < 0
    this._camMvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._camMvp.multiply(this._yFlip);

    const sEast = anchor.meterInMercatorEast ?? anchor.meterInMercator;
    const sNorth = anchor.meterInMercatorNorth ?? anchor.meterInMercator;
    const sUp = anchor.meterInMercatorUp ?? sEast;

    const camEnu: [number, number, number] = [
      (position[0] - anchor.x) / sEast,
      (position[1] + anchor.y) / sNorth,
      (position[2] - anchor.z) / sUp,
    ];

    this.driveFrame({
      mvp: this._camMvp.elements,
      cameraEnu: camEnu,
      fovRad: (fov * Math.PI) / 180,
      canvasHeight: canvas.height,
    });
  }

  /* ---------------------------------------------------------------- 拾取与销毁 */

  private readonly _onClick = (e: S3MHostMouseEvent): void => {
    if (!this.pickable) return;
    const hit = this.pickFromEvent(e);
    if (!hit) {
      this.select(null);
      return;
    }
    this.select(hit);
    this.onPick(hit);
  };

  pickFromEvent(e: S3MHostMouseEvent): PickResult | null {
    const canvas = this._canvas;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const oe = e?.originalEvent;
    const pt = Array.isArray(e?.point) ? { x: e.point[0], y: e.point[1] } : e?.point;
    const clientX = oe?.clientX ?? pt?.x ?? 0;
    const clientY = oe?.clientY ?? pt?.y ?? 0;
    return this.viewer.pick(clientX - rect.left, clientY - rect.top);
  }

  pick(x: number, y: number): PickResult | null {
    return this.viewer.pick(x, y);
  }

  select(result: PickResult | null, opts: { silent?: boolean } = {}): void {
    this.viewer.select(result, opts);
  }

  destroy(): void {
    this._detachFromMap();
    this._amap = null;
    this._host = null;
    this.unmountViewer();
    this.viewer.dispose();
  }
}
