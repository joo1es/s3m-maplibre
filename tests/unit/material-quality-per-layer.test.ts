/**
 * 单元测试：materialQuality 从「模块级全局」改为「图层级」
 *
 * 动机：0.4.21 起 `materialQuality` 是 s3m-three 的模块级全局开关 —— 同页多个图层
 * 会互相覆盖，最后创建的那个决定全局，且只影响之后创建的材质。于是
 * 「这一层 pbr、那一层 lambert」做不到，A 层加载到一半会被 B 层的构造打回 pbr。
 *
 * 目标语义（默认行为逐字不变）：
 *   1. `new S3MViewer({ materialQuality })` 只定这一层的档位，**不写模块级全局**；
 *   2. 不传 `materialQuality` 的图层继续跟随模块级默认（`setMaterialQuality` 的老用法有效）；
 *   3. `viewer.setMaterialQuality()` 只重建本层材质，别层不受影响；
 *   4. 档位经 viewer → DatasetManager → S3MTileset → buildTileObjects → createStyledMaterial
 *      一路透传，新瓦片材质与图层档位一致。
 *
 * 不依赖 WebGL：makeViewer + registerMesh 的既有模式。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';
import {
  createStyledMaterial,
  getMaterialQuality,
  setMaterialQuality,
} from '../../packages/s3m-three/src/render/StyleMaterial';
import type { ParsedTile } from '../../packages/s3m-three/src/core/types';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';

afterEach(() => {
  // 模块级默认是进程级状态，用例之间必须还原，否则后面的文件会读到脏值
  setMaterialQuality('pbr');
});

function makeViewer(opts: Record<string, unknown> = {}): S3MViewer {
  return new S3MViewer({
    canvas: null as never,
    container: null as never,
    ...opts,
  } as ConstructorParameters<typeof S3MViewer>[0]);
}

function registerMesh(viewer: S3MViewer, smid: number): THREE.Mesh {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(10, 10, 10);
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: viewer.uniforms, materialQuality: viewer.materialQuality }));
  mesh.userData = { geoRef: { pickInfo: { [smid]: { batchId: 0 } } } };
  group.add(mesh);
  (viewer as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
    { group, tile: null },
    { id: 'd', root: new THREE.Group() }
  );
  return mesh;
}

/* ------------------------------------------------------- 材质工厂的显式档位 */

describe('createStyledMaterial 的显式 materialQuality', () => {
  test('显式 lambert 优先于模块级默认（默认是 pbr）', () => {
    const m = createStyledMaterial({ materialQuality: 'lambert' });
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
  });

  test('显式 pbr 优先于模块级默认（默认是 lambert）', () => {
    setMaterialQuality('lambert');
    const m = createStyledMaterial({ materialQuality: 'pbr' });
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
  });

  test('不传时仍跟随模块级默认（旧行为不变）', () => {
    expect(createStyledMaterial({})).toBeInstanceOf(THREE.MeshStandardMaterial);
    setMaterialQuality('lambert');
    expect(createStyledMaterial({})).toBeInstanceOf(THREE.MeshLambertMaterial);
  });

  test('材质记下自己的档位，便于重建时不必猜', () => {
    const m = createStyledMaterial({ materialQuality: 'lambert' });
    expect((m.userData as { s3mQuality?: string }).s3mQuality).toBe('lambert');
  });
});

/* --------------------------------------------------------- 瓦片构建的透传 */

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

