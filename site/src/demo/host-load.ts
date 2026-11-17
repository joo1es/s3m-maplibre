/**
 * 按计划把宿主引擎搬进页面：内置包走 ESM 动态 import，CDN 版本按产物格式分别处理。
 *
 * 只有这里碰 GL 包与 DOM；`host.ts` 保持纯函数（SSG / 构建期也会被引用）。
 *
 * 三种加载形态，都是踩出来的：
 * 1. **内置包**（默认）：`import('maplibre-gl')`，CSS 用 Vite 的 `?url` 拿地址后自己注入。
 *    不用 `import 'xxx.css'`，是为了避免「切到 CDN 版本时页面里同时有两份 MapLibre 样式」。
 * 2. **CDN + UMD**（Mapbox 全系、MapLibre ≤5）：`<script>` 注入，等它挂上 `window.mapboxgl`。
 * 3. **CDN + ESM**（MapLibre ≥6）：动态 `import()`。v6 的 dist 里只有 `maplibre-gl.mjs`，
 *    照旧注入 `/dist/maplibre-gl.js` 会稳定 404 —— 这就是「切到 6.x 一片空白」的根因。
 *    另有一条兜底：`.js` 取不到时换成 `.mjs` 重试（重试要按**目标地址**的格式加载，
 *    把 .mjs 塞进 `<script>` 只会得到 `Cannot use 'import.meta' outside a module`）。
 *
 * 还有一层兜底是在 CDN 之间：`cdn.jsdelivr.net` 在国内时通时不通，取不到就按
 * `cdnFallbackOrder` 换下一条镜像（版本号不变，拿到的还是同一份产物）。
 * 手写 `?glsrc=` 不走这条：那是用户自托管的文件，换掉它等于换掉他的构建。
 */
import bundledCssUrl from 'maplibre-gl/dist/maplibre-gl.css?url';
import {
  HOST_ENGINES,
  PLACEHOLDER_MAPBOX_TOKEN,
  cdnFallbackOrder,
  cdnScriptUrl,
  cdnStyleUrl,
  resolveHost,
  siblingFormatUrl,
  type HostCdn,
  type HostEngine,
  type HostFormat,
  type HostPlan,
  type HostSource,
} from './host';

/** 两家 `Map` / `NavigationControl` 的形状一致，这里只声明页面真用到的那几个 */
export interface GlNamespace {
  Map: new (options: Record<string, unknown>) => Record<string, any>;
  NavigationControl: new (options?: Record<string, unknown>) => unknown;
  accessToken?: string;
  baseApiUrl?: string;
  config?: Record<string, unknown>;
  getVersion?: () => string;
  [extra: string]: any;
}

export interface HostRuntimeInfo {
  engine: HostEngine;
  source: HostSource;
  format: HostFormat;
  /** 实际生效的版本：内置包问包本身要，CDN 用 URL 里的那个 */
  version: string | null;
  cdn: HostCdn;
  scriptUrl: string;
  styleUrl: string;
  warnings: string[];
}

let gl: GlNamespace | null = null;
let engine: HostEngine = 'maplibre';
let runtimeInfo: HostRuntimeInfo | null = null;

/** 当前页用的是哪个引擎。加载前按默认（maplibre）算 */
export function hostEngine(): HostEngine {
  return engine;
}

/** 加载完成后的实际信息；未加载为 null */
export function loadedHost(): HostRuntimeInfo | null {
  return runtimeInfo;
}

/**
 * 拿宿主命名空间。**同步**，因为 `new Map()` 就写在页面初始化函数体中间。
 * 调用顺序由页面保证：先 `await loadHost()`，再取命名空间。
 */
export function getGl(): GlNamespace {
  if (!gl) throw new Error('[host] 宿主引擎还没加载：先 await loadHost()');
  return gl;
}

function readVersion(ns: unknown): string | null {
  const candidate = ns as { getVersion?: () => string; version?: string } | null;
  if (typeof candidate?.getVersion === 'function') return candidate.getVersion();
  if (typeof candidate?.version === 'string') return candidate.version;
  return null;
}

