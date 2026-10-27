/**
 * 双包版本管理：把 `s3m-three` / `s3m-maplibre` 的 x.y.z 按规则一起改。
 *
 * 规则（详见 tools/release-plan.mjs 与 AGENTS.md#版本）：
 *   x、y 两个包共享；只有 z（patch）各自独立。
 *
 * 用法：
 *   node tools/release.mjs                 # 体检：当前版本、是否同步、tag 是否被占用
 *   node tools/release.mjs --check         # 只校验同步关系，不一致时退出码 1（CI 用）
 *   node tools/release.mjs --align         # 收拢 minor 漂移（0.3.14/0.4.14 → 0.4.14/0.4.14）
 *   node tools/release.mjs patch           # 两包各 +1
 *   node tools/release.mjs patch --only maplibre
 *   node tools/release.mjs minor|major     # x/y 共享位，两包必须一起进
 *
 * 选项：
 *   --dry-run   只打印结果，不写文件
 *   --no-lock   不跑 bun install（bun.lock 里的 workspace 版本会不同步，通常别用）
 *   --commit    改完顺手提交一个 `chore: release ...`，**不会 push**
 *   --force     体检发现问题也继续（tag 已被占用仍然拒绝）
 *
 * 这个脚本只改版本、不发布。发布是 push tag 触发 .github/workflows/publish.yml —— 
 * 而那条流水线**不跑测试**，所以打 tag 前自己先 `bun test ./tests/unit`。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { alignVersions, bumpVersions, tagNames, validateSync } from './release-plan.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PKGS = [
  { key: 'three', dir: 'packages/s3m-three', name: 's3m-three' },
  { key: 'maplibre', dir: 'packages/s3m-maplibre', name: 's3m-maplibre' },
];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const words = argv.filter((a) => !a.startsWith('--'));
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function die(msg) {
  console.error(C.red(`✖ ${msg}`));
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

/** 读两个包当前的版本 */
function readVersions() {
  const out = {};
  for (const p of PKGS) {
    const file = `${ROOT}${p.dir}/package.json`;
    out[p.key] = JSON.parse(readFileSync(file, 'utf8')).version;
  }
  return out;
}

/** 只改 package.json 里第一处 "version"，保留原有缩进与结尾换行 */
function writeVersion(pkg, version) {
  const file = `${ROOT}${pkg.dir}/package.json`;
  const raw = readFileSync(file, 'utf8');
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === raw) die(`${pkg.dir}/package.json 里没找到 version 字段`);
  writeFileSync(file, next);
}

