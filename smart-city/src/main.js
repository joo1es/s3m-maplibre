/**
 * CITY OS · 智慧城市数字孪生 showcase
 *
 * 独立入口：不依赖 site/ 的 Solid 面板、不依赖 dev 中间件的路由白名单，
 * 直接用 workspace 包 + site/src/examples 的现成特效，自己起一个 vite 就能跑。
 *
 * 刻意不接外部栅格底图：CBD 服务自带 Ground / Ground2 / Lake 图层，纯深色底
 * + sky 已经能撑住整个画面，还少一个境外瓦片源拖首屏（AGENTS.md 第 4 节的坑）。
 */
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as THREE from 'three';
import { S3MLayer, STYLE } from 's3m-maplibre';
import '../style.css';

import { DATASETS, configUrlOf, CAMERA, THEME } from './config.js';
import { Hud } from './hud.js';
import { Effects } from './effects.js';
import { Show } from './show.js';
import { WaterSurface } from './water.js';
import { CityFog } from './fog.js';
import { warmupCity } from './warmup.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 程序化等距柱状天空（2:1），交给 setEnvironment 走 PMREM。
 * 不接外部 HDR：少一个资源请求，也不受 CDN / 跨域影响。
 * 目的是给 PBR 材质一个反射源 —— 水面 roughness 0.12、玻璃幕墙都吃这一口，
 * 没有 environment 时它们只剩两盏平行光的高光点，看起来就是死的深色块。
 */
function makeSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.00, '#5f98dd');
  grad.addColorStop(0.38, '#a9cdf0');
  grad.addColorStop(0.50, '#f3e7d2');
  grad.addColorStop(0.62, '#7e9cbd');
  grad.addColorStop(1.00, '#182a3e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 512);
  // 一个明确的亮斑，给水面和幕墙提供可辨认的镜面高光来源
  const sun = ctx.createRadialGradient(690, 178, 0, 690, 178, 165);
  sun.addColorStop(0.0, 'rgba(255,252,240,1)');
  sun.addColorStop(0.28, 'rgba(255,243,214,0.62)');
  sun.addColorStop(1.0, 'rgba(255,243,214,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, 1024, 512);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

/* ------------------------------------------------------------------ 状态 */

let hud;
let show;
let effects;
let water;
let fog;
let map;
let layer;

const qs = new URLSearchParams(location.search);
// ?fog=0 关掉体积雾，方便对照「有雾 / 无雾」两张截图
const fogEnabled = qs.get('fog') !== '0';
// ?warm=0 直接撤遮罩（调试对照用）；?warmMs=15000 放宽首屏预热上限
const warmEnabled = qs.get('warm') !== '0';
const warmBudgetMs = Number(qs.get('warmMs')) || undefined;
let stats = { tiles: 0, meshes: 0, triangles: 0, loading: 0, failed: 0 };
let loadedCount = 0;
let warmSkipped = false;
let warmReport = null;

// 预加载可能跑几十秒，必须给一个出口。Escape 与遮罩点击二选一，
// 不占用 Space（HUD 已把 Space 绑成播放/暂停，会误启动演出）。
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') warmSkipped = true; });
document.getElementById('loading')?.addEventListener('click', () => { warmSkipped = true; }, { once: true });

/* ------------------------------------------------------------------ 地图 */

map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#08182b' } }],
    // pitch 压大以后地平线以上没有任何图层覆盖，只剩 renderer 的清屏色（黑）。
    // sky 不是装饰，是补那块「天上破了个洞」的必要配置。
    // fog-color 刻意与 fog.js 的 SCENE_FOG_COLOR 完全一致：远处模型被 three 的
    // FogExp2 衰减到这个色，天空也是这个色，模型边界就不会硬切在近黑底图上。
    sky: {
      'sky-color': '#112a45',
      'sky-horizon-blend': 0.78,
      'horizon-color': '#2b5786',
      'horizon-fog-blend': 0.68,
      'fog-color': '#163352',
      'fog-ground-blend': 0.55,
    },
  },
  center: CAMERA.start.center,
  zoom: CAMERA.start.zoom,
  pitch: CAMERA.start.pitch,
  bearing: CAMERA.start.bearing,
  maxPitch: 85,
  antialias: true,
  attributionControl: false,
});

/* ------------------------------------------------------------------ S3M 图层 */

