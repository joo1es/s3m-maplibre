/**
 * round-14：S3MBLOCK TextureSharing **leaf 模式**（多精灵组合图集）的单元测试。
 *
 * 覆盖四层契约（每层都出过或将要出事故）：
 *
 * 1. `parseTexblockSegments` —— 三种外层格式（动态 pack / 静态 pack / 容器）。
 *    事故原型：把动态 pack 当容器读，`count` 是段数而 nameLen 是上一段长度 → 噪声；
 *    以及旧实现只读容器第一条记录 → `Tile_6_000000` 这类多记录文件丢 15/16 精灵。
 * 2. `expandTexblockRequestNames` —— 官方 `_subRequestNames` 的展开规则。
 *    事故原型：把 `Tex_0.texblock#000…` 整串当文件名请求（带 # 的 URL → 拿到别的文件）。
 * 3. `composeLeafAtlas` —— 行序。DXT 解码缓冲底朝上，画布必须自上而下
 *    （canvas 行 0 = 源图顶行 = 解码缓冲末行）。翻转这一行 → 所有贴图上下颠倒。
 * 4. `_fillExternalAtlases` 集成 —— leaf 请求计划（pack 合并 extratiles、段序=请求序）
 *    + 组合画布 + 纹理表/rect 重建，端到端像素断言。
 */
import { describe, expect, test } from 'bun:test';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  composeLeafAtlas,
  expandTexblockRequestNames,
  parseTexblockSegments,
  rebuildBlockTextureState,
} from '../../packages/s3m-three/src/core/S3MBlockParser';
import type { LeafSprite, S3MBlockAtlasImage } from '../../packages/s3m-three/src/core/S3MBlockParser';
import { decodeAtlasImage, packAtlases } from '../../packages/s3m-three/src/core/AtlasPack';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

const zlibInflate = (b: Uint8Array): Uint8Array => new Uint8Array(inflateSync(b));

/* ------------------------------------------------------------------ 字节流构造 */

/** 一条裸图像记录：`ct|w|h|pf|size|data`（data = 像素块，不含头） */
function recBytes(ct: number, w: number, h: number, pf: number, payload: Uint8Array): Buffer {
  const head = Buffer.alloc(20);
  head.writeUInt32LE(ct, 0);
  head.writeUInt32LE(w, 4);
  head.writeUInt32LE(h, 8);
  head.writeUInt32LE(pf, 12);
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, Buffer.from(payload)]);
}

/** 一条容器条目：`nameLen|name|unzip|zip|zlib(record)` */
function entryBytes(name: string, record: Buffer): Buffer {
  const zip = deflateSync(record);
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(4 + nameBuf.length + 4 + 4);
  let p = 0;
  head.writeUInt32LE(nameBuf.length, p); p += 4;
  nameBuf.copy(head, p); p += nameBuf.length;
  head.writeUInt32LE(record.length, p); p += 4;
  head.writeUInt32LE(zip.length, p);
  return Buffer.concat([head, zip]);
}

/** 普通容器：`count|条目×count` */
function containerBytes(entries: Buffer[]): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(entries.length, 0);
  return Buffer.concat([head, ...entries]);
}

/** 动态 pack（kMi）：`count|zippedLength[count]|段[count]`，段 = 容器 */
function dynPackBytes(segments: Buffer[]): Buffer {
  const head = Buffer.alloc(4 + 4 * segments.length);
  head.writeUInt32LE(segments.length, 0);
  segments.forEach((s, i) => head.writeUInt32LE(s.length, 4 + i * 4));
  return Buffer.concat([head, ...segments]);
}

