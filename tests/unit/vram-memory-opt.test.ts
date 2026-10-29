/**
 * 单元测试：显存与内存优化 (VRAM & Memory Optimization)
 *
 * 验证：
 * 1. 瓦片注销时的显存释放彻底性：
 *    - THREE.Mesh、THREE.Points（点云/高斯泼溅）、THREE.LineSegments（棱线）及其嵌套子节点的 geometry 与 material 均必须调用 dispose()；
 * 2. 瓦片淘汰时的纹理显存释放（引用计数）：
 *    - 瓦片淘汰（_evictOne）时，若其引用的纹理已无其他存活瓦片使用，必须调用 texture.dispose() 并从 textureCache 中移除；
 *    - 多瓦片共享同一张纹理时，仅在最后一块瓦片淘汰时才真正 dispose，不能提前误杀；
 * 3. 多图层/数据集的全局瓦片预算控制（防止图层叠多爆显存）：
 *    - S3MViewer 支持 totalMaxTiles 全局预算；
 *    - 多数据集并存时，自动在所有可见数据集之间均衡分配各数据集的 maxTiles；
 *    - 数据集设为不可见（visible = false）时，预算动态回收给可见数据集，且不可见数据集的驻留瓦片可被回收；
 * 4. 原始图像缓存（leafRequestCache / externalAtlasCache）的容量上限（LRU/上限控制）：
 *    - 防止数以千计的子瓦片请求拉取大批量未压缩 RGBA 数组挤爆 JS 堆内存。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';

describe('显存与内存优化 (VRAM & Memory Optimization)', () => {
  describe('1. 瓦片注销时所有几何与材质彻底释放', () => {
    test('_unregisterTile 必须彻底递归释放 Mesh、Points、LineSegments 及其材质', () => {
      const viewer = new S3MViewer() as any;

      let geomDisposedCount = 0;
      let matDisposedCount = 0;

      const mockGeom = () => {
        const g = new THREE.BufferGeometry();
        g.dispose = () => { geomDisposedCount++; };
        return g;
      };

      const mockMat = () => {
        const m = new THREE.MeshBasicMaterial();
        m.dispose = () => { matDisposedCount++; };
        return m;
      };

      // 构造包含 Mesh、Points、LineSegments 以及嵌套 Group 的复杂瓦片节点
      const rootGroup = new THREE.Group();

      const mesh = new THREE.Mesh(mockGeom(), mockMat());
      mesh.userData = { pickId: 10 };
      rootGroup.add(mesh);

      // 点云对象（以往 if (!mesh.isMesh) continue 会直接漏掉 Points 和 Lines）
      const points = new THREE.Points(mockGeom(), mockMat());
      rootGroup.add(points);

      // 嵌套 Group 中的 LineSegments（棱线）
      const subGroup = new THREE.Group();
      const lines = new THREE.LineSegments(mockGeom(), mockMat());
      subGroup.add(lines);
      rootGroup.add(subGroup);

      const tileNode = {
        url: 'tile_complex.s3mb',
        group: rootGroup,
        tile: {},
      };

      const mockEntry = {
        id: 'ds1',
        root: new THREE.Group(),
      };
      mockEntry.root.add(rootGroup);

      // 执行注销
      viewer._unregisterTile(tileNode, mockEntry);

      // 3 个几何体（Mesh, Points, Lines）必须全部被 dispose
      expect(geomDisposedCount).toBe(3);
      // 3 个材质必须全部被 dispose
      expect(matDisposedCount).toBe(3);
      // 从 entry.root 中移除
      expect(mockEntry.root.children.length).toBe(0);
    });
  });

  describe('2. S3MTileset 纹理引用计数与淘汰释放', () => {
    test('单瓦片独占纹理在瓦片淘汰时自动 dispose 并从 cache 移除', () => {
      let disposed = false;
      const tex = new THREE.Texture();
      tex.dispose = () => { disposed = true; };

      const ts = new S3MTileset({
        configUrl: 'http://example.com/config.json',
        maxTiles: 2,
      }) as any;

      ts.textureCache.set('tex_A', tex);

      // 创建一个引用该纹理的瓦片
      const nodeA = {
        url: 'tile_A.s3mb',
        group: new THREE.Group(),
        textureUrls: ['tex_A'],
        childUrls: [],
        lastSeen: 0,
        distance: 100,
        needRefine: false,
      };
      ts.registerTileTextures(nodeA.url, ['tex_A']);
      ts.nodes.set('tile_A.s3mb', nodeA);

      // 淘汰 tile_A
      ts._evictTileNode(nodeA);

      // 纹理计数归零，必须被释放
      expect(disposed).toBe(true);
      expect(ts.textureCache.has('tex_A')).toBe(false);
    });

    test('多瓦片共享纹理在最后一块瓦片淘汰前不释放，全部淘汰后释放', () => {
      let disposeCount = 0;
      const tex = new THREE.Texture();
      tex.dispose = () => { disposeCount++; };

      const ts = new S3MTileset({
        configUrl: 'http://example.com/config.json',
        maxTiles: 5,
      }) as any;

      ts.textureCache.set('shared_tex', tex);

      const nodeA = {
        url: 'tile_A.s3mb',
        group: new THREE.Group(),
        childUrls: [],
      };
      const nodeB = {
        url: 'tile_B.s3mb',
        group: new THREE.Group(),
        childUrls: [],
      };

      ts.registerTileTextures(nodeA.url, ['shared_tex']);
      ts.registerTileTextures(nodeB.url, ['shared_tex']);
      ts.nodes.set('tile_A.s3mb', nodeA);
      ts.nodes.set('tile_B.s3mb', nodeB);

      // 淘汰 nodeA
      ts._evictTileNode(nodeA);
      expect(disposeCount).toBe(0); // 还有 nodeB 在用，不能 dispose
      expect(ts.textureCache.has('shared_tex')).toBe(true);

      // 淘汰 nodeB
      ts._evictTileNode(nodeB);
      expect(disposeCount).toBe(1); // 最后一个瓦片也淘汰了，必须释放
      expect(ts.textureCache.has('shared_tex')).toBe(false);
    });
  });

  describe('3. 多数据集全局瓦片预算控制 (Global Tile Budget)', () => {
    test('S3MViewer 支持 totalMaxTiles 并均衡分配给各数据集', () => {
      const viewer = new S3MViewer({
        totalMaxTiles: 60,
      }) as any;

      const dm = viewer._datasetManager;

      // 注册 3 个数据集
      dm.registerDataset({ id: 'ds1', configUrl: 'http://example.com/1/config' });
      dm.registerDataset({ id: 'ds2', configUrl: 'http://example.com/2/config' });
      dm.registerDataset({ id: 'ds3', configUrl: 'http://example.com/3/config' });

      // 模拟 tileset 初始化完成
      for (const entry of dm.values()) {
        entry.tileset = new S3MTileset({ configUrl: entry.options.configUrl }) as any;
      }

      // 重新平衡预算
      dm.rebalanceBudgets();

      // 每个数据集应该分到 60 / 3 = 20
      for (const entry of dm.values()) {
        expect(entry.tileset.maxTiles).toBe(20);
      }
    });

    test('数据集设为不可见 (visible = false) 时，预算回收给剩余可见数据集', () => {
      const viewer = new S3MViewer({
        totalMaxTiles: 60,
      }) as any;

      const dm = viewer._datasetManager;
      dm.registerDataset({ id: 'ds1', configUrl: 'http://example.com/1/config' });
      dm.registerDataset({ id: 'ds2', configUrl: 'http://example.com/2/config' });
      for (const entry of dm.values()) {
        entry.tileset = new S3MTileset({ configUrl: entry.options.configUrl }) as any;
      }

      dm.rebalanceBudgets();
      expect(dm.get('ds1').tileset.maxTiles).toBe(30);
      expect(dm.get('ds2').tileset.maxTiles).toBe(30);

      // 隐藏 ds2
      viewer.setDatasetVisible('ds2', false);

      // 此时所有 60 个配额全给唯一可见的 ds1
      expect(dm.get('ds1').tileset.maxTiles).toBe(60);
      // 不可见数据集配额降为保底极低值（例如 0 或 1）
      expect(dm.get('ds2').tileset.maxTiles).toBeLessThanOrEqual(4);
    });
  });

  describe('4. 原始图像缓存容量上限控制', () => {
    test('leafRequestCache 和 externalAtlasCache 超过容量上限时自动淘汰旧缓存', () => {
      const ts = new S3MTileset({
        configUrl: 'http://example.com/config',
        maxImageCache: 3, // 设置小上限测试淘汰
      }) as any;

      // 填入 4 个外部图集记录
      ts.putExternalAtlas('atlas1', { data: new Uint8Array(10), width: 1, height: 1 } as any);
      ts.putExternalAtlas('atlas2', { data: new Uint8Array(10), width: 1, height: 1 } as any);
      ts.putExternalAtlas('atlas3', { data: new Uint8Array(10), width: 1, height: 1 } as any);
      ts.putExternalAtlas('atlas4', { data: new Uint8Array(10), width: 1, height: 1 } as any);

      // 超过 maxImageCache (3)，最早的 atlas1 必须被清理
      expect(ts.getExternalAtlas('atlas1')).toBeUndefined();
      expect(ts.getExternalAtlas('atlas4')).toBeDefined();
    });
  });

  describe('5. 显存字节级预算式主动回收 (VRAM Byte Budget - maxMemory)', () => {
    test('maxMemory 默认 Infinity = 不限制，支持动态调整', () => {
      const ts = new S3MTileset({
        configUrl: 'http://example.com/config',
      }) as any;

      expect(ts.maxMemory).toBe(Infinity);
      ts.setMaxMemory(1024 * 1024 * 512);
      expect(ts.maxMemory).toBe(1024 * 1024 * 512);

      // 非法或负数回退为 Infinity
      ts.setMaxMemory(-1);
      expect(ts.maxMemory).toBe(Infinity);
      ts.setMaxMemory(0);
      expect(ts.maxMemory).toBe(Infinity);
    });

    test('超显存预算时主动触发 make-before-break 淘汰非显示瓦片', () => {
      const ts = new S3MTileset({
        configUrl: 'http://example.com/config',
        maxTiles: 100, // 瓦片数充足，不因瓦片数淘汰
      }) as any;

      // 构造父瓦片 root：1000 顶点 (12000 字节) + 1 张 256KB 纹理
      const geoParent = new THREE.BufferGeometry();
      geoParent.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3000), 3));
      const groupParent = new THREE.Group();
      groupParent.add(new THREE.Mesh(geoParent));
      const texParent = new THREE.Texture();
      (texParent as any).image = { width: 512, height: 512, data: new Uint8Array(262144) };

      ts.textureCache.set('tex_root', texParent);
      ts.registerTileTextures('root.s3mb', ['tex_root']);

      const nodeParent = {
        url: 'root.s3mb',
        group: groupParent,
        childUrls: ['c1.s3mb'],
        lastSeen: 1,
        stats: { meshes: 1, vertices: 1000, triangles: 1000, memory: 12000 },
      };
      groupParent.visible = false; // 已被子瓦替换，不显示

      // 构造子瓦片 c1：正在显示
      const geoChild = new THREE.BufferGeometry();
      geoChild.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3000), 3));
      const groupChild = new THREE.Group();
      groupChild.add(new THREE.Mesh(geoChild));
      groupChild.visible = true;

      const nodeChild = {
        url: 'c1.s3mb',
        group: groupChild,
        parentUrl: 'root.s3mb',
        childUrls: [],
        lastSeen: 2,
        stats: { meshes: 1, vertices: 1000, triangles: 1000, memory: 12000 },
      };

      ts.nodes.set('root.s3mb', nodeParent);
      ts.nodes.set('c1.s3mb', nodeChild);

      // 总内存 = 12000 (parent) + 12000 (child) + 262144 (tex_root) = 286144 字节
      expect(ts.residentMemory()).toBe(286144);

      // 设置 maxMemory 为 100000 字节（低于总显存，但大于子瓦片的 12000 字节）
      ts.setMaxMemory(100000);

      // 触发预算裁剪
      const trimmed = ts._trimBudget();
      expect(trimmed).toBe(true);

      // 父瓦片被安全淘汰，子瓦片继续保留（不破坏显示）
      expect(ts.nodes.has('root.s3mb')).toBe(false);
      expect(ts.nodes.has('c1.s3mb')).toBe(true);
      // 纹理引用归零，tex_root 也被清理，显存回落到 12000 <= 100000
      expect(ts.residentMemory()).toBe(12000);
      expect(ts.residentMemory()).toBeLessThanOrEqual(ts.maxMemory);
    });

    test('S3MViewer / S3MLayer 转发 setMaxMemory', () => {
      const viewer = new S3MViewer({
        maxMemory: 512 * 1024 * 1024,
      }) as any;

      expect(viewer.maxMemory).toBe(512 * 1024 * 1024);

      const dm = viewer._datasetManager;
      dm.registerDataset({ id: 'ds1', configUrl: 'http://example.com/1/config' });
      const entry = dm.get('ds1')!;
      entry.tileset = new S3MTileset({ configUrl: entry.options.configUrl }) as any;

      viewer.setMaxMemory(256 * 1024 * 1024);
      expect(viewer.maxMemory).toBe(256 * 1024 * 1024);
      expect(entry.tileset.maxMemory).toBe(256 * 1024 * 1024);
    });
  });
});
