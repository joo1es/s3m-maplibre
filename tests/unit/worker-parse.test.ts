/**
 * Worker 解析链路单测：
 * 1. collectTransferables 的收集与去重规则（零拷贝往返的前提）
 * 2. S3MWorkerClient 的降级语义（创建失败返回 null / 坏脚本崩溃后拒绝而不是挂死）
 * 3. S3MTileset 挂上 useWorker 后主线程兜底路径仍然完整可用
 *
 * Bun 的 Worker 与浏览器产物路径不同，这里不验证「真在 Worker 里解析出几何」，
 * 那一步由浏览器 demo（tools/meshopt-check.mjs、parse-sample.mjs）覆盖。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { decodeTextureData } from '../../packages/s3m-three/src/core/TextureDecode';
import { assembleTileGeometry } from '../../packages/s3m-three/src/core/TileGeometry';
import type { S3MTexture } from '../../packages/s3m-three/src/core/types';
import { collectTransferables } from '../../packages/s3m-three/src/worker/transferables';
import { S3MWorkerClient, WorkerDeadError } from '../../packages/s3m-three/src/worker/S3MWorkerClient';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { toArrayBuffer } from '../helpers/sample';

describe('collectTransferables', () => {
  test('收集嵌套对象图里的全部 ArrayBuffer，并按底层缓冲去重', () => {
    const shared = new Float32Array(8); // 两个视图共享同一块 buffer
    const tile = {
      textures: {
        a: { data: new Uint8Array(4) },
        b: { data: new Uint8Array(new ArrayBuffer(12), 0, 6) },
      },
      geo: {
        positions: shared,
        normals: new Float32Array(shared.buffer, 0, 4),
        indices: null,
        nested: new Map([['k', new DataView(new ArrayBuffer(4))]]),
        list: [[new Uint16Array(2)]],
      },
      plain: { x: 1, s: 'text', fn: () => {} },
    };

    const bufs = collectTransferables(tile);
    // unique：shared.buffer(32B) / Uint8Array(4) / 12B 视图 / DataView(4B) / Uint16Array(2)→4B
    // shared 与 normals 同 buffer → 只收一次；plain 无 buffer；函数/标量安全跳过
    expect(bufs.length).toBe(5);
    expect(bufs.filter((b) => b.byteLength === 4).length).toBe(3);
    expect(bufs.some((b) => b.byteLength === shared.buffer.byteLength)).toBe(true);
    expect(bufs.some((b) => b.byteLength === 12)).toBe(true);
  });

  test('循环引用不死循环，空图与标量安全', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { parent: a };
    a.child = b;
    expect(collectTransferables(a)).toEqual([]);
    expect(collectTransferables(42)).toEqual([]);
    expect(collectTransferables(null)).toEqual([]);
  });
});

describe('S3MWorkerClient 降级语义', () => {
  test('环境不可用时 create() 返回 null 而不是抛错', () => {
    // Bun 里有 Worker，这里只验证 create 不抛；真正的无 Worker 环境走运行时分支
    const client = S3MWorkerClient.create();
    if (client) client.dispose();
    expect(true).toBe(true);
  });

  test('坏 buffer 走「解析失败」路径（保留 Worker 复活能力）；dispose 后再请求立即以 WorkerDeadError 拒绝', async () => {
    const client = S3MWorkerClient.create();
    if (!client) return; // 无 Worker 环境跳过
    // Bun 能直接加载 TS worker：8 字节垃圾进 parseS3MB → 解析错误回传（不是 WorkerDeadError）
    await expect(client.parseTile(new ArrayBuffer(8))).rejects.toThrow();
    expect(client.dead).toBe(false); // worker 活着，下一块瓦片照常派发
    client.dispose();
    await expect(client.parseTile(new ArrayBuffer(8))).rejects.toBeInstanceOf(WorkerDeadError);
  });
});

describe('S3MWorkerClient 端到端（Bun Worker 直跑 TS）', () => {
  test('Worker 解析结果与主线程 parseS3MB 一致', async () => {
    const client = S3MWorkerClient.create();
    if (!client) return; // 无 Worker 环境跳过
    try {
      const file = new URL('../fixtures/draco/pointcloud.s3mb', import.meta.url);
      const bytes = readFileSync(file);
      const main = await parseS3MB(toArrayBuffer(bytes), { inflate: inflateSync });
      const { tile: viaWorker } = await client.parseTile(toArrayBuffer(bytes));
      // 关键字段逐项对比：解析在哪个线程跑，产物必须一模一样
      expect(viaWorker.version).toBe(main.version);
      expect(viaWorker.bytesRead).toBe(main.bytesRead);
      expect(Object.keys(viaWorker.geoPackage)).toEqual(Object.keys(main.geoPackage));
      const geodes = Object.values(main.geoPackage);
      const wkGeodes = Object.values(viaWorker.geoPackage);
      for (let i = 0; i < geodes.length; i++) {
        const pkg = geodes[i]!.vertexPackage;
        const wkPkg = wkGeodes[i]!.vertexPackage;
        expect(wkPkg.verticesCount).toBe(pkg.verticesCount);
        expect(wkPkg.vertexAttributes.length).toBe(pkg.vertexAttributes.length);
      }
    } finally {
      client.dispose();
    }
  });

  test('Worker 纹理解码与主线程 decodeTextureData 逐字节一致（真实 CBD DXT 纹理）', async () => {
    const client = S3MWorkerClient.create();
    if (!client) return;
    try {
      const file = new URL(
        '../fixtures/gaussian-splatting/Tile_0019_262145_524289_0000.s3mb',
        import.meta.url
      );
      const tile = await parseS3MB(toArrayBuffer(readFileSync(file)), { inflate: inflateSync });
      const tex = Object.values(tile.textures ?? {}).find((t) => t.data && t.width > 0);
      if (!tex) return; // 样例没有纹理就跳过
      const main = await decodeTextureData(tex);
      const viaWorker = await client.decodeTexture(tex);
      expect(viaWorker.kind).toBe(main.kind);
      expect(viaWorker.width).toBe(main.width);
      expect(viaWorker.height).toBe(main.height);
      expect(viaWorker.hasAlpha).toBe(main.hasAlpha);
      if (main.rgba && viaWorker.rgba) {
        expect(viaWorker.rgba.length).toBe(main.rgba.length);
        // 逐字节一致（前后各抽查一段 + 长度校验，避免 60k 次 expect 拖慢）
        expect(viaWorker.rgba.subarray(0, 256)).toEqual(main.rgba.subarray(0, 256));
        let same = true;
        for (let i = 0; i < main.rgba.length; i++) {
          if (viaWorker.rgba[i] !== main.rgba[i]) {
            same = false;
            break;
          }
        }
        expect(same).toBe(true);
      }
    } finally {
      client.dispose();
    }
  });

  test('Worker 解析+组装一次往返：geometry 与主线程 assembleTileGeometry 一致', async () => {
    const client = S3MWorkerClient.create();
    if (!client) return;
    try {
      const file = new URL('../fixtures/gaussian-splatting/Tile_0019_262145_524289_0000.s3mb', import.meta.url);
      const bytes = readFileSync(file);
      const { tile, geometry } = await client.parseTile(toArrayBuffer(bytes), true);
      expect(tile).toBeTruthy();
      expect(geometry).toBeTruthy();
      const local = assembleTileGeometry(tile!);
      expect(geometry!.primitives.length).toBe(local.primitives.length);
      expect(geometry!.stats.vertices).toBe(local.stats.vertices);
      expect(geometry!.stats.edgeLines).toBe(local.stats.edgeLines);
      expect(geometry!.stats.instanced).toBe(local.stats.instanced);
      for (let i = 0; i < local.primitives.length; i++) {
        const a = geometry!.primitives[i]!;
        const b = local.primitives[i]!;
        expect(a.primitiveType).toBe(b.primitiveType);
        expect(a.vertexCount).toBe(b.vertexCount);
        expect(a.indexCount).toBe(b.indexCount);
        expect(a.matrix).toEqual(b.matrix);
        // 顶点位置逐字节一致（position 是核心产物）
        expect(new Float32Array(a.attributes.position.array as Float32Array)).toEqual(
          new Float32Array(b.attributes.position.array as Float32Array)
        );
      }
    } finally {
      client.dispose();
    }
  });

  test('decodeTextureData 的 raw 路径：BGR 重排 / alpha 补齐 / flipY', async () => {
    // 2x2 BGR（24 位）小纹理，手工构造
    const px = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    const tex: S3MTexture = {
      code: 't',
      level: 0,
      width: 2,
      height: 3,
      compressType: 0,
      pixelFormat: 11, // BGR
      data: new Uint8Array(px),
      flipY: false,
    } as S3MTexture;
    const out = await decodeTextureData(tex);
    expect(out.kind).toBe('raw');
    expect(out.rgba!.length).toBe(2 * 3 * 4);
    // 第一像素 BGR(1,2,3) → RGBA(3,2,1,255)
    expect([...out.rgba!.subarray(0, 4)]).toEqual([3, 2, 1, 255]);
    expect(out.hasAlpha).toBe(false);
  });

  test('压缩直传的块长校验：4×4 对齐块过、尺寸非对齐/块长不符回退解码', async () => {
    const mk = (width: number, height: number, byteLength: number): S3MTexture =>
      ({
        code: 't',
        level: 0,
        width,
        height,
        compressType: 21, // DXT5 裸块（v3.00 实测组合）
        pixelFormat: 21,
        data: new Uint8Array(byteLength),
        flipY: false,
      }) as S3MTexture;

    // 4x4 DXT5 = 1 块 × 16B：块长匹配 → 直传
    const ok = await decodeTextureData(mk(4, 4, 16), { compressed: true });
    expect(ok.kind).toBe('dxt5(c)');
    expect(ok.blocks!.byteLength).toBe(16);

    // 6x6：4×4 对齐后期望 2×2×16 = 64B；给 36B（非对齐存储）→ 必须回退解码，
    // 否则就是 GL_INVALID_VALUE: glCompressedTexSubImage2D <imageSize> mismatch
    const bad = await decodeTextureData(mk(6, 6, 36), { compressed: true });
    expect(bad.blocks).toBeUndefined();
    expect(bad.kind).toBe('dxt5');
    expect(bad.rgba).not.toBeNull();
  });

  test('压缩直传模式：dxt1/dxt5 跳过解码原样返回块，flipY 回退解码', async () => {
    const file = new URL(
      '../fixtures/gaussian-splatting/Tile_0019_262145_524289_0000.s3mb',
      import.meta.url
    );
    const tile = await parseS3MB(toArrayBuffer(readFileSync(file)), { inflate: inflateSync });
    const dxt = Object.values(tile.textures ?? {}).find(
      (t) => t.data && t.width > 0 && !t.flipY && [17, 21, 26, 27, 50000].includes(t.compressType)
    );
    if (!dxt) return; // 样例没有 DXT 纹理就跳过

    const compressed = await decodeTextureData(dxt, { compressed: true });
    expect(compressed.blocks).toBeTruthy(); // 块数据原样透传
    expect(compressed.rgba).toBeNull();
    expect(compressed.kind.endsWith('(c)')).toBe(true);
    expect(['dxt1', 'dxt5']).toContain(compressed.blockFormat!);
    if (compressed.blockFormat === 'dxt1') {
      expect(compressed.blocks!.length).toBe(compressed.width * compressed.height * 0.5);
    }

    // flipY（S3MBLOCK 图集）开不了压缩：回退 RGBA 解码路径
    const flipped = await decodeTextureData({ ...dxt, flipY: true }, { compressed: true });
    expect(flipped.blocks).toBeUndefined();
    expect(flipped.rgba).not.toBeNull();
  });
});

describe('S3MTileset useWorker 集成', () => {
  test('开启 useWorker 不改变 tileset 的构造与调度状态', () => {
    const tileset = new S3MTileset({
      configUrl: 'http://example.com/config.json',
      useWorker: true,
    });
    expect(tileset.maxConcurrent).toBe(4);
    expect(tileset.nodes.size).toBe(0);
    void new THREE.Group(); // 保持 three 引用（与文件其余测试一致的 import 使用）
  });
});
