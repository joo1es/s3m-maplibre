import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const PKG = fileURLToPath(new URL('.', import.meta.url));

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
      },
    },
  };
});
