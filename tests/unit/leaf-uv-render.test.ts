/**
 * S3MBLOCK leaf 的 UV 渲染契约测试。
 *
 * 这条测试故意不走「合成数据 + 只检查画布非空」的捷径，而是使用 OlympicGreen
 * Building@OlympicGreen/6_000000 的真实块与真实 .texblock 响应，完整经过：
 *
 *   parseS3MBlockGroups → _fillExternalAtlases → buildTileObjects
 *   → geometry.uv/aAtlasRect + material.map → 官方 mip0/fract/rect 采样
 *
 * 最终颜色必须逐点等于**独立解码的 117_0 原始精灵**。因此以下任一问题都会失败：
 * 请求段错位、subName 匹配错误、图集落位/行序错误、rect 坐标系错误、材质绑错图、
 * UV 被重写、着色器没有替换默认 map 采样。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import {
  parseS3MBlockGroups,
  parseTexblockSegments,
} from '../../packages/s3m-three/src/core/S3MBlockParser';
import type {
  S3MBlockAtlasImage,
  S3MBlockTile,
} from '../../packages/s3m-three/src/core/S3MBlockParser';
import DXTTextureDecode from '../../packages/s3m-three/src/core/DXTTextureDecode';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';

const FIXTURE = path.resolve('tests/fixtures/s3mblock/leaf');
const realFetch = globalThis.fetch;

function arrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function rgbaAt(data: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

/** 独立基准：不经过 composeLeafAtlas / AtlasPack / TextureFactory。 */
function decodeOfficialSprite(image: S3MBlockAtlasImage): Uint8Array {
  const decoded = new Uint8Array(image.width * image.height * 4);
  DXTTextureDecode.decode(decoded, image.width, image.height, image.data, 21);
  // DXTTextureDecode 输出底朝上；官方 subTextureInfo 的 offsetY 与 rect 使用顶向下坐标。
  const topDown = new Uint8Array(decoded.length);
  const stride = image.width * 4;
  for (let y = 0; y < image.height; y++) {
    const src = (image.height - 1 - y) * stride;
    topDown.set(decoded.subarray(src, src + stride), y * stride);
  }
  return topDown;
}

describe('真实 S3MBLOCK leaf：UV 最终采样必须命中原始精灵', () => {
  beforeEach(() => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('extratiles=')) {
        return new Response(fs.readFileSync(path.join(FIXTURE, 'Tex_0.pack')), { status: 200 });
      }
      if (url.endsWith('Tile_6_000000.texblock')) {
        return new Response(fs.readFileSync(path.join(FIXTURE, 'Tile_6_000000.texblock')), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('117_0：从真实 UV 到材质像素的整条链路逐点一致', async () => {
    const block = fs.readFileSync(path.join(FIXTURE, '6_00.s3mblock'));
    const groups = await parseS3MBlockGroups(arrayBuffer(block));
    const tile = groups.tiles[2] as S3MBlockTile; // 6_000000，31 个 base 精灵 + 1 个 bake 精灵
    expect(tile.blockName).toBe('6_000000');

    const tileset = new S3MTileset({ configUrl: 'http://localhost/config' } as never);
    await (tileset as unknown as {
      _fillExternalAtlases(tile: S3MBlockTile, url: string): Promise<void>;
    })._fillExternalAtlases(tile, 'http://localhost/6_00.s3mblock');

    const atlas = tile.texturePackage['-1352559696.texblock']!;
    const sub = atlas.subTexInfos.find((s) => s.subName === '117_0.texblock')!;
    const binding = sub.bindings.find((b) => b.texUnitIndex === 0)!;
    expect(binding).toBeDefined();

    const pack = await parseTexblockSegments(arrayBuffer(fs.readFileSync(path.join(FIXTURE, 'Tex_0.pack'))));
    const source = pack[0]!.find((r) => r.id === '117_0.texblock')!;
    const reference = decodeOfficialSprite(source);

    const built = await buildTileObjects(tile, { batching: false });
    const mesh = built.objects.find(
      (o): o is THREE.Mesh => o instanceof THREE.Mesh && o.userData.skeletonName === binding.geoName
    )!;
    expect(mesh).toBeDefined();

    const geometry = mesh.geometry;
    const material = mesh.material as THREE.MeshStandardMaterial;
    const map = material.map as THREE.DataTexture;
    expect(map).toBeInstanceOf(THREE.DataTexture);
    expect(map.generateMipmaps).toBe(false);
    expect(map.minFilter).toBe(THREE.LinearFilter);
    expect(material.defines).toHaveProperty('S3M_ATLAS');

    const uv = geometry.getAttribute('uv');
    const rect = geometry.getAttribute('aAtlasRect');
    expect(uv).toBeDefined();
    expect(rect).toBeDefined();

    const image = map.image as { data: Uint8Array; width: number; height: number };
    const W = image.width;
    const H = image.height;
    const baseW = sub.width * 2 / 3;
    let checked = 0;

    // 跳过落在精灵边缘的顶点：这里验证 mip0 像素归属，不把边缘钳制混进基准。
    for (let v = binding.vertexOffset; v < binding.vertexOffset + binding.vertexCount; v++) {
      const fu = fract(uv.getX(v));
      const fv = fract(uv.getY(v));
      if (fu <= 0.02 || fu >= 0.98 || fv <= 0.02 || fv >= 0.98) continue;

      const rx = rect.getX(v);
      const ry = rect.getY(v);
      const rw = rect.getZ(v);
      const rh = rect.getW(v);
      expect([rx, ry, rw, rh].every(Number.isFinite)).toBe(true);
      expect(rw).toBeGreaterThan(0);
      expect(rh).toBeGreaterThan(0);

      // 与 StyleMaterial.s3mAtlasUnit / s3mAtlasLod 的 mip0 公式一致。
      const texSizeX = rw * W * 2 / 3;
      const texSizeY = rh * H;
      const ou = clamp(fu, 1 / texSizeX, 1 - 1 / texSizeX);
      const ov = clamp(fv, 1 / texSizeY, 1 - 1 / texSizeY);
      const atlasU = rx + ou * texSizeX / W;
      const atlasV = ry + ov * texSizeY / H;
      const actual = rgbaAt(
        image.data,
        W,
        Math.min(W - 1, Math.floor(atlasU * W)),
        Math.min(H - 1, Math.floor(atlasV * H))
      );
      const expected = rgbaAt(
        reference,
        source.width,
        Math.min(source.width - 1, Math.floor(ou * baseW)),
        Math.min(source.height - 1, Math.floor(ov * source.height))
      );
      expect(actual).toEqual(expected);
      checked++;
      if (checked === 8) break;
    }

    expect(checked).toBe(8);

    // 验证不是只在 CPU 里算对了：three 的实际 shader 注入必须替换默认 map 采样。
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.fragmentShader).toContain('s3mAtlasUnit( vMapUv, vAtlasRect, uAtlasDim, map )');
    expect(shader.fragmentShader).not.toContain('texture2D( map, vMapUv )');
    expect(shader.uniforms.uAtlasDim.value).toEqual(new THREE.Vector2(W, H));
  }, 30_000);
});
