/**
 * CRN（crunch）纹理 → DXT 块数据
 *
 * S3M 的 `pixelFormat` 26 / 27 都是 CRN 容器（`CRN_DXT5` / `STANDARD_CRN`）：
 * 里面不再是裸 DXT 块，而是 crunch 自己的一套熵编码，必须先转码回 DXT 才能上传。
 * iServer 在「纹理压缩 = CRN_DXT5」时会把整包纹理都压成这个格式，所以这不是边角情况。
 *
 * 官方 SDK 走的是同一套 wasm（见 src/vendor/crunch_decoder.module.js），
 * 这里只做一件事：把 S3M 的裸块交给 wasm，拿回 DXT 字节，再交回现有的 DXT 解码链路。
 */
import type { CrunchModule } from '../vendor/crunch_decoder.module.js';

export interface CRNResult {
  width: number;
  height: number;
  /** CRN 里打包的 mip 层数（我们只取第 0 层，其余交给 three 生成） */
  levels: number;
  /** 1 / 3 / 5 */
  dxtFormat: 1 | 3 | 5;
  /** 第 0 层的 DXT 块数据 */
  data: Uint8Array;
}

let modulePromise: Promise<CrunchModule> | null = null;

/**
 * wasm 是否真的可用。
 *
 * 注意：胶水在实例化开始前就把 `Module.asm` 赋成了空对象，所以「asm 存在」不等于
 * 「就绪」——必须看导出表里有没有东西，否则 `_malloc` 会在内部对一个 undefined 调 apply。
 */
function isReady(m: CrunchModule): boolean {
  return !!m.asm && Object.keys(m.asm).length > 0;
}

/** wasm 只在真的遇到 CRN 纹理时才加载（内联在 vendor 里，不发额外请求） */
async function getCrunch(): Promise<CrunchModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await import('../vendor/crunch_decoder.module.js');
      const m = mod.default;
      if (!isReady(m)) {
        await new Promise<void>((resolve) => {
          m.onRuntimeInitialized = () => resolve();
          const tick = (): void => {
            if (isReady(m)) resolve();
            else setTimeout(tick, 8);
          };
          tick();
        });
      }
      return m;
    })();
  }
  return modulePromise;
}

/** CRN 文件头魔数 'Hx'；S3M 的纹理裸块没有容器头，但 crunch 负载自己保留了这两个字节 */
const CRN_MAGIC = [0x48, 0x78] as const;

function hasMagic(src: Uint8Array): boolean {
  return src.length >= 2 && src[0] === CRN_MAGIC[0] && src[1] === CRN_MAGIC[1];
}

/** 解一个 CRN 块。失败时抛错（调用方负责降级成「无贴图」）。 */
export async function transcodeCRN(src: Uint8Array): Promise<CRNResult> {
  const srcSize = src.byteLength;
  if (!srcSize) throw new Error('[s3m] CRN 数据为空');
  // 先验魔数：压缩方式标成 CRN 但数据其实不是（见过 DXT 被误标）时，
  // crunch 会拿垃圾头解出一个尺寸「看着合理」的块，越早拦越好；也省掉一次 wasm 加载
  if (!hasMagic(src)) throw new Error('[s3m] 数据没有 CRN 头（Hx），不是 crunch 负载');

  const crunch = await getCrunch();

  const srcPtr = crunch._malloc(srcSize);
  if (!srcPtr) throw new Error('[s3m] crunch 分配源数据失败');
  try {
    // 注意：malloc 可能触发堆扩容，HEAPU8 会换成新视图，所以每次都重新取
    crunch.HEAPU8.set(src, srcPtr);

    const fmt = crunch._crn_get_dxt_format(srcPtr, srcSize);
    const dxtFormat = fmt === 0 ? 1 : fmt === 1 ? 3 : fmt === 2 ? 5 : 0;
    if (!dxtFormat) throw new Error(`[s3m] 不是可识别的 CRN 数据（dxtFormat=${fmt}）`);

    const width = crunch._crn_get_width(srcPtr, srcSize);
    const height = crunch._crn_get_height(srcPtr, srcSize);
    const levels = crunch._crn_get_levels(srcPtr, srcSize);
    if (!(width > 0) || !(height > 0)) {
      throw new Error(`[s3m] CRN 尺寸异常：${width}×${height}`);
    }

    // 只解第 0 层：DXT1 每 4×4 块 8 字节，DXT3/5 是 16 字节
    const blockSize = dxtFormat === 1 ? 8 : 16;
    const dstSize = Math.max(1, width >> 2) * Math.max(1, height >> 2) * blockSize;
    const dstPtr = crunch._malloc(dstSize);
    if (!dstPtr) throw new Error('[s3m] crunch 分配输出缓冲失败');
    try {
      crunch._crn_decompress(srcPtr, srcSize, dstPtr, dstSize, 0, 1);
      const data = new Uint8Array(crunch.HEAPU8.subarray(dstPtr, dstPtr + dstSize));
      return { width, height, levels, dxtFormat: dxtFormat as 1 | 3 | 5, data };
    } finally {
      crunch._free(dstPtr);
    }
  } finally {
    crunch._free(srcPtr);
  }
}
