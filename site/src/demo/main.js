import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { S3MLayer, STYLE, AttributeQuery } from 's3m-maplibre';
import pkg from 's3m-maplibre/package.json';



/** 迁移前的 main.js 逻辑原样收在一个初始化函数里。
 *  UI 结构此时已由 Solid 渲染完毕，这里只做「抓 DOM → 绑事件 → 驱动图层」，
 *  与迁移前的执行顺序一致，避免引入行为回归。
 *  @param {HTMLElement} host 地图容器
 *  @returns {() => void} 清理函数
 */
export function initDemo(host) {
/** 常用预设快捷方式 */
const PRESETS = [
  {
    id: 'cbd',
    name: '北京CBD (CCTV)',
    url: './data/CBD/cbd.scp',
    color: '#2563eb',
    tip: '北京 CBD 核心区 · CCTV总部大楼',
    align: 'origin',
    heightOffset: 0,
    underground: false,
  },
  {
    id: 'comModel',
    name: 'comModel (样例)',
    url: './data/comModel/comModel.scp',
    color: '#d97706',
    tip: '单体建筑样例模型',
    align: 'origin',
    heightOffset: 0,
    underground: false,
  },
  {
    id: 'subwayCrn',
    // 这份数据的纹理全走 CRN（v3.01，compressType=50000），用来肉眼验证 CRN 解码链路
    name: '地铁站 (CRN 纹理)',
    url:
      'https://www.supermapol.com/realspace/services/3D-local3DCache-SubwayStationCombined' +
      '/rest/realspace/datas/SubwayStationCombined/config',
    color: '#16a34a',
    tip: 'SuperMap Online 公有服务 · 智能顶面对齐地表并开启半透明地下透视',
    align: 'top', // 智能语义对齐：顶部对齐地表（下沉 28.5m）
    heightOffset: 3.5, // 微调：出入口站房露于地面约 3.5m（净下沉 25m）
    underground: true, // 默认开启半透明地下透视
    pitch: 68,
    bearing: -35,
  },
  {
    id: 'gs',
    // SuperMap 的 3DGaussianSplatting 服务：v3.01 + MeshOpt 多骨架，
    // 瓦片没有索引包（顶点即点），LOD 用的是规范枚举里没有的 rangeMode = 2
    name: '寿宁阁 (高斯泼溅)',
    url:
      'https://www.supermapol.com/realspace/services/3D-ShouNingGe' +
      '/rest/realspace/datas/寿宁阁/config',
    color: '#7c3aed',
    tip: 'SuperMap Online 公有服务 · 高斯泼溅按点渲染，靠近会自动细化',
    align: 'origin',
    heightOffset: 0,
    underground: false,
    pitch: 72,
    bearing: -20,
  },
  {
    id: 's3mv1',
    // S3M 1.x（SuperMapCache）容器：config 返回 XML，瓦片是 .s3m（魔数 s3m\0 + zlib）。
    // 成果高程从 119.84m 起，不对齐就会整片悬在空中，斜视下像散在别处的碎片。
    name: '索菲亚教堂 (S3M 1.x 倾斜摄影)',
    url:
      'https://www.supermapol.com/realspace/services/3D-suofeiya_church' +
      '/rest/realspace/datas/Config/config',
    color: '#0891b2',
    tip: 'SuperMap Online 公有服务 · .s3m 容器，底部贴地；粗模要靠近才逐层细化',
    align: 'bottom', // 按 heightRange.min（119.84m）落地
    heightOffset: 0,
    underground: false,
    pitch: 62,
    bearing: -20,
  },
];

const DEFAULT_URL = PRESETS[0].url; // 默认使用 CCTV CBD 模型

const MODES = [
  { key: 'top_side', value: STYLE.TOP_SIDE, label: '顶/侧分色' },
  { key: 'white', value: STYLE.WHITE, label: '白膜' },
  { key: 'texture', value: STYLE.TEXTURE, label: '原色' },
  { key: 'solid', value: STYLE.SOLID, label: '单色' },
  { key: 'height', value: STYLE.HEIGHT, label: '按高度' },
  { key: 'floors', value: STYLE.FLOORS, label: '按楼层' },
  { key: 'batch', value: STYLE.BATCH, label: '按单体' },
  { key: 'dynamic', value: STYLE.DYNAMIC, label: '动态扫描' },
  { key: 'custom', value: STYLE.CUSTOM, label: '自定义复合' },
];

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(Math.round(n ?? 0)));
const num = (n, d = 1) => (n == null ? '—' : Number(n).toFixed(d));

/* ------------------------------------------------------------------ 地形 (Terrain) */

/**
 * 真实地形数据源：AWS elevation-tiles-prod 是公开的 terrarium 编码 DEM，
 * MapLibre 原生支持 `encoding: 'terrarium'`，且响应带 CORS 头，浏览器可直接拉。
 *
 * 关于高程基准：MapLibre 的 _viewProjMatrix 里含 translate(0,0,-elevation)，
 * 地形网格与 3D custom layer 共用同一个矩阵 ⇒ 两边都是「海拔 0」基准，
 * 深度测试天然可比，地形可以直接遮挡 S3M 建筑。
 * 唯一需要处理的是 S3M 模型自身按海拔 0 建模，而地面在海拔 G ⇒ 建筑要抬 G。
 */
const DEM_SOURCE = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  minzoom: 0,
  maxzoom: 15,
};

const terrainState = {
  enabled: false,
  exaggeration: 1,
  shade: true,
  snap: true,
  /** 当前已生效的自动贴地量（米） */
  groundOffset: 0,
};

function setStatus(text, kind) {
  $('statusText').textContent = text;
  $('dot').className = kind ?? '';
}

// 版本号在构建期从包 package.json 打进来（产物里不再依赖仓库根文件）
{
  const el = $('versionTag');
  if (el && pkg?.version) el.textContent = `v${pkg.version}`;
}

function baseStyle() {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
      // 地形 DEM 源（AWS Terrarium，公开免 key）
      dem: {
        ...DEM_SOURCE,
        attribution: 'Elevation: AWS Terrain Tiles',
      },
      // 地形表面纹理源：地形网格的贴图来自 RTT 栈（raster/hillshade/background 等层
      // 渲染进 FBO 的结果），所以必须有一个 raster 层为它供图。
      // 独立于 osm 源 ⇒ 「隐藏地图底图」时地形仍能出图。
      terrainTex: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e9edf2' } },
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        paint: { 'raster-opacity': 0.82, 'raster-saturation': -0.55, 'raster-brightness-max': 0.94 },
      },
      {
        // 地形纹理层：只在地形开启时可见，视觉上盖在 osm 之上给地形面供图
        id: 'terrainTex',
        type: 'raster',
        source: 'terrainTex',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.82, 'raster-saturation': -0.55, 'raster-brightness-max': 0.94 },
      },
      {
        id: 'terrainShade',
        type: 'hillshade',
        source: 'dem',
        layout: { visibility: 'none' },
        paint: {
          'hillshade-shadow-color': '#0b1220',
          'hillshade-highlight-color': '#8fb6d8',
          'hillshade-accent-color': '#4a6fa5',
          'hillshade-exaggeration': 0.4,
          'hillshade-illumination-direction': 335,
        },
      },
    ],
  };
}

