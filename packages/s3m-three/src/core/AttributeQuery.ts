/**
 * iServer 数据服务属性查询
 *
 * S3M 瓦片里**只有单体 ID**（`MonomerIDInfo.id`，即 SmID）和顶点区间，没有任何业务字段；
 * 业务属性在 iServer 的「数据服务」里：同一份数据源被发布成 `data-xxx/rest/data` 的那个服务。
 *
 * 这里的职责只有一件事：按 SmID 批量取字段值。字段表、分片、缓存、去重都在内部消化，
 * 上层（`S3MLayer.colorByField`）只关心「拿到值之后怎么算颜色」。
 *
 * 实测（iServer 2026，GEOMODEL3D 数据集）：
 *   - `queryOption: 'ATTRIBUTE'` 被忽略：放 body、放 query string、大小写都没用，
 *     2D / 3D 数据集都照样返回几何；模型数据集还会给每条要素带上 `geometry.model`
 *     —— 那是 deflate 压缩后的 S3M 模型字节，约 2.5KB/条，占整个响应的 90%；
 *   - 没有「只取属性」的接口。想省带宽只能逐条 GET `/rest/data/feature/{a}-{b}-{idx}.json`
 *     （957B/条，model 为 null），但那是拿请求数换带宽：300 条并发 16 反而比一次 POST 慢；
 *   - `.fastjson` 比 `.json` 少 40%：model 用 hex（2 字符/字节）而不是数字数组（3~4 字符/字节）。
 *     代价是它不是严格 JSON（`0.0D`、`1L`、`x'ABCD'` 都是 Java 字面量），要先清洗；
 *   - `maxFeatures` 生效，`fromIndex` / `toIndex` 不生效 —— 只能切前 N 条，不能翻页；
 *   - 同一份数据如果另外发布了二维数据源（`DataSource_erwei`），查它只有 1/5 的体积；
 *   - CORS 是开的（`Access-Control-Allow-Origin: *`），浏览器里可以直接 POST。
 *
 * 所以默认策略：`.fastjson` + 一次性把**全部字段**取回来（字段名很便宜，model 才是大头），
 * 这样换专题字段时全部命中缓存，不再发请求。
 */

import { resolveAuthRequest, type AuthenticateFn } from './AuthFetch.js';

const DEFAULT_ID_FIELD = 'SmID';
const DEFAULT_CHUNK_SIZE = 200;
/** 几何/索引字段取回来没用，还特别占带宽 */
const SKIP_FIELDS = new Set(['smgeometry', 'smindexkey', 'smgeoposition']);

export interface AttributeQueryOptions {
  /** 数据服务根地址，形如 https://host/iserver/services/data-xxx/rest/data */
  dataServiceUrl: string;
  /** 数据集，支持 "DataSource:zhoubian" 或只写 "zhoubian"（默认补 DataSource:） */
  datasetName: string;
  /** 与 S3M 单体 ID 对应的字段，默认 SmID（对应 scp 里的 idFieldName） */
  idField?: string;
  /** 只取这些字段，默认取字段表里除几何/索引外的全部（推荐留空，全字段进缓存后换字段零请求） */
  fields?: string[];
  /** 每次请求带多少个 id，默认 200 */
  chunkSize?: number;
  /** 响应格式，默认 'auto'：模型数据集用 fastjson（模型是 byte[]，hex 比数字数组省 43%），
   *  二维数据集用 json（坐标是 double，hex 反而更胖）。也可以强制指定 */
  format?: 'auto' | 'fastjson' | 'json';
  /** 便于测试时替换，默认用全局 fetch */
  fetchImpl?: typeof fetch;
  /**
   * 鉴权适配函数（不填则用图层级的 `authenticate`）。请求发出前过一遍，
   * 可改写 URL（加 `?token=`）或附加请求头。见 `AuthenticateFn`。
   */
  authenticate?: AuthenticateFn;
}

export interface AttributeField {
  name: string;
  type?: string;
  alias?: string;
}

export type AttributeRow = Record<string, string | number>;

/** 一次查询的代价，用来在 UI 上展示「查了多大、发了几个请求」 */
export interface AttributeQueryStats {
  requests: number;
  bytes: number;
  ms: number;
}

interface FeatureResultsJson {
  features?: Array<{
    ID?: number;
    fieldNames?: string[];
    fieldValues?: Array<string | number>;
  }>;
  featureCount?: number;
  error?: { code?: number; errorMsg?: string };
}

