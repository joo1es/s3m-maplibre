/**
 * 独立页面：同一个 CBD 模型，跑在不同宿主引擎 / 不同版本上。
 *
 * 和「数据集演示」页分开是有意的：
 * - 那页的面板是给数据源 / 样式 / 拾取用的，宿主只是背景；这页反过来，只有宿主是变量，
 *   数据集固定成 `demo/data/CBD`，一眼就能对照两家的渲染差异。
 * - 切换靠**重载页面**，不在原地换引擎：两家各带一份 CSS、各自占一个 WebGL 上下文与
 *   worker 池，原地换省下的那点时间换不来一个干净的世界。
 *
 * URL 参数见 `site/src/demo/host.ts` 顶部注释；面板上能选的这里都能写进地址栏。
 */
import { S3MLayer, STYLE, extractWorldCoordinateHelper } from 's3m-maplibre';
import { mountDemoTabs } from '../shared/demo-tabs';
import {
  HOST_ENGINES,
  HOST_PRESETS,
  applyHostChoice,
  applyHostCompat,
  describeHost,
  resolveHost,
  type HostCdn,
  type HostEngine,
} from '../demo/host';
import { getGl, loadHost, type GlNamespace, type HostRuntimeInfo } from '../demo/host-load';

mountDemoTabs('host');

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 与「数据集演示」页同一份数据：仓库自带的 CBD */
const CBD = './data/CBD/cbd.scp';

/**
 * CBD 的固定机位，可被 URL 覆盖：`?zoom=17.7&pitch=50&bearing=-25&lng=116.4581&lat=39.9123`。
 *
 * 为什么要能钉机位：对照两个引擎时，**唯一变量必须是引擎本身**。之前踩的坑就是一边
 * 15.2、一边 17.72（差 2.5 级 ≈ 5.7 倍视角），肉眼看当然"楼变大/变小"，但那不是渲染差异。
 * 机位参数不在宿主切换的清理名单里（见 `applyHostChoice`），换引擎后会被原样带过去。
 *
 * 之所以不 `fitBounds`：这份 .scp 声明范围约 2.7 km 见方，真正有楼的街区只占中心一小块，
 * fitBounds 会把 CCTV 那几栋压成十几个像素；更要紧的是两家的 `cameraForBounds` 对 pitch 的
 * 默认值不一样（Mapbox 默认 0，MapLibre 用当前值），同一段代码会得到两个不同的初始视角。
 */
function numParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const CAMERA_PARAMS = new URLSearchParams(location.search);

const CAMERA = {
  center: [
    numParam(CAMERA_PARAMS, 'lng', 116.4581),
    numParam(CAMERA_PARAMS, 'lat', 39.9123),
  ] as [number, number],
  zoom: numParam(CAMERA_PARAMS, 'zoom', 15.2),
  pitch: numParam(CAMERA_PARAMS, 'pitch', 50),
  bearing: numParam(CAMERA_PARAMS, 'bearing', -25),
};

/** Esri 浅灰，免 key；CBD 这片楼在这个底图上对比度最好 */
const BASEMAP_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
];
const BASEMAP_ATTRIBUTION = '© Esri, HERE, Garmin, © OpenStreetMap contributors';

const CDNS: { id: HostCdn; label: string }[] = [
  { id: 'jsdelivr', label: 'jsdelivr' },
  { id: 'unpkg', label: 'unpkg' },
  { id: 'npmmirror', label: 'npmmirror（国内）' },
];

const plan = resolveHost(location.search);

/* ---------------------------------------------------------------- 顶部切换条 */

/**
 * 切换条用原生 DOM 而不是框架：这一页没有别的 UI，为一个下拉框引一整套运行时
 * （还带着 SSR 与 hydration）不划算。样式与「数据集演示」页同一套命名。
 */
