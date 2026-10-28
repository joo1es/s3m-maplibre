/**
 * 降级上报：解析成功但能力不完整的数据，必须让调用方看得见
 *
 * 背景：3DGS 数据现在按 Points 渲染（不是高斯泼溅），但在改动前这个降级对上层
 * 完全不可见 —— `GaussianSplatting.isGaussianSplatting` 被解析出来以后没有任何人读。
 * 用户拿一个泼溅数据集看到一堆点，会以为是数据质量或 SDK 的问题。
 *
 * 这里的策略跟「静默失败」相反：
 *   1. 解析期打标（`ParsedTile.degradations`），信息不丢；
 *   2. 调度期聚合去重（`stats.degradations`），状态栏 / 日志能查到；
 *   3. 首次遇到时告警一次（同一类只报一次，避免刷屏）；
 *   4. `unsupported: 'throw'` 时直接拒绝，而不是画一堆点让人误判。
 *
 * 默认策略是 'warn'：不传参时行为与旧版一致（旧版不抛错），只是多一条告警。
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { planDegradations } from '../../packages/s3m-three/src/core/degradations';
import type { DegradationKind } from '../../packages/s3m-three/src/core/degradations';

const FIXTURES = join(import.meta.dir, '../fixtures');

function parseFixture(path: string) {
  const b = readFileSync(join(FIXTURES, path));
  return parseS3MB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, {
    inflate: (x) => inflateSync(x),
  });
}

/* ---------------------------------------------------------------- 解析期打标 */

test('泼溅参数完整时不打降级标记：3DGS 已经是正常渲染路径', async () => {
  const tile = await parseFixture('gaussian-splatting/Tile_0019_262145_524289_0000.s3mb');

  // gsScale / gsRotation 都在 → 渲染层能画出真泼溅，没有理由再报警。
  // （历史上这条断言是反的：那时候量化格式没标定，只能按点画，所以要降级上报。）
  expect(tile.degradations).toBeUndefined();
  expect(tile.bytesRead).toBe(tile.bytesTotal);
});

test('非 3DGS 瓦片不带降级标记：不传参时行为与旧版逐字一致', async () => {
  // Draco 点云是 v3.01、也有 extensions，但不是泼溅数据 —— 反例必须干净
  const tile = await parseFixture('draco/pointcloud.s3mb');

  expect(tile.degradations).toBeUndefined();
});

/* ---------------------------------------------------------------- 策略规划 */

test('没有降级项时：三种策略都什么都不做', () => {
  for (const policy of ['warn', 'throw', 'silent'] as const) {
    const plan = planDegradations([], [], policy);
    expect(plan.fresh).toEqual([]);
    expect(plan.error).toBeUndefined();
  }
});

test('首次遇到：记录并告警一次', () => {
  const plan = planDegradations(['gaussian-splatting-points'], [], 'warn');

  expect(plan.fresh).toEqual(['gaussian-splatting-points']);
  expect(plan.known).toEqual(['gaussian-splatting-points']);
  expect(plan.error).toBeUndefined();
  // 告警文案要能自己解释清楚「看到了什么」和「该怎么办」
  expect(plan.messages[0]).toContain('3DGS');
  expect(plan.messages[0]).toContain('点');
});

test('重复遇到同类降级：不重复告警，但 known 不丢', () => {
  const first = planDegradations(['gaussian-splatting-points'], [], 'warn');
  const second = planDegradations(['gaussian-splatting-points'], first.known, 'warn');

  expect(second.fresh).toEqual([]);
  expect(second.messages).toEqual([]);
  expect(second.known).toEqual(['gaussian-splatting-points']);
});

test("'silent' 只记录不告警：状态栏能查到，日志干净", () => {
  const plan = planDegradations(['gaussian-splatting-points'], [], 'silent');

  expect(plan.known).toEqual(['gaussian-splatting-points']);
  expect(plan.messages).toEqual([]);
  expect(plan.error).toBeUndefined();
});

test("'throw' 直接拒绝，并且标 permanent —— 不要在重试里空转", () => {
  const plan = planDegradations(['gaussian-splatting-points'], [], 'throw');

  expect(plan.error).toBeInstanceOf(Error);
  expect((plan.error as Error & { permanent?: boolean }).permanent).toBe(true);
  expect((plan.error as Error).message).toContain('gaussian-splatting-points');
});

/* ---------------------------------------------------------------- 调度期接入 */

/** 最小 ParsedTile：只放 _load 用得到的字段，避免把解析器拖进这个测试 */
function fakeTile(degradations?: DegradationKind[]) {
  return {
    version: 3.01,
    compressedType: 0,
    options: 0,
    groupNode: { pageLods: [] },
    geoPackage: {},
    textures: {},
    materials: null,
    pickInfo: null,
    ...(degradations ? { degradations } : {}),
    bytesRead: 8,
    bytesTotal: 8,
  };
}

/** 让 _load 拿到一块「跑得通」的瓦片：stub fetch + stub 解析，build 用计数器盯住 */
function harness(policy: 'warn' | 'throw' | 'silent', tile: unknown) {
  const built: string[] = [];
  const ts = new S3MTileset({
    configUrl: 'http://example.com/config.json',
    unsupported: policy,
    buildTile: async () => {
      built.push('build');
      return { group: new THREE.Group(), stats: {} };
    },
  }) as any;
  ts._parseClassicTile = async () => ({ tile });

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    headers: { get: () => 'application/octet-stream' },
    arrayBuffer: async () => new ArrayBuffer(8),
  })) as unknown as typeof fetch;

  const restore = () => {
    globalThis.fetch = origFetch;
  };
  return { ts, built, restore };
}

test('调度期 throw：在建几何之前就拒绝，瓦片进 failed 且不重试', async () => {
  const { ts, built, restore } = harness('throw', fakeTile(['gaussian-splatting-points']));
  const url = 'http://example.com/a.s3mb';
  try {
    await ts._load(url);
  } finally {
    restore();
  }

  // 关键：没有白跑一次几何组装（几十万面的解交错 + 合批）
  expect(built).toEqual([]);
  expect(ts.stats.failed).toBe(1);
  expect(ts.failed.has(url)).toBe(true);
  // 降级语义仍要留下痕迹，不然 UI 只看到一个莫名其妙的失败
  expect(ts.stats.degradations).toEqual(['gaussian-splatting-points']);
});

test('调度期 warn：照常出图，只是 stats 里能查到降级', async () => {
  const { ts, built, restore } = harness('warn', fakeTile(['gaussian-splatting-points']));
  const url = 'http://example.com/b.s3mb';
  try {
    await ts._load(url);
  } finally {
    restore();
  }

  expect(built).toEqual(['build']);
  expect(ts.stats.degradations).toEqual(['gaussian-splatting-points']);
  expect(ts.stats.failed).toBe(0);
});

test('调度期：普通瓦片完全不受影响 —— 不传参时行为与旧版一致', async () => {
  const { ts, built, restore } = harness('throw', fakeTile());
  try {
    await ts._load('http://example.com/c.s3mb');
  } finally {
    restore();
  }

  expect(built).toEqual(['build']);
  expect(ts.stats.degradations).toEqual([]);
  expect(ts.stats.failed).toBe(0);
});
