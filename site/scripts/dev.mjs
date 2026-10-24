/**
 * 一条命令起本地开发：编译两个包 → 常驻 tsc -w → 起 vite dev。
 *
 * 一个端口同时提供文档与 demo（dev 中间件里跑的是一次 SSG）：
 *   /                         s3m-maplibre 文档
 *   /three.html               s3m-three 文档
 *   /demo/                    demo（与线上 demo/index.html 同路径）
 *
 * vite 解析 workspace 包走的是包里的 dist/，所以必须先编一次再起服务，
 * 之后由 tsc -w 增量；改 packages 下的 .ts 保存，vite 直接读到新产物。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const PACKAGES = ['s3m-three', 's3m-maplibre'];
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const tscArgs = (pkg) => ['-p', path.join('packages', pkg, 'tsconfig.build.json')];

console.log('[dev] 首次编译 packages…');
for (const pkg of PACKAGES) {
  // s3m-maplibre 的产物要 import 's3m-three'，顺序不能反
  const r = spawnSync(process.execPath, [TSC, ...tscArgs(pkg)], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[dev] ${pkg} 编译失败，先修类型再启动`);
    process.exit(1);
  }
}
// tsc 只认 .ts，src/vendor 下的第三方 .js 由 copy-assets 拷一次
spawnSync(process.execPath, [path.join(ROOT, 'tools', 'copy-assets.mjs'), 's3m-three'], {
  cwd: ROOT,
  stdio: 'inherit',
});

const children = PACKAGES.map((pkg) =>
  spawn(process.execPath, [TSC, ...tscArgs(pkg), '-w', '--preserveWatchOutput'], {
    cwd: ROOT,
    stdio: 'inherit',
  }),
);

children.push(
  spawn(process.execPath, [VITE, '--config', path.join(SITE, 'vite.config.ts')], {
    cwd: ROOT,
    stdio: 'inherit',
  }),
);

// 端口以 vite 打印的为准（5173 被占它会自动往后挑）
console.log('[dev] 页面：/（图层文档）  /three.html（内核文档）  /demo/（示例）');

let closing = false;
const shutdown = (code = 0) => {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
  process.exit(code);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// vite 退出（比如端口被占）就整体收摊，别留一堆 tsc -w 在后台
children.at(-1).on('exit', (code) => shutdown(code ?? 0));