/**
 * fastjson 不是严格 JSON，服务端会把 Java 字面量直接吐出来：
 *   `"model":x'D7A34040...'`（byte[] 的 hex）、`"rotationX":0.0D`、`"id":423L`
 * 这些在 JSON.parse 里全是语法错误。model 恰好是我们唯一不想要的东西（占 90% 体积），
 * 直接在字符串上抹掉，连解析都省了。
 */
function sanitizeFastjson(text: string): string {
  return text
    .replace(/x'[0-9A-Fa-f]*'/g, 'null')
    .replace(/(\d)[dDlLfF](?=\s*[,}\]])/g, '$1');
}

export class AttributeQuery {
  readonly dataServiceUrl: string;
  readonly datasourceName: string;
  readonly datasetName: string;
  readonly idField: string;

  private readonly _fields: string[] | null;
  private readonly _chunkSize: number;
  private readonly _formatOption: 'auto' | 'fastjson' | 'json';
  private readonly _fetch: typeof fetch;
  private readonly _authenticate: AuthenticateFn | undefined;
  private readonly _cache = new Map<number, AttributeRow>();
  private _schema: AttributeField[] | null = null;
  private _resolvedFields: string[] | null = null;
  private _format: 'fastjson' | 'json' | null = null;
  private _stats: AttributeQueryStats = { requests: 0, bytes: 0, ms: 0 };

  constructor(options: AttributeQueryOptions) {
    if (!options?.dataServiceUrl) throw new Error('[s3m] AttributeQuery 缺少 dataServiceUrl');
    const full = options.datasetName?.includes(':') ? options.datasetName : `DataSource:${options.datasetName ?? ''}`;
    const [ds, name] = full.split(':');
    if (!name) throw new Error(`[s3m] datasetName 格式应为 "数据源:数据集"，收到 "${options.datasetName}"`);

    this.dataServiceUrl = options.dataServiceUrl.replace(/\/+$/, '');
    this.datasourceName = ds;
    this.datasetName = name;
    this.idField = options.idField ?? DEFAULT_ID_FIELD;
    this._fields = options.fields?.length ? options.fields : null;
    this._chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    this._formatOption = options.format ?? 'auto';
    this._fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this._authenticate = options.authenticate;
  }

  /** 数据集的 REST 路径：.../datasources/name/{ds}/datasets/name/{name} */
  get datasetPath(): string {
    return `${this.dataServiceUrl}/datasources/name/${encodeURIComponent(this.datasourceName)}/datasets/name/${encodeURIComponent(this.datasetName)}`;
  }

  /**
   * 带鉴权的请求：先过 `authenticate` 钩子改写 URL / 追加 header，再走本查询的
   * 传输层（`fetchImpl` 或全局 fetch，自定义传输不被绕过）。未配置鉴权时与旧版
   * 行为逐字一致（参数原样透传）。
   */
  private async _request(url: string, init?: RequestInit): Promise<Response> {
    const resolved = await resolveAuthRequest(url, this._authenticate, 'attributes');
    const hookHeaders = resolved.headers && Object.keys(resolved.headers).length > 0 ? resolved.headers : null;
    if (!hookHeaders) return init === undefined ? this._fetch(resolved.url) : this._fetch(resolved.url, init);
    // 钩子头在前，init 头在后：调用方显式给的头（如 Content-Type）不被覆盖
    const headers = { ...hookHeaders, ...init?.headers } as Record<string, string>;
    return this._fetch(resolved.url, { ...init, headers });
  }

  /** 累计的请求代价（不清零，用来观察整体开销） */
  get stats(): AttributeQueryStats {
    return { ...this._stats };
  }

  /** 字段表（顺手也用来判断「这个数据集到底有没有属性表」） */
  async loadSchema(): Promise<AttributeField[]> {
    if (this._schema) return this._schema;
    const res = await this._request(`${this.datasetPath}/fields.json`);
    this._stats.requests++;
    if (!res.ok) throw new Error(`[s3m] 读取字段表失败 ${res.status}：${this.datasetPath}/fields.json`);
    const json = (await res.json()) as { fieldNames?: string[] };
    this._schema = (json.fieldNames ?? []).map((name) => ({ name }));
    return this._schema;
  }

  /** 已经缓存过、不需要再请求的 id */
  hasCached(smid: number): boolean {
    return this._cache.has(smid);
  }

  clearCache(): void {
    this._cache.clear();
    this._stats = { requests: 0, bytes: 0, ms: 0 };
  }

