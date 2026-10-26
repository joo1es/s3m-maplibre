/**
 * 新增能力单测：拾取 / 单体平移 / LOD 缩放 / 单体聚焦 / 穿透拾取 /
 * 自定义 CRS / 多 Mesh 共享 SMID / 数据集垂直对齐
 *
 * 这些能力都靠 S3MLayer 的宿主胶水层实现，改动一处很容易连带别处，
 * 所以每项都钉住「数值结果」而不是「跑通不崩」。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MLayer } from '../../packages/s3m-maplibre/src/index';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

const mkLayer = (opts: ConstructorParameters<typeof S3MLayer>[0] = {}) => new S3MLayer(opts);

describe('1. lodRangeScale 动态调整', () => {
  test('构造时设置、运行期更新都生效', () => {
    const tileset = new S3MTileset({ configUrl: 'http://example.com/config.json', lodRangeScale: 1.5 });
    expect(tileset.lodRangeScale).toBe(1.5);

    // 模拟节点：rangeMode = 1（屏幕像素），rangeValue = 100
    tileset.nodes.set('root.s3mb', {
      url: 'root.s3mb',
      childUrl: 'child.s3mb',
      sphere: { center: { x: 0, y: 0, z: 0 }, radius: 10 },
      rangeValue: 100,
      rangeMode: 1,
      state: 'loaded',
      group: new THREE.Group(),
    } as never);

    // scale = 1.5 时阈值 150；scale = 0.8 时阈值 80，metric 120 就会触发 refine
    tileset.lodRangeScale = 0.8;
    expect(tileset.lodRangeScale).toBe(0.8);
  });
});

describe('2. 单体 xy/z 平移（状态纹理第 2 行）', () => {
  test('状态纹理高度扩为 2 行，成功存储 [dx, dy, dz]', () => {
    const layer = mkLayer({ configUrl: 'http://example.com/config.json' });

    // 造一个带 geoRef 与 aBatchId 的测试 Mesh
    const geom = new THREE.BoxGeometry(10, 10, 10);
    geom.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count), 1));
    const mat = new THREE.MeshBasicMaterial();
    mat.userData = {
      isStyled: true,
      uBatchTex: { value: null },
      uBatchTexWidth: { value: 1 },
      uBatchTexActive: { value: 0 },
    };
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = { pickId: 0, geoRef: { pickInfo: { 101: { batchId: 0 } } } };

    layer.setFeatureStyle(101, { color: '#ff0000', translation: [5, 10, 15] });
    layer.viewer._applyOverridesToMesh(mesh);

    const tex = mat.userData.uBatchTex.value;
    expect(tex).toBeTruthy();
    // 扩容成 2 行才放得下 vec3 平移
    expect(tex.image.height).toBe(2);

    const data = tex.image.data;
    const w = tex.image.width;
    // Row 0：[r, g, b, 显隐]
    expect(data[0]).toBeGreaterThan(0.9);
    expect(data[3]).toBe(0);

    // Row 1：[tx, ty, tz, 0]
    const r1 = w * 4;
    expect(data[r1 + 0]).toBe(5);
    expect(data[r1 + 1]).toBe(10);
    expect(data[r1 + 2]).toBe(15);
  });
});

describe('2.5 单体独立透明度（状态纹理第 2 行 alpha）', () => {
  const mkStyledMesh = (layer: S3MLayer, smid: number) => {
    const geom = new THREE.BoxGeometry(10, 10, 10);
    geom.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count), 1));
    const mesh = new THREE.Mesh(geom, createStyledMaterial(layer.uniforms));
    mesh.userData = { pickId: 0, geoRef: { pickInfo: { [smid]: { batchId: 0 } } } };
    return mesh;
  };

  test('写入第 2 行 alpha，材质开 transparent；清除后还原', () => {
    const layer = mkLayer({ configUrl: 'http://example.com/config.json' });
    const mesh = mkStyledMesh(layer, 101);

    layer.setFeatureStyle(101, { opacity: 0.4 });
    layer.viewer._applyOverridesToMesh(mesh);

    const mat = mesh.material as unknown as {
      transparent: boolean;
      opacity: number;
      userData: {
        uBatchTex: { value: { image: { data: Float32Array; width: number } } };
        uBatchTexActive: { value: number };
      };
    };
    const tex = mat.userData.uBatchTex.value;
    const w = tex.image.width;
    // Row 1 alpha = 0.4（(0,1) 开区间），Row 0 不受影响（不隐藏）
    expect(tex.image.data[w * 4 + 3]).toBeCloseTo(0.4, 5);
    expect(tex.image.data[3]).toBe(0);
    expect(mat.transparent).toBe(true);

    // 清除后：uBatchTexActive 归零（渲染不再采样状态纹理）、transparent 还原（全局 opacity=1）
    layer.removeFeatureStyle(101);
    layer.viewer._applyOverridesToMesh(mesh);
    expect(mat.userData.uBatchTexActive.value).toBe(0);
    expect(mat.transparent).toBe(false);
  });

  test('opacity <= 0 等价 hidden，走 Row 0 隐藏位', () => {
    const layer = mkLayer({ configUrl: 'http://example.com/config.json' });
    const mesh = mkStyledMesh(layer, 102);

    layer.setFeatureStyle(102, { opacity: 0 });
    layer.viewer._applyOverridesToMesh(mesh);

    const mat = mesh.material as unknown as {
      userData: { uBatchTex: { value: { image: { data: Float32Array; width: number } } } };
    };
    const tex = mat.userData.uBatchTex.value;
    expect(tex.image.data[3]).toBe(-1); // Row 0 hidden
    expect(tex.image.data[tex.image.width * 4 + 3]).toBe(0);
  });
});

describe('3. getFeatureBounds & flyToFeature', () => {
  test('单体范围计算与飞向宿主 map.fitBounds', () => {
    const layer = mkLayer({ configUrl: 'http://example.com/config.json' });
    layer.sceneAnchor = { x: 0.8, y: 0.4, z: 0.0, meterInMercator: 1e-7, altitude: 10 } as never;

    const geom = new THREE.BoxGeometry(20, 20, 20); // 范围 -10 ~ 10
    geom.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count), 1));
    const mesh = new THREE.Mesh(geom);
    mesh.updateMatrixWorld(true);
    mesh.userData = { pickId: 1, geoRef: { pickInfo: { 202: { batchId: 0 } } } };
    layer.viewer._pickables.set(1, { mesh, datasetId: 'test', skeletonName: 'box' } as never);

    const bounds = layer.getFeatureBounds(202);
    expect(bounds).toBeTruthy();
    expect(bounds!.length).toBe(2); // [[minLng, minLat], [maxLng, maxLat]]
    expect(bounds![0][0]).toBeLessThan(bounds![1][0]);
    expect(bounds![0][1]).toBeLessThan(bounds![1][1]);

    let flyCalledWith: { bounds: unknown; opts: { maxZoom?: number } } | null = null;
    layer.map = {
      getCanvas: () => ({ clientWidth: 800, clientHeight: 600, width: 800, height: 600 }),
      fitBounds: (b: unknown, opts: { maxZoom?: number }) => {
        flyCalledWith = { bounds: b, opts };
      },
    } as never;

    expect(layer.flyToFeature(202, { maxZoom: 17 })).toBe(true);
    expect(flyCalledWith).toBeTruthy();
    expect(flyCalledWith!.opts.maxZoom).toBe(17);
  });
});

describe('4. pickPosition 与精确求交', () => {
  test('精确返回场景点与世界坐标 [lng, lat, altitude]', () => {
    const layer = mkLayer({ configUrl: 'http://example.com/config.json' });
    layer.sceneAnchor = { x: 0.5, y: 0.5, z: 0.0, meterInMercator: 1e-6, altitude: 50 } as never;
    layer.viewer.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    layer.camera.position.set(0, 0, 100);
    layer.camera.lookAt(0, 0, 0);
    layer.camera.updateMatrixWorld(true);
    layer.camera.updateProjectionMatrix();

    // viewer 在 mount 时缓存画布；测试直接注入
    layer.viewer.canvas = { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as never;

    // 未命中建筑时与 z=0 地面求交
    const pos = layer.pickPosition(400, 300); // 屏幕正中心
    expect(pos).toBeTruthy();
    expect(Array.isArray(pos!.lngLat)).toBe(true);
    expect(pos!.altitude).toBe(50); // z=0 + 锚点高度 50m
    expect(Math.round(pos!.point[0])).toBe(0);
    expect(Math.round(pos!.point[1])).toBe(0);
  });
});

describe('5. drillPick 穿透拾取', () => {
  test('穿透多个单体并按深度排序返回', () => {
    const layer = mkLayer({ configUrl: 'http://example.com/config.json' });
    layer.sceneAnchor = { x: 0.5, y: 0.5, z: 0.0, meterInMercator: 1e-6, altitude: 0 } as never;
    layer.viewer.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    layer.camera.position.set(0, 0, 200);
    layer.camera.lookAt(0, 0, 0);
    layer.camera.updateMatrixWorld(true);
    layer.camera.updateProjectionMatrix();
    layer.viewer.canvas = { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as never;

    // 沿 z 轴放置前后两个面（前层 z=50，后层 z=10）
    const plane = (z: number, pickId: number, smid: number) => {
      const g = new THREE.PlaneGeometry(20, 20);
      g.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
      const m = new THREE.Mesh(g);
      m.position.set(0, 0, z);
      m.updateMatrixWorld(true);
      m.userData = { pickId, geoRef: { pickInfo: { [smid]: { batchId: 0 } } } };
      return m;
    };
    const front = plane(50, 10, 301);
    const back = plane(10, 11, 302);
    layer.viewer._pickables.set(10, { mesh: front, datasetId: 'test', skeletonName: 'front' } as never);
    layer.viewer._pickables.set(11, { mesh: back, datasetId: 'test', skeletonName: 'back' } as never);

    const hits = layer.drillPick(400, 300);
    expect(hits.length).toBe(2);
    expect(hits[0].smid).toBe(301);
    expect(hits[1].smid).toBe(302);
    expect(hits[0].point[2]).toBeGreaterThan(hits[1].point[2]); // 按深度排序
  });
});

describe('6. CRS / worldCoordinateHelper 适配', () => {
  test('任意投影与平面 CRS 的尺度、逆反查、投影切换都正确', () => {
    const customCRS = {
      name: 'custom:planar',
      worldFromLngLat(lng: number, lat: number, altitude = 0) {
        // 模拟自定义平面 CRS：extent = 50000m
        return { x: (lng - 100) / 10, y: (lat - 30) / 10, z: altitude / 50000 };
      },
      lngLatFromWorld(x: number, y: number) {
        return { lng: x * 10 + 100, lat: y * 10 + 30 };
      },
      metersPerWorldUnit: (_x: number, _y: number) => 50000,
    };

    const listeners: Record<string, (() => void) | undefined> = {};
    const mockMap = {
      getCanvas: () => ({ width: 800, height: 600 }),
      triggerRepaint: () => {},
      on: (evt: string, fn: () => void) => {
        listeners[evt] = fn;
      },
      off: (evt: string) => {
        delete listeners[evt];
      },
      transform: { worldCoordinateHelper: customCRS },
    };

    const layer = mkLayer();
    layer.map = mockMap as never;
    mockMap.on('projectiontransition', layer._onProjectionChange);

    layer.datasets.set('customDs', {
      id: 'customDs',
      name: 'Custom CRS Dataset',
      anchor: { lon: 105, lat: 35, height: 100 },
      root: new THREE.Group(),
      tileset: null,
    } as never);

    layer.viewer.recomputeAnchors();

    expect(layer.sceneAnchor).toBeTruthy();
    expect(layer.sceneAnchor!.x).toBe(0.5);
    expect(layer.sceneAnchor!.y).toBe(0.5);
    expect(layer.sceneAnchor!.meterInMercator).toBe(1 / 50000);
    expect(layer.sceneAnchor!.z).toBe(100 / 50000);

    // 坐标反查经纬度
    expect(layer.viewer._lngLatFromWorld(0.5, 0.5)).toEqual([105, 35]);

    // 投影切换动态响应
    customCRS.metersPerWorldUnit = () => 20000;
    listeners['projectiontransition']?.();
    expect(layer.sceneAnchor!.meterInMercator).toBe(1 / 20000);
  });
});

describe('7. 多 Mesh 共享同一 SMID 时联动选中（CBD 场景）', () => {
  test('点击单面时联动选中同 SMID 的所有材质网格', () => {
    const layer = mkLayer();

    const mkMesh = (pos: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      const m = new THREE.Mesh(g, createStyledMaterial(layer.uniforms));
      m.userData = {
        geoRef: { pickInfo: { 20: { batchId: 0, segments: [{ vertexOffset: 0, vertexCount: 3 }] } } },
      };
      layer.viewer._indexMeshSmids(m);
      return m;
    };
    const m1 = mkMesh([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const m2 = mkMesh([1, 1, 0, 2, 1, 0, 1, 2, 0]);

    layer.select({ datasetId: 'cbd', datasetName: 'CBD', objectId: 1, batchId: 0, smid: 20, mesh: m1 } as never);

    // 虽然只点了 m1，但共享 SMID 20 的两块网格都要高亮
    expect(m1.material.userData.uSelBatch.value).toBe(0);
    expect(m2.material.userData.uSelBatch.value).toBe(0);
    expect(layer.viewer._selectedMeshes.length).toBe(2);

    layer.select(null);
    expect(m1.material.userData.uSelBatch.value).toBe(-1);
    expect(m2.material.userData.uSelBatch.value).toBe(-1);
    expect(layer.viewer._selectedMeshes.length).toBe(0);
  });
});

describe('8. 数据集智能垂直对齐（align: top / bottom / center）', () => {
  test('按高度范围精确对齐地表，且贴地量不与 align 基准互相覆盖', () => {
    const layer = mkLayer({ id: 's3m' });
    const entry = {
      id: 'subway',
      name: 'Subway',
      options: { id: 'subway', configUrl: 'http://example.com/cfg.json', align: 'top', heightOffset: 2 },
      root: new THREE.Group(),
      tileset: {
        heightRange: { min: -5, max: 25 },
        anchor: { lon: 116.4, lat: 39.9, height: 0 },
      },
      anchor: { lon: 116.4, lat: 39.9, height: 0 },
      baseAlignOffset: 0,
      userOffset: 2,
      heightOffset: 0,
      offset: [0, 0, 0],
      visible: true,
      error: null,
    };
    layer.datasets.set('subway', entry as never);

    // align: 'top' → baseAlignOffset = -max = -25，加 userOffset 2 → -23
    entry.baseAlignOffset = layer._computeAlignOffset(entry.tileset as never, 'top');
    entry.heightOffset = entry.baseAlignOffset + entry.userOffset;
    expect(entry.baseAlignOffset).toBe(-25);
    expect(entry.heightOffset).toBe(-23);

    layer.setDatasetAlign('subway', 'bottom');
    expect(entry.baseAlignOffset).toBe(5); // 抬起 -min
    expect(entry.heightOffset).toBe(7); // 附加偏移 2m 保留

    layer.setDatasetAlign('subway', 'center');
    expect(entry.baseAlignOffset).toBe(-10); // -(25-5)/2
    expect(entry.heightOffset).toBe(-8);

    layer.setDatasetAlign('subway', 'origin');
    expect(entry.baseAlignOffset).toBe(0);
    expect(entry.heightOffset).toBe(2);

    // 贴地（setDatasetHeight）只改 userOffset，不覆盖 align 基准
    layer.setDatasetAlign('subway', 'top');
    layer.setDatasetHeight('subway', 40);
    expect(entry.baseAlignOffset).toBe(-25);
    expect(entry.userOffset).toBe(40);
    expect(entry.heightOffset).toBe(15);
    expect(layer.getDatasetHeight('subway')).toBe(40);
  });
});
