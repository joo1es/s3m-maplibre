/**
 * #35 S3MBLOCK 容器解析搬进 Worker
 *
 * 经典 .s3mb 早就走 Worker 了，S3MBLOCK 这条还留在主线程（`TileSource.load` 直接
 * `await parseS3MBlockGroups(buffer)`）。一个块最多 4096 组、每组 inflate + 解析，
 * 拉近转视角加载新块时主线程会顿一下。
 *
 * 这里不依赖真实 Worker / 合法 .s3mblock 字节：注入假 client、用故意非法的 buffer，
 * 走 Worker 分支就该拿到假结果，退回主线程解析则必然抛错。这样接缝、降级语义、
 * 错误分流都能在单测里精确观测。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseS3MBlockGroups } from '../../packages/s3m-three/src/core/S3MBlockParser';
import { toArrayBuffer } from '../helpers/sample';
import { TileSource } from '../../packages/s3m-three/src/tileset/TileSource';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { S3MWorkerClient, WorkerDeadError } from '../../packages/s3m-three/src/worker/S3MWorkerClient';
import { collectTransferables } from '../../packages/s3m-three/src/worker/transferables';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 故意非法的字节：主线程 parseS3MBlockGroups 一定会抛 */
const badBuffer = () => new ArrayBuffer(8);

const fakeSet = (tag: string) => ({
  tiles: [{ blockName: tag, texturePackage: {}, geoPackage: {} }],
  names: [tag],
}) as any;

function mkSource(useWorker = true) {
  const host: any = {
    authenticate: undefined,
    groupCache: new Map<string, any>(),
    useWorker: () => useWorker,
    vertexAttributeDescript: () => undefined,
    classicParser: async () => ({ tile: {} }),
    blockParser: (buf: ArrayBuffer) => source.parseBlockGroups(buf),
  };
  const source = new TileSource(host, null);
  return { source, host };
}

/** 往 TileSource 私有字段塞一个假 client，避开真实 Worker 创建 */
function injectClient(source: TileSource, client: any) {
  (source as any)._workerClient = client;
}

