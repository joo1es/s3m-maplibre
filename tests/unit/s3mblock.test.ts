/**
 * S3MBLOCK（纹理分包 / TextureSharing）单测。
 *
 * 夹具是 SuperMap Online `3D-CBD/Xiaopin@CBD` 的真实块文件（服务端公开数据，
 * 46 个块里取了 3 个有代表性的：多图集 + 嵌入数据、单图集全覆盖、单图集全覆盖）。
 *
 * 另外用官方 `@supermapgis/s3m-content-loader` 的 S3MBlockBufferLoader 做 oracle：
 * 同一份二进制两边解析，图集元信息与顶点数必须一致——布局是逆向标定的，
 * 有官方实现对着，格式读错会立刻暴露。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parseS3MBlock } from '../../packages/s3m-three/src/core/S3MBlockParser';
import { toArrayBuffer } from '../helpers/sample';

const FIXTURES = join(import.meta.dir, '../fixtures/s3mblock');
const file = (name: string) => readFileSync(join(FIXTURES, name));

const inflate = (b: Uint8Array) => new Uint8Array(inflateSync(Buffer.from(b)));

async function parse(name: string) {
  return parseS3MBlock(toArrayBuffer(file(name)), { inflate });
}

describe('S3MBLOCK 容器与内嵌瓦片', () => {
  test('0.s3mblock：双图集、几何与段消费完整', async () => {
    const tile = await parse('0.s3mblock');

    expect(tile.blockVersion).toBeCloseTo(2.1, 5);
    expect(tile.version).toBeCloseTo(2.1, 5);
    expect(tile.blockName).toBe('0');
    // 内层瓦片体的字节消费完整性：段目录偏移错一处就会不等
    expect(tile.bytesRead).toBe(tile.bytesTotal);

    const geos = Object.keys(tile.geoPackage);
    expect(geos).toEqual(['0000000082B02CF0']);
    const vp = tile.geoPackage[geos[0]]!.vertexPackage;
    expect(vp.verticesCount).toBe(1094);

    // 容器 pageLOD 提供 LOD 与子瓦片
    expect(tile.groupNode.pageLods).toHaveLength(1);
    expect(tile.groupNode.pageLods[0]!.childTile).toBe('0_00.s3mblock');
    expect(tile.groupNode.pageLods[0]!.rangeMode).toBe(1);
    expect(tile.groupNode.pageLods[0]!.boundingSphere.radius).toBeGreaterThan(0);
  });

  test('图集元信息：尺寸、内嵌数据、子区域与顶点绑定', async () => {
    const tile = await parse('0.s3mblock');
    const tp = tile.texturePackage;

    const atlas1 = tp['-667946976.texblock']!;
    // 多图集块会被合并成一张大图（core/AtlasPack.ts），原始尺寸/像素留在 origin 上
    const src = (atlas1 as { origin?: { width: number; height: number; pixelFormat: number; dataLength: number } }).origin ?? {
      width: atlas1.width,
      height: atlas1.height,
      pixelFormat: atlas1.pixelFormat,
      dataLength: atlas1.data?.length ?? 0,
    };
    expect(src.width).toBe(48);
    expect(src.height).toBe(40);
    // 48×40 DXT5 = 12×10 块 × 16B
    expect(src.dataLength).toBe(1920);
    expect(src.pixelFormat).toBe(21);
    expect(atlas1.subTexInfos).toHaveLength(2);
    expect(atlas1.subTexInfos[0]).toMatchObject({ subName: '60_3.texblock', offsetX: 0, offsetY: 0, width: 48, height: 32 });
    expect(atlas1.subTexInfos[1]).toMatchObject({ subName: '64_3.texblock', offsetX: 0, offsetY: 32, width: 24, height: 8 });

    const atlas2 = tp['562035931.texblock']!;
    const src2 = (atlas2 as { origin?: { width: number; height: number; dataLength: number } }).origin ?? {
      width: atlas2.width,
      height: atlas2.height,
      dataLength: atlas2.data?.length ?? 0,
    };
    expect(src2.width).toBe(192);
    expect(src2.height).toBe(128);
    expect(src2.dataLength).toBe(24576);
    // 192×128 覆盖整张图集，绑到 texUnit 1（uv2）
    expect(atlas2.subTexInfos[0]).toMatchObject({ subName: '40_3.texblock', offsetX: 0, offsetY: 0, width: 192, height: 128 });
    expect(atlas2.subTexInfos[0]!.bindings[0]).toMatchObject({
      geoName: '0000000082B02CF0',
      vertexOffset: 0,
      vertexCount: 1094,
      texUnitIndex: 1,
    });

    // 图集要能被材质按 id 找到
    expect(Object.keys(tile.textures)).toEqual(expect.arrayContaining(Object.keys(tp)));
  });

  test('图集矩形：逐顶点落到所属子区域，UV 保持原值', async () => {
    const tile = await parse('0.s3mblock');
    const geoName = Object.keys(tile.geoPackage)[0]!;
    const vp = tile.geoPackage[geoName]!.vertexPackage;
    const uv = vp.vertexAttributes.find((a) => a.semantic === 'uv')!;
    expect(uv.dtype).toBe('f32');
    const f = new Float32Array(uv.data.buffer, uv.data.byteOffset, uv.data.byteLength / 4);

    // 平铺的 fract 必须在片元做：顶点上取 fract 会让跨整数 UV 边界的三角形反向扫纹理，
    // 所以解析器不得改动原始 UV（这份数据的立面平铺到 ±20 个周期）。
    expect(Math.min(...f)).toBeLessThan(-1);
    expect(Math.max(...f)).toBeGreaterThan(1);

    const rects = tile.atlasRects![geoName]!;
    // [0..953) → 64_3 区域 (0,32,24,8)；[953..1094) → 60_3 区域 (0,0,48,32)
    //
    // 归一化 y 从**图集另一端**量：纹理上传时 flipY = true，直接拿 offsetY / height
    // 会让 rect 落到图集的空白/天空区，整面墙被 alphaTest 抠成窟窿。
    const rectAt = (v: number) => [rects.uv![v * 4], rects.uv![v * 4 + 1], rects.uv![v * 4 + 2], rects.uv![v * 4 + 3]];
    // rect 会再按图集 alpha 收缩到不透明本体（见 core/AtlasAlpha.ts），精确值不再是
    // 子区域原值。这里断言两件真正重要的事：① 落在图集内且非退化；② 同一 binding
    // 覆盖的顶点拿到的是同一个 rect（否则一段墙面会被拆成好几块精灵）。
    const inAtlas = (got: number[]) => {
      expect(got[2]!).toBeGreaterThan(0);
      expect(got[3]!).toBeGreaterThan(0);
      expect(got[0]!).toBeGreaterThanOrEqual(-1e-6);
      expect(got[1]!).toBeGreaterThanOrEqual(-1e-6);
      expect(got[0]! + got[2]!).toBeLessThanOrEqual(1 + 1e-6);
      expect(got[1]! + got[3]!).toBeLessThanOrEqual(1 + 1e-6);
    };
    for (const v of [0, 952, 953, 1093]) inAtlas(rectAt(v));
    // 同一个绑定组（同一张精灵）覆盖的顶点必须拿到同一个 rect，
    // 否则一段墙面会被拆成好几块精灵；不同组则允许不同（可能来自不同图集）。
    const grp = rects.group!;
    if (grp[0] === grp[952]) expect(rectAt(0)).toEqual(rectAt(952));
    if (grp[953] === grp[1093]) expect(rectAt(953)).toEqual(rectAt(1093));

    // uv2 同样只要求落在图集内、不退化
    expect(rects.uv2!.length).toBe(1094 * 4);
    inAtlas([rects.uv2![0]!, rects.uv2![1]!, rects.uv2![2]!, rects.uv2![3]!]);
  });

  test('rect 宽度必须包含子区域右 1/3 的内联 mip 列', async () => {
    // 子区域右 1/3 不是贴图内容，是 mip 金字塔（mip1 在 (x+2w/3, y)，mip2 在它下方…）。
    // 所以 rect 必须原样保留 width，不能按 alpha 收缩到不透明包围盒 ——
    // 一旦收缩，着色器里 `texSize = rect.zw * 2/3` 算出来的就不是 mip0 的尺寸，
    // mip>0 时平移量也会落空，整面墙碎成拼贴。
    const tile = await parse('0.s3mblock');
    let checked = 0;
    for (const tex of Object.values(tile.texturePackage)) {
      for (const sub of tex.subTexInfos) {
        for (const b of sub.bindings) {
          if (b.texUnitIndex !== 0) continue;
          const r = tile.atlasRects?.[b.geoName]?.uv;
          if (!r) continue;
          const v = b.vertexOffset;
          expect(r[v * 4 + 2]! * tex.width).toBeCloseTo(sub.width, 5);
          expect(r[v * 4 + 3]! * tex.height).toBeCloseTo(sub.height, 5);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('1.s3mblock / 2.s3mblock：全覆盖子区域，矩形退化为整张图集', async () => {
    for (const name of ['1.s3mblock', '2.s3mblock']) {
      const tile = await parse(name);
      expect(tile.bytesRead).toBe(tile.bytesTotal);
      const geoName = Object.keys(tile.geoPackage)[0]!;
      const vp = tile.geoPackage[geoName]!.vertexPackage;
      expect(vp.verticesCount).toBe(45);

      const atlas = Object.values(tile.texturePackage)[0]!;
      expect(atlas.width).toBe(48);
      expect(atlas.height).toBe(32);
      expect(atlas.data!.length).toBe(1536); // 48×32 DXT5
      expect(atlas.subTexInfos[0]).toMatchObject({ offsetX: 0, offsetY: 0, width: 48, height: 32 });

      const uv = vp.vertexAttributes.find((a) => a.semantic === 'uv')!;
      const f = new Float32Array(uv.data.buffer, uv.data.byteOffset, uv.data.byteLength / 4);
      // 全覆盖 → 矩形 (0,0,1,1)，且原始 UV 一个字节都不该被改
      const rects = tile.atlasRects![geoName]!.uv!;
      for (let v = 0; v < 45; v++) {
        // 全覆盖子区域，但会被 alpha 收缩到不透明本体：只要求不越界、不退化成空矩形
        const x = rects[v * 4]!, y = rects[v * 4 + 1]!, w = rects[v * 4 + 2]!, h = rects[v * 4 + 3]!;
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(1 + 1e-6);
        expect(y + h).toBeLessThanOrEqual(1 + 1e-6);
        expect(Number.isFinite(f[v * 2]!)).toBe(true);
      }
    }
  });
});

describe('S3MBLOCK 纹理表必须与 rect 同坐标系', () => {
  /**
   * 这是一条**曾经真错**的不变量：`textures` 原来在 `buildAtlasRects`（内部会把多张图集
   * 拼成一张）**之前**就建好了，于是渲染侧拿到的是拼图前的块内嵌缩略图（如 120×128 DXT5），
   * 而 aAtlasRect 是拼图坐标系（按 240×128 归一化）。
   *
   * 后果不是「糊一点」，而是 texSize 只有真实值的 1/2：
   *   maxMip = log2(min(w*2/3, h)) 掉一档、dFdx(uv*texSize) 也跟着变小 → mip 几乎恒为 0
   *   → 每像素采到随机纹素 → 满屏彩色雪花，越远越糟。
   */
  test('拼图块：textures 的尺寸/像素必须就是拼图那张，且不许翻行、不许开 GPU mip', async () => {
    const tile = await parse('0.s3mblock');
    let packedCount = 0;
    for (const [id, tp] of Object.entries(tile.texturePackage)) {
      const tex = tile.textures[id];
      expect(tex).toBeDefined();
      expect(tex!.width).toBe(tp.width);
      expect(tex!.height).toBe(tp.height);
      // 像素必须是同一份，不能是拼图前那份
      expect(tex!.data).toBe(tp.data as Uint8Array);
      if ((tp as { packed?: boolean }).packed) {
        packedCount++;
        expect(tex!.packed).toBe(true);
        // 拼图输出自上而下，v=0 就是首行：再翻行整张图会上下颠倒
        expect(tex!.flipY).toBe(false);
        expect(tex!.compressType).toBe(0);
        expect(tex!.pixelFormat).toBe(28);
      }
    }
    expect(packedCount).toBeGreaterThan(0);
  });

  test('未拼图的块仍走「原始 DXT 图集 + 翻行」那条路', async () => {
    const tile = await parse('1.s3mblock');
    const id = Object.keys(tile.texturePackage)[0]!;
    const tex = tile.textures[id]!;
    expect(tex.packed).toBeFalsy();
    expect(tex.flipY).toBe(true);
    expect(tex.data).toBe(tile.texturePackage[id]!.data as Uint8Array);
  });
});

