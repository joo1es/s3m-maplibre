/**
 * 一键起这个 showcase：node smart-city/dev.mjs
 *
 * 本机 shell 注入了 NODE_OPTIONS=--use-system-ca，会让 vite 静默失败，
 * 所以这里在子进程里把它清掉，用户不用自己记 NODE_OPTIONS= 前缀。
 * 端口在 vite.config.mjs 里（5174，不抢平时 bun run dev 的 5173）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const env = { ...process.env };
delete env.NODE_OPTIONS;

const child = spawn(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join(HERE, 'vite.config.mjs'),
    '--host', '127.0.0.1',
  ],
  { cwd: ROOT, stdio: 'inherit', env },
);

const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
