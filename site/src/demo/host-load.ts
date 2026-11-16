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
 */
import bundledCssUrl from 'maplibre-gl/dist/maplibre-gl.css?url';
import {
  HOST_ENGINES,
  PLACEHOLDER_MAPBOX_TOKEN,
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
    script.onerror = () => reject(new Error(`宿主脚本加载失败（网络/地址）：${src}`));
    document.head.appendChild(script);
  });
}

/** 跨域 ESM 走浏览器原生 import；`@vite-ignore` 是必须的，否则打包器会去解析这个外部地址 */
async function importEsm(src: string): Promise<GlNamespace> {
  return (await import(/* @vite-ignore */ src)) as unknown as GlNamespace;
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
  const warnings = [...plan.warnings];

  if (plan.source === 'bundled') {
    styleUrl = bundledCssUrl;
    await injectStyle(styleUrl);
    const mod = (await import('maplibre-gl')) as unknown as GlNamespace;
    ns = mod;
    version = readVersion(mod) ?? version;
  } else {
    await injectStyle(plan.styleUrl);
    try {
      ns =
        plan.format === 'esm'
          ? await importEsm(plan.scriptUrl)
          : await loadScript(plan.scriptUrl, spec.global);
    } catch (err) {
      const retry = siblingFormatUrl(plan.scriptUrl);
      if (!retry) throw err;
      // 重试要用**目标地址**的格式来加载：`.mjs` 只能 import，`.js` 只能注入脚本。
      const retryEsm = /\.mjs(\?|$)/.test(retry);
      warnings.push(
        retryEsm
          ? `UMD 产物不存在（MapLibre v6 起只发 .mjs），已改用 ESM 加载：${retry}`
          : `ESM 产物取不到，改用 UMD：${retry}`,
      );
      ns = retryEsm ? await importEsm(retry) : await loadScript(retry, spec.global);
    }
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
    cdn: plan.cdn,
    scriptUrl: plan.scriptUrl,
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
