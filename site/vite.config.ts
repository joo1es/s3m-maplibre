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
 * dev 下的页面入口。
 *
 * **路由必须显式列出**：中间件没命中就会 `next()`，而 Vite 的 SPA fallback 会把
 * 未命中的路径吐成根 `index.html` —— 文档站的 entry-client 要求页面里有
 * `s3m-page-data`，于是控制台报「缺少 s3m-page-data，页面不是由 SSG 生成的」。
 * 这句话看起来像 SSG 坏了，其实只是路由没接住。末尾还加了一道 404 兜底，
 * 让这类情况以后直接说「没有这个页面」，不再伪装成 SSG 故障。
 */
const ANALYSIS_ENTRY = 'analysis.html';
const ANALYSIS_ROUTES = new Set(['/demo/analysis', '/demo/analysis/', '/demo/analysis.html']);

/** 纯 three.js 演示：只有产物、没有构建入口，dev 直接读仓库里那份 */
const THREE_DEMO_ROUTES = new Set(['/demo/three', '/demo/three.html']);

/**
 * dev 的 URL 结构对齐产物。
 *
 * 以前文档站挂在 `/`、分析页挂在 `/analysis.html`，而产物里是 `docs/index.html`
 * 与 `demo/analysis.html`。两套层级意味着页面里每个相对链接都要判断「现在是不是
 * dev」，判错的后果不是 404，而是拿回一个 200 的文档站模板 —— 也就是上面那句
 * 「页面不是由 SSG 生成」。
 *
 * 现在 dev 直接复用产物的目录结构，页面里只写死相对路径，两套环境完全一致。
 * 旧地址保留 302，免得之前存下的链接失效。
 */
const DEV_REDIRECTS: Record<string, string> = {
  '/': '/docs/index.html',
  '/index.html': '/docs/index.html',
  '/three.html': '/docs/three.html',
  '/analysis': '/demo/analysis.html',
  '/analysis/': '/demo/analysis.html',
  '/analysis.html': '/demo/analysis.html',
  '/docs': '/docs/index.html',
};

/**
 * 必须显式映射的静态前缀：vite 的 root 是 site/，这些目录在 root 之外。
 *
 * 纯 three 演示一共三个请求：`./three.js`、`./vendor/three.module.js`、
 * `../packages/s3m-three/dist/index.js`。不映射就会落到 vite 的兜底上，
 * 浏览器拿到一份 HTML 或直接 404 —— 表现为控制台里一串 MIME / 404 报错。
 */
const STATIC_PREFIXES: Record<string, string> = {
  '/demo/three.js': 'demo/three.js',
  '/demo/vendor/': 'demo/vendor/',
  '/packages/': 'packages/',
};

/** 静态资源响应用的 MIME。three 演示的 importmap 直接引 .js，MIME 错了浏览器会拒执行 */
function mimeOf(file: string): string {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** 404 页：顺手列出 dev 下真正存在的入口，省得再去翻 README */
function pageNotFound(url: string): string {
  const link = (href: string) => `<a href="${href}" style="color:#0ea5e9">${href}</a>`;
  return `<!doctype html>
<meta charset="utf-8">
<title>404</title>
<div style="font:14px/1.8 -apple-system,'Segoe UI','PingFang SC',sans-serif;padding:28px;color:#1e293b">
  <p>dev 下没有这个页面：<code>${url}</code></p>
  <p style="color:#64748b">可用的入口：</p>
  <ul style="color:#475569">
    <li>${link('/docs/index.html')} · 图层文档</li>
    <li>${link('/docs/three.html')} · 内核文档</li>
    <li>${link('/demo/')} · 数据集演示</li>
    <li>${link('/demo/analysis.html')} · 空间分析</li>
    <li>${link('/demo/three.html')} · 纯 three 演示</li>
  </ul>
</div>`;
}

/**
 * 本地预览：vite dev 时在中间件里直接做一次 SSG，
 * 这样一个端口同时提供文档（/docs/）与 demo（/demo/），
 * 改 markdown 或组件保存后刷新即可看到真实产出，不用跑全量 build。
 *
 * dev 的目录结构与线上产物保持一致，这是刻意的：两套层级意味着页面里每个相对
 * 链接都要判断「现在是不是 dev」，判错就是拿回一个 200 的文档站模板。
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

      // ---- 旧地址 302 到产物结构。必须排在所有路由之前 ----
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const to = DEV_REDIRECTS[url];
        if (!to) return next();
        res.statusCode = 302;
        res.setHeader('Location', to);
        res.end();
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

      // ---- root 之外的静态资源 ----
      // 纯 three 演示用 importmap 直接引 `./vendor/three.module.js` 与
      // `../packages/s3m-three/dist/index.js`，这两个目录都在 vite root(site/) 之外，
      // 不显式映射的话浏览器会拿到一份 HTML 兜底页，然后在控制台报 MIME 错。
      server.middlewares.use(async (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        const prefix = Object.keys(STATIC_PREFIXES).find((p) => url.startsWith(p));
        if (!prefix) return next();

        const file = path.resolve(ROOT, STATIC_PREFIXES[prefix] + url.slice(prefix.length));
        // 目录穿越校验：任何 ../ 拼出来的路径都不许出仓库
        if (!file.startsWith(ROOT + path.sep)) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        try {
          const body = await readFile(file);
          res.setHeader('Content-Type', mimeOf(file));
          res.end(body);
        } catch {
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

          // ---- 分析页：纯客户端应用，直接吐模板（没有 SSR 注入） ----
          if (ANALYSIS_ROUTES.has(url)) {
            const template = await server.transformIndexHtml(
              `/${ANALYSIS_ENTRY}`,
              await readFile(at(`./${ANALYSIS_ENTRY}`), 'utf8'),
            );
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(template);
            return;
          }

          // ---- 纯 three 演示：只有产物、没有构建入口，dev 直接读仓库那份 ----
          if (THREE_DEMO_ROUTES.has(url)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(await readFile(path.join(ROOT, 'demo', 'three.html'), 'utf8'));
            return;
          }

          // ---- 文档页：/docs/index.html 与 /docs/three.html，与产物同层级 ----
          const entry = url.startsWith('/docs/') ? url.slice('/docs/'.length) || 'index.html' : '';
          const page = entry ? PAGES.find((p) => p.entry === entry) : undefined;
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

      // ---- 兜底：不存在的页面直接 404 ----
      // 不加这一道，未命中的路径会落进 vite 的 SPA fallback，拿回一份 200 的
      // 文档站模板，客户端再报「不是由 SSG 生成」—— 把「链接写错了」伪装成
      // 「SSG 坏了」。顺序必须在所有页面路由之后、vite 内部中间件之前。
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
        // vite 的模块请求、HMR 通道、预打包依赖都不是页面
        if (
          url.startsWith('/@') ||
          url.startsWith('/__') ||
          url.startsWith('/src/') ||
          url.startsWith('/node_modules/')
        ) {
          return next();
        }
        // 只拦「看起来是页面」的：.html，或者压根没有扩展名
        const isPage = url.endsWith('.html') || path.extname(url) === '';
        if (!isPage) return next();

        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(pageNotFound(url));
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
