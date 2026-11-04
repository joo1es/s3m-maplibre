/**
 * #36：把「视锥可见性」从 `cullRefine`（只管细化请求）里拆出来，独立作用于绘制。
 *
 * 背景：three 的剔除用 `projectionMatrix × matrixWorldInverse`，而本项目把
 * `projectionMatrix` 换成了完整 MVP、`matrixWorldInverse` 只是相机平移的逆，
 * 两者相乘得到的视锥整体平移了「相机到锚点」的距离（实测平面常数差 = 该距离）。
 * 普通瓦片 mesh 又走 three 默认的 `frustumCulled = true`，于是「画不画」跟真实
 * 可见性脱钩。这里改成：three 不再剔瓦片，由本模块用宿主 MVP 的正确视锥决定。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import type { TileNode } from '../../packages/s3m-three/src/tileset/types';

function makeNode(url: string, center: [number, number, number], radius: number, childUrls: string[] = []) {
  const group = new THREE.Group();
  group.name = url;
  const node: TileNode = {
    url,
    childUrls,
    rangeMode: 0,
    rangeValue: 500,
    sphere: { center: { x: center[0], y: center[1], z: center[2] }, radius },
    group,
    state: 'ready',
    stats: { meshes: 1, vertices: 10, triangles: 5, memory: 100 },
  } as unknown as TileNode;
  return node;
}

function makeTileset(nodes: TileNode[], roots: string[]) {
  const ts = new S3MTileset({ configUrl: 'http://example.com/config.json', maxTiles: 50 });
  for (const n of nodes) ts.nodes.set(n.url, n);
  ts.rootUrls = roots;
  return ts;
}

/** y > 0 可见、y <= 0 不可见：够用且能一眼看出期望 */
const visibleY = (center: { y: number }) => center.y > 0;

describe('#36 视锥可见性剔除：与 cullRefine（细化）解耦', () => {
  test('1. 默认行为不变：不传 options 时，即使给了 isVisible 也不改 group.visible', () => {
    const inNode = makeNode('in', [0, 100, 0], 50);
    const outNode = makeNode('out', [0, -500, 0], 50);
    const ts = makeTileset([inNode, outNode], ['in', 'out']);

    ts.update([0, 0, 0], Math.PI / 4, 800, visibleY as never);

    // 旧口径：isVisible 只参与「要不要细化」，可见性仍由 LOD 递归决定
    expect(inNode.group.visible).toBe(true);
    expect(outNode.group.visible).toBe(true);
  });

  test('2. visibleCull 生效：视野外隐藏、视野内显示', () => {
    const inNode = makeNode('in', [0, 100, 0], 50);
    const outNode = makeNode('out', [0, -500, 0], 50);
    const ts = makeTileset([inNode, outNode], ['in', 'out']);

    ts.update([0, 0, 0], Math.PI / 4, 800, visibleY as never, { visibleCull: true });

    expect(inNode.group.visible).toBe(true);
    expect(outNode.group.visible).toBe(false);
  });

  test('3. 父瓦不可见时，整棵子树一起隐藏', () => {
    const parent = makeNode('p', [0, -600, 0], 200, ['c']);
    const child = makeNode('c', [0, -600, 0], 100);
    const ts = makeTileset([parent, child], ['p']);

    ts.update([0, 0, 0], Math.PI / 4, 800, visibleY as never, { visibleCull: true });

    expect(parent.group.visible).toBe(false);
    expect(child.group.visible).toBe(false);
  });

  test('4. 全部在视野外时允许空场，不被「绝不允许空场」兜底强行点亮', () => {
    const a = makeNode('a', [0, -100, 0], 50);
    const b = makeNode('b', [0, -200, 0], 50);
    const ts = makeTileset([a, b], ['a', 'b']);

    ts.update([0, 0, 0], Math.PI / 4, 800, visibleY as never, { visibleCull: true });

    expect(a.group.visible).toBe(false);
    expect(b.group.visible).toBe(false);
  });

  test('5. 两个开关互相独立：visibleCull 只关绘制，refineCull 才管请求', () => {
    const outNode = makeNode('out', [0, -300, 0], 50, ['out_child']);
    const ts = makeTileset([outNode], ['out']);
    const enqueued: string[] = [];
    (ts as unknown as { _enqueue: (url: string) => void })._enqueue = (url: string) => enqueued.push(url);

    ts.update([0, 0, 0], Math.PI / 4, 800, visibleY as never, {
      visibleCull: true,
      refineCull: false,
    });

    // 不画，但仍然请求子瓦：转头回来时数据已经在
    expect(outNode.group.visible).toBe(false);
    expect(outNode.needRefine).toBe(true);
    expect(enqueued).toContain('out_child');
  });

  test('6. refineCull 打开时，视野外不再请求子瓦（保持 cullRefine 原语义）', () => {
    const outNode = makeNode('out', [0, -300, 0], 50, ['out_child']);
    const ts = makeTileset([outNode], ['out']);
    const enqueued: string[] = [];
    (ts as unknown as { _enqueue: (url: string) => void })._enqueue = (url: string) => enqueued.push(url);

    ts.update([0, 0, 0], Math.PI / 4, 800, visibleY as never, {
      visibleCull: true,
      refineCull: true,
    });

    expect(outNode.needRefine).toBe(false);
    expect(enqueued).not.toContain('out_child');
  });

  test('7. 没有包围球的节点保守保留：判不了就不隐藏', () => {
    const noSphere = makeNode('n', [0, -100, 0], 10);
    (noSphere as unknown as { sphere?: unknown }).sphere = undefined;
    const ts = makeTileset([noSphere], ['n']);

    ts.update([0, 0, 0], Math.PI / 4, 800, visibleY as never, { visibleCull: true });

    expect(noSphere.group.visible).toBe(true);
  });

  test('8. renderFrame 默认按宿主 MVP 剔除，不依赖 cullRefine 开关', () => {
    const v = new S3MViewer();
    v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };
    (v as unknown as { canvas: unknown }).canvas = { width: 800, height: 600 };
    (v as unknown as { camera: THREE.Camera }).camera = new THREE.Camera();
    (v as unknown as { renderer: unknown }).renderer = {
      getContext: () => ({ isContextLost: () => false, depthMask: () => {}, clear: () => {} }),
      capabilities: { isWebGL2: true },
      setViewport: () => {},
      resetState: () => {},
      render: () => {},
    };

    const inNode = makeNode('in', [0, 100, 0], 50);
    const outNode = makeNode('out', [0, -500, 0], 50);
    const ts = makeTileset([inNode, outNode], ['in', 'out']);

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
      offset: [0, 0, 0],
      visible: true,
      error: null,
    };
    (v as unknown as { datasets: Map<string, unknown> }).datasets.set('ds1', entry);
    entry.root.add(inNode.group);
    entry.root.add(outNode.group);
    (v as unknown as { scene: THREE.Scene }).scene.add(entry.root);
    entry.root.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(60, 800 / 600, 1, 1000);
    camera.position.set(0, 0, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, -100, 0);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const projScreen = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // cullRefine 保持默认 false
    expect(v.cullRefine).toBe(false);
    v.renderFrame({
      mvp: projScreen.elements as unknown as number[],
      cameraEnu: [0, 0, 0],
      fovRad: Math.PI / 3,
      canvasHeight: 600,
    });

    expect(inNode.group.visible).toBe(true);
    expect(outNode.group.visible).toBe(false);
  });
});
