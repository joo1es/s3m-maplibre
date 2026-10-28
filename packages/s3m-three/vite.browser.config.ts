import { fileURLToPath } from 'node:url';
import { createLogger, defineConfig, type Logger } from 'vite';

const PKG = fileURLToPath(new URL('.', import.meta.url));

/**
 * 滤掉 rolldown:vite-resolve 对 node 内建模块的 externalize 信息打印。
 * draco 的 emscripten 胶水里有 Node 分支 require('node:fs')，浏览器永远走不到；
 * 产物已用 stubNodeBuiltins 指到空占位（bundle 里没有 shim），这条打印纯属噪音。
 */
function quietLogger(): Logger {
  const logger = createLogger();
  const filter = (msg: string): boolean => !msg.includes('has been externalized for browser compatibility');
  const warn = logger.warn.bind(logger);
  const warnOnce = logger.warnOnce.bind(logger);
  logger.warn = (msg, options) => {
    if (filter(msg)) warn(msg, options);
  };
  logger.warnOnce = (msg, options) => {
    if (filter(msg)) warnOnce(msg, options);
  };
  return logger;
}

/**
 * 把 emscripten vendor（draco / crunch）里的 Node 分支 require('node:fs')
 * 指到浏览器空占位。enforce: 'pre' 必须放在 vite 顶层 plugins 里才生效——
 * 放 rollupOptions.plugins 会被排到 vite 内部 resolve 插件之后，拦不住。
 * 浏览器里这个分支永远不执行，占位只为不让 node:fs 的 shim 进产物。
 */
const stubNodeBuiltins = {
  name: 'stub-node-builtins-for-browser',
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (source === 'node:fs') {
      return fileURLToPath(new URL('./src/vendor/browser-node-stub.js', import.meta.url));
    }
    return null;
  },
};

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
    customLogger: quietLogger(),
    // 见 stubNodeBuiltins 注释：必须顶层 + enforce: 'pre' 才能赶在 vite-resolve 之前
    plugins: [stubNodeBuiltins],
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
        // iife 没有 import.meta：把「new URL(worker, import.meta.url)」里的 import.meta
        // 显式定义为空对象——与 rolldown 的隐式替换等价（worker 创建失败 → create()
        // 返回 null → 降级主线程解析），但不再刷 [EMPTY_IMPORT_META] 告警。
        transform: {
          define: { 'import.meta': '({})' },
        },
      },
    },
  };
});
