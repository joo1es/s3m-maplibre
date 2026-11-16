/**
 * 数据集级样式与绘制顺序（issue #54）
 *
 * 为什么需要：`S3MDatasetOptions` 能控制容量和摆放，但外观只有图层维度（`setStyle`
 * 没有 datasetId）、层叠只有图层维度（`map.addLayer` 顺序）。只要几个数据集要不同
 * 样式或确定的遮挡关系，接入方就只能「一个数据集建一个 S3MLayer」，于是每个数据集
 * 各拖一个 S3MViewer + WebGLRenderer。
 *
 * 两条目标语义（默认行为逐字不变）：
 *   1. `style` 是 patch 合并：数据集写过的键优先，没写的继续跟随图层 `setStyle`；
 *   2. `renderOrder` 只在数据集之间比较，瓦片级的 `100 + depth` 相对关系不变。
 *
 * 不依赖 WebGL：沿用 `_registerTile` / mock tileset 的既有测试模式。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { DATASET_ORDER_STRIDE } from '../../packages/s3m-three/src/tileset/TileVisibility';
import { createDatasetUniforms } from '../../packages/s3m-three/src/render/DatasetStyle';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';

function makeViewer(opts: Record<string, unknown> = {}): S3MViewer {
  return new S3MViewer({
    canvas: null as never,
    container: null as never,
    ...opts,
  } as ConstructorParameters<typeof S3MViewer>[0]);
}

function registerMesh(viewer: S3MViewer, smid: number, entry: unknown): THREE.Mesh {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(10, 10, 10);
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: viewer.uniforms }));
  mesh.userData = { geoRef: { pickInfo: { [smid]: { batchId: 0 } } } };
  group.add(mesh);
  (viewer as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
    { group, tile: null },
    entry
  );
  return mesh;
}

/* ------------------------------------------------------- ① uniform 分裂 */

describe('createDatasetUniforms：只分裂被覆盖的键', () => {
  test('覆盖的键是新对象，未覆盖的键仍是同一引用', () => {
    const v = makeViewer();
    const base = v.uniforms;
    const ds = createDatasetUniforms(base, { colorA: '#8fa3b8' });

    expect(ds).not.toBe(base);
    expect(ds.uColorA).not.toBe(base.uColorA);
    expect(ds.uColorA.value.getHexString()).toBe('8fa3b8');
    // 没覆盖的颜色继续共享：图层改它，数据集自动跟着变，零同步代码
    expect(ds.uColorB).toBe(base.uColorB);
    expect(ds.uColorC).toBe(base.uColorC);
    v.dispose();
  });

  test('交互类 uniform 永远共享（不引入逐帧镜像）', () => {
    const v = makeViewer();
    const base = v.uniforms;
    const ds = createDatasetUniforms(base, { colorA: '#ffffff', opacity: 0.5 });

    for (const key of ['uSelMix', 'uSelColor', 'uDim', 'uTime', 'uBatchMix'] as const) {
      expect(ds[key]).toBe(base[key]);
    }
    v.dispose();
  });

  test('数值键原样写入，不经过颜色转换', () => {
    const v = makeViewer();
    const base = v.uniforms;
    const ds = createDatasetUniforms(base, {
      mode: 2,
      opacity: 0.55,
      floorHeight: 4.2,
      metalness: 0.1,
      roughness: 0.8,
    });

    expect(ds.uMode.value).toBe(2);
    expect(ds.uOpacity?.value).toBe(0.55);
    expect(ds.uFloorHeight.value).toBe(4.2);
    expect(ds.uMetalness?.value).toBe(0.1);
    expect(ds.uRoughness?.value).toBe(0.8);
    v.dispose();
  });

  test('不支持的键（edges / 选中态）不会被当成 uniform 写进去', () => {
    const v = makeViewer();
    const base = v.uniforms;
    const ds = createDatasetUniforms(base, { edges: true, selectColor: '#ff0000' });

    // 只应多出一个「同一份引用」的空壳对象，不许动 uSelColor
    expect(ds.uSelColor).toBe(base.uSelColor);
    expect(Object.keys(ds).sort()).toEqual(Object.keys(base).sort());
    v.dispose();
  });

  test('空 patch 与原 uniform 等价（同一引用即可）', () => {
    const v = makeViewer();
    const base = v.uniforms;
    const ds = createDatasetUniforms(base, {});
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      expect(ds[key]).toBe(base[key]);
    }
    v.dispose();
  });
});

