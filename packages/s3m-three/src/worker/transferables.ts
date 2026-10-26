/**
 * 传输清单收集：递归扫出对象图里所有可 Transfer 的 ArrayBuffer（去重）。
 *
 * 用于 Worker 往返的零拷贝：postMessage 的 transferList 传这个清单后，
 * 线程间共享同一块内存（structured clone 只拷贝「壳」，不拷字节）。
 *
 * 安全性约定：**要么全转，要么不转** —— 同一块 ArrayBuffer 上可能挂着多个视图
 * （positions / normals 常是同一块顶点缓冲的 subarray），transferList 里出现它一次
 * 之后所有视图共享的底层数据整体过线，视图本身仍然有效；但如果只转一半视图、
 * 另一半留在原地，留在原地的会因 detach 变成空数据。所以只允许「把整个对象图
 * 的 buffer 全部收集」或「完全不收集」两种用法，不支持挑着转。
 */

/** 递归深度上限。ParsedTile 的层级是固定的（tile → geoPackage → geode → package），远用不到 12 层 */
const MAX_DEPTH = 12;

export function collectTransferables(root: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const seen = new Set<object>();

  const walk = (value: unknown, depth: number): void => {
    if (value == null || depth > MAX_DEPTH) return;
    if (ArrayBuffer.isView(value)) {
      const b = (value as ArrayBufferView).buffer;
      if (b instanceof ArrayBuffer) buffers.add(b);
      return;
    }
    if (value instanceof ArrayBuffer) {
      buffers.add(value);
      return;
    }
    if (typeof value !== 'object') return;
    const obj = value as object;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    if (obj instanceof Map) {
      for (const [k, v] of obj) {
        walk(k, depth + 1);
        walk(v, depth + 1);
      }
      return;
    }
    if (obj instanceof Set) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(obj)) {
      walk((obj as Record<string, unknown>)[key], depth + 1);
    }
  };

  walk(root, 0);
  return [...buffers];
}
