/**
 * `_fillExternalAtlases` 的回归测试 —— 这里曾经出过一次「近看白膜、远看马赛克」的事故。
 *
 * 背景：S3MBLOCK 的**子瓦片**图集段只有元信息（`data = null`），像素在同目录的独立
 * `.texblock` 里。补像素之后必须重算「纹理表 + 逐顶点矩形」，两者是一套坐标系：
 *   · 只补像素不重算 → `tile.textures` 里没有这条纹理 → 材质拿不到 map → 整块白膜
 *   · 只补像素不重算 → `atlasRects` 还是按旧尺寸归一化的 → 远处马赛克噪点
 *
 * 所以这里断言的不是「函数被调用了」，而是**补完之后渲染侧真的能拿到东西**。
 */
import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

/**
 * 一个 4×4 的**不透明白色** DXT5 块。
 * 布局：alpha0/alpha1 = 255,255（全不透明） + 6 字节 alpha 索引 0
 *      + color0/color1 = 0xFFFF（白） + 4 字节颜色索引 0
 */
const WHITE_DXT5_BLOCK = [255, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0];

/** 造一个 `.texblock`：容器头 + zlib 内层 + 一条 DXT5 图像记录（内容为不透明白） */
function makeTexblock(name: string, w: number, h: number): ArrayBuffer {
  const blocks = Math.ceil(w / 4) * Math.ceil(h / 4);
  const size = blocks * 16; // DXT5 = 1 字节/像素
  const rec = Buffer.alloc(20 + size);
  rec.writeUInt32LE(14, 0); // compressType = DXT5
  rec.writeUInt32LE(w, 4);
  rec.writeUInt32LE(h, 8);
  rec.writeUInt32LE(13, 12); // pixelFormat（标签是 ABGR，实际按 ct 走 DXT5）
  rec.writeUInt32LE(size, 16);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) rec[20 + b * 16 + i] = WHITE_DXT5_BLOCK[i]!;
  }

  const zip = deflateSync(rec);
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(4 + 4 + nameBuf.length + 4 + 4);
  let p = 0;
  head.writeUInt32LE(1, p); p += 4; // count
  head.writeUInt32LE(nameBuf.length, p); p += 4;
  nameBuf.copy(head, p); p += nameBuf.length;
  head.writeUInt32LE(rec.length, p); p += 4; // unzipSize
  head.writeUInt32LE(zip.length, p); // zipSize
  const out = Buffer.concat([head, zip]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/** 造一块最小可用的块瓦片；`withData=false` 模拟子瓦片（像素在外部文件里） */
function makeTile(withData: boolean) {
  const atlas = {
    id: 'A.texblock',
    level: 0,
    width: 4,
    height: 4,
    compressType: 14,
    pixelFormat: 21,
    data: withData ? new Uint8Array(WHITE_DXT5_BLOCK) : null,
    // 有内嵌缩略图 → 候选走 childTexNames（要验证）；没有 → 走 requestNames（无条件采用）
    childTexNames: withData ? ['A.texblock'] : [],
    requestNames: withData ? [] : ['A.texblock'],
    subTexInfos: [
      {
        subName: 's.texblock',
        offsetX: 0,
        offsetY: 0,
        width: 4,
        height: 4,
        bindings: [{ geoName: 'G', texUnitIndex: 0, vertexOffset: 0, vertexCount: 4 }],
      },
    ],
  };
  return {
    geoPackage: { G: { vertexPackage: { verticesCount: 4 } } },
    texturePackage: { 'A.texblock': atlas },
    textures: {},
    atlasRects: {},
  } as never;
}

function newTileset(): S3MTileset {
  return new S3MTileset({ configUrl: 'http://localhost/config.json' } as never);
}

const realFetch = globalThis.fetch;

describe('子瓦片外部图集补齐（data = null + requestNames）', () => {
  test('补完像素后必须建出纹理表与逐顶点矩形', async () => {
    globalThis.fetch = (async () =>
      new Response(makeTexblock('A.texblock', 4, 4), { status: 200 })) as unknown as typeof fetch;
    try {
      const tile = makeTile(false);
      const tileset = newTileset();
      // 解析阶段：没有像素 → 纹理表为空（这正是「白膜」的起点）
      expect(Object.keys((tile as { textures: object }).textures)).toHaveLength(0);

      await (tileset as unknown as { _fillExternalAtlases(t: unknown, u: string): Promise<void> })._fillExternalAtlases(
        tile,
        'http://localhost/6_00.s3mblock'
      );

      const t = tile as unknown as {
        textures: Record<string, { width: number; height: number; data: Uint8Array }>;
        atlasRects: Record<string, { uv?: Float32Array }>;
      };
      // ★ 白膜的根因：这里为空就等于材质拿不到 map
      expect(Object.keys(t.textures)).toEqual(['A.texblock']);
      expect(t.textures['A.texblock']!.width).toBe(4);
      expect(t.textures['A.texblock']!.data.length).toBeGreaterThan(0);

      // ★ 马赛克的根因：rect 必须跟着重算出来
      const uv = t.atlasRects['G']?.uv;
      expect(uv).toBeDefined();
      expect(uv!.length).toBe(4 * 4);
      expect(uv![2]).toBeCloseTo(1, 6); // 全覆盖 → 归一化 w=1
      expect(uv![3]).toBeCloseTo(1, 6);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('请求失败时不能把已有的纹理表清空（保持无贴图，由上层照常渲染几何）', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    try {
      const tile = makeTile(false);
      const tileset = newTileset();
      await (tileset as unknown as { _fillExternalAtlases(t: unknown, u: string): Promise<void> })._fillExternalAtlases(
        tile,
        'http://localhost/6_00.s3mblock'
      );
      const t = tile as unknown as { textures: Record<string, unknown> };
      expect(Object.keys(t.textures)).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('整数倍高清图被采用后：纹理表与 texturePackage 同源，归一化 rect 不变', async () => {
    const { rebuildBlockTextureState } = await import('../../packages/s3m-three/src/core/S3MBlockParser');
    globalThis.fetch = (async () =>
      new Response(makeTexblock('A.texblock', 8, 8), { status: 200 })) as unknown as typeof fetch;
    try {
      const tile = makeTile(true); // 有内嵌缩略图 → 走「验证后才换」的分支
      // 模拟解析阶段：纹理表与 rect 已经建好
      rebuildBlockTextureState(tile as never);
      const before = Array.from((tile as never as { atlasRects: Record<string, { uv: Float32Array }> }).atlasRects['G']!.uv);
      const tileset = newTileset();
      await (tileset as unknown as { _fillExternalAtlases(t: unknown, u: string): Promise<void> })._fillExternalAtlases(
        tile,
        'http://localhost/6.s3mblock'
      );
      const t = tile as unknown as {
        texturePackage: Record<string, { data: Uint8Array; width: number }>;
        textures: Record<string, { data: Uint8Array; width: number }>;
        atlasRects: Record<string, { uv: Float32Array }>;
      };
      // 4×4 → 8×8 的不透明白，门禁应当通过
      expect(tileset.atlasUpgraded.has('A.texblock')).toBe(true);
      expect(t.textures['A.texblock']!.data).toBe(t.texturePackage['A.texblock']!.data);
      expect(t.textures['A.texblock']!.width).toBe(8);
      // rect 是归一化的：换整数倍图后必须一模一样（rectScale 的作用）
      expect(Array.from(t.atlasRects['G']!.uv)).toEqual(before);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