/* ---------------------------------------------------------------- 地图与图层初始化 */

const map = new maplibregl.Map({
  container: host,
  style: baseStyle(),
  center: [116.4581, 39.9123],
  zoom: 16.2,
  pitch: 60,
  bearing: -30,
  maxPitch: 85,
  antialias: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

/**
 * 用户是否手动动过镜头。
 *
 * 数据集是异步加载的，`loadSource` 里的 fitLayerBounds 要等所有数据集 await 完才执行；
 * 大服务（几十张瓦片）能拖到好几秒。没有这个标记的话，用户刚把镜头怼到某栋楼，
 * 加载队列一收尾就被 fitBounds 拽回全局视角——特写根本停不住。
 * 只有真实手势（拖拽 / 滚轮 / 双指 / 键盘）会置位，程序触发的 fitBounds 不带 originalEvent。
 */
let userMovedCamera = false;
map.on('movestart', (e) => {
  if (e.originalEvent) userMovedCamera = true;
});

const layer = new S3MLayer({
  id: 's3m',
  // 预算要能装下「近处所有可见瓦片」。这个数据集光是根瓦片就有 79 块，
  // 预算给 64 时每帧都在淘汰-重下-再淘汰，子瓦片永远挤不进显示，纹理就永远停在
  // 最粗一级的雪碧图（一栋楼只剩十几像素、再被 uv 平铺几十遍）。
  maxTiles: 4096,
  maxConcurrent: 4,
  style: {
    mode: STYLE.TEXTURE,
    colorA: '#ffffff', // 顶面高亮暖白
    colorB: '#1d4ed8', // 侧立面科技蓝
    colorC: '#fbbf24', // 扫描金黄
    selectColor: '#22d3ee',
    outline: true,
    outlineStyle: 'edges', // 'edges' 单体棱线 | 'hull' 外扩轮廓
    outlineColor: '#22d3ee',
    outlineWidthPx: 3, // 选中棱线粗细（像素）
    outlineWidth: 0.9, // 外扩轮廓粗细（米）
    dimOthers: true,
    edgeWidth: 1.2, // 全局棱线粗细（像素）
    edgeOpacity: 0.45,
  },
  onStats: (s) => {
    $('stTiles').textContent = s.tiles;
    $('stMeshes').textContent = s.meshes;
    $('stTris').textContent = fmt(s.triangles);
    if (s.loading > 0) setStatus(`加载中 · 队列 ${s.loading}`, 'busy');
    else if (s.failed > 0) setStatus(`就绪 · ${s.failed} 个瓦片失败`, 'err');
    else setStatus('就绪', 'ok');
  },
  onError: (e) => {
    console.warn('[s3m error]', e);
    setStatus('加载异常', 'err');
  },
});

/* ---------------------------------------------------------------- URL 与数据集解析 */

function getQueryUrl() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('url');
  return q ? decodeURIComponent(q.trim()) : null;
}

function updateBrowserUrl(url) {
  const u = new URL(window.location.href);
  if (!url || url === DEFAULT_URL) {
    u.searchParams.delete('url');
  } else {
    u.searchParams.set('url', url);
  }
  window.history.replaceState(null, '', u.toString());
}

/**
 * 解析用户输入的任意 URL，兼容：
 * 1. 预设快捷词（如 "cbd", "shenyin", "comModel"）
 * 2. 直接的 .scp 或 .s3mb 路径（相对路径 / 绝对路径）
 * 3. SuperMap iServer REST 服务根地址 /realspace 或 /datas
 * 4. 指向特定数据集的目录，如 .../datas/cheng
 *
 * 满足需求："如果只有没有指定数据集 就列出所有数据集默认勾选第一个"
 */
async function resolveUrlToDatasets(rawUrl) {
  let url = (rawUrl || '').trim();
  if (!url) url = DEFAULT_URL;

  // 1. 匹配预设 ID
  const matchedPreset = PRESETS.find((p) => p.id.toLowerCase() === url.toLowerCase());
  if (matchedPreset) url = matchedPreset.url;

  try {
    url = decodeURIComponent(url);
  } catch {}

  // 2. 指向具体的 .scp 或 .s3mb 文件
  if (/\.(scp|s3mb)(\?.*)?$/i.test(url)) {
    const filename = url.split('/').pop().split('?')[0].replace(/\.(scp|s3mb)$/i, '');
    const isCBD = /cbd/i.test(filename) || /cbd/i.test(url);
    return [
      {
        id: filename || 'default',
        name: isCBD ? '北京CBD (CCTV总部大楼)' : (filename || '三维模型'),
        configUrl: url,
        checked: true,
        color: '#2563eb',
      },
    ];
  }

  // 3. iServer REST realspace 服务的兼容探测
  const cleanUrl = url.replace(/\/+$/, '');

  // 若指向具体数据集，例如 .../datas/cheng
  const subDsMatch = /\/datas\/([^\/\?#]+)$/i.exec(cleanUrl);
  if (subDsMatch && subDsMatch[1] !== 'datas') {
    const dsName = subDsMatch[1];
    return [
      {
        id: dsName,
        name: dsName,
        configUrl: `${cleanUrl}/config`,
        checked: true,
        color: '#2563eb',
      },
    ];
  }

  // 探测数据集列表 JSON（realspace/datas.json 或 datas.json）
  let listUrl = cleanUrl;
  if (cleanUrl.endsWith('/realspace')) {
    listUrl = `${cleanUrl}/datas.json`;
  } else if (!cleanUrl.endsWith('.json')) {
    listUrl = `${cleanUrl}.json`;
  }

  try {
    setStatus('查询数据集列表中…', 'busy');
    const res = await fetch(listUrl);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0 && data[0].name) {
        // 这是 iServer datas 集合！
        // 关键："如果只有没有指定数据集 就列出所有数据集默认勾选第一个"
        const colors = ['#2563eb', '#8b95a3', '#059669', '#d97706', '#7c3aed', '#ec4899', '#06b6d4'];
        return data.map((item, index) => {
          const cfgUrl = item.path.startsWith('http')
            ? `${item.path}/config`
            : new URL(`${item.path}/config`, cleanUrl).href;
          return {
            id: item.name,
            name: item.name === 'zhoubian' ? '周边底模' : item.name,
            configUrl: cfgUrl,
            checked: index === 0, // 仅第 1 个默认勾选，其余展示在列表待勾选
            color: colors[index % colors.length],
          };
        });
      }
    }
  } catch (err) {
    console.warn('[s3m] 探测数据集列表未果，尝试作为直接配置文件读取:', err);
  }

  // 4. 退化作为单个配置
  return [
    {
      id: 'default',
      name: '三维图层',
      configUrl: cleanUrl.endsWith('/config') ? cleanUrl : cleanUrl,
      checked: true,
      color: '#2563eb',
    },
  ];
}

/* ---------------------------------------------------------------- 加载数据源 */

let currentDatasets = [];

async function loadSource(rawUrl) {
  const url = rawUrl || DEFAULT_URL;
  $('urlInput').value = url;
  updateBrowserUrl(url);

  // 预设高亮状态
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.url === url || (url === DEFAULT_URL && btn.dataset.id === 'cbd'));
  });

  const matchedPreset = PRESETS.find((p) => p.url === url || (url === DEFAULT_URL && p.id === 'cbd'));
  const presetAlign = matchedPreset?.align ?? 'origin';
  const presetHeightOffset = matchedPreset?.heightOffset ?? 0;
  const isUnderground = matchedPreset?.underground ?? false;

  if ($('optAlign')) $('optAlign').value = presetAlign;
  if ($('optUnderground')) $('optUnderground').checked = isUnderground;
  layer.setGroundMode(isUnderground ? 'translucent' : 'none');
  updateBasemapVisibility();

  setStatus('正在解析数据源…', 'busy');
  layer.clearDatasets();
  // 切换数据源是明确意图，允许重新取景（否则用户手动动过一次镜头后就再也不会自动对齐新数据）
  userMovedCamera = false;

  currentDatasets = await resolveUrlToDatasets(url);
  // ?all=1：把该服务下的所有数据集全部勾选（官方场景是 6 层：鸟巢/水/树/路/地面/建筑，
  // 只加载 Building 一层做出来的画面根本没法跟官方对照）
  if (new URLSearchParams(window.location.search).get('all') === '1') {
    for (const d of currentDatasets) d.checked = true;
  }
  renderDatasetUI();

  // 添加默认勾选的数据集
  const checkedList = currentDatasets.filter((d) => d.checked);
  for (const d of checkedList) {
    try {
      await layer.addDataset({
        id: d.id,
        name: d.name,
        configUrl: d.configUrl,
        align: presetAlign,
        heightOffset: presetHeightOffset,
      });
      updateDatasetTag(d.id);
    } catch (e) {
      console.warn(`[s3m] 加载数据集 ${d.name} 失败:`, e);
    }
  }

  // 同步实际生效的高程到 UI 控制器
  const effectiveHeight = layer.getDatasetHeight();
  $('optHeightOffset').value = effectiveHeight;
  $('heightOffsetVal').textContent = `${effectiveHeight > 0 ? '+' : ''}${effectiveHeight.toFixed(1)}m`;

  // 定位镜头到图层范围（如预设指定了推荐倾角/偏航则应用）
  fitLayerBounds(matchedPreset ? { pitch: matchedPreset.pitch ?? 58, bearing: matchedPreset.bearing ?? -25 } : undefined);
}