describe('#35 S3MBLOCK Worker 化 · TileSource 解析分支', () => {
  test('Worker 可用时走 client.parseBlock，结果原样透传，主线程解析一次都不跑', async () => {
    const { source } = mkSource();
    let calls = 0;
    let seen: ArrayBuffer | null = null;
    injectClient(source, {
      dead: false,
      parseBlock: async (buf: ArrayBuffer) => {
        calls++;
        seen = buf;
        return fakeSet('from-worker');
      },
    });

    const buf = badBuffer();
    const set = await (source as any).parseBlockGroups(buf);

    expect(calls).toBe(1);
    expect(seen).toBe(buf);
    expect(set.names).toEqual(['from-worker']);
  });

  test('useWorker=false 时不碰 Worker，退回主线程解析', async () => {
    const { source } = mkSource(false);
    let calls = 0;
    injectClient(source, {
      dead: false,
      parseBlock: async () => { calls++; return fakeSet('should-not-be-used'); },
    });

    await expect((source as any).parseBlockGroups(badBuffer())).rejects.toThrow();
    expect(calls).toBe(0);
    // 主线程兜底跑过（无效字节抛错），说明确实没走假 client
  });

  test('WorkerDeadError 永久降级：置 null 后不再给这个 client 发活', async () => {
    const { source } = mkSource();
    let calls = 0;
    injectClient(source, {
      dead: false,
      parseBlock: async () => { calls++; throw new WorkerDeadError('dead'); },
    });

    await expect((source as any).parseBlockGroups(badBuffer())).rejects.toThrow();
    expect((source as any)._workerClient).toBe(null);

    // 第二次直接走主线程，不该再尝试 Worker
    await expect((source as any).parseBlockGroups(badBuffer())).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('普通解析错误原样抛，不触发降级（与主线程 parseS3MB 口径一致）', async () => {
    const { source } = mkSource();
    const err = new Error('bad bytes');
    injectClient(source, {
      dead: false,
      parseBlock: async () => { throw err; },
    });

    await expect((source as any).parseBlockGroups(badBuffer())).rejects.toBe(err);
    expect((source as any)._workerClient).not.toBe(null);
  });

  test('经典 .s3mb 的 Worker 路径不受影响（共享同一个 client 取值逻辑）', async () => {
    const { source } = mkSource();
    let calls = 0;
    injectClient(source, {
      dead: false,
      parseTile: async () => { calls++; return { tile: { from: 'worker' } }; },
    });

    const out = await source.parseClassicTile(badBuffer());
    expect(calls).toBe(1);
    expect((out.tile as any).from).toBe('worker');
  });
});

describe('#35 S3MBLOCK Worker 化 · load() 接缝与块缓存', () => {
  test('load() 走宿主回注的 blockParser；同名 #N 命中缓存零请求', async () => {
    const { source, host } = mkSource();
    let fetches = 0;
    let parsed = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(new Uint8Array(8), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }) as never;
    host.blockParser = async (buf: ArrayBuffer) => {
      parsed++;
      expect(buf.byteLength).toBe(8);
      return fakeSet('block-a');
    };

    const first = await source.load('https://example.com/a.s3mblock');
    expect(parsed).toBe(1);
    expect(fetches).toBe(1);
    expect(first.isBlock).toBe(true);
    expect(first.groupNames).toEqual(['block-a']);
    expect((first.tile as any).blockName).toBe('block-a');

    // 同一个块文件里的第 2 组：命中 groupCache，不再发请求、不再解析
    const second = await source.load('https://example.com/a.s3mblock#2');
    expect(fetches).toBe(1);
    expect(parsed).toBe(1);
    expect((second.tile as any).blockName).toBe('block-a');
    expect(host.groupCache.has('https://example.com/a.s3mblock')).toBe(true);
  });

  test('S3MTileset 有 _parseBlockGroups 转发点，stub 后能被 load() 接缝看到', async () => {
    const ts = new S3MTileset({
      configUrl: 'https://example.com/ds/config',
      maxConcurrent: 1,
      buildTile: (async () => ({ group: null, stats: {} })) as never,
      onError: () => {},
    }) as any;

    expect(typeof ts._parseBlockGroups).toBe('function');

    let hit = 0;
    ts._source.parseBlockGroups = async () => { hit++; return fakeSet('forwarded'); };
    const set = await ts._parseBlockGroups(badBuffer());
    expect(hit).toBe(1);
    expect(set.names).toEqual(['forwarded']);
  });
});

describe('#35 S3MBLOCK Worker 化 · 客户端协议与零拷贝', () => {
  test('client.parseBlock 发 type:block 请求，并按 set 分派响应', async () => {
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      posted: any[] = [];
      postMessage(msg: any) { this.posted.push(msg); }
      terminate() {}
    }
    const worker = new FakeWorker();
    // 构造函数是 private，运行时直接造一个挂假 worker 的 client
    const client = new (S3MWorkerClient as any)(worker) as S3MWorkerClient;

    const buf = badBuffer();
    const pending = client.parseBlock(buf);
    expect(worker.posted[0]).toEqual({ type: 'block', id: 1, buffer: buf });

    const set = fakeSet('over-wire');
    worker.onmessage?.({ data: { id: 1, ok: true, set } });
    expect(await pending).toEqual(set);
  });

  test('块解析产物可零拷贝传输：typed array 的 buffer 会被收进清单', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const set = {
      tiles: [{ texturePackage: { t: { data } } }],
      names: ['a'],
    };
    expect(collectTransferables(set)).toEqual([data.buffer]);
  });
});

describe('#35 · 真实 fixture 坐实两个跨线程前提', () => {
  const fixtures = join(import.meta.dir, '../fixtures/s3mblock');
  const bytes = () => toArrayBuffer(readFileSync(join(fixtures, '0.s3mblock')));

  test('defaultInflate 只依赖 DecompressionStream/Blob/Response，不碰 DOM，Worker 里能跑', async () => {
    // 不注入 inflate，走的正是 Worker 端会用的那条解压路径
    const set = await parseS3MBlockGroups(bytes());
    expect(set.tiles.length).toBeGreaterThan(0);
    expect(set.names.length).toBe(set.tiles.length);
    expect(set.tiles[0]!.blockName).toBe(set.names[0]);
  });

  test('真实产物可结构化克隆；零拷贝清单非空', async () => {
    const set = await parseS3MBlockGroups(bytes());
    const cloned = structuredClone(set);
    expect(cloned.names).toEqual(set.names);
    expect(cloned.tiles.length).toBe(set.tiles.length);
    expect(cloned.tiles[0]!.blockName).toBe(set.tiles[0]!.blockName);
    expect(Object.keys(cloned.tiles[0]!.geoPackage).length).toBe(Object.keys(set.tiles[0]!.geoPackage).length);
    expect(collectTransferables(set).length).toBeGreaterThan(0);
  });
});