function gitAvailable() {
  try {
    sh('git', ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

function showStatus(versions) {
  console.log(C.bold('\n当前版本'));
  for (const p of PKGS) {
    console.log(`  ${p.name.padEnd(14)} ${versions[p.key]}`);
  }

  const sync = validateSync(versions);
  if (sync.ok) {
    console.log(C.green('  ✓ x/y 已同步'));
  } else {
    console.log(C.yellow('  ✗ 未同步'));
    for (const p of sync.problems) console.log(C.yellow(`    · ${p}`));
  }

  if (gitAvailable()) {
    // 按创建时间排，不要用默认的字典序（0.3.9 会排在 0.3.14 后面）
    const tags = sh('git', ['tag', '--sort=-creatordate', '--list'])
      .split('\n')
      .filter(Boolean)
      .filter((t) => t.startsWith('s3m-three@') || t.startsWith('s3m-maplibre@'));
    console.log(C.dim(`  已有 tag ${tags.length} 个，最近：${tags.slice(0, 2).join(' , ') || '（无）'}`));
    const dirty = sh('git', ['status', '--porcelain']).split('\n').filter(Boolean).length;
    if (dirty > 0) {
      console.log(C.yellow(`  工作区有 ${dirty} 处未提交改动 —— release commit 会把它们一起带走`));
    }
  }

  return sync;
}

/** 目标版本是否已有 tag（有就不能再用，发布流水线也会因版本对不上而拒绝） */
function assertTagsFree(versions) {
  if (!gitAvailable()) return;
  const existing = new Set(sh('git', ['tag', '--list']).split('\n').filter(Boolean));
  for (const tag of tagNames(versions)) {
    if (existing.has(tag)) die(`tag ${tag} 已存在 —— 换一个版本号，或先删除旧 tag`);
  }
}

function apply(next, { dryRun }) {
  const cur = readVersions();
  for (const p of PKGS) {
    if (cur[p.key] === next[p.key]) continue;
    console.log(`  ${p.name.padEnd(14)} ${cur[p.key]} → ${C.green(next[p.key])}${dryRun ? C.dim('（dry-run）') : ''}`);
    if (!dryRun) writeVersion(p, next[p.key]);
  }
}

function syncLockfile() {
  if (flags.has('--no-lock')) {
    console.log(C.yellow('  跳过 bun install：bun.lock 里的 workspace 版本会不同步'));
    return;
  }
  console.log(C.dim('  bun install（同步 bun.lock 里的 workspace 版本）…'));
  try {
    // 本机 shell 可能注入 NODE_OPTIONS=--use-system-ca，会让 bun 静默失败
    sh('bun', ['install'], { stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' } });
  } catch (err) {
    die(`bun install 失败：${err?.stderr || err?.message || err}`);
  }
}

function nextSteps(next) {
  const [tagThree, tagMaplibre] = tagNames(next);
  const proxy =
    `"/c/Program Files/Git/cmd/git.exe" ` +
    `-c 'credential.helper=!"C:/Program Files/Git/mingw64/bin/git-credential-manager.exe"' ` +
    `-c http.proxy=http://127.0.0.1:10809 -c https.proxy=http://127.0.0.1:10809 push origin`;

  console.log(C.bold('\n接下来'));
  console.log(`  1. NODE_OPTIONS= bun run build      ${C.dim('重建 demo/ 与 docs/，产物要一起提交')}`);
  console.log(`  2. NODE_OPTIONS= bun run typecheck && NODE_OPTIONS= bun test ./tests/unit`);
  console.log(`     ${C.yellow('publish.yml 只跑 build + typecheck，不跑测试 —— 这一步不能省')}`);
  console.log(`  3. git add -A && git commit -m "chore: release ${next.three} / ${next.maplibre}"`);
  console.log(`  4. git tag ${tagThree} && git tag ${tagMaplibre}`);
  console.log(`  5. 先推内核，再推图层（publish.yml 会校验依赖已在 npm 上）：`);
  console.log(C.dim(`     ${proxy} main`));
  console.log(C.dim(`     ${proxy} ${tagThree}`));
  console.log(C.dim(`     ${proxy} ${tagMaplibre}`));
}

// ---------------------------------------------------------------- main

const versions = readVersions();

if (flags.has('--check')) {
  const sync = validateSync(versions);
  if (!sync.ok) {
    console.error(C.red(`✖ 两个包的 x/y 不同步：three ${versions.three} / maplibre ${versions.maplibre}`));
    for (const p of sync.problems) console.error(`  · ${p}`);
    process.exit(1);
  }
  console.log(C.green(`✓ 版本同步：three ${versions.three} / maplibre ${versions.maplibre}`));
  process.exit(0);
}

if (words.length === 0 && !flags.has('--align')) {
  showStatus(versions);
  if (process.env.CI) process.exit(validateSync(versions).ok ? 0 : 1);
  console.log(C.dim('\n用 --align / patch / minor / major 改版本；--check 只校验同步关系。'));
  process.exit(0);
}

const dryRun = flags.has('--dry-run');
const kind = words[0];

if (kind && !['patch', 'minor', 'major'].includes(kind)) {
  die(`不认识的参数：${kind}（只能是 patch / minor / major / --align / --check）`);
}

// 历史漂移先收拢：allowed 的组合是「--align 单独用」或「--align + 一个递增」。
// 合在一起是常态 —— 0.3.14 / 0.4.14 想直接到 0.4.15 / 0.4.15，不该分成两次命令。
const aligned = alignVersions(versions);
const needsAlign = aligned.three !== versions.three || aligned.maplibre !== versions.maplibre;

let next = versions;
if (needsAlign && (flags.has('--align') || kind)) {
  console.log(C.bold('\n对齐 minor（x/y 收拢到较大的一侧，z 各自保留）'));
  for (const p of PKGS) {
    if (aligned[p.key] !== versions[p.key]) {
      console.log(`  ${p.name.padEnd(14)} ${versions[p.key]} → ${aligned[p.key]}`);
    }
  }
  next = aligned;
} else if (flags.has('--align') && !needsAlign) {
  console.log(C.green('✓ x/y 本来就同步，无需 align'));
  process.exit(0);
}

if (kind) {
  console.log(C.bold(`\n${kind} 递增${only ? `（只动 ${only}）` : ''}`));
  try {
    next = bumpVersions(next, kind, only);
  } catch (err) {
    die(err.message);
  }
}

apply(next, { dryRun });

if (!dryRun) {
  assertTagsFree(next);
  syncLockfile();
}

if (!dryRun) {
  const text = `chore: release ${next.three} / ${next.maplibre}`;
  if (flags.has('--commit')) {
    sh('git', ['add', '-A']);
    sh('git', ['commit', '-q', '-m', text]);
    console.log(C.green(`\n✓ 已提交：${text}`));
  } else {
    console.log(C.dim(`\n建议提交信息：${text}`));
  }
}

nextSteps(next);