function updateDatasetTag(id) {
  const entry = layer.datasets.get(id);
  const b = entry?.tileset?.config?.geoBounds;
  const tagEl = $(`tag-${id}`);
  if (tagEl && b) {
    const w = ((b.right - b.left) * 111320 * Math.cos((b.top * Math.PI) / 180)) | 0;
    const h = ((b.top - b.bottom) * 110540) | 0;
    tagEl.textContent = `${w}×${h}m`;
  }
}

function fitLayerBounds(customOptions, force = false) {
  // 用户已经自己取景 ⇒ 不再抢镜头（force 用于「切换数据源」这类明确意图）
  if (userMovedCamera && !force) return;
  const bounds = layer.getBounds();
  if (bounds) {
    const opts = Object.assign(
      { padding: 80, pitch: 58, bearing: -25, maxZoom: 16.6, duration: 900 },
      customOptions
    );
    map.fitBounds(bounds, opts);
  }
}

function renderDatasetUI() {
  const host = $('datasets');
  host.innerHTML = '';

  for (const d of currentDatasets) {
    const label = document.createElement('label');
    label.className = 'ds';
    label.innerHTML = `
      <input type="checkbox" ${d.checked ? 'checked' : ''} data-ds="${d.id}" />
      <span class="sw" style="background:${d.color}"></span>
      <span class="nm" title="${d.name}">${d.name}</span>
      <span class="tag" id="tag-${d.id}">${d.checked ? '加载中' : '未加载'}</span>`;
    host.appendChild(label);
  }

  host.querySelectorAll('input[data-ds]').forEach((el) => {
    el.addEventListener('change', async () => {
      const id = el.dataset.ds;
      const d = currentDatasets.find((item) => item.id === id);
      if (!d) return;

      d.checked = el.checked;
      if (el.checked) {
        if (layer.datasets.has(id)) {
          layer.setDatasetVisible(id, true);
        } else {
          setStatus(`加载数据集 ${d.name}…`, 'busy');
          $(`tag-${id}`).textContent = '加载中';
          try {
            await layer.addDataset({
              id: d.id,
              name: d.name,
              configUrl: d.configUrl,
            });
            updateDatasetTag(id);
            fitLayerBounds();
          } catch (e) {
            $(`tag-${id}`).textContent = '失败';
            console.error(e);
          }
        }
      } else {
        layer.setDatasetVisible(id, false);
      }
    });
  });
}

/* ---------------------------------------------------------------- 预设与输入绑定 */

function initSourceControls() {
  const presetsHost = $('presets');
  presetsHost.innerHTML = '';
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.dataset.id = p.id;
    btn.dataset.url = p.url;
    btn.textContent = p.name;
    btn.title = p.tip;
    btn.addEventListener('click', () => loadSource(p.url));
    presetsHost.appendChild(btn);
  }

  $('btnLoad').addEventListener('click', () => {
    const val = $('urlInput').value.trim();
    if (val) loadSource(val);
  });

  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = $('urlInput').value.trim();
      if (val) loadSource(val);
    }
  });
}

/* ---------------------------------------------------------------- 地形 (Terrain) */

/**
 * 开关地形。
 * - dem 源在初始 style 里已建好，terrainShade(hillshade) 层引用它 ⇒ 不能 removeSource
 * - setTerrain 开关真正的高程网格（带 DEM 的地形面）
 */
function applyTerrain() {
  if (terrainState.enabled) {
    map.setTerrain({ source: 'dem', exaggeration: terrainState.exaggeration });
  } else {
    map.setTerrain(null);
  }

  // 地形网格的贴图来自 RTT 栈 ⇒ 必须有 raster 层供图，否则地形面空白
  if (map.getLayer('terrainTex')) {
    map.setLayoutProperty('terrainTex', 'visibility', terrainState.enabled ? 'visible' : 'none');
  }

  // hillshade 层跟着开关走
  if (map.getLayer('terrainShade')) {
    map.setLayoutProperty(
      'terrainShade',
      'visibility',
      terrainState.enabled && terrainState.shade ? 'visible' : 'none'
    );
  }

  map.triggerRepaint();
  updateTerrainInfo();
}

/**
 * 建筑贴地：S3M 模型的 z 基准是海拔 0，而真实 DEM 地面在海拔 G（北京 CBD 约 40m）。
 * MapLibre 的 _viewProjMatrix 含 translate(0,0,-elevation)，地形与 custom layer 共用
 * 同一个矩阵 ⇒ 两边同为海拔 0 基准，深度测试天然可比，地形能直接挡住建筑。
 * 这里只需把数据集整体抬到地面高程。
 *
 * setDatasetHeight 的语义是「在 align 基准之上再抬升」，
 * 所以 align='top'（顶部对齐地表并下沉）的数据集贴地后仍然是「顶部落在地面高度」。
 *
 * 注意：queryTerrainElevation 返回的是「含 exaggeration」的地面高程，
 * 所以夸张倍数变化后必须重新贴地。
 */
