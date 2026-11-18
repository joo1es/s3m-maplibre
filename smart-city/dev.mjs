/**
 * 一键起这个 showcase：node smart-city/dev.mjs [--watch]
 *
 * 本机 shell 注入了 NODE_OPTIONS=--use-system-ca，会让 vite 静默失败，
 * 所以这里在子进程里把它清掉，用户不用自己记 NODE_OPTIONS= 前缀。
 * 端口在 vite.config.mjs 里（5174，不抢平时 bun run dev 的 5173）。
 *
 * `--watch`（推荐日常用）：
 *   监听 packages/s3m-three/src 与 packages/s3m-maplibre/src，改完自动重建 dist；
 *   vite 侧不再忽略 dist/，所以重建完成后浏览器会自己刷新。
 *
 *   为什么要这一步：demo import 的是 `packages/<pkg>/dist` 而不是源码（这也是线上
 *   路径）。以前改完内核必须手动 build + 手动重启 dev server，忘了任何一步就会
 *   拿旧代码测半天 —— 2026-11-18 就被这个坑了一轮。现在两条都自动。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const env = { ...process.env };
delete env.NODE_OPTIONS;

const WATCH = process.argv.includes('--watch');
const WATCH_DIRS = [
  path.join(ROOT, 'packages', 's3m-three', 'src'),
  path.join(ROOT, 'packages', 's3m-maplibre', 'src'),
];

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/* ------------------------------------------------------------------ vite */

const child = spawn(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join(HERE, 'vite.config.mjs'),
    '--host', '127.0.0.1',
  ],
  { cwd: ROOT, stdio: 'inherit', env },
);

/* ------------------------------------------------------------------ 内核重建 */

/** 跑一条命令，resolve 退出码；stdout/stderr 直通，看得见构建报错 */
function run(command, args) {
  return new Promise((resolve) => {
    const p = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env, shell: true });
    p.on('error', (e) => { console.error(cyan('[city]'), '构建命令启动失败：', e.message); resolve(1); });
    p.on('exit', (code) => resolve(code ?? 0));
  });
}

let building = false;
let pending = false;
let timer = null;
let lastBuildMs = 0;

async function rebuild() {
  if (building) { pending = true; return; }
  building = true;
  const t0 = Date.now();
  console.log(cyan('[city]'), '内核源码变化 → 重建中…');
  // 两个包有依赖顺序：maplibre 的产物会内联 three 的 dist
  const a = await run('bun', ['run', 'build:three']);
  const b = a === 0 ? await run('bun', ['run', 'build:maplibre']) : 1;
  lastBuildMs = Date.now() - t0;
  building = false;
  if (a !== 0 || b !== 0) {
    console.log(cyan('[city]'), `重建失败（${lastBuildMs}ms），浏览器保持上一版；修好保存即会再试`);
  } else {
    console.log(cyan('[city]'), `重建完成（${lastBuildMs}ms），浏览器应已自动刷新`);
  }
  if (pending) { pending = false; schedule(); }
}

function schedule() {
  clearTimeout(timer);
  // 编辑器保存常常连着触发好几次（格式化 + 写盘），攒一下再构建
  timer = setTimeout(rebuild, 350);
}

function startWatch() {
  const missing = WATCH_DIRS.filter((d) => !fs.existsSync(d));
  if (missing.length) {
    console.warn(cyan('[city]'), '找不到监听目录：', missing.join(', '));
  }
  for (const dir of WATCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.watch(dir, { recursive: true }, (_evt, file) => {
        // 只关心源码，忽略临时文件与 sourcemap
        if (!file || /\.(map|swp|tmp)$/.test(file) || path.basename(file).startsWith('.')) return;
        schedule();
      });
    } catch (e) {
      console.warn(cyan('[city]'), `监听 ${dir} 失败：`, e.message);
    }
  }
  console.log(cyan('[city]'), dim('已开启内核热更：改 packages/*/src 会自动 build + 刷新页面'));
  // 启动时先建一次，保证 dist 与源码一致（首次 clone / 切分支后尤其需要）
  schedule();
}

if (WATCH) startWatch();

/* ------------------------------------------------------------------ 退出 */

const stop = () => {
  clearTimeout(timer);
  child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
