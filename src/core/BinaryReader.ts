/**
 * S3M 二进制读取器
 *
 * 约定全部来自 SuperMap/s3m-spec 的 S3ModelParser.js（Apache-2.0）：
 *   - 小端字节序
 *   - String = uint32 字节长度 + UTF-8 字节（无结尾 0）
 *   - 多处需要按 4 字节对齐，且对齐基准点不同（绝对偏移 / 流起点）
 */
import type { BoundingBox, Vec3 } from './types.js';

export class BinaryReader {
  readonly buffer: ArrayBuffer;
  readonly base: number;
  readonly view: DataView;
  offset: number;

  private readonly _decoder = new TextDecoder('utf-8');

  constructor(buffer: ArrayBuffer, byteOffset = 0, byteLength?: number) {
    this.buffer = buffer;
    this.base = byteOffset;
    this.view = new DataView(
      buffer,
      byteOffset,
      byteLength === undefined ? buffer.byteLength - byteOffset : byteLength
    );
    this.offset = 0;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** 返回原始字节视图（不拷贝，生命周期绑定底层 buffer） */
  bytes(n: number): Uint8Array {
    const a = new Uint8Array(this.buffer, this.base + this.offset, n);
    this.offset += n;
    return a;
  }

  /** 返回拷贝，用于纹理等需要脱离源 buffer 的数据 */
  bytesCopy(n: number): Uint8Array {
    const a = new Uint8Array(this.buffer, this.base + this.offset, n);
    this.offset += n;
    return a.slice();
  }

  string(): string {
    const len = this.u32();
    const a = new Uint8Array(this.buffer, this.base + this.offset, len);
    this.offset += len;
    return this._decoder.decode(a);
  }

  skip(n: number): void {
    this.offset += n;
  }

  /**
   * 4 字节对齐。rel 是对齐基准在流中的偏移，默认 0（即整个流起点）。
   * 纹理流用的是「纹理流起点」而不是文件起点，所以要显式传。
   */
  align4(rel = 0): void {
    const m = (this.offset - rel) % 4;
    if (m !== 0) this.skip(4 - m);
  }

  vec3f64(): Vec3 {
    return { x: this.f64(), y: this.f64(), z: this.f64() };
  }

  boundingBox(): BoundingBox {
    return {
      center: this.vec3f64(),
      xExtent: this.vec3f64(),
      yExtent: this.vec3f64(),
      zExtent: this.vec3f64(),
    };
  }
}
