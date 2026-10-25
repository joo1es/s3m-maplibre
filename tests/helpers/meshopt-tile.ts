/**
 * 合成 v3.01 MeshOpt 瓦片的测试夹具。
 *
 * 官方样例里多块骨架（blockCount > 1）的瓦片都在 SuperMap Online 上，二进制约 1~2 MB，
 * 不适合当仓库夹具；meshopt 属性流也没法手搓（要编码器）。
 * 这里用 meshoptimizer 的编码器在测试内直接合成瓦片：
 *
 *   属性流 = encodeVertexBuffer(量化后的源)   → 走真实解码路径
 *   索引包 = primitiveType 13（未压缩 uint32）→ 无需编码，偏移逻辑逐值可断言
 *
 * 容器各段按 S3MBParser 实测布局写（字段顺序、对齐与真实数据一致），
 * 所以 parseS3MB 的「bytesRead === bytesTotal」能反过来验证夹具本身写得对。
 */
import { MeshoptEncoder } from 'meshoptimizer';

/** 顶点语义位标记（与 core/MeshOpt.ts 保持一致，测试里独立声明避免耦合内部实现） */
export const SEM = {
  POSITION: 0x1,
  NORMAL: 0x4,
  TANGENT: 0x8,
  TEXCOORD0: 0x10,
  COLOR: 0x40,
} as const;

/** 一个 MeshOpt 块的规格；顶点内容由 vertexCount + 量化常量确定，断言时可精确复算 */
export interface BlockSpec {
  vertexCount: number;
  vertScale: number;
  min: [number, number, number];
  /** slot0 纹理坐标量化常量，默认 [1, 1] / [0, 0] */
  texScale?: [number, number];
  texOffset?: [number, number];
  /**
   * 索引包，数组里每个元素是一个包（索引为**块内局部编号**，与真实数据一致）。
   * 解析后第 i 块的包应整体偏移「前面所有块的顶点数之和」。
   */
  indexPacks: number[][];
  /** 塞一条 TANGENT 流（解析端应跳过而不报错） */
  withTangent?: boolean;
}

/** 小端字节写入器（对齐行为与 BinaryReader 一致：string 不带 pad，由调用方 align4） */
class Bin {
  private buf = new Uint8Array(4096);
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

