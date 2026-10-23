/**
 * 纯 three.js 示例：不依赖 MapLibre / Mapbox，直接把 S3M 瓦片渲染进一个普通 three 场景。
 *
 * 这个库的分层本来就是按「宿主无关」切的：
 *   core    —— 纯二进制解析，连 three 都不需要
 *   tileset —— 瓦片树 + LOD + 加载队列，只需要一个 fetch 和一个容器 Group
 *   render  —— buildTileObjects() 把解析结果拼成 three 的 Mesh / Group
 * 所以只要自己喂相机位置、自己加法线光照，就能独立跑；S3MLayer 只是把这三层
 * 粘到 MapLibre 的 custom layer 上，以及补了样式、拾取、描边这些地图侧的东西。
 *
 * 唯一的坑是坐标系：S3M 顶点是局部 ENU（x 东 / y 北 / z 天），three 是 y 朝上，
 * 所以根节点绕 X 轴转 -90°，相机位置要反算回 ENU 才能喂给 LOD 调度。
 */
import * as THREE from 'three';
import { S3MTileset, createSharedUniforms, STYLE, setMaxAnisotropy } from '../dist/index.js';

const DATASETS = {
  cbd: { url: './data/CBD/cbd.scp', name: '北京CBD (CCTV)' },
  comModel: { url: './data/comModel/comModel.scp', name: 'comModel' },
  // 纹理全走 CRN（v3.01），用来验证 crunch 转码 → DXT 解码这条链
  subwayCrn: {
    url:
      'https://www.supermapol.com/realspace/services/3D-local3DCache-SubwayStationCombined' +
      '/rest/realspace/datas/SubwayStationCombined/config',
    name: '地铁站 (CRN 纹理)',
    align: 'top', // 智能语义对齐：顶部对齐地表（下沉 28.5m）
    heightOffset: 3.5, // 微调：出入口站房露于地面约 3.5m（净下沉 25m）
  },
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- 场景 */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
const isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
scene.background = new THREE.Color(isLight ? '#e2e8f0' : '#0d1420');
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  scene.background.set(e.matches ? '#e2e8f0' : '#0d1420');
});

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 60000);

// ENU（z 朝上）→ three（y 朝上）
const root = new THREE.Group();
root.rotation.x = -Math.PI / 2;
scene.add(root);

