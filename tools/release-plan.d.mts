/**
 * tools/release-plan.mjs 的类型声明（.mjs 对应 .d.mts）。
 * 纯类型，无运行时行为 —— 双包版本规则的函数签名与 .mjs 里的 JSDoc 保持一致。
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export interface VersionPair {
  three: string;
  maplibre: string;
}

export type Target = 'both' | 'three' | 'maplibre';

export interface SyncResult {
  ok: boolean;
  problems: string[];
}

/** 解析失败返回 null（不抛错，由调用方决定如何处理） */
export function parseVersion(value: unknown): Version | null;
export function formatVersion(v: Version): string;
/** 校验「x/y 相同，z 自由」 */
export function validateSync(versions: VersionPair): SyncResult;
/** 把两个包的 x/y 收拢到较大的那一侧，z 各自保留。幂等 */
export function alignVersions(versions: VersionPair): VersionPair;
/** 推版本；kind !== 'patch' 时 target 只能是 'both' */
export function bumpVersions(
  versions: VersionPair,
  kind: 'patch' | 'minor' | 'major',
  target?: Target
): VersionPair;
/** 顺序有意义：内核必须先发 */
export function tagNames(versions: VersionPair): [string, string];
/** prepublishOnly 把 `workspace:*` 替换成 `^<version>` */
export function dependencyRange(version: string): string;