/* ------------------------------------------- ①b 材质真的读上了那份 uniform */

describe('瓦片材质与数据集 uniform 的绑定', () => {
  /** 一个三角面的最小瓦片 */
  function oneTriangleTile() {
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
    } as never;
  }

  test('材质绑定的是数据集那份 uniform：覆盖项独立、未覆盖项共享', async () => {
    const v = makeViewer();
    const dsUniforms = createDatasetUniforms(v.uniforms, { colorA: '#8fa3b8', opacity: 0.55 });
    const { objects } = await buildTileObjects(oneTriangleTile(), { uniforms: dsUniforms });

    const mesh = objects.find((o) => (o as { isMesh?: boolean }).isMesh) as THREE.Mesh;
    // createStyledMaterial 在 onBeforeCompile 里 `Object.assign(shader.uniforms, uniforms)`，
    // 所以跑一遍就能看到材质真正绑定的 uniform 对象（userData 里只有逐材质的那几个）
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '', fragmentShader: '' };
    (mesh.material as unknown as { onBeforeCompile: (s: unknown, r: unknown) => void }).onBeforeCompile(
      shader,
      null
    );

    expect(shader.uniforms.uColorA).toBe(dsUniforms.uColorA);
    expect(shader.uniforms.uOpacity).toBe(dsUniforms.uOpacity);
    // 没覆盖的键仍指向图层那份：图层改它，数据集自动跟着变
    expect(shader.uniforms.uColorB).toBe(v.uniforms.uColorB);
    v.dispose();
  });
});

/* ------------------------------------------------ ② 图层 → 数据集的透传 */
describe('S3MViewer.addDataset 的 uniforms 透传', () => {
  function stubManager(v: S3MViewer): { seen: unknown[] } {
    const box: { seen: unknown[] } = { seen: [] };
    const dm = (v as unknown as { _datasetManager: { addDataset: (...a: unknown[]) => Promise<unknown> } })
      ._datasetManager;
    dm.addDataset = async (...args: unknown[]) => {
      box.seen = args;
      return { id: 'x', root: new THREE.Group(), options: {}, tileset: null, visible: true, error: null };
    };
    return box;
  }

  test('不传 style：直接用图层那份 uniforms（与改动前一致）', async () => {
    const v = makeViewer();
    v.scene = new THREE.Scene();
    const box = stubManager(v);
    await v.addDataset({ id: 'x', configUrl: 'x.scp' });
    expect(box.seen[3]).toBe(v.uniforms);
    v.dispose();
  });

  test('传 style：换成数据集自己那份', async () => {
    const v = makeViewer();
    v.scene = new THREE.Scene();
    const box = stubManager(v);
    await v.addDataset({ id: 'x', configUrl: 'x.scp', style: { colorA: '#8fa3b8' } });
    const passed = box.seen[3] as typeof v.uniforms;
    expect(passed).not.toBe(v.uniforms);
    expect(passed.uColorA.value.getHexString()).toBe('8fa3b8');
    expect(passed.uColorB).toBe(v.uniforms.uColorB);
    v.dispose();
  });

  test('renderOrder 透传到 tileset（默认 0）', async () => {
    const v = makeViewer();
    v.scene = new THREE.Scene();
    const dm = (v as unknown as { _datasetManager: { addDataset: (...a: unknown[]) => Promise<unknown> } })
      ._datasetManager;
    const seen: unknown[] = [];
    dm.addDataset = async (ds: unknown) => {
      seen.push(ds);
      return { id: 'x', root: new THREE.Group(), options: {}, tileset: null, visible: true, error: null };
    };
    await v.addDataset({ id: 'a', configUrl: 'a.scp' });
    await v.addDataset({ id: 'b', configUrl: 'b.scp', renderOrder: 2 });
    expect((seen[0] as { renderOrder?: number }).renderOrder).toBeUndefined();
    expect((seen[1] as { renderOrder?: number }).renderOrder).toBe(2);
    v.dispose();
  });
});

/* ------------------------------------------------- ③ 注册时的混合开关 */

