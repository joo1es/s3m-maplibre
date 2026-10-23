/**
 * 极简静态服务器：node tools/serve.mjs [port] [--watch]
 * 从工作区根目录提供服务，这样 demo 能同时访问 s3m-maplibre/ 和 s3m-spec/ 下的样例数据。
 *
 * 加 --watch（等价于 npm run dev）会：
 *   1. 先编译一次 dist，避免浏览器一打开就 404；
 *   2. 起一个 tsc -w 常驻增量编译；
 *   3. 监听 dist/ 与 demo/，文件一变就用 SSE 通知页面自动刷新。
 * 注意 tsc 只负责 .ts，src/vendor 下的第三方 .js 仍由 copy-assets.mjs 拷一次。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const WATCH = args.includes('--watch') || process.env.S3M_WATCH === '1';
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.scp': 'application/json; charset=utf-8',
  '.s3mb': 'application/octet-stream',
  '.s3md': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

/* ------------------------------------------------------------------ 自动刷新 */

const clients = new Set();

function broadcastReload() {
  for (const res of clients) {
    try {
      res.write('data: reload\n\n');
    } catch {
      clients.delete(res);
    }
  }
}

const LIVE_RELOAD_CLIENT = `(() => {
  let es;
  const connect = () => {
    es = new EventSource('/__s3m_reload');
    es.onmessage = (e) => { if (e.data === 'reload') location.reload(); };
    es.onerror = () => { es.close(); setTimeout(connect, 1000); };
  };
  connect();
})();`;

const LIVE_RELOAD_TAG = '<script src="/__s3m_livereload.js"></script>';

function injectLiveReload(html) {
  if (!WATCH) return html;
  const at = html.lastIndexOf('</body>');
  return at === -1 ? html + LIVE_RELOAD_TAG : html.slice(0, at) + LIVE_RELOAD_TAG + html.slice(at);
}

/* ------------------------------------------------------------------ 联动构建 */

function tsc(args) {
  return spawnSync(process.execPath, [join(PROJECT, 'node_modules', 'typescript', 'bin', 'tsc'), ...args], {
    cwd: PROJECT,
    stdio: 'inherit',
  });
}

function buildOnce() {
  const r = tsc(['-p', 'tsconfig.build.json']);
  if (r.status !== 0) console.warn('[watch] 首次编译失败，先修好类型再打开 demo');
  spawnSync(process.execPath, [join(PROJECT, 'tools', 'copy-assets.mjs')], { cwd: PROJECT, stdio: 'inherit' });
}

function startTscWatch() {
  const child = spawn(
    process.execPath,
    [join(PROJECT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json', '-w', '--preserveWatchOutput'],
    { cwd: PROJECT, stdio: 'inherit' }
  );
  child.on('exit', (code) => {
    if (code) console.warn(`[watch] tsc -w 退出，code=${code}`);
  });
  return child;
}

let pending = null;
function reloadSoon(reason) {
  if (pending) clearTimeout(pending);
  // 等 tsc 把这一轮的文件都写完再刷新，否则可能加载到写了一半的 dist
  pending = setTimeout(() => {
    pending = null;
    console.log(`[watch] ${reason} → 刷新浏览器`);
    broadcastReload();
  }, 350);
}

function watchDirs(dirs) {
  for (const [dir, reason] of dirs) {
    try {
      watch(dir, { recursive: true }, (_type, file) => {
        if (!file) return;
        if (/\.(map|tsbuildinfo)$/.test(file)) return;
        reloadSoon(`${reason}/${file}`);
      });
    } catch {
      /* 目录还不存在（比如第一次编译前没有 dist），跳过 */
    }
  }
}

/* ------------------------------------------------------------------ 启动 */

if (WATCH) {
  console.log('[watch] 首次编译…');
  buildOnce();
  startTscWatch();
  watchDirs([
    [join(PROJECT, 'dist'), 'dist'],
    [join(PROJECT, 'demo'), 'demo'],
  ]);
}

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

    // 自动刷新用的两条内部路由
    if (url === '/__s3m_reload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url === '/__s3m_livereload.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
      res.end(LIVE_RELOAD_CLIENT);
      return;
    }

    let file = normalize(join(ROOT, url));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = join(file, 'index.html');

    const data = await readFile(file);
    const ext = extname(file).toLowerCase();
    const body = ext === '.html' ? injectLiveReload(data.toString('utf8')) : data;

    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`demo → http://localhost:${PORT}/s3m-maplibre/demo/index.html`);
  if (WATCH) console.log('[watch] 改 src/**/*.ts 或 demo/ 下的文件，保存后浏览器自动刷新');
});
