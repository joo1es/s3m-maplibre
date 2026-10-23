/**
 * 公共数据类型
 *
 * 这里只放「跨模块共享」的结构定义。模块内部的私有类型各自就近声明。
 */
import type { Color } from 'three';

/* ------------------------------------------------------------------ 数学 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox {
  center: Vec3;
  xExtent: Vec3;
  yExtent: Vec3;
  zExtent: Vec3;
}

/* ------------------------------------------------------------------ 几何 */

export type AttrDType = 'f32' | 'u8' | 'u16' | 'u32';

export interface VertexAttribute {
  semantic: string;
  /** 原始字节视图，生命周期绑定底层 buffer */
  data: Uint8Array;
  components: number;
  stride: number;
  offsetInBytes: number;
  /** 非 0 表示实例属性 */
  divisor?: number;
  dtype: AttrDType;
}

export interface IndexPackage {
  indexCount: number;
  /** 0 = UNSIGNED_SHORT，1/3 = UNSIGNED_INT */
  indexType: number;
  useIndex: number;
  /** 4 = TRIANGLES */
  primitiveType: number;
  indices: Uint8Array | null;
  passNames: string[];
}

export interface VertexPackage {
  verticesCount: number;
  vertexAttributes: VertexAttribute[];
  /** semantic → 在 vertexAttributes 中的下标 */
  attrLocation: Record<string, number>;
  instanceCount: number;
  /** 16 = 只有矩阵，17/29 = 矩阵 + 颜色 */
  instanceMode: number;
  /** -1 表示非实例化 */
  instanceIndex: number;
  instanceBuffer?: Uint8Array;
  /**
   * 实例化几何的逐实例控制位（长度 = instanceCount），-1 表示该实例不属于任何单体。
   * 注意顶点数 ≠ 实例数，所以它不能当逐顶点属性用，构建几何时要做成 InstancedBufferAttribute。
   */
  instanceBatchIds?: Float32Array;
  compressOptions?: number;
  customVertexAttribute?: unknown;
  textureCoordIsW?: boolean;
}

export interface PickSegment {
  vertexOffset: number;
  vertexCount: number;
}

export interface PickEntry {
  /** 顶点区间型单体：控制位（写进 `aBatchId`） */
  batchId?: number;
  segments?: PickSegment[];
  /** 实例化单体：落在哪几个实例上（一个单体可能对应多个实例） */
  instanceIds?: number[];
  /** 实例化单体：控制位（写进 `aInstanceBatchId`），等于 pickInfo 里的枚举序 */
  instanceBatchId?: number;
}

export interface GeoPackageEntry {
  name: string;
  vertexPackage: VertexPackage;
  indexPackages: IndexPackage[];
  /** SMID → batchId + 顶点区间（单体化信息） */
  pickInfo?: Record<number, PickEntry>;
}

/* ------------------------------------------------------------------ LOD 树 */

export interface Geode {
  /** 列主序 4×4，平移在 [12][13][14] */
  matrix: number[];
  skeletonNames: string[];
}

export interface PageLOD {
  rangeValue: number;
  /** 0 = 视点距离，1 = 屏幕像素，2 = 几何误差 */
  rangeMode: number;
  boundingSphere: { center: Vec3; radius: number };
  obb?: BoundingBox;
  childTile: string;
  geodes: Geode[];
}

export interface GroupNode {
  pageLods: PageLOD[];
}

/* ------------------------------------------------------------------ 纹理 */

export interface S3MTexture {
  code: string;
  level: number;
  width: number;
  height: number;
  compressType: number;
  pixelFormat: number;
  data: Uint8Array;
}

/* ------------------------------------------------------------------ 瓦片 */

export interface ParsedTile {
  version: number;
  compressedType: number;
  options: number;
  groupNode: GroupNode;
  geoPackage: Record<string, GeoPackageEntry>;
  textures: Record<string, S3MTexture>;
  materials: unknown;
  pickInfo: unknown;
  extensions?: unknown;
  /** 实际消费的字节数，应与 bytesTotal 相等 */
  bytesRead: number;
  bytesTotal: number;
}

/* ------------------------------------------------------------------ 配置 */

export interface Anchor {
  lon: number;
  lat: number;
  /** 锚点椭球高（米） */
  height: number;
}

export interface Stats {
  tiles: number;
  loading: number;
  failed: number;
  meshes: number;
  vertices: number;
  triangles: number;
  datasets: number;
}

/* ------------------------------------------------------------------ 单体属性 */

export interface FeatureAttributes {
  smid: number | null;
  /** 建筑高度（米），单体包围盒 z 跨度 */
  height?: number;
  /** 基底高程（米），相对数据集锚点 */
  baseElevation?: number;
  /** 外接盒平面尺寸 [宽, 深]（米） */
  size?: [number, number];
  /** 外接盒底面积（㎡），异形建筑会偏大 */
  bboxArea?: number;
  /** 楼层估算 = 高度 / 层高 */
  floors?: number;
  /** 本单体自身的三角面数 */
  triangles?: number;
  vertices?: number;
  /** 单体局部包围盒 [[minX,minY,minZ],[maxX,maxY,maxZ]]（米） */
  bbox?: [[number, number, number], [number, number, number]];
}

export interface SegmentBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  count: number;
  triangles: number;
}

/* ------------------------------------------------------------------ 着色 */

/** 全局共享 uniform：所有材质引用同一批对象，改 .value 即全场景生效 */
export interface StyleUniforms {
  uMode: { value: number };
  uColorA: { value: Color };
  uColorB: { value: Color };
  uColorC: { value: Color };
  uTime: { value: number };
  uHeightMin: { value: number };
  uHeightMax: { value: number };
  uFloorHeight: { value: number };
  uDim: { value: number };
  uDimFactor?: { value: number };
  uSelColor: { value: Color };
  uSelMix: { value: number };
  uSelMode?: { value: number };
  uSelOpacity?: { value: number };
  uSelEmissive?: { value: number };
  uSelElevation?: { value: number };
  uFilterMinZ?: { value: number };
  uFilterMaxZ?: { value: number };
  uFilterHeightActive?: { value: number };
  uRoofThreshold?: { value: number };
  uTexMix?: { value: number };
  [key: string]: { value: unknown } | undefined;
}
