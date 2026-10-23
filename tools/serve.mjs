/**
 * 极简静态服务器：node tools/serve.mjs [port]
 * 从工作区根目录提供服务，这样 demo 能同时访问 s3m-maplibre/ 和 s3m-spec/ 下的样例数据。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.argv[2] ?? 8123);

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
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`demo → http://localhost:${PORT}/s3m-maplibre/demo/index.html`);
});
