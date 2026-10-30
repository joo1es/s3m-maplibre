/**
 * Draco 几何解码器（google/draco，wasm 内联）的类型声明
 *
 * 只声明 S3M 用到的部分。两个坑：
 *   1. `draco.Decoder` 的属性取值接口只接受 embind 的 `Draco*Array`，
 *      直接传 JS TypedArray 会被 embind 当成对象指针，解出来全是 0。
 *   2. 解码产物是 embind 包装的 C++ 对象，用完要 `draco.destroy()`，
 *      否则 wasm 堆只涨不降。
 *
 * draco 的枚举常量（POSITION=0 / NORMAL=1 / COLOR=2 / TEX_COORD=3 / GENERIC=4，
 * DT_FLOAT32=9 / DT_UINT8=2 / DT_UINT16=4 / DT_UINT32=6，POINT_CLOUD=0 /
 * TRIANGULAR_MESH=1）在模块实例上，本文件不重复导出——避免被当成
 * 可从 .js 引入的值。
 */

export interface DracoAttributeTransformData {
  transform_type(): number;
  quantization_bits(): number;
  /** 仅量化变换有效：第 index 个分量的最小值 */
  min_value(index: number): number;
  range(): number;
  __destroy__(): void;
}

export interface DracoPointAttribute {
  attribute_type(): number;
  data_type(): number;
  num_components(): number;
  normalized(): boolean;
  byte_stride(): number;
  byte_offset(): number;
  unique_id(): number;
  size(): number;
  GetAttributeTransformData(): DracoAttributeTransformData;
  __destroy__(): void;
}

export interface DracoPointCloud {
  num_points(): number;
  num_attributes(): number;
  __destroy__(): void;
}


/** draco::Mesh - inherits from PointCloud, additionally provides face info (used for TRIANGULAR_MESH branch) */
export interface DracoMesh extends DracoPointCloud {
  num_faces(): number;
}
export interface DracoStatus {
  ok(): boolean;
  error_msg(): string;
}

export interface DracoDecoder {
  /** 传入的是 draco 字节流开头（至少 5 字节的 "DRACO" magic） */
  GetEncodedGeometryType(data: Uint8Array): number;
  DecodeArrayToPointCloud(
    data: Uint8Array,
    byteLength: number,
    out: DracoPointCloud
  ): DracoStatus;
  /** 解码三角网格（TRIANGULAR_MESH 分支） */
  DecodeArrayToMesh(
    data: Uint8Array,
    byteLength: number,
    out: DracoMesh
  ): DracoStatus;
  /** 从已解码的 Mesh 取第 faceIndex 个面的 3 个顶点索引到 DracoInt32Array */
  GetFaceFromMesh(mesh: DracoMesh, faceIndex: number, out: DracoInt32Array): boolean;
  /** 按属性在几何里的序号取 */
  GetAttribute(pc: DracoPointCloud, index: number): DracoPointAttribute;
  /** 按 unique_id 取；不存在时返回 null */
  GetAttributeByUniqueId(pc: DracoPointCloud, uniqueId: number): DracoPointAttribute | null;
  GetAttributeFloatForAllPoints(pc: DracoPointCloud, attr: DracoPointAttribute, out: DracoFloat32Array): boolean;
  GetAttributeFloatArrayForAllPoints(
    pc: DracoPointCloud,
    attr: DracoPointAttribute,
    out: DracoFloat32Array
  ): boolean;
  GetAttributeInt8ForAllPoints(pc: DracoPointCloud, attr: DracoPointAttribute, out: DracoInt8Array): boolean;
  GetAttributeUInt8ForAllPoints(pc: DracoPointCloud, attr: DracoPointAttribute, out: DracoUInt8Array): boolean;
  GetAttributeInt16ForAllPoints(pc: DracoPointCloud, attr: DracoPointAttribute, out: DracoInt16Array): boolean;
  GetAttributeUInt16ForAllPoints(pc: DracoPointCloud, attr: DracoPointAttribute, out: DracoUInt16Array): boolean;
  GetAttributeInt32ForAllPoints(pc: DracoPointCloud, attr: DracoPointAttribute, out: DracoInt32Array): boolean;
  GetAttributeUInt32ForAllPoints(pc: DracoPointCloud, attr: DracoPointAttribute, out: DracoUInt32Array): boolean;
  __destroy__(): void;
}

/** embind 的定长数组包装：取值必须逐个 GetValue */
export interface DracoFloat32Array {
  size(): number;
  GetValue(index: number): number;
  __destroy__(): void;
}
export interface DracoInt8Array {
  size(): number;
  GetValue(index: number): number;
  __destroy__(): void;
}
export interface DracoUInt8Array {
  size(): number;
  GetValue(index: number): number;
  __destroy__(): void;
}
export interface DracoInt16Array {
  size(): number;
  GetValue(index: number): number;
  __destroy__(): void;
}
export interface DracoUInt16Array {
  size(): number;
  GetValue(index: number): number;
  __destroy__(): void;
}
export interface DracoInt32Array {
  size(): number;
  GetValue(index: number): number;
  __destroy__(): void;
}
export interface DracoUInt32Array {
  size(): number;
  GetValue(index: number): number;
  __destroy__(): void;
}

export interface DracoModule {
  Decoder: new () => DracoDecoder;
  PointCloud: new () => DracoPointCloud;
  Mesh: new () => DracoMesh;
  DracoFloat32Array: new () => DracoFloat32Array;
  DracoInt8Array: new () => DracoInt8Array;
  DracoUInt8Array: new () => DracoUInt8Array;
  DracoInt16Array: new () => DracoInt16Array;
  DracoUInt16Array: new () => DracoUInt16Array;
  DracoInt32Array: new () => DracoInt32Array;
  DracoUInt32Array: new () => DracoUInt32Array;
  /** 释放 embind 对象占用的 wasm 堆 */
  destroy(obj: unknown): void;
}

declare function loadDracoModule(): Promise<DracoModule>;
export default loadDracoModule;
