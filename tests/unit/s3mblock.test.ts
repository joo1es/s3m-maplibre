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
    expect(atlas1.width).toBe(48);
    expect(atlas1.height).toBe(40);
    expect(atlas1.data).not.toBeNull();
    // 48×40 DXT5 = 12×10 块 × 16B
    expect(atlas1.data!.length).toBe(1920);
    expect(atlas1.pixelFormat).toBe(21);
    expect(atlas1.subTexInfos).toHaveLength(2);
    expect(atlas1.subTexInfos[0]).toMatchObject({ subName: '60_3.texblock', offsetX: 0, offsetY: 0, width: 48, height: 32 });
    expect(atlas1.subTexInfos[1]).toMatchObject({ subName: '64_3.texblock', offsetX: 0, offsetY: 32, width: 24, height: 8 });

    const atlas2 = tp['562035931.texblock']!;
    expect(atlas2.width).toBe(192);
    expect(atlas2.height).toBe(128);
    expect(atlas2.data!.length).toBe(24576);
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
    const rectAt = (v: number) => [rects.uv![v * 4], rects.uv![v * 4 + 1], rects.uv![v * 4 + 2], rects.uv![v * 4 + 3]];
    const close = (got: number[], want: number[]) => want.forEach((w, k) => expect(got[k]).toBeCloseTo(w, 6));
    close(rectAt(0), [0, 32 / 40, 24 / 48, 8 / 40]);
    close(rectAt(952), [0, 32 / 40, 24 / 48, 8 / 40]);
    close(rectAt(953), [0, 0, 1, 32 / 40]);
    close(rectAt(1093), [0, 0, 1, 32 / 40]);

    // uv2：192×128 图集全覆盖 → 整张图集
    expect(rects.uv2!.length).toBe(1094 * 4);
    expect([rects.uv2![0], rects.uv2![1], rects.uv2![2], rects.uv2![3]]).toEqual([0, 0, 1, 1]);
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
        expect([rects[v * 4], rects[v * 4 + 1], rects[v * 4 + 2], rects[v * 4 + 3]]).toEqual([0, 0, 1, 1]);
        expect(Number.isFinite(f[v * 2]!)).toBe(true);
      }
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
