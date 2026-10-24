/**
 * 文档站构建：vite(client) → vite(ssr) → Solid renderToString → 注入页面 → 拷贝到仓库根 docs/
 *
 *   packages/pkg/docs/API.md  →  site/dist/index.html  →  docs/index.html   （URL 不变）
 *                             →  site/dist/three.html  →  docs/three.html
 *
 * 正文 HTML 由 shiki / markdown-it 在 Node 里算好（不进浏览器包），
 * 布局外壳由 Solid 在 SSR 里渲染、浏览器端再 hydrate。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, writeFile, rm, cp, stat, readdir } from 'node:fs/promises';
import { build } from 'vite';
import { PAGES, buildPageData, createRenderer } from './markdown.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const CONFIG = path.join(SITE, 'vite.config.ts');
const DIST = path.join(SITE, 'dist');
const SSR_OUT = path.join(SITE, 'dist-ssr');
const TARGET = path.join(ROOT, 'docs');
const OUTLET = '<!--ssr-outlet-->';
const DATA_OUTLET = '<!--s3m-page-data-->';
const HYDRATION_OUTLET = '<!--s3m-hydration-->';

const started = Date.now();
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/**
 * 把 vite 注入的 <link rel="stylesheet"> 换成内联 <style>。
 *
 * vite 会把 html 里引用的样式表统一挪到 head 末尾、且排在 module script 之后，
 * 首访/弱网下浏览器可能先画出一帧无样式内容（就是「进去闪一下」）。
 * 样式一共 8 KB 出头，内联后页面自包含：零额外请求、零 FOUC，
 * file:// 直接打开也和线上一致。
 */
async function inlineStylesheet(html) {
  const match = html.match(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
  if (!match) return html;
  const css = await readFile(path.join(DIST, match[1].replace(/^\.\//, '')), 'utf8');
  return html.replace(match[0], `<style>${css}</style>`);
}

async function main() {
  console.log('[docs] 构建前端资源…');
  // 入口/输出目录由这里指定：同一份 vite.config.ts 也被 demo 构建复用
  await build({
    root: SITE,
    configFile: CONFIG,
    logLevel: 'warn',
    build: {
      outDir: DIST,
      emptyOutDir: true,
      rollupOptions: {
        input: Object.fromEntries(
          PAGES.map((p) => [p.entry.replace(/\.html$/, ''), path.join(SITE, p.entry)]),
        ),
      },
    },
  });

  // 单独打 SSR 包：build.ssr 会把 environment 切到 server，
  // solid 插件据此把 JSX 编译成服务端模式（同一份 config，不能用两份，否则客户端会丢 hydratable）
  console.log('[docs] 构建 SSR 入口…');
  const entryServer = path.join(SITE, 'src', 'entry-server.tsx');
  await build({
    root: SITE,
    configFile: CONFIG,
    logLevel: 'warn',
    build: {
      ssr: entryServer,
      outDir: SSR_OUT,
      emptyOutDir: true,
      rollupOptions: { input: entryServer },
    },
  });

  const { render, hydrationScript } = await import(
    pathToFileURL(path.join(SSR_OUT, 'entry-server.js')).href,
  );
  const renderer = await createRenderer();

  for (const page of PAGES) {
    const data = await buildPageData(page, renderer, ROOT);
    const shell = render(data);

    const templatePath = path.join(DIST, page.entry);
    const template = await readFile(templatePath, 'utf8');
    for (const mark of [OUTLET, DATA_OUTLET, HYDRATION_OUTLET]) {
      if (!template.includes(mark)) throw new Error(`${page.entry} 缺少 ${mark} 占位`);
    }

    // 页面数据必须放在 #root 外面：放进 root 会让 hydrate 多遍历一个节点而失配
    const payload = JSON.stringify(data).replace(/</g, '\\u003c');
    const html = await inlineStylesheet(
      template
        .replace(HYDRATION_OUTLET, hydrationScript)
        .replace(OUTLET, shell)
        .replace(DATA_OUTLET, `<script type="application/json" id="s3m-page-data">${payload}</script>`),
    );

    await writeFile(templatePath, html, 'utf8');
    const size = (await stat(templatePath)).size;
    console.log(
      `  ✓ ${page.brand.padEnd(13)} ${page.entry.padEnd(11)} ${String(data.toc.length).padStart(3)} 节  ${kb(size)}`,
    );
  }

  // 整体替换 docs/：旧产物（含早年的单文件 html）不会残留
  await rm(TARGET, { recursive: true, force: true });
  await cp(DIST, TARGET, { recursive: true });

  // 样式已内联进 html，assets 里那份 css 没人引用了，删掉免得看着像漏改
  const assetsDir = path.join(TARGET, 'assets');
  for (const name of await readdir(assetsDir).catch(() => [])) {
    if (name.endsWith('.css')) await rm(path.join(assetsDir, name), { force: true });
  }

  // dist/ 与 dist-ssr/ 只是中转站，产物已经落到 docs/，留着只会越积越多
  await rm(SSR_OUT, { recursive: true, force: true });
  await rm(DIST, { recursive: true, force: true });

  console.log(
    `[docs] 输出 docs/ （${PAGES.length} 页，${((Date.now() - started) / 1000).toFixed(1)}s）`,
  );
}

main().catch((err) => {
  console.error('[docs] 构建失败:', err);
  process.exit(1);
});
