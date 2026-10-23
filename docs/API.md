# API 参考

> 版本 0.1.0 · 对应 `s3m-maplibre` 的 `src/index.ts` 导出面

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [`S3MLayer`](#s3mlayer)
- [样式（S3MStyle）](#样式s3mstyle)
- [拾取与属性](#拾取与属性)
- [底层 API](#底层-api)
- [性能调优](#性能调优)
- [已知限制](#已知限制)

---

## 安装

```bash
npm install s3m-maplibre three
```

`three` 是 peer 依赖，需要宿主项目自己提供（要求 `>=0.168.0`，该版本起自带 TypeScript 类型）。

`maplibre-gl` **不是**本包的依赖：图层只是一个符合 `CustomLayerInterface` 的普通对象，你通过 `map.addLayer()` 挂上去即可。

### TypeScript

包内置类型声明（`dist/index.d.ts`），由 TS 源码直接编译产出，开箱可用。公开 API 会暴露 `THREE.Mesh` / `THREE.Group` 等对象，three `>=0.168` 自带类型；更老的版本需要 `@types/three`。

```ts
import { S3MLayer, STYLE, type S3MPickResult } from 's3m-maplibre';
```

### 宿主兼容

图层是 MapLibre / Mapbox 都能挂的普通对象，不依赖任何一方的类型：

- `render(gl, matrix)` 同时接受 `Float32Array(16)`（MapLibre v4）、`{ defaultProjectionData: { mainMatrix } }`（MapLibre v5）和 `modelViewProjectionMatrix`（Mapbox）。
- 只用到宿主的 `getCanvas / triggerRepaint / on / off / getBearing`，其余全部可选。

---

## 快速开始

```ts
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
  style: { mode: STYLE.WHITE, opacity: 0.9 },
  onPick: (f) => console.log(f?.smid, f?.height),
});

map.on('load', () => map.addLayer(layer));
```

---

## 核心概念

### 坐标链路

```
S3M 顶点（数据集局部 ENU，米）
  → 数据集 Group 偏移：把各数据集锚点对齐到「场景锚点」
  → L 矩阵：ENU → Web Mercator 归一化坐标
  → MapLibre 传入的 mercator→clip 矩阵
```

three 场景原点固定在**场景锚点**（第一个成功加载的数据集的位置），所有顶点只保留「相对锚点的米」。这是 3D Tiles `RTC_CENTER` 的同类做法，目的是避免 float32 在墨卡托大坐标下抖动。

多数据集叠加时，每个数据集一个 `THREE.Group`，用 `position` 承担锚点差。因此**所有数据集应当位于同一城市量级**（几公里内），跨城市叠加会重新引入精度问题。

### 锚点

锚点来自数据集配置的 `position`，但会做一致性校验：若 `position` 与 `geoBounds` 中心偏差超过 0.5°，判定为生产时的占位脏数据，回退到 `geoBounds` 中心。

### 瓦片与 LOD

配置里的 `tiles`（桌面导出）或 `rootTiles`（iServer，可多棵）是瓦片树入口。LOD 按规范里的 `RangeMode` 判定：

| rangeMode | 含义 | 判定 |
|---|---|---|
| 0 | `Distance_From_EyePoint` | 相机到包围球中心距离 < rangeValue 时细化 |
| 1 | `Pixel_Size_OnScreen` | 包围球投影像素半径 > rangeValue 时细化 |
| 2 | `Geometric_Error` | 按屏幕像素半径近似处理 |

### 单体化

S3M 瓦片里可能带 `pickInfo`：`SMID → batchId + 顶点区间`。解析时会把它展开成逐顶点的 `aBatchId` 属性，于是 GPU 可以按单体着色、按单体拾取。没有单体化信息的几何 `batchId = -1`，只能整块拾取。

---

## `S3MLayer`

MapLibre 自定义图层。`type === 'custom'`、`renderingMode === '3d'`。

### 构造函数

```ts
new S3MLayer(options?: S3MLayerOptions)
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | `string` | `'s3m'` | 图层 id |
| `configUrl` | `string` | — | 单数据集简写 |
| `datasets` | `S3MDatasetOptions[]` | `[]` | 多数据集叠加 |
| `style` | `Partial<S3MStyle>` | 见[样式](#样式s3mstyle) | 初始样式 |
| `pickable` | `boolean` | `true` | 是否响应点击 |
| `maxTiles` | `number` | `64` | 每个数据集最多驻留瓦片 |
| `maxConcurrent` | `number` | `4` | 每个数据集并发请求数 |
| `onStats` | `(s: S3MStats) => void` | — | 统计更新 |
| `onReady` | `(entry) => void` | — | 某个数据集就绪 |
| `onPick` | `(f: S3MPickResult \| null) => void` | — | 点击拾取结果 |
| `onError` | `(e: unknown) => void` | — | 瓦片加载 / 解析错误 |

`configUrl` 与 `datasets` 二选一；同时给时以 `datasets` 为准。

### 数据集管理

```ts
addDataset(ds: S3MDatasetOptions): Promise<S3MDatasetEntry>
removeDataset(id: string): void
setDatasetVisible(id: string, visible: boolean): void
```

```ts
interface S3MDatasetOptions {
  id: string;           // 唯一标识
  name?: string;        // 展示名
  configUrl: string;    // .scp 地址
  visible?: boolean;    // 默认 true
  maxTiles?: number;    // 覆盖图层级配置
}
```

`addDataset` 在图层 `onAdd` 之前调用会抛错（此时还没有 WebGL 上下文）。

### 样式

```ts
setStyle(patch?: Partial<S3MStyle>): void
getStyle(): S3MStyle & { modeLabel: string }
```

`setStyle` 是**合并**语义，只传要改的字段。除了 `shading`（编译期宏，需重编译着色器）之外，其余字段都是 uniform / 材质状态更新，热切换零成本。

### 棱线

```ts
setEdges(enabled: boolean): void
```

优先用**数据自带的棱线包**（`primitiveType === 13` 的索引包，本质是线段对）：解析时就建好 `LineSegments`，开关只是切 `visible`，成本为零，颜色跟随 `style.edgeColor`。

数据里没有棱线包时才用 `EdgesGeometry` 在 CPU 端现算。几十万面一次性建会卡住主线程（实测 20 个网格 1.9s），所以内部按 8ms 一帧切片执行，超过 12 万索引的几何直接跳过。

> 注意：棱线包**不能**当三角面画。把它当 `TRIANGLES` 提交，每条棱线都会被连成一根几十上百米的尖刺，整片模型变成放射状三角面。

### 拾取

```ts
pick(x: number, y: number): S3MPickResult | null
pickFromEvent(e): S3MPickResult | null
select(result: S3MPickResult | null, opts?: { silent?: boolean }): void
```

`pick` 的坐标是**相对 canvas 左上角的 CSS 像素**。`pickFromEvent` 接受 MapLibre 的 `MouseEvent` 或原生事件，自动换算。

拾取走 GPU：把「物体编号 + batchId」编码成 RGBA 渲染到离屏目标，再读那一个像素。代价与三角面数无关，且天然只命中最前面的可见面。

`select` 负责高亮与描边，传 `null` 清除选中。

### 其他

```ts
getBounds(): [[number, number], [number, number]] | null  // 合并经纬度范围
readonly stats: S3MStats
readonly fps: number
dispose(): void
```

```ts
interface S3MStats {
  tiles: number; loading: number; failed: number;
  meshes: number; vertices: number; triangles: number; datasets: number;
}
```

---

## 样式（S3MStyle）

```ts
interface S3MStyle {
  mode: S3MStyleMode;
  colorA: string;       // 白膜基色；顶/侧分色中的顶面色；高度渐变低端色
  colorB: string;       // 顶/侧分色中的侧立面色；高度/楼层渐变高端色
  colorC: string;       // 动态扫描色 / 复合渐变高端色
  selectColor: string;  // 选中单体高亮色
  floorHeight: number;  // 楼层估算层高，默认 3.2
  speed: number;        // 动态扫描速度倍率
  opacity: number;      // 0.05 ~ 1
  shading: 'flat' | 'smooth';
  dimOthers: boolean;   // 选中时压暗其他建筑
  outline: boolean;     // 选中单体描边
  edges: boolean;       // 全局棱线
  edgeColor: string;    // 棱线颜色
  edgeOpacity?: number; // 棱线透明度（0.1 ~ 1.0），默认 0.45，能显著消除 1px 细线的高对比度走样锯齿
  roofThreshold?: number; // 顶面法线判定阈值，默认 0.65
}
```

### 着色模式

| 常量 | 值 | 说明 |
|---|---|---|
| `STYLE.WHITE` | 0 | 白膜：忽略贴图与顶点色，纯色 + 光照 |
| `STYLE.TEXTURE` | 1 | 原色：贴图 × 顶点色 |
| `STYLE.SOLID` | 2 | 单色（`colorA`） |
| `STYLE.HEIGHT` | 3 | 按高度连续渐变（`colorA` → `colorB`） |
| `STYLE.FLOORS` | 4 | 按楼层离散分层，层高取 `floorHeight` |
| `STYLE.BATCH` | 5 | 按单体自动分配色相 |
| `STYLE.DYNAMIC` | 6 | 动态扫描：底色按高度渐变 + 扫描线自下而上循环 |
| `STYLE.TOP_SIDE` | 7 | 顶面/侧面分色：顶面（`colorA`）与立面/侧面（`colorB`）智能分色 |
| `STYLE.CUSTOM` | 8 | 自定义复合模式：顶面分色 + 侧立面高度渐变 |

所有模式都在同一个 `MeshStandardMaterial` 的片元着色器里用 `uMode` 分支实现，切换不重建几何、不重建材质。

### 关于 `shading`

**默认 `'flat'`（平面着色）**。原因：白模 / OSGB 转 S3M 的数据，法线多是共享顶点平均出来的，平滑插值会让墙面出现大片斑驳。平面着色在片元里用屏幕空间导数算法线，墙面干净得多。

倾斜摄影这类本身法线连续的模型，可以改成 `'smooth'`。

### 关于光照

主光与补光方向**每帧跟随地图 bearing 重算**（主光在镜头后上方偏左 150°、仰角 50°；补光偏右 215°、仰角 30°）。相当于一盏头灯，保证任意旋转角度下白模都是受光的，不会转到背光面就一片死灰。

如果你需要固定的物理太阳方向，可以自行替换 `layer` 内部的 `_keyLight` / `_fillLight`（非公开 API，升级可能变化）。

---

## 拾取与属性

```ts
interface S3MPickResult {
  datasetId: string;
  datasetName: string;
  objectId: number;      // 网格在图层内的编号
  batchId: number;       // 单体编号，-1 表示无单体化信息
  skeletonName: string;
  centerLngLat: [number, number] | null;
  mesh: THREE.Mesh | THREE.InstancedMesh;

  // 以下由几何实时计算
  smid: number | null;   // S3M 单体化信息里的 SMID
  height?: number;       // 米，单体包围盒 z 跨度
  baseElevation?: number;
  size?: [number, number];   // 外接盒 [宽, 深]
  bboxArea?: number;         // 外接盒底面积（㎡）
  floors?: number;           // 高度 / floorHeight
  triangles?: number;        // 本单体自身三角面数
  vertices?: number;
  bbox?: [[number, number, number], [number, number, number]];
}
```

> **注意**：`height` / `floors` / `bboxArea` 这些是**从几何算出来的**，不是业务属性表。OSGB 转 S3M 的数据通常不带属性表，`smid` 是与 iServer 侧数据对齐的唯一标识，业务字段需要你自己按 `smid` 去外部关联。

需要接业务属性时，用 `onPick` 拿到 `smid` 后自行查询：

```ts
new S3MLayer({
  onPick: async (f) => {
    if (!f?.smid) return;
    const info = await fetch(`/api/building/${f.smid}`).then((r) => r.json());
    showPanel({ ...f, ...info });
  },
});
```

---

## 底层 API

### `parseS3MB`

```ts
parseS3MB(buffer: ArrayBuffer, options?): Promise<S3MParsedTile>
```

纯解析，**不依赖 three**，可在 Node 里跑：

```ts
import { parseS3MB } from 's3m-maplibre/core';
import { inflateSync } from 'node:zlib';

const tile = await parseS3MB(buf, { inflate: inflateSync });
console.log(tile.version, Object.keys(tile.geoPackage));
```

解析结果可用 `bytesRead === bytesTotal` 自检——不等说明偏移算错了。

### MeshOpt 压缩几何

v3 瓦片默认用 MeshOpt 压几何。解析器内部按需 `import` 内联的 meshoptimizer wasm 解码器（约 22KB），只有真的遇到 MeshOpt 瓦片才会加载，v1/v2 与未压缩的 v3 不受影响。

解码后的顶点属性已经还原成 float，下游无感知：

```
position = minVerticesValue + uint16 * vertCompressConstant
texcoord = minTexCoordValue[i] + uint16 * texCoordCompressConstant[i]
normal   = octDecode(int16 / 32767)
```

回归校验（60 个真实瓦片，校验偏移、索引范围、法线归一化、包围盒与 OBB 尺寸）：

```bash
npm run test:meshopt
```

需要 WebAssembly；不支持 wasm 的环境会在遇到 MeshOpt 瓦片时抛明确错误。

### `S3MTileset`

单个数据集的瓦片树。不依赖 three，可以用注入的 `buildTile` 在 Node 里跑通完整链路（URL 解析 → 解析 → LOD 调度），适合做数据体检。

```ts
const ts = new S3MTileset({ configUrl, buildTile: async () => ({ group: null, stats: {} }) });
await ts.init();
ts.update([0, 0, 500], 0.64, 900); // 相机在局部 ENU 的位置
```

### 单体属性工具

```ts
resolveFeature(geo, batchId)   // → { smid, segments }
measureSegments(geometry, segments)  // → 包围盒 + 单体三角面数
buildAttributes({ smid, box, triangles, floorHeight })  // → S3MFeatureAttributes
```

---

## 性能调优

| 手段 | 说明 |
|---|---|
| `maxTiles` | 每个数据集驻留瓦片上限，默认 64。叠加 5 个数据集时建议 40~48 |
| `maxConcurrent` | 每数据集并发，默认 4。公开服务建议 2~3 |
| 关闭 `edges` | 棱线是 CPU 端构建 + 每网格一个 drawcall，大场景慎用 |
| `shading: 'flat'` | 与 `'smooth'` 性能相当，但视觉更干净 |
| 不透明度 < 1 | 会开启混合并关闭深度写入，overdraw 明显上升，仅用于演示 |

实测（上海某区，5 数据集叠加，45 万三角面，1440×900）：**85~90 fps**。

---

## 已知限制

- **Draco 压缩几何**未实现，遇到会抛明确错误。MeshOpt 已支持。
- **KTX2 / CRN / ETC** 纹理未实现；DXT1/3/5 与 WebP 可用。
- **骨骼动画**解析了但未驱动。
- **地形遮挡**未实现：MapLibre 的地形深度没有写进 custom layer 的深度缓冲，建筑不会被地形裁掉。
- 跨城市量级的数据集叠加会有 float32 精度问题。

---

## 数据与许可

- 本库代码 Apache-2.0。
- `src/core/DXTTextureDecode.ts` 来自 [SuperMap/s3m-spec](https://github.com/supermap/s3m-spec)（Apache-2.0）。
- `src/vendor/meshopt_decoder.module.js` 是 [meshoptimizer](https://github.com/zeux/meshoptimizer) 官方解码器（MIT，© Arseny Kapoulkine），未做修改。
- S3M 规范文本遵循 CC BY-ND 4.0，不得修改规范文本后再发布。
