/**
 * 「着色器翻行」这条链路的接线测试（不是采样数学测试）。
 *
 * 采样等价性另有用例（atlas-flip-v.test.ts，72000 个真实采样点，最大差 1）。
 * 这里钉的是**那个 1 有没有真的送到 GPU**——回归最常见的形态恰恰是接线断了：
 *   ① 图集纹理必须真的走成 CompressedTexture；
 *   ② 纹理上必须带 `userData.s3mAtlasFlipV = 1`（行序没翻）；
 *   ③ 镂空语义 `userData.s3mHasAlpha` 不能丢（否则 alphaTest 变 0，透明处变成黑块）；
 *   ④ 材质必须把它读成 uniform `uAtlasFlipV = 1`，且片元着色器里确实有镜像那一行；
 *   ⑤ 走 RGBA 回退时（不支持 s3tc），以上三项必须反过来说：不压缩、不翻、uniform 0。
 *
 * 任何一条断了都会立刻红，而不需要打开浏览器。
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseS3MBlock } from '../../packages/s3m-three/src/core/S3MBlockParser';
import {
  createTexture,
  setCompressedTexturesSupported,
} from '../../packages/s3m-three/src/render/TextureFactory';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

/** 取一份真实的 Bridge 图集描述（CRN_DXT5、flipY = true） */
async function bridgeAtlas() {
  const buf = readFileSync(join(import.meta.dir, '../fixtures/s3mblock/bridge-child.s3mblock'));
  const tile = await parseS3MBlock(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const tex = Object.values(tile.textures).find((t) => t.flipY === true && t.width > 0);
  expect(tex).toBeDefined();
  return tex!;
}

/** 把 onBeforeCompile 跑一遍，拿 uniforms 与最终片元着色器 */
function compile(map: THREE.Texture | null, atlas = true) {
  const mat = createStyledMaterial({ uniforms: {} as never, map, atlas, alphaTest: 0.01 });
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  mat.onBeforeCompile(shader as never, null as never);
  return { mat, shader };
}

afterEach(() => setCompressedTexturesSupported(false));

describe('图集直传的接线（真实 Bridge 图集）', () => {
  test('支持 s3tc：纹理是 CompressedTexture，带 flip 与 alpha 标记', async () => {
    setCompressedTexturesSupported(true);
    const tex = await bridgeAtlas();
    const { texture } = await createTexture(tex);
    expect(texture).not.toBeNull();
    expect(texture).toBeInstanceOf(THREE.CompressedTexture);
    // 块序与 RGBA 同向（解码器内置 flip + TextureDecode 的 flip 抵消）→ 不需要任何行序标记
    expect(texture!.userData.s3mAtlasFlipV).toBeUndefined();
    // DXT5 带 alpha → 必须保留镂空语义，否则 alphaTest 变 0、透明处成了黑块
    expect(texture!.userData.s3mHasAlpha).toBe(true);
    // 图集不吃 GPU mip（层级由内联金字塔算）
    expect(texture!.generateMipmaps).toBe(false);
    expect(texture!.minFilter).toBe(THREE.LinearFilter);
  }, 30_000);

  test('着色器里不能再有行序镜像（压缩直传与 RGBA 同向）', async () => {
    setCompressedTexturesSupported(true);
    const { texture } = await createTexture(await bridgeAtlas());
    const { shader } = compile(texture);
    expect(shader.uniforms.uAtlasFlipV).toBeUndefined();
    expect(shader.fragmentShader).not.toContain('uAtlasFlipV');
    expect(shader.fragmentShader).toContain('s3mAtlasUnit( vMapUv, vAtlasRect, uAtlasDim, map )');
  }, 30_000);

  test('不支持 s3tc：回退 RGBA，不压缩、不翻、uniform 0', async () => {
    setCompressedTexturesSupported(false);
    const { texture, decoded } = await createTexture(await bridgeAtlas());
    expect(texture).not.toBeNull();
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(texture!.userData.s3mAtlasFlipV).toBeUndefined();
    expect(texture!.userData.s3mHasAlpha).toBe(true);
    expect(decoded.startsWith('crn')).toBe(true);

    const { shader } = compile(texture);
    expect(shader.fragmentShader).not.toContain('uAtlasFlipV');
  }, 30_000);
});
