import { describe, expect, it } from 'bun:test';
import { AttributeQuery } from '../../packages/s3m-three/src/core/AttributeQuery.js';

describe('AttributeQuery 属性查询与缓存', () => {
  it('构造参数校验：缺少必要参数抛错，正确解析数据源与数据集', () => {
    expect(() => new AttributeQuery({} as any)).toThrow('缺少 dataServiceUrl');
    expect(() => new AttributeQuery({ dataServiceUrl: 'http://test' } as any)).toThrow('datasetName 格式应为');

    // 默认补 DataSource:
    const q1 = new AttributeQuery({
      dataServiceUrl: 'http://test/rest/data/',
      datasetName: 'building',
    });
    expect(q1.datasourceName).toBe('DataSource');
    expect(q1.datasetName).toBe('building');
    expect(q1.datasetPath).toBe('http://test/rest/data/datasources/name/DataSource/datasets/name/building');

    // 显式指定数据源
    const q2 = new AttributeQuery({
      dataServiceUrl: 'http://test/rest/data',
      datasetName: 'CityData:road',
    });
    expect(q2.datasourceName).toBe('CityData');
    expect(q2.datasetName).toBe('road');
  });

  it('loadSchema：成功读取字段列表，失败时抛错', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('fields.json')) {
        return new Response(JSON.stringify({ fieldNames: ['SmID', 'SmGeometry', 'Height', 'Name'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const query = new AttributeQuery({
      dataServiceUrl: 'http://test/rest/data',
      datasetName: 'test_ds',
      fetchImpl: mockFetch as any,
    });

    const schema = await query.loadSchema();
    expect(schema.map((f) => f.name)).toEqual(['SmID', 'SmGeometry', 'Height', 'Name']);
    expect(query.stats.requests).toBe(1);

    // 再次调用命中缓存，不发二次请求
    const schema2 = await query.loadSchema();
    expect(schema2).toBe(schema);
    expect(query.stats.requests).toBe(1);

    // 模拟失败
    const failQuery = new AttributeQuery({
      dataServiceUrl: 'http://test/rest/data',
      datasetName: 'fail_ds',
      fetchImpl: (async () => new Response('Error', { status: 500 })) as any,
    });
    await expect(failQuery.loadSchema()).rejects.toThrow('读取字段表失败 500');
  });

  it('queryBySmids：过滤无效 id、支持 fastjson 数据清洗并写入缓存', async () => {
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('fields.json')) {
        return new Response(JSON.stringify({ fieldNames: ['SmID', 'Name', 'Height', 'smgeometry'] }), {
          status: 200,
        });
      }
      if (urlStr.includes('features.json')) {
        // 探测返回 MODEL 类型 -> 启用 fastjson
        return new Response(JSON.stringify({ geometryType: 'GEOMODEL3D' }), { status: 200 });
      }
      if (urlStr.includes('featureResults.fastjson')) {
        // 模拟带 Java 字面量的 fastjson 响应：含有 x'...' 和 100L, 25.5D
        const fastjsonText = `
          {
            "features": [
              {
                "ID": 1,
                "fieldNames": ["SmID", "Name", "Height"],
                "fieldValues": [1, "Building A", 50.0D],
                "model": x'41424344'
              },
              {
                "ID": 2,
                "fieldNames": ["SmID", "Name", "Height"],
                "fieldValues": [2, "Building B", 80.5F],
                "model": x'FF00'
              }
            ],
            "featureCount": 2
          }
        `;
        return new Response(fastjsonText, { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const query = new AttributeQuery({
      dataServiceUrl: 'http://test/rest/data',
      datasetName: 'model_ds',
      fetchImpl: mockFetch as any,
    });

    // 传入包含 NaN 和重复 ID 的列表
    const result = await query.queryBySmids([1, 2, NaN, 1]);
    expect(result.size).toBe(2);
    expect(result.get(1)).toEqual({ SmID: 1, Name: 'Building A', Height: 50.0 });
    expect(result.get(2)).toEqual({ SmID: 2, Name: 'Building B', Height: 80.5 });
    expect(query.hasCached(1)).toBe(true);
    expect(query.hasCached(2)).toBe(true);

    const prevRequests = query.stats.requests;
    // 再次查询已缓存的 id -> 零请求命中
    const cachedResult = await query.queryBySmids([1]);
    expect(cachedResult.get(1)?.Name).toBe('Building A');
    expect(query.stats.requests).toBe(prevRequests);

    // 清空缓存
    query.clearCache();
    expect(query.hasCached(1)).toBe(false);
    expect(query.stats.requests).toBe(0);
  });

  it('服务端返回 json.error 时抛出异常', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('fields.json')) {
        return new Response(JSON.stringify({ fieldNames: ['SmID'] }), { status: 200 });
      }
      if (urlStr.includes('features.json')) {
        return new Response(JSON.stringify({ geometryType: 'POINT' }), { status: 200 });
      }
      if (urlStr.includes('featureResults.')) {
        return new Response(JSON.stringify({ error: { code: 400, errorMsg: 'SQL filter 语法错误' } }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 200 });
    };

    const query = new AttributeQuery({
      dataServiceUrl: 'http://test/rest/data',
      datasetName: 'err_ds',
      fetchImpl: mockFetch as any,
    });

    await expect(query.queryBySmids([999])).rejects.toThrow('属性查询失败：SQL filter 语法错误');
  });
});
