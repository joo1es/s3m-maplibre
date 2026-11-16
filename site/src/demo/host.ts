/**
 * 宿主引擎选择：MapLibre GL 与 Mapbox GL 任意切换。
 *
 * 为什么需要这一层：
 * `s3m-maplibre` 只按鸭子类型消费宿主（见 `packages/s3m-maplibre/src/MapLibreGeoAdapter.ts`
 * 的 `MapLike`），同一份图层代码本来就能跑在 MapLibre 与 Mapbox 上，demo 想切换缺的只是
 * 「拿到哪个命名空间」以及两家之间那几处签名差异。于是差异集中在这里，`main.js` 一行
 * `const maplibregl = getGl()` 就换掉了引擎。
 *
 * 这个文件**不许 import 任何 GL 包**：它被 `DemoApp.tsx`（SSG 阶段也要执行）静态引用，
 * 真正的加载放在 `host-load.ts` 里，那里才有 `import('maplibre-gl')` 与 `<script>` 注入。
 *
 * URL 参数：
 *   ?gl=mapbox                  Mapbox GL，用 HOST_ENGINES.mapbox.defaultCdnVersion（CDN）
 *   ?gl=maplibre&glv=6.18.0     指定版本 → 走 CDN（内置副本只有 devDependencies 里那一版）
 *   ?gl=mapbox&glv=2.15.0       老版本兼容性对照
 *   ?glcdn=unpkg | npmmirror    CDN 供应商（默认 jsdelivr；国内可换 npmmirror）
 *   ?glsrc=<url> ?glcss=<url>   自托管：直接给脚本 / 样式地址，覆盖上面的推导
 *   ?mapboxToken=pk.xxx         Mapbox 的 accessToken（只用自家瓦片时可以不给）
 *
 * 页面机位另有 `?zoom= / ?pitch= / ?bearing= / ?lng= / ?lat=`（见 `site/src/host/main.ts`）：
 * 它们不在本文件的清理名单里，所以换引擎时会被原样带过去 —— 对照两家时必须同机位，
 * 否则"楼变大变小"只是两档 zoom 的差别。
 */

export type HostEngine = 'maplibre' | 'mapbox';
export type HostSource = 'bundled' | 'cdn';
export type HostCdn = 'jsdelivr' | 'unpkg' | 'npmmirror';

export interface HostEngineSpec {
  /** npm 包名，内置包名与 CDN 路径都用它 */
  pkg: string;
  /** UMD 构建挂到 window 上的名字 */
  global: string;
  /** 仓库里有没有这个包的内置副本（只有 maplibre 有） */
  bundled: boolean;
  /** 走 CDN 但没给 `glv` 时用的版本；null = 版本也由 CDN 决定 */
  defaultCdnVersion: string | null;
  /** UMD 产物路径；null = 这个包没有 UMD 构建 */
  umdFile: string | null;
  /** ESM 产物路径；null = 这个包没有可直接 import 的 ESM 构建 */
  esmFile: string | null;
  /** 从哪个大版本起只剩 ESM；null = 不按版本切换格式 */
  esmFromMajor: number | null;
  label: string;
}

export const HOST_ENGINES: Record<HostEngine, HostEngineSpec> = {
  maplibre: {
    pkg: 'maplibre-gl',
    global: 'maplibregl',
    bundled: true,
    // 内置副本就是 devDependencies 里那一版，不写死版本号，避免两处漂移
    defaultCdnVersion: null,
    umdFile: 'dist/maplibre-gl.js',
    esmFile: 'dist/maplibre-gl.mjs',
    // v6 起不再发 UMD（dist 里只有 maplibre-gl.mjs），<script> 会 404
    esmFromMajor: 6,
    label: 'MapLibre GL',
  },
  mapbox: {
    pkg: 'mapbox-gl',
    global: 'mapboxgl',
    // 仓库不内置 mapbox-gl（1.5 MB，且只在对照时才用），只能走 CDN
    bundled: false,
    // 必须钉一个版本：不钉的话线上页面会随 CDN 的 latest 漂移，
    // 「上周还能渲染」这种问题会变成查不出来的偶发。
    defaultCdnVersion: '3.35.0',
    umdFile: 'dist/mapbox-gl.js',
    // v3 只有 UMD（没有 .mjs），只能 <script> 注入
    esmFile: null,
    esmFromMajor: null,
    label: 'Mapbox GL',
  },
};