function buildBar(): void {
  const bar = $('bar');
  bar.innerHTML = `
    <h1>宿主引擎</h1>
    <div class="row">
      <select id="engine">${Object.entries(HOST_ENGINES)
        .map(([id, spec]) => `<option value="${id}">${spec.label}</option>`)
        .join('')}</select>
      <input id="version" type="text" spellcheck="false"
        placeholder="版本，如 6.18.0；空 = 内置/默认" />
    </div>
    <div class="row">
      <select id="cdn">${CDNS.map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}</select>
      <button id="apply" type="button">切换并重载</button>
    </div>
    <div class="presets" id="presets"></div>
  `;

  const engineEl = $<HTMLSelectElement>('engine');
  const versionEl = $<HTMLInputElement>('version');
  const cdnEl = $<HTMLSelectElement>('cdn');
  const presetsEl = $('presets');

  engineEl.value = plan.engine;
  versionEl.value = plan.source === 'cdn' ? (plan.version ?? '') : '';
  cdnEl.value = plan.cdn;

  const go = (engine: HostEngine, version: string, cdn: HostCdn) => {
    const search = applyHostChoice(location.search, { engine, version, cdn });
    location.replace(`${location.pathname}${search}${location.hash}`);
  };

  $('apply').addEventListener('click', () =>
    go(engineEl.value as HostEngine, versionEl.value.trim(), cdnEl.value as HostCdn),
  );
  versionEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $<HTMLButtonElement>('apply').click();
  });
  // 换引擎时把版本清掉：一个 maplibre 的版本号填在 mapbox 里只会得到一个 404
  engineEl.addEventListener('change', () => {
    const next = engineEl.value as HostEngine;
    versionEl.value = next === plan.engine && plan.source === 'cdn' ? (plan.version ?? '') : '';
    versionEl.placeholder =
      next === 'mapbox'
        ? `版本，如 3.35.0；空 = ${HOST_ENGINES.mapbox.defaultCdnVersion}`
        : '版本，如 6.18.0；空 = 内置';
  });

  for (const preset of HOST_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = preset.label;
    const isCurrent =
      preset.engine === plan.engine &&
      (preset.version ?? '') === (plan.source === 'cdn' ? (plan.version ?? '') : '');
    if (isCurrent) btn.classList.add('active');
    btn.addEventListener('click', () => go(preset.engine, preset.version ?? '', plan.cdn));
    presetsEl.appendChild(btn);
  }
}

/* ---------------------------------------------------------------- HUD */

let info: HostRuntimeInfo | null = null;
let layersOrder: 'native' | 'shim' | 'none' = 'none';
let helperName: string | null = null;

/** 4×4 列主序矩阵 × 4 分量向量（three 的 elements 就是这个布局） */
function mulMatVec(m: ArrayLike<number>, v: readonly number[]): [number, number, number, number] {
  const x = v[0]!, y = v[1]!, z = v[2]!, w = v[3]!;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w,
  ];
}

/**
 * 模型在屏幕上的像素包围盒。
 *
 * 这是「顶点 → 米→墨卡托 → ENU 矩阵 → MVP → 视口」这条链的**最终结果**，
 * 也是唯一能用来判断"两家大小是否真的不同"的客观量：同一个机位、同一份数据下，
 * 两页的这个数字必须相同（允许 ≤0.1% 的 canvas 取整差异）。
 * 靠肉眼看截图会混进裁剪、窗口缩放、截图工具缩放，这个数字不会。
 */
