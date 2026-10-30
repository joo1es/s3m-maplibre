/**
 * 合成含 Draco TRIANGULAR_MESH 骨架的 v3.01 S3MB 瓦片（测试夹具）。
 *
 * 由于没有真实的 Draco 三角网格 S3M 瓦片，这里用 draco3d（仅 devDependency）
 * 在测试侧直接编码出一个最小三角网格：4 顶点 2 三角面（正方形）。
 *
 * 容器结构和字段顺序与 Draco.ts 里逐字节标定的点云格式完全一致：
 *   payloadSize / unknown=32 / posUniqueId / normalUniqueId / colorUniqueId /
 *   secondColorUniqueId / texCoordCount / texCoordUniqueIds[] / vertexAttrCount /
 *   dracoSize / draco[] / pad4 / descript / pad4 / obb[12]
 *
 * 由于 Draco 三角网格与点云共用同一套容器头（Issue #5 调研确认），
 * 正确性由「bytesRead === bytesTotal」这个不变量兜底。
 */

/** 与 meshopt-tile.ts 共用的小端字节写入器 */
class Bin {
  private buf = new Uint8Array(65536);
  private view = new DataView(this.buf.buffer);
  len = 0;

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.need(1); this.view.setUint8(this.len, v); this.len += 1; }
  u16(v: number): void { this.need(2); this.view.setUint16(this.len, v, true); this.len += 2; }
  u32(v: number): void { this.need(4); this.view.setUint32(this.len, v >>> 0, true); this.len += 4; }
  i32(v: number): void { this.need(4); this.view.setInt32(this.len, v | 0, true); this.len += 4; }
  f32(v: number): void { this.need(4); this.view.setFloat32(this.len, v, true); this.len += 4; }
  f64(v: number): void { this.need(8); this.view.setFloat64(this.len, v, true); this.len += 8; }
  bytes(b: Uint8Array): void {
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    this.bytes(b);
  }
  align4(): void {
    const m = this.len % 4;
    if (m !== 0) this.len += 4 - m;
  }
  /** 回填某个偏移处的 u32 */
  patchU32(offset: number, v: number): void {
    this.view.setUint32(offset, v >>> 0, true);
  }
  get out(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/**
 * 用 draco3d 编码器构造一个最小 TRIANGULAR_MESH 字节流。
 *
 * 几何：正方形（4 顶点 2 三角面）
 *   顶点坐标（xyz）：
 *     0: (0, 0, 0)
 *     1: (1, 0, 0)
 *     2: (1, 1, 0)
 *     3: (0, 1, 0)
 *   三角面（顺时针）：[0,1,2], [0,2,3]
 */
export async function buildDracoMeshBuffer(): Promise<{
  data: Uint8Array;
  posUniqueId: number;
  numFaces: number;
  numPoints: number;
}> {
  // 动态 import，避免正式构建依赖 draco3d
  const createEncoder = (await import('../../node_modules/draco3d/draco_encoder_nodejs.js')).default;
  const draco = await createEncoder();

  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const numPoints = 4;
  const numFaces = 2;

  const meshBuilder = new draco.MeshBuilder();
  const mesh = new draco.Mesh();

  // 添加位置属性
  const posAttr = meshBuilder.AddFloatAttributeToMesh(
    mesh, draco.POSITION, numPoints, 3, positions
  );

  // 添加三角面索引（AddFacesToMesh 直接接受 JS Uint32Array）
  meshBuilder.AddFacesToMesh(mesh, numFaces, indices);

  const encoder = new draco.Encoder();
  const encoderBuffer = new draco.DracoInt8Array();

  const encodedLen = encoder.EncodeMeshToDracoBuffer(mesh, encoderBuffer);
  if (encodedLen === 0) {
    throw new Error('[test] Draco 编码失败');
  }

  const data = new Uint8Array(encodedLen);
  for (let i = 0; i < encodedLen; i++) data[i] = encoderBuffer.GetValue(i);

  // posUniqueId：draco 编码后第一个 POSITION 属性的 unique_id
  // 通过解码器回查（确保与解码端一致）
  const createDecoder = (await import('../../packages/s3m-three/src/vendor/draco_decoder.module.js')).default;
  const decoderMod = await createDecoder();
  const decoder = new decoderMod.Decoder();
  const decodedMesh = new decoderMod.Mesh();
  const status = decoder.DecodeArrayToMesh(data, data.length, decodedMesh);
  if (!status.ok()) throw new Error('[test] 回查解码失败: ' + status.error_msg());
  let posUniqueId = -1;
  for (let i = 0; i < decodedMesh.num_attributes(); i++) {
    const attr = decoder.GetAttribute(decodedMesh, i);
    if (attr.attribute_type() === 0 /* POSITION */) {
      posUniqueId = attr.unique_id();
      break;
    }
  }
  decoderMod.destroy(decoder);
  decoderMod.destroy(decodedMesh);

  draco.destroy(encoderBuffer);
  draco.destroy(mesh);
  draco.destroy(meshBuilder);
  draco.destroy(encoder);

  return { data, posUniqueId, numFaces, numPoints };
}

/**
 * 构造一个包含单个 Draco TRIANGULAR_MESH 骨架的 v3.01 S3MB 瓦片。
 * compressedType = 0（payload 不压缩），布局与 draco.test.ts 使用的点云瓦片相同。
 */
export async function buildDracoMeshTile(): Promise<ArrayBuffer> {
  const { data: dracoBytes, posUniqueId, numFaces: _numFaces, numPoints: _numPoints } = await buildDracoMeshBuffer();

  const skel = new Bin();

  // ---- Draco 容器头（与 Draco.ts 标定布局一致） ----
  const payloadSizeOffset = skel.len;
  skel.u32(0); // payloadSize 占位，后面回填
  const payloadStart = skel.len;

  skel.u32(32); // unknown = 32（实测恒 32）
  skel.i32(posUniqueId); // posUniqueId
  skel.i32(-1); // normalUniqueId（无）
  skel.i32(-1); // colorUniqueId（无）
  skel.i32(-1); // secondColorUniqueId
  skel.u32(0); // texCoordCount = 0（三角网格夹具简化：无自定义属性）
  // texCoordUniqueIds[0] 项：texCoordCount=0，跳过
  skel.u32(0); // vertexAttrCount = 0

  skel.u32(dracoBytes.length); // dracoSize
  skel.bytes(dracoBytes);
  skel.align4();

  const descript = ''; // 无自定义属性
  skel.str(descript);
  skel.align4();

  // 回填 payloadSize
  skel.patchU32(payloadSizeOffset, skel.len - payloadStart);

  // 骨架末尾的 OBB（center 3×f64 + 三轴各 3×f64 = 12×f64）
  for (let i = 0; i < 12; i++) skel.f64(i === 0 ? 0 : (i < 3 ? 0 : (i === 3 ? 1 : 0)));

  const skelBytes = skel.out.slice();

  // ---- 完整 S3MB payload ----
  const p = new Bin();

  // fileOptions = 0
  p.u32(0);

  // ---- groupNode ----
  p.u32(0); // streamSize（解析端忽略）
  p.u32(1); // pageLOD 数
  p.f32(500); // rangeValue
  p.u16(1); // rangeMode = PixelSize
  p.f64(0); p.f64(0); p.f64(0); // boundingSphere center
  p.f64(10); // radius
  // OBB：center + 三个轴
  p.f64(0); p.f64(0); p.f64(0);
  p.f64(10); p.f64(0); p.f64(0);
  p.f64(0); p.f64(10); p.f64(0);
  p.f64(0); p.f64(0); p.f64(10);
  p.str(''); // childTile
  p.u32(0); // geodeCount
  p.str(''); // 动画 JSON
  p.align4();

  // ---- skeletons：一个 Draco 骨架 ----
  const skelStreamSizeOffset = p.len;
  p.u32(0); // streamSize（解析端忽略）
  p.u32(1); // 骨架数
  p.u32(skelBytes.length); // skeletonStreamSize —— 解析端用此跳到末尾读 OBB
  p.str('GeoDracoMesh');
  p.align4();
  p.u32(1); // tag = VertexTagV3.DRACO

  p.bytes(new Uint8Array(skelBytes));

  // ---- textures / materials / extensions ----
  p.u32(4); // textures streamSize（盖住后面的 count 字段）
  p.u32(0);
  p.u32(0); // materials 长度 = 0
  p.str(''); // extensions

  const payload = p.out;

  // ---- 容器头 ----
  const w = new Bin();
  w.f32(3.01); // version
  w.u32(0); // compressedType = 0
  w.u32(payload.length); // uncompressedSize
  w.u32(payload.length); // compressedSize
  w.bytes(payload);

  void skelStreamSizeOffset; // 仅用于调试

  return w.out.slice().buffer as ArrayBuffer;
}
