/** crunch wasm 模块（emscripten 胶水），只声明我们用到的导出 */
export interface CrunchModule {
  HEAPU8: Uint8Array;
  /** wasm 实例化完成后指向导出表；实例化开始阶段是空对象，用 keys 判断就绪 */
  asm?: Record<string, unknown>;
  calledRun?: boolean;
  onRuntimeInitialized?: () => void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  /** 0 = DXT1，1 = DXT3，2 = DXT5；其它值表示不是合法 CRN */
  _crn_get_dxt_format(src: number, size: number): number;
  _crn_get_levels(src: number, size: number): number;
  _crn_get_width(src: number, size: number): number;
  _crn_get_height(src: number, size: number): number;
  /** 解出 DXT 数据。firstLevel / levels 控制解哪几层 */
  _crn_decompress(
    src: number,
    size: number,
    dst: number,
    dstSize: number,
    firstLevel: number,
    levels: number
  ): void;
}

declare const Crunch: CrunchModule;
export default Crunch;
