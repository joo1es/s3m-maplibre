/**
 * uv 第三分量（custom0 / 官方 aTextureCoordMatrix）单测。
 *
 * 背景：SuperMap Online 的 BIM 数据里，同一块瓦片的 custom0 会同时出现
 * `-99999`（该顶点不采样纹理 → 纯色）和 `65536+n`。忽略它，本该纯色的墙面
 * 就会被贴上整张材质图并每米重复一次。
 *
 * 这里钉住两件事：
 *   1. 哨兵判定（`< -90000` 才算「不采样」），以及**没有该属性时行为不变**；
 *   2. 组装产物里带 / 不带 `aTexCoordZ` 的分流、合批搬运不丢这条属性。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  isTexCoordDisabled,
  isTexCoordWhite,
  decodeTexMatrix,
  TEX_COORD_Z_DISABLED_BELOW,
  TEX_COORD_Z_WHITE_BELOW,
} from '../../packages/s3m-three/src/core/TexCoordZ';
import { assembleTileGeometry } from '../../packages/s3m-three/src/core/TileGeometry';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';
import type { ParsedTile } from '../../packages/s3m-three/src/core/types';

const f32 = (arr: number[]) => new Uint8Array(new Float32Array(arr).buffer);

describe('isTexCoordDisabled（官方 inTexCoord.z < -9000 哨兵）', () => {
  // 三档语义（官方 bundle getTextureColor/getUV 实测）：
  //   z < -99900 → 纯白不采样（SMID 3464 这类平涂顶点色面）
  //   -99900 ≤ z < -9000 → uv 原样平铺
  //   其余 → 图集子区域公式
  // 之前把 -99999 当平铺，3464 的米制 uv 就整图平铺上百次（「uv 整图」bug）。
  test('-99999 命中白色档（不采样），-90001 / -50000 命中平铺分支', () => {
    expect(isTexCoordWhite(-99999)).toBe(true);
    expect(isTexCoordDisabled(-99999)).toBe(true); // disabled 仍为真，但 white 优先
    expect(isTexCoordDisabled(-90001)).toBe(true);
    expect(isTexCoordDisabled(-50000)).toBe(true);
    expect(isTexCoordWhite(-90001)).toBe(false);
    expect(isTexCoordWhite(-50000)).toBe(false);
  });

  test('边界与正常值不命中：阈值本身、0、以及 65536+n 走子区域分支', () => {
    expect(isTexCoordDisabled(TEX_COORD_Z_DISABLED_BELOW)).toBe(false);
    expect(isTexCoordDisabled(-1)).toBe(false);
    expect(isTexCoordDisabled(0)).toBe(false); // three 未绑定 attribute 时的默认值
    expect(isTexCoordDisabled(65536)).toBe(false);
    expect(isTexCoordDisabled(65793)).toBe(false);
    expect(isTexCoordWhite(TEX_COORD_Z_WHITE_BELOW)).toBe(false);
    expect(isTexCoordWhite(0)).toBe(false);
  });

  test('decodeTexMatrix 的档位编码：白=-2、平铺=-1、公式=1/2^level', () => {
    expect(decodeTexMatrix(-99999)).toMatchObject({ disabled: true, white: true, scale: -2 });
    expect(decodeTexMatrix(-50000)).toMatchObject({ disabled: true, white: false, scale: -1 });
    expect(decodeTexMatrix(0)).toMatchObject({ disabled: false, white: false, scale: 1 });
    expect(decodeTexMatrix(65536)).toMatchObject({ disabled: false, white: false, scale: 0.5 });
  });
});

/* ------------------------------------------------------------ 组装层 */