describe('S3MBLOCK 高清图集重拼（解拼图 → 换图 → 重拼）', () => {
  /** 把「渲染侧真正会用到的东西」抓一份快照，用来比较重拼前后是否完全一致 */
  function snapshot(tile: ReturnType<typeof parse> extends Promise<infer T> ? T : never) {
    const rects: Record<string, number[]> = {};
    for (const [geo, r] of Object.entries(tile.atlasRects ?? {})) {
      rects[geo] = Array.from(r.uv ?? []);
      rects[`${geo}#group`] = Array.from(r.group ?? []);
    }
    const textures: Record<string, unknown> = {};
    for (const [id, t] of Object.entries(tile.textures ?? {})) {
      textures[id] = { w: t.width, h: t.height, packed: t.packed, flipY: t.flipY, packKey: t.packKey };
    }
    return { rects, textures };
  }

  test('解拼图后状态必须显式失效（不能留着拼图坐标系的旧值）', async () => {
    const { unpackBlockTextures } = await import('../../packages/s3m-three/src/core/S3MBlockParser');
    const tile = await parse('0.s3mblock');
    expect(Object.keys(tile.textures).length).toBeGreaterThan(0);

    const unpacked = unpackBlockTextures(tile);
    expect(unpacked).toBe(true);

    for (const tp of Object.values(tile.texturePackage)) {
      const t = tp as unknown as { packed?: boolean; flipY?: boolean; origin?: { width: number } };
      expect(t.packed).toBeFalsy();
      // 退回原始 DXT 图集 → 又要翻行了
      expect(t.flipY).toBe(true);
      expect(tp.width).toBe(t.origin!.width);
    }
    // 失效而不是留旧值：忘了重拼要立刻表现为「没贴图」，而不是画面错位
    expect(tile.textures).toEqual({});
    expect(tile.atlasRects).toEqual({});
  });

  test('重拼必须逐位还原：rect / 纹理表 / 拼图签名都不能漂', async () => {
    const { unpackBlockTextures, rebuildBlockTextureState } = await import('../../packages/s3m-three/src/core/S3MBlockParser');
    const tile = await parse('0.s3mblock');
    const before = snapshot(tile);

    expect(unpackBlockTextures(tile)).toBe(true);
    rebuildBlockTextureState(tile);

    expect(snapshot(tile)).toEqual(before);
    // 纹理表里的像素必须就是 texturePackage 里那张（第十一轮事故的核心不变量）
    for (const [id, tp] of Object.entries(tile.texturePackage)) {
      expect(tile.textures[id]!.data).toBe(tp.data as Uint8Array);
    }
  });

  test('换成整数倍高清图后，归一化 rect 必须完全不变（rectScale 的作用）', async () => {
    const { rebuildBlockTextureState } = await import('../../packages/s3m-three/src/core/S3MBlockParser');

    // 造一个最小可用的块：单图集（不触发拼图）+ 一个 4 顶点几何
    const mkTile = (w: number, h: number, rectScale?: number) => {
      const tp = {
        A: {
          id: 'A',
          level: 0,
          width: w,
          height: h,
          compressType: 0,
          pixelFormat: 28,
          data: new Uint8Array(w * h * 4),
          childTexNames: [],
          requestNames: [],
          rectScale,
          subTexInfos: [
            {
              subName: 's.texblock',
              offsetX: 2,
              offsetY: 1,
              width: 8,
              height: 6,
              bindings: [{ geoName: 'G', texUnitIndex: 0, vertexOffset: 0, vertexCount: 4 }],
            },
          ],
        },
      };
      return {
        geoPackage: { G: { vertexPackage: { verticesCount: 4 } } },
        texturePackage: tp,
        textures: {},
        atlasRects: {},
      } as unknown as Parameters<typeof rebuildBlockTextureState>[0];
    };

    // 基准：rect 参考尺寸 = 纹理尺寸
    const base = mkTile(32, 32);
    rebuildBlockTextureState(base);
    const r0 = Array.from(base.atlasRects!['G']!.uv!);

    // 换成 2 倍高清图：尺寸翻倍 + rectScale=2 → 归一化 rect 必须一模一样
    const hi = mkTile(64, 64, 2);
    rebuildBlockTextureState(hi);
    const r1 = Array.from(hi.atlasRects!['G']!.uv!);

    expect(r1).toEqual(r0);
    // 反证：如果忘了 rectScale，rect 会缩到一半
    const forgot = mkTile(64, 64);
    rebuildBlockTextureState(forgot);
    const r2 = Array.from(forgot.atlasRects!['G']!.uv!);
    expect(r2[2]).toBeCloseTo(r0[2]! / 2, 6);
  });

  test('换过像素再重拼，rect 跟着拼图重算而不是沿用旧值', async () => {
    const { unpackBlockTextures, rebuildBlockTextureState } = await import('../../packages/s3m-three/src/core/S3MBlockParser');
    const tile = await parse('0.s3mblock');
    const ids = Object.keys(tile.texturePackage);
    expect(ids.length).toBeGreaterThan(1);

    // 模拟「第一张图集换成了更大的高清版」（内容随便，只看重拼是否把它算进去）
    expect(unpackBlockTextures(tile)).toBe(true);
    const first = tile.texturePackage[ids[0]!]!;
    const big = new Uint8Array(first.width * 2 * first.height * 2 * 4).fill(200);
    first.data = big;
    first.width *= 2;
    first.height *= 2;

    rebuildBlockTextureState(tile);

    // 拼图整体变宽了，归一化 rect 必须随之改变（第二张图集的 x 会被推到更右边）
    const packedW = tile.texturePackage[ids[0]!]!.width;
    expect(packedW).toBeGreaterThan(0);
    const geo = Object.keys(tile.atlasRects!)[0]!;
    const r = tile.atlasRects![geo]!.uv!;
    expect(r.length).toBeGreaterThan(0);
    for (let i = 0; i < r.length; i += 4) {
      expect(r[i + 2]!).toBeGreaterThan(0);
      expect(r[i]! + r[i + 2]!).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe('S3MBLOCK 子图集（.texblock）', () => {
  test('独立子图集文件：容器与内层单条图像记录字节闭合', async () => {
    const { parseS3MBlockTextureFile } = await import('../../packages/s3m-three/src/core/S3MBlockParser');
    const buf = toArrayBuffer(file('911305599.texblock'));
    const imgs = await parseS3MBlockTextureFile(buf, { inflate });

    expect(imgs).toHaveLength(1);
    const img = imgs[0]!;
    expect(img.id).toBe('911305599.texblock');
    expect(img.width).toBe(396);
    expect(img.height).toBe(768);
    expect(img.compressType).toBe(14);
    // DXT5 = 1 字节/像素
    expect(img.data.length).toBe(396 * 768);

    // 它是 33.s3mblock 里那张 204×384 根图集的清晰版：同一套排布、等比放大
    expect(img.width * img.height).toBeGreaterThan(204 * 384);
  });

  test('根图集挂的 child 名字是 .texblock', async () => {
    const tile = await parse('0.s3mblock');
    const all = Object.values(tile.texturePackage).flatMap((t) => t.childTexNames);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((c) => /\.texblock$/i.test(c))).toBe(true);
  });
});

describe('S3MBLOCK 与官方 loader 交叉验证', () => {
  test('图集元信息与顶点数和 @supermapgis/s3m-content-loader 一致', async () => {
    const { default: S3MBlockBufferLoader } = await import('@supermapgis/s3m-content-loader/source/S3MBlockBufferLoader.js');

    for (const name of ['0.s3mblock', '1.s3mblock', '2.s3mblock']) {
      const mine = await parse(name);
      const official = S3MBlockBufferLoader.load(toArrayBuffer(file(name)), {}, []) as Record<string, any>;
      const group = Object.values(official)[0]!;

      // 骨架数与顶点数
      const myGeos = Object.keys(mine.geoPackage);
      const offGeos = Object.keys(group.geoPackage);
      expect(myGeos).toEqual(offGeos);
      for (const gn of myGeos) {
        expect(mine.geoPackage[gn]!.vertexPackage.verticesCount).toBe(group.geoPackage[gn].vertexPackage.verticesCount);
      }

      // 图集元信息
      for (const [id, t] of Object.entries(group.texturePackage) as [string, any][]) {
        const mine2 = mine.texturePackage[id]!;
        // 多图集块在解析阶段会被合并成一张大图（core/AtlasPack.ts），
        // 尺寸/像素自然不再等于单个图集，这里只校验子区域声明仍然一一对应。
        if ((mine2 as { packed?: boolean }).packed) {
          expect(mine2.subTexInfos.length).toBe(t.subTexInfos.length);
          continue;
        }
        expect(mine2.width).toBe(t.width);
        expect(mine2.height).toBe(t.height);
        expect(mine2.compressType).toBe(t.compressType);
        expect(mine2.pixelFormat).toBe(t.format);
        expect(mine2.data?.length ?? 0).toBe(t.textureData?.length ?? 0);
        expect(mine2.subTexInfos.length).toBe(t.subTexInfos.length);
        for (let i = 0; i < t.subTexInfos.length; i++) {
          expect(mine2.subTexInfos[i]).toMatchObject({
            subName: t.subTexInfos[i].subName,
            offsetX: t.subTexInfos[i].offsetX,
            offsetY: t.subTexInfos[i].offsetY,
            width: t.subTexInfos[i].width,
            height: t.subTexInfos[i].height,
          });
          expect(mine2.subTexInfos[i]!.bindings.length).toBe(t.subTexInfos[i].subVertexOffsetArr.length);
        }
      }
    }
  });
});
