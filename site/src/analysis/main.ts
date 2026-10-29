/**
 * 三维空间分析 demo —— 只演示**库内提供的能力**，交互与绘制都在这一层。
 *
 * 这个文件本身就是「哪些该进库、哪些该在外围」的示范：
 * - 取点、拖拽、标签、颜色、工具栏 → 全在这里（应用层）
 * - 距离 / 面积 / 通视 / 裁剪 / 天际线 / 可视域 → 全部来自 `s3m-maplibre`
 *
 * 数据用仓库里自带的 `demo/data/CBD/cbd.scp`，不依赖外网瓦片服务
 * （底图走 OSM，离线时只是背景色，不影响分析）。
 */
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as THREE from 'three';
import { S3MLayer, STYLE } from 's3m-maplibre';
import type { LngLatAlt } from 's3m-maplibre';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/* ---------------------------------------------------------------- 地图 */

const map = new maplibregl.Map({
  container: 'map',
  style: {
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
      { id: 'bg', type: 'background', paint: { 'background-color': '#0b101b' } },
      { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-opacity': 0.55 } },
    ],
  },
  center: [116.4581, 39.9123],
  zoom: 16.4,
  pitch: 60,
  bearing: -30,
  maxPitch: 85,
  antialias: true,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

const layer = new S3MLayer({
  id: 's3m',
  maxTiles: 4096,
  maxConcurrent: 4,
  style: {
    mode: STYLE.TEXTURE,
    colorA: '#ffffff',
    colorB: '#1d4ed8',
    colorC: '#fbbf24',
    selectColor: '#22d3ee',
    // 分析场景不开装饰性描边：它和天际线同色系，画在图上分不清哪条是分析结果，
    // 而且每条棱线都是一次 drawcall，跟分析本身没关系。
    outline: false,
  },
});
map.on('error', (e) => console.warn('[demo]', e?.error?.message ?? e));

/**
 * 图层必须在 `load` 之后才能 addLayer —— 样式没加载完时 MapLibre 会直接抛
 * `Style is not done loading`，而且 `S3MLayer.addDataset` 也要求宿主已经挂上。
 */
async function boot(): Promise<void> {
  map.addLayer(layer);
  // 相对路径：构建产物是 demo/analysis.html，数据在同级的 demo/data/
  // （dev 下页面挂在站点根 /analysis.html，`./data` 同样命中 dev 中间件的 /data 映射）
  await layer.addDataset({ id: 'cbd', name: 'CBD', configUrl: './data/CBD/cbd.scp' });
  const b = layer.getBounds();
  if (b) map.fitBounds(b as [[number, number], [number, number]], { padding: 80, duration: 0 });
  hud('数据集就绪。选一个工具，然后在地图上点击。');
}

/* ---------------------------------------------------------------- 绘制层 */

const overlay = $('overlay') as HTMLCanvasElement;
const ctx2d = overlay.getContext('2d')!;

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  overlay.width = Math.round(map.getCanvas().clientWidth * dpr);
  overlay.height = Math.round(map.getCanvas().clientHeight * dpr);
  overlay.style.width = `${map.getCanvas().clientWidth}px`;
  overlay.style.height = `${map.getCanvas().clientHeight}px`;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
window.addEventListener('resize', resize);

/** 屏幕坐标（CSS 像素）→ 画布坐标（已按 dpr 缩放，这里用 CSS 像素画） */
function toScreen(p: LngLatAlt): [number, number] {
  const s = map.project([p.lng, p.lat]);
  return [s.x, s.y];
}

function draw(): void {
  const w = overlay.width;
  const h = overlay.height;
  ctx2d.clearRect(0, 0, w, h);

  // 可视域：把栅格逐格投到屏幕上（只是演示画法，生产环境应该用贴图）
  if (viewshed) {
    const { raster, grid, minX, minY, cellSize } = viewshed;
    // 场景 ENU → 经纬度走库里的换算，不要自己拿「每度多少米」近似：
    // 那在纬度高/半径大时会偏，而且和量算用的口径不一致
    const px = Math.max(2, Math.min(6, (cellSize / 10) * 2));
    for (let iy = 0; iy < grid; iy++) {
      for (let ix = 0; ix < grid; ix++) {
        const v = raster[iy * grid + ix]!;
        if (v < 0) continue;
        const ex = minX + (ix + 0.5) * cellSize;
        const ey = minY + (iy + 0.5) * cellSize;
        const ll = layer.pointToLngLat([ex, ey, 0]);
        const s = map.project([ll.lng, ll.lat]);
        ctx2d.fillStyle = v > 0 ? 'rgba(34, 211, 238, 0.42)' : 'rgba(248, 113, 113, 0.30)';
        ctx2d.fillRect(s.x - px / 2, s.y - px / 2, px, px);
      }
    }
  }

  // 天际线：直接按深度图给出的归一化屏幕坐标描线。
  // 深度图本来就是屏幕空间的产物，换算成角度只是为了读数，画线不需要再投影一次。
  // 纯天空的列要断开，否则线会横穿天空掉到画面底部。
  if (skyline) {
    const w = overlay.clientWidth;
    const h = overlay.clientHeight;
    ctx2d.save();
    // 先用深色描一遍底，再叠琥珀色 —— 底图是浅色影像时纯亮色线会糊掉
    ctx2d.lineWidth = 4;
    ctx2d.lineJoin = 'round';
    ctx2d.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    ctx2d.beginPath();
    let started = false;
    for (let c = 0; c < skyline.hasGeometry.length; c++) {
      if (!skyline.hasGeometry[c]) {
        started = false;
        continue;
      }
      const x = skyline.screen[c * 2]! * w;
      const y = skyline.screen[c * 2 + 1]! * h;
      if (started) ctx2d.lineTo(x, y);
      else {
        ctx2d.moveTo(x, y);
        started = true;
      }
    }
    ctx2d.stroke();

    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = '#fbbf24';
    ctx2d.shadowColor = 'rgba(251, 191, 36, 0.9)';
    ctx2d.shadowBlur = 10;
    ctx2d.stroke();
    ctx2d.restore();
  }

  // 量算：折线 + 顶点 + 每段长度
  if (points.length > 0) {
    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = '#38bdf8';
    ctx2d.beginPath();
    points.forEach((p, i) => {
      const [x, y] = toScreen(p);
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    });
    ctx2d.stroke();

    for (const p of points) {
      const [x, y] = toScreen(p);
      ctx2d.fillStyle = '#38bdf8';
      ctx2d.beginPath();
      ctx2d.arc(x, y, 4, 0, Math.PI * 2);
      ctx2d.fill();
    }

    // 面积工具：闭合并填充
    if (tool === 'area' && points.length > 2) {
      ctx2d.closePath();
      ctx2d.fillStyle = 'rgba(56, 189, 248, 0.18)';
      ctx2d.fill();
    }

    // 每段长度
    ctx2d.font = '12px ui-monospace, monospace';
    ctx2d.fillStyle = '#e2e8f0';
    for (let i = 1; i < points.length; i++) {
      const a = toScreen(points[i - 1]!);
      const b = toScreen(points[i]!);
      const m = layer.measureDistance(points[i - 1]!, points[i]!);
      ctx2d.fillText(`${m.distance3D.toFixed(1)} m`, (a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - 6);
    }
  }

  // 通视：可见段绿、遮挡段红，遮挡点画个叉
  if (los && los.result) {
    const [ax, ay] = toScreen(los.from);
    const [bx, by] = toScreen(los.to);
    const t = los.result.visibleRatio;
    ctx2d.lineWidth = 3;
    ctx2d.strokeStyle = '#22c55e';
    ctx2d.beginPath();
    ctx2d.moveTo(ax, ay);
    ctx2d.lineTo(ax + (bx - ax) * t, ay + (by - ay) * t);
    ctx2d.stroke();
    if (!los.result.visible) {
      ctx2d.strokeStyle = '#ef4444';
      ctx2d.beginPath();
      ctx2d.moveTo(ax + (bx - ax) * t, ay + (by - ay) * t);
      ctx2d.lineTo(bx, by);
      ctx2d.stroke();
    }
    for (const p of [los.from, los.to]) {
      const [x, y] = toScreen(p);
      ctx2d.strokeStyle = '#f8fafc';
      ctx2d.lineWidth = 2;
      ctx2d.strokeRect(x - 4, y - 4, 8, 8);
    }
  }
}

/* ---------------------------------------------------------------- 状态 */

/** 通视 / 可视域的眼高（米） */
const EYE_HEIGHT = 1.7;

type Tool = 'none' | 'distance' | 'area' | 'los' | 'viewshed';

let tool: Tool = 'none';
let points: LngLatAlt[] = [];
let viewshed: {
  raster: Float32Array;
  grid: number;
  minX: number;
  minY: number;
  cellSize: number;
  origin: LngLatAlt;
} | null = null;
type LosResult = ReturnType<S3MLayer['lineOfSight']>;
/** 通视：`result` 为空表示「起点已选，等终点」 */
let los: { from: LngLatAlt; to: LngLatAlt; result: LosResult | null } | null = null;
/** 天际线的屏幕坐标（相机一动就作废） */
let skyline: { screen: Float32Array; hasGeometry: Uint8Array } | null = null;
/** 相机停下后是否自动重算天际线 */
let skylineFollow = false;

function hud(text: string): void {
  $('hud').textContent = text;
}

function setTool(next: Tool): void {
  tool = next;
  points = [];
  if (next !== 'viewshed') viewshed = null;
  if (next !== 'los') los = null;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-tool]')) {
    btn.classList.toggle('on', btn.dataset.tool === next);
  }
  draw();
  const tips: Record<Tool, string> = {
    none: '选一个工具，然后在地图上点击。',
    distance: '连续点击取点；右键 / Esc 结束。',
    area: '点三个以上顶点；右键 / Esc 结束并给出面积。',
    los: '点两个点：起点 → 终点（两端各抬 1.7m 眼高），自动判断通视。',
    viewshed: '点一个观察点，算 360° 可视域（半径 300m）。',
  };
  hud(tips[next]);
}

/* ---------------------------------------------------------------- 交互 */

map.on('click', (e) => {
  const p = layer.pickPosition(e.point.x, e.point.y);
  if (!p) {
    hud('这个位置没有拾取到模型表面（可能点在天空/底图上）。');
    return;
  }
  const hit: LngLatAlt = { lng: p.lngLat[0], lat: p.lngLat[1], altitude: p.altitude };

  if (tool === 'distance' || tool === 'area') {
    points.push(hit);
    reportMeasure();
  } else if (tool === 'los') {
    if (!los || los.result) {
      los = { from: hit, to: hit, result: null };
      hud('再点一个点作为终点。');
    } else {
      los.to = hit;
      // 眼高视线：两端各抬 1.7m。贴地视线会被路缘、台阶、花坛这些「真实但没意义」
      // 的东西挡住 —— 几何上没错，但不是规划/安防要的口径。
      const eyeA: LngLatAlt = { ...los.from, altitude: los.from.altitude + EYE_HEIGHT };
      const eyeB: LngLatAlt = { ...hit, altitude: hit.altitude + EYE_HEIGHT };
      los.result = layer.lineOfSight(eyeA, eyeB);
      const r = los.result;
      hud(
        r.visible
          ? `通视：可见 ✅（两端眼高 ${EYE_HEIGHT} m）\n直线距离 ${r.distance.toFixed(1)} m`
          : `通视：不可见 ❌（两端眼高 ${EYE_HEIGHT} m）\n直线距离 ${r.distance.toFixed(1)} m，遮挡在 ${r.blockedDistance!.toFixed(1)} m 处（${(r.visibleRatio * 100).toFixed(0)}% 处）`
      );
    }
  } else if (tool === 'viewshed') {
    const r = layer.viewshed({ origin: hit, radius: 300, grid: 96, eyeHeight: EYE_HEIGHT });
    if (!r) {
      hud('可视域计算失败：图层可能还没挂载。');
      return;
    }
    viewshed = { ...r, origin: hit };
    hud(`可视域：半径 300 m，地面可见比例 ${(r.visibleRatio * 100).toFixed(1)}%\n（青色可见 / 红色遮挡）`);
  }
  draw();
});

map.on('contextmenu', (e) => {
  e.preventDefault();
  finish();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') finish();
});

function finish(): void {
  if (tool === 'distance' || tool === 'area') reportMeasure(true);
  points = [];
  draw();
}

function reportMeasure(final = false): void {
  if (points.length < 2) {
    if (points.length === 1) hud('继续点击，至少两个点。');
    return;
  }
  if (tool === 'area') {
    if (points.length < 3) {
      hud('面积至少需要 3 个点。');
      return;
    }
    const a = layer.measurePolygon(points);
    hud(
      `面积：坡面 ${a.area3D.toFixed(1)} m² / 水平投影 ${a.areaHorizontal.toFixed(1)} m²\n周长 ${a.perimeter.toFixed(1)} m，顶点 ${points.length} 个${final ? '（已结束）' : ''}`
    );
    return;
  }
  const l = layer.measurePolyline(points);
  hud(`长度：三维 ${l.length3D.toFixed(1)} m / 水平 ${l.lengthHorizontal.toFixed(1)} m，顶点 ${points.length} 个${final ? '（已结束）' : ''}`);
}

/* ---------------------------------------------------------------- 工具栏 */

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'distance', label: '距离量算' },
  { id: 'area', label: '面积量算' },
  { id: 'los', label: '通视分析' },
  { id: 'viewshed', label: '可视域 360°' },
];