const STYLE_ID = 's3m-host-style';

/** 注入样式表。失败也不 reject：样式没到位顶多排版难看，不该连地图一起挡掉 */
function injectStyle(href: string): Promise<void> {
  if (!href) return Promise.resolve();
  document.getElementById(STYLE_ID)?.remove();
  return new Promise<void>((resolve) => {
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => {
      console.warn(`[host] 样式表加载失败：${href}`);
      resolve();
    };
    document.head.appendChild(link);
  });
}

/** 注入 UMD 脚本，等它把 `window[globalName]` 挂上 */
function loadScript(src: string, globalName: string): Promise<GlNamespace> {
  return new Promise<GlNamespace>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      const ns = (globalThis as Record<string, any>)[globalName];
      if (ns) resolve(ns as GlNamespace);
      else reject(new Error(`宿主脚本已加载，但没有挂上 window.${globalName}：${src}`));
    };
    script.onerror = () => {
      // 失败的标签留在 head 里没有意义，还会在 DevTools 里堆成一串红色 404；换镜像重试前先摘掉
      script.remove();
      reject(new Error(`宿主脚本加载失败（网络/地址）：${src}`));
    };
    document.head.appendChild(script);
  });
}

/** 跨域 ESM 走浏览器原生 import；`@vite-ignore` 是必须的，否则打包器会去解析这个外部地址 */
async function importEsm(src: string): Promise<GlNamespace> {
  return (await import(/* @vite-ignore */ src)) as unknown as GlNamespace;
}

/** 按目标产物的格式取一次：ESM 只能 import，UMD 只能注入 `<script>` */
async function loadArtifact(
  format: HostFormat,
  src: string,
  globalName: string,
): Promise<GlNamespace> {
  return format === 'esm' ? await importEsm(src) : await loadScript(src, globalName);
}

/**
 * 先按计划格式取，取不到就换同名产物再试一次。
 *
 * 只对 `maplibre-gl.js ↔ maplibre-gl.mjs` 这一对生效（见 `siblingFormatUrl`）：
 * 手写的地址、或者「版本号没写到能判断大版本」的情况下，格式判断可能落空。
 * 重试必须按**目标地址**的格式加载，把 .mjs 塞进 `<script>` 只会得到 import.meta 的语法错。
 */
async function loadWithSiblingRetry(
  format: HostFormat,
  src: string,
  globalName: string,
  warnings: string[],
): Promise<GlNamespace> {
  try {
    return await loadArtifact(format, src, globalName);
  } catch (err) {
    const retry = siblingFormatUrl(src);
    if (!retry) throw err;
    const retryFormat: HostFormat = /\.mjs(\?|$)/.test(retry) ? 'esm' : 'umd';
    warnings.push(
      retryFormat === 'esm'
        ? `UMD 产物不存在（MapLibre v6 起只发 .mjs），已改用 ESM 加载：${retry}`
        : `ESM 产物取不到，改用 UMD 加载：${retry}`,
    );
    return await loadArtifact(retryFormat, retry, globalName);
  }
}

interface CdnLoadResult {
  ns: GlNamespace;
  cdn: HostCdn;
  scriptUrl: string;
  styleUrl: string;
}

/**
 * 按 CDN 兜底顺序取脚本：先用户选的那家，最后才报错。
 *
 * 每换一家都重新注入样式：脚本换到 unpkg 而样式还指着不可达的 jsdelivr，
 * 画面会是「地图能跑、控件全裸」的样子，比直接失败更难查。
 */
