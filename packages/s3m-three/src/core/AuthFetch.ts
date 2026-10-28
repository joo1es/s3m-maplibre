/**
 * 鉴权适配（Authenticate Hook）
 *
 * S3M 服务经常挂在带鉴权的网关后面：有的要求 URL 带 `?token=...`，有的要求
 * 请求头带 `Authorization` / `X-Token`，还有的 token 会过期需要定期换。内核在
 * 主线程发出的全部请求（数据集配置 scp、瓦片 .s3mb/.s3mblock、子图集 .texblock、
 * 棱线缓存、iServer 属性查询）都从这一个钩子过一遍，由使用方统一改写。
 *
 * 设计约束（对应 AGENTS.md 不变式①）：不传 `authenticate` 时，请求路径与旧版
 * 逐字一致——`authFetch` 直接短路到裸 `fetch(url)` / `fetch(url, init)`，连 init
 * 对象都不新建。
 *
 * 注意：鉴权只作用于**发到网络上的请求**，不参与内核的缓存键（瓦片 URL 带 `#N`
 * 片段与 nodes/pending 等内部 Map 的键都是改写前的原 URL），token 轮换不会导致
 * 重复加载同一块瓦片。重试时每次重新过钩子，token 刷新后重试天然带上新值。
 */

/** 请求类别，钩子按类别区分处理（比如属性查询走另一个网关） */
export type AuthRequestKind = 'config' | 'tile' | 'texblock' | 'creases' | 'attributes';

/** 改写后的请求：实际请求的 URL + 需要附加的请求头 */
export interface AuthResolvedRequest {
  /** 实际发到网络上的 URL（可追加 `?token=...` 等鉴权参数） */
  url: string;
  /** 需要附加的请求头（如 `Authorization` / `X-Token`） */
  headers?: Record<string, string>;
}

/**
 * 鉴权适配函数。每个请求发出前调用一次：
 *
 * - 返回 `string`：只改写 URL（最简形式，如追加 `?token=`）；
 * - 返回 `{ url, headers }`：改写 URL 并附加请求头；
 * - 返回 `Promise`：支持异步（如先向认证服务换 token）。
 *
 * ```js
 * new S3MLayer({
 *   configUrl: 'https://gw.example.com/data/a.scp',
 *   authenticate: (url, kind) => ({
 *     url: `${url}${url.includes('?') ? '&' : '?'}token=${getToken()}`,
 *     headers: { 'X-Client': 's3m' },
 *   }),
 * });
 * ```
 */
export type AuthenticateFn = (
  url: string,
  kind: AuthRequestKind
) => string | AuthResolvedRequest | Promise<string | AuthResolvedRequest>;

/** 把钩子返回值归一成 `{ url, headers }`；返回值异常时兜底用原 URL */
export async function resolveAuthRequest(
  url: string,
  auth: AuthenticateFn | undefined,
  kind: AuthRequestKind
): Promise<AuthResolvedRequest> {
  if (!auth) return { url };
  const out = await auth(url, kind);
  if (typeof out === 'string') return { url: out || url };
  if (!out || typeof out !== 'object') return { url };
  return { url: out.url || url, headers: out.headers };
}

/**
 * 带鉴权的 fetch：先过钩子改写 URL / 追加 header，再发请求。
 * `init.headers`（调用方自带的头）优先级高于钩子返回的 headers。
 * `auth` 未配置时与裸 `fetch` 完全等价（参数原样透传，不新建 init）。
 */
export async function authFetch(
  url: string,
  auth: AuthenticateFn | undefined,
  kind: AuthRequestKind,
  init?: RequestInit
): Promise<Response> {
  if (!auth) return init === undefined ? fetch(url) : fetch(url, init);
  const resolved = await resolveAuthRequest(url, auth, kind);
  const hookHeaders = resolved.headers && Object.keys(resolved.headers).length > 0 ? resolved.headers : null;
  if (!hookHeaders) return init === undefined ? fetch(resolved.url) : fetch(resolved.url, init);
  // 钩子头在前，init 头在后：调用方显式给的头不被覆盖
  const headers = { ...hookHeaders, ...init?.headers } as Record<string, string>;
  return fetch(resolved.url, { ...init, headers });
}
