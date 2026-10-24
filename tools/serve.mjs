/**
 * 极简静态服务器：node tools/serve.mjs [port]
 * 从工作区根目录提供服务，这样 demo 能同时访问 demo/data 下的样例数据，
 * 也顺便复现 GitHub Pages 的子路径布置：
 *   http://localhost:8123/s3m-maplibre/demo/index.html
 *   http://localhost:8123/s3m-maplibre/docs/index.html
 *
 * 只服务构建产物、不做监听；日常开发用 npm run dev（vite dev + tsc -w）。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
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

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

    let file = normalize(join(ROOT, url));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = join(file, 'index.html');

    const data = await readFile(file);
    const ext = extname(file).toLowerCase();

    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`demo → http://localhost:${PORT}/s3m-maplibre/demo/index.html`);
  console.log(`docs → http://localhost:${PORT}/s3m-maplibre/docs/index.html`);
});
