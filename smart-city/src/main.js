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
// 体积雾默认关闭：它单独吃 11 fps（89 → 100），而在这套已经发蓝的夜景配色里
// 几乎看不出差别。想要的话 ?fog=1 打开。
const fogEnabled = qs.get('fog') === '1';
// ?warm=0 直接撤遮罩（调试对照用）；?warmMs=15000 放宽首屏预热上限
const warmEnabled = qs.get('warm') !== '0';
const warmBudgetMs = Number(qs.get('warmMs')) || undefined;
// ?ready=N 首屏要等多少块瓦片（默认见 config.js 的 WARMUP.readyTiles）
const warmReady = Number(qs.get('ready')) || undefined;
let stats = { tiles: 0, meshes: 0, triangles: 0, loading: 0, failed: 0 };
let loadedCount = 0;
let warmSkipped = false;
let warmReport = null;

/** 推 n 帧渲染：MapLibre 是按需绘制的，光改状态不会立刻出图，得主动触发 */
const settleFrames = (n = 2) =>
  new Promise((resolve) => {
    let left = n;
    const step = () => {
      map?.triggerRepaint();
      if (--left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

/**
 * 撤遮罩前的「暖渲染」。
 *
 * 遮罩一消失，用户看到的第一帧其实就是这几百块瓦片的**首次绘制**：纹理要一次性
 * 传上 GPU、材质 program 首次编译、棱线要现生成。实测这一下会卡 300~700ms，
 * 而且每次都有 —— 因为遮罩挡住的时候这些工作还没发生。
 *
 * 这里关着遮罩强行多渲几帧，连续 3 帧耗时都正常（<45ms）才算「暖好了」，
 * 最多等 maxMs。把这段成本留在遮罩后面，入场就是平滑的。
 */
async function settleFirstPaint(maxMs = 2600) {
  const t0 = performance.now();
  let calm = 0;
  while (performance.now() - t0 < maxMs) {
    const f0 = performance.now();
    map.triggerRepaint();
    // 两帧：第一帧触发 layer.render、第二帧确保绘制真的提交了
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    calm = performance.now() - f0 < 45 ? calm + 1 : 0;
    if (calm >= 3) break;
  }
}

/**
 * 把「只在后面几幕才出现」的 program 提前编译掉。
 *
 * 棱线（GpuEdgePass）、飞线 / 光柱 / 光池（overlay）和辉光（post-presenter）的着色器
 * 都不在 prewarmShading 的覆盖范围里 —— 它们是在**第一次真正渲染**时才编译的。
 * 页面里手动执行的结果：辉光一次 +16 个 program，飞线+光柱+光池 +6，
 * 棱线 +5；对应演出版正是 30s / 40s 那两次跳变。
 *
 * 做法：全部挂上 → 渲染几帧 → 全部撤掉。每一步单独兜错（某一步先决条件不满足
 * 不该把后面的也跳过去），最后一定回到关闭状态，不会把特效残留到开场画面上。
 */
async function prewarmEffectPrograms() {
  const failed = [];
  const step = (label, fn) => { try { fn(); } catch (e) { failed.push(label + ': ' + (e?.message ?? e)); } };
  const programs = () => layer.viewer?.renderer?.info?.programs?.length ?? -1;
  const trace = { before: programs(), steps: [], after: -1, failed };
  try {
    step('edges', () => layer.setEdges('gpu', { duration: 0 }));
    step('edgeStyle', () => layer.setStyle({ edgeColor: THEME.cyanSoft, edgeWidth: 1.35, edgeOpacity: 0.42 }));
    // 第 4 幕才出现的四类覆盖物全部挂上：飞线 / 光柱 / 发光边界盒 / 辉光。
    // 实测（页面里手动执行）：辉光一次 +16 个 program，飞线+光柱+光池 +6。
    step('cube', () => { effects.addCube(); trace.steps.push(['cube', programs()]); });
    step('flows', () => { effects.addFlows(); trace.steps.push(['flows', programs()]); });
    step('beacons', () => { effects.addBeacons(); trace.steps.push(['beacons', programs()]); });
    step('bloom', () => { effects.enableBloom(); trace.steps.push(['bloom', programs()]); });
    // 第 2 幕的扫描波也是 overlay（自带一套 ShaderMaterial），一并编掉
    step('scanWave', () => { effects.addScanWave(); trace.steps.push(['scanWave', programs()]); });
    // 辉光的十几个 program 属于**后期通道**，不在场景材质里，compileAsync 编不到；
    // 必须真的让 presenter 跑几帧。用 sleep 而不是 rAF：加载期宿主可能不给帧。
    for (let i = 0; i < 5; i++) {
      map.triggerRepaint();
      await sleep(220);
    }
    trace.afterPaint = programs();
    try {
      const v = layer.viewer;
      if (v?.renderer?.compileAsync) {
        trace.compileRequested = true;
        await v.renderer.compileAsync(v.scene, v.camera);
      }
    } catch (e) {
      failed.push('compile: ' + (e?.message ?? e));
    }
    trace.after = programs();
  } finally {
    step('rmScanWave', () => effects.removeScanWave());
    step('rmBloom', () => effects.disableBloom());
    step('rmBeacons', () => effects.removeBeacons());
    step('rmFlows', () => effects.removeFlows());
    step('rmCube', () => effects.removeCube());
    step('rmEdges', () => layer.setEdges(false, { duration: 0 }));
    step('resetStyle', () => layer.setStyle({ edgeOpacity: 0 }));
    await settleFrames(2);
    trace.final = programs();
    if (window.__city) window.__city.prewarm = trace;
    if (failed.length) console.warn('[city] 特效预热部分失败（不影响演出）', failed);
  }
}

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
  maxTiles: 1024,
  // LOD 保守的兜底档（每数据集在 config.js 里各自覆盖）：数值越大越倾向保留粗模。
  // 这是加载期总工作量最有效的一根旋钮 —— 详见 config.js 里 DATASETS 的注释。
  lodRangeScale: 1.15,
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
  // 拖拽 / 缩放 / 旋转进行中时暂停新瓦片入队、跳过淡入、延后瓦片进场景。
  // 内核 0.4.x 起默认就是 true，这里显式写出来是为了让 demo 的意图可读。
  // 程序驱动的镜头巡游不算手势（movestart 不带 originalEvent），细化照常继续。
  calmWhileInteracting: true,
  // 镜头在动的时候只给加载 2ms/帧（静止时 8ms）。动画每帧预算只有 16ms，
  // 固定吃 8ms 就是稳定掉帧；压到 2ms 动画和拖拽都跟得上，停住后自动恢复。
  // 注意是「调小」不是「停」—— 停会在镜头停住那一刻把积压请求一次性放闸。
  movingSliceBudgetMs: 2,
  // 单帧最多新建 4 个瓦片请求：镜头停住的瞬间几十块瓦片同时达标，不封顶就是
  // 「一停就狂加载」—— 峰值被摊平后，补细节慢一两秒，但不会再出现整段卡死。
  maxEnqueuePerFrame: 4,
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
    // 瓦片淡入整个关掉。它不是「进场动画」，是每块瓦片自己一条 900ms 时间线：
    // 7 个数据集、几十块瓦片不是同时到的，各从 0 淡到 1，叠在深色底上就是持续闪烁。
    // 压短时长只是让闪烁更快，治不了根 —— 根在「不同步」，关掉最干净（0 = 直接显示）。
    fadeIn: 0,
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

// ?quality=lambert 切到纯漫反射材质：少一整套 PBR 着色（IBL / 粗糙度 / 镜面），
// 中低端 GPU 上逐像素成本明显更低；代价是玻璃幕墙和水面没有环境反射，观感更平。
// 默认 pbr —— 这套数据的主角就是幕墙和铺装贴图，环境反射是「有材质」的分界线。
if (qs.get('quality') === 'lambert') layer.setMaterialQuality('lambert');

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
        // 逐数据集的精度档：铺底类（地面 / 铺装 / 植被 / 水系）保持全画面覆盖，
        // 但只细化到够用为止 —— 镂空不会出现，省下的是后面几级子瓦片。
        lodRangeScale: d.lodRangeScale,
        maxTiles: d.tiles,
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

    // 演出要切四种着色模式（原色 / 按高度 / 动态扫描 / 顶侧分色），在着色器里是四个
    // 不同的 program。首次用到要现编，单个 100~300ms，正好卡在镜头推进的时候。
    // 趁遮罩还挂着先全部编译一遍 —— 结束后会自动切回原色。
    try {
      await layer.prewarmStyleVariants?.([STYLE.TEXTURE, STYLE.HEIGHT, STYLE.DYNAMIC, STYLE.CUSTOM]);
    } catch (e) {
      console.warn('[city] 着色变体预热失败（不影响渲染）', e);
    }

    // 棱线和辉光各有自己的 program，也是**首次渲染那一刻**才编译的：实测第 3 幕
    // 一开棱线就卡 600ms，第 4 幕开辉光再来一下，两次都正好压在镜头推进上。
    // 这里趁遮罩还在，把它们各自挂上渲染几帧再撤掉，编译成本就落在遮罩里。
    // （放在瓦片预热**之后**：特效依赖 overlay / 渲染目标，太早调用会静默失败。）

    // 只预热首屏：镜头短暂移到俯冲落点，让 LOD 把首屏要用的中等精度瓦片发出来，
    // 增长停滞就撤遮罩。精细层交给演出中 26 秒的渐进细化，不在这里阻塞等到底。
    if (warmEnabled) {
      warmReport = await warmupCity({
        map,
        layer,
        hud,
        isSkipped: () => warmSkipped,
        budgetMs: warmBudgetMs,
        readyTiles: warmReady,
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
    // 遮罩后面先把「首次绘制」跑完：纹理上传 / program 编译都留在这里，
    // 否则它们会正好砸在遮罩消失后的第一帧上（实测 300~700ms，每次都掉）。
    // 特效 program 也在这里编：瓦片已就绪，overlay / 渲染目标都建好了。
    try {
      await prewarmEffectPrograms();
    } catch (e) {
      console.warn('[city] 特效预热失败（不影响演出）', e);
    }
    await settleFirstPaint();
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
