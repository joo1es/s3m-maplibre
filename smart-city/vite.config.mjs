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
    // _tmp 里是十几万条抓取缓存，watcher 扫进去会白烧一遍 CPU
    watch: { ignored: ['**/_tmp/**', '**/node_modules/**', '**/dist/**'] },
  },
  resolve: { dedupe: ['three'] },
  build: { target: 'es2022', outDir: 'dist' },
});
