import { S3MLayer, STYLE } from '../dist/index.js';

const BASE = 'https://yyxk-cs.sggs.sh.cn/iserver/services/shenyinzhilian/rest/realspace/datas';

/**
 * 同一服务下的 5 个数据集。zhoubian 是 3.7km 的周边底模（12 棵根树），
 * 其余 4 个是局部精模，锚点略有差异 —— 正好用来验证多数据集叠加。
 */
const DATASETS = [
  { id: 'zhoubian', name: '周边底模', configUrl: `${BASE}/zhoubian/data/path/zhoubian.scp`, color: '#8b95a3' },
  { id: 'jingmo', name: '精模', configUrl: `${BASE}/jingmo/data/path/jingmo.scp`, color: '#2563eb' },
  { id: 'cheng', name: 'cheng', configUrl: `${BASE}/cheng/data/path/cheng.scp`, color: '#059669' },
  { id: 'fang', name: 'fang', configUrl: `${BASE}/fang/data/path/fang.scp`, color: '#d97706' },
  { id: 'tiao', name: 'tiao', configUrl: `${BASE}/tiao/data/path/tiao.scp`, color: '#7c3aed' },
];

const MODES = [
  { key: 'white', value: STYLE.WHITE, label: '白膜' },
  { key: 'texture', value: STYLE.TEXTURE, label: '原色' },
  { key: 'solid', value: STYLE.SOLID, label: '单色' },
  { key: 'height', value: STYLE.HEIGHT, label: '按高度' },
  { key: 'floors', value: STYLE.FLOORS, label: '按楼层' },
  { key: 'batch', value: STYLE.BATCH, label: '按单体' },
  { key: 'dynamic', value: STYLE.DYNAMIC, label: '动态扫描' },
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

/* ---------------------------------------------------------------- 地图 */

const map = new maplibregl.Map({
  container: 'map',
  style: baseStyle(),
  center: [121.4738, 31.244],
  zoom: 16.2,
  pitch: 60,
  bearing: -25,
  maxPitch: 85,
  antialias: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

const layer = new S3MLayer({
  id: 's3m',
  datasets: DATASETS.map((d) => ({ id: d.id, name: d.name, configUrl: d.configUrl })),
  maxTiles: 48,
  maxConcurrent: 3,
  style: {
    mode: STYLE.WHITE,
    colorA: '#dfe6ee',
    colorB: '#1d4ed8',
    colorC: '#fbbf24',
    selectColor: '#22d3ee',
    outline: true,
    dimOthers: true,
  },
  onStats: (s) => {
    $('stTiles').textContent = s.tiles;
    $('stMeshes').textContent = s.meshes;
    $('stTris').textContent = fmt(s.triangles);
    if (s.loading > 0) setStatus(`加载中 · 队列 ${s.loading}`, 'busy');
    else if (s.failed > 0) setStatus(`就绪 · ${s.failed} 个瓦片失败`, 'err');
    else setStatus('就绪', 'ok');
  },
  onError: (e) => console.warn('[s3m]', e),
});

map.on('load', async () => {
  map.addLayer(layer);

  // 等所有数据集把首棵根树加载完，再框到总范围
  await Promise.all(
    DATASETS.map((d) =>
      new Promise((resolve) => {
        // 等 config 解析完成（getBounds 依赖 geoBounds），而不是等全部瓦片
        const tick = () => (layer.datasets.get(d.id)?.tileset?.config ? resolve() : setTimeout(tick, 120));
        tick();
      })
    )
  );
  const bounds = layer.getBounds();
  if (bounds) {
    map.fitBounds(bounds, { padding: 80, pitch: 58, bearing: -25, maxZoom: 16.6, duration: 900 });
  }
  buildDatasetUI();
});

/* ---------------------------------------------------------------- 数据集 UI */

let boundsReady = false;
function buildDatasetUI() {
  const host = $('datasets');
  host.innerHTML = '';
  for (const d of DATASETS) {
    const entry = layer.datasets.get(d.id);
    const b = entry?.tileset?.config?.geoBounds;
    let tag = '未加载';
    if (b) {
      const w = ((b.right - b.left) * 111320 * Math.cos((b.top * Math.PI) / 180)) | 0;
      const h = ((b.top - b.bottom) * 110540) | 0;
      tag = `${w}×${h}m`;
    }
    const label = document.createElement('label');
    label.className = 'ds';
    label.innerHTML = `
      <input type="checkbox" ${entry?.visible !== false ? 'checked' : ''} data-ds="${d.id}" />
      <span class="sw" style="background:${d.color}"></span>
      <span class="nm">${d.name}</span>
      <span class="tag">${tag}</span>`;
    host.appendChild(label);
  }
  host.querySelectorAll('input[data-ds]').forEach((el) => {
    el.addEventListener('change', () => {
      layer.setDatasetVisible(el.dataset.ds, el.checked);
    });
  });
  boundsReady = true;
}

/* ---------------------------------------------------------------- 着色 UI */

let currentMode = 'white';
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
  const show = ['solid', 'height', 'floors', 'dynamic'].includes(currentMode);
  $('swatches').classList.toggle('hide', !show);
  // 「按单体」用色相自动分配，颜色选择器对它无效
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

$('optOutline').addEventListener('change', (e) => layer.setStyle({ outline: e.target.checked }));
$('optDim').addEventListener('change', (e) => layer.setStyle({ dimOthers: e.target.checked }));
$('optEdges').addEventListener('change', (e) => layer.setEdges(e.target.checked));

$('optOpacity').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('opacityVal').textContent = `${v}%`;
  layer.setStyle({ opacity: v / 100 });
});
$('optFlat').addEventListener('change', (e) => layer.setStyle({ shading: e.target.checked ? 'flat' : 'smooth' }));

syncSwatches();

/* ---------------------------------------------------------------- 属性卡 */

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

// 图层内部已经处理了 click，这里只负责把结果画出来
layer.onPick = (f) => renderFeature(f);

/* ---------------------------------------------------------------- 状态轮询 */

setInterval(() => {
  $('stFps').textContent = layer.fps || '—';
  if (boundsReady) updateLegend();
}, 600);

window.__s3m = { map, layer, renderFeature };