function snapDatasetsToTerrain() {
  if (!terrainState.enabled || !terrainState.snap) return;

  const b = layer.getBounds();
  if (!b) return;
  const center = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];

  let elev = null;
  try {
    elev = map.queryTerrainElevation(center);
  } catch (e) {
    console.warn('[terrain] queryTerrainElevation 失败', e);
  }

  if (typeof elev !== 'number' || !Number.isFinite(elev)) {
    updateTerrainInfo('贴地：高程未就绪（DEM 瓦片仍在加载）');
    return;
  }

  // S3M 原始基准是海拔 0 ⇒ 抬到地面高程（不覆盖 align 基准）
  for (const id of layer.datasets.keys()) {
    layer.setDatasetHeight(id, elev);
  }
  terrainState.groundOffset = elev;

  const el = $('optHeightOffset');
  if (el) {
    el.value = Math.max(Number(el.min), Math.min(Number(el.max), elev));
    $('heightOffsetVal').textContent = `${elev > 0 ? '+' : ''}${elev.toFixed(1)}m`;
  }
  updateTerrainInfo(`地面海拔 ${elev.toFixed(1)}m · 已贴地`);
}

/** 关闭贴地时把附加偏移还回 0（align 基准不受影响） */
function clearTerrainSnap() {
  terrainState.groundOffset = 0;
  for (const id of layer.datasets.keys()) layer.setDatasetHeight(id, 0);
  const el = $('optHeightOffset');
  if (el) {
    el.value = 0;
    $('heightOffsetVal').textContent = '0m';
  }
}

function updateTerrainInfo(note) {
  const el = $('terrainInfo');
  if (!el) return;
  if (!terrainState.enabled) {
    el.textContent = '未开启';
    return;
  }
  const base = `AWS Terrarium · 夸张 ${terrainState.exaggeration}×`;
  el.textContent = note ? `${base} · ${note}` : base;
}

$('optTerrain')?.addEventListener('change', (e) => {
  terrainState.enabled = e.target.checked;
  applyTerrain();
  if (terrainState.enabled) {
    setStatus('地形已开启', 'ok');
    // DEM 瓦片异步加载，分多次尝试贴地
    setTimeout(snapDatasetsToTerrain, 1000);
    setTimeout(snapDatasetsToTerrain, 2500);
    setTimeout(snapDatasetsToTerrain, 5000);
  } else {
    clearTerrainSnap();
    setStatus('地形已关闭');
  }
});

$('optExagg')?.addEventListener('input', (e) => {
  terrainState.exaggeration = Number(e.target.value);
  $('exaggVal').textContent = `${terrainState.exaggeration}×`;
  if (terrainState.enabled) {
    map.setTerrain({ source: 'dem', exaggeration: terrainState.exaggeration });
    map.triggerRepaint();
    // 高程含 exaggeration ⇒ 贴地量也要跟着变
    setTimeout(snapDatasetsToTerrain, 600);
  }
  updateTerrainInfo();
});

$('optTerrainShade')?.addEventListener('change', (e) => {
  terrainState.shade = e.target.checked;
  if (map.getLayer('terrainShade')) {
    map.setLayoutProperty(
      'terrainShade',
      'visibility',
      terrainState.enabled && terrainState.shade ? 'visible' : 'none'
    );
  }
});

$('optTerrainSnap')?.addEventListener('change', (e) => {
  terrainState.snap = e.target.checked;
  if (terrainState.snap) snapDatasetsToTerrain();
  else clearTerrainSnap();
});

/* ---------------------------------------------------------------- 底图与正交投影 */

function updateBasemapVisibility() {
  const hide = !!$('optHideBasemap')?.checked || !!$('optOrtho')?.checked;
  const isUnderground = !!$('optUnderground')?.checked;

  for (const id of ['bg', 'osm']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', hide ? 'none' : 'visible');
  }

  // 地形开启时，terrainTex 是地形的贴图来源：
  // 隐藏底图时它也得跟着隐藏（否则地形上会浮着第二层底图）；
  // 不隐藏时它与 osm 重叠，靠 terrainTex 在图层顺序上位于 osm 之后、覆盖其上。
  if (map.getLayer('terrainTex')) {
    map.setLayoutProperty(
      'terrainTex',
      'visibility',
      terrainState.enabled && !hide ? 'visible' : 'none'
    );
  }

  if (!hide) {
    const opacity = isUnderground ? 0.22 : 0.82;
    if (map.getLayer('osm')) {
      map.setPaintProperty('osm', 'raster-opacity', opacity);
    }
    if (map.getLayer('terrainTex')) {
      map.setPaintProperty('terrainTex', 'raster-opacity', opacity);
    }
    if (map.getLayer('bg')) {
      map.setPaintProperty('bg', 'background-color', isUnderground ? '#0f172a' : '#e9edf2');
    }
  }
}

$('optUnderground')?.addEventListener('change', (e) => {
  const on = e.target.checked;
  layer.setGroundMode(on ? 'translucent' : 'none');
  updateBasemapVisibility();
  setStatus(on ? '3D 物理地表与地下透视已开启' : '已恢复标准地表模式');
});

/* ---------------------------------------------------------------- 地表遮挡（独立开关）

   深度缓冲是共用的：谁写了更近的深度，谁就遮挡。MapLibre terrain 是一个来源（需要 DEM），
   物理地表那块平面是另一个来源 —— 开启后地面以下的几何被真正切掉，不需要任何 DEM。
   「切掉」由 s3m-three 里一块 colorWrite=false 的纯深度代理完成，半透明覆盖网格本身不参与。
   与「地下透视」互相独立：不开透视时它就是一块不显示的隐形地面，纯粹把地面以下切掉。 */

$('optGroundOcclude')?.addEventListener('change', (e) => {
  const on = e.target.checked;
  layer.setGroundOcclude(on);
  // 遮挡开启时把地表钉在 z=0：高程滑杆只动模型不动切割面，
  // 变成直观的「控制埋深 / 切掉多少」；关闭后恢复跟随（贴地工作流不受影响）
  const gm = layer.groundManager;
  gm.trackHeight = !on;
  gm.setGroundHeight(on ? 0 : layer.getDatasetHeight());
  setStatus(on ? '地表遮挡已开启：地面以下被切掉（地表钉在 z=0，高程滑杆控制埋深）' : '地表遮挡已关闭：地下几何恢复显示');
});

$('optHideBasemap').addEventListener('change', (e) => {
  updateBasemapVisibility();
  setStatus(e.target.checked ? '已隐藏地图底图' : '已恢复地图底图');
});

