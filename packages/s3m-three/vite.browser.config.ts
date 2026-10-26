import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const PKG = fileURLToPath(new URL('.', import.meta.url));

/**
 * 浏览器直引包（<script> 直接引入，不依赖打包器）。一次构出两个文件：
 *
 *   s3m-three.iife.js             内置 three，开箱即用。加载时顺手把这份 three 挂到
 *                                 window.THREE（页面里没有才挂），用户拿它搭自己的场景
 *                                 用的就是同一个实例，不会出现第二份。
 *   s3m-three.iife.ext-three.js   外置 three，读页面上的 window.THREE，约 20 KB，
 *                                 给「已经有 three」的工程用。
 *
 * 只出 IIFE：AMD 不在 vite 的 lib 格式白名单里；UMD 在 three 停发 UMD（r160）之后没意义。
 */
export default defineConfig(({ mode }) => {
  const externalThree = mode === 'ext';

  return {
    root: PKG,
    build: {
      outDir: 'dist/browser',
      // ext-three 是第二轮构建，别把第一轮的产物清掉
      emptyOutDir: !externalThree,
      target: 'es2020',
      // 解析 Worker（new Worker(new URL(...), { type: 'module' })）按 ESM 打成独立资产
      worker: {
        format: 'es',
      },
      // 这个文件是给人 <script> 直接引的，不打 map
      sourcemap: false,
      lib: {
        entry: 'src/browser.ts',
        formats: ['iife'],
        name: 'S3M',
        fileName: () => (externalThree ? 's3m-three.iife.ext-three.js' : 's3m-three.iife.js'),
      },
      rollupOptions: {
        external: externalThree ? ['three'] : [],
        output: {
          // 入口同时有具名导出和 default，显式声明 named 才不会有混合导出警告
          exports: 'named',
          ...(externalThree ? { globals: { three: 'THREE' } } : {}),
        },
      },
    },
  };
});