const bar = $('toolbar');
for (const t of TOOLS) {
  const btn = document.createElement('button');
  btn.textContent = t.label;
  btn.dataset.tool = t.id;
  btn.onclick = () => setTool(tool === t.id ? 'none' : t.id);
  bar.appendChild(btn);
}

/** 裁剪：Box / 十字。以画面中心拾取到的点为原点，铺一个 ±120m 的盒子 */
function clipAroundCenter(kind: 'box' | 'cross'): void {
  const p = layer.pickPosition(map.getCanvas().clientWidth / 2, map.getCanvas().clientHeight / 2);
  if (!p) {
    hud('先让模型出现在画面中心再裁剪。');
    return;
  }
  // setClipping 收的是场景 ENU 米制坐标，pickPosition 正好也返回它（point 字段）
  const origin = p.point as [number, number, number];
  const half = 120;
  if (kind === 'box') {
    layer.setClipping({
      type: 'box',
      a: [origin[0] - half, origin[1] - half, origin[2] - half],
      b: [origin[0] + half, origin[1] + half, origin[2] + half],
    });
  } else {
    layer.setClipping({
      type: 'cross',
      center: [origin[0], origin[1], origin[2] - half],
      keepX: -1,
      keepY: -1,
      horizontal: true,
      keepZ: -1,
    });
  }
  hud(kind === 'box' ? 'Box 裁剪已应用（切掉盒外部分）。' : '十字剖切已应用（切掉一个角）。');
}

