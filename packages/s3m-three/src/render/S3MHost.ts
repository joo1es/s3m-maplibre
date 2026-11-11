/**
 * 宿主地图/视图通用抽象接口（S3MHost）
 *
 * 将不同地图宿主（MapLibre / Mapbox / 高德 AMap / Cesium / 纯 Three.js 等）
 * 与 S3M 渲染内核协作所需的最小通用能力收敛成窄接口：
 *
 *   1. 画布与生命周期：getCanvas()、triggerRepaint()
 *   2. 视口状态：center / zoom / pitch / bearing
 *   3. 事件系统：on / off（鼠标事件、上下文丢失与恢复、投影过渡等）
 *   4. 上下文恢复图层生命周期支持：getLayer / addLayer / removeLayer
 *
 * 任何具体的地图适配层（如 s3m-maplibre 的 MapLike、高德 AMap）均实现或扩展该接口。
 */

export interface S3MHostMouseEvent {
  originalEvent?: MouseEvent | { clientX: number; clientY: number };
  point?: { x: number; y: number } | [number, number];
  lngLat?: [number, number] | { lng: number; lat: number };
}

export interface S3MHost {
  /** 获取宿主渲染画布 Canvas 元素 */
  getCanvas(): HTMLCanvasElement;

  /** 请求宿主进行下一帧重绘（如 maplibre: triggerRepaint, amap: render/triggerRepaint, three: requestAnimationFrame） */
  triggerRepaint(): void;

  /** 监听宿主事件（'click'、'webglcontextlost'、'webglcontextrestored'、'projectiontransition' 等） */
  on(type: string, listener: (e: any) => void): unknown;

  /** 取消监听宿主事件 */
  off(type: string, listener: (e: any) => void): unknown;

  /** 当前视口中心经纬度 [lng, lat] 或 { lng, lat } */
  getCenter?(): [number, number] | { lng: number; lat: number };

  /** 当前缩放层级（zoom level） */
  getZoom?(): number;

  /** 当前俯仰角 / 倾斜角（度，垂直向下为 0） */
  getPitch?(): number;

  /** 当前方位角 / 旋转角（度，正北为 0，顺时针为正） */
  getBearing?(): number;

  /** 上下文恢复或图层管理可选钩子（MapLibre / Mapbox 在 context lost 后需重新 addLayer） */
  getLayer?(id: string): unknown;
  addLayer?(layer: unknown): unknown;
  removeLayer?(id: string): unknown;
}
