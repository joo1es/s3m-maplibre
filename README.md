# s3m-maplibre

**在 MapLibre GL JS 里原生渲染 SuperMap S3M 三维模型** —— 浏览器直接解析 `.s3mb` 瓦片，不需要预先转成 3D Tiles，也不需要 SuperMap 的 WebGL 客户端。

[![npm](https://img.shields.io/npm/v/s3m-maplibre?color=blue&label=npm)](https://www.npmjs.com/package/s3m-maplibre)
[![demo](https://img.shields.io/badge/demo-online-2ea44f)](https://joo1es.github.io/s3m-maplibre/demo/index.html)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](./LICENSE)
[![types](https://img.shields.io/badge/types-included-blue)](./src/index.ts)

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
| 动态扫描 | ✅ | 扫描线沿高度循环 |
| 透明度 | ✅ | 实时，不重编译着色器 |
| 选中高亮 + 描边 | ✅ | 单体级 |
| 全局棱线 | ✅ | 优先用数据自带棱线包，没有才 CPU 现算 |
| 单体级点选 + 属性 | ✅ | GPU 拾取，代价与面数无关 |
| 实例化几何 | ✅ | `instanceMode` 16 / 17 |
| 瓦片同材质合批 | ✅ | 倾斜摄影大瓦片自动合批，大幅降低 DrawCall |
| 纹理变换与寻址 | ✅ | 支持 `texmodmatrix` 仿射变换与 `addressmode` |
| DXT / WebP 纹理 | ✅ | |
| 骨骼动画 | ❌ | 已解析未驱动 |
| 地形遮挡 | ❌ | |
| Draco 压缩几何 | ❌ | 能识别、不能解码，遇到抛明确错误；接法见[未支持的格式](#未支持的格式draco--crn--ktx2) |
| CRN 纹理（pixelFormat 26 / 27） | ❌ | 官方 SDK 是 crunch.js 转 DXT5 再解码，接口位置已留好 |
| KTX2 纹理 | — | S3M 官方 `pixelFormat` 枚举里没有这个值，属于「不会遇到」而不是「不支持」 |

---

## 安装

```bash
npm install s3m-maplibre three
```

包在 npm 上是 [s3m-maplibre](https://www.npmjs.com/package/s3m-maplibre)，当前 `0.2.4`。

`three` 是 peer 依赖（`>=0.168.0`）。`maplibre-gl` 不是依赖——图层只是一个符合 `CustomLayerInterface` 的普通对象，MapLibre / Mapbox 都能挂；不用地图时也能只用解析和瓦片层（见「纯 three.js 使用」）。

类型随包发布（`dist/index.d.ts`，由源码直接生成）。three `>=0.168` 自带类型，更老的版本需要自己装 `@types/three`。

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

完整接口见 **[docs/API.md](./docs/API.md)**。

---

## 演示

在线跑（GitHub Pages，数据随仓库一起发布）：

- **MapLibre 版** — <https://joo1es.github.io/s3m-maplibre/demo/index.html>
- **纯 three.js 版** — <https://joo1es.github.io/s3m-maplibre/demo/three.html>

（<https://joo1es.github.io/s3m-maplibre/> 是入口页，两个示例都能进）

本地跑：

```bash
npm run dev      # 开发模式：tsc -w + 静态服务，保存源码后浏览器自动刷新
npm run demo     # 一次性编译后起静态服务（不做监听）
```

两个命令都指向 http://localhost:8123/s3m-maplibre/demo/index.html ，`demo/three.html` 是同一台服务器上的纯 three 版。

演示自带两份样例数据（北京 CBD 的 CCTV、comModel），也可以在地址栏输入框里填任意 iServer `realspace` 服务根地址、`datas` 集合或具体的 `.scp`，自动列出数据集并默认勾选第一个。

演示包含：数据集叠加开关、着色模式、透明度、平面/平滑着色、选中描边（棱线 / 外扩两种画法，粗细可调）、全局棱线、点击属性卡。

---

## 纯 three.js 使用（不用 MapLibre）

可以。图层本身只是把三层粘到地图上，这三层都是宿主无关的：

| 层 | 需要什么 | 与地图的关系 |
|---|---|---|
| `core/` 解析 | 一个 `ArrayBuffer` | 完全无关，Node 里也能跑 |
| `tileset/` 瓦片树 | `fetch` + 一个 `three.Group` 当容器 | 只要喂相机位置算 LOD |
| `render/` 几何 | WebGL 上下文 | 只产出 `THREE.Group` / `Mesh` |

```js
import * as THREE from 'three';
import { S3MTileset, createSharedUniforms, STYLE } from 's3m-maplibre';

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

自己搭宿主时需要补的几件事，`S3MLayer` 不会代劳：

- **光照**：`MeshStandardMaterial` 的标准光照，自己加 `HemisphereLight` + `DirectionalLight`；
- **多数据集对齐**：每份数据有各自的锚点，`S3MLayer` 会按墨卡托算锚点差、写进数据集 `Group.position`（米），纯 three 里需要自己算一次；
- **贴地 / 经纬度**：不接地图就没有「贴在地球上」这一步，只有局部米制坐标；
- **拾取 / 选中描边 / 样式切换 UI**：`Picker`、等宽棱线、`setStyle` 都是 `S3MLayer` 上的，纯 three 用法需要直接操作 `uniforms` 与 Mesh。

---

## 未支持的格式：Draco / CRN / KTX2

这三个常被问到，结论分别不同：

**Draco 压缩几何 —— 能解决，缺的是样本。**
官方 SDK 里有 `S3MParser/S3MDracoDecode.js` + `draco_decode.module.js`（对 `DecodeBufferToPointCloud` 的封装，POSITION / NORMAL / TEX_COORD 三个属性，再按 `compressOptions` 分支处理）。接法与本项目的 MeshOpt 完全一致：内联 wasm 解码器、只在遇到 `VertexTag.DRACO` 时动态 `import`、解码后走同一套 attribute 组装 + 量化还原。真正的成本不在写代码，而在**标定容器**——MeshOpt 当时就是靠 60 个真实瓦片逐字节对齐才做对的，Draco 的 attribute 映射、`compressOptions` 与实际数据是否一致也必须拿样例验。仓库里没有 Draco 瓦片，所以现在是「识别到就抛明确错误」。

**CRN 纹理（`pixelFormat` 26 / 27）—— 能解决，纯接解码器。**
SuperMap 自己的做法是 `crunch.js` 把 CRN 转码成 DXT5 字节，再走普通 DXT 上传。本项目的 `TextureFactory` 在 DXT 那条路上已经完整（DXT1/3/4/5 都解到 RGBA8），所以只要在 `decodeTexture` 里加一个 CRN 分支：crunch 转 DXT5 → 复用现成解码。工作量约一个解码器文件 + 一个分支，同样需要一份 CRN 纹理样例来验字节。

**KTX2 —— 不是「不支持」，是 S3M 里基本不会出现。**
官方 `S3MPixelFormat` 枚举（`1/2/3/4/5/6/7/10/11/12/13/14/17…21/25/26/27/28`）里没有 KTX2 / Basis 的条目，iServer 也不会发。真要支持，得自己引入 `basis_transcoder.wasm` 并把 KTX2 容器转成 RGBA32 或 DXT，但那是给「别人转成 KTX2 再塞进 S3M」的场景准备的，没有数据样本可测。

两者的共同前提：**要有样例数据**。手头有 Draco 压缩的瓦片或带 CRN 纹理的服务地址，把 `.s3mb` 或服务地址给我，就能按 MeshOpt 那套方式标定 + 实现 + 回归。

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

调优建议见 [docs/API.md#性能调优](./docs/API.md#性能调优)。

---

## 已知限制

- **Draco 压缩几何 / CRN 纹理**未实现（可解，缺样例数据），见[未支持的格式](#未支持的格式draco--crn--ktx2)。
- **地形遮挡**未实现：MapLibre 的地形深度没进 custom layer 的深度缓冲，建筑不会被地形裁掉。
- 跨城市量级的数据集叠加会重新引入 float32 精度问题。
- MVT 式的「按需懒加载 + 卸载」没有做：已加载的瓦片常驻，只受 `maxTiles` 限制。

---

## 目录结构

```
src/
  core/      解析层（无 three 依赖，Node 可用）
    BinaryReader.ts      小端二进制读取
    S3MBParser.ts        S3MB 结构解析
    MeshOpt.ts           MeshOpt 几何压缩解码（量化还原 + 八面体法线）
    FeatureInfo.ts       单体属性反推
    DXTTextureDecode.ts  DXT 解码（来自 SuperMap/s3m-spec）
  tileset/   瓦片树 + LOD + 加载调度
  render/    three 渲染
    S3MLayer.ts          图层主体（多数据集 / 样式 / 拾取）
    GeometryBuilder.ts   几何与材质组装
    StyleMaterial.ts     着色器注入的着色系统
    EdgeLines.ts         屏幕空间等宽棱线（选中描边 / 全局棱线）
    Picker.ts            GPU 拾取
    TextureFactory.ts    纹理解码
  vendor/    meshoptimizer 解码器（wasm 内联，原样保留）
demo/
  index.html / main.js   MapLibre 完整示例（控制面板 + 属性卡）
  three.html / three.js  纯 three.js 示例（无地图）
tools/       自检脚本（解析校验、MeshOpt 回归、带热更新的静态服务）
```

---

## 许可

- 本项目 [Apache-2.0](./LICENSE)。
- `src/core/DXTTextureDecode.ts` 来自 [SuperMap/s3m-spec](https://github.com/supermap/s3m-spec)（Apache-2.0）。
- `src/vendor/meshopt_decoder.module.js` 是 [meshoptimizer](https://github.com/zeux/meshoptimizer) 官方解码器（MIT，© Arseny Kapoulkine），未做修改。
- S3M 规范文本遵循 CC BY-ND 4.0，不得修改规范文本后再发布。
