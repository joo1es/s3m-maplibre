# s3m-maplibre

**在 MapLibre GL JS 里原生渲染 SuperMap S3M 三维模型** —— 浏览器直接解析 `.s3mb` 瓦片，不需要预先转成 3D Tiles，也不需要 SuperMap 的 WebGL 客户端。

仓库是 monorepo，两个 npm 包：**s3m-maplibre**（MapLibre / Mapbox 图层，本文主角）与 **s3m-three**（宿主无关的渲染内核，不接地图、纯 three.js 场景也能用，见「纯 three.js 使用」）。

[![npm](https://img.shields.io/npm/v/s3m-maplibre?color=blue&label=npm)](https://www.npmjs.com/package/s3m-maplibre)
[![npm](https://img.shields.io/npm/v/s3m-three?color=blue&label=npm%20s3m-three)](https://www.npmjs.com/package/s3m-three)
[![docs](https://img.shields.io/badge/docs-online-38bdf8)](https://joo1es.github.io/s3m-maplibre/docs/index.html)
[![demo](https://img.shields.io/badge/demo-online-2ea44f)](https://joo1es.github.io/s3m-maplibre/demo/index.html)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](./LICENSE)
[![types](https://img.shields.io/badge/types-included-blue)](./packages/s3m-maplibre/src/index.ts)

---

## 为什么需要它

SuperMap 的 S3M（Spatial 3D Model）是国内 GIS 项目里非常常见的三维格式，iServer 的 `realspace` 服务默认就发布成 S3M。但它和 MapLibre / Mapbox 生态是断开的：

- 官方只有 Cesium 系的 WebGL 客户端；
- 转 3D Tiles 是离线批处理，数据一更新就得重跑，做不到实时；
- 转出来的 3D Tiles 还要再丢一次精度。

这个库走的是**第二条路**：在浏览器里直接解析 S3MB 二进制，用 three.js 画在 MapLibre 的自定义图层上。数据更新即时可见，不需要任何预处理。

```
iServer / 本地目录  →  .scp 配置 + .s3mb 瓦片
                          ↓  fetch + 解压 + 二进制解析
                     three.js 几何 + 材质
                          ↓  ENU → Web Mercator
                     MapLibre custom layer (3d)
```

---

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| S3MB 解析 | ✅ | v2.0 / v3.0 / v3.01，官方样例与线上服务字节级对齐；v1.x（OSGB 缓存）见下方「核心格式逆向与标定说明」 |
| S3MBLOCK 纹理分包 | ✅ 完整 | 支持单文件 `.s3mblock` 瓦片容器、内嵌图集拼图合批、细级 LOD 外部 `.texblock` 及 pack 批量合并请求（`extratiles`）、多精灵组合画布动态装配与 UV 自动重映射 |
| MeshOpt 几何压缩 | ✅ | v3 默认压缩方式，浏览器内 wasm 解码，按需加载 |
| LOD 渐进加载 | ✅ | 支持 `Distance_From_EyePoint` / `Pixel_Size_OnScreen`；线上高斯泼溅与点云用的 `rangeMode = 2`（规范枚举里没有这一档）按屏幕尺寸近似处理，可用 `lodRangeScale` 收放 |
| 多数据集叠加 | ✅ | 各数据集独立锚点，自动对齐到统一场景原点 |
| 白膜 / 单色 | ✅ | |
| 按高度 / 按楼层着色 | ✅ | 高度范围自动统计 |
| 按单体着色 | ✅ | 基于 S3M 单体化信息 |
| 按业务字段着色 | ✅ | 走 iServer 数据服务查 SMID 属性，分类 / 色带 / 分级，见 [s3m-three API 文档](./packages/s3m-three/docs/API.md#按业务字段着色) |
| 按业务字段过滤 / 抬高 | ✅ | 区间 / 取值 / 谓词过滤，字段值映射成抬高米数，同样只改一张一维纹理 |
| 动态扫描 | ✅ | 扫描线沿高度循环 |
| 透明度 | ✅ | 实时，不重编译着色器 |
| 选中高亮 + 描边 | ✅ | 单体级 |
| 全局棱线 | ✅ | 优先用数据自带棱线包，没有才 CPU 现算 |
| 单体级点选 + 属性 | ✅ | GPU 拾取，代价与面数无关；支持 `pickPosition()` 返回精确表面交点与世界坐标 |
| 穿透拾取 drillPick | ✅ | 沿视线方向穿透拾取多个单体并按深度排序返回 |
| 单体包围盒与飞向 | ✅ | `getFeatureBounds(smid)`（内核）与 `flyToFeature(smid)`（图层，内部走宿主 `map.fitBounds`）聚焦单体 |
| 单体三维平移 | ✅ | `FeatureStyle.translation` 存 `[dx, dy, dz]`（米），与着色器 / 拾取 / 描边全链路同步 |
| LOD 细化倍率 | ✅ | `lodRangeScale` 运行时动态调节粗细模判定阈值 |
| 实例化几何 | ✅ | `instanceMode` 16 / 17 |
| 正交投影 | ✅ | 可选开关（`projection: 'orthographic'`），默认透视；需 MapLibre ≥ 5，正交时底图 / 地形 / marker 需 App 退出，见[正交投影](#正交投影) |
| 可调光照 | ✅ | `setLight()` / `getLight()` 支持动态调整环境光与主平行光的颜色、强度、方位角与高度角，支持 `headlamp`（跟随视角）与 `fixed`（太阳固定世界方位）模式 |
| 服务鉴权 | ✅ | `authenticate` 钩子：内核发出的全部请求（配置 / 瓦片 / 子图集 / 棱线缓存 / 属性查询）统一改写 URL（加 `?token=`）或附加请求头，支持异步换 token，见[服务鉴权](#服务鉴权authenticate) |
| 显存与多图层优化 | ✅ | 全局瓦片预算 `totalMaxTiles` 动态分配、纹理引用计数淘汰自动释放 GPU 显存、递归深度释放几何/材质/点云/线框，防止长时间漫游或多图层堆叠爆显存 |
| 瓦片同材质合批 | ✅ | 倾斜摄影大瓦片自动合批，大幅降低 DrawCall |
| 纹理变换与寻址 | ✅ | 支持 `texmodmatrix` 仿射变换与 `addressmode` |
| DXT / WebP 纹理 | ✅ | |
| 骨骼动画 | ❌ | 未实现：LODPackage 上的 animations JSON 直接跳过不解析，官方 JS SDK 同样只读偏移不驱动 |
| 深度遮挡 | ✅ | **深度来源可替换**：本层全程不清深度缓冲（`autoClear = false`），谁写了更近的深度谁就遮挡建筑。地形只是其中一个来源（宿主 `setTerrain` + DEM，山体挡楼）；自带物理地表代理（`ground.occlude`）是另一个来源，能把地下结构真正切掉，两者可叠加 |
| Draco 压缩几何 | ✅ 点云 | v3.01 点云分支已解码（内联 wasm、按需加载，分类码 / 强度 / 权重一并解出）；容器与规范描述对不上，按真实瓦片标定，见[核心格式标定说明](#核心格式逆向与标定说明) |
| 高斯泼溅服务（`3DGaussianSplatting`） | ✅ 完整 | 已标定 gsScale / gsRotation 量化格式，支持各向异性高斯片、协方差计算、深度排序与点选拾取 |
| SuperMapCache / S3M 1.x（`.s3m`） | ✅ | 几何、UV、索引、DXT1 纹理、整棵 LOD 树都能解；瓦片是 `s3m\0` + zlib 的老容器，走独立解析器 `core/S3M1Parser.ts`。见[线上服务的三种发布形态](#线上服务的三种发布形态) |
| CRN 纹理（`compressType` 26 / 27 / 38001 / 50000） | ✅ | 内联 crunch wasm 转 DXT 后走同一套解码，只在遇到时懒加载；已在 SuperMap Online 公有服务实测 |
| KTX2 纹理 | — | S3M 官方 `pixelFormat` 枚举里没有这个值，属于「不会遇到」而不是「不支持」 |

---

## 安装

```bash
npm install s3m-maplibre three     # MapLibre / Mapbox 宿主
npm install s3m-three three       # 只要渲染内核（任意 three 场景）
```

两个包都在 npm 上：[s3m-maplibre](https://www.npmjs.com/package/s3m-maplibre)、[s3m-three](https://www.npmjs.com/package/s3m-three)。`s3m-maplibre` 依赖 `s3m-three`（渲染内核，`^` 范围），装前者会自动带上后者。

两包**版本各自独立**：内核修 bug 只发 `s3m-three` 的新 patch，图层包靠 `^` 范围自动获得，不必重复发；只有图层自己改了才需要发 `s3m-maplibre`。

`three` 是 peer 依赖（`>=0.155.0`）。下限取 0.155 而不是更早的版本，是因为 0.152 换掉了 `outputEncoding`（改叫 `outputColorSpace`）、0.155 又把光照默认值切成物理单位——再往前的 three 会把方向光放大约 π 倍，白模会直接过曝。`maplibre-gl` 不是依赖——图层只是一个符合 `CustomLayerInterface` 的普通对象，MapLibre / Mapbox 都能挂；不用地图时直接用 `s3m-three` 的 `S3MViewer`（见「纯 three.js 使用」）。

类型随包发布（各包 `dist/index.d.ts`，由源码直接生成）。three 自身不带类型，需要另装 `@types/three`。

---

## 浏览器直接引入（无打包器）

两个包的 `dist/browser/` 下各出两个文件（`bun run build` 时自动生成）：

| 文件 | 体积 | 用途 |
|---|---|---|
| `s3m-maplibre.iife.js` | 约 800+ KB | 内置 three + s3m-three，一行 script 开箱即用 |
| `s3m-maplibre.iife.ext-three.js` | 约 200+ KB | three 外置，用页面上的 `window.THREE` |
| `s3m-three.iife.js` / `s3m-three.iife.ext-three.js` | 约 800+ / 200+ KB | 同上，只要渲染内核 |

### 一行 script

```html
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5/dist/maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/s3m-maplibre@0.4.2/dist/browser/s3m-maplibre.iife.js"></script>
<script>
  const layer = new S3MMapLibre.S3MLayer({ configUrl: './data/CBD/cbd.scp' });
  map.addLayer(layer);
</script>
```

全局名：图层是 `S3MMapLibre`，内核是 `S3M`。

内置版加载时会顺手把那份 three 挂到 `window.THREE`（页面里已经有就不覆盖），所以你要自己搭场景时直接用 `window.THREE` 就行——**不要再另外引一份 three**，两份实例会让 `instanceof` 判断失效。

### 自带 three

`three` 从 r160 起不再发布 UMD，页面上没有现成的 `window.THREE`，所以自己引时必须先把 three 放到全局、再加载外置版：

```html
<script type="module">
  import * as THREE from 'https://esm.sh/three@0.169.0';
  window.THREE = THREE;
  await import('https://cdn.jsdelivr.net/npm/s3m-maplibre@0.4.2/dist/browser/s3m-maplibre.iife.ext-three.js');
</script>
```

顺序不能反：外置版执行时就去读 `window.THREE`。

### 原生 ESM（和 `import * as THREE from 'https://…'` 同一种写法）

不用 IIFE，直接吃包的 ESM 产物，bare specifier 交给 importmap 解析：

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
    "s3m-three": "https://cdn.jsdelivr.net/npm/s3m-three@0.3.2/dist/index.js",
    "s3m-maplibre": "https://cdn.jsdelivr.net/npm/s3m-maplibre@0.4.2/dist/index.js"
  }
}
</script>
<script type="module">
  import * as THREE from 'three';
  import { S3MLayer } from 's3m-maplibre';
</script>
```

这条路上 `three` 只有一份（就是你 importmap 里那个），也不需要 `window.THREE`。代价是 dist 是逐文件 ESM（90+ 个文件），首屏请求数比单文件多；在意请求数就用上面的 IIFE。

esm.sh 也能直接吃：`import { S3MLayer } from 'https://esm.sh/s3m-maplibre@0.4.2'`。注意它会为 `three` 生成自己的 URL，你如果同时引 `https://esm.sh/three@0.169.0`，两边不一定是同一个构建——用 `?deps=three@0.169.0` 对齐，或 `?external=three` 配 importmap。

---

## 快速开始

```js
import maplibregl from 'maplibre-gl';
import { S3MLayer, STYLE } from 's3m-maplibre';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [121.4739, 31.244],
  zoom: 16.5,
  pitch: 60,
  antialias: true, // 建筑边缘需要抗锯齿
});

const layer = new S3MLayer({
  datasets: [
    {
      id: 'jingmo',
      name: '精模',
      configUrl: 'https://host/iserver/services/svc/rest/realspace/datas/jingmo/data/path/jingmo.scp',
    },
  ],
  style: { mode: STYLE.WHITE, opacity: 0.92 },
  onPick: (f) => console.log(f?.smid, f?.height, f?.floors),
});

map.on('load', () => map.addLayer(layer));
```

### 叠加多个数据集 + 换着色

```js
const layer = new S3MLayer({
  datasets: [
    { id: 'zhoubian', name: '周边底模', configUrl: '.../zhoubian.scp' },
    { id: 'jingmo', name: '精模', configUrl: '.../jingmo.scp' },
  ],
  maxTiles: 48,
});

await layer.addDataset({ id: 'cheng', name: 'cheng', configUrl: '.../cheng.scp' });

layer.setStyle({ mode: STYLE.HEIGHT, colorA: '#e2e8f0', colorB: '#1d4ed8' });
layer.setDatasetVisible('zhoubian', false);
layer.setEdges(true);
```

### 点选

```js
map.on('click', (e) => {
  const f = layer.pickFromEvent(e);
  if (!f) return layer.select(null);
  layer.select(f);
  console.log(`${f.datasetName} · SMID ${f.smid} · ${f.height}m · ${f.floors}层`);
});
```

完整接口分两份，各管各的：**[s3m-maplibre API 参考（在线网页）](https://joo1es.github.io/s3m-maplibre/docs/index.html)** / [本地](./packages/s3m-maplibre/docs/API.md)，**[s3m-three 内核 API 参考](https://joo1es.github.io/s3m-maplibre/docs/three.html)** / [本地](./packages/s3m-three/docs/API.md)。

---

## 演示与在线文档

在线体验与文档（GitHub Pages，数据随仓库一起发布）：

- **📚 图层开发指南 & API 文档** — <https://joo1es.github.io/s3m-maplibre/docs/index.html>
- **📗 内核（s3m-three）API 文档** — <https://joo1es.github.io/s3m-maplibre/docs/three.html>
- **🗺️ MapLibre 版演示** — <https://joo1es.github.io/s3m-maplibre/demo/index.html>
- **🧊 纯 three.js 版演示** — <https://joo1es.github.io/s3m-maplibre/demo/three.html>
- **🏠 Pages 导航入口** — <https://joo1es.github.io/s3m-maplibre/>

本地跑：

```bash
bun run dev    # 开发：编一次 packages → tsc -w + vite dev（一个端口同时出文档和 demo）
bun run serve  # 只服务已构建的产物（http://localhost:8123/s3m-maplibre/demo/index.html）
bun run demo   # 全量构建后起静态服务
bun run build  # 只产出，不起服务
```

`bun run dev` 起来后：

| 地址 | 内容 |
|---|---|
| <http://localhost:5173/> | s3m-maplibre 文档（改 `packages/*/docs/API.md` 保存即刷新） |
| <http://localhost:5173/three.html> | s3m-three 内核文档 |
| <http://localhost:5173/demo/> | demo（和线上 `demo/index.html` 同路径，相对资源不用改） |

改 `packages/*/src/**/*.ts` 由 `tsc -w` 增量编译，vite 直接读到新产物；改 `site/` 下的组件走 HMR。

`bun run build` 会按 `s3m-three → s3m-maplibre → docs → demo` 的顺序全部产出，其中 docs/ 与 demo/index.html 都由 `site/` 构建（共用一份 `site/vite.config.ts`，只是入口和输出目录不同；产物位置不变，URL 不变）。

演示自带两份本地样例数据（北京 CBD 的 CCTV、comModel，离线可用），另有一个在线预设「地铁站 (CRN 纹理)」——SuperMap Online 公有服务，纹理全是 CRN，用来肉眼验证 CRN 转码链路；也可以在地址栏输入框里填任意 iServer `realspace` 服务根地址、`datas` 集合或具体的 `.scp`，自动列出数据集并默认勾选第一个。

演示包含：数据集叠加开关、着色模式、透明度、平面/平滑着色、选中描边（棱线 / 外扩两种画法，粗细可调）、全局棱线、点击属性卡；右侧面板还能填 iServer 数据服务地址，按业务字段（KEYID / SmMaxZ…）上色出图例、按区间过滤、按字段值抬高。

「投影」分组里的**正交投影**勾选框（或 `?ortho=1`）会把 S3M 层切成正交相机——pan / zoom / pitch / 拾取 / 选中全部照常，勾选时自动隐藏底图（正交层和透视底图对不齐，见[正交投影](#正交投影)）。演示用的是 `devDependencies` 里的 MapLibre GL JS v5（由 vite 打包，不再有 `demo/vendor/` 下的那份 UMD 副本），正交需要的独立投影矩阵从 v5 开始才有。

---

## 纯 three.js 使用（不用 MapLibre）

渲染内核 `s3m-three` 就是干这个的，两条路：

**省事路线 —— `S3MViewer`**：把场景、相机、灯光、拾取、选中、样式都封好的宿主无关查看器，只差你自己喂帧：

```js
import * as THREE from 'three';
import { S3MViewer } from 's3m-three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);

const viewer = new S3MViewer({
  configUrl: '.../jingmo.scp',
  onRequestRepaint: () => {},        // 接自己的渲染循环
  getBearing: () => 0,               // 可选：让灯光跟着视角走
});
viewer.geo = null;                   // null = 标准 Web 墨卡托兜底；也可注入自定义 GeoAdapter
viewer.mount(renderer.domElement, renderer.getContext());

function tick() {
  const mvp = new THREE.Matrix4();   // 你的 world→clip 矩阵
  const p = camera.position;
  viewer.renderFrame({
    mvp: mvp.elements,
    cameraEnu: [p.x, -p.z, p.y],     // three（y 朝上）→ ENU（z 朝上）
    fovRad: THREE.MathUtils.degToRad(camera.fov),
    canvasHeight: renderer.domElement.height,
  });
  requestAnimationFrame(tick);
}
```

**自由路线 —— 只用分层**。`core/` 解析与 `tileset/` 瓦片树都是宿主无关的：

| 层 | 需要什么 | 与地图的关系 |
|---|---|---|
| `core/` 解析 | 一个 `ArrayBuffer` | 完全无关，Node 里也能跑 |
| `tileset/` 瓦片树 | `fetch` + 一个 `three.Group` 当容器 | 只要喂相机位置算 LOD |
| `render/` 几何 | WebGL 上下文 | 只产出 `THREE.Group` / `Mesh` |

```js
import * as THREE from 'three';
import { S3MTileset, createSharedUniforms, STYLE } from 's3m-three';

const uniforms = createSharedUniforms();       // 材质 uniform 全局共享
uniforms.uMode.value = STYLE.TEXTURE;          // 改这一行就是切样式

const root = new THREE.Group();
root.rotation.x = -Math.PI / 2;                // S3M 顶点是 ENU（z 朝上），three 是 y 朝上
scene.add(root);

const tileset = new S3MTileset({
  configUrl: '.../jingmo.scp',
  uniforms,
  onTile: (node) => root.add(node.group),      // node.group 就是这片瓦片拼好的 Group（米制局部坐标）
});
await tileset.init();                          // 返回时首棵瓦片已就绪

// 每帧：把相机位置换算回 ENU 喂给 LOD 调度，父子瓦片自己按需细分
function tick() {
  const p = camera.position;
  tileset.update([p.x, -p.z, p.y], THREE.MathUtils.degToRad(camera.fov), renderer.domElement.height);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
```

完整可运行版本见 [`demo/three.js`](./demo/three.js)（一个文件，含轨道控制、切片统计、样式切换）。

---

## 核心格式逆向与标定说明

这三个常被问到，结论分别不同：

**Draco 压缩几何 —— 已支持（v3.01 点云分支）。**
接法与 MeshOpt 一致：内联 wasm 解码器（约 266KB）、只在骨架走到 Draco 标记时动态 `import`、解码后并入同一套 attribute 组装，点云按 `primitiveType = 1` 交给 `THREE.Points` 渲染；分类码 / 强度 / 权重三种自定义属性一并解出来。

**但容器是按真实瓦片逐字节标定的，规范里 Draco 分支的描述和实际数据对不上。**标定出的字段顺序（偏移以骨架 tag 字段之后为 0）：

```
u32  payloadSize       // 覆盖「本字段之后 … 条目末尾 OBB 之前」
u32  未知（实测恒 32）
i32  pos / normal / color / secondColor 各自的 draco 属性 uid（-1 = 无）
u32  自定义属性个数（实测 3）+ i32[] 各自的 uid
u32  vertexAttrCount   // 实测恒 0
u32  dracoSize; byte[dracoSize]   // 标准 draco 比特流，开头 5 字节是 "DRACO" 魔数
String descript        // {"PointCloudClassCode":2,"PointCloudIntensity":1,"VertexWeight":0}
f64  obb[12]           // 不在这段里读，由骨架条目统一按「条目末尾 96 字节」取
```

两个坑记一下：

1. `descript` 的值是「该属性在自定义 uid 数组里的**下标**」，不是分量数（`VertexWeight→0`、`Intensity→1`、`ClassCode→2`）。
2. **官方 SDK 这条路径解析不了同一个服务**：`parseDracoSkeleton` 的字段顺序里多了一个 `materialCount`，而且 `version === 3` 的判定对 v3.01 瓦片不成立。所以这个分支不能照官方实现抄，只能以实测为准。

读偏的兜底是四重自校验：`payloadSize` 覆盖范围、`dracoSize`、`"DRACO"` 魔数、以及骨架条目自带的 `skeletonStreamSize`；另有单骨架点数上限（64M）防止把头读错时开出天文数字的缓冲。实测两个瓦片 5 个骨架逐字节一致。

这一轮的回归测试还没补进 `tests/`（目前只有排查用的探针脚本），是下一步要收的尾。

**CRN 纹理 —— 已支持，并在真实服务上验过。**
`packages/s3m-three/src/vendor/crunch_decoder.module.js`（crunch 的 emscripten 胶水，wasm 内联成 base64，只在真的遇到 CRN 时动态 import）把 CRN 转回 DXT 块，再走现成的 DXT1/3/4/5 解码；具体是 DXT1 还是 DXT5 由 CRN 头部给出。判定逻辑收敛在 `packages/s3m-three/src/core/TextureFormat.ts`，单测钉死 25 条断言。

**关键点：「是不是 CRN」看 `compressType`，不能看 `pixelFormat`。** 实测到的三组组合（SuperMap Online 公有服务）：

| 数据版本 | compressType | pixelFormat | 实际内容 |
|:---|:---|:---|:---|
| v3.00 | `26`（CRN_DXT5） | `13`（ABGR，无意义） | CRN，数据以 `Hx` 开头 |
| v3.00 | `14`（噪声） | `21` | DXT5 裸块 |
| v3.01（行标） | `50000`（TC_CRN_DXT5） | `32856`（GL_RGBA8） | CRN，数据以 `Hx` 开头 |

早期版本按 `pixelFormat === 26 / 27` 判断，真实服务里的 CRN 纹理会被当成未知格式整包丢掉——表现就是**模型能出来，但全是灰模**。现在先看 `compressType`（`26 / 27 / 38001 / 50000`），认不出来才退回 `pixelFormat`；另外 `transcodeCRN` 会先验 `Hx` 魔数，避免把误标的 DXT 数据喂进 crunch 解出一个「尺寸看着合理」的垃圾块。

验证方式：

```bash
bun run probe:crn -- --crn https://host/iserver/services/svc/rest/realspace/datas/<数据集>/config --limit 3
# 也可以先摸底：--service <realspace 根地址> 列出每个数据集的 s3m:TextureCompressionType
```

探针会对每张 CRN 纹理报告「尺寸是否与纹理头一致 / 解出的色数 / 邻域粗糙度」，并打一张 ASCII 灰度预览，用来判断熵解码是否真的解对了（解错会是一屏噪声）。已跑过的数据：`3D-BianDianZhan3`（512²，v3.00）、`3D-BIMTreeModel` / `3D-local3DCache-SubwayStationCombined`（32² / 64²，v3.01）、`3D-scyx`（1024²），除「数据本身标错」外全部尺寸吻合、预览有真实结构。

**KTX2 —— 不是「不支持」，是 S3M 里基本不会出现。**
官方 `S3MPixelFormat` 枚举（`1/2/3/4/5/6/7/10/11/12/13/14/17…21/25/26/27/28`）里没有 KTX2 / Basis 的条目，iServer 也不会发。真要支持，得自己引入 `basis_transcoder.wasm` 并把 KTX2 容器转成 RGBA32 或 DXT，但那是给「别人转成 KTX2 再塞进 S3M」的场景准备的，没有数据样本可测。

共同前提：**要有样例数据**。3DGS 的 `gsScale` / `gsRotation` 量化格式已从官方 Worker 成功逆向标定（`log` 量化尺度与四元数恢复），已完整支持高斯椭球体投影、协方差计算与相机视角深度排序（`core/GaussianSplat.ts` 与 `viewer/SplatLayer.ts`）。

Draco 与 3DGS 的容器结构都已有回归测试钉住：`tests/unit/draco.test.ts`（单骨架 + 4 骨架两块真实瓦片）、`tests/unit/gaussian-splatting.test.ts`（根瓦 + 子瓦，含那次 +4 字节错位）。改字段顺序这几条会直接红。

> 逐字段的**标定依据、置信度分级、与官方 SDK 的分歧清单、上游变更后的复验流程**，都整理在 **[FORMAT-NOTES](./packages/s3m-three/docs/FORMAT-NOTES.md)** —— 这些知识原本散在七个解析器的头部注释里，改一次代码要翻七个文件。

### 线上服务的三种发布形态

`supermapol.com/realspace/services/3D-xxx/` 这类公有服务看着同一个 URL 样式，底下其实是三种完全不同的数据。先摸清形态再排查，比在渲染层猜快得多——**判断只看两处**：`…/rest/realspace/datas.json` 列出的数据源名，和 `…/datas/<数据源>/config` 返回的是 JSON 还是 XML。

| 形态 | config | 瓦片 | 本库支持 |
|:---|:---|:---|:---|
| S3M 瓦片缓存（主流） | JSON（`rootTiles` / `position.point3D` / `geoBounds`） | `.s3mb` v2 / v3 / v3.01，或 `.s3mblock` | ✅ 完整（含 `.s3mblock` 纹理分包与 `.texblock` 细级外部图集完整支持） |
| SuperMapCache / S3M 1.x | **XML**（`<SuperMapCache>`，`sml:FileType = OSGBFile`） | `.s3m` —— 整棵 LOD 树都是这种容器（子瓦走 `datas/<数据源>/data/path/…/<名>.s3m`） | ✅ 几何 / 纹理 / 细化全通，走 `core/S3M1Parser.ts` |
| 高斯泼溅 | JSON，`dataType = "3DGaussianSplatting"` | `.s3mb` v3.01 + MeshOpt，**没有索引包** | ✅ 完整支持高斯泼溅渲染（已标定 scale / rotation，支持协方差、深度排序与点选拾取） |

几个已经踩过、已经修掉的坑，记在这里免得再踩：

- **`config` 不带后缀**。`datas/<名>/config.xml` 会 406「当前资源不支持请求体中的媒体类型」，`datas/<名>/config` 才对。数据源名可以是中文（如 `寿宁阁`），走 `new URL()` 会自动百分号编码。
- **OSGB 的 XML 里没有经纬度范围**，只有 `<sml:Position>`（经纬度原点）和 `<sml:BoundingBox>`（以该原点为中心的**米制**局部盒）。直接读 `Left/Right/Top/Bottom` 会得到全 0，于是视角甩到几内亚湾，锚点校验还会把唯一正确的 `position` 判成异常。现在按等距圆柱近似反算（`Δlon = x / (111320·cos φ)`、`Δlat = y / 110540`）。
- **OSGB 的瓦片名带 `+`**（`Tile_+002_+001`）。iServer 的 Java 侧按 `URLDecoder` 解路径，未编码的 `+` 会变成空格 → 404「瓦片数据不存在」；`new URL()` 又认为 `+` 在 path 里合法而不编码。所以拼出来的每个瓦片 URL 都得把 `+` 补成 `%2B`（同一个地址实测：裸 `+` 404，`%2B` 200）。
- **v3.01 的 `position` 换成了 `position.point3D` + `unit`**（老数据是 `position.x/y/z` + `units`），两个键名都得认，否则投影单位是米的数据会被当成度。
- **S3M 1.x 的识别与分流**：头 4 字节是魔数 `73 33 6D 00`（`"s3m\0"`），紧接 `78 da` 的 zlib。不当场分流的话，头 4 字节会被 float32 读成 1e-38 的「版本号」，再把 zlib 头当长度，报出来的是 `RangeError: Invalid typed array length` 这种彻底误导人的错。现在 `parseS3MB` 认出魔数就交给 `core/S3M1Parser.ts`。解压后的结构：`uint32 xmlSize + XML + 补齐到 4 字节对齐 + (uint32 size + data) × 3`（几何流 / 4 字节小段 / 纹理流），三段长度链在四块样本上严丝合缝落到解压末尾。注意 XML 之后那几个 `0x30` 是**对齐填充**（2~3 个，取决于 XML 长度），不是固定标记 —— 我一开始把它当成 `byte[3] "000"` 写进了文档。
- **`.s3m`（SuperMapCache）的下一级 LOD 不是 `.osgb`**。XML 里 `RangeDataList` 写的 `Tile_+002_+001_L16_0.osgb` 只是切片时的原始文件名，服务实际发布的是**同名换 `.s3m` 后缀**，走 `datas/<数据源>/data/path/<瓦片目录>/<名>.s3m`（实测 L16/L17/L18 全部 200，`?sceneName=` 不参与寻址）。所以整棵树都是同一种容器，不需要 OSG Binary 解码器。
- **这种容器已接通解码**（`core/S3M1Parser.ts`，`parseS3MB` 认魔数后分流）。完整布局：几何头 `meshCount + {geoName, 7, 772, V, 0}` → `V × 16B` 顶点 `(x, y, z, z)` → 24B 数组头 `[0,0,0, 1, V, 2]` → `V × 8B` UV → 12B 索引头 `[1, indexCount, 0x00040100]` → `u16` 索引（末尾补到 4 字节对齐）→ `[u32 1][u32 materialId]`（与 XML 材质号一致）。三条不变量互相印证：`indexCount` 恒被 3 整除、最大索引恰为 `V-1`、逐 LOD 的几何都落在 XML 那个包围球内。接这种格式踩过三个坑，都写进了测试：
  1. **没有法线数组**（全段扫 `|v|≈1` 最长游程只有 4~10 个）→ 要 `computeVertexNormals()`；
  2. **头里的 `format=14` 不是 `S3MPixelFormat`**（那枚举里 14 = BGRA = 4 B/px），照搬就把 0.5 B/px 的 DXT1 当 4 字节读 → 满屏彩噪。按 `size/(w·h)` 反推；
  3. **UV 的 `v=0` 对应文件首行**，和 DXT 解码内部那次 GL 方向的 Y 翻转相反 → 不抵消就正好采到图集空的那半张（区域均值亮度 5.6 对比 76.1），模型一片黑块，所以要置 `flipY`。
- **高斯泼溅（3DGS）已完整支持**：数据里每条骨架携带的 `gsScale` 与 `gsRotation` 自定义流（各 4 字节/顶点）已从官方 Worker 源码中逆向标定（`gsScale` 为 log 量化，`gsRotation` 为单位四元数），实现了完整的各向异性高斯椭球体计算、视锥协方差投影与逐帧相机视角深度排序（`core/GaussianSplat.ts` 与 `viewer/SplatLayer.ts`），支持拾取和动态透明度。


---

## 工作原理

### 解析

S3MB 是「文件头 + 压缩段」结构：`float version` → (v3) `uint32 compressedType` → (v2+) `uint32 uncompressedSize` → `uint32 compressedSize` → 压缩载荷。解压后是严格的顺序流：

```
fileOptions
GroupNode → PageLOD[] → Geode[]（matrix4d + skeletonNames）
Skeleton[] → VertexDataPackage + IndexPackage[]
Textures / Materials
PickInfo（单体化：SMID → batchId + 顶点区间）
Extensions（v3）
```

解析器是纯 TS，**不依赖 three 和 WebGL**，可以在 Node 里跑，用 `bytesRead === bytesTotal` 自检偏移是否正确。

### MeshOpt 压缩几何

iServer 现在默认用 MeshOpt 压几何（`VertexTag = 2`），瓦片里的顶点流是 meshoptimizer 编码过的量化数据。处理方式：

- **解码器**直接内联 [meshoptimizer](https://github.com/zeux/meshoptimizer) 0.17 的 wasm 解码器（MIT，约 22KB），只有真的遇到 MeshOpt 瓦片才动态 `import`；
- **容器结构**按真实数据逐字节标定（规范里的 `CompressedDataPackage` 已经落后于 v3.01 的实际数据），量化公式用瓦片自带的 OBB 反推验证：
  ```
  position = minVerticesValue + uint16 * vertCompressConstant
  texcoord = minTexCoordValue[i] + uint16 * texCoordCompressConstant[i]
  normal   = octDecode(int16 / 32767)
  ```
- 官方 `ParseMeshOpt.js` **不能直接搬运**：它被混淆过，而且在描述字符串之后多推进 4 字节，遇到现在 iServer 发的 v3.01 数据必然崩在索引包上。

### 索引包类型

一个骨架可以带多个索引包，`primitiveType` 决定怎么画：

| primitiveType | 含义 | 画法 |
|---|---|---|
| 4 | 独立三角形 | `Mesh` |
| 13 | **数据自带的棱线包**（规范里没写，实测就是建筑轮廓线） | `LineSegments` |
| 其他 | 点 / 线 / 条带 | 跳过 |

把 13 当三角形画，每条棱线都会被连成一根几十上百米的尖刺 —— 这是踩过的坑，写在这里省下一个人一天。

### 坐标

```
S3M 顶点（数据集局部 ENU，米）
  → 数据集 Group 偏移（各锚点对齐到场景锚点）
  → L 矩阵：ENU → Web Mercator 归一化
  → MapLibre 传入的 mercator→clip
```

场景原点固定在第一个数据集的锚点，顶点只保留「相对锚点的米」——等价于 3D Tiles 的 `RTC_CENTER`，避免 float32 在大坐标下抖动。

### 着色

所有模式都在同一个 `MeshStandardMaterial` 的片元着色器里用 `uMode` 分支实现，uniform 全局共享。切换样式不重建几何、不重建材质、不重编译着色器。

### 拾取

「物体编号 + batchId」编码成 RGBA 渲到离屏目标，点击时读那一个像素。代价与三角面数无关，深度测试由 GPU 完成，天然只命中最前面的可见面。

离屏目标只有 1×1：viewport 仍是整块画布、原点平移到点击点，整幅画面照常光栅化，只有那一格落在目标上——所以每点一次不是渲染一整屏。

### 正交投影

可选开关（`projection: 'orthographic'`，默认透视）。MapLibre 没有正交相机，custom layer 每帧拿到的是透视 MVP；但 MapLibre ≥5 会把 `projectionMatrix`（view→clip）和 `modelViewProjectionMatrix`（world→clip）**分开**给，于是视图矩阵可以精确解出来：

```
V = P⁻¹ × MVP           （反推视图矩阵，不猜、不自建相机）
正交 MVP = P_ortho · V ，P_ortho 半高 = 相机距 × tan(fov/2)
```

半高取「目标深度处透视视锥的半高」，于是正交与透视在目标平面上逐点重合，zoom 改相机距离 → 距离减半 = 半高减半 = 放大一倍，pan / pitch / rotate 手感与透视完全一致。拾取、选中描边、状态纹理都读同一个相机，自动跟随。MapLibre v4 只给一个合并矩阵，解不出 V，会明确告警并保持透视。

实现上有个坑：视场角必须用 render() 入参里的 `fov`（弧度）——MapLibre v5 起 `transform.fov` 改成了「度」，当弧度用会让 `tan(fov/2)` 差出 20% 以上（LOD 屏幕误差和正交半高都会错）。

**边界（产品决策，不是技术限制）**：正交只覆盖本层。底图瓦片、地形、DOM Marker / 弹窗仍走 MapLibre 自己的透视投影，和正交层差 ≈ 楼高 / 相机距——城市尺度（楼高 100m、相机距 1km）俯视时屋顶线就能差出 ~90px（1080p），带俯仰角时连地面一起撕开（近端可差上千像素）。要用正交，App 需要自行把这些层退出；demo 里的勾选框就是这么干的（勾选即隐藏 `bg` / `osm` 两层）。

### 服务鉴权（authenticate）

S3M 服务挂在带鉴权的网关后面时（要求 URL 带 `?token=`、或请求头带 `Authorization` / `X-Token`），用 `authenticate` 钩子统一处理。内核主线程发出的**全部**请求——数据集配置 scp、瓦片 `.s3mb` / `.s3mblock`、子图集 `.texblock`、棱线缓存、iServer 属性查询——发出前都过一遍这个钩子：

```js
const layer = new S3MLayer({
  configUrl: 'https://gw.example.com/data/a.scp',
  authenticate: (url, kind) => ({
    url: `${url}${url.includes('?') ? '&' : '?'}token=${getToken()}`,
    headers: { 'X-Token': getToken() },
  }),
});
```

- 返回 `string`：只改写 URL（最简形式）；返回 `{ url, headers }`：改 URL 并加请求头；返回 `Promise` 也行（比如先向认证服务换新 token）。
- `kind` 标明请求类别：`'config'`（配置 scp）| `'tile'`（瓦片）| `'texblock'`（子图集）| `'creases'`（棱线缓存）| `'attributes'`（属性查询），可按类别走不同网关。
- 鉴权只作用于**发到网络上的请求**，不参与瓦片缓存键——token 轮换不会导致同一块瓦片重复加载；失败重试时每次重新过钩子，刷新后的 token 天然带上。
- 多数据集走不同网关时，给单个数据集传 `authenticate` 覆盖全局：`layer.addDataset({ id, configUrl, authenticate })`；属性查询同理（`attributes.authenticate`）。
- **不传 = 行为与旧版完全一致**，一个字节都不多发。

---

## 验证情况

- **解析正确性**：9 个官方样例（v1 / v2 / v3）全部 `bytesRead === bytesTotal`；并用官方 `S3ModelParser.js` 在 Node 里做逐段偏移对照。
- **MeshOpt 解码**：`bun run test:meshopt` 跑 60 个真实瓦片（5 个数据集 × 根瓦片 + 一级子瓦片），逐项校验偏移对齐、索引不越界、三角形索引数是 3 的倍数、法线归一化、顶点包围盒与 OBB 尺寸一致 —— 60/60 通过。
- **真实服务**：上海某区 iServer `realspace` 服务，S3M 3.01、`epsg:4326`、DXT 纹理压缩、5 个数据集叠加，20 个瓦片 / 45 万三角面稳定 85~90 fps。
- **拾取正确性**：以射线求交为真值，对 135 个像素采样，有效像素 96/96 一致（其余 39 个是两个数据集几何完全重合的平局）。

---

## 性能

| 项 | 数值 |
|---|---|
| 45 万三角面 / 20 瓦片 / 1440×900 | 85~90 fps |
| 拾取单次 | < 1 ms（与面数无关） |
| 棱线构建 | 8ms 一帧切片，20 网格约 1.9s 总计，不阻塞交互 |

调优建议见 [s3m-three API 文档#性能调优](./packages/s3m-three/docs/API.md#性能调优)。移动端与差设备另有几个可选刹车，**默认都不启用**（行为与旧版一致）：`lodPixelRatioCap`（LOD 判定屏幕高度的 DPR 上限，3x 屏上收益最大）、`maxTriangles`（按驻留面数淘汰）、`maxMemory`（按显存/内存字节预算主动淘汰）、`anisotropyCap`（各向异性上限）、`maxTextureSize`（纹理长边上限），见[移动端 / 差设备](./packages/s3m-three/docs/API.md#移动端--差设备)。

---

## 已知限制

- **实例化单体（`instanceMode` 16 / 17）**：白模常见（`pickInfo` 给的是 `instanceIds` 而不是 `batchId`）。目前支持正常网格渲染，单体样式操作（`setFeatureStyle` / 字段过滤 / 抬高）与 GPU 拾取暂不生效。
- **切线（TANGENT）顶点流不参与法线贴图**：材质没有法线贴图通道，所以此流只跳过不解码；带它的模型正常渲染不受影响。
- **骨骼动画未挂接驱动**：S3M 数据中的动画元信息与 JSON 已解析，但目前未接入逐帧骨骼驱动。
- **遮挡取决于「谁写了深度」而不是「开没开地形」**：地形网格与本层共用主 framebuffer 的同一深度缓冲、同一 `depthRangeFor3D`，所以山体能挡建筑；但 S3M 数据通常按海拔 0 建模，开地形时必须用 `setDatasetHeight()` 抬到真实地面高程，否则模型会陷在山体下面（另外地形网格的贴图来自 raster / hillshade 层，没有这两层时地形面是空白的）。不想接 DEM 时，可以用自带物理地表当遮挡源（`ground: { occlude: true }` 或 `setGroundOcclude()`），但它只能表达 `z = 高程` 的一刀切：没有起伏，山体那种「半山腰挡住后面楼」表达不了；两者叠加时，凡是地形已经写了更近深度的像素，平面代理写不进去，山后的建筑仍会露出来。
- **正交投影不覆盖 MapLibre 自己画的内容**：正交模式下底图瓦片、地形、DOM Marker / 弹窗仍是透视投影，和正交层差 ≈ 楼高 / 相机距（城市尺度几十到上百像素），App 需要自行把这些层退出，见[正交投影](#正交投影)。另外正交需要 MapLibre ≥ 5（要拿到独立的投影矩阵），v4 上会告警并保持透视。
- **多数据集跨城市叠加精度**：跨城市广域（数十公里以上）多个不同中心的数据集叠加受 WebGL 单精度 float32 深度与位置精度限制，建议同场景数据集位于同一城市量级内。

---

## 目录结构

monorepo（bun workspaces），两个发布包：

```
packages/
  s3m-three/      渲染内核（宿主无关，peer: three）
    src/
      core/      解析层（无 three 依赖，Node 可用）
        BinaryReader.ts      小端二进制读取
        S3MBParser.ts        S3MB 结构解析
        MeshOpt.ts           MeshOpt 几何压缩解码（量化还原 + 八面体法线）
        FeatureInfo.ts       单体属性反推
        AttributeQuery.ts    业务属性查询（iServer 数据服务，供按字段着色/过滤/抬高）
        DXTTextureDecode.ts  DXT 解码（来自 SuperMap/s3m-spec）
        TextureFormat.ts     纹理格式判定（compressType / pixelFormat → 解码路径）
        CRNDecode.ts         CRN → DXT 转码（crunch wasm，按需加载）
        types.ts             解析层共享类型
      tileset/    瓦片树 + LOD + 加载调度
      render/     three 渲染
        S3MViewer.ts         宿主无关场景查看器（多数据集 / 样式 / 拾取 / 选中）
        GeoAdapter.ts        地理坐标接口 + 墨卡托兜底
        DatasetManager.ts    多数据集生命周期与锚点对齐
        FeatureStyleManager.ts  单体颜色 / 拔高 / 平移 / 显隐
        GroundManager.ts     3D 物理地表与基坑开挖
        GeometryBuilder.ts   几何与材质组装
        StyleMaterial.ts     着色器注入的着色系统
        EdgeLines.ts         屏幕空间等宽棱线（选中描边 / 全局棱线）
        OrthoProjection.ts   正交投影：反推视图矩阵 + 正交视锥（纯数学，可单测）
        Picker.ts            GPU 拾取
        TextureFactory.ts    纹理解码
      vendor/     meshoptimizer / crunch 解码器（wasm 内联，原样保留）
  s3m-maplibre/   MapLibre / Mapbox 适配层（依赖 s3m-three）
    src/
      index.ts            包入口（再导出 s3m-three 全量符号，0.2.x 用法不破）
      S3MLayer.ts          薄图层：custom layer 生命周期 / render 矩阵提取 / 事件
      MapLibreGeoAdapter.ts WorldCoordinateHelper 提取 → GeoAdapter
demo/       在线演示产物（index.html 由 site/ 构建）+ 样例数据；three.html 仍是单文件版
site/       站点源码（vite + Solid SSG）：docs 正文由 markdown-it + shiki 构建期渲染，demo 面板为 Solid 组件
tools/      自检脚本（MeshOpt 回归、纹理/CRN 探针、带热更新的静态服务）
tests/      单元测试（bun test）：unit/ 纯逻辑与合成数据，e2e/ 需静态服务；types/ 类型级用法测试
docs/       API 文档站产物（`bun run build:docs` 生成，图层 + 内核双页面，勿手改）
```

`S3MViewer` 与 `S3MLayer` 的分界：前者不 import 任何地图 API，后者只做「宿主协议 ↔ 内核」的翻译（矩阵提取、事件、`triggerRepaint` 回调）。

---

## 许可

- 本项目 [Apache-2.0](./LICENSE)。
- `packages/s3m-three/src/core/DXTTextureDecode.ts` 来自 [SuperMap/s3m-spec](https://github.com/supermap/s3m-spec)（Apache-2.0）。
- `packages/s3m-three/src/vendor/crunch_decoder.module.js` 是 [crunch](https://github.com/BinomialLLC/crunch) 的 emscripten 构建（经 SuperMap SDK 转发，Apache-2.0）；改动三处：wasm 改为内联字节、Node ESM 下 `__dirname` 兜底、去掉 ESM 里的裸 `require("fs"/"path")` 与 `module["exports"]`（wasm 已内联所以那条读文件路径不会走，留着只会让打包器报 COMMONJS_VARIABLE_IN_ESM）。
- `packages/s3m-three/src/vendor/meshopt_decoder.module.js` 是 [meshoptimizer](https://github.com/zeux/meshoptimizer) 官方解码器（MIT，© Arseny Kapoulkine），未做修改。
- S3M 规范文本遵循 CC BY-ND 4.0，不得修改规范文本后再发布。
