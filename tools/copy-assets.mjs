/**
 * 把 tsc 不会处理的非 TS 资源拷进对应包的 dist。
 * 目前只有 packages/s3m-three/src/vendor 下的 meshoptimizer / crunch 解码器
 * （原样引入的第三方 .js）。
 *
 *   node tools/copy-assets.mjs [packageName]
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const pkg = process.argv[2] ?? 's3m-three';
const FROM = join(ROOT, 'packages', pkg, 'src', 'vendor');
const TO = join(ROOT, 'packages', pkg, 'dist', 'vendor');

const entries = await readdir(FROM).catch(() => []);
const jsFiles = entries.filter((f) => f.endsWith('.js'));

if (!jsFiles.length) {
  console.log(`[copy-assets] ${pkg}/src/vendor 下没有 .js，跳过`);
  process.exit(0);
}

await mkdir(TO, { recursive: true });
for (const f of jsFiles) {
  await cp(join(FROM, f), join(TO, f));
  console.log(`[copy-assets] ${pkg} vendor/${f}`);
}

// 顺手确认 dist 目录结构没被 tsc 之外的东西破坏
await mkdir(dirname(TO), { recursive: true });