$('optOrtho').addEventListener('change', (e) => {
  const on = e.target.checked;
  layer.setProjection(on ? 'orthographic' : 'perspective');
  // 正交只覆盖 S3M 层：底图走 MapLibre 自己的透视投影，会与本层对不齐，整体退出。
  updateBasemapVisibility();
  setStatus(on ? '正交投影已开启：底图退出' : '已切回透视投影');
});

/* ---------------------------------------------------------------- 着色 UI */

let currentMode = 'texture';
const modeHost = $('modes');
for (const m of MODES) {
  const btn = document.createElement('button');
  btn.textContent = m.label;
  btn.dataset.mode = m.key;
  if (m.key === currentMode) btn.classList.add('on');
  btn.addEventListener('click', () => {
    currentMode = m.key;
    modeHost.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m.key));
    layer.setStyle({ mode: m.value });
    syncSwatches();
    updateLegend();
  });
  modeHost.appendChild(btn);
}

function syncSwatches() {
  const show = ['top_side', 'solid', 'height', 'floors', 'dynamic', 'custom'].includes(currentMode);
  $('swatches').classList.toggle('hide', !show);
  if (!show) return;

  const wrapCA = $('wrapCA');
  const wrapCB = $('wrapCB');
  const wrapCC = $('wrapCC');
  const lblCA = $('lblCA');
  const lblCB = $('lblCB');
  const lblCC = $('lblCC');

  wrapCA.style.display = '';
  wrapCB.style.display = '';
  wrapCC.style.display = 'none';

  if (currentMode === 'top_side') {
    lblCA.textContent = '顶面色';
    lblCB.textContent = '侧面色';
  } else if (currentMode === 'solid') {
    lblCA.textContent = '单色';
    wrapCB.style.display = 'none';
  } else if (currentMode === 'height' || currentMode === 'floors') {
    lblCA.textContent = '底高色';
    lblCB.textContent = '顶高色';
  } else if (currentMode === 'dynamic') {
    lblCA.textContent = '底高色';
    lblCB.textContent = '顶高色';
    lblCC.textContent = '扫描色';
    wrapCC.style.display = '';
  } else if (currentMode === 'custom') {
    lblCA.textContent = '顶面色';
    lblCB.textContent = '侧底色';
    lblCC.textContent = '侧顶色';
    wrapCC.style.display = '';
  }
}

function updateLegend() {
  const el = $('legend');
  const useRamp = ['height', 'floors'].includes(currentMode);
  el.classList.toggle('hide', !useRamp);
  if (!useRamp) return;
  const min = layer.uniforms.uHeightMin.value;
  const max = layer.uniforms.uHeightMax.value;
  const s = layer.getStyle();
  el.innerHTML = `
    <div class="bar" style="background:linear-gradient(90deg, ${s.colorA}, ${s.colorB})"></div>
    <div class="lab"><span>${num(min, 0)} m</span><span>${num(max, 0)} m</span></div>`;
}

for (const [id, key] of [['cA', 'colorA'], ['cB', 'colorB'], ['cC', 'colorC']]) {
  $(id).addEventListener('input', (e) => {
    layer.setStyle({ [key]: e.target.value });
    updateLegend();
  });
}

// 控件事件绑定
$('optAlign')?.addEventListener('change', (e) => {
  const align = e.target.value;
  layer.setDatasetAlign(align);
  // align 只换基准，手动偏移原样保留
  const currentTotal = layer.getDatasetHeight();
  $('optHeightOffset').value = currentTotal;
  $('heightOffsetVal').textContent = `${currentTotal > 0 ? '+' : ''}${currentTotal.toFixed(1)}m`;
  setStatus(`垂直对齐已设为：${align}`);
});

$('optHeightOffset').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('heightOffsetVal').textContent = `${v > 0 ? '+' : ''}${v}m`;
  layer.setDatasetHeight(v);
});

$('optSelMode').addEventListener('change', (e) => {
  const mode = e.target.value;
  layer.setStyle({ selectMode: mode });
  $('wrapSelOpacity').style.display = mode === 'glowOnly' ? 'none' : '';
});

$('optSelColor').addEventListener('input', (e) => {
  layer.setStyle({ selectColor: e.target.value });
});

$('optSelOpacity').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  $('selOpacityVal').textContent = `${val}%`;
  layer.setStyle({ selectOpacity: val / 100 });
});

$('optSelElevation').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  $('selElevationVal').textContent = `${val}m`;
  layer.setStyle({ selectElevation: val });
});

$('optOutline').addEventListener('change', (e) => {
  const on = e.target.checked;
  layer.setStyle({ outline: on });
  $('wrapOutlineOpts').style.display = on ? '' : 'none';
});

$('optOutlineStyle').addEventListener('change', (e) => {
  const style = e.target.value;
  layer.setStyle({ outlineStyle: style });
  // 棱线按像素算粗细，外扩轮廓按米算，两种画法各给一个滑块
  $('wrapOutlineWidthPx').style.display = style === 'edges' ? '' : 'none';
  $('wrapOutlineWidth').style.display = style === 'hull' ? '' : 'none';
});

$('optOutlineColor').addEventListener('input', (e) => {
  layer.setStyle({ outlineColor: e.target.value });
});

$('optOutlineWidthPx').addEventListener('input', (e) => {
  const v = Number(e.target.value) / 10;
  $('outlineWidthPxVal').textContent = `${v.toFixed(1)}px`;
  layer.setStyle({ outlineWidthPx: v });
});

$('optOutlineWidth').addEventListener('input', (e) => {
  const v = Number(e.target.value) / 10;
  $('outlineWidthVal').textContent = `${v.toFixed(1)}m`;
  layer.setStyle({ outlineWidth: v });
});
$('optDim').addEventListener('change', (e) => layer.setStyle({ dimOthers: e.target.checked }));
$('optEdges').addEventListener('change', (e) => {
  const on = e.target.checked;
  layer.setEdges(on);
  $('wrapEdgeOpacity').style.display = on ? '' : 'none';
  $('wrapEdgeWidth').style.display = on ? '' : 'none';
  $('wrapEdgeThreshold').style.display = on ? '' : 'none';
});

$('optEdgeThreshold').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('edgeThresholdVal').textContent = `${v}°`;
  // 会重建 CPU 棱线（EdgesGeometry 参数变了），分片建，拖快了也只是慢一点
  layer.setStyle({ edgeThreshold: v });
});

$('optEdgeWidth').addEventListener('input', (e) => {
  const v = Number(e.target.value) / 10;
  $('edgeWidthVal').textContent = `${v.toFixed(1)}px`;
  layer.setStyle({ edgeWidth: v });
});

$('optEdgeOpacity').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  $('edgeOpacityVal').textContent = `${val}%`;
  layer.setStyle({ edgeOpacity: val / 100 });
});

$('optOpacity').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('opacityVal').textContent = `${v}%`;
  layer.setStyle({ opacity: v / 100 });
});

$('optFadeIn').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('fadeInVal').textContent = v > 0 ? `${v}ms` : '关闭';
  // 只影响之后新加载的瓦片；想立刻看到效果可以转动视角触发 LOD 换瓦
  layer.setStyle({ fadeIn: v });
});
$('optFlat').addEventListener('change', (e) => layer.setStyle({ shading: e.target.checked ? 'flat' : 'smooth' }));

