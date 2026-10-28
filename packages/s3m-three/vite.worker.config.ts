import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const PKG = fileURLToPath(new URL('.', import.meta.url));

/**
 * 与 vite.browser.config.ts 同款：把 emscripten vendor（draco / crunch）里的
 * Node 分支 require('node:fs') 指到浏览器空占位。Worker 本身跑在浏览器里，
 * Node 分支永远不执行，占位只为消除 externalized 告警。
 * 必须顶层 + enforce: 'pre'，rollupOptions.plugins 里的 enforce 会被忽略。
 */
const stubNodeBuiltins = {
  name: 'stub-node-builtins-for-browser',
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (source === 'node:fs') return fileURLToPath(new URL('./src/vendor/browser-node-stub.js', import.meta.url));
    return null;
  },
};

/**
 * ESM 发行版的解析 Worker 预打包。
 *
 * tsc 只会把 `src/worker/s3mWorker.ts` 编译成一组相对导入的 ESM 文件；
 * 宿主打包器再把 `S3MWorkerClient` 里的 `new Worker(new URL(...))` 当 Worker 入口
 * 重新打包时，Draco / Crunch / MeshOpt 的动态 import 会产生 code-splitting。
 * Vite 默认把 Worker 打成 IIFE，直接报「IIFE ... not supported for
 * code-splitting builds」；就算宿主改成 `worker.format: 'es'`，Worker 与主线程
 * 的同名 vendor chunk 也可能互相覆盖。
 *
 * 所以发行前把 Worker 打成**一个自包含 ES 文件**：宿主再按 Worker 入口打包时
 * 只有一份代码，不产生额外 chunk，也不依赖宿主的 `worker.format` 配置。
 */
export default defineConfig({
  root: PKG,
  plugins: [stubNodeBuiltins],
  build: {
    outDir: 'dist/worker',
    // tsc 先在这里生成 S3MWorkerClient 的 .js/.d.ts，这里只覆盖 Worker 入口
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: 'src/worker/s3mWorker.ts',
      formats: ['es'],
      fileName: () => 's3mWorker.js',
    },
    rollupOptions: {
      output: {
        // Vite 8 / Rolldown 的现行写法；等效于旧版 Rollup 的 inlineDynamicImports
        codeSplitting: false,
      },
    },
  },
});
