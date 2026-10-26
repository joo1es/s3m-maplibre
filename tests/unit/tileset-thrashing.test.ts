/**
 * 单元测试：瓦片淘汰统计指标递减与防无限死循环加载 (Thrashing Loop Prevention)
 *
 * 验证：
 * 1. 瓦片节点在 _evictTileNode 淘汰时，stats.tiles、stats.meshes、stats.vertices、stats.triangles 同步扣减，
 *    彻底解决淘汰-重入队过程中三角面数与瓦片数单调无限膨胀的 bug；
 * 2. 淘汰挑选 (_pickVictim) 策略：
 *    优先淘汰已经被子节点完全接管渲染的不可见父节点 (refined = true)，而不是优先踢掉正在显示的活跃叶子节点；
 * 3. 淘汰时不再盲目把上一级父瓦片重新塞回队列，避免在有限预算 (maxTiles) 下发生父子节点乒乓下载死循环。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MTileset, type TileNode } from '../../packages/s3m-three/src/tileset/S3MTileset';

function createMockTileNode(url: string, triangles = 1000, meshes = 1, vertices = 800): TileNode {
  const group = new THREE.Group();
  const geom = new THREE.BufferGeometry();
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geom, mat);
  group.add(mesh);

  return {
    url,
    tile: {} as any,
    group,
    sphere: { center: { x: 0, y: 0, z: 0 }, radius: 100 },
    rangeValue: 100,
    rangeMode: 1,
    childUrls: [],
    state: 'ready',
    stats: { meshes, vertices, triangles },
  };
}

describe('瓦片淘汰统计与防循环加载 (Tileset Thrashing Prevention)', () => {
  test('1. 瓦片淘汰时 stats 指标（tiles, meshes, vertices, triangles）正确扣减', () => {
    const ts = new S3MTileset({ configUrl: 'http://localhost/config.json' }) as any;

    expect(ts.stats.tiles).toBe(0);
    expect(ts.stats.triangles).toBe(0);

    const node1 = createMockTileNode('tile_1.s3m', 1500, 2, 1000);
    const node2 = createMockTileNode('tile_2.s3m', 3000, 3, 2000);

    // 模拟注册
    ts.nodes.set(node1.url, node1);
    ts.stats.tiles++;
    ts.stats.meshes += node1.stats.meshes;
    ts.stats.vertices += node1.stats.vertices;
    ts.stats.triangles += node1.stats.triangles;

    ts.nodes.set(node2.url, node2);
    ts.stats.tiles++;
    ts.stats.meshes += node2.stats.meshes;
    ts.stats.vertices += node2.stats.vertices;
    ts.stats.triangles += node2.stats.triangles;

    expect(ts.stats.tiles).toBe(2);
    expect(ts.stats.meshes).toBe(5);
    expect(ts.stats.vertices).toBe(3000);
    expect(ts.stats.triangles).toBe(4500);

    // 淘汰 node1
    ts._evictTileNode(node1);
    expect(ts.stats.tiles).toBe(1);
    expect(ts.stats.meshes).toBe(3);
    expect(ts.stats.vertices).toBe(2000);
    expect(ts.stats.triangles).toBe(3000);

    // 淘汰 node2
    ts._evictTileNode(node2);
    expect(ts.stats.tiles).toBe(0);
    expect(ts.stats.meshes).toBe(0);
    expect(ts.stats.vertices).toBe(0);
    expect(ts.stats.triangles).toBe(0);
  });

  test('2. 淘汰候选优先挑已被子瓦接管的父瓦片，保留活跃显示的叶子瓦片', () => {
    const ts = new S3MTileset({ configUrl: 'http://localhost/config.json' }) as any;

    const parentUrl = 'http://localhost/parent.s3m';
    const childUrl = 'http://localhost/child.s3m';

    const parent = createMockTileNode(parentUrl, 100);
    parent.childUrls = [childUrl];
    parent.group.visible = false; // 已被子节点接替，父节点隐藏

    const child = createMockTileNode(childUrl, 1000);
    child.parentUrl = parentUrl;
    child.group.visible = true; // 正在显示

    ts.nodes.set(parentUrl, parent);
    ts.nodes.set(childUrl, child);

    // _pickVictim 应能识别已被覆盖接管的父瓦片 (allowRefined = true)
    const victim = ts._pickVictim(true, false);
    expect(victim).not.toBeNull();
    expect(victim.url).toBe(parentUrl);

    // 叶子瓦片由于正在显示且无子瓦接手，不能作为非安全候选被误踢
    const leafVictim = ts._pickVictim(false, false);
    expect(leafVictim).toBeNull();
  });

  test('3. 淘汰叶子时不再无脑重新入队父瓦片引发无限加载循环', () => {
    const ts = new S3MTileset({ configUrl: 'http://localhost/config.json', maxTiles: 2 }) as any;

    const parentUrl = 'http://localhost/parent.s3m';
    const leafUrl = 'http://localhost/leaf.s3m';

    const leaf = createMockTileNode(leafUrl, 500);
    leaf.parentUrl = parentUrl;
    leaf.group.visible = false; // 隐藏或非激活

    ts.nodes.set(leafUrl, leaf);
    ts._parentOf.set(leafUrl, parentUrl);

    // 模拟触发淘汰
    ts._evictOne(true);

    // 队列中绝不能自动重新加入 parentUrl
    expect(ts._queue).not.toContain(parentUrl);
    expect(ts.pending.has(parentUrl)).toBe(false);
  });
});