$('optBlendTex').addEventListener('change', (e) => {
  const on = e.target.checked;
  $('wrapTexMix').style.display = on ? '' : 'none';
  const val = on ? Number($('optTexMix').value) / 100 : 0;
  layer.setStyle({ texMix: val });
});

$('optTexMix').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  $('texMixVal').textContent = `${val}%`;
  layer.setStyle({ texMix: val / 100 });
});

$('optOccludeBack').addEventListener('change', (e) => {
  layer.setStyle({ depthWrite: e.target.checked });
});

/* ---------------------------------------------------------------- 光照调节 */

if ($('optLightMode')) {
  $('optLightMode').addEventListener('change', (e) => {
    layer.setLight({ mode: e.target.value });
  });
}
if ($('optLightMain')) {
  $('optLightMain').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    $('lightMainVal').textContent = v.toFixed(2);
    layer.setLight({ mainIntensity: v });
  });
}
if ($('optLightAmbient')) {
  $('optLightAmbient').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    $('lightAmbientVal').textContent = v.toFixed(2);
    layer.setLight({ ambientIntensity: v });
  });
}
if ($('optLightAltitude')) {
  $('optLightAltitude').addEventListener('input', (e) => {
    const deg = Number(e.target.value);
    $('lightAltitudeVal').textContent = `${deg}°`;
    layer.setLight({ altitude: deg });
  });
}
if ($('optLightAzimuth')) {
  $('optLightAzimuth').addEventListener('input', (e) => {
    const deg = Number(e.target.value);
    $('lightAzimuthVal').textContent = `${deg}°`;
    layer.setLight({ azimuth: deg });
  });
}
if ($('optLightMainColor')) {
  $('optLightMainColor').addEventListener('input', (e) => {
    layer.setLight({ mainColor: e.target.value });
  });
}
if ($('optLightAmbientColor')) {
  $('optLightAmbientColor').addEventListener('input', (e) => {
    layer.setLight({ ambientColor: e.target.value });
  });
}
/* ---------------------------------------------------------------- 过滤与单体定制 */

let hiddenSmids = new Set();
let isolateSmid = null;
let maxHeightFilter = null;
let currentFeature = null;

function applyFilters() {
  const filter = {};
  if (isolateSmid != null) {
    filter.include = [isolateSmid];
  } else if (hiddenSmids.size > 0) {
    filter.exclude = Array.from(hiddenSmids);
  }
  if (maxHeightFilter != null) {
    filter.maxHeight = maxHeightFilter;
  }
  layer.setFilter(Object.keys(filter).length > 0 ? filter : null);
  updateFilterStatus();
}

function updateFilterStatus() {
  const el = $('filterStatus');
  if (!el) return;
  const parts = [];
  const customCount = layer.getFeatureStyles().size;
  if (customCount > 0) parts.push(`已定制 <b>${customCount}</b> 栋单体`);
  if (isolateSmid != null) parts.push(`独显 SMID <b>${isolateSmid}</b>`);
  else if (hiddenSmids.size > 0) parts.push(`已隐藏 <b>${hiddenSmids.size}</b> 栋`);
  if (maxHeightFilter != null) parts.push(`限高 ≤ <b>${maxHeightFilter}m</b>`);
  el.innerHTML = parts.length > 0 ? parts.join(' · ') : '显示全量模型';
}

$('btnFilterIsolate').addEventListener('click', () => {
  if (currentFeature?.smid != null) {
    isolateSmid = currentFeature.smid;
    applyFilters();
  } else {
    alert('请先在地图上点击选中一栋建筑');
  }
});

$('btnFilterHide').addEventListener('click', () => {
  if (currentFeature?.smid != null) {
    hiddenSmids.add(currentFeature.smid);
    layer.select(null);
    applyFilters();
  } else {
    alert('请先在地图上点击选中一栋建筑');
  }
});

$('btnFilterReset').addEventListener('click', () => {
  isolateSmid = null;
  hiddenSmids.clear();
  maxHeightFilter = null;
  $('optFilterMaxH').value = 250;
  $('filterMaxHVal').textContent = '全部';
  layer.clearFilter();
  updateFilterStatus();
});

/* ---------------------------------------------------------------- 单体动画演示 */

const animStatus = (msg) => {
  const el = $('animStatus');
  if (el) el.textContent = msg;
};

$('btnOrbit').addEventListener('click', () => {
  const smid = currentFeature?.smid;
  if (smid == null) {
    alert('请先在地图上点击选中一栋建筑');
    return;
  }
  // 半径 40m 的圆：translation 是相对原位的偏移，所以看起来是绕自己转圈
  const points = [];
  const R = 40;
  const N = 48;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    points.push([Math.cos(a) * R, Math.sin(a) * R, 0]);
  }
  layer.followPath(smid, points, { duration: 8000, loop: true, closed: true });
  animStatus(`SMID ${smid} 绕圈中（弧长参数化，恒速）`);
});

$('btnOrbitStop').addEventListener('click', () => {
  const smid = currentFeature?.smid;
  if (smid == null) return;
  layer.stopPath(smid);
  animStatus('已停止（停在当前位置）');
});

$('btnRaise').addEventListener('click', () => {
  const smid = currentFeature?.smid;
  if (smid == null) {
    alert('请先在地图上点击选中一栋建筑');
    return;
  }
  const cur = layer.getFeatureStyle(smid)?.elevation ?? 0;
  const next = cur > 0 ? 0 : 100;
  layer.animateFeature(smid, { elevation: next }, { duration: 700, easing: 'easeOutCubic' });
  animStatus(`抬高 → ${next}m`);
});

$('btnFadeOut').addEventListener('click', () => {
  const smid = currentFeature?.smid;
  if (smid == null) {
    alert('请先在地图上点击选中一栋建筑');
    return;
  }
  const cur = layer.getFeatureStyle(smid)?.opacity ?? 1;
  const next = cur < 0.9 ? 1 : 0.15;
  layer.animateFeature(smid, { opacity: next }, { duration: 600 });
  animStatus(`透明度 → ${next}`);
});

$('optFilterMaxH').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  if (val >= 250) {
    maxHeightFilter = null;
    $('filterMaxHVal').textContent = '全部';
  } else {
    maxHeightFilter = val;
    $('filterMaxHVal').textContent = `≤${val}m`;
  }
  applyFilters();
});

syncSwatches();

/* ---------------------------------------------------------------- 按业务字段着色 */

/** 当前 AttributeQuery 对应的数据源，变了才重建（重建会丢整行缓存） */
let attrSourceKey = '';

/** 数据源没变就别重建 —— 否则换字段时整行缓存白丢，又得重新查一遍 */
function applyAttrSource(source) {
  const key = `${source.dataServiceUrl}|${source.datasetName}`;
  if (key === attrSourceKey) return layer.attributeQuery;
  layer.setAttributeSource(source);
  attrSourceKey = key;
  return layer.attributeQuery;
}

function setAttrStatus(text) {
  $('attrStatus').textContent = text;
}