layer = new S3MLayer({
  id: 's3m',
  // 7 个数据集实测 191 块根瓦片，预算给小了每帧都在淘汰-重下，纹理会永远停在最粗一级
  maxTiles: 4096,
  // 保持 6：服务端实测是 HTTP/1.1 + keep-alive（openresty，无 h2），浏览器同域名
  // 只有 6 条连接。7 个数据集已经远超这个上限，再提并发只会让请求在浏览器里
  // 排队、还可能把 Building 的根瓦片挤到队尾。h1 下唯一有效的是减少请求总数。
  maxConcurrent: 6,
  // 默认 false 是「全向加载」——视野外的瓦片照样继续细化，特写机位下 360° 的
  // 子瓦片全都会被拉下来，这是瓦片数爆炸的最大来源。API 明确它只管请求、
  // 不管绘制（画不画一律按宿主 MVP 视锥），视野内画质零损失。
  cullRefine: true,
  // LOD 阈值按绘图缓冲的物理像素高度算，2x/3x 屏细化层数跟着翻倍。按 CSS 高度
  // ×1.5 截断，高分屏上少一整层瓦片；普通 1080p（DPR 1）此值不产生任何影响。
  lodPixelRatioCap: 1.5,
  // MapLibre 的 nearZ 写死是 canvasHeight/50，zoom 16.8 贴脸看会把楼整片裁掉
  nearPlaneScale: 0.25,
  // 增量细化：子瓦片就绪一个显示一个，未就绪区域由父瓦片垫底，巡游时不会整块跳变
  lodTransition: 'incremental',
  style: {
    // 原色是这套数据的主角的：玻璃幕墙、铺装、植被、水面贴图全靠它。
    // 科技配色只在演出幕里以 texMix 叠加，绝不覆盖贴图。
    mode: STYLE.TEXTURE,
    texMix: 0,
    ambientGain: 0.06,
    selectColor: THEME.cyan,
    outline: true,
    outlineStyle: 'edges',
    outlineWidthPx: 3,
    edgeColor: THEME.cyanSoft,
    edgeWidth: 1.3,
    edgeOpacity: 0,
    dimOthers: false,
    fadeIn: 900,
    opacity: 0,
  },
  onStats: (s) => {
    stats = s;
    if (s.loading > 4) hud?.setStatus(`加载瓦片 · 队列 ${s.loading}`, 'busy');
    else if (s.failed > 0) hud?.setStatus(`就绪 · ${s.failed} 块失败`, 'err');
    else hud?.setStatus('实时渲染中', '');
  },
  onError: (e) => {
    console.warn('[city] S3M error', e);
    hud?.setStatus('瓦片加载异常', 'err');
  },
});

layer.onPick = (f) => {
  if (f) hud?.showFeature(f);
  else hud?.hideFeature();
};

/* ------------------------------------------------------------------ HUD 与演出 */

hud = new Hud({
  onSeek: (i) => show?.seek(i),
  onPrev: () => show?.prev(),
  onNext: () => show?.next(),
  onPlayToggle: () => show?.togglePlay(),
  onReplay: () => show?.replay(),
  onLoopToggle: () => show && show.setLoop(!show.loop),
  onFreeToggle: () => show && show.setFree(!show.free),
});
hud.setLoop(true);
hud.setPlaying(false);
hud.setLoading('连接 SuperMap iServer 三维数据服务…', 4);

effects = new Effects(layer);
water = new WaterSurface({ layer, map });
fog = new CityFog({ layer });
show = new Show({ map, layer, effects, hud });

/** 400ms 汇一次：onStats 是每次瓦片就绪都来，直接刷 DOM 会抖 */
setInterval(() => {
  const gpu = layer.stats ?? {};
  hud.setStats({
    tiles: stats.tiles,
    meshes: stats.meshes,
    triangles: stats.triangles,
    fps: layer.fps,
    drawCalls: gpu.drawCalls,
    programs: gpu.programs,
    textures: gpu.textures,
    datasets: layer.datasets?.size ?? 0,
  });
  hud.pushFps(layer.fps || 0);
}, 450);

/* ------------------------------------------------------------------ 加载 */

