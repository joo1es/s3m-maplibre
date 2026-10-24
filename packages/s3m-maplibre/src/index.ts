/**
 * s3m-maplibre 公共出口 —— SuperMap S3M × MapLibre / Mapbox 渲染图层
 *
 * 大多数使用者只需要 `S3MLayer`：
 *   const layer = new S3MLayer({ configUrl });
 *   map.addLayer(layer);
 *
 * 渲染内核来自 s3m-three（本包的全部渲染、拾取、样式能力都再导出于此，
 * 0.2.x 时代从根入口能 import 到的符号这里都能 import 到）。
 */
export { S3MLayer } from './S3MLayer.js';
export { S3MLayer as default } from './S3MLayer.js';
export type { S3MLayerOptions } from './S3MLayer.js';

export {
  DEFAULT_FOV,
  createMapLibreGeoAdapter,
  extractWorldCoordinateHelper,
} from './MapLibreGeoAdapter.js';
export type {
  MapLike,
  MapMouseEventLike,
  WorldCoordinateHelperLike,
} from './MapLibreGeoAdapter.js';

/** 渲染内核（s3m-three）全量再导出，保持与 0.2.x 单包版的导入兼容 */
export * from 's3m-three';