async function loadFromCdn(
  plan: HostPlan,
  spec: (typeof HOST_ENGINES)[HostEngine],
  warnings: string[],
): Promise<CdnLoadResult> {
  const order = cdnFallbackOrder(plan.cdn);
  const failures: string[] = [];

  for (const cdn of order) {
    const styleUrl = cdnStyleUrl(plan.engine, plan.version, cdn);
    const scriptUrl = cdnScriptUrl(plan.engine, plan.version, cdn, plan.format);
    await injectStyle(styleUrl);
    try {
      const ns = await loadWithSiblingRetry(plan.format, scriptUrl, spec.global, warnings);
      if (cdn !== plan.cdn) warnings.push(`${plan.cdn} 取不到，已改用 ${cdn}`);
      return { ns, cdn, scriptUrl, styleUrl };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${cdn}: ${message}`);
    }
  }

  throw new Error(`宿主脚本在 ${order.length} 个 CDN 上都取不到 —— ${failures.join('；')}`);
}

/**
 * 按 `?gl= / ?glv= / ?glcdn= / ?glsrc= / ?glfmt=` 把引擎装好，返回实际生效的信息。
 *
 * 内置包路径（默认）与改造前逐字等价：`import('maplibre-gl')` + 同一份 css，
 * 只是 css 从静态依赖变成 `<link>`。
 */
export async function loadHost(
  plan: HostPlan = resolveHost(window.location.search),
): Promise<HostRuntimeInfo> {
  const spec = HOST_ENGINES[plan.engine];
  let ns: GlNamespace;
  let version: string | null = plan.version;
  let styleUrl = plan.styleUrl;
  let scriptUrl = plan.scriptUrl;
  let cdn = plan.cdn;
  const warnings = [...plan.warnings];

  if (plan.source === 'bundled') {
    styleUrl = bundledCssUrl;
    await injectStyle(styleUrl);
    const mod = (await import('maplibre-gl')) as unknown as GlNamespace;
    ns = mod;
    version = readVersion(mod) ?? version;
  } else if (plan.selfHosted) {
    // 手写 `?glsrc=` 是「我就要这个文件」：取不到就报错，不替用户换镜像
    await injectStyle(plan.styleUrl);
    ns = await loadWithSiblingRetry(plan.format, plan.scriptUrl, spec.global, warnings);
    version = plan.version ?? readVersion(ns);
  } else {
    const loaded = await loadFromCdn(plan, spec, warnings);
    ns = loaded.ns;
    cdn = loaded.cdn;
    scriptUrl = loaded.scriptUrl;
    styleUrl = loaded.styleUrl;
    version = plan.version ?? readVersion(ns);
  }

  // Mapbox v2+ 会拿 accessToken 去打 map-sessions 与 events：本页一次 mapbox:// 都不发
  // （底图全是 Esri / OSM 的栅格瓦片），这两条通道纯属噪声 —— 不关掉的话控制台会稳定刷 401，
  // 并 fire 一条「A valid Mapbox access token is required」。
  // 关法来自 dist 里导出的 `config` / `baseApiUrl`：API_URL 为空时 getSession 直接 return，
  // EVENTS_URL 也返回 null；REQUIRE_ACCESS_TOKEN=false 让 URL 归一化不再要求 token。
  // 老版本（v1）没有这两个出口，退回一个格式像样的占位 token。
  if (plan.engine === 'mapbox') {
    if (ns.config) ns.config.REQUIRE_ACCESS_TOKEN = false;
    if (plan.token) ns.accessToken = plan.token;
    else if (ns.config && 'baseApiUrl' in ns) ns.baseApiUrl = '';
    else ns.accessToken = PLACEHOLDER_MAPBOX_TOKEN;
  }

  gl = ns;
  engine = plan.engine;

  runtimeInfo = {
    engine: plan.engine,
    source: plan.source,
    format: plan.format,
    version,
    cdn,
    scriptUrl,
    styleUrl,
    warnings,
  };

  // 方便在控制台 / 无头浏览器里读「这一页到底是哪个引擎跑的」
  document.body.dataset.s3mHost = plan.engine;
  document.body.dataset.s3mHostVersion = version ?? '';
  document.body.dataset.s3mHostSource = plan.source;
  document.body.dataset.s3mHostFormat = plan.format;

  return runtimeInfo;
}
