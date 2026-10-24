import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { PAGES, buildPageData, createRenderer } from './scripts/markdown.mjs';

const SITE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(SITE, '..');
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const OUTLET = '<!--ssr-outlet-->';
const DATA_OUTLET = '<!--s3m-page-data-->';
const HYDRATION_OUTLET = '<!--s3m-hydration-->';

/**
 * 本地预览：vite dev 时直接在中间件里做一次 SSG，
 * 这样改 markdown 保存后刷新就能看到真实产出，不用跑全量 build。
 */
function docsSsgDev(): Plugin {
  return {
    name: 's3m-docs-ssg-dev',
    apply: 'serve',
    async configureServer(server) {
      const renderer = await createRenderer();

      server.watcher.add([
        path.join(ROOT, 'packages/s3m-maplibre/docs'),
        path.join(ROOT, 'packages/s3m-three/docs'),
      ]);
      server.watcher.on('change', (file) => {
        if (file.endsWith('.md')) server.ws.send({ type: 'full-reload' });
      });

      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '/').split('?')[0];
        const entry = url.replace(/^\//, '') || 'index.html';
        const page = PAGES.find((p) => p.entry === entry);
        if (!page) return next();

        try {
          const data = await buildPageData(page, renderer, ROOT);
          const { render, hydrationScript } = await server.ssrLoadModule('/src/entry-server.tsx');
          const template = await server.transformIndexHtml(
            `/${page.entry}`,
            await readFile(at(`./${page.entry}`), 'utf8'),
          );

          const payload = JSON.stringify(data).replace(/</g, '\\u003c');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            template
              .replace(HYDRATION_OUTLET, hydrationScript)
              .replace(OUTLET, render(data))
              .replace(DATA_OUTLET, `<script type="application/json" id="s3m-page-data">${payload}</script>`),
          );
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

/**
 * 文档站 + 示例的 vite 配置。
 *
 * solid({ ssr: true }) 是 SSG 的关键，不是笔误：
 * 插件只有在 ssr 选项打开时才会给客户端产物也加上 hydratable，
 * 否则浏览器端没有 hydration key，SSR 出来的 DOM 不会被接管
 * （表现为事件全失效、signal 更新不重绘）。generate 模式由插件按
 * environment.consumer 自动区分：构建客户端用 dom，--ssr 构建用 ssr。
 */
export default defineConfig({
  // 必须显式指定：dev 从仓库根启动，不写的话 root 会变成仓库根，
  // /src/entry-server.tsx 这类路径全部解析失败
  root: SITE,
  // 产物落在仓库根的 docs/ 下，页面只在一层目录里，用相对 base 最省心：
  // 本地 file:// 预览、GitHub Pages 子路径部署都不用再配 PAGES_BASE。
  base: './',
  plugins: [solid({ ssr: true }), docsSsgDev()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      // 入口放在 site 根：产物就是 dist/index.html + dist/three.html + dist/assets/，
      // 拷进仓库根 docs/ 后相对路径不用做任何调整
      input: {
        docs: at('./index.html'),
        three: at('./three.html'),
      },
    },
  },
  ssr: {
    // SSR 打包时不能 external：Node 里 import 'solid-js' 拿到的是浏览器构建
    noExternal: ['solid-js'],
  },
});
