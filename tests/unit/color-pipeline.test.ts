/**
 * Direct 色彩管线（supermap 完整版）+ polygonOffset 配置单测。
 *
 * 目标：lightingPreset: 'supermap' 升级为逐像素对齐官方：
 *   1. 纹理字节值**不解码**（NoColorSpace）—— 官方贴图字节值直接进 shader；
 *   2. 光照换成官方常数 Lambert：base * (0.8·NdotL + 0.7)（S3MTilesFS.js:263）；
 *   3. 片元输出前做 sRGB→linear，抵消 renderer outputColorSpace 的 OETF，
 *      使屏幕上的数值 = 官方直乘结果 —— 不动共享 renderer，底图不受影响。
 * 默认管线（'linear'）必须一字节不变。
 */
import { describe, expect, test, afterEach } from 'bun:test';
import * as THREE from 'three';
import { createTexture, setSrgbTextureDecode } from '../../packages/s3m-three/src/render/TextureFactory';
import { setColorPipeline, getColorPipeline, createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';
import type { ParsedTile, S3MTexture } from '../../packages/s3m-three/src/core/types';

afterEach(() => {
  setColorPipeline('linear');
  setSrgbTextureDecode(true);
});

/* ------------------------------------------------------------ 纹理解码 */

const fakeS3MTexture = (): S3MTexture =>
  ({
    code: 'T',
    level: 0,
    width: 2,
    height: 2,
    compressType: 0,
    pixelFormat: 28, // PixelFormat.RGBA，raw 路径
    data: new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]),
  }) as unknown as S3MTexture;

describe('纹理解码开关（官方直乘 = 不做 sRGB 解码）', () => {
  test('默认解码：colorSpace = SRGBColorSpace（现状不变）', async () => {
    const { texture } = await createTexture(fakeS3MTexture());
    expect(texture).not.toBeNull();
    expect(texture!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  test('setSrgbTextureDecode(false)：字节值原样进 shader', async () => {
    setSrgbTextureDecode(false);
    const { texture } = await createTexture(fakeS3MTexture());
    expect(texture).not.toBeNull();
    expect(texture!.colorSpace).toBe(THREE.NoColorSpace);
  });

  test('恢复默认后回到 SRGB', async () => {
    setSrgbTextureDecode(false);
    setSrgbTextureDecode(true);
    const { texture } = await createTexture(fakeS3MTexture());
    expect(texture!.colorSpace).toBe(THREE.SRGBColorSpace);
  });
});

/* ------------------------------------------------------------ 材质注入 */

describe('direct 管线的片元注入', () => {
  const build = () => {
    const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const mat = createStyledMaterial({ map } as never);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    (mat as unknown as { onBeforeCompile: (s: unknown, r: unknown) => void }).onBeforeCompile(shader, null);
    return { shader, mat: mat as unknown as { defines: Record<string, string>; customProgramCacheKey: () => string } };
  };

  test('默认管线：无 S3M_DIRECT_COLOR 分支', () => {
    expect(getColorPipeline()).toBe('linear');
    const { shader, mat } = build();
    expect(shader.fragmentShader).not.toContain('S3M_DIRECT_COLOR');
    expect(mat.defines.S3M_DIRECT_COLOR).toBeUndefined();
  });

  test("setColorPipeline('direct')：官方常数 Lambert + gamma 抵消 + 缓存键隔离", () => {
    setColorPipeline('direct');
    const { shader, mat } = build();
    expect(mat.defines.S3M_DIRECT_COLOR).toBe('');
    expect(mat.customProgramCacheKey()).toContain('-direct');
    // 官方常数：Sun 0.8 / Ambient 0.7（S3MTilesFS.js:255-263）
    expect(shader.fragmentShader).toContain('0.8 * s3mNL');
    expect(shader.fragmentShader).toContain('vec3( 0.7 )');
    // 输出前抵消 renderer 的 linear→sRGB OETF（精确 sRGBToLinear，不是 pow 2.2 近似）
    expect(shader.fragmentShader).toContain('s3mSRGBToLinear');
    expect(shader.fragmentShader).toContain('outgoingLight = s3mDirectOut');
    // 光方向来自共享 uniform
    expect(shader.fragmentShader).toContain('uniform vec3 uSunDirection');
    expect('uSunDirection' in shader.uniforms).toBe(true);
  });

  test('linear 管线不引用 uSunDirection（uniform 不进 program）', () => {
    const { shader } = build();
    expect(shader.fragmentShader).not.toContain('uSunDirection');
  });

  test('sRGBToLinear 的数学正确性（0.5 → 0.214，与浏览器 OETF 互逆）', async () => {
    // 纯函数端等价验证：three 的 SRGBToLinear 常量
    const toLinear = (c: number) =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    expect(toLinear(0.5)).toBeCloseTo(0.2140, 3);
    expect(toLinear(0)).toBe(0);
    expect(toLinear(1)).toBe(1);
  });
});

/* ------------------------------------------------------------ polygonOffset */

/** 一个三角面的最小瓦片 */
function oneTriangleTile(): ParsedTile {
  const f32 = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);
  return {
    version: 3,
    compressedType: 0,
    options: 0,
    groupNode: { pageLods: [{ geodes: [{ matrix: null, skeletonNames: ['skel0'] }] }] },
    geoPackage: {
      skel0: {
        vertexPackage: {
          verticesCount: 3,
          vertexAttributes: [
            { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
            { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: f32([0, 0, 1, 0, 0, 1]) },
          ],
          instanceIndex: -1,
        },
        indexPackages: [{ primitiveType: 4, indexCount: 3, indices: new Uint16Array([0, 1, 2]), passNames: ['M'] }],
      },
    },
    textures: {},
    materials: { materials: [{ material: { id: 'M', textureStates: [] } }] },
    pickInfo: {},
    bytesRead: 0,
    bytesTotal: 0,
  } as unknown as ParsedTile;
}

describe('polygonOffset 配置', () => {
  test('默认不开（行为与旧版一致）', async () => {
    const { objects } = await buildTileObjects(oneTriangleTile());
    for (const o of objects) {
      if (!(o as { isMesh?: boolean }).isMesh) continue;
      const m = (o as { material: THREE.Material }).material;
      expect(m.polygonOffset).toBe(false);
    }
  });

  test('配置后：三角面材质带 polygonOffset（棱线/点云不受影响）', async () => {
    const { objects } = await buildTileObjects(oneTriangleTile(), {
      polygonOffset: { factor: -1, units: -2 },
    } as never);
    let checked = 0;
    for (const o of objects) {
      if (!(o as { isMesh?: boolean }).isMesh) continue;
      const m = (o as { material: THREE.MeshStandardMaterial }).material;
      expect(m.polygonOffset).toBe(true);
      expect(m.polygonOffsetFactor).toBe(-1);
      expect(m.polygonOffsetUnits).toBe(-2);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
