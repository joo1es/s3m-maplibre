/**
 * `S3MTileset` 的公共 API 表面快照 —— 拆分重构的安全网。
 *
 * 背景：`S3MTileset` 要从 1946 行的单体拆成 `tileset/*` 子模块（见 issue #27），
 * 而它的 13 个导出被 `index.ts`、`DatasetManager`、`S3MViewer` 和既有单测直接引用，
 * 公共面一旦被改动，使用方的编译错误会在几百行之外炸开，靠人眼 review diff 抓不住。
 *
 * 这里钉三件事：
 *   1. `prototype` 上的公共方法（含 getter/setter）；
 *   2. 实例上的公共字段；
 *   3. 那些**下划线但被既有单测直接调用**的成员。
 *
 * 第 3 条是白名单而不是全量快照：私有方法本来就该在拆分中搬家，
 * 全量快照会逼着每个私有成员都留在主类上，反而把 facade 撑大。
 *
 * 拆分过程中如果这个测试红了，说明公共面真的变了 —— 不要改快照，改代码。
 */
import { describe, expect, test } from 'bun:test';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

/** 拆分前（0.4.29）的公共方法表，顺序无关 */
const PUBLIC_METHODS = [
  'dispose', 'getExternalAtlas', 'getLeafRecords', 'getLodTransition', 'heightRange', 'init',
  'putExternalAtlas', 'putLeafRecords', 'registerTileTextures', 'residentMemory', 'retryFailed',
  'setLodTransition', 'setMaterialQuality', 'setMaxMemory', 'setMaxTriangles', 'setRenderProfile',
  'shouldBakeMercator', 'update',
].sort();

/** 公共实例字段（构造后即可读的那些） */
const PUBLIC_FIELDS = [
  'anchor', 'atlasLod', 'atlasLodCache', 'atlasUpgradeSkipped', 'atlasUpgraded', 'authenticate',
  'config', 'configUrl', 'externalAtlasCache', 'failed', 'fallbackNodes', 'fallbackOffset', 'hardCap',
  'isS3MV1', 'leafRequestCache', 'lodRangeScale', 'lodTransition', 'maxConcurrent', 'maxImageCache',
  'maxMemory', 'maxTiles', 'maxTriangles', 'nodes', 'pending', 'primaryNodes', 'rootRadius',
  'rootUrls', 'stats', 'textureCache',
].sort();

/**
 * 下划线成员的白名单：既有单测直接摸的那些。
 * 拆分时它们可以搬到子模块，但主类必须留一个同名转发（值或方法），否则测试立刻炸。
 */
const INTERNAL_USED = [
  '_enqueue', '_evictOne', '_evictTileNode', '_fillExternalAtlases',
  '_load', '_pickVictim', '_residentTriangles', '_trimBudget',
];

function makeTileset(): S3MTileset {
  // 构造期不发请求，只做 options 归一，所以给个假 URL 就够
  return new S3MTileset({ configUrl: 'http://example.com/datas/cfg.scp' });
}

describe('S3MTileset 公共 API 表面', () => {
  test('公共方法表与拆分前一致', () => {
    const actual = Object.getOwnPropertyNames(S3MTileset.prototype)
      .filter((n) => n !== 'constructor' && !n.startsWith('_'))
      .sort();
    expect(actual).toEqual(PUBLIC_METHODS);
  });

  test('公共实例字段与拆分前一致', () => {
    const actual = Object.getOwnPropertyNames(makeTileset())
      .filter((n) => !n.startsWith('_'))
      .sort();
    expect(actual).toEqual(PUBLIC_FIELDS);
  });

  test('被单测依赖的内部成员仍然可达', () => {
    const ts = makeTileset();
    const protoNames = new Set(Object.getOwnPropertyNames(S3MTileset.prototype));
    const missing = INTERNAL_USED.filter((name) => !protoNames.has(name) && !(name in ts));
    expect(missing).toEqual([]);
  });
});
