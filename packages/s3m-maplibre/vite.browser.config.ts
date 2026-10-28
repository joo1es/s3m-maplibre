import { fileURLToPath } from 'node:url';
import { createLogger, defineConfig, type Logger } from 'vite';

const PKG = fileURLToPath(new URL('.', import.meta.url));

/**
 * 滤掉 rolldown:vite-resolve 对 node 内建模块的 externalize 信息打印——
 * s3m-three 的 draco emscripten 胶水里有浏览器永远走不到的 Node 分支
 * require('node:fs')，产物已被下面的占位插件指到空模块，这条打印纯属噪音。
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
 * 把 s3m-three dist 里 draco 的 Node 分支 require('node:fs') 指到浏览器空占位
 * （复用 s3m-three 包内的占位文件）。浏览器里该分支永远不执行。
 * 必须顶层 + enforce: 'pre'，rollupOptions.plugins 里的 enforce 会被忽略。
 */
const stubNodeBuiltins = {
  name: 'stub-node-builtins-for-browser',
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (source === 'node:fs') {
      return fileURLToPath(new URL('../s3m-three/src/vendor/browser-node-stub.js', import.meta.url));
    }
    return null;
  },
};

/**
 * 浏览器直引包（<script> 直接引入，不依赖打包器）。一次构出两个文件：
 *
 *   s3m-maplibre.iife.js             内置 three + s3m-three，开箱即用；加载时把 three 挂到
 *                                    window.THREE（页面里没有才挂），不会产生第二份实例。
 *   s3m-maplibre.iife.ext-three.js   外置 three，读页面上的 window.THREE，约 30 KB。
 *
 * maplibre-gl 始终外置：它还在发 UMD，页面里正常引一份就有全局 `maplibregl`。
 */
export default defineConfig(({ mode }) => {
  const externalThree = mode === 'ext';

  return {
    root: PKG,
    customLogger: quietLogger(),
    plugins: [stubNodeBuiltins],
    build: {
      outDir: 'dist/browser',
      // ext-three 是第二轮构建，别把第一轮的产物清掉
      emptyOutDir: !externalThree,
      target: 'es2020',
      sourcemap: false,
      lib: {
        entry: 'src/browser.ts',
        formats: ['iife'],
        name: 'S3MMapLibre',
        fileName: () => (externalThree ? 's3m-maplibre.iife.ext-three.js' : 's3m-maplibre.iife.js'),
      },
      rollupOptions: {
        external: externalThree ? ['three', 'maplibre-gl'] : ['maplibre-gl'],
        output: {
          exports: 'named',
          globals: externalThree
            ? { three: 'THREE', 'maplibre-gl': 'maplibregl' }
            : { 'maplibre-gl': 'maplibregl' },
        },
        // iife 没有 import.meta：S3MWorkerClient 的「new URL(worker, import.meta.url)」
        // 在 iife 下本来就靠 create() 的 try/catch 降级主线程解析。显式定义为空对象
        // 与 rolldown 隐式替换等价，只是不再刷 [EMPTY_IMPORT_META] 告警。
        transform: {
          define: { 'import.meta': '({})' },
        },
      },
    },
  };
});
