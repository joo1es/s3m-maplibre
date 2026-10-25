/**
 * s3m-three 公共出口 —— SuperMap S3M 的 three.js 渲染内核（宿主无关）
 *
 * 分层：
 *   core    —— 纯解析，无 three 依赖，可在 Node 里跑
 *   tileset —— 瓦片树 + LOD + 加载调度
 *   render  —— three 场景管理（S3MViewer）、几何/材质/拾取/棱线/单体样式
 *
 * 大多数使用者只需要 `S3MViewer`；MapLibre / Mapbox 宿主请改用 s3m-maplibre 包的 S3MLayer。
 */

// —— 解析层（Node 可用，不依赖 three / WebGL）
export { parseS3MB, S3MFormatError, S3M_VERSION, VertexTag, VertexTagV3 } from './core/S3MBParser.js';
export type { ParseOptions, InflateFn } from './core/S3MBParser.js';
export { BinaryReader } from './core/BinaryReader.js';
export { resolveFeature, measureSegments, buildAttributes, DEFAULT_FLOOR_HEIGHT } from './core/FeatureInfo.js';
export { AttributeQuery } from './core/AttributeQuery.js';
export type {
  AttributeQueryOptions,
  AttributeField,
  AttributeRow,
} from './core/AttributeQuery.js';

// —— 公共类型
export type {
  Vec3,
  BoundingBox,
  AttrDType,
  VertexAttribute,
  IndexPackage,
  VertexPackage,
  PickSegment,
  PickEntry,
  GeoPackageEntry,
  Geode,
  PageLOD,
  GroupNode,
  S3MTexture,
  ParsedTile,
  Anchor,
  Stats,
  FeatureAttributes,
  SegmentBox,
  StyleUniforms,
} from './core/types.js';

// —— 地理坐标适配（宿主无关接口 + 墨卡托兜底）
export {
  EARTH_RADIUS,
  mercatorFromLngLat,
  lngLatFromMercator,
  worldFromLngLat,
  lngLatFromWorld,
} from './render/GeoAdapter.js';
export type { GeoAdapter } from './render/GeoAdapter.js';

// —— 瓦片层
export { S3MTileset } from './tileset/S3MTileset.js';
export type { TileNode, BuildTileFn, S3MTilesetOptions } from './tileset/S3MTileset.js';

// —— 渲染层
export { S3MViewer } from './render/S3MViewer.js';
export type {
  S3MViewerOptions,
  PickResult,
} from './render/S3MViewer.js';
export {
  DEFAULT_STYLE,
  STYLE,
  STYLE_LABELS,
  SELECT_MODE,
  SELECT_MODE_LABELS,
} from './render/StyleMaterial.js';
export type { S3MStyle } from './render/StyleMaterial.js';
export {
  GroundManager,
  DatasetManager,
  FeatureStyleManager,
} from './render/S3MViewer.js';
export type {
  DatasetAlignment,
  S3MDatasetOptions,
  S3MDatasetEntry,
  FeatureStyle,
  ColorByFieldOptions,
  ThematicLegendEntry,
  ThematicResult,
  BatchConflict,
  BatchAudit,
  FieldFilterOptions,
  FieldFilterResult,
  FieldElevationOptions,
  FieldElevationResult,
  S3MFilter,
  GroundMode,
  GroundOptions,
} from './render/S3MViewer.js';

export { buildTileObjects } from './render/GeometryBuilder.js';
export type { BuildTileOptions, BuildTileResult, TileBuildStats } from './render/GeometryBuilder.js';

export { createTexture, PixelFormat, setMaxAnisotropy } from './render/TextureFactory.js';
export type { DecodedTexture } from './render/TextureFactory.js';

export { resolveTextureKind, dxtPixelFormatOf, TextureCompress } from './core/TextureFormat.js';
export type { TextureKind } from './core/TextureFormat.js';

export {
  createSharedUniforms,
  createStyledMaterial,
  createOutlineMaterial,
} from './render/StyleMaterial.js';
export type { StyleMode, SelectMode, StyledMaterial, StyledMaterialOptions, OutlineMaterial } from './render/StyleMaterial.js';

export { Picker } from './render/Picker.js';
export type { PickHit } from './render/Picker.js';

export {
  buildOrthoMVP,
  extractProjectionMatrix,
  extractNearFar,
  extractFovRadians,
} from './render/OrthoProjection.js';
export type { ProjectionMode, OrthoInput, OrthoParams, OrthoMVP } from './render/OrthoProjection.js';

export {
  createThickLineMaterial,
  createLineSharedUniforms,
  buildThickLineGeometry,
  buildFeatureEdgeSegments,
} from './render/EdgeLines.js';
export type { ThickLineMaterial, LineSharedUniforms, EdgeVertexRange } from './render/EdgeLines.js';

export { S3MViewer as default } from './render/S3MViewer.js';
