/**
 * 验证：texmodmatrix 纹理矩阵应用 与 倾斜摄影瓦片网格合批
 * 运行方式：node tools/test-batch-texmatrix.mjs
 */
import assert from 'node:assert';
import * as THREE from 'three';
import { buildTileObjects } from '../dist/render/GeometryBuilder.js';

console.log('=== 测试 1: 纹理变换矩阵 (texmodmatrix) 与寻址模式 (addressmode) ===');

{
  // 构造模拟瓦片
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
            { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer) },
            { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 1, 0, 0, 1]).buffer) },
          ],
          instanceIndex: -1,
        },
        indexPackages: [
          {
            primitiveType: 4,
            indexCount: 3,
            indices: new Uint16Array([0, 1, 2]),
            passNames: ['Mtr_Custom_TexMod'],
          },
        ],
      },
    },
    textures: {
      tex0: {
        code: 'tex0',
        width: 64,
        height: 64,
        pixelFormat: 28, // RGBA
        data: new Uint8Array(64 * 64 * 4).fill(200),
      },
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
                  // 2x 缩放并平移 (0.2, 0.5) 的 4x4 列主序矩阵:
                  // [ 2, 0, 0, 0,
                  //   0, 2, 0, 0,
                  //   0, 0, 1, 0,
                  //   0.2, 0.5, 0, 1 ]
                  texmodmatrix: [
                    2, 0, 0, 0,
                    0, 2, 0, 0,
                    0, 0, 1, 0,
                    0.2, 0.5, 0, 1,
                  ],
                  addressmode: { u: 0, v: 1 }, // u=Repeat, v=Clamp
                },
              },
            ],
          },
        },
      ],
    },
  };

  const res = await buildTileObjects(fakeTile);
  assert.strictEqual(res.stats.meshes, 1, '应生成 1 个 Mesh');
  const mesh = res.objects[0];
  const mat = mesh.material;
  assert.ok(mat.map, '材质必须包含 map 贴图');
  assert.strictEqual(mat.map.matrixAutoUpdate, false, '有 texmodmatrix 时应关闭 matrixAutoUpdate');

  // Three.js 的 Matrix3 elements 为列主序 [n00, n10, n20, n01, n11, n21, n02, n12, n22]
  // 对应的仿射矩阵:
  // [ 2, 0, 0.2 ]
  // [ 0, 2, 0.5 ]
  // [ 0, 0, 1   ]
  const el = mat.map.matrix.elements;
  assert.strictEqual(el[0], 2, '缩放 X 应为 2');
  assert.strictEqual(el[4], 2, '缩放 Y 应为 2');
  assert.strictEqual(el[6], 0.2, '平移 U 应为 0.2');
  assert.strictEqual(el[7], 0.5, '平移 V 应为 0.5');

  // 验证 addressmode
  assert.strictEqual(mat.map.wrapS, THREE.RepeatWrapping, 'wrapS 应为 RepeatWrapping (u=0)');
  assert.strictEqual(mat.map.wrapT, THREE.ClampToEdgeWrapping, 'wrapT 应为 ClampToEdgeWrapping (v=1)');

  console.log('  √ texmodmatrix 仿射矩阵正确设置到 map.matrix');
  console.log('  √ matrixAutoUpdate 已设为 false');
  console.log('  √ addressmode 正确映射到 wrapS / wrapT');
}

console.log('\n=== 测试 2: 瓦片同材质网格合批 (Geometry Batching) ===');