/** 面板上的一键对照版本（点一下就换 URL 重载） */
export const HOST_PRESETS: { label: string; engine: HostEngine; version: string | null }[] = [
  { label: 'MapLibre 内置', engine: 'maplibre', version: null },
  { label: 'MapLibre 6.18.0', engine: 'maplibre', version: '6.18.0' },
  { label: 'Mapbox 3.35.0', engine: 'mapbox', version: '3.35.0' },
];

/**
 * 没给 token 时塞的假 token。
 *
 * Mapbox GL v2+ 会把 accessToken 拼到 `mapbox://` 请求与遥测上；本 demo 只用栅格瓦片
 * （Esri / OSM / 天地图），一次 mapbox:// 请求都不发，所以给个格式像样的占位值即可 ——
 * 留空反而会在某些版本里让 Map 构造直接抛错。
 */
export const PLACEHOLDER_MAPBOX_TOKEN =
  'pk.eyJ1IjoiczNtLWRlbW8iLCJhIjoiczNtLWRlbW8ifQ.placeholder-token-not-valid';

export interface HostPlan {
  engine: HostEngine;
  source: HostSource;
  /** 实际要用的版本：内置副本时为 null（版本运行时再问包本身） */
  version: string | null;
  cdn: HostCdn;
  /** 从 CDN 取哪个产物：umd 用 `<script>` 注入，esm 用动态 import */
  format: HostFormat;
  /** source === 'cdn' 时要加载的脚本地址；内置包时为空串 */
  scriptUrl: string;
  /** 配套 CSS 地址；内置包时为空串（用打包进来的那一份） */
  styleUrl: string;
  token: string | null;
  /** 参数写错时的降级说明，只用于往界面上贴一行提示，不参与加载决策 */
  warnings: string[];
}

export type HostFormat = 'umd' | 'esm';

const ENGINE_ALIASES: Record<string, HostEngine> = {
  maplibre: 'maplibre',
  ml: 'maplibre',
  'maplibre-gl': 'maplibre',
  mapbox: 'mapbox',
  mb: 'mapbox',
  mx: 'mapbox',
  'mapbox-gl': 'mapbox',
};

const CDN_ALIASES: Record<string, HostCdn> = {
  jsdelivr: 'jsdelivr',
  'jsdelivr-npm': 'jsdelivr',
  unpkg: 'unpkg',
  npmmirror: 'npmmirror',
  taobao: 'npmmirror',
};

/**
 * 版本号白名单。
 *
 * 只允许 semver 形态与 `latest`：这个字符串会被拼进 CDN 路径，`../` 之类的东西
 * 拼出什么 URL 都不奇怪，所以宁可在解析阶段就整条丢掉（退回默认版本）并记一条 warning。
 */
const VERSION_RE = /^(latest|\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?)$/;