  /**
   * 按 SmID 批量取属性。自动跳过已缓存的、按 chunkSize 分片，并丢弃几何。
   * 缓存的是**整行**（全部字段），所以换专题字段时不会再发请求。
   */
  async queryBySmids(smids: number[]): Promise<Map<number, AttributeRow>> {
    const ids = [...new Set(smids.filter((n) => Number.isFinite(n)))];
    const result = new Map<number, AttributeRow>();
    for (const id of ids) {
      const hit = this._cache.get(id);
      if (hit) result.set(id, hit);
    }

    const todo = ids.filter((id) => !this._cache.has(id));
    if (!todo.length) return result;

    const fields = await this._resolveFields();
    for (let i = 0; i < todo.length; i += this._chunkSize) {
      const chunk = todo.slice(i, i + this._chunkSize);
      const rows = await this._queryChunk(chunk, fields);
      for (const [id, row] of rows) {
        this._cache.set(id, row);
        result.set(id, row);
      }
    }
    return result;
  }

  private async _resolveFields(): Promise<string[]> {
    if (this._resolvedFields) return this._resolvedFields;
    if (this._fields) {
      this._resolvedFields = this._fields;
      return this._resolvedFields;
    }
    const schema = await this.loadSchema();
    const fields = schema.map((f) => f.name).filter((n) => !SKIP_FIELDS.has(n.toLowerCase()));
    this._resolvedFields = fields.length ? fields : [this.idField];
    return this._resolvedFields;
  }

  /**
   * 选响应格式。
   *
   * 模型数据集的体积几乎全是 `geometry.model`（byte[]），fastjson 用 hex 表示只要 2 字符/字节，
   * json 是十进制数字数组（3~4 字符/字节），所以 fastjson 又快又小；
   * 二维数据集的几何是坐标数组（double），hex 反而比十进制更胖（实测 3.9KB vs 2.4KB/条），
   * 这种就留在 json。用 `features.json` 返回的 geometryType 判断，一次几十字节，跟着实例缓存。
   */
  private async _resolveFormat(): Promise<'fastjson' | 'json'> {
    if (this._format) return this._format;
    if (this._formatOption !== 'auto') return (this._format = this._formatOption);
    try {
      const res = await this._request(`${this.datasetPath}/features.json?fromIndex=0&toIndex=1`);
      this._stats.requests++;
      const json = (await res.json()) as { geometryType?: string };
      const isModel = String(json.geometryType ?? '').toUpperCase().includes('MODEL');
      this._format = isModel ? 'fastjson' : 'json';
    } catch {
      // 探测失败就当模型数据集处理：S3M 场景下这是绝大多数
      this._format = 'fastjson';
    }
    return this._format;
  }

  private async _queryChunk(ids: number[], fields: string[]): Promise<Map<number, AttributeRow>> {
    const body = {
      getFeatureMode: 'SQL',
      datasetNames: [`${this.datasourceName}:${this.datasetName}`],
      // 服务端会忽略它，但留着：将来遇到真的听话的版本就能省下全部几何
      queryOption: 'ATTRIBUTE',
      queryParameter: {
        attributeFilter: `${this.idField} IN (${ids.join(',')})`,
        fields,
      },
    };

    const format = await this._resolveFormat();
    const raw = await this._post(body, format);
    let json: FeatureResultsJson;
    try {
      json = this._parse(raw);
    } catch (e) {
      // fastjson 的方言没吃透时留一条退路，别让一次格式变更把功能整个弄挂
      if (format !== 'fastjson') throw e;
      json = this._parse(await this._post(body, 'json'));
    }
    if (json.error) throw new Error(`[s3m] 属性查询失败：${json.error.errorMsg ?? '未知错误'}`);

    const out = new Map<number, AttributeRow>();
    for (const f of json.features ?? []) {
      const names = f.fieldNames ?? [];
      const values = f.fieldValues ?? [];
      const row: AttributeRow = {};
      for (let i = 0; i < names.length; i++) row[names[i]] = values[i];
      // 优先用 idField（SmID）关联，拿不到才退回要素 ID
      const rawId = row[this.idField] ?? f.ID;
      const id = Number(rawId);
      if (Number.isFinite(id)) out.set(id, row);
    }
    return out;
  }

  private async _post(body: unknown, format: 'fastjson' | 'json'): Promise<string> {
    const t0 = performance.now();
    const res = await this._request(`${this.dataServiceUrl}/featureResults.${format}?returnContent=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    this._stats.requests++;
    this._stats.bytes += text.length;
    this._stats.ms += Math.round(performance.now() - t0);
    if (!res.ok) throw new Error(`[s3m] 属性查询失败 ${res.status}：${text.slice(0, 200)}`);
    return text;
  }

  private _parse(text: string): FeatureResultsJson {
    return JSON.parse(text.includes("x'") || /\d[dDlL](?=\s*[,}\]])/.test(text) ? sanitizeFastjson(text) : text) as FeatureResultsJson;
  }
}
