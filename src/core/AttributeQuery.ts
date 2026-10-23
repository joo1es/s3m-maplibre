/**
 * iServer 数据服务属性查询
 *
 * S3M 瓦片里**只有单体 ID**（`MonomerIDInfo.id`，即 SmID）和顶点区间，没有任何业务字段；
 * 业务属性在 iServer 的「数据服务」里：同一份数据源被发布成 `data-xxx/rest/data` 的那个服务。
 *
 * 这里的职责只有一件事：按 SmID 批量取字段值。字段表、分片、缓存、去重都在内部消化，
 * 上层（`S3MLayer.colorByField`）只关心「拿到值之后怎么算颜色」。
 *
 * 实测（iServer 11，模型数据集）：
 *   - `queryOption: 'ATTRIBUTE'` 对模型数据集不生效，每条要素仍会带 `geometry.model`
 *     的 base64（约 10KB/条），所以必须分片 + 只取需要的 id；
 *   - `fromIndex/toIndex` 分页参数被忽略，分页只能自己用 `SmID IN (...)` 切；
 *   - CORS 是开的（`Access-Control-Allow-Origin: *`），浏览器里可以直接 POST。
 */

const DEFAULT_ID_FIELD = 'SmID';
const DEFAULT_CHUNK_SIZE = 200;
/** 几何/索引字段取回来没用，还特别占带宽 */
const SKIP_FIELDS = new Set(['SmGeometry', 'SmIndexKey', 'SmGeoPosition']);

export interface AttributeQueryOptions {
  /** 数据服务根地址，形如 https://host/iserver/services/data-xxx/rest/data */
  dataServiceUrl: string;
  /** 数据集，支持 "DataSource:zhoubian" 或只写 "zhoubian"（默认补 DataSource:） */
  datasetName: string;
  /** 与 S3M 单体 ID 对应的字段，默认 SmID（对应 scp 里的 idFieldName） */
  idField?: string;
  /** 只取这些字段，默认取字段表里除几何/索引外的全部 */
  fields?: string[];
  /** 每次请求带多少个 id，默认 200 */
  chunkSize?: number;
  /** 便于测试时替换，默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface AttributeField {
  name: string;
  type?: string;
  alias?: string;
}

export type AttributeRow = Record<string, string | number>;

interface FeatureResultsJson {
  features?: Array<{
    ID?: number;
    fieldNames?: string[];
    fieldValues?: Array<string | number>;
  }>;
  featureCount?: number;
  error?: { code?: number; errorMsg?: string };
}

export class AttributeQuery {
  readonly dataServiceUrl: string;
  readonly datasourceName: string;
  readonly datasetName: string;
  readonly idField: string;

  private readonly _fields: string[] | null;
  private readonly _chunkSize: number;
  private readonly _fetch: typeof fetch;
  private readonly _cache = new Map<number, AttributeRow>();
  private _schema: AttributeField[] | null = null;

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
    this._fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** 数据集的 REST 路径：.../datasources/name/{ds}/datasets/name/{name} */
  get datasetPath(): string {
    return `${this.dataServiceUrl}/datasources/name/${encodeURIComponent(this.datasourceName)}/datasets/name/${encodeURIComponent(this.datasetName)}`;
  }

  /** 字段表（顺手也用来判断「这个数据集到底有没有属性表」） */
  async loadSchema(): Promise<AttributeField[]> {
    if (this._schema) return this._schema;
    const res = await this._fetch(`${this.datasetPath}/fields.json`);
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
  }

  /**
   * 按 SmID 批量取属性。自动跳过已缓存的、按 chunkSize 分片、并丢弃几何。
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
    if (this._fields) return this._fields;
    const schema = await this.loadSchema();
    const fields = schema.map((f) => f.name).filter((n) => !SKIP_FIELDS.has(n));
    return fields.length ? fields : [this.idField];
  }

  private async _queryChunk(ids: number[], fields: string[]): Promise<Map<number, AttributeRow>> {
    const body = {
      getFeatureMode: 'SQL',
      datasetNames: [`${this.datasourceName}:${this.datasetName}`],
      queryOption: 'ATTRIBUTE',
      queryParameter: {
        attributeFilter: `${this.idField} IN (${ids.join(',')})`,
        fields,
      },
    };

    const res = await this._fetch(`${this.dataServiceUrl}/featureResults.json?returnContent=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[s3m] 属性查询失败 ${res.status}：${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as FeatureResultsJson;
    if (json.error) throw new Error(`[s3m] 属性查询失败：${json.error.errorMsg ?? '未知错误'}`);

    const out = new Map<number, AttributeRow>();
    for (const f of json.features ?? []) {
      const names = f.fieldNames ?? [];
      const values = f.fieldValues ?? [];
      const row: AttributeRow = {};
      for (let i = 0; i < names.length; i++) row[names[i]] = values[i];
      // 优先用 idField（SmID）关联，拿不到才退回要素 ID
      const raw = row[this.idField] ?? f.ID;
      const id = Number(raw);
      if (Number.isFinite(id)) out.set(id, row);
    }
    return out;
  }
}