async function loadCity() {
  // 环境反射是「有材质」和「一块色」的分界线。放在瓦片开始加载之后调，
  // 此时 viewer / renderer 一定已就绪（PMREM 要用 WebGL 上下文）；失败也不拖垮主流程。
  layer.setEnvironment(makeSkyTexture(), 0.85).catch((e) => {
    console.warn('[city] 环境贴图不可用（不影响几何与贴图）', e);
  });

  hud.setLoading('解析 7 个数据集配置…', 6);

  const tasks = DATASETS.map(async (d) => {
    try {
      await layer.addDataset({
        id: d.id,
        name: d.label,
        configUrl: configUrlOf(d.id),
        // 数据集级水面特效：Lake@CBD 的 config 声明了 955833.water，
        // 打开后会用配置里真实的 waterColour(0, .63, .91) / brightness / alpha
        // 替代内置的深墨蓝兜底色；其余数据集没有 .water 附件，零额外请求。
        // 解析出的菲涅尔 / 噪声参数还会被 water.js 拿去驱动水纹。
        waterEffect: true,
      });
      loadedCount += 1;
      hud.setLoading(
        `加载城市要素 ${loadedCount}/${DATASETS.length} · ${d.label}`,
        6 + (loadedCount / DATASETS.length) * 56,
      );
      return true;
    } catch (e) {
      // 单个图层失败不拖垮整场演出：地面/植被少一层，建筑还在
      console.warn(`[city] 数据集 ${d.id} 加载失败`, e);
      return false;
    }
  });

  const results = await Promise.all(tasks);
  const ok = results.filter(Boolean).length;

  if (!ok) {
    // 一个数据集都没起来，没必要白等瓦片；直接撤遮罩让界面还能交互
    hud.setLoading('数据服务未响应', 100,
      '请确认能访问 www.supermapol.com（必要时走本地代理），其它图层会继续尝试。');
    await sleep(1200);
  } else {
    hud.setLoading('编译着色程序 · 点击遮罩 / Esc 跳过', 64);
    // 内核自带 prewarmShading（compileAsync / KHR_parallel_shader_compile），
    // 首帧会自动跑一次；这里显式 await，把 program 编译也藏进遮罩里。
    try {
      await layer.prewarmShading?.();
    } catch (e) {
      console.warn('[city] 着色预热失败（不影响渲染）', e);
    }

    // 只预热首屏：镜头短暂移到俯冲落点，让 LOD 把首屏要用的中等精度瓦片发出来，
    // 增长停滞就撤遮罩。精细层交给演出中 26 秒的渐进细化，不在这里阻塞等到底。
    if (warmEnabled) {
      warmReport = await warmupCity({
        map,
        layer,
        hud,
        isSkipped: () => warmSkipped,
        budgetMs: warmBudgetMs,
        initialPct: 64,
      });
      console.info('[city] 瓦片预加载报告', warmReport);
    } else {
      warmReport = { skipped: true, timedOut: false, ms: 0, tiles: stats.tiles, views: [] };
    }

    const note = warmReport.timedOut
      ? ' · 首屏已就绪，余下瓦片在巡游中增量细化'
      : warmReport.skipped ? ' · 已跳过首屏预热' : '';
    hud.setLoading(
      `就绪 · ${ok}/${DATASETS.length} 个数据集 · 预载 ${warmReport.tiles.toLocaleString('zh-CN')} 块瓦片${note}`,
      100,
    );
    // 最后一批纹理上传 / program 链接还在 GPU 队列里，让几帧跑完再撤遮罩
    map.triggerRepaint();
    await sleep(400);
  }

  hud.hideLoading();
  hud.setStatus(ok ? '实时渲染中' : '数据源不可用', ok ? '' : 'err');
  water.start();
  if (fogEnabled) fog.start();
  show.start();
  if (!ok) hud.toast('三维服务未连通，界面仍可交互；检查网络后刷新页面', 5000);
}

map.once('style.load', () => {
  map.addLayer(layer);
  // 原色贴图要的是「像白天拍的城市」：暖白主光把立面拉开，中性偏亮的天空光
  // 托住背光面。之前的冷蓝环境光会把玻璃幕墙压成灰蓝，贴图的层次全丢。
  layer.setLight({
    mode: 'fixed',
    mainIntensity: 1.42,
    ambientIntensity: 0.92,
    mainColor: '#fff3e0',
    ambientColor: '#93b2d4',
    altitude: 48,
    azimuth: 130,
  });
  loadCity().catch((e) => {
    console.error('[city] 初始化失败', e);
    hud.setLoading('初始化失败', 100, String(e?.message ?? e));
  });
});

// 调试出口：控制台里可以直接改样式、跳幕、看统计
window.__city = {
  map, layer, show, effects, water, fog, hud,
  get stats() { return stats; },
  get warmup() { return warmReport; },
};
