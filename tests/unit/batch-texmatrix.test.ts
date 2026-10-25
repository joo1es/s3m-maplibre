/**
 * 几何构建单测：texmodmatrix 纹理矩阵 / addressmode / 倾斜摄影瓦片合批
 *
 * 这两条链路错了不会立刻崩，只会「贴图位置整体偏移」或「DrawCall 暴涨」，
 * 所以按数值逐项钉住，不靠肉眼看图。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';

const f32 = (arr: number[]) => new Uint8Array(new Float32Array(arr).buffer);

describe('纹理变换矩阵（texmodmatrix）与寻址模式（addressmode）', () => {
  const fakeTile = {
    groupNode: {
      pageLods: [
        {
          geodes: [
            {
              matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
              skeletonNames: ['skel0'],
            },
          ],
        },
      ],
    },
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
        indexPackages: [
          { primitiveType: 4, indexCount: 3, indices: new Uint16Array([0, 1, 2]), passNames: ['Mtr_Custom_TexMod'] },
        ],
      },
    },
    textures: {
      tex0: { code: 'tex0', width: 64, height: 64, pixelFormat: 28, data: new Uint8Array(64 * 64 * 4).fill(200) },
    },
    materials: {
      materials: [
        {
          material: {
            id: 'Mtr_Custom_TexMod',
            textureStates: [
              {
                textureunitstate: {
                  id: 'tex0',
                  // 2x 缩放并平移 (0.2, 0.5) 的 4x4 列主序矩阵：
                  // [ 2, 0, 0, 0 / 0, 2, 0, 0 / 0, 0, 1, 0 / 0.2, 0.5, 0, 1 ]
                  texmodmatrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0.2, 0.5, 0, 1],
                  addressmode: { u: 0, v: 1 }, // u=Repeat, v=Clamp
                },
              },
            ],
          },
        },
      ],
    },
  };

  const build = async () => {
    const res = await buildTileObjects(fakeTile);
    expect(res.stats.meshes).toBe(1);
    return res.objects[0].material;
  };

  test('texmodmatrix 写成 map.matrix（列主序，缩放 2 / 平移 0.2,0.5）', async () => {
    const mat = await build();
    expect(mat.map).toBeTruthy();
    // elements：列主序 [n00, n10, n20, n01, n11, n21, n02, n12, n22]
    // 对应仿射 [ 2,0,0.2 / 0,2,0.5 / 0,0,1 ]
    const el = mat.map.matrix.elements;
    expect(el[0]).toBe(2);
    expect(el[4]).toBe(2);
    expect(el[6]).toBe(0.2);
    expect(el[7]).toBe(0.5);
  });

  test('有 texmodmatrix 时关闭 matrixAutoUpdate（否则每帧被重算覆盖）', async () => {
    const mat = await build();
    expect(mat.map.matrixAutoUpdate).toBe(false);
  });

  test('addressmode 映射到 wrapS / wrapT', async () => {
    const mat = await build();
    expect(mat.map.wrapS).toBe(THREE.RepeatWrapping); // u=0
    expect(mat.map.wrapT).toBe(THREE.ClampToEdgeWrapping); // v=1
  });
});

describe('瓦片同材质网格合批（Geometry Batching）', () => {
  const chunk = () => ({
    vertexPackage: {
      verticesCount: 3,
      vertexAttributes: [
        {
          semantic: 'position',
          byteOffset: 0,
          components: 3,
          stride: 12,
          offsetInBytes: 0,
          dtype: 'f32',
          data: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        },
        {
          semantic: 'normal',
          byteOffset: 0,
          components: 3,
          stride: 12,
          offsetInBytes: 0,
          dtype: 'f32',
          data: f32([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        },
        {
          semantic: 'uv',
          byteOffset: 0,
          components: 2,
          stride: 8,
          offsetInBytes: 0,
          dtype: 'f32',
          data: f32([0, 0, 1, 0, 0, 1]),
        },
      ],
      instanceIndex: -1,
    },
    indexPackages: [
      {
        primitiveType: 4,
        indexCount: 3,
        indices: new Uint8Array(new Uint16Array([0, 1, 2]).buffer),
        passNames: ['Mtr_Shared'],
      },
    ],
  });

  // 模拟倾斜摄影大瓦片：3 个同材质碎片，各自带局部平移
  const fakePhotogrammetryTile = {
    groupNode: {
      pageLods: [
        {
          geodes: [
            { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], skeletonNames: ['chunk0'] },
            { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1], skeletonNames: ['chunk1'] },
            { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 20, 0, 1], skeletonNames: ['chunk2'] },
          ],
        },
      ],
    },
    geoPackage: { chunk0: chunk(), chunk1: chunk(), chunk2: chunk() },
    materials: { materials: [{ material: { id: 'Mtr_Shared' } }] },
  };

  test('开启合批：3 个碎片合并成 1 个 Mesh，DrawCall 降低 66%', async () => {
    const res = await buildTileObjects(fakePhotogrammetryTile, { batching: true });
    expect(res.stats.meshes).toBe(1);
    expect(res.stats.originalMeshes).toBe(3);
    expect(res.stats.triangles).toBe(3);

    const mesh = res.objects[0];
    expect(mesh.userData.isBatched).toBe(true);
    expect(mesh.userData.batchedCount).toBe(3);
    expect(mesh.geometry.attributes.position.count).toBe(9);
    expect(mesh.geometry.index!.count).toBe(9);
  });

  test('各子网格的局部变换被烘焙进顶点位置', async () => {
    const res = await buildTileObjects(fakePhotogrammetryTile, { batching: true });
    const pos = res.objects[0].geometry.attributes.position.array;
    // chunk0: (0,0,0)
    expect([pos[0], pos[1], pos[2]]).toEqual([0, 0, 0]);
    // chunk1: 平移 (10,0,0)
    expect([pos[9], pos[10], pos[11]]).toEqual([10, 0, 0]);
    // chunk2: 平移 (0,20,0)
    expect([pos[18], pos[19], pos[20]]).toEqual([0, 20, 0]);
  });

  test('关闭合批：平滑回退到 3 个独立 Mesh', async () => {
    const res = await buildTileObjects(fakePhotogrammetryTile, { batching: false });
    expect(res.stats.meshes).toBe(3);
  });
});
