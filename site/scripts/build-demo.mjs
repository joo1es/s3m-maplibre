/**
 * demo 构建：vite(client) → vite(ssr) → Solid renderToString → 注入 → 落到 demo/
 *
 *   site/demo.html  →  site/dist-demo/demo.html  →  demo/index.html
 *                   →  site/dist-demo/assets/    →  demo/assets/
 *
 * 与 build-docs 共用 site/vite.config.ts，入口与 outDir 在这里指定。
 *
 * demo/ 下的 data/、three.html、three.js 是原样保留的静态资源，
 * 所以这里只替换 index.html 与 assets/，不清空整个目录。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, rm, cp, stat, readdir, mkdir } from 'node:fs/promises';
import { build } from 'vite';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const CONFIG = path.join(SITE, 'vite.config.ts');
const DIST = path.join(SITE, 'dist-demo');
const SSR_OUT = path.join(SITE, 'dist-demo-ssr');
const TARGET = path.join(ROOT, 'demo');

const OUTLET = '<!--ssr-outlet-->';
const HYDRATION_OUTLET = '<!--s3m-hydration-->';

const started = Date.now();

async function main() {
  console.log('[demo] 构建前端资源…');
  // 只打 demo 这一个入口，产物落 dist-demo/（docs 那边落 dist/）
  await build({
    root: SITE,
    configFile: CONFIG,
    logLevel: 'warn',
    build: {
      outDir: DIST,
      emptyOutDir: true,
      rollupOptions: { input: { demo: path.join(SITE, 'demo.html') } },
    },
  });

  console.log('[demo] 构建 SSR 入口…');
  const entryServer = path.join(SITE, 'src', 'demo', 'entry-server.tsx');
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
    pathToFileURL(path.join(SSR_OUT, 'entry-server.js')).href
  );

  const htmlPath = path.join(DIST, 'demo.html');
  const template = await readFile(htmlPath, 'utf8');
  for (const mark of [OUTLET, HYDRATION_OUTLET]) {
    if (!template.includes(mark)) throw new Error(`demo.html 缺少 ${mark} 占位`);
  }

  const html = template
    .replace(HYDRATION_OUTLET, hydrationScript)
    .replace(OUTLET, render());

  await writeFile(path.join(TARGET, 'index.html'), html, 'utf8');

  // assets 整体替换，避免残留旧 hash 文件
  await rm(path.join(TARGET, 'assets'), { recursive: true, force: true });
  await mkdir(path.join(TARGET, 'assets'), { recursive: true });
  await cp(path.join(DIST, 'assets'), path.join(TARGET, 'assets'), { recursive: true });

  // 单文件时代的入口，已经被 src/demo/main.js 取代
  await rm(path.join(TARGET, 'main.js'), { force: true });

  const size = (await stat(path.join(TARGET, 'index.html'))).size;
  const assets = await readdir(path.join(TARGET, 'assets'));
  console.log(`  ✓ demo/index.html  ${(size / 1024).toFixed(0)} KB，assets ${assets.length} 个`);

  // dist-demo/ 与 dist-demo-ssr/ 只是中转站，产物已经落到 demo/，留着只会越积越多。
  // 清理是尽力而为：这两个目录都在 .gitignore 里，删不掉只占点磁盘，
  // 不该让一次已经成功的构建被判失败（个别环境的安全删除钩子会拦截 rm）。
  for (const dir of [SSR_OUT, DIST]) {
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[demo] 清理 ${path.basename(dir)} 失败（可忽略）: ${err?.message ?? err}`);
    });
  }
  console.log(`[demo] 输出 demo/ （${((Date.now() - started) / 1000).toFixed(1)}s）`);
}

main().catch((err) => {
  console.error('[demo] 构建失败:', err);
  process.exit(1);
});
