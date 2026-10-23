import { S3MLayer, STYLE } from '../dist/index.js';

/** 常用预设快捷方式 */
const PRESETS = [
  {
    id: 'cbd',
    name: '北京CBD (CCTV)',
    url: './data/CBD/cbd.scp',
    color: '#2563eb',
    tip: '北京 CBD 核心区 · CCTV总部大楼',
  },
  {
    id: 'comModel',
    name: 'comModel (样例)',
    url: './data/comModel/comModel.scp',
    color: '#d97706',
    tip: '单体建筑样例模型',
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

function setStatus(text, kind) {
  $('statusText').textContent = text;
  $('dot').className = kind ?? '';
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
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e9edf2' } },
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        paint: { 'raster-opacity': 0.82, 'raster-saturation': -0.55, 'raster-brightness-max': 0.94 },
      },
    ],
  };
}

/* ---------------------------------------------------------------- 地图与图层初始化 */

const map = new maplibregl.Map({
  container: 'map',
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

const layer = new S3MLayer({
  id: 's3m',
  maxTiles: 64,
  maxConcurrent: 4,
  style: {
    mode: STYLE.TEXTURE,
    colorA: '#ffffff', // 顶面高亮暖白
    colorB: '#1d4ed8', // 侧立面科技蓝
    colorC: '#fbbf24', // 扫描金黄
    selectColor: '#22d3ee',
    outline: true,
    outlineColor: '#22d3ee',
    outlineWidth: 0.9,
    dimOthers: true,
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

  setStatus('正在解析数据源…', 'busy');
  layer.clearDatasets();
  $('optHeightOffset').value = 0;
  $('heightOffsetVal').textContent = '0m';

  currentDatasets = await resolveUrlToDatasets(url);
  renderDatasetUI();

  // 添加默认勾选的数据集
  const checkedList = currentDatasets.filter((d) => d.checked);
  for (const d of checkedList) {
    try {
      await layer.addDataset({
        id: d.id,
        name: d.name,
        configUrl: d.configUrl,
      });
      updateDatasetTag(d.id);
    } catch (e) {
      console.warn(`[s3m] 加载数据集 ${d.name} 失败:`, e);
    }
  }

  // 定位镜头到图层范围
  fitLayerBounds();
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

function fitLayerBounds() {
  const bounds = layer.getBounds();
  if (bounds) {
    map.fitBounds(bounds, { padding: 80, pitch: 58, bearing: -25, maxZoom: 16.6, duration: 900 });
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

$('optOutlineColor').addEventListener('input', (e) => {
  layer.setStyle({ outlineColor: e.target.value });
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

syncSwatches();

/* ---------------------------------------------------------------- 属性卡展示 */

function renderFeature(f) {
  const el = $('feature');
  if (!f) {
    el.classList.remove('on');
    return;
  }
  const coord = f.centerLngLat ? `${f.centerLngLat[0].toFixed(6)}, ${f.centerLngLat[1].toFixed(6)}` : '—';
  const size = f.size ? `${num(f.size[0])} × ${num(f.size[1])} m` : '—';

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
    <div class="note">SMID 取自 S3M 单体化信息（pickInfo）；高度 / 楼层 / 占地由几何实时计算，不是业务属性表。</div>`;

  el.classList.add('on');
  $('closeFeature').addEventListener('click', () => {
    layer.select(null);
    el.classList.remove('on');
  });
}

layer.onPick = (f) => renderFeature(f);

/* ---------------------------------------------------------------- 地图加载入口 */

map.on('load', async () => {
  map.addLayer(layer);
  initSourceControls();

  // 从 URL query ?url= 获取，若无则使用默认的 CCTV CBD 模型
  const initialUrl = getQueryUrl() || DEFAULT_URL;
  await loadSource(initialUrl);
});

/* ---------------------------------------------------------------- 状态轮询 */

setInterval(() => {
  $('stFps').textContent = layer.fps || '—';
  if (currentDatasets.length > 0) updateLegend();
}, 600);

window.__s3m = { map, layer, renderFeature, loadSource };
