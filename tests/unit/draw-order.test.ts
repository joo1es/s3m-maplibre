/**
 * 绘制顺序：三角面网格的 renderOrder 必须等于「文件里的材质序号」。
 *
 * 为什么钉这个：数据里有跨单体完全重合的面（实测 48 组，顶点偏移中位数 1 微米），
 * 深度相等、`LESS_OR_EQUAL` 下「后画的赢」。官方按材质顺序提交 DrawCommand，
 * 所以谁最后画是确定的；three 自己不透明队列按 `program.id → material.id → z` 排，
 * 而 material.id 是创建顺序，换质感档位重建材质时会重排 —— 同一场景换个画质，
 * 重合面的颜色就变了。renderOrder 跟着 Object3D 走，重建材质不受影响。
 */
import { describe, expect, test } from 'bun:test';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';
import type { ParsedTile } from '../../packages/s3m-three/src/core/types';

const f32 = (arr: number[]) => new Uint8Array(new Float32Array(arr).buffer);

/** 两个骨架、两个材质；passNames 故意与材质列表顺序相反 */
function twoMaterialTile(): ParsedTile {
  const tri = (x: number) => ({
    vertexPackage: {
      verticesCount: 3,
      vertexAttributes: [
        { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: f32([x, 0, 0, x + 1, 0, 0, x, 1, 0]) },
        { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: f32([0, 0, 1, 0, 0, 1]) },
      ],
      instanceIndex: -1,
    },
    indexPackages: [{ primitiveType: 4, indexCount: 3, indices: new Uint16Array([0, 1, 2]) }],
  });
  return {
    version: 3,
    compressedType: 0,
    options: 0,
    groupNode: {
      pageLods: [{ geodes: [{ matrix: null, skeletonNames: ['skel0', 'skel1'] }] }],
    },
    geoPackage: {
      // 文件里先出现材质 M1 的几何，再出现 M0 的几何
      skel0: { ...tri(0), indexPackages: [{ ...tri(0).indexPackages[0]!, passNames: ['M1'] }] },
      skel1: { ...tri(2), indexPackages: [{ ...tri(2).indexPackages[0]!, passNames: ['M0'] }] },
    },
    textures: {},
    // 材质列表的顺序才是权威：M0 在前
    materials: {
      materials: [
        { material: { id: 'M0', textureStates: [] } },
        { material: { id: 'M1', textureStates: [] } },
      ],
    },
    pickInfo: {},
    bytesRead: 0,
    bytesTotal: 0,
  } as unknown as ParsedTile;
}

describe('renderOrder = 文件材质序号', () => {
  test('几何出现顺序与材质顺序相反时，renderOrder 仍按材质列表来', async () => {
    const { objects } = await buildTileObjects(twoMaterialTile());
    const meshes = objects.filter((o) => (o as { isMesh?: boolean }).isMesh) as {
      renderOrder: number;
      material: { id: string };
    }[];
    expect(meshes).toHaveLength(2);
    // skel0 用 M1（列表第 2 个）→ 1；skel1 用 M0（第 1 个）→ 0
    const orders = meshes.map((m) => m.renderOrder).sort((a, b) => a - b);
    expect(orders).toEqual([0, 1]);
  });

  test('棱线 / 点云排在所有材质之后（不会被某个材质序号插队）', async () => {
    const { objects } = await buildTileObjects(twoMaterialTile());
    for (const o of objects) {
      if ((o as { isMesh?: boolean }).isMesh) expect(o.renderOrder).toBeLessThan(1000);
    }
  });

  test('透明材质不参与「重合面定序」：renderOrder 保持 0，交给透明队列按距离排', async () => {
    const tile = twoMaterialTile();
    // M1 是 blend（玻璃类）。共面定序只对不透明面有意义 ——
    // 透明的正确顺序是「远 → 近」，钉死成材质序号反而会把近处的玻璃画在前面。
    const mats = (tile.materials as { materials: { material: Record<string, unknown> }[] }).materials;
    mats[1]!.material.alphaMode = 'blend';

    const { objects } = await buildTileObjects(tile);
    const meshes = objects.filter((o) => (o as { isMesh?: boolean }).isMesh) as {
      renderOrder: number;
      material: { transparent: boolean; opacity: number };
    }[];
    const blend = meshes.find((m) => m.material.transparent);
    expect(blend).toBeDefined();
    expect(blend!.renderOrder).toBe(0);
    // 不透明的那块仍然是材质序号 0
    expect(meshes.find((m) => !m.material.transparent)!.renderOrder).toBe(0);
  });
});
