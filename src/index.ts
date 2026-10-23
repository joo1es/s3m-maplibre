/**
 * s3m-maplibre 公共出口
 *
 * 分层：
 *   core    —— 纯解析，无 three 依赖，可在 Node 里跑
 *   tileset —— 瓦片树 + LOD + 加载调度
 *   render  —— three 渲染、着色、拾取
 *
 * 大多数使用者只需要 `S3MLayer`。
 */

// —— 解析层（Node 可用，不依赖 three / WebGL）
export { parseS3MB, S3M_VERSION, VertexTag, VertexTagV3 } from './core/S3MBParser.js';
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

// —— 瓦片层
export { S3MTileset } from './tileset/S3MTileset.js';
export type { TileNode, BuildTileFn, S3MTilesetOptions } from './tileset/S3MTileset.js';

// —— 渲染层
export { S3MLayer, DEFAULT_STYLE, STYLE, STYLE_LABELS, SELECT_MODE, SELECT_MODE_LABELS } from './render/S3MLayer.js';
export type {
  S3MLayerOptions,
  S3MStyle,
  SelectMode,
  FeatureStyle,
  S3MFilter,
  S3MDatasetOptions,
  S3MDatasetEntry,
  PickResult,
  MapLike,
  MapMouseEventLike,
  ColorByFieldOptions,
  ThematicLegendEntry,
  BatchConflict,
  BatchAudit,
  ThematicResult,
  FieldFilterOptions,
  FieldFilterResult,
  FieldElevationOptions,
  FieldElevationResult,
} from './render/S3MLayer.js';

export { buildTileObjects } from './render/GeometryBuilder.js';
export type { BuildTileOptions, BuildTileResult, TileBuildStats } from './render/GeometryBuilder.js';

export { createTexture, PixelFormat, setMaxAnisotropy } from './render/TextureFactory.js';
export type { DecodedTexture } from './render/TextureFactory.js';

export { resolveTextureKind, dxtPixelFormatOf, TextureCompress } from './core/TextureFormat.js';
export type { TextureKind } from './core/TextureFormat.js';

export { createSharedUniforms, createStyledMaterial, createOutlineMaterial } from './render/StyleMaterial.js';
export type { StyleMode, StyledMaterial, StyledMaterialOptions, OutlineMaterial } from './render/StyleMaterial.js';

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

export { S3MLayer as default } from './render/S3MLayer.js';