/** 上一次填的数据源记在本地，刷新页面不用重填 */
function readAttrSource() {
  const dataServiceUrl = $('optAttrUrl').value.trim();
  const datasetName = $('optAttrDataset').value.trim();
  if (!dataServiceUrl || !datasetName) return null;
  localStorage.setItem('s3m.attr.url', dataServiceUrl);
  localStorage.setItem('s3m.attr.dataset', datasetName);
  return { dataServiceUrl, datasetName };
}

$('optAttrUrl').value = localStorage.getItem('s3m.attr.url') ?? '';
$('optAttrDataset').value = localStorage.getItem('s3m.attr.dataset') ?? '';

function renderAttrLegend(result) {
  const host = $('attrLegend');
  if (!result.legend.length) {
    host.innerHTML = '';
    return;
  }
  const rows = result.legend.slice(0, 12).map(
    (e) => `<div style="display:flex; align-items:center; gap:6px; margin-top:4px;">
        <span style="width:10px; height:10px; border-radius:2px; flex:none; background:${e.color};"></span>
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${e.label}">${e.label}</span>
        ${e.count ? `<span style="color:#9ca3af; flex:none;">${e.count}</span>` : ''}
      </div>`
  );
  if (result.legend.length > 12) {
    rows.push(`<div style="color:#9ca3af; margin-top:4px;">…共 ${result.legend.length} 类</div>`);
  }
  host.innerHTML = rows.join('');
}

$('btnAttrFields').addEventListener('click', async () => {
  const source = readAttrSource();
  if (!source) {
    setAttrStatus('先填数据服务地址和数据集');
    return;
  }
  setAttrStatus('读取字段表…');
  try {
    const query = applyAttrSource(source) ?? new AttributeQuery(source);
    const schema = await query.loadSchema();
    const select = $('optAttrField');
    select.innerHTML = '';
    for (const f of schema) {
      if (['SmGeometry', 'SmIndexKey', 'SmUserID'].includes(f.name)) continue;
      const opt = document.createElement('option');
      opt.value = f.name;
      opt.textContent = f.name;
      select.appendChild(opt);
    }
    // 优先选看起来像业务字段的
    const preferred = ['KEYID', 'ENTITYID', 'NOTE', 'SmMaxZ', 'SmMinZ'];
    const hit = preferred.find((name) => schema.some((f) => f.name === name));
    if (hit) select.value = hit;
    setAttrStatus(`共 ${schema.length} 个字段`);
  } catch (e) {
    setAttrStatus(String(e?.message ?? e));
    console.error(e);
  }
});

$('btnAttrApply').addEventListener('click', async () => {
  const source = readAttrSource();
  if (!source) {
    setAttrStatus('先填数据服务地址和数据集');
    return;
  }
  const field = $('optAttrField').value;
  if (!field) {
    setAttrStatus('先点「读字段」选择字段');
    return;
  }
  const type = $('optAttrType').value;
  applyAttrSource(source);
  setAttrStatus(`查询 ${field}…`);
  try {
    const query = layer.attributeQuery;
    const before = query ? { ...query.stats } : null;
    const t0 = performance.now();
    const result = await layer.colorByField({ field, type });
    renderAttrLegend(result);
    const cost = Math.round(performance.now() - t0);
    const after = query ? query.stats : null;
    const reqs = before && after ? after.requests - before.requests : 0;
    const kb = before && after ? Math.round((after.bytes - before.bytes) / 1024) : 0;
    const many = type === 'category' && result.legend.length > 20;
    setAttrStatus(
      `${result.field} · 上色 ${result.matched} 栋 · 缺属性 ${result.missing} · ${cost}ms · ` +
        (reqs ? `${reqs} 次请求 ${kb}KB` : '缓存命中，0 请求') +
        (many ? ` · 该字段有 ${result.legend.length} 个取值，建议改用「渐变 / 分级」` : '')
    );
  } catch (e) {
    setAttrStatus(String(e?.message ?? e));
    console.error(e);
  }
});

$('btnAttrClear').addEventListener('click', () => {
  layer.clearThematic();
  $('attrLegend').innerHTML = '';
  setAttrStatus('已清除专题色');
});

/** 过滤 / 抬高共用：取当前字段，没有就提示 */
function currentAttrField() {
  const field = $('optAttrField').value;
  if (!field) setAttrStatus('先点「读字段」选择字段');
  return field;
}

$('btnAttrFilter').addEventListener('click', async () => {
  const source = readAttrSource();
  if (!source) return setAttrStatus('先填数据服务地址和数据集');
  const field = currentAttrField();
  if (!field) return;
  applyAttrSource(source);

  const minText = $('optAttrMin').value.trim();
  const maxText = $('optAttrMax').value.trim();
  setAttrStatus(`按 ${field} 过滤…`);
  try {
    const t0 = performance.now();
    const result = await layer.filterByField({
      field,
      mode: $('optAttrFilterMode').value,
      min: minText === '' ? undefined : Number(minText),
      max: maxText === '' ? undefined : Number(maxText),
    });
    const cost = Math.round(performance.now() - t0);
    if (result.matched === 0) {
      // 分类字段没有区间可言，命中 0 栋时不要把所有楼都藏掉
      layer.clearFieldFilter();
      setAttrStatus(`${field} 没有单体命中（区间过滤只对数值字段有效），已保持原样`);
      return;
    }
    setAttrStatus(
      `过滤 ${result.field} · 命中 ${result.matched}/${result.total} · 隐藏 ${result.hidden.length} 栋` +
        (result.missing ? ` · 缺属性 ${result.missing}` : '') +
        ` · ${cost}ms`
    );
  } catch (e) {
    setAttrStatus(String(e?.message ?? e));
    console.error(e);
  }
});

$('btnAttrFilterClear').addEventListener('click', () => {
  layer.clearFieldFilter();
  setAttrStatus('已清除字段过滤');
});

$('btnAttrElevate').addEventListener('click', async () => {
  const source = readAttrSource();
  if (!source) return setAttrStatus('先填数据服务地址和数据集');
  const field = currentAttrField();
  if (!field) return;
  applyAttrSource(source);

  const scale = Number($('optAttrElev').value);
  if (!Number.isFinite(scale) || scale === 0) return setAttrStatus('抬高倍率填个非 0 数字');
  setAttrStatus(`按 ${field} 抬高…`);
  try {
    const t0 = performance.now();
    const result = await layer.elevateByField({ field, scale });
    const cost = Math.round(performance.now() - t0);
    if (result.matched === 0) {
      setAttrStatus(`${field} 不是数值字段或全为 0，没有单体被抬高`);
      return;
    }
    setAttrStatus(
      `抬高 ${result.field} ×${scale} · ${result.matched} 栋 · 最大 ${result.appliedMax.toFixed(1)}m` +
        ` · 字段范围 ${result.min.toFixed(1)}~${result.max.toFixed(1)} · ${cost}ms`
    );
  } catch (e) {
    setAttrStatus(String(e?.message ?? e));
    console.error(e);
  }
});

$('btnAttrElevReset').addEventListener('click', () => {
  layer.clearThematicElevation();
  setAttrStatus('已复位抬高');
});