const clipBox = document.createElement('button');
clipBox.textContent = 'Box 裁剪';
clipBox.onclick = () => clipAroundCenter('box');
bar.appendChild(clipBox);

const clipCross = document.createElement('button');
clipCross.textContent = '十字剖切';
clipCross.onclick = () => clipAroundCenter('cross');
bar.appendChild(clipCross);

const skylineBtn = document.createElement('button');
skylineBtn.textContent = '天际线';
skylineBtn.onclick = () => runSkyline();
bar.appendChild(skylineBtn);

const followBtn = document.createElement('button');
followBtn.textContent = '天际线跟随';
followBtn.onclick = () => {
  skylineFollow = !skylineFollow;
  followBtn.classList.toggle('on', skylineFollow);
  hud(skylineFollow ? '天际线跟随相机：每次停稳后自动重算。' : '天际线不再跟随相机。');
};
bar.appendChild(followBtn);

/** 底图建筑代理：只造一次，之后复用 */
let proxy: THREE.Group | null = null;
let proxyShown = false;

const proxySkyBtn = document.createElement('button');
proxySkyBtn.textContent = '含底图天际线';
proxySkyBtn.onclick = () => {
  proxy ??= buildBuildingProxy();
  // 注意这里**没有**把代理加进场景：它就是给这一趟深度渲染用的。
  // 真实项目里 MapLibre 已经把底图建筑画出来了，再加一份就是重复渲染。
  runSkyline([proxy]);
};
bar.appendChild(proxySkyBtn);