describe('数据集 opacity 与混合开关', () => {
  function entryWithStyle(style?: Record<string, unknown>) {
    return { id: 'd', root: new THREE.Group(), options: style ? { style } : {} };
  }

  test('数据集半透明：新瓦片材质进透明队列', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 930, entryWithStyle({ opacity: 0.55 }));
    expect(mesh.material.transparent).toBe(true);
    expect((mesh.material.userData as { s3mDatasetOpacity?: number }).s3mDatasetOpacity).toBe(0.55);
    v.dispose();
  });

  test('图层改透明度不会把数据集材质踩回不透明', () => {
    const v = makeViewer();
    const dsMesh = registerMesh(v, 931, entryWithStyle({ opacity: 0.55 }));
    const plainMesh = registerMesh(v, 932, entryWithStyle());

    v.setStyle({ opacity: 0.5 });
    v.setStyle({ opacity: 1 });

    expect(dsMesh.material.transparent).toBe(true);
    // 没有任何数据集样式的瓦片照旧跟随图层
    expect(plainMesh.material.transparent).toBe(false);
    v.dispose();
  });

  test('数据集 shading 覆盖到新瓦片的共享 uniform', () => {
    const v = makeViewer({ style: { shading: 'smooth' } });
    const mesh = registerMesh(v, 933, entryWithStyle({ shading: 'flat' }));
    const u = (mesh.material.userData as { uFlatShading?: { value: number } }).uFlatShading;
    expect(u?.value).toBe(1); // flat = 1
    v.dispose();
  });

  test('数据集没写 opacity 时，材质记录里不出现覆盖标记', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 934, entryWithStyle({ colorA: '#ffffff' }));
    expect((mesh.material.userData as { s3mDatasetOpacity?: number }).s3mDatasetOpacity).toBeUndefined();
    v.dispose();
  });

  test('图层切 shading 不会覆盖数据集自己的 shading', () => {
    const v = makeViewer({ style: { shading: 'smooth' } });
    const mesh = registerMesh(v, 935, entryWithStyle({ shading: 'flat' }));
    const u = (mesh.material.userData as { uFlatShading?: { value: number } }).uFlatShading;
    expect(u?.value).toBe(1);

    v.setStyle({ shading: 'smooth' });
    expect(u?.value).toBe(1); // 数据集写过，图层动不了
    v.dispose();
  });

  test('切光照档位重建材质后，数据集 uniform / 混合 / shading 都不丢', () => {
    const v = makeViewer();
    const dsUniforms = createDatasetUniforms(v.uniforms, {
      colorA: '#8fa3b8',
      opacity: 0.55,
      shading: 'flat',
    });
    const style = { colorA: '#8fa3b8', opacity: 0.55, shading: 'flat' as const };
    const entry = {
      id: 'd',
      root: new THREE.Group(),
      options: { style },
      uniforms: dsUniforms,
      tileset: null,
      visible: true,
      error: null,
    };
    (v as unknown as { _datasetManager: { datasets: Map<string, unknown> } })._datasetManager.datasets.set(
      'd',
      entry
    );
    const mesh = registerMesh(v, 936, entry);

    v.setMaterialQuality('lambert');

    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '', fragmentShader: '' };
    (mesh.material as unknown as { onBeforeCompile: (s: unknown, r: unknown) => void }).onBeforeCompile(
      shader,
      null
    );
    // 重建后仍然绑数据集那份，而不是回落到图层级
    expect(shader.uniforms.uColorA).toBe(dsUniforms.uColorA);
    expect(mesh.material.transparent).toBe(true);
    expect((mesh.material.userData as { uFlatShading?: { value: number } }).uFlatShading?.value).toBe(1);
    v.dispose();
  });
});

/* ------------------------------------------------------ ④ 绘制顺序平移 */