/** 一块只有 3 个顶点的假瓦片；withTexZ 决定是否带 custom0 */
function fakeTile(withTexZ: boolean, values = [0, 0, 0]): ParsedTile {
  const attrs: unknown[] = [
    { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: f32([0, 0, 1, 0, 0, 1]) },
  ];
  if (withTexZ) {
    attrs.push({ semantic: 'custom0', byteOffset: 0, comp: 1, dtype: 'f32', data: f32(values) });
  }
  return {
    version: 3,
    compressedType: 0,
    options: 0,
    groupNode: {
      pageLods: [{ geodes: [{ matrix: null, skeletonNames: ['skel0'] }] }],
    },
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

describe('组装产物里的 aTexCoordZ', () => {
  test('没有 custom0：不产生该属性（旧数据的行为必须一字节不变）', () => {
    const { primitives } = assembleTileGeometry(fakeTile(false));
    expect(primitives).toHaveLength(1);
    expect(primitives[0]!.attributes.aTexCoordZ).toBeUndefined();
  });

  test('有 custom0：逐顶点搬到 aTexCoordZ', () => {
    const { primitives } = assembleTileGeometry(fakeTile(true, [-99999, 65536, 65793]));
    const attr = primitives[0]!.attributes.aTexCoordZ;
    expect(attr).toBeDefined();
    expect(attr!.components).toBe(1);
    expect(Array.from(attr!.array as Float32Array)).toEqual([-99999, 65536, 65793]);
  });

  test('合批后仍然保留（同材质多骨架合并成一块几何）', () => {
    const tile = fakeTile(true, [-99999, 65536, 65793]);
    // 复制一份骨架，让两个 geode 命中同材质、触发合并
    // 浅拷贝即可：data 是 Uint8Array，JSON 往返会把 typed array 变成普通对象
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

    const { primitives, stats } = assembleTileGeometry(tile);
    expect(stats.originalMeshes).toBe(2);
    expect(primitives).toHaveLength(1);
    const attr = primitives[0]!.attributes.aTexCoordZ!;
    expect(attr.array.length).toBe(6);
    expect(Array.from(attr.array as Float32Array)).toEqual([-99999, 65536, 65793, -99999, 65536, 65793]);
  });
});

/* ------------------------------------------------------------ 材质注入 */

/**
 * `AGENTS.md` §3 第 4 条：涉及 shader 注入的，**必须断言 three 的模板里确实存在
 * 被 `replace` 的那个 include 名**。`replace('#include <xxx>')` 在 three 改名后
 * 会静默 no-op —— 材质照样渲染，只是这一整套 uv 语义静默失效，谁也不会发现。
 *
 * 上面那组测试只钉住了数学和属性搬运，管不到这里。
 */
describe('texCoordZ 的片元注入', () => {
  const build = (texCoordZ: boolean) => {
    const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const mat = createStyledMaterial({ map, texCoordZ } as never);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    (mat as unknown as { onBeforeCompile: (s: unknown, r: unknown) => void }).onBeforeCompile(shader, null);
    return {
      shader,
      mat: mat as unknown as { defines: Record<string, string>; customProgramCacheKey: () => string },
    };
  };

  test('three 模板里确实有 #include <map_fragment>（replace 的前提）', () => {
    expect(THREE.ShaderLib.physical.fragmentShader).toContain('#include <map_fragment>');
  });

  test('texCoordZ: true → 注入采样函数、include 被吃掉、宏与缓存键都隔离', () => {
    const { shader, mat } = build(true);
    expect(mat.defines.S3M_TEXCOORD_Z).toBe('');
    // 函数定义（FRAG_PARS）和调用点（map_fragment 位置）都得在，缺一个就是编译失败
    expect(shader.fragmentShader).toContain('vec4 s3mTexCoordZUnit');
    expect(shader.fragmentShader).toContain('s3mTexCoordZUnit( vMapUv, vTexMatrix, map, uAtlasDim.x )');
    // 注入成功 = 原来的 include 不再存在；仍是 include 说明 replace 静默 no-op 了
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    // 顶点侧必须真的把 z 解成 varying（片元拿不到就是恒 0 = 公式档）
    expect(shader.vertexShader).toContain('#ifdef S3M_TEXCOORD_Z');
    expect(shader.vertexShader).toContain('vTexMatrix');
    expect(mat.customProgramCacheKey()).toContain('-texz');
  });

  test('texCoordZ: false → 不注入，include 原样保留（默认路径一字节不变）', () => {
    const { shader, mat } = build(false);
    expect(mat.defines.S3M_TEXCOORD_Z).toBeUndefined();
    expect(shader.fragmentShader).not.toContain('s3mTexCoordZUnit( vMapUv');
    expect(shader.fragmentShader).toContain('#include <map_fragment>');
    expect(mat.customProgramCacheKey()).not.toContain('-texz');
  });

  test('没有贴图时即使传了 texCoordZ 也不开宏（无意义的注入会让 program 白分裂一份）', () => {
    const mat = createStyledMaterial({ texCoordZ: true } as never);
    const defines = (mat as unknown as { defines: Record<string, string> }).defines;
    expect(defines?.S3M_TEXCOORD_Z).toBeUndefined();
  });
});
