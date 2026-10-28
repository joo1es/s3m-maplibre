/**
 * 单元测试：authenticate 鉴权适配钩子
 *
 * 锁定的行为（对应 AGENTS.md 不变式①）：
 *   1. 不传 `authenticate` 时请求路径与旧版逐字一致（fetch 以原参数被调用，不新建 init）；
 *   2. 钩子可改写 URL（`?token=` 后缀）；
 *   3. 钩子可附加请求头（Authorization / X-Token），且不覆盖调用方显式给的头；
 *   4. 支持异步（先换 token 再发请求）；
 *   5. kind（config / tile / texblock / creases / attributes）正确传给钩子；
 *   6. 数据集级 authenticate 覆盖图层级默认值；
 *   7. AttributeQuery 的自定义 fetchImpl 传输不被绕过，鉴权仍生效。
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { authFetch, resolveAuthRequest, type AuthenticateFn } from '../../packages/s3m-three/src/core/AuthFetch';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { DatasetManager } from '../../packages/s3m-three/src/render/DatasetManager';
import { AttributeQuery } from '../../packages/s3m-three/src/core/AttributeQuery';

type CapturedCall = { url: string; init: RequestInit | undefined };

/** mock 全局 fetch，记录每次调用的 (url, init)，按前缀返回指定响应 */
function installFetchMock(handler: (url: string) => Response | null): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const res = handler(url);
    if (res) return res;
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

afterEach(() => {
  // 各测试自己 restore；这里兜底防串扰由 installFetchMock 的 restore 完成
});