describe('buildTileObjects 的 materialQuality 透传', () => {
  test('显式 lambert：瓦片三角面材质走 Lambert', async () => {
    const { objects } = await buildTileObjects(oneTriangleTile(), { materialQuality: 'lambert' });
    let checked = 0;
    for (const o of objects) {
      if (!(o as { isMesh?: boolean }).isMesh) continue;
      expect((o as { material: THREE.Material }).material).toBeInstanceOf(THREE.MeshLambertMaterial);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('不传：仍按模块级默认（默认 pbr）', async () => {
    const { objects } = await buildTileObjects(oneTriangleTile());
    let checked = 0;
    for (const o of objects) {
      if (!(o as { isMesh?: boolean }).isMesh) continue;
      expect((o as { material: THREE.Material }).material).toBeInstanceOf(THREE.MeshStandardMaterial);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------ 图层级隔离 */

describe('图层级 materialQuality 隔离', () => {
  test('两个图层各持自己的档位，后创建的不覆盖先创建的', () => {
    const a = makeViewer({ materialQuality: 'lambert' });
    const b = makeViewer();
    expect(a.materialQuality).toBe('lambert');
    expect(b.materialQuality).toBe('pbr');
    expect(a.materialQuality).toBe('lambert'); // b 构造后 a 不变
    a.dispose();
    b.dispose();
  });

  test('同页 pbr 层与 lambert 层的新材质互不干扰', () => {
    const a = makeViewer({ materialQuality: 'lambert' });
    const ma = registerMesh(a, 920);
    const b = makeViewer({ materialQuality: 'pbr' });
    const mb = registerMesh(b, 921);
    expect(ma.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mb.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    a.dispose();
    b.dispose();
  });

  test('构造图层不写模块级全局', () => {
    setMaterialQuality('pbr');
    const a = makeViewer({ materialQuality: 'lambert' });
    expect(getMaterialQuality()).toBe('pbr');
    a.dispose();
  });

  test('setMaterialQuality 只重建本层材质', () => {
    const a = makeViewer({ materialQuality: 'pbr' });
    const b = makeViewer({ materialQuality: 'pbr' });
    const ma = registerMesh(a, 922);
    const mb = registerMesh(b, 923);
    a.setMaterialQuality('lambert');
    expect(a.materialQuality).toBe('lambert');
    expect(b.materialQuality).toBe('pbr');
    expect(ma.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mb.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    a.dispose();
    b.dispose();
  });

  test('不传 materialQuality 的图层继续跟随模块级默认（老用法仍然有效）', () => {
    const v = makeViewer();
    setMaterialQuality('lambert');
    expect(v.materialQuality).toBe('lambert');
    expect(registerMesh(v, 924).material).toBeInstanceOf(THREE.MeshLambertMaterial);
    v.dispose();
  });

  test('重建时按本层档位，不被中途改掉的模块级默认带跑', () => {
    const v = makeViewer({ materialQuality: 'lambert' });
    const mesh = registerMesh(v, 925);
    setMaterialQuality('pbr'); // 别处（老代码）动了全局
    v.setMaterialQuality('lambert');
    expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    v.dispose();
  });

  test('非法档位归一为 pbr，不抛错', () => {
    setMaterialQuality('pbr'); // 钉住模块级默认，避免依赖用例顺序
    const v = makeViewer({ materialQuality: 'nope' as never });
    expect(v.materialQuality).toBe('pbr');
    v.dispose();
  });
});

/* ------------------------------------------------- S3MLayer（用户真正用的门面） */

describe('S3MLayer 层的隔离', () => {
  test('两个 S3MLayer 各持档位，构造顺序不影响对方', () => {
    const a = new S3MLayer({ id: 'a', materialQuality: 'lambert' });
    const b = new S3MLayer({ id: 'b' });
    expect(a.materialQuality).toBe('lambert');
    expect(b.materialQuality).toBe('pbr');
    expect(a.materialQuality).toBe('lambert');
    a.dispose?.();
    b.dispose?.();
  });

  test('a.setMaterialQuality 不影响 b', () => {
    const a = new S3MLayer({ id: 'a' });
    const b = new S3MLayer({ id: 'b' });
    a.setMaterialQuality('lambert');
    expect(a.materialQuality).toBe('lambert');
    expect(b.materialQuality).toBe('pbr');
    a.dispose?.();
    b.dispose?.();
  });
});

/* -------------------------------------------------- 图层 → 数据集的透传 */
describe('图层档位透传给数据集', () => {
  test('图层档位成为数据集管理器的默认值（新数据集据此建材质）', async () => {
    const v = makeViewer({ materialQuality: 'lambert' });
    v.scene = new THREE.Scene();
    let seen: string | undefined = 'unset';
    const dm = (v as unknown as {
      _datasetManager: { addDataset: (...args: unknown[]) => Promise<unknown>; defaultMaterialQuality?: string };
    })._datasetManager;
    dm.addDataset = async () => {
      seen = dm.defaultMaterialQuality;
      return { id: 'x', root: new THREE.Group(), options: {}, tileset: null, visible: true, error: null };
    };
    await v.addDataset({ id: 'x', configUrl: 'x.scp' });
    expect(seen).toBe('lambert');
    v.dispose();
  });

  test('数据集自己指定档位时原样保留（优先于图层）', async () => {
    const v = makeViewer({ materialQuality: 'pbr' });
    v.scene = new THREE.Scene();
    let seen: { materialQuality?: string } | null = null;
    const dm = (v as unknown as { _datasetManager: { addDataset: (...args: unknown[]) => Promise<unknown> } })
      ._datasetManager;
    dm.addDataset = async (...args: unknown[]) => {
      seen = args[0] as { materialQuality?: string };
      return { id: 'x', root: new THREE.Group(), options: {}, tileset: null, visible: true, error: null };
    };
    await v.addDataset({ id: 'x', configUrl: 'x.scp', materialQuality: 'lambert' });
    expect(seen?.materialQuality).toBe('lambert');
    v.dispose();
  });

  test('setMaterialQuality 会把档位推给已存在的数据集（之后的新瓦片才一致）', () => {
    const v = makeViewer({ materialQuality: 'pbr' });
    const dm = (v as unknown as {
      _datasetManager: {
        datasets: Map<string, unknown>;
        registerDataset: (o: unknown) => { tileset: unknown };
        defaultMaterialQuality?: string;
      };
    })._datasetManager;
    const seen: (string | undefined)[] = [];
    const entry = dm.registerDataset({ id: 'a', configUrl: 'a.scp' }) as { tileset: unknown };
    entry.tileset = { setMaterialQuality: (q: string | undefined) => seen.push(q), dispose: () => {} };
    v.setMaterialQuality('lambert');
    expect(seen).toEqual(['lambert']);
    expect(dm.defaultMaterialQuality).toBe('lambert');
    v.dispose();
  });

  test('数据集显式指定过档位的，不被图层 setMaterialQuality 覆盖', () => {
    const v = makeViewer({ materialQuality: 'pbr' });
    const dm = (v as unknown as {
      _datasetManager: {
        registerDataset: (o: unknown) => { tileset: unknown };
      };
    })._datasetManager;
    const seen: (string | undefined)[] = [];
    const entry = dm.registerDataset({ id: 'b', configUrl: 'b.scp', materialQuality: 'lambert' }) as {
      tileset: unknown;
    };
    entry.tileset = { setMaterialQuality: (q: string | undefined) => seen.push(q), dispose: () => {} };
    v.setMaterialQuality('pbr');
    expect(seen).toEqual([]);
    v.dispose();
  });
});
