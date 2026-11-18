/**
 * 智慧城市 showcase 的独立开发服务。
 *
 * 刻意不复用 site/vite.config.ts：那边有 SSG、文档路由与 404 兜底，加一个页面要改主项目。
 * 这里 root 就是本目录，主项目一行都不动；但要能 import 仓库里的 workspace 包与
 * site/src/examples 的现成特效，所以 fs.allow 放开到仓库根，并 dedupe three 保证单实例。
 *
 * 端口 5174：用户平时跑的 bun run dev 占着 5173，不抢端口。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');

export default defineConfig({
  root: DIR,
  base: './',
  server: {
    port: 5174,
    strictPort: false,
    fs: { allow: [ROOT] },
    // _tmp 里是十几万条抓取缓存，watcher 扫进去会白烧一遍 CPU。
    //
    // ★ 这里**不能**再忽略 dist 目录：demo 加载的是 packages/<pkg>/dist（线上也是
    //   这条路径），忽略之后 `node smart-city/dev.mjs --watch` 重建完 dist，vite 不会
    //   失效模块图，浏览器继续跑旧代码 —— 改完内核却看不到变化，很容易误判成
    //   「改动没生效」而回去改代码。宁可让 watcher 多扫两个 dist 目录。
    watch: { ignored: ['**/_tmp/**', '**/node_modules/**'] },
  },
  resolve: { dedupe: ['three'] },
  build: { target: 'es2022', outDir: 'dist' },
});