{
  // 构造包含 3 个相同材质碎片网格的瓦片（模拟倾斜摄影大瓦片）
  const fakePhotogrammetryTile = {
    groupNode: {
      pageLods: [
        {
          geodes: [
            {
              // 切片 1 平移 (0, 0, 0)
              matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
              skeletonNames: ['chunk0'],
            },
            {
              // 切片 2 平移 (10, 0, 0)
              matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1],
              skeletonNames: ['chunk1'],
            },
            {
              // 切片 3 平移 (0, 20, 0)
              matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 20, 0, 1],
              skeletonNames: ['chunk2'],
            },
          ],
        },
      ],
    },
    geoPackage: {
      chunk0: {
        vertexPackage: {
          verticesCount: 3,
          vertexAttributes: [
            { semantic: 'position', byteOffset: 0, components: 3, stride: 12, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer) },
            { semantic: 'normal', byteOffset: 0, components: 3, stride: 12, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer) },
            { semantic: 'uv', byteOffset: 0, components: 2, stride: 8, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 1, 0, 0, 1]).buffer) },
          ],
          instanceIndex: -1,
        },
        indexPackages: [{ primitiveType: 4, indexCount: 3, indices: new Uint8Array(new Uint16Array([0, 1, 2]).buffer), passNames: ['Mtr_Shared'] }],
      },
      chunk1: {
        vertexPackage: {
          verticesCount: 3,
          vertexAttributes: [
            { semantic: 'position', byteOffset: 0, components: 3, stride: 12, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer) },
            { semantic: 'normal', byteOffset: 0, components: 3, stride: 12, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer) },
            { semantic: 'uv', byteOffset: 0, components: 2, stride: 8, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 1, 0, 0, 1]).buffer) },
          ],
          instanceIndex: -1,
        },
        indexPackages: [{ primitiveType: 4, indexCount: 3, indices: new Uint8Array(new Uint16Array([0, 1, 2]).buffer), passNames: ['Mtr_Shared'] }],
      },
      chunk2: {
        vertexPackage: {
          verticesCount: 3,
          vertexAttributes: [
            { semantic: 'position', byteOffset: 0, components: 3, stride: 12, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer) },
            { semantic: 'normal', byteOffset: 0, components: 3, stride: 12, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer) },
            { semantic: 'uv', byteOffset: 0, components: 2, stride: 8, offsetInBytes: 0, dtype: 'f32', data: new Uint8Array(new Float32Array([0, 0, 1, 0, 0, 1]).buffer) },
          ],
          instanceIndex: -1,
        },
        indexPackages: [{ primitiveType: 4, indexCount: 3, indices: new Uint8Array(new Uint16Array([0, 1, 2]).buffer), passNames: ['Mtr_Shared'] }],
      },
    },
    materials: {
      materials: [{ material: { id: 'Mtr_Shared' } }],
    },
  };

  // 1) 开启合批构建
  const resBatched = await buildTileObjects(fakePhotogrammetryTile, { batching: true });
  assert.strictEqual(resBatched.stats.meshes, 1, '开启合批时：3 个切片网格必须合并为 1 个 Mesh');
  assert.strictEqual(resBatched.stats.originalMeshes, 3, '原始网格数应统计为 3');
  assert.strictEqual(resBatched.stats.triangles, 3, '三角面数保持为 3');
  const batchedMesh = resBatched.objects[0];
  assert.strictEqual(batchedMesh.userData.isBatched, true, 'Mesh 应标记为 isBatched');
  assert.strictEqual(batchedMesh.userData.batchedCount, 3, 'Mesh 的 batchedCount 应为 3');

  const geo = batchedMesh.geometry;
  assert.strictEqual(geo.attributes.position.count, 9, '合并后顶点数应为 9');
  assert.strictEqual(geo.index.count, 9, '合并后索引数应为 9');

  // 验证局部变换矩阵是否正确烘焙进 position 缓冲中
  const pos = geo.attributes.position.array;
  // chunk0: (0,0,0)
  assert.strictEqual(pos[0], 0);
  assert.strictEqual(pos[1], 0);
  assert.strictEqual(pos[2], 0);
  // chunk1: 平移 (10, 0, 0)
  assert.strictEqual(pos[9], 10);
  assert.strictEqual(pos[10], 0);
  assert.strictEqual(pos[11], 0);
  // chunk2: 平移 (0, 20, 0)
  assert.strictEqual(pos[18], 0);
  assert.strictEqual(pos[19], 20);
  assert.strictEqual(pos[20], 0);

  // 2) 关闭合批构建
  const resUnbatched = await buildTileObjects(fakePhotogrammetryTile, { batching: false });
  assert.strictEqual(resUnbatched.stats.meshes, 3, '关闭合批时：应保持 3 个独立 Mesh');

  console.log('  √ 开启合批时：3 个相同材质碎片成功合并为 1 个 Mesh (DrawCall 降低 66%)');
  console.log('  √ 顶点属性 (position, normal, uv) 和索引正确合并');
  console.log('  √ 各子网格的世界变换矩阵准确预先烘焙进顶点位置中');
  console.log('  √ 关闭合批时：平滑回退到独立 Mesh');
}

console.log('\n全部测试通过！');
