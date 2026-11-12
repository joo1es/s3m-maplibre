/**
 * 宿主地图/视图通用窄接口（S3MHost）
 *
 * 将不同地图宿主（MapLibre / Mapbox / 高德 AMap / Cesium / 纯 Three.js 等）
 * 与 S3M 渲染内核协作所需的最小通用能力收敛为同一契约：
 *
 *   1. 画布与重绘：getCanvas()、triggerRepaint()
 *   2. 视口状态：center / zoom / pitch / bearing
 *   3. 事件绑定：on / off
 *   4. 图层生命周期：getLayer / addLayer / removeLayer（上下文恢复重加图层）
 *
 * 具体宿主适配层（如 s3m-maplibre 的 `MapLike`、高德的 `AMapLike`）均扩展或实现该接口；
 * `HostRenderer` 只依赖这份最小契约，不耦合任何地图 SDK 专有类型。
 */

export interface S3MHostMouseEvent {
  originalEvent?: MouseEvent | { clientX: number; clientY: number };
  point?: { x: number; y: number } | [number, number];
  lngLat?: [number, number] | { lng: number; lat: number };
}

export interface S3MHost {
  /** 获取宿主渲染画布（无画布/独立覆盖画布宿主可缺省） */
  getCanvas?(): HTMLCanvasElement;

  /** 请求宿主进行下一帧重绘 */
  triggerRepaint(): void;

  /** 当前视口中心经纬度 */
  getCenter?(): unknown;

  /** 当前缩放层级 */
  getZoom?(): number;

  /** 当前俯仰角（度） */
  getPitch?(): number;

  /** 当前方位角（度，正北为 0，顺时针为正；用于灯光跟随视角） */
  getBearing?(): number;

  /** 绑定宿主事件监听 */
  on?(type: string, listener: (e: S3MHostMouseEvent) => void): unknown;

  /** 解绑宿主事件监听 */
  off?(type: string, listener: (e: S3MHostMouseEvent) => void): unknown;

  /** 查询已挂载图层 */
  getLayer?(id: string): unknown;

  /** 添加图层 */
  addLayer?(layer: unknown): unknown;

  /** 移除图层 */
  removeLayer?(id: string): unknown;
}