function text(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function normalizeEngine(raw: string): HostEngine | null {
  return ENGINE_ALIASES[raw.toLowerCase()] ?? null;
}

function normalizeVersion(raw: string): string | null {
  const v = raw.replace(/^v/i, '');
  return VERSION_RE.test(v) ? v : null;
}

/** `?a=1&b=2` 或 `?a=1` 或 `a=1` 都能解析（`location.search` 与纯 query 两种入参） */
function searchParams(search: string): URLSearchParams {
  return new URLSearchParams(search.trim().replace(/^\?/, ''));
}

function at(version: string | null): string {
  return version ? `@${version}` : '';
}

/**
 * CDN 地址。
 *
 * npmmirror 的路径形态跟另外两家不一样（`/<pkg>/<version>/files/<path>`），
 * 它也是国内唯一稳定能取到 npm 原始文件的镜像，所以单独列一行。
 */
export function cdnAssetUrl(
  engine: HostEngine,
  version: string | null,
  cdn: HostCdn,
  file: string,
): string {
  const { pkg } = HOST_ENGINES[engine];
  if (cdn === 'npmmirror') {
    return `https://registry.npmmirror.com/${pkg}/${version ?? 'latest'}/files/${file}`;
  }
  if (cdn === 'unpkg') return `https://unpkg.com/${pkg}${at(version)}/${file}`;
  return `https://cdn.jsdelivr.net/npm/${pkg}${at(version)}/${file}`;
}

/**
 * 版本 → 该从 CDN 取哪个产物。
 *
 * MapLibre **v6 起不再发 UMD**：dist 里只有 `maplibre-gl.mjs` / `-shared.mjs` / `-worker.mjs`，
 * 照旧注入 `<script src=.../maplibre-gl.js>` 会稳定 404 —— 也就是「切到 6.x 就没反应」。
 * 所以 v6+ 走动态 `import()`，v5 及以前仍用 UMD（它家的 UMD 自带 worker 内联，最省事）。
 * Mapbox 反过来：v3 只有 UMD，没有可直接 import 的 ESM 构建。
 */
export function hostFormat(engine: HostEngine, version: string | null): HostFormat {
  const spec = HOST_ENGINES[engine];
  if (!spec.esmFile) return 'umd';
  if (!spec.umdFile) return 'esm';
  const major = majorOf(version);
  // 没给版本 / 给的 latest：按「当前发布线」算（maplibre 现在是 v6，只有 ESM）
  if (major === null) return 'esm';
  return spec.esmFromMajor !== null && major >= spec.esmFromMajor ? 'esm' : 'umd';
}

function majorOf(version: string | null): number | null {
  const match = /^(\d+)/.exec(version ?? '');
  return match ? Number(match[1]) : null;
}

export function cdnScriptUrl(
  engine: HostEngine,
  version: string | null,
  cdn: HostCdn,
  format: HostFormat = hostFormat(engine, version),
): string {
  const spec = HOST_ENGINES[engine];
  const file = (format === 'esm' ? spec.esmFile : spec.umdFile) ?? spec.umdFile ?? spec.esmFile;
  return cdnAssetUrl(engine, version, cdn, file as string);
}

export function cdnStyleUrl(engine: HostEngine, version: string | null, cdn: HostCdn): string {
  return cdnAssetUrl(engine, version, cdn, `dist/${HOST_ENGINES[engine].pkg}.css`);
}

/**
 * `.js` ↔ `.mjs` 互换。
 *
 * MapLibre v6 起不再发 UMD：`dist/maplibre-gl.js` 不存在，只有 `dist/maplibre-gl.mjs`。
 * 手写的地址（或从旧笔记里抄来的地址）大概率还是 `.js`，加载器拿它兜一次，而不是直接报错。
 * 只认 `maplibre-gl` 这一个文件名：mapbox 的 `.js` 是真 UMD，不能乱换。
 */
export function siblingFormatUrl(src: string): string | null {
  if (/\/maplibre-gl\.js(\?|$)/.test(src)) {
    return src.replace(/\/maplibre-gl\.js/, '/maplibre-gl.mjs');
  }
  if (/\/maplibre-gl\.mjs(\?|$)/.test(src)) {
    return src.replace(/\/maplibre-gl\.mjs/, '/maplibre-gl.js');
  }
  return null;
}

/**
 * URL → 加载计划。**幂等、不碰 DOM**，单测直接喂字符串。
 *
 * 默认（不带 `gl`）必须与改造前逐字一致：内置 maplibre、不注入任何外部资源。
 */
export function resolveHost(search: string): HostPlan {
  const params = searchParams(search);
  const warnings: string[] = [];

  const rawEngine = text(params.get('gl'));
  let engine: HostEngine = 'maplibre';
  if (rawEngine) {
    const parsed = normalizeEngine(rawEngine);
    if (parsed) engine = parsed;
    else warnings.push(`未知宿主「${rawEngine}」，已退回 MapLibre`);
  }

  const rawVersion = text(params.get('glv'));
  let version: string | null = null;
  if (rawVersion) {
    version = normalizeVersion(rawVersion);
    if (!version) warnings.push(`版本号「${rawVersion}」不像 semver，已忽略`);
  }

  const rawCdn = text(params.get('glcdn'));
  let cdn: HostCdn = 'jsdelivr';
  if (rawCdn) {
    const parsed = CDN_ALIASES[rawCdn.toLowerCase()];
    if (parsed) cdn = parsed;
    else warnings.push(`未知 CDN「${rawCdn}」，已退回 jsdelivr`);
  }

  let rawScript = text(params.get('glsrc'));
  const rawStyle = text(params.get('glcss'));

  // 三类参数都必须走 CDN：显式脚本地址、显式版本、以及「根本没有内置副本」的 mapbox。
  const source: HostSource =
    rawScript || version || !HOST_ENGINES[engine].bundled ? 'cdn' : 'bundled';

  const cdnVersion =
    source === 'bundled' ? null : (version ?? HOST_ENGINES[engine].defaultCdnVersion);

  // Mapbox 2.x 起 WebGL 上下文是 WebGL1（3.x 才默认 WebGL2），而 three r169 的渲染器要
  // WebGL2 才能建纹理数组/采样器对象 —— 装上也画不出模型。这里只提醒，不拦加载：
  // 拦掉的话连底图都看不到，反而更难判断问题在哪。
  if (engine === 'mapbox' && cdnVersion && majorOf(cdnVersion) !== null && majorOf(cdnVersion)! < 3) {
    warnings.push(
      `Mapbox GL ${cdnVersion} 用的是 WebGL1，three 需要 WebGL2，模型会画不出来；对照请用 3.x`,
    );
  }

  // 格式：显式 `?glfmt=` 最优先，其次看自托管地址的后缀，最后按引擎 + 版本推
  const rawFormat = text(params.get('glfmt')).toLowerCase();
  let format: HostFormat = rawScript && /\.mjs($|\?)/.test(rawScript)
    ? 'esm'
    : hostFormat(engine, cdnVersion);
  if (rawFormat === 'esm' || rawFormat === 'umd') format = rawFormat;
  else if (rawFormat) warnings.push(`未知产物格式「${rawFormat}」，按引擎与版本推断`);

  // MapLibre v6 起 dist 里没有 maplibre-gl.js。手写的地址多半还是 .js，
  // 与其让它 404 再兜，不如解析阶段就换成同一个构建的 .mjs。
  if (format === 'esm' && /\/maplibre-gl\.js(\?|$)/.test(rawScript)) {
    rawScript = rawScript.replace(/\/maplibre-gl\.js/, '/maplibre-gl.mjs');
    warnings.push('MapLibre v6 起不再发 UMD，已把 glsrc 的 .js 换成 .mjs');
  }

  const scriptUrl =
    source === 'bundled' ? '' : rawScript || cdnScriptUrl(engine, cdnVersion, cdn, format);
  const styleUrl =
    source === 'bundled' ? '' : rawStyle || cdnStyleUrl(engine, cdnVersion, cdn);

  return {
    engine,
    source,
    version: cdnVersion,
    cdn,
    format,
    scriptUrl,
    styleUrl,
    token: text(params.get('mapboxToken')) || null,
    warnings,
  };
}

export interface HostChoice {
  engine: HostEngine;
  /** null / 空串 = 该引擎的默认版本（内置副本或 defaultCdnVersion） */
  version?: string | null;
  cdn?: HostCdn | null;
}

/**
 * 生成切换后的 query（含前导 `?`，落到默认配置时返回空串）。
 *
 * 保留当前 URL 上所有别的参数 —— 数据集 `url`、底图 `basemap`、`ortho` 这些
 * 是用户正在看的现场，换个引擎不该把它们清掉。
 *
 * `glsrc` / `glcss` 会被清掉：它们是「手工指定的脚本」，点面板切换就是在表达
 * 「别用我上次手填的那个地址」，留着会让切换看起来没生效。
 */
export function applyHostChoice(search: string, choice: HostChoice): string {
  const params = searchParams(search);
  const version = text(choice.version ?? '');
  const isDefault = choice.engine === 'maplibre' && !version;

  params.delete('glsrc');
  params.delete('glcss');
  // 先删再设：URLSearchParams 保留插入顺序，不先删就会留下
  // `?gl=mapbox&url=cbd&glv=...` 这种一条参数被劈成两段的 URL，
  // 分享出去时读的人得看两处才知道换了什么引擎。
  params.delete('gl');
  params.delete('glv');
  params.delete('glcdn');

  if (!isDefault) {
    params.set('gl', choice.engine);
    if (version) params.set('glv', version);
    if (choice.cdn) params.set('glcdn', choice.cdn);
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

/** 面板上「当前引擎」那一行的文案（只认这几个字段，运行时信息可直接喂进来） */
export function describeHost(
  plan: Pick<HostPlan, 'engine' | 'source' | 'version' | 'cdn'>,
): string {
  const spec = HOST_ENGINES[plan.engine];
  if (plan.source === 'bundled') return `${spec.label} · 内置包`;
  const version = plan.version ? ` ${plan.version}` : '';
  return `${spec.label}${version} · CDN ${plan.cdn}`;
}

export interface HostCompatResult {
  /**
   * `map.getLayersOrder()` 的来源：
   * native = 宿主自带（MapLibre 1.x~6.x），shim = 本层补的（Mapbox 全系），none = 补不上
   */
  layersOrder: 'native' | 'shim' | 'none';
}

/**
 * 宿主兼容垫片。
 *
 * 只补**demo 真的用到**的那一处：`map.getLayersOrder()`。
 * 两家的 `Style` 都跳过 custom 层的序列化，所以 `getStyle().layers` 永远查不到 S3M 层，
 * `beforeId` 落空 → 矢量底图被追加到模型之后 → 2D 层拿 `DepthMode.disabled` 平铺盖住模型。
 * MapLibre 为此加了 `getLayersOrder()`，Mapbox 没有，但它保留着 `style._order`（含 custom 层）。
 *
 * 其余差异（`transform` 里的 fov / 内部投影矩阵）在 `S3MLayer` 与 `maplibreOrtho` 里
 * 已经按「v5 / v6 / Mapbox」三分支处理过，这里不重复。
 */
export function applyHostCompat(map: unknown): HostCompatResult {
  const target = map as { getLayersOrder?: unknown } | null | undefined;
  if (!target || typeof target !== 'object') return { layersOrder: 'none' };
  if (typeof target.getLayersOrder === 'function') return { layersOrder: 'native' };

  (target as { getLayersOrder: () => string[] }).getLayersOrder = function getLayersOrder() {
    return layerOrderOf(target);
  };
  return { layersOrder: 'shim' };
}

/** 当前样式里的图层顺序（含 custom 层），按可靠性三档退让 */
export function layerOrderOf(map: unknown): string[] {
  const style = (map as { style?: Record<string, unknown> } | null | undefined)?.style;
  const order = style?._order;
  if (Array.isArray(order)) return order.filter((id): id is string => typeof id === 'string');
  const layers = style?._layers;
  if (layers && typeof layers === 'object') return Object.keys(layers as object);
  const serialized = (map as { getStyle?: () => { layers?: { id: string }[] } } | null)?.getStyle?.();
  return Array.isArray(serialized?.layers) ? serialized.layers.map((l) => l.id) : [];
}