/** 静态 pack：`count|(offset,length)[count]|段`，段 = 单条裸条目（无 count 头） */
function staticPackBytes(segments: Buffer[]): Buffer {
  const tableEnd = 4 + 8 * segments.length;
  const head = Buffer.alloc(tableEnd);
  head.writeUInt32LE(segments.length, 0);
  let off = tableEnd;
  segments.forEach((s, i) => {
    head.writeUInt32LE(off, 4 + i * 8);
    head.writeUInt32LE(s.length, 8 + i * 8);
    off += s.length;
  });
  return Buffer.concat([head, ...segments]);
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** RGBA 记录对象（ct=0/pf=28，exact-size passthrough → topDown） */
function rgbaSprite(id: string, w: number, h: number, rows: Array<[number, number, number, number]>): S3MBlockAtlasImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const c = rows[Math.min(y, rows.length - 1)]!;
    for (let x = 0; x < w; x++) data.set(c, (y * w + x) * 4);
  }
  return { id, width: w, height: h, compressType: 0, pixelFormat: 28, data };
}

/**
 * 一个 4×4 DXT5 块：alpha 全 255；调色板 c0=红 c1=蓝；颜色索引按行 0,0,1,1。
 * 块内像素行 = 源图自上而下行序，故源图 = [红, 红, 蓝, 蓝]；
 * DXT 解码缓冲与之上下颠倒（[蓝, 蓝, 红, 红]）—— compose/pack 必须倒序贴回。
 * （只用纯 c0/c1，不碰 1/3 插值的取整差异。）
 */
const DXT5_RED_BLUE = new Uint8Array([
  255, 255, 0, 0, 0, 0, 0, 0, // alpha: a0=a1=255 → 全不透明
  0x00, 0xf8, 0x1f, 0x00, // color: c0=红(0xF800) c1=蓝(0x001F)
  0x00, 0x00, 0x55, 0x55, // 索引：行0,1 → 0(红)，行2,3 → 1(蓝)
]);

function dxtSprite(id: string, data: Uint8Array = DXT5_RED_BLUE): S3MBlockAtlasImage {
  return { id, width: 4, height: 4, compressType: 14, pixelFormat: 13, data };
}

