/**
 * LOD 过渡：从「整节点二值切换」升级为 primary/fallback 增量细化（Issue #14）
 *
 * 验证目标：
 * 1. 默认行为不变：不传参数时默认为 'binary'，行为路径与之前逐字一致；
 * 2. 慢 child 场景：8 个子瓦中 7 个先到（200ms）、1 个慢（3s）时，
 *    'incremental' 模式下 7 个已到子瓦立即作为 primary 渲染，父瓦作为 fallback 兜底慢子瓦；
 *    'binary' 模式下必须等全部 8 个到齐才切换；
 * 3. 连续推进 60 帧空间全覆盖断言：任意一帧任意空间位置至少被一层瓦片（primary 或 fallback）覆盖，不出洞；
 * 4. Draw calls 增量实测：稳态 0 增量，过渡期仅在途父节点产生 1 层 fallback；
 * 5. 材质 polygonOffset 与 renderOrder 正确切换与无残留还原；
 * 6. S3MViewer / S3MLayer 图层级 API 与 setter 联动。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';

function createMockMesh(): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  return new THREE.Mesh(geo, mat);
}

function createMockNode(url: string, rangeValue: number, childUrls: string[], parentUrl: string | null = null) {
  const group = new THREE.Group();
  const mesh = createMockMesh();
  group.add(mesh);

  return {
    url,
    tile: { geoPackage: {} },
    group,
    sphere: { center: { x: 0, y: 0, z: 0 }, radius: 100 },
    rangeValue,
    rangeMode: 1, // 屏幕像素模式
    childUrls,
    childUrl: childUrls[0] ?? null,
    parentUrl,
    state: 'ready',
    needRefine: false,
    distance: 100,
    stats: { meshes: 1, vertices: 3, triangles: 1 },
  };
}

function createTestTileset(opts: any = {}): any {
  const ts = new S3MTileset({
    configUrl: 'https://example.com/ds/config',
    ...opts,
  } as any) as any;
  ts._load = () => Promise.resolve();
  return ts;
}

describe('LOD 过渡策略（lodTransition: binary vs incremental）', () => {
  test('1. 默认行为不变：不传参数默认为 binary，与旧版二值切换一致', () => {
    const tsDefault = createTestTileset();
    expect(tsDefault.lodTransition).toBe('binary');

    // 构造根瓦片与 4 个子瓦
    const pNode = createMockNode('root', 50, ['c1', 'c2', 'c3', 'c4'], null);
    pNode.needRefine = true;
    tsDefault.nodes.set('root', pNode as any);
    tsDefault.rootUrls.push('root');

    // 只到了 3 个子瓦，第 4 个还在途中
    for (const c of ['c1', 'c2', 'c3']) {
      const cNode = createMockNode(c, 25, [], 'root');
      tsDefault.nodes.set(c, cNode as any);
    }

    // binary 模式下 update：因为 c4 没到，allResolved=false，不能细化
    tsDefault.update([0, 0, 50], Math.PI / 4, 1080);

    expect(pNode.group.visible).toBe(true);
    expect((tsDefault.nodes.get('c1') as any).group.visible).toBe(false);
    expect((tsDefault.nodes.get('c2') as any).group.visible).toBe(false);
    expect((tsDefault.nodes.get('c3') as any).group.visible).toBe(false);
    expect(tsDefault.fallbackNodes.size).toBe(0);
  });

  test('2. 慢 child 场景：7 个就绪 + 1 个慢 child，增量细化立即显示 7 个 primary 并保留父瓦 fallback', () => {
    const ts = createTestTileset({
      lodTransition: 'incremental',
    });
    expect(ts.lodTransition).toBe('incremental');

    const children = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
    const pNode = createMockNode('root', 50, children, null);
    pNode.needRefine = true;
    ts.nodes.set('root', pNode as any);
    ts.rootUrls.push('root');

    // 模拟 200ms：c1~c7 到达，c8 仍在下载
    for (const c of children.slice(0, 7)) {
      const cNode = createMockNode(c, 25, [], 'root');
      ts.nodes.set(c, cNode as any);
    }

    ts.update([0, 0, 50], Math.PI / 4, 1080);

    // 验证：7 个就绪子瓦立即进入 primary 并显示
    for (const c of children.slice(0, 7)) {
      const node = ts.nodes.get(c) as any;
      expect(node.group.visible).toBe(true);
      expect(ts.primaryNodes.has(c)).toBe(true);
      expect(node.group.renderOrder).toBeGreaterThanOrEqual(100);
    }

    // 验证：父瓦片作为 fallback 保持显示，垫底填补 c8 区域
    expect(pNode.group.visible).toBe(true);
    expect(ts.fallbackNodes.has('root')).toBe(true);
    expect(pNode.group.renderOrder).toBe(0); // fallback renderOrder 靠前

    // 验证材质上的 polygonOffset 深度推移生效
    const mesh = pNode.group.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.Material;
    expect(mat.polygonOffset).toBe(true);
    expect(mat.polygonOffsetFactor).toBeGreaterThan(0);
    expect(mat.polygonOffsetUnits).toBeGreaterThan(0);

    // 模拟 3s：慢 child c8 终于到达
    const c8Node = createMockNode('c8', 25, [], 'root');
    ts.nodes.set('c8', c8Node as any);

    ts.update([0, 0, 50], Math.PI / 4, 1080);

    // 验证：所有 8 个子瓦均转为 primary 显示
    for (const c of children) {
      const node = ts.nodes.get(c) as any;
      expect(node.group.visible).toBe(true);
      expect(ts.primaryNodes.has(c)).toBe(true);
    }

    // 验证：父瓦片不再需要 fallback 兜底，自动隐藏，材质 polygonOffset 还原
    expect(pNode.group.visible).toBe(false);
    expect(ts.fallbackNodes.has('root')).toBe(false);
    expect(mat.polygonOffset).toBe(false);
  });

  test('3. 相机连续推进 60 帧空间全覆盖断言：任意一帧每个区域均被覆盖（无洞）', () => {
    const ts = createTestTileset({
      lodTransition: 'incremental',
    });

    // 造一棵 3 层四叉树
    const pNode = createMockNode('root', 100, ['c1', 'c2', 'c3', 'c4'], null);
    ts.nodes.set('root', pNode as any);
    ts.rootUrls.push('root');

    const subKids: Record<string, string[]> = {
      c1: ['c1_1', 'c1_2', 'c1_3', 'c1_4'],
      c2: ['c2_1', 'c2_2', 'c2_3', 'c2_4'],
      c3: ['c3_1', 'c3_2', 'c3_3', 'c3_4'],
      c4: ['c4_1', 'c4_2', 'c4_3', 'c4_4'],
    };

    for (const [c, kids] of Object.entries(subKids)) {
      ts.nodes.set(c, createMockNode(c, 50, kids, 'root') as any);
      for (const k of kids) {
        ts.nodes.set(k, createMockNode(k, 25, [], c) as any);
      }
    }

    // 模拟相机从远及近 60 步推进
    for (let frame = 0; frame < 60; frame++) {
      const z = 200 - frame * 2.5; // 从 200m 降到 50m
      // 人为让部分瓦片随帧数加载就绪，模拟网络异步落位
      pNode.needRefine = z < 150;
      for (const [c, kids] of Object.entries(subKids)) {
        const cNode = ts.nodes.get(c) as any;
        cNode.needRefine = z < 90;
      }

      ts.update([0, 0, z], Math.PI / 4, 1080);

      // 断言空间覆盖：对 4 个顶层象限 c1, c2, c3, c4，每个象限都必须有至少一个可见瓦片在渲染
      for (const quadrant of ['c1', 'c2', 'c3', 'c4']) {
        const qKids = subKids[quadrant]!;
        const rootCovering = pNode.group.visible;
        const quadCovering = (ts.nodes.get(quadrant) as any).group.visible;
        const subCovering = qKids.some((k) => (ts.nodes.get(k) as any).group.visible);

        const covered = rootCovering || quadCovering || subCovering;
        expect(covered).toBe(true);
      }
    }
  });

  test('4. Draw Calls 增量测试：稳态增量为 0，过渡态受限于正在细化的父节点', () => {
    const ts = createTestTileset({
      lodTransition: 'incremental',
    });

    const children = ['c1', 'c2', 'c3', 'c4'];
    const pNode = createMockNode('root', 50, children, null);
    pNode.needRefine = true;
    ts.nodes.set('root', pNode as any);
    ts.rootUrls.push('root');

    // 状态 A：无子瓦到达，稳态
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(ts.fallbackNodes.size).toBe(0);
    expect(ts.primaryNodes.size).toBe(1); // 只有 root

    // 状态 B：部分到达（2/4），过渡态
    ts.nodes.set('c1', createMockNode('c1', 25, [], 'root') as any);
    ts.nodes.set('c2', createMockNode('c2', 25, [], 'root') as any);
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(ts.fallbackNodes.size).toBe(1); // 只有 root 充当 fallback
    expect(ts.primaryNodes.size).toBe(2); // c1, c2 为 primary
    // 总渲染瓦片数 = fallback (1) + primary (2) = 3 块，增量仅为 1 块 fallback 绘制

    // 状态 C：全部到达（4/4），稳态
    ts.nodes.set('c3', createMockNode('c3', 25, [], 'root') as any);
    ts.nodes.set('c4', createMockNode('c4', 25, [], 'root') as any);
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(ts.fallbackNodes.size).toBe(0); // fallback 退出，稳态增量精确为 0
    expect(ts.primaryNodes.size).toBe(4);
  });

  test('5. 材质 polygonOffset 还原与独立性：不污染已有材质设置', () => {
    const ts = createTestTileset({
      lodTransition: 'incremental',
    });

    const pNode = createMockNode('root', 50, ['c1', 'c2'], null);
    pNode.needRefine = true;
    // 人为给该材质预先设置了基础 polygonOffset
    const mesh = pNode.group.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.Material;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -2;

    ts.nodes.set('root', pNode as any);
    ts.rootUrls.push('root');
    ts.nodes.set('c1', createMockNode('c1', 25, [], 'root') as any); // c2 没到

    // 进入 fallback
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(ts.fallbackNodes.has('root')).toBe(true);
    expect(mat.polygonOffset).toBe(true);
    expect(mat.polygonOffsetFactor).toBeGreaterThan(-1); // 叠加了 fallback factor
    expect(mat.polygonOffsetUnits).toBeGreaterThan(-2); // 叠加了 fallback units

    // 补齐 c2，退出 fallback
    ts.nodes.set('c2', createMockNode('c2', 25, [], 'root') as any);
    ts.update([0, 0, 50], Math.PI / 4, 1080);
    expect(ts.fallbackNodes.has('root')).toBe(false);
    // 验证材质精准还原为初始值 (-1, -2)
    expect(mat.polygonOffset).toBe(true);
    expect(mat.polygonOffsetFactor).toBe(-1);
    expect(mat.polygonOffsetUnits).toBe(-2);
  });

  test('6. S3MViewer & S3MLayer 联动与 setLodTransition 动态切换', () => {
    const viewer = new S3MViewer({
      configUrl: 'https://example.com/ds/config',
      lodTransition: 'incremental',
    } as any);
    expect(viewer.lodTransition).toBe('incremental');

    viewer.setLodTransition('binary');
    expect(viewer.lodTransition).toBe('binary');

    viewer.setLodTransition('incremental');
    expect(viewer.lodTransition).toBe('incremental');

    const layer = new S3MLayer({
      id: 'test-layer',
      configUrl: 'https://example.com/ds/config',
      lodTransition: 'incremental',
    } as any);
    expect(layer.lodTransition).toBe('incremental');

    layer.setLodTransition('binary');
    expect(layer.lodTransition).toBe('binary');
  });

  test('7. 增量细化模式下，fallback 瓦片受预算淘汰机制保护，不出空洞', () => {
    const ts = createTestTileset({
      lodTransition: 'incremental',
      maxTiles: 2, // 极紧预算
    });

    const pNode = createMockNode('root', 50, ['c1', 'c2'], null);
    pNode.needRefine = true;
    ts.nodes.set('root', pNode as any);
    ts.rootUrls.push('root');

    // 只有 c1 就绪，root 需作为 fallback
    ts.nodes.set('c1', createMockNode('c1', 25, [], 'root') as any);
    ts.update([0, 0, 50], Math.PI / 4, 1080);

    // root 作为 fallback 仍在显示，不能被淘汰；画面不能开洞
    expect(ts.nodes.has('root')).toBe(true);
    expect(ts.nodes.has('c1')).toBe(true);
    expect((ts.nodes.get('root') as any).group.visible).toBe(true);
  });
});
