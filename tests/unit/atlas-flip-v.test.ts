/**
 * 图集「压缩直传」与「解成 RGBA」必须上传**同一个方向**的像素。
 *
 * 这条曾经被我写反过，值得钉死：
 *   `DXTTextureDecode.DecompressImage` 写像素时**内置了一次 flipY**（`height-1-sy`），
 *   `TextureDecode.decodeDXT` 随后又按 `tex.flipY` 翻一次 —— 两次抵消。
 *   所以对 `flipY = true` 的图集，**解出来的 RGBA 与 DXT 块本身的顺序逐字节相同**。
 *
 * 推论：压缩直传（GPU 按块序解）与旧的 RGBA 上传是同一个方向，着色器**不能**再镜像 v。
 * 之前按「块是底朝上」在片元里做了 v→1−v，桥面的贴图就整片错位/重复。
 *
 * 这条测试用真实 Bridge 图集把「两块像素完全一致」钉住；另配阴性对照，证明它测得出问题。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseS3MBlock } from '../../packages/s3m-three/src/core/S3MBlockParser';
import { decodeTextureData } from '../../packages/s3m-three/src/core/TextureDecode';
import DXTTextureDecode from '../../packages/s3m-three/src/core/DXTTextureDecode';
import { PixelFormat } from '../../packages/s3m-three/src/core/TextureFormat';
import type { S3MTexture } from '../../packages/s3m-three/src/core/types';

async function bridgeAtlas(): Promise<S3MTexture> {
  const buf = readFileSync(join(import.meta.dir, '../fixtures/s3mblock/bridge-child.s3mblock'));
  const tile = await parseS3MBlock(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const tex = Object.values(tile.textures).find((t) => t.flipY === true && t.width > 0);
  expect(tex).toBeDefined();
  return tex!;
}

function flipRows(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgba.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(rgba.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
}

function maxChannelDiff(a: Uint8Array, b: Uint8Array): number {
  let max = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

describe('图集压缩直传：与 RGBA 路径同向', () => {
  test('真实 Bridge 图集：块序（GPU 解出来的样子）与 RGBA 上传的像素一致', async () => {
    const tex = await bridgeAtlas();
    const compressed = await decodeTextureData(tex, {
      compressed: true,
      allowCompressedFlipY: true,
      onlyLevel0: true,
    });
    const rgba = await decodeTextureData(tex, { compressed: false });
    expect(compressed.blocks).toBeDefined();
    expect(rgba.rgba).not.toBeNull();

    // DecompressImage 内置了一次 flipY，翻回来才是 GPU 按块序解出来的画面
    const decodedByPublicDecoder = new Uint8Array(compressed.width * compressed.height * 4);
    DXTTextureDecode.decode(
      decodedByPublicDecoder,
      compressed.width,
      compressed.height,
      compressed.blocks!,
      compressed.blockFormat === 'dxt1' ? PixelFormat.DXT1 : PixelFormat.DXT5
    );
    const gpuImage = flipRows(decodedByPublicDecoder, compressed.width, compressed.height);

    expect(maxChannelDiff(gpuImage, rgba.rgba!)).toBeLessThanOrEqual(1);
  }, 30_000);

  test('阴性对照：多翻一次（当年的 bug）会差出大量像素', async () => {
    const tex = await bridgeAtlas();
    const compressed = await decodeTextureData(tex, {
      compressed: true,
      allowCompressedFlipY: true,
      onlyLevel0: true,
    });
    const rgba = await decodeTextureData(tex, { compressed: false });

    const decodedByPublicDecoder = new Uint8Array(compressed.width * compressed.height * 4);
    DXTTextureDecode.decode(
      decodedByPublicDecoder,
      compressed.width,
      compressed.height,
      compressed.blocks!,
      compressed.blockFormat === 'dxt1' ? PixelFormat.DXT1 : PixelFormat.DXT5
    );
    // 不翻回：等价于「再镜像一次 v」的着色器输出，应当与常规上传明显不同
    expect(maxChannelDiff(decodedByPublicDecoder, rgba.rgba!)).toBeGreaterThan(40);
  }, 30_000);
});
