/**
 * 双包版本规则的纯函数测试。
 *
 * 规则：`x.y.z` 里 **x 与 y 两个包共享，只有 z（patch）各自独立**。
 *   · three     0.4.15
 *   · maplibre  0.4.15   ← 同一世代；下一轮如果只动图层，就是 0.4.15 / 0.4.16
 *
 * 为什么把 z 独立出去：两个包的改动频率不同（图层侧的 API/交互改动远多于内核），
 * 强制 patch 同号会让内核为了对齐而空发版本。x/y 共享则保证「API 世代」一眼可辨。
 *
 * 当前仓库有一次遗留漂移：three 0.3.14 / maplibre 0.4.14（minor 差 1）。`alignVersions`
 * 负责把 minor 收拢到较大的那个（0.4.14 / 0.4.14），随后一次 patch bump 就是
 * 0.4.15 / 0.4.15 —— three 的这次 minor 升级对使用方是破坏性的，只做一次。
 */
import { expect, test } from 'bun:test';
import {
  alignVersions,
  bumpVersions,
  dependencyRange,
  formatVersion,
  parseVersion,
  tagNames,
  validateSync,
} from '../../tools/release-plan.mjs';

const NOW = { three: '0.3.14', maplibre: '0.4.14' };
const ALIGNED = { three: '0.4.15', maplibre: '0.4.16' };

test('parseVersion 接受标准 semver，拒绝残缺与非法输入', () => {
  expect(parseVersion('0.4.15')).toEqual({ major: 0, minor: 4, patch: 15 });
  expect(parseVersion('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0 });
  for (const bad of ['0.4', 'v0.4.15', '0.4.15-beta', 'x.y.z', '', null, undefined]) {
    expect(parseVersion(bad as never)).toBeNull();
  }
});

test('formatVersion 与 parseVersion 互逆', () => {
  expect(formatVersion({ major: 0, minor: 3, patch: 7 })).toBe('0.3.7');
  expect(formatVersion(parseVersion('12.34.56')!)).toBe('12.34.56');
});

test('validateSync：x/y 相同即通过，z 可以不同', () => {
  expect(validateSync(ALIGNED).ok).toBe(true);
  expect(validateSync({ three: '0.4.15', maplibre: '0.4.15' }).ok).toBe(true);
});

test('validateSync：当前仓库状态（0.3.14 / 0.4.14）判定为不一致', () => {
  const r = validateSync(NOW);
  expect(r.ok).toBe(false);
  const text = r.problems.join('\n');
  expect(text).toContain('0.3.14');
  expect(text).toContain('0.4.14');
  expect(text).toContain('minor');
});

test('validateSync：major 不同也要报出来', () => {
  const r = validateSync({ three: '0.4.15', maplibre: '1.4.15' });
  expect(r.ok).toBe(false);
  expect(r.problems.join('\n')).toContain('major');
});

test('validateSync：任一版本非法都不允许继续', () => {
  expect(validateSync({ three: 'abc', maplibre: '0.4.15' }).ok).toBe(false);
  expect(validateSync({ three: '0.4.15', maplibre: '' }).ok).toBe(false);
});

test('alignVersions：minor 收拢到较大的那个，z 各自保留', () => {
  expect(alignVersions(NOW)).toEqual({ three: '0.4.14', maplibre: '0.4.14' });
  // 已经对齐时原样返回，可以无脑反复执行
  expect(alignVersions(ALIGNED)).toEqual(ALIGNED);
});

test('patch bump：默认两包各自 +1', () => {
  expect(bumpVersions(ALIGNED, 'patch')).toEqual({ three: '0.4.16', maplibre: '0.4.17' });
});

test('patch bump：可以只动一个包（图层侧改动多于内核，这是常态）', () => {
  expect(bumpVersions(ALIGNED, 'patch', 'maplibre')).toEqual({
    three: '0.4.15',
    maplibre: '0.4.17',
  });
  expect(bumpVersions(ALIGNED, 'patch', 'three')).toEqual({
    three: '0.4.16',
    maplibre: '0.4.16',
  });
});

test('minor bump：两包一起进 y+1.0，z 归零（y 是共享的，不允许只动一个）', () => {
  expect(bumpVersions(ALIGNED, 'minor')).toEqual({ three: '0.5.0', maplibre: '0.5.0' });
  expect(() => bumpVersions(ALIGNED, 'minor', 'three')).toThrow();
});

test('major bump：两包一起进 x+1.0.0，同样不允许只动一个', () => {
  expect(bumpVersions(ALIGNED, 'major')).toEqual({ three: '1.0.0', maplibre: '1.0.0' });
  expect(() => bumpVersions(ALIGNED, 'major', 'maplibre')).toThrow();
});

test('bumpVersions：输入本身已漂移时拒绝执行，要求先 align', () => {
  expect(() => bumpVersions(NOW, 'patch')).toThrow();
});

test('bumpVersions：非法 kind / 非法版本号直接抛错', () => {
  expect(() => bumpVersions(ALIGNED, 'huge' as 'patch')).toThrow();
  expect(() => bumpVersions({ three: '0.4', maplibre: '0.4.15' }, 'patch')).toThrow();
});

test('tagNames：两个包各自的版本，顺序是「先内核」', () => {
  expect(tagNames({ three: '0.4.15', maplibre: '0.4.16' })).toEqual([
    's3m-three@0.4.15',
    's3m-maplibre@0.4.16',
  ]);
});

test('dependencyRange：与 prepublishOnly 把 workspace:* 替换出来的写法一致', () => {
  expect(dependencyRange('0.4.15')).toBe('^0.4.15');
  expect(dependencyRange('1.2.3')).toBe('^1.2.3');
});