const proxyShowBtn = document.createElement('button');
proxyShowBtn.textContent = '显示代理';
proxyShowBtn.onclick = () => {
  proxy ??= buildBuildingProxy();
  proxyShown = !proxyShown;
  if (proxyShown) layer.scene?.add(proxy);
  else proxy.parent?.remove(proxy);
  proxyShowBtn.classList.toggle('on', proxyShown);
  hud(
    proxyShown
      ? '代理几何已加进场景（灰盒子）。它们本来只喂给分析 —— 这里加进画面只为让你看见。'
      : '代理几何已从场景移除，恢复成「只参与分析」。'
  );
};
bar.appendChild(proxyShowBtn);

/** 算一次天际线并画到地图上（一次深度 pass，别在拖动中调） */
function runSkyline(include?: THREE.Object3D[]): void {
  // 采集分辨率不用跟画布一致：640 宽 ≈ 0.56°/列，画线时按归一化坐标缩放即可
  const r = layer.skyline({ width: 960, height: 540, include });
  if (!r) {
    hud('天际线计算失败：图层可能还没挂载。');
    return;
  }
  skyline = { screen: r.screen, hasGeometry: r.hasGeometry };
  drawSkyline(r.azimuths, r.elevations);
  draw();
  hud(
    `天际线：最大仰角 ${r.maxElevation.toFixed(1)}°，天空占比 ${(r.openRatio * 100).toFixed(1)}%\n` +
      (include
        ? `（已把底图建筑代理算进去：${include.reduce((n, g) => n + g.children.length, 0)} 个几何，只参与分析、不进画面）\n`
        : '') +
      '地图上的黄线就是天际线轮廓；右上角是「方位角 → 仰角」曲线。'
  );
}