/* ---------------------------------------------------------------- 属性卡展示 */

function renderFeature(f) {
  currentFeature = f;
  const el = $('feature');
  if (!f) {
    el.classList.remove('on');
    return;
  }
  const coord = f.centerLngLat ? `${f.centerLngLat[0].toFixed(6)}, ${f.centerLngLat[1].toFixed(6)}` : '—';
  const size = f.size ? `${num(f.size[0])} × ${num(f.size[1])} m` : '—';
  const custom = f.smid != null ? layer.getFeatureStyle(f.smid) : null;

  let customHtml = '';
  if (f.smid != null) {
    const isPinned = !!custom;
    customHtml = `
      <div class="feat-custom">
        <div class="feat-custom-hd">
          <span>单体独立定制</span>
          <span style="font-size: 10.5px; color: ${isPinned ? '#34d399' : '#64748b'};">${isPinned ? '● 已固定' : '默认样式'}</span>
        </div>
        <div class="feat-row">
          <span style="font-size: 11px; color: #94a3b8;">颜色</span>
          <input type="color" id="featColor" value="${custom?.color ?? '#ef4444'}" style="width: 26px; height: 22px; border: 1px solid rgba(255,255,255,0.14); border-radius: 4px; padding: 0; cursor: pointer; background: transparent;" />
          <label class="rng" style="margin: 0; flex: 1;">
            <span style="color: #94a3b8;">拔高</span>
            <input type="range" id="featElevation" min="0" max="40" step="1" value="${custom?.elevation ?? 0}" style="flex: 1;" />
            <b id="featElevationVal" style="width: 26px; text-align: right; color: #f8fafc; font-family: ui-monospace, monospace;">${custom?.elevation ?? 0}m</b>
          </label>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; margin-top: 4px;">
          <button id="btnPinFeature" class="btn btn-primary" style="padding: 4px 6px; font-size: 11px;">固定样式</button>
          <button id="btnResetFeature" class="btn" style="padding: 4px 6px; font-size: 11px;">重置</button>
          <button id="btnHideFeature" class="btn btn-danger" style="padding: 4px 6px; font-size: 11px;">隐藏</button>
        </div>
      </div>
    `;
  }

  el.innerHTML = `
    <div class="hd">
      <b>SMID ${f.smid ?? '—'}</b>
      <span class="close" id="closeFeature">×</span>
    </div>
    <div class="kv"><span>数据集</span><span>${f.datasetName}</span></div>
    <div class="kv"><span>高度</span><span>${num(f.height)} m</span></div>
    <div class="kv"><span>楼层（估算）</span><span>${f.floors ?? '—'} 层</span></div>
    <div class="kv"><span>基底高程</span><span>${num(f.baseElevation)} m</span></div>
    <div class="kv"><span>外接盒</span><span>${size}</span></div>
    <div class="kv"><span>底面积（外接盒）</span><span>${fmt(f.bboxArea ?? 0)} ㎡</span></div>
    <div class="kv"><span>三角面 / 顶点</span><span>${fmt(f.triangles ?? 0)} / ${fmt(f.vertices ?? 0)}</span></div>
    <div class="kv"><span>中心坐标</span><span>${coord}</span></div>
    ${customHtml}
    <div id="featAttrs"></div>
    <div class="note">SMID 取自 S3M 单体化信息；独立定制后点击其他建筑仍持久保留。</div>`;

  el.classList.add('on');

  // 配了业务数据服务才有：按 SmID 把业务字段补进属性卡
  if (f.smid != null && layer.attributeQuery) {
    const attrsHost = $('featAttrs');
    attrsHost.innerHTML = '<div class="kv"><span>业务属性</span><span>查询中…</span></div>';
    layer.attributeQuery
      .queryBySmids([f.smid])
      .then((rows) => {
        if (currentFeature?.smid !== f.smid) return;
        const row = rows.get(f.smid);
        if (!row) {
          attrsHost.innerHTML = '<div class="note">数据服务里查不到这个 SmID</div>';
          return;
        }
        attrsHost.innerHTML = Object.entries(row)
          .filter(([key]) => !key.startsWith('SmGeo') && key !== 'SmIndexKey' && key !== 'SmUserID')
          .map(([key, value]) => {
            const text = String(value ?? '');
            const shown = text.length > 34 ? `${text.slice(0, 34)}…` : text || '—';
            return `<div class="kv"><span>${key}</span><span title="${text}">${shown}</span></div>`;
          })
          .join('');
      })
      .catch((e) => {
        if (currentFeature?.smid !== f.smid) return;
        attrsHost.innerHTML = `<div class="note">业务属性查询失败：${String(e?.message ?? e)}</div>`;
      });
  }
  $('closeFeature').addEventListener('click', () => {
    layer.select(null);
    el.classList.remove('on');
  });

  if (f.smid != null) {
    $('featElevation').addEventListener('input', (e) => {
      const val = Number(e.target.value);
      $('featElevationVal').textContent = `${val}m`;
      if (layer.getFeatureStyle(f.smid)) {
        layer.setFeatureStyle(f.smid, {
          color: $('featColor').value,
          elevation: val,
        });
      }
    });
    $('featColor').addEventListener('input', (e) => {
      if (layer.getFeatureStyle(f.smid)) {
        layer.setFeatureStyle(f.smid, {
          color: e.target.value,
          elevation: Number($('featElevation').value),
        });
      }
    });
    $('btnPinFeature').addEventListener('click', () => {
      layer.setFeatureStyle(f.smid, {
        color: $('featColor').value,
        elevation: Number($('featElevation').value),
      });
      updateFilterStatus();
      renderFeature(f);
    });
    $('btnResetFeature').addEventListener('click', () => {
      layer.removeFeatureStyle(f.smid);
      updateFilterStatus();
      renderFeature(f);
    });
    $('btnHideFeature').addEventListener('click', () => {
      hiddenSmids.add(f.smid);
      layer.select(null);
      applyFilters();
    });
  }
}

layer.onPick = (f) => renderFeature(f);

/* ---------------------------------------------------------------- 地图加载入口 */

map.on('load', async () => {
  map.addLayer(layer);
  initSourceControls();

  // ?ortho=1 直接以正交模式打开（勾选框同步，底图自动退出）
  if (new URLSearchParams(window.location.search).get('ortho') === '1') {
    $('optOrtho').checked = true;
    $('optOrtho').dispatchEvent(new Event('change'));
  }

  // 从 URL query ?url= 获取，若无则使用默认的 CCTV CBD 模型
  const initialUrl = getQueryUrl() || DEFAULT_URL;
  await loadSource(initialUrl);
});

/* ---------------------------------------------------------------- 状态轮询 */

const statsTimer = setInterval(() => {
  $('stFps').textContent = layer.fps || '—';
  if (currentDatasets.length > 0) updateLegend();
}, 600);

window.__s3m = { map, layer, renderFeature, loadSource };

return () => {
  clearInterval(statsTimer);
  try {
    map.remove();
  } catch {
    /* 已经移除过 */
  }
};

}