function modelPixelBox(): { w: number; h: number } | null {
  const viewer = (window as any).__s3m?.layer?.viewer;
  const canvas = $('map')?.querySelector('canvas') as HTMLCanvasElement | null;
  const cam = viewer?.camera;
  const scene = viewer?.scene;
  if (!viewer || !canvas || !cam || !scene) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let boxes = 0;

  scene.traverse((o: any) => {
    if (!o.isMesh && !o.isPoints) return;
    if (!o.visible || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    if (!bb) return;
    boxes++;
    for (let i = 0; i < 8; i++) {
      const corner = [
        i & 1 ? bb.max.x : bb.min.x,
        i & 2 ? bb.max.y : bb.min.y,
        i & 4 ? bb.max.z : bb.min.z,
        1,
      ] as const;
      const world = mulMatVec(o.matrixWorld.elements, corner);
      const clip = mulMatVec(cam.projectionMatrix.elements, world);
      if (clip[3] === 0) continue;
      const ndcX = clip[0]! / clip[3]!;
      const ndcY = clip[1]! / clip[3]!;
      minX = Math.min(minX, ndcX);
      maxX = Math.max(maxX, ndcX);
      minY = Math.min(minY, ndcY);
      maxY = Math.max(maxY, ndcY);
    }
  });

  if (!boxes || !Number.isFinite(minX)) return null;
  const w = Math.round(((maxX - minX) / 2) * canvas.width);
  const h = Math.round(((maxY - minY) / 2) * canvas.height);
  return { w, h };
}

function renderHud(stats?: { tiles: number; meshes: number; draws?: number; fps?: number }): void {
  const lines: string[] = [];
  if (info) {
    lines.push(
      info.source === 'bundled'
        ? `${describeHost(info)}（打包进页面）`
        : `${describeHost(info)} · ${info.format === 'esm' ? 'ESM 动态 import' : 'UMD <script>'}`,
    );
    lines.push(
      `图层顺序 ${layersOrder === 'native' ? '原生 getLayersOrder' : layersOrder === 'shim' ? '垫片（宿主没有 getLayersOrder）' : '—'}` +
        ` · 坐标助手 ${helperName ?? '无，走 Web 墨卡托兜底'}`,
    );
    if (info.warnings.length) lines.push(`⚠ ${info.warnings.join('；')}`);
  }
  if (stats) {
    lines.push(
      `瓦片 ${stats.tiles} · 网格 ${stats.meshes} · Draw ${stats.draws ?? '—'} · FPS ${stats.fps ?? '—'}`,
    );
  }
  // 机位必须露出来：两个引擎对照时，"是不是同一机位"是第一个要排除的变量
  const cam = CAMERA.center;
  lines.push(
    `机位 ${cam[0].toFixed(4)},${cam[1].toFixed(4)} · z${CAMERA.zoom} · pitch ${CAMERA.pitch} · bearing ${CAMERA.bearing}`,
  );
  // 像素密度同理：浏览器缩放（100% / 150%）会改 devicePixelRatio，同一 zoom 下模型在
  // 截图里的像素大小会整体差 1.5 倍，但模型与底图的**相对**比例不变 —— 两件事必须分开看。
  // 有这一行，两次截图是不是同一 DPR 一望即知，不用再猜"大小不对"。
  const canvas = $('map')?.querySelector('canvas') as HTMLCanvasElement | null;
  if (canvas) {
    lines.push(
      `画布 ${canvas.width}×${canvas.height} px · CSS ${canvas.clientWidth}×${canvas.clientHeight} · DPR ${window.devicePixelRatio || 1}`,
    );
  }
  // 尺寸的可核对量：同一个机位、同一份数据，两页这一行必须相同
  const box = modelPixelBox();
  if (box) lines.push(`模型 ${box.w}×${box.h} px（屏幕包围盒，两家对照就看这个）`);
  $('hud').textContent = lines.join('\n');
}

function showFailure(err: unknown): void {
  const box = $('fail');
  box.hidden = false;
  const message = err instanceof Error ? err.message : String(err);
  box.innerHTML = `
    <b>宿主引擎没加载起来</b>
    <p><code>${message}</code></p>
    <p>指定版本走 CDN（jsdelivr / unpkg / npmmirror），断网或镜像不可达时会停在这一步。</p>
    <p><a href="./host.html">回到内置 MapLibre</a></p>
  `;
  console.error('[host] 加载失败', err);
}

/* ---------------------------------------------------------------- 地图 + CBD */

function baseStyle() {
  return {
    version: 8,
    sources: {
      esri: {
        type: 'raster',
        tiles: BASEMAP_TILES,
        tileSize: 256,
        maxzoom: 16,
        attribution: BASEMAP_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e9edf2' } },
      { id: 'esri', type: 'raster', source: 'esri' },
    ],
  };
}

async function boot(): Promise<void> {
  // 先挂切换条：引擎加载失败时它反而是唯一能自救的东西
  buildBar();
  $('hud').textContent = `正在加载宿主引擎…（${describeHost(plan)}）`;

  try {
    info = await loadHost(plan);
  } catch (err) {
    showFailure(err);
    return;
  }

  renderHud();

  const maplibregl: GlNamespace = getGl();
  const map = new maplibregl.Map({
    container: 'map',
    style: baseStyle(),
    center: CAMERA.center,
    zoom: CAMERA.zoom,
    pitch: CAMERA.pitch,
    bearing: CAMERA.bearing,
    maxPitch: 85,
    attributionControl: { compact: true },
  });
  // 导航控件放右下：右上角留给切换条，避免两者叠在一起
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.on('error', (e: any) => console.warn('[host] map error', e?.error?.message ?? e));

  // Mapbox 没有 getLayersOrder()，补一层；顺便把「这台引擎给了什么」写进 HUD
  layersOrder = applyHostCompat(map).layersOrder;
  const helper = extractWorldCoordinateHelper(map);
  helperName = helper ? helper.name || 'WorldCoordinateHelper' : null;
  renderHud();

  const layer = new S3MLayer({
    id: 's3m',
    maxTiles: 4096,
    maxConcurrent: 6,
    style: {
      mode: STYLE.TEXTURE,
      colorA: '#ffffff',
      colorB: '#1d4ed8',
      colorC: '#fbbf24',
      selectColor: '#22d3ee',
      outline: true,
      outlineStyle: 'edges',
      outlineColor: '#22d3ee',
      outlineWidthPx: 3,
    },
  });

  // 图层必须等样式加载完再挂：否则宿主会抛 `Style is not done loading`
  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  map.addLayer(layer);

  try {
    await layer.addDataset({ id: 'cbd', name: 'CBD', configUrl: CBD });
    // 机位固定（理由见 CAMERA 注释）：两页对照时唯一变量必须是引擎本身。
    // 数据集真的换了（改了 CBD 常量）再考虑按 bounds 兜底，那时两家的 cameraForBounds
    // 差异要单独处理 —— pitch 记得显式传，否则 Mapbox 会掰回俯视。
    map.jumpTo(CAMERA);
  } catch (err) {
    console.warn('[host] CBD 数据集加载失败', err);
  }

  setInterval(() => {
    const stats = layer.stats;
    renderHud({
      tiles: stats?.tiles ?? 0,
      meshes: stats?.meshes ?? 0,
      draws: stats?.drawCalls,
      fps: layer.fps,
    });
  }, 600);

  // 无头浏览器 / 控制台自检用
  (window as any).__s3m = { map, layer, host: info };
}

void boot();
