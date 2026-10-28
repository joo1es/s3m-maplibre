/**
 * 顶点色 alpha 与 alphaMode 单测。
 *
 * 背景（`3D-BIMbuilding-2` 实测）：SMID 4421 的材质是 `WhiteMaterial_1`，
 * 无纹理、`diffuse.a = 1`，唯一的不透明度来源是**顶点色 alpha**
 * —— 顶点色 u8 `(0, 128, 192, 63)`，即 alpha = 63/255 ≈ 0.247。
 *
 * 我们此前在两条链路上把它丢了：
 *   1. 组装层 `colorData()` 固定只取 RGB 3 个分量，alpha 直接不要；
 *   2. 着色器 `varying vec3 vVertColor` 也只传 RGB。
 * 另外材质透明判定写的是 `alphaMode === 'AM_BLEND'`，而数据里实际是
 * `'opaque' | 'blend' | 'mask'`（官方 `S3MTiles/Enum/AlphaMode.js` 同样是小写），
 * 所以 blend 材质永远被判成不透明。
 *
 * 这里钉住三件事：组装层保留 RGBA、透明判定认小写枚举与顶点色 alpha、
 * 着色器确实把 alpha 乘进 diffuseColor.a。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { assembleTileGeometry } from '../../packages/s3m-three/src/core/TileGeometry';
import { resolveAlphaMode, isTransparentMaterial } from '../../packages/s3m-three/src/render/materialAlpha';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';
import type { ParsedTile } from '../../packages/s3m-three/src/core/types';

const f32 = (arr: number[]) => new Uint8Array(new Float32Array(arr).buffer);

/** 3 个顶点、带 u8 顶点色的假瓦片；rgba 为 null 表示没有 color 流 */
function fakeTile(rgba: number[] | null): ParsedTile {
  const attrs: unknown[] = [
    { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: f32([0, 0, 1, 0, 0, 1]) },
  ];
  if (rgba) {
    attrs.push({ semantic: 'color', byteOffset: 0, comp: 4, dtype: 'u8', data: new Uint8Array(rgba) });
  }
  return {
    version: 3,
    compressedType: 0,
    options: 0,
    groupNode: { pageLods: [{ geodes: [{ matrix: null, skeletonNames: ['skel0'] }] }] },
    geoPackage: {
      skel0: {
        vertexPackage: { verticesCount: 3, vertexAttributes: attrs, instanceIndex: -1 },
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

/* ------------------------------------------------------------ 组装层 */

describe('组装产物的 aColor 是 RGBA', () => {
  test('u8 顶点色的 alpha 必须保留（4421 的透明度就在这里）', () => {
    const { primitives } = assembleTileGeometry(fakeTile([0, 128, 192, 63, 0, 128, 192, 63, 0, 128, 192, 63]));
    const attr = primitives[0]!.attributes.aColor;
    expect(attr.components).toBe(4);
    expect(attr.array.length).toBe(12);
    expect((attr.array as Float32Array)[3]).toBeCloseTo(63 / 255, 6);
    expect((attr.array as Float32Array)[0]).toBeCloseTo(0, 6);
    expect((attr.array as Float32Array)[1]).toBeCloseTo(128 / 255, 6);
  });

  test('没有 color 流时补成不透明的白色（行为与之前一致）', () => {
    const { primitives } = assembleTileGeometry(fakeTile(null));
    const attr = primitives[0]!.attributes.aColor;
    expect(attr.components).toBe(4);
    expect(Array.from(attr.array as Float32Array)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  test('合批搬运 4 个分量，不串行', () => {
    const tile = fakeTile([0, 128, 192, 63, 255, 0, 0, 255, 0, 255, 0, 128]);
    const geo = (tile.geoPackage as Record<string, any>).skel0;
    (tile.geoPackage as Record<string, unknown>).skel1 = {
      ...geo,
      vertexPackage: { ...geo.vertexPackage, vertexAttributes: geo.vertexPackage.vertexAttributes.map((a: any) => ({ ...a })) },
      indexPackages: geo.indexPackages.map((p: any) => ({ ...p })),
    };
    (tile.groupNode as unknown as { pageLods: { geodes: { matrix: null; skeletonNames: string[] }[] }[] }).pageLods[0]!.geodes = [
      { matrix: null, skeletonNames: ['skel0'] },
      { matrix: null, skeletonNames: ['skel1'] },
    ];
    const { primitives } = assembleTileGeometry(tile);
    const arr = primitives[0]!.attributes.aColor.array as Float32Array;
    expect(arr.length).toBe(24);
    expect(arr[3]).toBeCloseTo(63 / 255, 6);
    expect(arr[7]).toBeCloseTo(1, 6);
    expect(arr[11]).toBeCloseTo(128 / 255, 6);
    // 第二个骨架原样重复
    expect(arr[15]).toBeCloseTo(63 / 255, 6);
  });
});

/* ------------------------------------------------------------ 透明判定 */

describe('resolveAlphaMode（官方 AlphaMode 是小写枚举）', () => {
  test('数据里的真实取值', () => {
    expect(resolveAlphaMode('blend')).toBe('blend');
    expect(resolveAlphaMode('mask')).toBe('mask');
    expect(resolveAlphaMode('opaque')).toBe('opaque');
  });

  test('规范文档写法 AM_BLEND / 大小写变体也要认', () => {
    expect(resolveAlphaMode('AM_BLEND')).toBe('blend');
    expect(resolveAlphaMode('AM_MASK')).toBe('mask');
    expect(resolveAlphaMode('AM_OPAQUE')).toBe('opaque');
    expect(resolveAlphaMode('BLEND')).toBe('blend');
  });

  test('缺失或未知取值回落 opaque', () => {
    expect(resolveAlphaMode(undefined)).toBe('opaque');
    expect(resolveAlphaMode('')).toBe('opaque');
    expect(resolveAlphaMode('whatever')).toBe('opaque');
  });
});

describe('isTransparentMaterial', () => {
  test('★ alphaMode=blend 必须透明（旧代码认 AM_BLEND，永远不命中）', () => {
    expect(isTransparentMaterial({ alphaMode: 'blend' })).toBe(true);
  });

  test('★ 顶点色 alpha < 1 必须透明，即使材质自称 opaque', () => {
    expect(isTransparentMaterial({ alphaMode: 'opaque', vertexAlphaMin: 63 / 255 })).toBe(true);
  });

  test('3D-BIMbuilding-2 / SMID 4421 的真实组合', () => {
    expect(isTransparentMaterial({ alphaMode: 'blend', diffuseAlpha: 1, vertexAlphaMin: 63 / 255 })).toBe(true);
  });

  test('不透明材质保持不透明（不能因为改动把所有楼变成半透明）', () => {
    expect(isTransparentMaterial({ alphaMode: 'opaque' })).toBe(false);
    expect(isTransparentMaterial({ alphaMode: 'opaque', diffuseAlpha: 1, vertexAlphaMin: 1 })).toBe(false);
    expect(isTransparentMaterial({})).toBe(false);
  });

  test('mask 走 alphaTest 而不是混合（树叶镂空不该进透明队列）', () => {
    expect(isTransparentMaterial({ alphaMode: 'mask', vertexAlphaMin: 1 })).toBe(false);
  });

  test('diffuse.a < 1、transparentsorting、无贴图水面都算透明', () => {
    expect(isTransparentMaterial({ alphaMode: 'opaque', diffuseAlpha: 0.5 })).toBe(true);
    expect(isTransparentMaterial({ alphaMode: 'opaque', transparentSorting: true })).toBe(true);
    expect(isTransparentMaterial({ alphaMode: 'opaque', isWaterWithoutMap: true })).toBe(true);
  });
});

/* ------------------------------------------------------------ 着色器 */

describe('顶点色 alpha 进入着色器', () => {
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
    return shader;
  };

  test('varying 是 vec4 且整条赋值', () => {
    const { vertexShader } = build();
    expect(vertexShader).toContain('varying vec4 vVertColor');
    expect(vertexShader).toContain('vVertColor = aColor');
    expect(vertexShader).not.toContain('varying vec3 vVertColor');
  });

  test('alpha 乘进 diffuseColor.a，rgb 用法保持原样', () => {
    const fs = build().fragmentShader;
    expect(fs).toContain('varying vec4 vVertColor');
    expect(fs).toContain('diffuseColor.a *= vVertColor.a');
    expect(fs).toContain('diffuseColor.rgb = s3mBase * vVertColor.rgb');
  });
});
