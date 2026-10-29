/**
 * 三维空间分析内核（宿主无关、不依赖 WebGL）。
 *
 * 分工：
 * - 本目录只做**纯数学**：量算、通视判定、裁剪半空间生成。可以直接单测。
 * - 需要 GPU 的部分（贴地采样、天际线、可视域、阴影）在 `render/` 下，
 *   复用 `Picker` 的离屏 pass 与状态恢复。
 * - 交互（取点、拖拽、标签绘制）属于应用层，不进这个包。
 */
export {
  distance3D,
  distanceHorizontal,
  heightDifference,
  polylineLength,
  polylineLengthHorizontal,
  polygonPerimeter,
  polygonArea,
  polygonAreaHorizontal,
  measureSegment,
} from './measure.js';
export type { Vec3, LngLatAlt, MeasureResult } from './measure.js';

export { lineOfSight } from './lineOfSight.js';
export type { RayHit, RayCast, LineOfSightOptions, LineOfSightResult } from './lineOfSight.js';

export {
  planeFromPointNormal,
  isPointKept,
  planeClipping,
  boxClipping,
  crossClipping,
  buildClipPlanes,
} from './clipping.js';
export type {
  PlaneLike,
  ClipPlaneOptions,
  ClipBoxOptions,
  ClipCrossOptions,
  ClipOptions,
} from './clipping.js';

/* 深度图回读（P1：天际线 / 可视域的数学部分，GL 在 render/analysis/DepthPass） */
export { packRGBADepth, unpackRGBADepth, unprojectNdc, pixelToNdc, azimuthElevation } from './depth.js';
export { skylineFromDepth } from './skyline.js';
export type { SkylineArgs, SkylineResult } from './skyline.js';
export { computeViewshed, makeCubeDistanceSampler } from './viewshed.js';
export type { ViewshedOptions, ViewshedResult } from './viewshed.js';
