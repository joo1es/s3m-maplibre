/**
 * 双包版本规则的纯函数，给 tools/release.mjs 与 tests/unit/release-version.test.ts 共用。
 *
 * 规则：`x.y.z` 里 **x 与 y 两个包共享，只有 z 各自独立**。
 *   同一世代 →  three 0.4.15 / maplibre 0.4.16（图层发了个补丁，内核没动）
 *   世代升级 →  three 0.5.0  / maplibre 0.5.0 （两包必须一起，不允许只动一个）
 *
 * z 为什么独立：图层侧的改动频率远高于内核，强制同号会逼内核空发版本。
 * x/y 为什么必须共享：它们表达的是「API 世代」，使用方要能一眼看出两个包配不配。
 *
 * 注意一个连带约束（不在这里强制）：发布时 maplibre 的依赖会写成 `^0.4.N`，
 * caret 在 0.x 上锁 minor —— 所以**改 three 的 minor 必须同时发 maplibre**，
 * 否则使用方会拿到装不上的组合。minor 必须两包一起动，正是为此。
 */

/** @typedef {{ major: number, minor: number, patch: number }} Version */
/** @typedef {{ three: string, maplibre: string }} VersionPair */
/** @typedef {'both' | 'three' | 'maplibre'} Target */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {unknown} value
 * @returns {Version | null} 解析失败返回 null（不抛错，由调用方决定如何处理）
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = SEMVER.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * @param {Version} v
 * @returns {string}
 */
export function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * 解析两个包的版本；任一非法就抛错。
 *
 * @param {VersionPair} versions
 * @returns {{ three: Version, maplibre: Version }}
 */
function parsePair(versions) {
  const three = parseVersion(versions.three);
  const maplibre = parseVersion(versions.maplibre);
  if (!three) throw new Error(`s3m-three 的版本号无法解析：${String(versions.three)}`);
  if (!maplibre) throw new Error(`s3m-maplibre 的版本号无法解析：${String(versions.maplibre)}`);
  return { three, maplibre };
}

/**
 * 校验「x/y 相同，z 自由」。
 *
 * @param {VersionPair} versions
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateSync(versions) {
  const problems = [];
  const three = parseVersion(versions?.three);
  const maplibre = parseVersion(versions?.maplibre);

  if (!three) problems.push(`s3m-three 的版本号无法解析：${String(versions?.three)}`);
  if (!maplibre) problems.push(`s3m-maplibre 的版本号无法解析：${String(versions?.maplibre)}`);
  if (!three || !maplibre) return { ok: false, problems };

  if (three.major !== maplibre.major) {
    problems.push(
      `major 必须相同：three ${formatVersion(three)} / maplibre ${formatVersion(maplibre)}`
    );
  }
  if (three.minor !== maplibre.minor) {
    problems.push(
      `minor 必须相同：three ${formatVersion(three)} / maplibre ${formatVersion(maplibre)}` +
        `（只有 patch 可以各自独立；不一致时先跑 release.mjs --align）`
    );
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 把两个包的 x/y 收拢到较大的那一侧，z 各自保留。幂等。
 *
 * 用于清理历史漂移：0.3.14 / 0.4.14 → 0.4.14 / 0.4.14。
 *
 * @param {VersionPair} versions
 * @returns {VersionPair}
 */
export function alignVersions(versions) {
  const { three, maplibre } = parsePair(versions);
  const major = Math.max(three.major, maplibre.major);
  const minor = Math.max(three.minor, maplibre.minor);
  return {
    three: formatVersion({ major, minor, patch: three.patch }),
    maplibre: formatVersion({ major, minor, patch: maplibre.patch }),
  };
}

/**
 * 推版本。
 *
 * - `patch`：只动 z。target 默认 'both'（两包各 +1）；可指定单个包 —— 这是常态，
 *   图层侧改动多于内核时内核不该空发版本。
 * - `minor` / `major`：x/y 是共享的，两包必须一起进，指定单个包会直接抛错。
 *
 * 输入必须已经对齐（`validateSync().ok`），否则抛错要求先 align —— 静默把漂移带到
 * 新版本里，正是这套规则要防的事。
 *
 * @param {VersionPair} versions
 * @param {'patch' | 'minor' | 'major'} kind
 * @param {Target} [target='both']
 * @returns {VersionPair}
 */
export function bumpVersions(versions, kind, target = 'both') {
  const { three, maplibre } = parsePair(versions);

  if (kind !== 'patch' && kind !== 'minor' && kind !== 'major') {
    throw new Error(`不支持的递增类型：${String(kind)}（只能是 patch / minor / major）`);
  }
  if (target !== 'both' && target !== 'three' && target !== 'maplibre') {
    throw new Error(`不支持的 target：${String(target)}（只能是 both / three / maplibre）`);
  }
  if (kind !== 'patch' && target !== 'both') {
    throw new Error(`${kind} 是两包共享的位，必须两个包一起进（去掉 --only 或改用 patch）`);
  }

  const sync = validateSync(versions);
  if (!sync.ok) {
    throw new Error(`两个包的 x/y 不一致，先跑 release.mjs --align：\n${sync.problems.join('\n')}`);
  }

  if (kind === 'patch') {
    const next = {
      three: { ...three, patch: three.patch + (target === 'maplibre' ? 0 : 1) },
      maplibre: { ...maplibre, patch: maplibre.patch + (target === 'three' ? 0 : 1) },
    };
    return { three: formatVersion(next.three), maplibre: formatVersion(next.maplibre) };
  }

  if (kind === 'minor') {
    const next = { major: three.major, minor: three.minor + 1, patch: 0 };
    return { three: formatVersion(next), maplibre: formatVersion(next) };
  }

  const next = { major: three.major + 1, minor: 0, patch: 0 };
  return { three: formatVersion(next), maplibre: formatVersion(next) };
}

/**
 * 与 .github/workflows/publish.yml 里 `s3m-three@*` / `s3m-maplibre@*` 的解析一致。
 * 顺序有意义：内核必须先发，否则 maplibre 的依赖校验（npm view）会失败。
 *
 * @param {VersionPair} versions
 * @returns {[string, string]}
 */
export function tagNames(versions) {
  return [`s3m-three@${versions.three}`, `s3m-maplibre@${versions.maplibre}`];
}

/**
 * prepublishOnly 把 `workspace:*` 替换成 `^<three 的版本>`，这里同步一份用于提示。
 *
 * @param {string} version
 * @returns {string}
 */
export function dependencyRange(version) {
  return `^${version}`;
}
