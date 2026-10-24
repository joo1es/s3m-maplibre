/**
 * meshoptimizer 解码器的类型声明
 *
 * 只声明 S3M 用到的那部分；wasm 实例在 `ready` 之后才可用，解码本身是同步的。
 */
export interface MeshoptDecoder {
  /** wasm 实例就绪；解码前必须 await */
  ready: Promise<void>;
  /** 环境不支持 WebAssembly 时为 false */
  supported: boolean;
  /**
   * @param target 输出缓冲，长度须为 count * size
   * @param count  顶点数
   * @param size   每顶点字节数（1~256）
   * @param source 压缩数据
   * @param filter 可选滤波器；S3M 传源长度，等价于不滤波
   */
  decodeVertexBuffer(
    target: Uint8Array,
    count: number,
    size: number,
    source: Uint8Array,
    filter?: unknown
  ): void;
  /** @param size 每个索引的字节数（2 或 4） */
  decodeIndexBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array): void;
  decodeIndexSequence(target: Uint8Array, count: number, size: number, source: Uint8Array): void;
}

declare const MeshoptDecoder: MeshoptDecoder;
export default MeshoptDecoder;