/* ------------------------------------------------- 「含底图」的天际线（外围做法） */

/**
 * 底图建筑代理。
 *
 * 分析只看得见 S3M 场景里的几何，MapLibre 画的建筑不在里面，而且**读不到它的深度**
 * （自定义图层的深度是主 framebuffer 的，帧内拿不出来）。所以只能复制一份几何：
 * 用 `map.querySourceFeatures()` 取当前视野的建筑轮廓 + 高度，挤成 three 几何，
 * 通过 `include` 只喂给这一趟深度渲染。
 *
 * 这里没有矢量底图源，就用「撒一圈盒子」代替 —— 换成真实 MVT 时，
 * 把 `syntheticBoxes()` 换成 `map.querySourceFeatures('源名', { sourceLayer: 'building' })`
 * 再按 `render_height` 挤出即可，后面的调用一行都不用改。
 */
function buildBuildingProxy(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'basemap-building-proxy';

  const features = (() => {
    try {
      return map.querySourceFeatures(undefined as never, { sourceLayer: 'building' });
    } catch {
      return [];
    }
  })();

  const mat = new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.95, metalness: 0 });

  if (features.length > 0) {
    // 真实项目走这里：轮廓 → ENU → ExtrudeGeometry
    // （高度字段各家不同：render_height / height / building:levels * 3）
    for (const f of features) {
      const h = Number((f.properties as { render_height?: number })?.render_height ?? 0);
      if (!(h > 0)) continue;
      const ring = (f.geometry as GeoJSON.Polygon)?.coordinates?.[0];
      if (!ring || ring.length < 3) continue;
      const shape = new THREE.Shape(
        ring.map(([lng, lat]) => {
          const p = layer.lngLatToPoint({ lng, lat, altitude: 0 });
          return new THREE.Vector2(p[0], p[1]);
        })
      );
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      const mesh = new THREE.Mesh(geo, mat);
      // ExtrudeGeometry 沿 +z 挤出，ENU 的 z 就是向上，不用转
      group.add(mesh);
    }
  }

  if (group.children.length === 0) {
    // 兜底：底图没有矢量建筑源时，撒一圈盒子，至少能把「代理参与分析」这件事演出来
    let seed = 20261029;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const c = map.getCenter();
    const mPerDegLng = 111320 * Math.cos((c.lat * Math.PI) / 180);
    for (let i = 0; i < 48; i++) {
      const ang = rnd() * Math.PI * 2;
      const dist = 200 + rnd() * 520;
      const w = 18 + rnd() * 28;
      const h = 12 + rnd() * 80;
      const p = layer.lngLatToPoint({
        lng: c.lng + (Math.cos(ang) * dist) / mPerDegLng,
        lat: c.lat + (Math.sin(ang) * dist) / 110540,
        altitude: 0,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, w, h), mat);
      mesh.position.set(p[0], p[1], p[2] + h / 2);
      group.add(mesh);
    }
  }

  return group;
}

