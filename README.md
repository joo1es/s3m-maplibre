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
| S3MB 解析 | ✅ | v1.0 / v2.0 / v3.0，9 个官方样例字节级对齐 |
| MeshOpt 几何压缩 | ✅ | v3 默认压缩方式，浏览器内 wasm 解码，按需加载 |
| LOD 渐进加载 | ✅ | 支持 `Distance_From_EyePoint` / `Pixel_Size_OnScreen` |
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
| 瓦片同材质合批 | ✅ | 倾斜摄影大瓦片自动合批，大幅降低 DrawCall |
| 纹理变换与寻址 | ✅ | 支持 `texmodmatrix` 仿射变换与 `addressmode` |
| DXT / WebP 纹理 | ✅ | |
| 骨骼动画 | ❌ | 未实现：LODPackage 上的 animations JSON 直接跳过不解析，官方 JS SDK 同样只读偏移不驱动 |
| 地形遮挡 | ✅ | 与 MapLibre terrain 共用同一深度缓冲，山体可遮挡建筑；需宿主开启 `setTerrain` 并提供 DEM 源 |
| Draco 压缩几何 | ❌ | 能识别、不能解码，遇到抛明确错误；接法见[未支持的格式](#未支持的格式draco--crn--ktx2) |
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

`three` 是 peer 依赖（`>=0.168.0`）。`maplibre-gl` 不是依赖——图层只是一个符合 `CustomLayerInterface` 的普通对象，MapLibre / Mapbox 都能挂；不用地图时直接用 `s3m-three` 的 `S3MViewer`（见「纯 three.js 使用」）。

类型随包发布（各包 `dist/index.d.ts`，由源码直接生成）。three `>=0.168` 自带类型，更老的版本需要自己装 `@types/three`。

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
npm run dev    # 开发：编一次 packages → tsc -w + vite dev（一个端口同时出文档和 demo）
npm run serve  # 只服务已构建的产物（http://localhost:8123/s3m-maplibre/demo/index.html）
npm run demo   # 全量构建后起静态服务
npm run build  # 只产出，不起服务
```

`npm run dev` 起来后：

| 地址 | 内容 |
|---|---|
| <http://localhost:5173/> | s3m-maplibre 文档（改 `packages/*/docs/API.md` 保存即刷新） |
| <http://localhost:5173/three.html> | s3m-three 内核文档 |
| <http://localhost:5173/demo/> | demo（和线上 `demo/index.html` 同路径，相对资源不用改） |

改 `packages/*/src/**/*.ts` 由 `tsc -w` 增量编译，vite 直接读到新产物；改 `site/` 下的组件走 HMR。

`npm run build` 会按 `s3m-three → s3m-maplibre → docs → demo` 的顺序全部产出，其中 docs/ 与 demo/index.html 都由 `site/` 构建（共用一份 `site/vite.config.ts`，只是入口和输出目录不同；产物位置不变，URL 不变）。

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

## 未支持的格式：Draco / KTX2

这三个常被问到，结论分别不同：

**Draco 压缩几何 —— 能解决，缺的是样本。**
官方 SDK 里有 `S3MParser/S3MDracoDecode.js` + `draco_decode.module.js`（对 `DecodeBufferToPointCloud` 的封装，POSITION / NORMAL / TEX_COORD 三个属性，再按 `compressOptions` 分支处理）。接法与本项目的 MeshOpt 完全一致：内联 wasm 解码器、只在遇到 `VertexTag.DRACO` 时动态 `import`、解码后走同一套 attribute 组装 + 量化还原。真正的成本不在写代码，而在**标定容器**——MeshOpt 当时就是靠 60 个真实瓦片逐字节对齐才做对的，Draco 的 attribute 映射、`compressOptions` 与实际数据是否一致也必须拿样例验。仓库里没有 Draco 瓦片，所以现在是「识别到就抛明确错误」。

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
npm run probe:crn -- --crn https://host/iserver/services/svc/rest/realspace/datas/<数据集>/config --limit 3
# 也可以先摸底：--service <realspace 根地址> 列出每个数据集的 s3m:TextureCompressionType
```

探针会对每张 CRN 纹理报告「尺寸是否与纹理头一致 / 解出的色数 / 邻域粗糙度」，并打一张 ASCII 灰度预览，用来判断熵解码是否真的解对了（解错会是一屏噪声）。已跑过的数据：`3D-BianDianZhan3`（512²，v3.00）、`3D-BIMTreeModel` / `3D-local3DCache-SubwayStationCombined`（32² / 64²，v3.01）、`3D-scyx`（1024²），除「数据本身标错」外全部尺寸吻合、预览有真实结构。

**KTX2 —— 不是「不支持」，是 S3M 里基本不会出现。**
官方 `S3MPixelFormat` 枚举（`1/2/3/4/5/6/7/10/11/12/13/14/17…21/25/26/27/28`）里没有 KTX2 / Basis 的条目，iServer 也不会发。真要支持，得自己引入 `basis_transcoder.wasm` 并把 KTX2 容器转成 RGBA32 或 DXT，但那是给「别人转成 KTX2 再塞进 S3M」的场景准备的，没有数据样本可测。

共同前提：**要有样例数据**。手头有 Draco 压缩的瓦片，把 `.s3mb` 给我，就能按 MeshOpt 那套方式标定 + 实现 + 回归（CRN 的代码已经接好，只差真样本验一遍熵解码）。

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

---

## 验证情况

- **解析正确性**：9 个官方样例（v1 / v2 / v3）全部 `bytesRead === bytesTotal`；并用官方 `S3ModelParser.js` 在 Node 里做逐段偏移对照。
- **MeshOpt 解码**：`npm run test:meshopt` 跑 60 个真实瓦片（5 个数据集 × 根瓦片 + 一级子瓦片），逐项校验偏移对齐、索引不越界、三角形索引数是 3 的倍数、法线归一化、顶点包围盒与 OBB 尺寸一致 —— 60/60 通过。
- **真实服务**：上海某区 iServer `realspace` 服务，S3M 3.01、`epsg:4326`、DXT 纹理压缩、5 个数据集叠加，20 个瓦片 / 45 万三角面稳定 85~90 fps。
- **拾取正确性**：以射线求交为真值，对 135 个像素采样，有效像素 96/96 一致（其余 39 个是两个数据集几何完全重合的平局）。

---

## 性能

| 项 | 数值 |
|---|---|
| 45 万三角面 / 20 瓦片 / 1440×900 | 85~90 fps |
| 拾取单次 | < 1 ms（与面数无关） |
| 棱线构建 | 8ms 一帧切片，20 网格约 1.9s 总计，不阻塞交互 |

调优建议见 [s3m-three API 文档#性能调优](./packages/s3m-three/docs/API.md#性能调优)。

---

## 已知限制

- **Draco 压缩几何**未实现（可解，缺样例数据），见[未支持的格式](#未支持的格式draco--ktx2)。
- **纹理分包（`s3m:TextureSharing`）未支持**：这类数据集的 `tiles` 全是 `.s3mblock`（纹理块文件），不是 `.s3mb` 瓦片，加载会直接失败，例如 SuperMap Online 的 `3D-CBD/Xiaopin@CBD`。目前会如实报错，不做静默降级。
- **多块 MeshOpt 骨架尚未对齐**：`3D-WorkSpace_pbr1/pbrmodel` 里有根瓦片是 `blockCount=2`，第二块的头按现有布局读会错位。单个属性流尺寸会先拦一道、给出可定位的报错，不会抛「Invalid typed array length」。
- **地形遮挡需要宿主把模型贴到真实地面高程**：深度测试本身是通的（地形网格与本层共用主 framebuffer 的同一深度缓冲、同一 `depthRangeFor3D`），但 S3M 数据通常按海拔 0 建模，必须用 `setDatasetHeight()` 抬到真实地面高程，否则模型会陷在地形下面。另外地形网格的贴图来自 raster / hillshade 层，没有这两层时地形面是空白的。
- 跨城市量级的数据集叠加会重新引入 float32 精度问题。
- 卸载只做了「超上限淘汰」：`maxTiles` 满了会淘汰最久没用的瓦片，但没有做预算式（按显存占用）的主动回收。
- **切线（TANGENT）顶点流不参与渲染**：没有法线贴图通道，所以这条流只跳过不解码；但带它的数据（PBR 一类）不会因此失败。
- **正交投影不覆盖 MapLibre 自己画的内容**：正交模式下底图瓦片、地形、DOM Marker / 弹窗仍是透视投影，和正交层差 ≈ 楼高 / 相机距（城市尺度几十到上百像素），App 需要自行把这些层退出，见[正交投影](#正交投影)。另外正交需要 MapLibre ≥ 5（要拿到独立的投影矩阵），v4 上会告警并保持透视。

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
tools/      自检脚本（解析校验、MeshOpt 回归、纹理/CRN 探针、带热更新的静态服务）
tests/      类型级用法测试（tests/types/usage.ts）
docs/       API 文档站产物（`npm run build:docs` 生成，图层 + 内核双页面，勿手改）
```

`S3MViewer` 与 `S3MLayer` 的分界：前者不 import 任何地图 API，后者只做「宿主协议 ↔ 内核」的翻译（矩阵提取、事件、`triggerRepaint` 回调）。

---

## 许可

- 本项目 [Apache-2.0](./LICENSE)。
- `packages/s3m-three/src/core/DXTTextureDecode.ts` 来自 [SuperMap/s3m-spec](https://github.com/supermap/s3m-spec)（Apache-2.0）。
- `packages/s3m-three/src/vendor/crunch_decoder.module.js` 是 [crunch](https://github.com/BinomialLLC/crunch) 的 emscripten 构建（经 SuperMap SDK 转发，Apache-2.0）；只改了两处：wasm 改为内联字节、Node ESM 下 `__dirname` 兜底。
- `packages/s3m-three/src/vendor/meshopt_decoder.module.js` 是 [meshoptimizer](https://github.com/zeux/meshoptimizer) 官方解码器（MIT，© Arseny Kapoulkine），未做修改。
- S3M 规范文本遵循 CC BY-ND 4.0，不得修改规范文本后再发布。
