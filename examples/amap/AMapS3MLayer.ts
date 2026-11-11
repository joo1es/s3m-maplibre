/**
 * S3M × 高德地图 (AMap) 适配层 (Phase 2)
 *
 * 继承宿主无关基类 `HostRenderer`，适配高德地图 JS API v2 的 `AMap.GLCustomLayer`：
 *   1. 共享 WebGL Context：通过 GLCustomLayer.init(gl) 将底图上下文直接挂载给 S3MViewer；
 *   2. 严格遵循 WebGL 状态交接纪律：每帧渲染前后各调用一次 `renderer.resetState()`，并将 `autoClear` 置为 `false`，
 *      防止擦除高德矢量/栅格底图；
 *   3. 坐标与相机对齐：通过高德 `customCoords.getCameraParams()` 提取真实透视相机参数，折合成标准 MVP 矩阵；
 *   4. 单体拾取与事件联动：复用 S3MViewer 的 GPU 离屏拾取通道。
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
  type WorldCoordinateResult,
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
  customCoords?: AMapCustomCoords;
  render?(): void;
}

export interface AMapS3MLayerOptions extends HostRendererOptions {
  map?: AMapLike;
  zIndex?: number;
  zooms?: [number, number];
  opacity?: number;
}

export class AMapS3MLayer extends HostRenderer {
  readonly zIndex: number;
  readonly zooms: [number, number];
  readonly opacity: number;

  private _amap: AMapLike | null = null;
  private _contextLost = false;
  private _listenersAttached = false;
  private _cameraHelper = new PerspectiveCamera();
  private _yFlipMatrix = new Matrix4().makeScale(1, -1, 1);

  constructor(options: AMapS3MLayerOptions = {}) {
    super(options);
    this.zIndex = options.zIndex ?? 120;
    this.zooms = options.zooms ?? [2, 20];
    this.opacity = options.opacity ?? 1;
    if (options.map) {
      this._amap = options.map;
      this._host = options.map;
    }
  }

  get map(): AMapLike | null {
    return this._amap;
  }

  set map(map: AMapLike | null) {
    this._amap = map;
    this._host = map;
    this.viewer.geo = map ? createAMapGeoAdapter(map) : null;
  }

  /** 请求下一帧重绘（转发高德 render 或 triggerRepaint） */
  protected override requestRepaint(): void {
    if (this._amap) {
      if (typeof this._amap.render === 'function') {
        this._amap.render();
      } else {
        this._amap.triggerRepaint();
      }
    }
  }

  /** 高德方位角（度，正北为 0，顺时针） */
  protected override getBearing(): number {
    return this._amap?.getBearing?.() ?? 0;
  }

  /**
   * 正交投影模式限制：第一版显式禁用并告警一次，保持透视模式（对应 Issue 43 约束）
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

  /* ---------------------------------------------------------------- 生命周期 */

  /**
   * 由 AMap.GLCustomLayer 自动调用的初始化方法。
   * 支持签名：init(gl) 或 init(map, gl)。
   */
  init(arg1: any, arg2?: any): void {
    let map: AMapLike | null = this._amap;
    let gl: WebGLRenderingContext | WebGL2RenderingContext;

    if (arg2) {
      map = arg1 as AMapLike;
      gl = arg2 as WebGLRenderingContext;
    } else {
      gl = arg1 as WebGLRenderingContext;
    }

    if (map) {
      this.map = map;
    }

    const canvas = this._amap?.getCanvas?.() ?? (gl.canvas as HTMLCanvasElement);
    this.mountViewer(canvas, gl);

    // 关键纪律：共享 WebGL context 下绝对不能开启 autoClear，否则会擦除高德底图
    if (this.viewer.renderer) {
      this.viewer.renderer.autoClear = false;
    }

    if (this._amap && !this._listenersAttached) {
      this._amap.on('click', this._onClick);
      this._amap.on('webglcontextlost', this._onContextLost);
      this._amap.on('webglcontextrestored', this._onContextRestored);
      this._listenersAttached = true;
    }
  }

  /** 销毁或从地图中移除 */
  destroy(): void {
    if (this._amap && this._listenersAttached) {
      this._amap.off('click', this._onClick);
      this._amap.off('webglcontextlost', this._onContextLost);
      this._amap.off('webglcontextrestored', this._onContextRestored);
      this._listenersAttached = false;
    }
    this.unmountViewer();
    this.viewer.geo = null;
    this._amap = null;
    this._host = null;
  }

  /* ---------------------------------------------------------------- 每帧渲染 */

  /**
   * 由 AMap.GLCustomLayer 逐帧调用的渲染方法
   */
  render(): void {
    const map = this._amap;
    const anchor = this.viewer.sceneAnchor;
    if (!map || !anchor) return;
    if (this._contextLost) return;

    const customCoords = map.customCoords;
    if (!customCoords || typeof customCoords.getCameraParams !== 'function') return;

    const renderer = this.viewer.renderer;
    // 关键纪律：渲染前重置 three.js 的 WebGL 状态机，避免状态污染
    if (renderer) renderer.resetState();

    const canvas = map.getCanvas();
    const aspect = canvas.width / (canvas.height || 1);

    // 1. 提取高德实时透视相机参数
    const { near, far, fov, up, lookAt, position } = customCoords.getCameraParams();

    // 2. 构造透视相机并更新变换矩阵
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
    // 高德 customCoords 坐标系中 +Y 为正北向，S3MViewer 内部世界坐标系遵循墨卡托标准（+Y 为正南向，-Y 为正北向）。
    // 因此在 MVP 上乘以 Y 轴翻转，将 S3M 顶点坐标无缝映射入高德投影空间。
    const mvp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    mvp.multiply(this._yFlipMatrix);

    // 4. 计算相机在局部场景 ENU 空间中的位置（米），用于 LOD 精度判定
    const sEast = anchor.meterInMercatorEast ?? anchor.meterInMercator;
    const sNorth = anchor.meterInMercatorNorth ?? anchor.meterInMercator;
    const sUp = anchor.meterInMercatorUp ?? 1.0;

    // 高德坐标系下的锚点坐标：x = anchor.x, y = -anchor.y, z = anchor.z
    const dX = position[0] - anchor.x;
    const dY = position[1] - (-anchor.y);
    const dZ = position[2] - anchor.z;

    const camEnu: [number, number, number] = [
      dX / sEast,
      dY / sNorth,
      dZ / sUp,
    ];

    const fovRad = (fov * Math.PI) / 180;

    // 5. 驱动渲染内核
    this.driveFrame({
      mvp: mvp.elements,
      cameraEnu: camEnu,
      fovRad,
      canvasHeight: canvas.height,
    });

    // 关键纪律：渲染完成后再次重置 WebGL 状态，完好交还给高德底层渲染管线
    if (renderer) renderer.resetState();
  }

  /* ---------------------------------------------------------------- 事件与拾取 */

  private _onContextLost = (): void => {
    this._contextLost = true;
  };

  private _onContextRestored = (): void => {
    this._contextLost = false;
    const canvas = this._amap?.getCanvas();
    const gl =
      (canvas?.getContext('webgl2') as WebGLRenderingContext | null) ??
      (canvas?.getContext('webgl') as WebGLRenderingContext | null);
    if (gl) {
      this.viewer.restoreContext(gl);
      if (this.viewer.renderer) {
        this.viewer.renderer.autoClear = false;
      }
    }
    this.requestRepaint();
  };

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
    const canvas = this._amap?.getCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const oe = e.originalEvent ?? e;
    const clientX = oe.clientX ?? e.pixel?.x ?? 0;
    const clientY = oe.clientY ?? e.pixel?.y ?? 0;
    return this.viewer.pick(clientX - rect.left, clientY - rect.top);
  }

  /** 按画布像素拾取 */
  pick(x: number, y: number): PickResult | null {
    return this.viewer.pick(x, y);
  }

  /** 选中单体高亮 */
  select(pickOrId: PickResult | number | null): void {
    this.viewer.select(pickOrId);
  }
}
