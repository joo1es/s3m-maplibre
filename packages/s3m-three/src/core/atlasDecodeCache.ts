/**
 * 块图集「预解码」缓存（把 DXT 解块搬下主线程）。
 *
 * 背景：主线程上最贵的一笔不是逐瓦片纹理（那条已经走 Worker），而是**块图集**——
 * `.texblock` 里的精灵要解 DXT、拼成一张大图、再按 rect 重排。实测 smart-city
 * 加载期这块占 2.7 秒，全部落在主线程。
 *
 * 做法不是把整条拼图流程改成异步（那会一路 ripple 到解析器），而是：
 *   1. 在 `fillExternalAtlases` 这个**已经是 async** 的位置，把将要解码的原始缓冲
 *      一次性丢给 Worker；
 *   2. Worker 用同一份 `decodeAtlasImage` 解好，零拷贝传回；
 *   3. 结果按**源缓冲对象本身**记账（WeakMap），于是后面的同步 `composeLeafAtlas` /
 *      `packAtlases` 原样调用即可 —— 它们内部的 `decodeAtlasImage` 先查缓存，命中就直接返回。
 *
 * 为什么 key 用 `Uint8Array` 对象而不是内容哈希：同一条纹理在整条链路里是同一个对象
 * （`tex.data` / `img.data` 一路引用下去），WeakMap 既不会误命中也不会泄漏 ——
 * 源缓冲被释放，解码结果跟着回收。
 *
 * 命中不了（Worker 不可用 / 预览失败 / 缓冲不是同对象）一律回退主线程解码，
 * 结果完全一致，只是慢一点。
 */
import type { DecodedAtlasImage } from './AtlasPack.js';

/** 已解码结果：按源缓冲对象记账 */
let _decoded = new WeakMap<Uint8Array, DecodedAtlasImage>();

/** Worker 侧解码条目 */
export interface AtlasDecodeItem {
  width: number;
  height: number;
  pixelFormat: number;
  compressType: number;
  /** 原始（压缩）像素 */
  data: Uint8Array;
}

/** Worker 解码结果：`null` = 这条不需要解（本来就是 RGBA） */
export interface AtlasDecodeResult {
  rgba: Uint8Array | null;
  topDown: boolean;
}

/** 离线程解码器；null = 只用主线程 */
type AtlasDecodeFn = (items: AtlasDecodeItem[]) => Promise<Array<AtlasDecodeResult | null> | null>;

let _offThread: AtlasDecodeFn | null = null;

/**
 * 注册 / 取消离线程图集解码器（形如 `decodeAtlasesWithWorker`）。
 *
 * 传 `null` 退回纯主线程路径 —— Worker 崩溃、被 CSP 挡掉、或宿主环境没有 Worker 时用。
 */
export function setAtlasOffThreadDecode(fn: AtlasDecodeFn | null): void {
  _offThread = fn;
}

/** 当前是否挂着离线程解码器（诊断用） */
export function hasOffThreadAtlasDecode(): boolean {
  return _offThread !== null;
}

/**
 * 把一批原始缓冲送去 Worker 预解码，结果写进缓存。
 *
 * 永不抛：任何失败都按「没解」处理，调用方照常走主线程。
 * 已经是 RGBA 的条目会被跳过（解码本来就是零成本）。
 */
export async function predecodeAtlases(items: AtlasDecodeItem[]): Promise<number> {
  const fn = _offThread;
  if (!fn || items.length === 0) return 0;

  // 只送真正需要解块的（DXT 族），RGBA 原样不送
  const targets = items.filter(
    (it) => it.data && it.width > 0 && it.height > 0 && !(it.compressType === 0 || it.compressType === undefined)
  );
  if (targets.length === 0) return 0;

  let results: Array<AtlasDecodeResult | null> | null;
  try {
    results = await fn(targets);
  } catch {
    return 0;
  }
  if (!results) return 0;

  let hit = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (!r || !r.rgba) continue;
    _decoded.set(targets[i]!.data, { rgba: r.rgba, topDown: r.topDown });
    hit++;
  }
  return hit;
}

/** 取预解码结果（命中即返回，不影响后续再次查询） */
export function takePredecodedAtlas(data: Uint8Array): DecodedAtlasImage | undefined {
  return _decoded.get(data);
}

/** 清空缓存（单测用；WeakMap 没有 clear()，只能整个换掉） */
export function resetAtlasDecodeCache(): void {
  _decoded = new WeakMap();
}