/** 读画布某像素 RGBA */
function px(data: Uint8Array, W: number, x: number, y: number): [number, number, number, number] {
  const i = (y * W + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

const realFetch = globalThis.fetch;

/* ------------------------------------------------------------------ 1. 三格式解析 */

describe('parseTexblockSegments：三种外层格式', () => {
  test('容器（多条目全部返回，不能只读第一条）', async () => {
    const bytes = containerBytes([
      entryBytes('117_0.texblock', recBytes(14, 4, 4, 13, DXT5_RED_BLUE)),
      entryBytes('381_0.texblock', recBytes(14, 4, 4, 13, DXT5_RED_BLUE)),
    ]);
    const segs = await parseTexblockSegments(toArrayBuffer(bytes), { inflate: zlibInflate });
    // 容器 = 1 段、2 条记录 —— 旧实现只拿第一条
    expect(segs).toHaveLength(1);
    expect(segs[0]!.map((r) => r.id)).toEqual(['117_0.texblock', '381_0.texblock']);
    expect(segs[0]![1]!.data.length).toBe(16);
  });

  test('动态 pack：段序 = 请求序，每段独立容器', async () => {
    const bytes = dynPackBytes([
      containerBytes([entryBytes('s1', recBytes(14, 4, 4, 13, DXT5_RED_BLUE))]),
      containerBytes([entryBytes('s2', recBytes(14, 4, 4, 13, DXT5_RED_BLUE))]),
      containerBytes([entryBytes('s3a', recBytes(14, 4, 4, 13, DXT5_RED_BLUE)), entryBytes('s3b', recBytes(14, 4, 4, 13, DXT5_RED_BLUE))]),
    ]);
    const segs = await parseTexblockSegments(toArrayBuffer(bytes), { inflate: zlibInflate });
    expect(segs.length).toBe(3);
    expect(segs[0]![0]!.id).toBe('s1'); // kMi(i) 取第 i 段
    expect(segs[1]![0]!.id).toBe('s2');
    expect(segs[2]!.map((r) => r.id)).toEqual(['s3a', 's3b']);
  });

  test('静态 pack：段 = 单条裸条目（没有段头 count）', async () => {
    const bytes = staticPackBytes([
      entryBytes('s1', recBytes(14, 4, 4, 13, DXT5_RED_BLUE)),
      entryBytes('s2', recBytes(14, 4, 4, 13, DXT5_RED_BLUE)),
    ]);
    const segs = await parseTexblockSegments(toArrayBuffer(bytes), { inflate: zlibInflate });
    expect(segs.length).toBe(2);
    expect(segs[0]![0]!.id).toBe('s1');
    expect(segs[1]![0]!.id).toBe('s2');
  });

  test('存储态条目（zip == unzip，无 zlib 包装）必须按原样读（3D-CBD-2 Tex_0_000 实测）', async () => {
    // CBD 的 texblock pack 里，部分条目 payload 未压缩：zip == unzip，
    // 内容直接就是图像记录。无条件 inflate 会把整包判成「无法识别的外层格式」。
    const storedEntry = (name: string, record: Buffer): Buffer => {
      const nameBuf = Buffer.from(name, 'utf8');
      const head = Buffer.alloc(4 + nameBuf.length + 4 + 4);
      let p = 0;
      head.writeUInt32LE(nameBuf.length, p); p += 4;
      nameBuf.copy(head, p); p += nameBuf.length;
      head.writeUInt32LE(record.length, p); p += 4;
      head.writeUInt32LE(record.length, p); // zip == unzip → 存储态
      return Buffer.concat([head, record]);
    };
    const bytes = dynPackBytes([
      containerBytes([entryBytes('14_-1.texblock', recBytes(14, 4, 4, 13, DXT5_RED_BLUE))]),
      containerBytes([storedEntry('15_-1.texblock', recBytes(26, 4, 4, 13, DXT5_RED_BLUE))]),
    ]);
    const segs = await parseTexblockSegments(toArrayBuffer(bytes), { inflate: zlibInflate });
    expect(segs.length).toBe(2);
    expect(segs[0]![0]!.id).toBe('14_-1.texblock');
    expect(segs[1]![0]!.id).toBe('15_-1.texblock');
    expect(segs[1]![0]!.compressType).toBe(26);
    expect(segs[1]![0]!.data.length).toBe(16);
  });

  test('守卫：count≤256 的普通容器不得被误判成动态 pack（算术必须严丝合缝）', async () => {
    // 2 条目的容器 count=2 ≤256：若 dyn 判定贪婪，lens[0] = nameLen 会把名字字节当长度
    const bytes = containerBytes([
      entryBytes('aaaaaaaa', recBytes(14, 4, 4, 13, DXT5_RED_BLUE)), // nameLen=13 ≥ 8，恰好能骗过 len<8 的检查
      entryBytes('bbbbbbbb', recBytes(14, 4, 4, 13, DXT5_RED_BLUE)),
    ]);
    const segs = await parseTexblockSegments(toArrayBuffer(bytes), { inflate: zlibInflate });
    expect(segs).toHaveLength(1); // 仍是容器 1 段
    expect(segs[0]!.map((r) => r.id)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  test('完全不像 texblock 的字节必须抛错，而不是静默给空数组', async () => {
    await expect(
      parseTexblockSegments(toArrayBuffer(Buffer.from('not a texblock at all ...')), { inflate: zlibInflate })
    ).rejects.toThrow(/无法识别/);
  });
});

/* ------------------------------------------------------------------ 2. 请求名展开 */

describe('expandTexblockRequestNames：官方 _subRequestNames 规则', () => {
  // tile2 真实 requestNames（OlympicGreen Building 6_00.s3mblock）
  const rn = [
    'Tex_0.texblock#000009015016020028047054062064072076084088130131',
    'Tile_6_000000.texblock',
    'Tile_6_000000.texblock',
  ];

  test('#码按 3 位切分成 pack 组，普通名取 stem，重复去重', () => {
    const plan = expandTexblockRequestNames(rn);
    expect(plan.packGroups.get('Tex_0')).toEqual([
      'Tex_0_000', 'Tex_0_009', 'Tex_0_015', 'Tex_0_016', 'Tex_0_020', 'Tex_0_028',
      'Tex_0_047', 'Tex_0_054', 'Tex_0_062', 'Tex_0_064', 'Tex_0_072', 'Tex_0_076',
      'Tex_0_084', 'Tex_0_088', 'Tex_0_130', 'Tex_0_131',
    ]);
    expect(plan.plain).toEqual(['Tile_6_000000']); // 重复项只留一个
    expect(plan.names).toHaveLength(17); // 16 pack + 1 plain
  });

  test('Tex_* 没有 # → 不产生子请求（官方行为，直接 continue）', () => {
    const plan = expandTexblockRequestNames(['Tex_5.texblock']);
    expect(plan.packGroups.size).toBe(0);
    expect(plan.plain).toEqual([]);
    expect(plan.names).toEqual([]);
  });

  test('非 Tex 前缀一律按普通文件处理（含带点的完整文件名）', () => {
    const plan = expandTexblockRequestNames(['-704919438.texblock', '911305599.texblock']);
    expect(plan.plain).toEqual(['-704919438', '911305599']);
    expect(plan.packGroups.size).toBe(0);
  });

  test('undefined / 空表 → 空计划（根瓦片只挂 childTexNames 时 0 请求）', () => {
    expect(expandTexblockRequestNames(undefined).names).toEqual([]);
    expect(expandTexblockRequestNames([]).names).toEqual([]);
  });
});

/* ------------------------------------------------------------------ 3. 组合与行序 */

describe('composeLeafAtlas：按 subTexInfos 贴精灵，画布自上而下', () => {
  const atlas = {
    width: 8,
    height: 8,
    subTexInfos: [
      { subName: 's0', offsetX: 0, offsetY: 0, width: 4, height: 2, bindings: [] },
      { subName: 's1', offsetX: 2, offsetY: 4, width: 4, height: 4, bindings: [] },
      { subName: 'gone', offsetX: 0, offsetY: 6, width: 2, height: 2, bindings: [] },
    ],
  };

  test('DXT 精灵行序：canvas 行 0 = 源图顶行（解码缓冲末行）', () => {
    const sprites = new Map<string, LeafSprite>([
      ['s0', { source: 'B', image: rgbaSprite('s0', 4, 2, [[0, 255, 0, 255], [255, 0, 255, 255]]) }],
      ['s1', { source: 'A', image: dxtSprite('s1') }],
    ]);
    const out = composeLeafAtlas(atlas, sprites)!;
    expect(out.width).toBe(8);
    expect(out.height).toBe(8);

    // s0（RGBA topDown 原样透传）：行 0 绿、行 1 品红
    expect(px(out.data, 8, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(px(out.data, 8, 3, 1)).toEqual([255, 0, 255, 255]);

    // s1（DXT，源图 [红,红,蓝,蓝]，解码缓冲上下颠倒）：画布 (2,4) 起 ——
    // 行 4 必须是红（= 源图顶行）、行 7 必须是蓝。若行序逻辑翻转，这两个断言互换 → 测试必挂。
    expect(px(out.data, 8, 2, 4)).toEqual([255, 0, 0, 255]);
    expect(px(out.data, 8, 5, 7)).toEqual([0, 0, 255, 255]);

    // 未贴精灵的 rect 留透明
    expect(px(out.data, 8, 0, 6)).toEqual([0, 0, 0, 0]);

    expect(out.matched).toEqual(['s0', 's1']);
    expect(out.missing).toEqual(['gone']);
    expect(out.mismatched).toEqual([]);
    expect(out.sig).toBe('A#s1,B#s0'); // 排序拼接
  });

  test('精灵尺寸 ≠ rect 尺寸：照样贴（官方行为），只记录 mismatched', () => {
    const wide = {
      ...atlas,
      subTexInfos: [{ subName: 's1', offsetX: 0, offsetY: 0, width: 2, height: 2, bindings: [] }],
    };
    const out = composeLeafAtlas(wide, new Map([['s1', { source: 'A', image: dxtSprite('s1') }]]))!;
    expect(out.mismatched).toEqual(['s1']);
    expect(out.matched).toEqual(['s1']);
    expect(px(out.data, 8, 0, 0)).toEqual([255, 0, 0, 255]); // 仍按精灵尺寸贴上（红=源顶行）
  });

  test('画布扩张：offset + 精灵超出声明尺寸时自动变大', () => {
    const big = {
      width: 4,
      height: 4,
      subTexInfos: [{ subName: 's1', offsetX: 2, offsetY: 2, width: 4, height: 4, bindings: [] }],
    };
    const out = composeLeafAtlas(big, new Map([['s1', { source: 'A', image: dxtSprite('s1') }]]))!;
    expect(out.width).toBe(6);
    expect(out.height).toBe(6);
    expect(px(out.data, 6, 2, 2)).toEqual([255, 0, 0, 255]); // 精灵首行(红)落在偏移处
    expect(px(out.data, 6, 5, 5)).toEqual([0, 0, 255, 255]); // 精灵末行(蓝)落在画布末行
  });

  test('没有任何 subName 命中 → null（调用方退回整图路径）', () => {
    expect(composeLeafAtlas(atlas, new Map([['nope', { source: 'A', image: dxtSprite('nope') }]]))).toBeNull();
    expect(composeLeafAtlas(atlas, new Map())).toBeNull();
  });

  test('解不出来的记录按缺失处理（留透明，不整块拒收）', () => {
    const bad: S3MBlockAtlasImage = { id: 's0', width: 4, height: 2, compressType: 99, pixelFormat: 1, data: new Uint8Array(8) };
    const out = composeLeafAtlas(
      { width: 4, height: 4, subTexInfos: [{ subName: 's0', offsetX: 0, offsetY: 0, width: 4, height: 2, bindings: [] }] },
      new Map([['s0', { source: 'A', image: bad }]])
    );
    expect(out).toBeNull(); // painted=0
  });
});

/* ------------------------------------------------------------------ 4. AtlasPack 行序透传 */

describe('decodeAtlasImage / packAtlases：RGBA 透传与 DXT 倒序共存', () => {
  test('RGBA 精确尺寸原样透传（topDown=true）；DXT 解码（topDown=false）', () => {
    const rgba = rgbaSprite('r', 4, 2, [[1, 2, 3, 4]]);
    const d1 = decodeAtlasImage(rgba)!;
    expect(d1.topDown).toBe(true);
    expect(d1.rgba).toBe(rgba.data); // 零拷贝

    const d2 = decodeAtlasImage(dxtSprite('d'))!;
    expect(d2.topDown).toBe(false);
    expect(d2.rgba.length).toBe(64);
  });

  test('非 DXT 且非已解 RGBA → null（拒绝猜测格式）', () => {
    expect(decodeAtlasImage({ id: 'x', width: 4, height: 4, compressType: 0, pixelFormat: 1, data: new Uint8Array(48) })).toBeNull();
  });

  test('拼图：DXT 行倒序 + RGBA 直拷，两者行 0 都对齐画布顶行', () => {
    // 两张 4×4：D（DXT 解码缓冲 [红,红,蓝,蓝]）与 R（RGBA，行 0 绿 / 行 3 黑）
    const packed = packAtlases({
      D: { width: 4, height: 4, compressType: 14, pixelFormat: 13, data: DXT5_RED_BLUE },
      R: rgbaSprite('R', 4, 4, [[0, 255, 0, 255], [0, 0, 0, 0]]),
    })!;
    expect(packed.width).toBe(8); // 货架：并排一行
    const d = packed.offsets.get('D')!;
    const r = packed.offsets.get('R')!;
    // D：画布行 0 = 源顶行（红）；行 3 = 蓝
    expect(px(packed.data, 8, d.x, d.y + 0)).toEqual([255, 0, 0, 255]);
    expect(px(packed.data, 8, d.x, d.y + 3)).toEqual([0, 0, 255, 255]);
    // R：topDown 直拷，行 0 = 绿
    expect(px(packed.data, 8, r.x, r.y + 0)).toEqual([0, 255, 0, 255]);
    expect(px(packed.data, 8, r.x, r.y + 3)).toEqual([0, 0, 0, 0]);
  });

  test('单张图集不拼（返回 null，避免无谓解码）', () => {
    expect(packAtlases({ D: { width: 4, height: 4, compressType: 14, pixelFormat: 13, data: DXT5_RED_BLUE } })).toBeNull();
  });
});

/* ------------------------------------------------------------------ 5. _fillExternalAtlases 集成 */

describe('_fillExternalAtlases：leaf 请求计划 + 组合 + 重建（mock fetch）', () => {
  /** 8×8 图集、两个 4×4 精灵 rect：s1 在 (0,0)，s2 在 (4,4)；顶点 0-1 用 s1、2-3 用 s2 */
  function makeLeafTile() {
    const sub = (subName: string, x: number, y: number, vo: number) => ({
      subName,
      offsetX: x,
      offsetY: y,
      width: 4,
      height: 4,
      bindings: [{ geoName: 'G', texUnitIndex: 0, vertexOffset: vo, vertexCount: 2 }],
    });
    return {
      geoPackage: { G: { vertexPackage: { verticesCount: 4 } } },
      texturePackage: {
        'A.texblock': {
          id: 'A.texblock',
          level: 0,
          width: 8,
          height: 8,
          compressType: 14,
          pixelFormat: 21,
          data: null, // leaf：像素全在外部
          childTexNames: [],
          requestNames: ['Tex_0.texblock#000009', 'Tile_X.texblock'], // pack 组 2 名 + 普通 1 名
          subTexInfos: [sub('s1', 0, 0, 0), sub('s2', 4, 4, 2)],
        },
      },
      textures: {},
      atlasRects: {},
    } as never;
  }

  const packResp = dynPackBytes([
    containerBytes([entryBytes('s2', recBytes(14, 4, 4, 13, DXT5_RED_BLUE))]), // 注意：seg0 装 s2
    containerBytes([entryBytes('s1', recBytes(14, 4, 4, 13, DXT5_RED_BLUE))]), // seg1 装 s1
  ]);
  const tileResp = containerBytes([entryBytes('zzz', recBytes(14, 4, 4, 13, DXT5_RED_BLUE))]);

  test('pack 走合并 extratiles、普通名单独请求；段序=请求序；画布/纹理表/rect 全部正确', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (u: string) => {
      urls.push(u);
      if (u.includes('extratiles')) return new Response(packResp, { status: 200 });
      if (u.endsWith('Tile_X.texblock')) return new Response(tileResp, { status: 200 });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const tile = makeLeafTile();
      const tileset = new S3MTileset({ configUrl: 'http://localhost/config.json' } as never);
      await (tileset as unknown as { _fillExternalAtlases(t: unknown, u: string): Promise<void> })._fillExternalAtlases(
        tile,
        'http://localhost/dir/6_00.s3mblock'
      );

      // 请求计划：恰好 2 个请求；pack URL 必须是「首名 + 去扩展名 extratiles」
      expect(urls).toEqual([
        'http://localhost/dir/Tex_0_000.texblock?extratiles=Tex_0_000;Tex_0_009',
        'http://localhost/dir/Tile_X.texblock',
      ]);

      // 段序 = extratiles 序（kMi(i) 取第 i 段）
      expect(tileset.leafRequestCache.get('Tex_0_000')!.map((r) => r.id)).toEqual(['s2']);
      expect(tileset.leafRequestCache.get('Tex_0_009')!.map((r) => r.id)).toEqual(['s1']);
      expect(tileset.leafRequestCache.get('Tile_X')!.map((r) => r.id)).toEqual(['zzz']);

      // 组合画布写回 + 状态旗标
      const tp = (tile as never as { texturePackage: Record<string, Record<string, unknown>> }).texturePackage['A.texblock']!;
      expect(tp.data).toBeInstanceOf(Uint8Array);
      expect((tp.data as Uint8Array).length).toBe(8 * 8 * 4);
      expect(tp.composed).toBe(true);
      expect(tp.pixelFormat).toBe(28);
      expect(tp.rectScale).toBe(1);
      expect(tileset.atlasUpgraded.has('A.texblock')).toBe(true);
      expect(tileset.atlasUpgradeSkipped.size).toBe(0);

      // 纹理表（单图集不拼图，但 composed 必须透传 → 关 GPU mip、flipY=false）
      const t = (tile as never as { textures: Record<string, Record<string, unknown>> }).textures['A.texblock']!;
      expect(t.width).toBe(8);
      expect(t.composed).toBe(true);
      expect(t.packed).toBeFalsy();
      expect(t.flipY).toBe(false);

      // 像素端到端：按记录名落位 —— s1 在 (0,0)、s2 在 (4,4)，行 0 = 源顶行（红）
      const data = t.data as Uint8Array;
      expect(px(data, 8, 0, 0)).toEqual([255, 0, 0, 255]); // s1 行 0 = 红（源顶行）
      expect(px(data, 8, 3, 3)).toEqual([0, 0, 255, 255]); // s1 行 3 = 蓝
      expect(px(data, 8, 4, 4)).toEqual([255, 0, 0, 255]); // s2 行 0 = 红
      expect(px(data, 8, 7, 7)).toEqual([0, 0, 255, 255]); // s2 行 3 = 蓝

      // rect：v=0 是画布顶行 → s2 的 uv 从 0.5 起、宽高各 0.5
      const uv = (tile as never as { atlasRects: Record<string, { uv: Float32Array }> }).atlasRects['G']!.uv;
      expect(uv.length).toBe(4 * 4);
      expect(uv[0]).toBeCloseTo(0, 6);
      expect(uv[1]).toBeCloseTo(0, 6);
      expect(uv[8]).toBeCloseTo(0.5, 6); // 顶点 2（s2）
      expect(uv[9]).toBeCloseTo(0.5, 6);
      expect(uv[10]).toBeCloseTo(0.5, 6);
      expect(uv[11]).toBeCloseTo(0.5, 6);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('同名请求跨瓦片只发一次（leafRequestCache 命中后不再请求）', async () => {
    let packCalls = 0;
    let tileCalls = 0;
    globalThis.fetch = (async (u: string) => {
      if (u.includes('extratiles')) {
        packCalls++;
        return new Response(packResp, { status: 200 });
      }
      tileCalls++;
      return new Response(tileResp, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const tileset = new S3MTileset({ configUrl: 'http://localhost/config.json' } as never);
      await (tileset as unknown as { _fillExternalAtlases(t: unknown, u: string): Promise<void> })._fillExternalAtlases(
        makeLeafTile(),
        'http://localhost/dir/6_00.s3mblock'
      );
      await (tileset as unknown as { _fillExternalAtlases(t: unknown, u: string): Promise<void> })._fillExternalAtlases(
        makeLeafTile(),
        'http://localhost/dir/6_01.s3mblock' // 另一块瓦片、同名子请求
      );
      expect(packCalls).toBe(1);
      expect(tileCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('leaf 组合失败时退回整图路径（plain 首条记录 + 无基准门禁）', async () => {
    // 精灵记录名与 subName 完全对不上 → compose 返回 null → 走「整图替换」回退
    globalThis.fetch = (async (u: string) => {
      if (u.includes('extratiles')) {
        return new Response(dynPackBytes([containerBytes([entryBytes('nope1', recBytes(14, 8, 8, 13, new Uint8Array(64)))]), containerBytes([entryBytes('nope2', recBytes(14, 8, 8, 13, new Uint8Array(64)))])]), { status: 200 });
      }
      return new Response(containerBytes([entryBytes('whole', recBytes(14, 8, 8, 13, new Uint8Array(64)))]), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const tile = makeLeafTile();
      const tileset = new S3MTileset({ configUrl: 'http://localhost/config.json' } as never);
      await (tileset as unknown as { _fillExternalAtlases(t: unknown, u: string): Promise<void> })._fillExternalAtlases(
        tile,
        'http://localhost/dir/6_00.s3mblock'
      );
      const tp = (tile as never as { texturePackage: Record<string, Record<string, unknown>> }).texturePackage['A.texblock']!;
      // 8×8 → 8×8 整图替换：长宽比一致 → 门禁放行；rectScale=1；不是组合画布
      expect(tileset.atlasUpgraded.has('A.texblock')).toBe(true);
      expect(tp.composed).toBe(false);
      expect(tp.rectScale).toBe(1);
      expect((tp.data as Uint8Array).length).toBe(64);
      const t = (tile as never as { textures: Record<string, Record<string, unknown>> }).textures['A.texblock']!;
      expect(t.flipY).toBe(true); // DXT 原图（底朝上）→ 解码时翻行
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('全部请求失败：保持无贴图（不抛异常、不清已有状态）', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    try {
      const tile = makeLeafTile();
      const tileset = new S3MTileset({ configUrl: 'http://localhost/config.json' } as never);
      await (tileset as unknown as { _fillExternalAtlases(t: unknown, u: string): Promise<void> })._fillExternalAtlases(
        tile,
        'http://localhost/dir/6_00.s3mblock'
      );
      const t = tile as never as { textures: Record<string, unknown> };
      expect(Object.keys(t.textures)).toHaveLength(0);
      expect(tileset.leafRequestCache.get('Tex_0_000')).toBeNull();
      expect(tileset.atlasUpgradeSkipped.get('A.texblock')).toContain('no usable external image');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/* ------------------------------------------------------------------ 6. unpack 往返 */

describe('unpackBlockTextures：组合画布退回后 flipY 保持 false', () => {
  /** 拼图后的图集（16×16 大图），origin = 拼图前的本体 */
  function mkTile(composed: boolean) {
    return {
      texturePackage: {
        'A.texblock': {
          id: 'A.texblock',
          level: 0,
          width: 16,
          height: 16,
          compressType: 0,
          pixelFormat: 28,
          data: new Uint8Array(16 * 16 * 4),
          composed,
          packed: true,
          packKey: 'k',
          origin: composed
            ? { width: 8, height: 8, compressType: 0, pixelFormat: 28, data: new Uint8Array(8 * 8 * 4) } // 组合画布
            : { width: 8, height: 8, compressType: 14, pixelFormat: 21, data: new Uint8Array(16) }, // DXT 原图
          subTexInfos: [],
        },
      },
    } as never;
  }

  test('composed 画布退回 → flipY=false 且 composed 保留；DXT 原图退回 → flipY=true', async () => {
    const { unpackBlockTextures } = await import('../../packages/s3m-three/src/core/S3MBlockParser');

    // —— leaf 组合画布（自上而下 RGBA）——
    const t1 = mkTile(true);
    expect(unpackBlockTextures(t1 as never)).toBe(true);
    const a1 = (t1 as never as { texturePackage: Record<string, Record<string, unknown>> }).texturePackage['A.texblock']!;
    expect(a1.packed).toBe(false);
    expect((a1.data as Uint8Array).length).toBe(8 * 8 * 4); // 退回 origin（画布尺寸）
    rebuildBlockTextureState(t1 as never);
    const o1 = (t1 as never as { textures: Record<string, Record<string, unknown>> }).textures['A.texblock']!;
    expect(o1.flipY).toBe(false); // composed 保留 → 仍自上而下、关 GPU mip
    expect(o1.composed).toBe(true);

    // —— 原始 DXT 图集（底朝上）——
    const t2 = mkTile(false);
    unpackBlockTextures(t2 as never);
    const a2 = (t2 as never as { texturePackage: Record<string, Record<string, unknown>> }).texturePackage['A.texblock']!;
    expect(a2.flipY).toBe(true);
    expect((a2.data as Uint8Array).length).toBe(16);
    rebuildBlockTextureState(t2 as never);
    const o2 = (t2 as never as { textures: Record<string, Record<string, unknown>> }).textures['A.texblock']!;
    expect(o2.flipY).toBe(true); // 解码时翻行
    expect(o2.composed).toBe(false);
  });
});