describe('renderOrder：整组平移，瓦片级相对关系不变', () => {
  /** 根瓦片 + 一个有就绪子瓦的节点：根会被推成 fallback、子瓦进 primary */
  function makeTileset(renderOrder?: number, lodTransition: 'binary' | 'incremental' = 'incremental') {
    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', renderOrder, lodTransition });
    const rootGroup = new THREE.Group();
    const childGroup = new THREE.Group();
    const rootUrl = 'http://example.com/root.s3mb';
    const childUrl = 'http://example.com/child.s3mb';
    ts.nodes.set(rootUrl, {
      url: rootUrl,
      childUrls: [childUrl, 'http://example.com/missing.s3mb'],
      rangeMode: 0,
      rangeValue: 500,
      sphere: { center: { x: 0, y: 100, z: 0 }, radius: 50 },
      group: rootGroup,
      state: 'ready' as const,
      stats: { meshes: 1, vertices: 10, triangles: 5, memory: 100 },
    } as never);
    ts.nodes.set(childUrl, {
      url: childUrl,
      childUrls: [],
      rangeMode: 0,
      rangeValue: 500,
      sphere: { center: { x: 0, y: 100, z: 0 }, radius: 50 },
      group: childGroup,
      state: 'ready' as const,
      stats: { meshes: 1, vertices: 10, triangles: 5, memory: 100 },
    } as never);
    ts.rootUrls = [rootUrl];
    return { ts, rootGroup, childGroup };
  }

  test('binary（默认）：整组共用一个基值，默认 0 与改动前一致', () => {
    const expectAllVisible = (d: ReturnType<typeof makeTileset>, order: number) => {
      d.ts.update([0, 0, 0], Math.PI / 4, 800);
      const groups = [d.rootGroup, d.childGroup].filter((g) => g.visible);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) expect(g.renderOrder).toBe(order);
    };

    const d = makeTileset(undefined, 'binary');
    expect(d.ts.renderOrder).toBe(0);
    expectAllVisible(d, 0);

    const o = makeTileset(2, 'binary');
    expect(o.ts.renderOrder).toBe(2);
    expectAllVisible(o, 2 * DATASET_ORDER_STRIDE);
  });

  test('incremental：与改动前一致（primary 100 + depth，fallback depth）', () => {
    const { ts, rootGroup, childGroup } = makeTileset();
    expect(ts.renderOrder).toBe(0);
    ts.update([0, 0, 0], Math.PI / 4, 800);
    expect(childGroup.renderOrder).toBe(101);
    expect(rootGroup.renderOrder).toBe(0);
  });

  test('incremental：renderOrder 平移整组，数据集内部仍按 depth 递进', () => {
    const { ts, rootGroup, childGroup } = makeTileset(2);
    expect(ts.renderOrder).toBe(2);
    ts.update([0, 0, 0], Math.PI / 4, 800);
    expect(childGroup.renderOrder).toBe(2 * DATASET_ORDER_STRIDE + 101);
    expect(rootGroup.renderOrder).toBe(2 * DATASET_ORDER_STRIDE + 0);
  });

  test('合法步长：相邻 renderOrder 的瓦片集合不重叠', () => {
    const a = makeTileset(0);
    const b = makeTileset(1);
    a.ts.update([0, 0, 0], Math.PI / 4, 800);
    b.ts.update([0, 0, 0], Math.PI / 4, 800);
    // a 里最深的 primary 也不可能越过 b 的基线
    expect(b.childGroup.renderOrder - a.childGroup.renderOrder).toBeGreaterThan(0);
    expect(DATASET_ORDER_STRIDE).toBeGreaterThan(100);
  });

  test('非法值归一到 0，不抛错', () => {
    expect(new S3MTileset({ configUrl: 'x', renderOrder: Number.NaN }).renderOrder).toBe(0);
    expect(new S3MTileset({ configUrl: 'x', renderOrder: -3 }).renderOrder).toBe(-3);
  });
});

/* -------------------------------------------------- ⑤ 运行时改绘制顺序 */

describe('setDatasetRenderOrder', () => {
  test('改完之后下一帧的组 order 跟着变', () => {
    const v = makeViewer();
    const entry = {
      id: 'd',
      root: new THREE.Group(),
      options: {},
      tileset: { renderOrder: 0, dispose: () => {} } as unknown as S3MTileset,
      visible: true,
      error: null,
    };
    (v as unknown as { _datasetManager: { datasets: Map<string, unknown> } })._datasetManager.datasets.set(
      'd',
      entry
    );

    v.setDatasetRenderOrder('d', 3);
    expect((entry.tileset as unknown as { renderOrder: number }).renderOrder).toBe(3);

    v.setDatasetRenderOrder('missing', 1); // 不存在的数据集：静默忽略
    expect((entry.tileset as unknown as { renderOrder: number }).renderOrder).toBe(3);
    v.dispose();
  });
});
