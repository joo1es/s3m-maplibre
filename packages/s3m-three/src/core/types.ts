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

/** MeshOpt 块解码后的原始流清单（语义名 + 每顶点字节数），来自 parseMeshOptGeometry */
export interface MeshOptInfo {
  vertexCount: number;
  compressOptions: number;
  minVertices: [number, number, number];
  vertScale: number;
  texCoordScale: number[][];
  texCoordOffset: number[][];
  streams: Array<{ semantic: string; bytes: number; stride: number }>;
}

export interface VertexPackage {
  verticesCount: number;
  vertexAttributes: VertexAttribute[];
  /** semantic → 在 vertexAttributes 中的下标 */
  attrLocation: Record<string, number>;
  /**
   * MeshOpt 骨架的原始流清单（诊断用，也是接自定义属性 / 高斯泼溅属性的入口）：
   * 每条流解码后每个顶点占 stride 字节，压缩前的字节数在 bytes 里。
   */
  meshOptInfo?: MeshOptInfo;
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
  /**
   * v3 骨架条目末尾自带的 OBB（局部 ENU 系，中心/三个半轴都是 float64）。
   * 多骨架瓦片里每块 geode 的范围各不相同，pageLOD 的包围球只取自其中一块，
   * 要做按块的剔除/贴地就得用它。v2 没有这个字段。
   */
  obb?: BoundingBox;
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
  /**
   * S3MBLOCK 图集为真：数据按 GL 纹理方向（v=0 在最后一行）存储，
   * 解码成 RGBA 后要翻一次行再上传，rect 坐标（offsetY 从 v=0 起）才对得上。
   */
  flipY?: boolean;
  /**
   * 由 AtlasPack 拼合出来的 RGBA 大图（不是文件里的原始 DXT 块）。
   * 这类纹理：① 已是自上而下，flipY 必须为 false；② 不能开 GPU mipmap，
   * 层级由 StyleMaterial 的内联金字塔自己算；③ rect 是拼图坐标系。
   */
  packed?: boolean;
  /**
   * leaf 模式按 `subTexInfos` 把多张精灵贴出来的自上而下 RGBA 画布（可能没进拼图，
   * 只有一张图集时 packAtlases 返回 null）。与 packed 同等对待：flipY=false、
   * 不开 GPU mipmap，层级由 StyleMaterial 的内联金字塔自己算。
   */
  composed?: boolean;
  /**
   * 拼图集合签名（`408x192#id1,id2,...`）。拼图是逐块做的，同一个 atlas id 在不同块里
   * 可能落在不同位置，所以跨瓦片共享纹理时 key 必须带上它，否则会复用别的块的排布。
   */
  packKey?: string;
}

/* ------------------------------------------------------------------ 瓦片 */

/**
 * S3MBLOCK 图集：每个顶点所属子区域的归一化矩形 (x, y, w, h)。
 * 未被绑定覆盖的顶点是 (0, 0, 1, 1)，即整张图集。
 * uv 对应材质 textureunit 0，uv2 对应 unit 1（官方叫 BaseTex / BakeTex）。
 */
export interface S3MAtlasRects {
  uv?: Float32Array;
  uv2?: Float32Array;
  /**
   * 每个顶点所属的绑定组 id（= 块文件里「哪段顶点用哪张子纹理」）。
   * 生成 UV 时按它分组，一组一面墙 → 一张精灵，跟官方 batch 表的语义一致。
   */
  group?: Float32Array;
  /** 每个顶点所属子区域的像素尺寸 (w, h)：决定这段 uv 该怎么平铺 */
  groupDim?: Float32Array;
}

export interface ParsedTile {
  version: number;
  compressedType: number;
  options: number;
  groupNode: GroupNode;
  geoPackage: Record<string, GeoPackageEntry>;
  textures: Record<string, S3MTexture>;
  /** 仅 S3MBLOCK：图集子区域矩形（按骨架名） */
  atlasRects?: Record<string, S3MAtlasRects>;
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
  /** 上一帧 draw call 数（renderer.info.render.calls，无渲染器时为 0） */
  drawCalls: number;
  /** 已编译着色程序数（renderer.info.programs.length） */
  programs: number;
  /** 显存里驻留的纹理数（renderer.info.memory.textures） */
  textures: number;
  /** 显存里驻留的几何数（renderer.info.memory.geometries） */
  geometries: number;
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
  /** 基础漫反射底色增益 / 直通自发光微调（0~1，默认 0.0） */
  uAmbientGain?: { value: number };
  /** 双纹理交叉淡化插值因子（0~1，0 = 状态 A，1 = 状态 B） */
  uBatchMix?: { value: number };
  /** 图层整体透明度（共享 uniform，透明度动画靠它做到 O(1)） */
  uOpacity?: { value: number };
  /** 棱线淡入淡出乘子（setEdges 过渡期间 0→1） */
  uEdgeFade?: { value: number };
  /** 整体压暗乘子（mode 切换的 fade-through） */
  uFade?: { value: number };
  /** GPU 路径数据采样纹理 */
  uPathTex?: { value: unknown };
  /** GPU 路径纹理中包含的路径条数（高度） */
  uPathCount?: { value: number };
  /** 是否激活 GPU 路径动画（0 = 未激活，1 = 激活） */
  uPathTexActive?: { value: number };
  /** GPU 路径全局时间戳（秒） */
  uPathTime?: { value: number };
  [key: string]: { value: unknown } | undefined;
}
