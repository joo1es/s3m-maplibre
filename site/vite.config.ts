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

/** 样例数据留在仓库 demo/data 下（不进构建产物），dev 直接从磁盘读 */
const DATA_DIR = path.join(ROOT, 'demo', 'data');

/** dev 下的 demo 入口，和线上 demo/index.html 保持同一份模板 */
const DEMO_ENTRY = 'demo.html';
const DEMO_ROUTES = new Set(['/demo', '/demo/', '/demo.html', '/demo/index.html']);

/**
 * 本地预览：vite dev 时在中间件里直接做一次 SSG，
 * 这样一个端口同时提供文档（/、/three.html）与 demo（/demo/），
 * 改 markdown 或组件保存后刷新即可看到真实产出，不用跑全量 build。
 */
function siteDev(): Plugin {
  return {
    name: 's3m-site-dev',
    apply: 'serve',
    async configureServer(server) {
      const renderer = await createRenderer();

      // 正文是构建期渲染的，HMR 管不到 md，只能整页刷新
      server.watcher.add([
        path.join(ROOT, 'packages/s3m-maplibre/docs'),
        path.join(ROOT, 'packages/s3m-three/docs'),
      ]);
      server.watcher.on('change', (file) => {
        if (file.endsWith('.md')) server.ws.send({ type: 'full-reload' });
      });

      // /data/* → 仓库 demo/data/*（.scp 是 JSON，.s3mb 是二进制）
      // demo 挂在 /demo/ 下时相对路径会变成 /demo/data/*，两种前缀都认
      server.middlewares.use(async (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        const rel = url.startsWith('/demo/data/') ? url.slice('/demo'.length) : url;
        if (!rel.startsWith('/data/')) return next();

        const file = path.resolve(DATA_DIR, rel.slice('/data/'.length));
        if (!file.startsWith(DATA_DIR)) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        try {
          const body = await readFile(file);
          res.setHeader(
            'Content-Type',
            /\.(scp|json)$/.test(file) ? 'application/json' : 'application/octet-stream',
          );
          res.end(body);
        } catch {
          // 别落到 SPA fallback：缺失的瓦片会拿到一份 index.html（200 text/html），
          // 前端只能报「瓦片请求返回了 HTML 页面」，看不出到底是文件不存在
          res.statusCode = 404;
          res.end('not found');
        }
      });

      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '/').split('?')[0];
        try {
          // ---- demo 页：只吐面板骨架，地图在 onMount 里加载 ----
          if (DEMO_ROUTES.has(url)) {
            const { render, hydrationScript } = await server.ssrLoadModule(
              '/src/demo/entry-server.tsx',
            );
            const template = await server.transformIndexHtml(
              `/${DEMO_ENTRY}`,
              await readFile(at(`./${DEMO_ENTRY}`), 'utf8'),
            );
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(
              template.replace(HYDRATION_OUTLET, hydrationScript).replace(OUTLET, render()),
            );
            return;
          }

          // ---- 文档页：正文 + 页面数据一起注入 ----
          const entry = url.replace(/^\//, '') || 'index.html';
          const page = PAGES.find((p) => p.entry === entry);
          if (!page) return next();

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
              .replace(
                DATA_OUTLET,
                `<script type="application/json" id="s3m-page-data">${payload}</script>`,
              ),
          );
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

/**
 * 站点配置：文档站 + demo 共用一份。
 *
 * 构建入口与输出目录不写在这里——两边的产物要落到不同目录
 * （docs/ 与 demo/），由 site/scripts/build-*.mjs 各自指定，
 * dev 则统一由 siteDev() 的中间件接管。
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
  // 产物只在一层目录里，用相对 base 最省心：本地 file:// 预览、
  // GitHub Pages 子路径部署都不用再配 PAGES_BASE。
  base: './',
  plugins: [solid({ ssr: true }), siteDev()],
  // three 走包里的 peer，确保只解析出一份实例
  resolve: { dedupe: ['three'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  ssr: {
    // SSR 打包时不能 external：Node 里 import 'solid-js' 拿到的是浏览器构建
    noExternal: ['solid-js'],
  },
});
