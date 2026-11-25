/**
 * 共享纹理缓存 × 同一图集的不同尺寸（issue：`rectScale` 怀疑）。
 *
 * 现状：`buildTileObjects` 的纹理缓存按 `code`（拼图再加 `packKey`）记账，
 * 同一图集 id 在不同瓦片里可能先到缩略图（120×184）、后到高清图（240×304）。
 * 规则是「像素大的留下」——小图命中缓存直接跳过，大图触发重解码覆盖。
 *
 * 这里把它拆成两条可测的断言：
 *   ① 缓存的永远是像素多的那一份，且后到的缩略图**不会**把它换掉（无谓重解码）；
 *   ② 每块瓦片自己的 `atlasRects` 原样进入几何（aAtlasRect），共享纹理不会改写它。
 *
 * ②是「rect 错位」的判据：只要 rect 是按各自声明的图尺寸归一化的，
 * 换个分辨率的同内容纹理采样到的仍是同一块区域；如果哪天归一化口径分叉，
 * 这个用例会红。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';
import type { ParsedTile } from '../../packages/s3m-three/src/core/types';

/** 一块只有一个三角形、只引用图集 `A` 的瓦片 */
function atlasTile(size: number, rect: [number, number, number, number]): ParsedTile {
  const f32 = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);
  const pixel = new Uint8Array(size * size * 4).fill(255);
  return {
    version: 3,
    compressedType: 0,
    options: 0,
    groupNode: { pageLods: [{ geodes: [{ matrix: null, skeletonNames: ['skel0'] }] }] },
    geoPackage: {
      skel0: {
        vertexPackage: {
          verticesCount: 3,
          instanceIndex: -1,
          vertexAttributes: [
            { semantic: 'position', comp: 3, dtype: 'f32', data: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
            { semantic: 'uv', comp: 2, dtype: 'f32', data: f32([0, 0, 1, 0, 0, 1]) },
          ],
        },
        indexPackages: [
          { primitiveType: 4, indexCount: 3, indices: new Uint16Array([0, 1, 2]), passNames: ['M'] },
        ],
      },
    },
    // 逐顶点的子区域矩形（已按本瓦片声明的图尺寸归一化）
    atlasRects: { skel0: { uv: new Float32Array([...rect, ...rect, ...rect]) } },
    textures: {
      A: {
        code: 'A',
        level: 0,
        width: size,
        height: size,
        compressType: 0,
        pixelFormat: 28, // RGBA（raw 路径）
        data: pixel,
      },
    },
    materials: {
      materials: [{ material: { id: 'M', textureStates: [{ textureunitstate: { name: 'A' } }] } }],
    },
    pickInfo: {},
    bytesRead: 0,
    bytesTotal: 0,
  } as unknown as ParsedTile;
}

function rectOf(objects: THREE.Object3D[]): number[] {
  const mesh = objects.find((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh;
  const attr = mesh.geometry.getAttribute('aAtlasRect');
  return Array.from(attr.array as ArrayLike<number>).slice(0, 4);
}

describe('纹理缓存：同一图集不同尺寸', () => {
  test('缩略图先到、高清图后到 → 缓存升级；高清先到 → 缩略图不再覆盖', async () => {
    const cache = new Map<string, THREE.Texture>();

    await buildTileObjects(atlasTile(8, [0, 0, 0.5, 0.5]), { textureCache: cache });
    const small = cache.get('A')!;
    expect((small.image as { width: number }).width).toBe(8);

    await buildTileObjects(atlasTile(16, [0, 0, 0.5, 0.5]), { textureCache: cache });
    const big = cache.get('A')!;
    expect((big.image as { width: number }).width).toBe(16);
    expect(big).not.toBe(small);

    // 又来一块缩略图：不得把高清换掉（无谓重解码）
    await buildTileObjects(atlasTile(8, [0, 0, 0.5, 0.5]), { textureCache: cache });
    expect(cache.get('A')).toBe(big);
  });

  test('共享纹理后，每块瓦片仍用自己归一化的 rect（不发生串位）', async () => {
    const cache = new Map<string, THREE.Texture>();

    // 同一张图集、不同分辨率和不同子区域：各自的 rect 必须原样保留
    const small = await buildTileObjects(atlasTile(8, [0, 0, 0.5, 0.5]), { textureCache: cache });
    const big = await buildTileObjects(atlasTile(16, [0.5, 0.5, 0.5, 0.5]), { textureCache: cache });

    // 两块瓦片共用缓存里的那张 16×16
    expect((cache.get('A')!.image as { width: number }).width).toBe(16);
    expect(rectOf(small.objects)).toEqual([0, 0, 0.5, 0.5]);
    expect(rectOf(big.objects)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});
