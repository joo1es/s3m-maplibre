import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';

describe('视锥剔除第一期：视野外瓦片不再细化 (issue #25)', () => {
  function makeMockTileset() {
    const ts = new S3MTileset({
      configUrl: 'http://example.com/config.json',
      maxTiles: 20,
    });
    // 手动构造两个节点：nodeIn（视野内/原点前方），nodeOut（视野外/背后）
    const groupIn = new THREE.Group();
    const groupOut = new THREE.Group();

    const nodeIn = {
      url: 'http://example.com/in.s3mb',
      childUrls: ['http://example.com/in_child.s3mb'],
      rangeMode: 0, // Distance_From_EyePoint
      rangeValue: 500, // 距离 < 500 时需细化
      sphere: { center: { x: 0, y: 100, z: 0 }, radius: 50 },
      group: groupIn,
      state: 'ready' as const,
      stats: { meshes: 1, vertices: 10, triangles: 5, memory: 100 },
    };

    const nodeOut = {
      url: 'http://example.com/out.s3mb',
      childUrls: ['http://example.com/out_child.s3mb'],
      rangeMode: 0,
      rangeValue: 500,
      sphere: { center: { x: 0, y: -500, z: 0 }, radius: 50 },
      group: groupOut,
      state: 'ready' as const,
      stats: { meshes: 1, vertices: 10, triangles: 5, memory: 100 },
    };

    ts.nodes.set(nodeIn.url, nodeIn);
    ts.nodes.set(nodeOut.url, nodeOut);
    ts.rootUrls = [nodeIn.url, nodeOut.url];

    return { ts, nodeIn, nodeOut };
  }

  test('1. 默认行为不变（不变式 ①）：不传 isVisible 回调时，两块瓦片均按距离细化并入队', () => {
    const { ts, nodeIn, nodeOut } = makeMockTileset();
    const enqueued: string[] = [];
    (ts as any)._enqueue = (childUrl: string) => {
      enqueued.push(childUrl);
    };

    ts.update([0, 0, 0], Math.PI / 4, 800);

    expect(nodeIn.needRefine).toBe(true);
    expect(enqueued).toContain('http://example.com/in_child.s3mb');
  });

  test('2. 传入 isVisible 视锥判定：视野外的瓦片 needRefine 为 false 且不入队', () => {
    const { ts, nodeIn, nodeOut } = makeMockTileset();
    const enqueued: string[] = [];
    (ts as any)._enqueue = (childUrl: string) => {
      enqueued.push(childUrl);
    };

    // 模拟视锥剔除：y > 0 的可见，y <= 0 的不可见
    const isVisible = (center: { x: number; y: number; z: number }) => center.y > 0;

    ts.update([0, 0, 0], Math.PI / 4, 800, isVisible);

    expect(nodeIn.needRefine).toBe(true);
    expect(nodeOut.needRefine).toBe(false);
    expect(enqueued).toContain('http://example.com/in_child.s3mb');
    expect(enqueued).not.toContain('http://example.com/out_child.s3mb');
  });

  test('3. 不动 lastSeen 语义：视野外瓦片只要在有效距离内，仍然更新 lastSeen（不被轻易回收）', () => {
    const { ts, nodeOut } = makeMockTileset();
    const isVisible = (center: { x: number; y: number; z: number }) => center.y > 0;

    ts.update([0, 0, 0], Math.PI / 4, 800, isVisible);

    // nodeOut 距离为 500，在 inRange (dist < threshold * 2 = 1000) 范围内
    expect(nodeOut.lastSeen).toBe((ts as any)._frame);
  });

  test('4. S3MViewer cullRefine 配置与 getter/setter 暴露', () => {
    const v = new S3MViewer({ cullRefine: true });
    expect(v.cullRefine).toBe(true);

    v.setCullRefine(false);
    expect(v.cullRefine).toBe(false);

    v.cullRefine = true;
    expect(v.cullRefine).toBe(true);
  });

  test('5. S3MLayer 转发 cullRefine 配置与 setter', () => {
    const layer = new S3MLayer({
      id: 'test-layer',
      cullRefine: true,
    });
    expect(layer.cullRefine).toBe(true);

    layer.setCullRefine(false);
    expect(layer.cullRefine).toBe(false);

    layer.cullRefine = true;
    expect(layer.cullRefine).toBe(true);
  });

  test('6. renderFrame 端到端：cullRefine 开启时自动构造视锥并跳过背后瓦片细化', () => {
    const v = new S3MViewer({ cullRefine: true });
    v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };
    (v as any).canvas = { width: 800, height: 600 };
    (v as any).camera = new THREE.Camera();
    (v as any).renderer = {
      getContext: () => ({ isContextLost: () => false, depthMask: () => {}, clear: () => {} }),
      capabilities: { isWebGL2: true },
      setViewport: () => {},
      resetState: () => {},
      render: () => {},
    };

    const { ts, nodeIn, nodeOut } = makeMockTileset();
    const enqueued: string[] = [];
    (ts as any)._enqueue = (childUrl: string) => {
      enqueued.push(childUrl);
    };

    // 挂载数据集
    const entry = {
      id: 'ds1',
      name: 'ds1',
      options: {},
      root: new THREE.Group(),
      tileset: ts,
      anchor: null,
      baseAlignOffset: 0,
      userOffset: 0,
      heightOffset: 0,
      offset: [0, 0, 0] as [number, number, number],
      visible: true,
      error: null,
    };
    (v as any).datasets.set('ds1', entry);
    entry.root.add(nodeIn.group);
    entry.root.add(nodeOut.group);
    (v as any).scene.add(entry.root);
    entry.root.updateMatrixWorld(true);

    // 宿主 MVP 处于墨卡托坐标系（ENU 的 y 经过 _enuMatrix 翻转为 -y）
    // 构造一个朝向墨卡托 -y（即 ENU 正北 +y）的相机
    const camera = new THREE.PerspectiveCamera(60, 800 / 600, 1, 1000);
    camera.position.set(0, 0, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, -100, 0);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const projScreen = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // 渲染一帧
    v.renderFrame({
      mvp: projScreen.elements as unknown as number[],
      cameraEnu: [0, 0, 0],
      fovRad: Math.PI / 3,
      canvasHeight: 600,
    });

    // nodeIn 位于 (0, 100, 0) 朝向正前方，应该细化
    expect(nodeIn.needRefine).toBe(true);
    expect(enqueued).toContain('http://example.com/in_child.s3mb');

    // nodeOut 位于 (0, -500, 0) 正后方，应该被剔除，不细化也不入队
    expect(nodeOut.needRefine).toBe(false);
    expect(enqueued).not.toContain('http://example.com/out_child.s3mb');
  });

  test('7. 边界余量保障：贴近视锥边界外的瓦片（在 margin 缓冲区内）保留细化', () => {
    const v = new S3MViewer({ cullRefine: true });
    v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };
    (v as any).canvas = { width: 800, height: 600 };
    (v as any).camera = new THREE.Camera();
    (v as any).renderer = {
      getContext: () => ({ isContextLost: () => false, depthMask: () => {}, clear: () => {} }),
      capabilities: { isWebGL2: true },
      setViewport: () => {},
      resetState: () => {},
      render: () => {},
    };

    const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', maxTiles: 10 });
    const groupNear = new THREE.Group();
    const nodeNear = {
      url: 'http://example.com/near.s3mb',
      childUrls: ['http://example.com/near_child.s3mb'],
      rangeMode: 0,
      rangeValue: 500,
      // 视锥右平面 x <= 50；球心在 52，radius 10；边界外 2 米（在 10 米余量内）
      sphere: { center: { x: 52, y: 100, z: 0 }, radius: 10 },
      group: groupNear,
      state: 'ready' as const,
      stats: { meshes: 1, vertices: 10, triangles: 5, memory: 100 },
    };
    ts.nodes.set(nodeNear.url, nodeNear);
    ts.rootUrls = [nodeNear.url];

    const entry = {
      id: 'ds2',
      name: 'ds2',
      options: {},
      root: new THREE.Group(),
      tileset: ts,
      anchor: null,
      baseAlignOffset: 0,
      userOffset: 0,
      heightOffset: 0,
      offset: [0, 0, 0] as [number, number, number],
      visible: true,
      error: null,
    };
    (v as any).datasets.set('ds2', entry);
    entry.root.add(nodeNear.group);
    (v as any).scene.add(entry.root);
    entry.root.updateMatrixWorld(true);

    // 墨卡托正交相机：x ∈ [-50, 50], y 从 0 到 -200（即 ENU y 从 0 到 +200）, z ∈ [-50, 50]
    const orthoCam = new THREE.OrthographicCamera(-50, 50, 0, -200, -50, 50);
    orthoCam.updateMatrixWorld(true);
    orthoCam.matrixWorldInverse.copy(orthoCam.matrixWorld).invert();
    const orthoProjScreen = new THREE.Matrix4().multiplyMatrices(orthoCam.projectionMatrix, orthoCam.matrixWorldInverse);

    v.renderFrame({
      mvp: orthoProjScreen.elements as unknown as number[],
      cameraEnu: [0, 0, 0],
      fovRad: Math.PI / 3,
      canvasHeight: 600,
    });

    // 处于 10 米余量缓冲内的贴边瓦片，应该保留细化，不引起画面边缘剔除闪烁
    expect(nodeNear.needRefine).toBe(true);
  });
});
