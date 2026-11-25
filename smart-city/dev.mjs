/**
 * 一键起这个 showcase：node smart-city/dev.mjs [--watch]
 *
 * 本机 shell 注入了 NODE_OPTIONS=--use-system-ca，会让 vite 静默失败，
 * 所以这里在子进程里把它清掉，用户不用自己记 NODE_OPTIONS= 前缀。
 * 端口在 vite.config.mjs 里（5174，不抢平时 bun run dev 的 5173）。
 *
 * `--watch`（推荐日常用）：
 *   监听 packages/s3m-three/src 与 packages/s3m-maplibre/src，改完自动重建 dist；
 *   构建**全部成功后**由本脚本 POST 一次 `/__city-reload`，浏览器刷新一次。
 *
 *   为什么不让 vite 自己看 dist：一次 `bun run build` 要写五轮文件
 *   （tsc → copy-assets → 三次 vite build），watcher 每轮都 full reload，
 *   12 秒的构建期间浏览器能刷十几次，看起来就是「无限刷新」。所以
 *   vite.config.mjs 里把 `packages/*\/dist` 从 watcher 摘掉了，改由这里收口。
 *
 *   为什么要这一步：demo import 的是 `packages/<pkg>/dist` 而不是源码（这也是线上
 *   路径）。以前改完内核必须手动 build + 手动重启 dev server，忘了任何一步就会
 *   拿旧代码测半天 —— 2026-11-18 就被这个坑了一轮。现在两条都自动。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
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

/* ------------------------------------------------------------------ 端口 */

/**
 * 从 start 往上找一个能监听的空闲端口。
 *
 * 自己算而不是让 vite 自动 +1：主动 reload 得知道端口号。多人同时开两个实例时，
 * 第二个从 5175 起，和 vite 原来的行为一致（只是现在可预测）。
 */
function findFreePort(start, tries = 20) {
  return new Promise((resolve) => {
    const attempt = (p, left) => {
      const srv = net.createServer();
      srv.unref();
      srv.once('error', () => (left > 0 ? attempt(p + 1, left - 1) : resolve(start)));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    attempt(start, tries);
  });
}

const PORT = await findFreePort(5174);

/* ------------------------------------------------------------------ vite */

const child = spawn(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join(HERE, 'vite.config.mjs'),
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--strictPort',
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
/** 待重建的包：只改 three 就只编 three，别顺手把 maplibre 也重编一遍（白等三秒） */
const dirty = new Set();

/**
 * 和 vite 的构建闸门通信（见 vite.config.mjs 的 `reloadOnBuildDone`）。
 *
 *   /start → 静音：构建期间 dist 的几十次写入不触发 HMR，避免刷好几次
 *   /end   → 解除静音 + invalidateAll + 刷一次（新代码一定生效）
 *   /abort → 只解除静音，不刷：构建失败时刷新只会拿到半成品
 *
 * 为什么不能只发一个 "reload"：s3m-maplibre / s3m-three 没进 optimizeDeps，
 * Vite 缓存的是模块图的 transform 结果。不 invalidate 的话，浏览器重新拉到的
 * 还是构建前的代码 —— 表现就是「页面刷了但改动没生效」。
 */
async function signalBuild(stage) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/__city-build${stage}`, { method: 'POST' });
  } catch {
    // dev server 还没起来 / 已经退出：构建产物仍然是对的，下次刷新页面就是新版
  }
}

async function rebuild() {
  if (building) { pending = true; return; }
  if (!dirty.size) return;

  const targets = ['three', 'maplibre'].filter((t) => dirty.has(t));
  dirty.clear();
  building = true;
  const t0 = Date.now();
  console.log(cyan('[city]'), `内核源码变化 → 重建 ${targets.join(' + ')}…`);

  // 先静音：tsc 会连着写几十个 dist 文件，不压住的话 watcher 每批都刷一次
  await signalBuild('/start');

  // 依赖顺序不能反：maplibre 消费的是 three 的 dist 与 .d.ts。
  // 但反过来只改 maplibre 时不需要重编 three（转译产物已经在了）。
  let code = 0;
  for (const t of targets) {
    code = await run('bun', ['run', '--cwd', `packages/s3m-${t}`, 'build:dev']);
    if (code !== 0) break;
  }

  lastBuildMs = Date.now() - t0;
  building = false;
  if (code !== 0) {
    // 失败不刷：浏览器保持上一版，修好保存会再触发一轮
    await signalBuild('/abort');
    console.log(cyan('[city]'), `重建失败（${lastBuildMs}ms），浏览器保持上一版；修好保存即会再试`);
    if (pending) { pending = false; schedule(); }
    return;
  }

  await signalBuild('/end');
  console.log(cyan('[city]'), `重建完成（${lastBuildMs}ms），浏览器已刷新一次`);
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
        dirty.add(dir.includes('s3m-three') ? 'three' : 'maplibre');
        schedule();
      });
    } catch (e) {
      console.warn(cyan('[city]'), `监听 ${dir} 失败：`, e.message);
    }
  }
  console.log(cyan('[city]'), dim('已开启内核热更：改 packages/*/src 会自动 build + 刷新页面'));
  // 启动时先建一次，保证 dist 与源码一致（首次 clone / 切分支后尤其需要）
  dirty.add('three');
  dirty.add('maplibre');
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
