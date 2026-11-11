// examples/amap/AMapS3MLayer.ts
import { Matrix4, PerspectiveCamera } from "three";
import {
  HostRenderer,
  createAMapGeoAdapter
} from "s3m-three";

class AMapS3MLayer extends HostRenderer {
  zIndex;
  zooms;
  opacity;
  _amap = null;
  _canvas = null;
  _cameraHelper = new PerspectiveCamera;
  _listenersAttached = false;
  _customLayer = null;
  constructor(options = {}) {
    super(options);
    this.zIndex = options.zIndex ?? 120;
    this.zooms = options.zooms ?? [2, 20];
    this.opacity = options.opacity ?? 1;
    if (options.canvas) {
      this._canvas = options.canvas;
      this._canvas.style.position = "absolute";
      this._canvas.style.top = "0";
      this._canvas.style.left = "0";
      this._canvas.style.width = "100%";
      this._canvas.style.height = "100%";
      this._canvas.style.pointerEvents = "none";
      this._canvas.style.zIndex = String(this.zIndex);
    }
    if (options.map) {
      this.setMap(options.map);
    }
  }
  get map() {
    return this._amap;
  }
  set map(map) {
    this.setMap(map);
  }
  setMap(map) {
    if (this._amap === map)
      return;
    if (this._amap) {
      this._detachFromMap();
    }
    this._amap = map;
    this._host = map;
    if (map) {
      this._attachToMap(map);
    }
  }
  init(arg1, arg2) {
    const map = arg2 ? arg1 : arg1?.getContainer ? arg1 : this._amap;
    if (map) {
      this.setMap(map);
    }
  }
  getCanvas() {
    return this._canvas;
  }
  requestRepaint() {
    if (this._amap) {
      if (typeof this._amap.render === "function") {
        this._amap.render();
      } else if (typeof this._amap.triggerRepaint === "function") {
        this._amap.triggerRepaint();
      } else {
        this.render();
      }
    }
  }
  getBearing() {
    return this._amap?.getBearing?.() ?? 0;
  }
  setProjection(mode, transition) {
    if (mode === "orthographic") {
      if (!this._orthoWarned) {
        this._orthoWarned = true;
        console.warn("[s3m-amap] 高德适配层暂不支持正交投影模式，已保持透视模式");
      }
      return;
    }
    super.setProjection(mode, transition);
  }
  _attachToMap(map) {
    const container = map.getContainer();
    if (!container)
      return;
    if (!this._canvas && typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.className = "amap-s3m-layer-canvas";
      this._canvas = canvas;
    }
    if (this._canvas) {
      this._canvas.style.position = "absolute";
      this._canvas.style.top = "0";
      this._canvas.style.left = "0";
      this._canvas.style.width = "100%";
      this._canvas.style.height = "100%";
      this._canvas.style.pointerEvents = "none";
      this._canvas.style.zIndex = String(this.zIndex);
    }
    if (this._canvas && !this.viewer.renderer) {
      const gl = typeof this._canvas.getContext === "function" ? this._canvas.getContext("webgl2") : null;
      if (gl) {
        this.mountViewer(this._canvas, gl);
        const renderer = this.viewer.renderer;
        if (renderer) {
          renderer.autoClear = true;
        }
      }
    }
    if (typeof window !== "undefined" && typeof window.AMap?.CustomLayer === "function" && this._canvas) {
      try {
        this._customLayer = new window.AMap.CustomLayer(this._canvas, {
          zIndex: this.zIndex,
          zooms: this.zooms,
          alwaysRender: true,
          render: () => this.render()
        });
        if (typeof map.add === "function") {
          map.add(this._customLayer);
        }
      } catch {
        this._customLayer = null;
      }
    }
    if (!this._customLayer && this._canvas && !container.contains(this._canvas)) {
      container.appendChild(this._canvas);
    }
    if (!this._listenersAttached) {
      this._listenersAttached = true;
      map.on("viewchange", this._onViewChange);
      map.on("move", this._onViewChange);
      map.on("zoomchange", this._onViewChange);
      map.on("rotatechange", this._onViewChange);
      map.on("pitchchange", this._onViewChange);
      map.on("resize", this._onResize);
      map.on("click", this._onClick);
    }
    if (map.customCoords) {
      this.viewer.geo = createAMapGeoAdapter(map);
      this.viewer.recomputeAnchors();
    }
    this._syncCanvasSize();
    this.requestRepaint();
  }
  _detachFromMap() {
    if (this._amap && this._listenersAttached) {
      this._listenersAttached = false;
      this._amap.off("viewchange", this._onViewChange);
      this._amap.off("move", this._onViewChange);
      this._amap.off("zoomchange", this._onViewChange);
      this._amap.off("rotatechange", this._onViewChange);
      this._amap.off("pitchchange", this._onViewChange);
      this._amap.off("resize", this._onResize);
      this._amap.off("click", this._onClick);
    }
    if (this._customLayer && this._amap && typeof this._amap.remove === "function") {
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
  _onViewChange = () => {
    this.render();
  };
  _onResize = () => {
    this._syncCanvasSize();
    this.render();
  };
  _syncCanvasSize() {
    if (!this._canvas || !this._amap)
      return;
    const container = this._amap.getContainer();
    if (!container)
      return;
    const width = container.clientWidth || 300;
    const height = container.clientHeight || 150;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (this._canvas.width !== targetW || this._canvas.height !== targetH) {
      this._canvas.width = targetW;
      this._canvas.height = targetH;
      this._canvas.style.width = width + "px";
      this._canvas.style.height = height + "px";
      if (this.viewer.renderer) {
        this.viewer.renderer.setSize(width, height, false);
      }
    }
  }
  render() {
    if (!this._amap || !this._canvas)
      return;
    if (!this.viewer.geo && this._amap.customCoords) {
      const geo = createAMapGeoAdapter(this._amap);
      if (geo) {
        this.viewer.geo = geo;
        this.viewer.recomputeAnchors();
      }
    }
    const customCoords = this._amap.customCoords;
    if (!customCoords || typeof customCoords.getCameraParams !== "function") {
      return;
    }
    const anchor = this.viewer.sceneAnchor;
    if (!anchor)
      return;
    const camParams = customCoords.getCameraParams();
    if (!camParams)
      return;
    this._syncCanvasSize();
    const { fov, near, far, position, lookAt, up } = camParams;
    const canvas = this._canvas;
    const aspect = canvas.width / Math.max(canvas.height, 1);
    const camPos = [position[0], -position[1], position[2]];
    const camLookAt = [lookAt[0], -lookAt[1], lookAt[2]];
    const camUp = [up[0], -up[1], up[2]];
    const cam = this._cameraHelper;
    cam.fov = fov;
    cam.aspect = aspect;
    cam.near = near;
    cam.far = far;
    cam.position.set(camPos[0], camPos[1], camPos[2]);
    cam.up.set(camUp[0], camUp[1], camUp[2]);
    cam.lookAt(camLookAt[0], camLookAt[1], camLookAt[2]);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const mvp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const sEast = anchor.meterInMercatorEast ?? anchor.meterInMercator;
    const sNorth = anchor.meterInMercatorNorth ?? anchor.meterInMercator;
    const sUp = anchor.meterInMercatorUp ?? 1;
    const camEnu = [
      (camPos[0] - anchor.x) / sEast,
      -(camPos[1] - anchor.y) / sNorth,
      (camPos[2] - anchor.z) / sUp
    ];
    const fovRad = fov * Math.PI / 180;
    this.driveFrame({
      mvp: mvp.elements,
      cameraEnu: camEnu,
      fovRad,
      canvasHeight: canvas.height
    });
  }
  _onClick = (e) => {
    if (!this.pickable)
      return;
    const hit = this.pickFromEvent(e);
    if (!hit) {
      this.select(null);
      return;
    }
    this.select(hit);
    this.onPick(hit);
  };
  pickFromEvent(e) {
    const canvas = this._canvas;
    if (!canvas)
      return null;
    const rect = canvas.getBoundingClientRect();
    const oe = e?.originalEvent ?? e;
    const clientX = oe?.clientX ?? e?.pixel?.x ?? 0;
    const clientY = oe?.clientY ?? e?.pixel?.y ?? 0;
    return this.viewer.pick(clientX - rect.left, clientY - rect.top);
  }
  pick(x, y) {
    return this.viewer.pick(x, y);
  }
  select(result, opts = {}) {
    this.viewer.select(result, opts);
  }
  destroy() {
    this._detachFromMap();
    this.viewer.dispose();
  }
}
export {
  AMapS3MLayer
};