  u8(v: number): void {
    this.need(1);
    this.view.setUint8(this.len, v);
    this.len += 1;
  }
  u16(v: number): void {
    this.need(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
  }
  u32(v: number): void {
    this.need(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }
  i32(v: number): void {
    this.need(4);
    this.view.setInt32(this.len, v | 0, true);
    this.len += 4;
  }
  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
  }
  f64(v: number): void {
    this.need(8);
    this.view.setFloat64(this.len, v, true);
    this.len += 8;
  }
  bytes(b: Uint8Array): void {
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  /** u32 长度前缀 + UTF-8 内容，不带 pad（解析端在哪里 align4 由调用方负责） */
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    this.bytes(b);
  }
  align4(): void {
    const m = this.len % 4;
    if (m !== 0) this.len += 4 - m;
  }
  get out(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** 夹具内顶点属性的量化源：模式固定，测试里可以逐顶点复算期望值 */
export function quantizedPosition(block: BlockSpec, v: number): [number, number, number] {
  return [1000 + v, 2000 + v, 3000 + v];
}
export function quantizedTexCoord(block: BlockSpec, v: number): [number, number] {
  return [10 + v, 20 + v];
}
export function vertexColor(v: number): [number, number, number, number] {
  return [v % 251, 7, 9, 255];
}

let encoderReady: Promise<unknown> | null = null;
function encode(source: Uint8Array, count: number, size: number): Uint8Array {
  encoderReady ??= MeshoptEncoder.ready;
  return MeshoptEncoder.encodeVertexBuffer(source, count, size);
}

function buildSkeleton(w: Bin, blocks: BlockSpec[]): void {
  // compressOptions 0x13 = POSITION | NORMAL | TEXCOORD（与真实 pbr 数据一致）
  w.u32(0x13);
  w.u32(blocks.length);

  for (const block of blocks) {
    const n = block.vertexCount;

    w.u32(n);
    w.f32(block.vertScale);
    for (const v of block.min) w.f64(v);
    // 顺序是 scale0, offset0, scale1, offset1（各一对 f64）
    const ts = block.texScale ?? [1, 1];
    const to = block.texOffset ?? [0, 0];
    w.f64(ts[0]);
    w.f64(ts[1]);
    w.f64(to[0]);
    w.f64(to[1]);
    w.f64(1);
    w.f64(1);
    w.f64(0);
    w.f64(0);

    // 属性流。POSITION stride 8（4×u16）、NORMAL 4（2×i16）、TEXCOORD0 4（2×u16）、COLOR 4（RGBA8）
    const pos = new Uint16Array(n * 4);
    const nrm = new Int16Array(n * 2);
    const tex = new Uint16Array(n * 2);
    const col = new Uint8Array(n * 4);
    for (let v = 0; v < n; v++) {
      const [x, y, z] = quantizedPosition(block, v);
      pos[v * 4] = x;
      pos[v * 4 + 1] = y;
      pos[v * 4 + 2] = z;
      nrm[v * 2] = 32767; // 八面体编码的 (1, 0, 0)
      nrm[v * 2 + 1] = 0;
      const [tu, tv] = quantizedTexCoord(block, v);
      tex[v * 2] = tu;
      tex[v * 2 + 1] = tv;
      const [r, g, b2, a] = vertexColor(v);
      col[v * 4] = r;
      col[v * 4 + 1] = g;
      col[v * 4 + 2] = b2;
      col[v * 4 + 3] = a;
    }

    const attrs: Array<{ semantic: number; data: Uint8Array }> = [
      { semantic: SEM.POSITION, data: encode(new Uint8Array(pos.buffer, 0, pos.byteLength), n, 8) },
      { semantic: SEM.NORMAL, data: encode(new Uint8Array(nrm.buffer, 0, nrm.byteLength), n, 4) },
      { semantic: SEM.TEXCOORD0, data: encode(new Uint8Array(tex.buffer, 0, tex.byteLength), n, 4) },
      { semantic: SEM.COLOR, data: encode(col, n, 4) },
    ];
    if (block.withTangent) {
      // TANGENT 解析端直接跳过，内容不参与解码
      attrs.splice(1, 0, { semantic: SEM.TANGENT, data: new Uint8Array(n * 8) });
    }

    w.i32(attrs.length);
    for (const attr of attrs) {
      w.i32(attr.semantic);
      w.i32(attr.data.length);
      w.bytes(attr.data);
      w.align4();
    }

    w.str('{"TextureCoordMatrix":1,"VertexWeight":0}');
    w.align4();

    // 每块各带一份索引包 —— 这正是多块布局的关键点
    w.i32(block.indexPacks.length);
    for (const indices of block.indexPacks) {
      w.i32(indices.length);
      w.u8(3); // declaredIndexType = UNSIGNED_INT（解析端不信任它，按实际位宽回写）
      w.u8(1); // useIndex
      w.u8(13); // primitiveType = UNCOMPRESSED_INDEX，索引直接是 uint32 数组
      w.u8(0); // pad
      w.i32(indices.length);
      w.bytes(new Uint8Array(new Uint32Array(indices).buffer));
      w.align4();
      w.i32(1); // passCount
      w.str('mat#BatchPBR_0');
      w.align4();
    }
  }

  // v3 骨架末尾的包围盒（readV3BoundingBox：center + 三个轴，各 vec3f64）
  w.f64(0);
  w.f64(0);
  w.f64(0); // center
  w.f64(10);
  w.f64(0);
  w.f64(0); // xExtent
  w.f64(0);
  w.f64(10);
  w.f64(0); // yExtent
  w.f64(0);
  w.f64(0);
  w.f64(10); // zExtent
}

/**
 * 合成一个只含一个 MeshOpt 骨架的 v3.01 瓦片。
 * compressedType = 0（payload 不压缩），省掉一层 zlib 也绕开对 inflate 的依赖。
 */
export function buildMeshOptTile(blocks: BlockSpec[]): ArrayBuffer {
  const p = new Bin();

  // fileOptions：bit0 = 有单体化信息。0 → parsePickInfo 直接返回 null
  p.u32(0);

  // ---- groupNode ----
  p.u32(0); // streamSize（解析端忽略）
  p.u32(1); // pageLOD 数
  p.f32(0); // rangeValue
  p.u16(0); // rangeMode
  p.f64(0);
  p.f64(0);
  p.f64(0); // boundingSphere center
  p.f64(100); // radius
  // OBB：center + 三个轴
  p.f64(0);
  p.f64(0);
  p.f64(0);
  p.f64(1);
  p.f64(0);
  p.f64(0);
  p.f64(0);
  p.f64(1);
  p.f64(0);
  p.f64(0);
  p.f64(0);
  p.f64(1);
  p.str(''); // childTile
  p.u32(0); // geodeCount
  p.str(''); // 动画 JSON
  p.align4();

  // ---- skeletons：一个 MeshOpt 骨架 ----
  p.u32(0); // streamSize（解析端忽略）
  p.u32(1); // 骨架数
  p.u32(0); // skeletonStreamSize（解析端忽略）
  p.str('GeoTest');
  p.align4();
  p.u32(2); // tag = VertexTagV3.MESHOPT
  buildSkeleton(p, blocks);

  // ---- textures / materials / extensions ----
  p.u32(4); // textures streamSize（恰好盖住后面的 count 字段）
  p.u32(0);
  p.u32(0); // materials 长度 = 0
  p.str(''); // extensions

  const payload = p.out;

  // ---- 容器头 ----
  const w = new Bin();
  w.f32(3.01); // version
  w.u32(0); // compressedType = 0：payload 原样使用
  w.u32(payload.length); // uncompressedSize
  w.u32(payload.length); // compressedSize
  w.bytes(payload);

  return w.out.slice().buffer as ArrayBuffer;
}