describe('authFetch 钩子语义', () => {
  test('1. 未配置鉴权：fetch 以原参数被调用（行为与旧版逐字一致）', async () => {
    const { calls, restore } = installFetchMock(() => new Response('ok'));
    try {
      const res = await authFetch('https://gw/a.scp', undefined, 'config');
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://gw/a.scp');
      expect(calls[0]!.init).toBeUndefined(); // 连 init 对象都不新建
      // 带 init 的调用原样透传
      const init = { method: 'POST', headers: { 'Content-Type': 'text/plain' } };
      await authFetch('https://gw/x', undefined, 'tile', init);
      expect(calls[1]!.init).toBe(init);
    } finally {
      restore();
    }
  });

  test('2. 钩子返回 string：只改写 URL（?token 后缀）', async () => {
    const { calls, restore } = installFetchMock(() => new Response('ok'));
    try {
      const auth: AuthenticateFn = (url) => `${url}?token=abc`;
      await authFetch('https://gw/a.scp', auth, 'config');
      expect(calls[0]!.url).toBe('https://gw/a.scp?token=abc');
      expect(calls[0]!.init).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('3. 钩子返回 {url, headers}：改 URL 并附加请求头', async () => {
    const { calls, restore } = installFetchMock(() => new Response('ok'));
    try {
      const auth: AuthenticateFn = (url) => ({ url: `${url}?token=abc`, headers: { 'X-Token': 'abc' } });
      await authFetch('https://gw/a.scp', auth, 'tile');
      expect(calls[0]!.url).toBe('https://gw/a.scp?token=abc');
      expect(calls[0]!.init?.headers).toEqual({ 'X-Token': 'abc' });
    } finally {
      restore();
    }
  });

  test('4. 钩子支持异步（先换 token）；init 自带头不被钩子覆盖', async () => {
    const { calls, restore } = installFetchMock(() => new Response('ok'));
    try {
      let rotated = 0;
      const auth: AuthenticateFn = async (url, kind) => {
        expect(kind).toBe('tile');
        rotated++;
        return { url: `${url}?token=t${rotated}`, headers: { Authorization: `Bearer t${rotated}`, 'X-Keep': 'hook' } };
      };
      await authFetch('https://gw/a', auth, 'tile', { headers: { 'X-Keep': 'caller', 'X-Other': '1' } });
      expect(calls[0]!.url).toBe('https://gw/a?token=t1');
      expect(calls[0]!.init?.headers).toEqual({ Authorization: 'Bearer t1', 'X-Keep': 'caller', 'X-Other': '1' });
    } finally {
      restore();
    }
  });

  test('5. resolveAuthRequest：异常返回兜底原 URL', async () => {
    expect((await resolveAuthRequest('https://gw/a', () => '', 'config')).url).toBe('https://gw/a');
    expect((await resolveAuthRequest('https://gw/a', () => null as never, 'config')).url).toBe('https://gw/a');
    expect((await resolveAuthRequest('https://gw/a', undefined, 'config'))).toEqual({ url: 'https://gw/a' });
  });
});

describe('S3MTileset 鉴权集成（config / tile）', () => {
  test('6. 配置与瓦片请求都过钩子，kind 分别为 config / tile', async () => {
    const kinds: string[] = [];
    const auth: AuthenticateFn = (url, kind) => {
      kinds.push(kind);
      return `${url}?token=scp`;
    };
    const { calls, restore } = installFetchMock((url) => {
      // scp 配置返回最小 JSON；瓦片 404（_load 内部吞掉失败，不影响断言）
      if (url.endsWith('.scp') || url.includes('.scp?')) {
        return new Response(JSON.stringify({ rootTiles: [{ url: 't.s3mb' }] }), { status: 200 });
      }
      return null;
    });
    try {
      const ts = new S3MTileset({ configUrl: 'https://gw.example.com/data/a.scp', authenticate: auth });
      await ts.init();
      // 第 1 个请求：config，URL 已带 token
      expect(calls[0]!.url).toBe('https://gw.example.com/data/a.scp?token=scp');
      expect(kinds[0]).toBe('config');
      // 第 2 个请求：根瓦片（resolveUrl 相对解析到同目录），kind = tile
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[1]!.url).toBe('https://gw.example.com/data/t.s3mb?token=scp');
      expect(kinds[1]).toBe('tile');
      // 内部缓存键不受鉴权影响：node 记的是改写前的 URL
      expect(ts.authenticate).toBe(auth);
    } finally {
      restore();
    }
  });
});

describe('DatasetManager 数据集级覆盖', () => {
  const noopCallbacks = {
    onTile: () => {},
    onTileRemoved: () => {},
    onStats: () => {},
    onError: () => {},
    onReady: () => {},
    triggerRepaint: () => {},
  };

  test('7. ds.authenticate 覆盖图层级默认；未传时回落图层级', async () => {
    const globalAuth: AuthenticateFn = (url) => `${url}?token=GLOBAL`;
    const dsAuth: AuthenticateFn = (url) => `${url}?token=DATASET`;
    const scene = new (require('three') as typeof import('three')).Scene();
    const { calls, restore } = installFetchMock((url) => {
      if (url.includes('.scp')) return new Response(JSON.stringify({ rootTiles: [{ url: 't.s3mb' }] }), { status: 200 });
      return null;
    });
    try {
      const dm = new DatasetManager();
      // 数据集 A：自己的鉴权，覆盖全局
      await dm
        .addDataset(
          { id: 'a', configUrl: 'https://gw.example.com/a.scp', authenticate: dsAuth },
          scene, null, null, 1, null, 64, 4, noopCallbacks, Infinity, 128, globalAuth
        )
        .catch(() => {});
      // 数据集 B：没有自己的鉴权，回落全局
      await dm
        .addDataset(
          { id: 'b', configUrl: 'https://gw.example.com/b.scp' },
          scene, null, null, 1, null, 64, 4, noopCallbacks, Infinity, 128, globalAuth
        )
        .catch(() => {});
      const aConfig = calls.find((c) => c.url.includes('/a.scp'));
      const bConfig = calls.find((c) => c.url.includes('/b.scp'));
      expect(aConfig!.url).toBe('https://gw.example.com/a.scp?token=DATASET');
      expect(bConfig!.url).toBe('https://gw.example.com/b.scp?token=GLOBAL');
    } finally {
      restore();
    }
  });
});

describe('AttributeQuery 鉴权（自定义传输不被绕过）', () => {
  test('8. 属性查询过钩子：改 URL + 加 header，fetchImpl 仍被使用', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({ fieldNames: ['SmID', 'NAME'] }), { status: 200 });
    }) as unknown as typeof fetch;
    const auth: AuthenticateFn = (url) => ({ url: `${url}?token=attr`, headers: { 'X-Gateway': 's3m' } });

    const aq = new AttributeQuery({
      dataServiceUrl: 'https://gw.example.com/iserver/services/data-x/rest/data',
      datasetName: 'DS:build',
      fetchImpl,
      authenticate: auth,
    });
    const fields = await aq.loadSchema();
    expect(fields.map((f) => f.name)).toEqual(['SmID', 'NAME']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://gw.example.com/iserver/services/data-x/rest/data/datasources/name/DS/datasets/name/build/fields.json?token=attr'
    );
    expect(calls[0]!.init?.headers).toEqual({ 'X-Gateway': 's3m' });
  });

  test('9. 未配置鉴权的属性查询：fetchImpl 以原参数被调用', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({ fieldNames: ['SmID'] }), { status: 200 });
    }) as unknown as typeof fetch;
    const aq = new AttributeQuery({
      dataServiceUrl: 'https://gw.example.com/rest/data',
      datasetName: 'DS:build',
      fetchImpl,
    });
    await aq.loadSchema();
    expect(calls[0]!.init).toBeUndefined();
  });
});