const clearBtn = document.createElement('button');
clearBtn.textContent = '清除';
clearBtn.onclick = () => {
  points = [];
  los = null;
  viewshed = null;
  skyline = null;
  proxy?.parent?.remove(proxy);
  proxyShown = false;
  layer.setClipping(null);
  ($('sky') as HTMLElement).classList.remove('on');
  setTool('none');
};
bar.appendChild(clearBtn);

/* ---------------------------------------------------------------- 天际线曲线 */

function drawSkyline(azimuths: Float32Array, elevations: Float32Array): void {
  const cv = $('sky') as HTMLCanvasElement;
  cv.classList.add('on');
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, cv.width, cv.height);

  const pad = 18;
  const w = cv.width - pad * 2;
  const h = cv.height - pad * 2;
  const maxEl = Math.max(10, ...Array.from(elevations));

  // 地平线
  g.strokeStyle = 'rgba(148,163,184,0.45)';
  g.beginPath();
  g.moveTo(pad, pad + h);
  g.lineTo(pad + w, pad + h);
  g.stroke();

  g.beginPath();
  for (let i = 0; i < elevations.length; i++) {
    const x = pad + (i / Math.max(1, elevations.length - 1)) * w;
    const y = pad + h - (Math.max(0, elevations[i]!) / maxEl) * h;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.lineTo(pad + w, pad + h);
  g.lineTo(pad, pad + h);
  g.closePath();
  g.fillStyle = 'rgba(56,189,248,0.28)';
  g.fill();
  g.strokeStyle = '#38bdf8';
  g.lineWidth = 1.5;
  g.stroke();

  g.fillStyle = '#94a3b8';
  g.font = '10px ui-monospace, monospace';
  g.fillText(`${maxEl.toFixed(0)}°`, 2, pad + 6);
  g.fillText('0°', 2, pad + h);
  void azimuths;
}

/* ---------------------------------------------------------------- 启动 */

map.once('load', () => {
  resize();
  setTool('none');
  boot().catch((e) => hud(`初始化失败：${e?.message ?? e}`));
});
map.on('move', () => draw());

// 天际线是「相机位姿 + 深度图」的产物，镜头一动就作废 —— 必须清掉，
// 否则会留一条和画面完全对不上的旧线（比不画更误导）。
map.on('movestart', () => {
  if (!skyline) return;
  skyline = null;
  draw();
});
map.on('moveend', () => {
  if (skylineFollow) runSkyline();
});
