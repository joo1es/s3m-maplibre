/**
 * 瓦片 URL 工具：目录拼接、绝对化、路径编码修补、S3M 1.x 子瓦寻址。
 *
 * 全部是纯函数，不依赖任何状态 —— 从 `S3MTileset.ts` 原样搬出来（issue #27 的 P1 阶段），
 * 行为逐字未变。放在这里是因为它们被 `_load`、图集补齐、测试三条链路各自引用，
 * 留在单体里看不出「这些和瓦片状态无关」。
 */

export function dirOf(url: string): string {
  return url.slice(0, url.lastIndexOf('/') + 1);
}

/**
 * 把任意 URL 转成绝对地址。
 * 关键：configUrl 常常是相对路径（如 '../../data/cbd.scp'），
 * 而 new URL(rel, 相对基准) 会抛异常，导致后续 childTile 全部解析错误。
 * 所以进 init 前必须先锚定到 document.baseURI。
 */
export function toAbsolute(url: string): string {
  if (!url) return url;
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : undefined;
    return base ? new URL(url, base).href : new URL(url).href;
  } catch {
    return url;
  }
}

export function resolveUrl(base: string, rel: string | null | undefined): string | null {
  if (!rel) return null;
  try {
    return fixPathEncoding(new URL(rel, base).href);
  } catch {
    // base 不是合法绝对地址时，退化为手工拼接，避免静默拿到错误路径
    return fixPathEncoding(`${dirOf(base)}${rel}`);
  }
}

/**
 * 修补路径里没被编码、但会被服务端改写的字符。
 *
 * 最典型的是 `+`：OSGB 转 S3M 的缓存瓦片名就是 `Tile_+002_+001`，而 iServer 的 Java 侧
 * 按 URLDecoder 解路径，未编码的 `+` 会变成空格 → 404「瓦片数据不存在」。
 * new URL() 的序列化器认为 `+` 在 path 里是合法字符，所以不会替我们编码，必须自己补上。
 * 只动 path，不动 query/hash：query 里的 `+` 本来就是空格的约定，改了反而换味。
 */
export function fixPathEncoding(url: string): string {
  if (!/[+ ]/.test(url)) return url;
  const hashAt = url.indexOf('#');
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const body = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = body.indexOf('?');
  const path = queryAt < 0 ? body : body.slice(0, queryAt);
  const query = queryAt < 0 ? '' : body.slice(queryAt);
  return `${path.replace(/\+/g, '%2B').replace(/ /g, '%20')}${query}${hash}`;
}

/**
 * S3M 1.x（SuperMapCache）的子瓦地址。
 *
 * XML 的 RangeDataList 写的是切片时的原始文件名（`Tile_+002_+001_L16_0.osgb`），
 * 而 iServer 实际发布的是**同名换 .s3m 后缀**、并且插在 `datas/<数据源>/data/path/` 下：
 *   .../datas/Config/Tile_+002_+001/Tile_+002_+001.s3m                     ← 根
 *   .../datas/Config/data/path/Tile_+002_+001/Tile_+002_+001_L16_0.s3m     ← 子
 * 实测 L16/L17/L18 都是 200，`?sceneName=` 不参与寻址。
 */
export function s3m1ChildUrl(tileUrl: string, child: string | null | undefined): string | null {
  if (!child) return null;
  const name = child.replace(/\.(osgb|s3mb|s3m)$/i, '.s3m');
  // 根瓦地址：  <前缀>/datas/<数据源>/<瓦片目录>/<文件名>.s3m
  // 子瓦地址：  <前缀>/datas/<数据源>/data/path/<瓦片目录>/<子瓦名>.s3m
  const parts = tileUrl.split('/');
  const file = parts.pop() ?? '';
  const dir = parts.pop() ?? '';
  const datasIdx = parts.lastIndexOf('datas');
  if (!file || !dir || datasIdx < 1) {
    // 不像 datas/<ds>/<dir>/<file> 的结构，退回按父目录解析
    return resolveUrl(dirOf(tileUrl), name);
  }
  // 父瓦自己就已经在 data/path 下面了（再往下细化），那只换文件名，别再插一层
  const alreadyPath = parts[parts.length - 1] === 'path' && parts[parts.length - 2] === 'data';
  const base = alreadyPath ? `${parts.join('/')}/${dir}` : `${parts.join('/')}/data/path/${dir}`;
  return fixPathEncoding(`${base}/${name}`);
}