scene.add(new THREE.HemisphereLight(0xdbe7f5, 0x27303c, 2.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.3);
sun.position.set(0.45, 1, 0.3);
scene.add(sun);

const groundGroup = new THREE.Group();
const grid = new THREE.GridHelper(6000, 60, 0x38bdf8, 0x1e293b);
grid.material.transparent = true;
grid.material.opacity = 0.65;
groundGroup.add(grid);

const groundGeo = new THREE.PlaneGeometry(6000, 6000);
const groundMat = new THREE.MeshBasicMaterial({
  color: 0x0f172a,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const groundMesh = new THREE.Mesh(groundGeo, groundMat);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.renderOrder = 200;
groundGroup.add(groundMesh);
scene.add(groundGroup);

// 样式 uniform 全局共享：切「原色 / 白膜 / 按单体」只是改一个 int
const uniforms = createSharedUniforms();
uniforms.uMode.value = STYLE.TEXTURE;

/* ---------------------------------------------------------------- 轨道控制（够用就好） */

const target = new THREE.Vector3();
let dist = 900;
let theta = -0.75;
let phi = 1.02;

function applyOrbit() {
  phi = Math.min(1.52, Math.max(0.12, phi));
  dist = Math.min(40000, Math.max(8, dist));
  camera.position.set(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  ).multiplyScalar(dist).add(target);
  camera.lookAt(target);
}

let dragging = null;
const canvas = renderer.domElement;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  dragging = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragging.x;
  const dy = e.clientY - dragging.y;
  dragging.x = e.clientX;
  dragging.y = e.clientY;

  if (dragging.pan) {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    const k = dist * 0.0016;
    target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  } else {
    theta -= dx * 0.005;
    phi -= dy * 0.005;
  }
  applyOrbit();
});
canvas.addEventListener('pointerup', (e) => {
  dragging = null;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  dist *= Math.exp(e.deltaY * 0.0012);
  applyOrbit();
}, { passive: false });

/* ---------------------------------------------------------------- 加载数据集 */

let tileset = null;
let framed = false;
let loadToken = 0;

function clearRoot() {
  root.position.set(0, 0, 0);
  for (const child of [...root.children]) {
    child.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    root.remove(child);
  }
}

/** 按根节点的包围盒把镜头抬到能看全的位置 */
function frameCamera() {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  target.copy(sphere.center);
  dist = Math.max(sphere.radius * 2.4, 60);
  // 地面网格与地表面固定在 y=0 作为地表绝对基准（地下部分沉在网格下方，地上出入口露出网格上方）
  groundGroup.position.y = 0;
  applyOrbit();
  framed = true;
}

async function load(key) {
  const ds = DATASETS[key];
  const token = ++loadToken;

  if (tileset) {
    tileset.dispose();
    tileset = null;
  }
  clearRoot();
  framed = false;

  const ts = new S3MTileset({
    configUrl: ds.url,
    maxTiles: 64,
    maxConcurrent: 4,
    uniforms,
    onTile: (node) => {
      if (token !== loadToken) return; // 切换数据集后，旧瓦片的回调直接丢掉
      root.add(node.group); // 瓦片 Group 就在数据集的局部 ENU 米制坐标里
      if (!framed) frameCamera();
    },
    onError: (e) => console.warn('[s3m]', e),
  });

  tileset = ts;
  try {
    await ts.init();
    if (token === loadToken) {
      // 计算垂直对齐偏移（在 three 场景中，root.rotation.x = -PI/2，ENU 的 Z 对应 three 的 Y）
      const hr = ts.heightRange;
      let offsetY = 0;
      if (ds.align === 'top' && hr) {
        offsetY = -hr.max + (ds.heightOffset ?? 0);
      } else if (ds.align === 'bottom' && hr) {
        offsetY = -hr.min + (ds.heightOffset ?? 0);
      } else if (typeof ds.heightOffset === 'number') {
        offsetY = ds.heightOffset;
      }
      root.position.y = offsetY;
      if (!framed) frameCamera();
    }
  } catch (e) {
    console.error(e);
  }
}

/* ---------------------------------------------------------------- 交互 */

$('ds').addEventListener('change', (e) => load(e.target.value));

const MODE_BUTTONS = [
  ['mTexture', STYLE.TEXTURE],
  ['mWhite', STYLE.WHITE],
  ['mBatch', STYLE.BATCH],
];
for (const [id, mode] of MODE_BUTTONS) {
  $(id).addEventListener('click', () => {
    uniforms.uMode.value = mode;
    for (const [bid] of MODE_BUTTONS) $(bid).classList.toggle('on', bid === id);
  });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ---------------------------------------------------------------- 主循环 */

const fmt = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(Math.round(n ?? 0)));
let last = performance.now();
let fps = 0;
let statTimer = 0;

function tick(now) {
  requestAnimationFrame(tick);

  const dt = now - last;
  last = now;
  fps = dt > 0 ? Math.round(1000 / dt) : fps;

  if (tileset) {
    // 相机位置反算回 ENU：world (x, y, z) ← ENU (x, -z, y)
    const enu = [camera.position.x, -camera.position.z, camera.position.y];
    tileset.update(enu, THREE.MathUtils.degToRad(camera.fov), renderer.domElement.height);
  }

  renderer.render(scene, camera);

  if (now - statTimer > 400) {
    statTimer = now;
    if (tileset) {
      $('stTiles').textContent = String(tileset.stats.tiles);
      $('stTris').textContent = fmt(tileset.stats.triangles);
    }
    $('stFps').textContent = String(fps);
  }
}

applyOrbit();
requestAnimationFrame(tick);

// ?ds=subwayCrn 可直接指定数据集（截图 / 分享用），默认还是 CBD
const initial = new URLSearchParams(location.search).get('ds');
if (initial && DATASETS[initial]) {
  $('ds').value = initial;
  load(initial);
} else {
  load('cbd');
}
