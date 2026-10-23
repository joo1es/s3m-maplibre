# API 参考

> 对应 `s3m-maplibre` 的 `src/index.ts` 导出面

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [`S3MLayer`](#s3mlayer)
- [样式（S3MStyle）](#样式s3mstyle)
- [拾取与属性](#拾取与属性)
- [投影](#投影)
- [按业务字段着色](#按业务字段着色)
- [纯 three.js 使用](#纯-threejs-使用)
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

#### batch 粒度：多个 SMID 共用一个 batch

单体化的分辨率只到 **batch**，不是 SMID。实测有数据会把若干相邻铺面合并成一个 batch（白模里甚至 81 个 mesh 共用一个材质码），于是「给 3 号楼单独上色」这件事在几何层面就不成立。

内部规则（确定性的，不再「最后写的说了算」）：

- **任一 SMID 需要隐藏 → 整批隐藏**；
- **颜色 / 抬高取 SMID 最小的那一个**；
- 真的发生时只 `console.warn` 一次，不会每次重写纹理都刷屏。

先摸清数据能细到什么程度：

```ts
const audit = layer.auditBatches();
// { smids, batches, conflicts: [{ datasetId, batchId, smids }], conflictingSmids }
```

`conflicts` 为空说明这批数据可以放心按单体操作；不为空时，这些单体对应「按 batch 罩层」之类的做法，靠本库的单体化通道做不到。

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
| `maxTiles` | `number` | `64` | 每个数据集驻留瓦片上限，超了淘汰最久没用的（不是停止加载） |
| `maxConcurrent` | `number` | `4` | 每个数据集并发请求数 |
| `projection` | `'perspective' \| 'orthographic'` | `'perspective'` | 投影模式，见[投影](#投影) |
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

棱线本身画成**屏幕空间等宽线**（`src/render/EdgeLines.ts`）：WebGL 的 `lineWidth` 在绝大多数平台被忽略、恒定 1px，只有把每条棱摊成面向屏幕的四边形才能真的调粗细。因此：

- `edgeWidth`（像素）控全局棱线粗细，缩放时线宽恒定；
- 选中单体的描边默认也走同一套画法（`outlineStyle: 'edges'`），只挑这个单体自己的三角面算折边，`outlineWidthPx` 控粗细；
- 数据自带的棱线包是原始线段，仍是 1px，只受颜色 / 透明度控制。

> 注意：棱线包**不能**当三角面画。把它当 `TRIANGLES` 提交，每条棱线都会被连成一根几十上百米的尖刺，整片模型变成放射状三角面。

### 拾取与空间查询

```ts
pick(x: number, y: number): S3MPickResult | null
pickFromEvent(e): S3MPickResult | null
pickPosition(x: number, y: number): { lngLat: [number, number]; altitude: number; point: [number, number, number] } | null
drillPick(x: number, y: number, limit?: number): S3MPickResult[]
select(result: S3MPickResult | null, opts?: { silent?: boolean }): void
getFeatureBounds(smid: number): [[number, number], [number, number]] | null
flyToFeature(smid: number, options?: Record<string, unknown>): boolean
```

`pick` 的坐标是**相对 canvas 左上角的 CSS 像素**。`pickFromEvent` 接受 MapLibre 的 `MouseEvent` 或原生事件，自动换算。返回值包含单体属性、中心经纬度、以及精确交点世界坐标（`point: [x,y,z]`, `lngLat: [lng,lat]`, `altitude: number`）。

- `pickPosition(x, y)`：拾取指定屏幕像素对应的精确三维世界坐标。优先对命中的建筑网格精确表面求交；未命中建筑时与地表面（z=0）求交。
- `drillPick(x, y, limit?)`：视线穿透拾取，沿射线命中所有单体，按由近至远距离排序返回。
- `getFeatureBounds(smid)`：获取指定 SMID 单体的经纬度包围盒 `[[minLng, minLat], [maxLng, maxLat]]`（自动叠加单体平移/拔高）。
- `flyToFeature(smid, options?)`：聚焦飞向单体，内部自动调用宿主地图的 `map.fitBounds`。

拾取走 GPU：把「物体编号 + batchId」编码成 RGBA 渲染到离屏目标，再读那一个像素。代价与三角面数无关，且天然只命中最前面的可见面。

离屏目标只有 **1×1**：viewport 尺寸仍是整块画布、原点平移到 `(-px, -(h-1-py))`，于是整幅画面按原样光栅化，只有点击点那一格落在目标上。着色器、矩阵、深度测试全都不变，但每点一次不再渲染一整屏（移动端收益最明显）。

`select` 负责高亮与描边，传 `null` 清除选中。

### 其他

```ts
getBounds(): [[number, number], [number, number]] | null  // 合并经纬度范围
setProjection(mode: 'perspective' | 'orthographic'): void  // 投影模式，见[投影](#投影)
setLodRangeScale(scale: number, datasetId?: string): void  // 缩放 LOD 切换距离阈值（>1 更倾向粗模，<1 提前细化）
readonly lodRangeScale: number
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
  outlineStyle?: 'edges' | 'hull'; // 描边画法：'edges' 单体棱线（默认）| 'hull' 背面外扩轮廓
  outlineColor?: string;  // 描边颜色，默认跟随 selectColor
  outlineWidthPx?: number; // 选中棱线粗细（像素，默认 3），仅 outlineStyle: 'edges'
  outlineWidth?: number;   // 外扩轮廓粗细（米，默认 0.9），仅 outlineStyle: 'hull'
  edges: boolean;       // 全局棱线
  edgeColor: string;    // 棱线颜色
  edgeWidth?: number;   // 全局棱线粗细（像素，默认 1.2）
  edgeOpacity?: number; // 棱线透明度（0.1 ~ 1.0），默认 0.45
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

### 关于「按单体」配色

`STYLE.BATCH` 的色相是对 `batchId` 做哈希（`s3mHash`）得到的。这里有个很容易踩的坑：**`batchId` 在着色器里是 varying**。GPU 逐像素做透视校正插值时，即使一个三角形三个顶点的 `aBatchId` 完全相等，三次乘加的舍入误差也不会正好抵消，结果会带 `1e-7` 量级的相对误差，而且逐像素不同（不同 GPU / 驱动还不一样）。

这个误差本身无害，但哈希是混沌放大器：`fract(p*0.1031)` → `p*(p+33.33)` → `p*2p`，每级放大几十倍。实测 `batchId≈4.2 万` 时，`1e-7` 的抖动就能把哈希输出从单一值扩散到 `0.20~0.78` 整个区间 —— 表现就是**整屏彩色噪点**，而且只在部分机器上出现。

所以凡是「按 id 取值」的地方都先取整（`s3mBatchId()` = `floor(vBatchId + 0.5)`）：按单体配色、单体状态纹理（隐藏 / 独立改色）采样、选中判定统一走它。同一个单体在所有像素上得到完全相同的颜色，跨 GPU 一致。

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

## 投影

```ts
new S3MLayer({ projection: 'orthographic' })   // 构造时指定
layer.setProjection('orthographic' | 'perspective')  // 运行时切换，下一帧生效
layer.projection  // 当前模式
```

MapLibre 没有正交相机，custom layer 每帧拿到的是透视 MVP。但 MapLibre ≥ 5 的 `render()` 入参会把 `projectionMatrix`（view→clip）和 `modelViewProjectionMatrix`（world→clip）分开给，视图矩阵可以精确解出来：

```
V = P⁻¹ × MVP
正交 MVP = P_ortho · V ，P_ortho 半高 = 相机距 × tan(fov/2)
```

半高取「目标深度处透视视锥的半高」，于是正交与透视在目标平面上逐点重合；zoom 改的是相机距离，距离减半 = 半高减半 = 放大一倍，pan / pitch / rotate 与透视手感一致。拾取、选中描边、按单体着色 / 隐藏 / 抬高都读同一个相机，自动跟随，不需要额外适配。

**边界**：

- 正交只覆盖本层。底图瓦片、地形、DOM Marker / 弹窗仍走 MapLibre 的透视投影，和正交层差 ≈ 楼高 / 相机距（城市尺度几十到上百像素，俯视时屋顶线就能差出 ~90px）。要用正交，App 需自行把这些层退出。
- 需要 MapLibre ≥ 5（要拿到独立的投影矩阵）。v4 只给合并矩阵，会 `console.warn` 一次并保持透视，不会静默画错。
- 解出的视图矩阵会做刚体校验（3×3 正交、底行 `[0,0,0,1]`）；校验不过说明两个输入矩阵不同源，同样退回透视并告警。

底层数学在 `src/render/OrthoProjection.ts`，`npm test` 里的 `tools/test-ortho.mjs` 用合成矩阵钉住：视图矩阵还原、目标平面重合、正交语义、zoom 映射、near/far 深度映射、三类非法输入拒绝。

---

## 按业务字段着色

S3M 瓦片里**只有单体 ID**（SMID）和顶点区间，没有任何业务字段；业务属性在 iServer 的**数据服务**里（`data-xxx/rest/data`），和三维服务（`3D-xxx/rest/realspace`）是两个服务。所以按字段着色是「三维 + 数据」的跨服务查询，需要单独配一个数据源。

```ts
const layer = new S3MLayer({
  datasets: [{ id: 'jingmo', configUrl: '.../jingmo.scp' }],
  attributes: {
    dataServiceUrl: 'https://host/iserver/services/data-xxx/rest/data',
    datasetName: 'DataSource:zhoubian',   // 数据源:数据集，只写数据集名时默认补 DataSource:
    // idField 默认 SmID，对应 scp 里的 idFieldName
  },
});

// 分类字段：同一取值同色
const result = await layer.colorByField({ field: 'KEYID', type: 'category' });

// 数值字段：连续色带 / 按阈值分级
await layer.colorByField({ field: 'SmMaxZ', type: 'ramp' });
await layer.colorByField({ field: 'SmMaxZ', type: 'breaks', breaks: [10, 30, 60] });

result.legend;    // [{ label, color, count }]  直接拿去画图例
result.matched;   // 真正上了色的单体数
```

几个要点：

- **默认范围是「当前已加载的单体」**（`getLoadedSmids()`），不是整个数据集。实测每条要素的响应约 5KB（模型数据集每条都挂着 `geometry.model`，见下面的「为什么这么重」），全量几千栋会变成几十 MB，所以只查加载进来的那部分，按 200 个一批分片；
- 查询结果按 SMID 缓存**整行**（`AttributeQuery`），换字段只是重算颜色、重写一张一维纹理，不重建几何、不重编译着色器，也不再发一次请求；
- 手动 `setFeatureStyle()` 的颜色优先级高于专题色；
- `transform` 用来归并取值：`KEYID` / `ENTITYID` 这种基本一栋一个值的字段直接上分类色，着出来就是「随机色」，要么改用 `ramp` / `breaks`，要么用 `transform` 把编码截到能分组的层级，比如 `(v) => v.slice(0, 6)`;
- `breaks` 不给就用色带档数等分；`colors` 不给就用内置 12 色板。

不想接数据服务时，也可以：

```ts
// 自己算好颜色（比如按几何派生量：高度 / 面积 / 楼层）
layer.setThematicColors(new Map([[423, '#ef4444'], [424, '#22c55e']]));
layer.clearThematic();
```

`AttributeQuery` 也能单独用（不依赖图层）：

```ts
import { AttributeQuery } from 's3m-maplibre';

const query = new AttributeQuery({ dataServiceUrl, datasetName: 'DataSource:zhoubian' });
const schema = await query.loadSchema();          // [{ name: 'SmID' }, ...]，也能用来判断有没有属性表
const rows = await query.queryBySmids([423, 424]); // Map<smid, { SmID, ENTITYID, KEYID, ... }>
```

拾取结果里的 `attributes` 不在 `PickResult` 上：`pick()` 只负责拿 SMID，业务字段要按 SMID 再查一次。demo 里的属性卡就是这么补的（点楼 → 查 `featureResults` → 追加字段行）。

### 过滤 / 抬高

同一份属性除了上色，还能直接拿来过滤和抬高——都是「查一次字段 → 写进每网格的单体状态纹理」，不重建几何、不重编译着色器。

```ts
// 只显示 30~80 米之间的建筑
await layer.filterByField({ field: 'SmMaxZ', min: 30, max: 80 });

// 按编码精确匹配（values 按 String(value) 比）
await layer.filterByField({ field: 'KEYID', values: ['C10100SVK57YDUALQHRR00'] });

// 反过来：隐藏 20 米以下的
await layer.filterByField({ field: 'SmMaxZ', max: 20, mode: 'hide' });

// 自定义条件
await layer.filterByField({ field: 'SmMaxZ', keep: (v) => Number(v) > 100 });

layer.clearFieldFilter();   // 恢复全量，不影响 setFilter() 的规则

// 抬高：字段值 × 倍率（米）
await layer.elevateByField({ field: 'SmMaxZ', scale: 0.5 });

// 或者自己映射，第二个参数是数据分布
await layer.elevateByField({
  field: 'SmMaxZ',
  map: (v, r) => ((v - r.min) / (r.max - r.min)) * 200,
  max: 120, // 封顶
});
layer.clearThematicElevation();
```

返回值够用：`filterByField` 给 `{ total, matched, missing, hidden }`，`elevateByField` 给 `{ matched, missing, min, max, appliedMax }`。

几个约定：

- `filterByField` 与 `setFilter()` 是**叠加**关系（两个都放行才显示）；被隐藏的单体不渲染、也不参与拾取；`onMissing` 控制查不到属性的单体怎么算（默认保留）；
- `keep` 模式记的是「命中集合」，之后才加载进来的单体不在集合里，同样隐藏——符合「只显示命中的」，也不会漏出新瓦片里的建筑；
- `elevateByField` 的抬高量写在单体状态纹理的第四通道，顶点着色器加到 z 上；手动 `setFeatureStyle(smid, { elevation })` 优先级更高；
- 抬高只改显示、不改几何，但**拾取和高亮都跟着抬高后的位置走**：GPU 拾取的那一趟渲染会采样同一张状态纹理，选中棱线也会加上同样的偏移，所以抬起来的楼点得中、描边也贴在楼上；
- 上色 / 过滤 / 抬高共用同一个 `AttributeQuery` 缓存，切字段不会重复查；
- 不想走网络时，用 `setThematicElevation(new Map([[423, 20]]))` 直接塞 SMID → 抬高米数。

### 为什么这么重，以及怎么减

数据服务没有「只取属性」的接口。iServer 2026 上逐项试过，结论如下（数据集 `DataSource:zhoubian`，4461 条）：

| 尝试 | 结果 |
|---|---|
| `queryOption: 'ATTRIBUTE'`（body / query string / 大小写） | **完全被忽略**，几何照返回 |
| `hasGeometry` / `returnGeometry` / `withGeometry`（顶层与 `queryParameter` 内） | 全被忽略 |
| `fromIndex` / `toIndex` | 被忽略，不能翻页 |
| `maxFeatures` | ✅ 生效，但只能「取前 N 条」 |
| `.fastjson` 替代 `.json` | ✅ 模型数据集 −40~50% |
| 逐条 `GET /rest/data/feature/{a}-{b}-{idx}.json` | 957B/条（`model` 为 null），但 300 条并发 16 要 2~14s，反而不如一次 POST |
| 二维数据源 `DataSource_erwei` | ✅ 若同名数据集存在，体积只有 1/2.5（`REGION` 而非 `GEOMODEL3D`） |

体积的 90% 是 `geometry.model`：每条要素都带着自己那栋楼的 S3M 模型字节（deflate 压缩后约 2.5KB），而我们要的只是几个字段。所以策略是「一次把全部字段捞回来，尽量少发请求」：

- 响应格式按数据集自动选（`format: 'auto'`）。模型数据集的 `model` 是 byte[]，`.fastjson` 用 hex 表示只要 2 字符/字节，`.json` 是十进制数字数组（3~4 字符/字节），所以走 fastjson；二维数据集的几何是坐标 double，hex 反而更胖（实测 3.9KB vs 2.4KB/条），那种就留在 json。判断依据是 `features.json` 返回的 `geometryType`，一次几十字节。
  fastjson **不是严格 JSON**（`0.0D`、`423L`、`x'D7A34040…'` 都是 Java 字面量），`AttributeQuery` 会先在字符串上把 `x'…'` 抹成 `null` 再 `JSON.parse`——顺便省掉了整个模型的解析开销；解析失败自动回退 `.json`。
- 默认取字段表里除 `SmGeometry` / `SmIndexKey` 外的**全部字段**（字段名本身很便宜，模型才是大头），这样换专题字段、看属性卡都命中缓存。
- 需要压到极限时，如果同一份数据还发布了二维数据源，把 `datasetName` 指过去即可：

```ts
attributes: {
  dataServiceUrl: '.../rest/data',
  datasetName: 'DataSource_erwei:cheng',   // 二维版本，同样的属性、没有模型
}
```

实测同一批 100 栋：

| 数据集 | 格式 | 体积 |
|---|---|---|
| `DataSource:zhoubian`（模型） | json | 9.2 KB/条 |
| `DataSource:zhoubian`（模型） | fastjson（自动） | 6.3 KB/条 |
| `DataSource:cheng`（模型） | json | 10.8 KB/条 |
| `DataSource:cheng`（模型） | fastjson（自动） | 5.5 KB/条 |
| `DataSource_erwei:cheng`（二维） | json（自动） | 2.1 KB/条 |

`AttributeQuery` 还提供 `format`、`chunkSize`、`fields` 三个开关，以及 `query.stats`（`{ requests, bytes, ms }`）用来观察实际开销。

---

## 纯 three.js 使用

`S3MLayer` 是给地图用的，但下面的三层都是宿主无关的，可以直接塞进任意 three 场景（`demo/three.js` 是一个 150 行的完整例子）：

```ts
import * as THREE from 'three';
import { S3MTileset, createSharedUniforms, STYLE, setMaxAnisotropy } from 's3m-maplibre';

const renderer = new THREE.WebGLRenderer({ antialias: true });
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy()); // 纹理各向异性，越早越好

const uniforms = createSharedUniforms();
uniforms.uMode.value = STYLE.TEXTURE;  // 切样式就是改这个 int

// S3M 顶点是局部 ENU（x 东 / y 北 / z 天），three 是 y 朝上
const root = new THREE.Group();
root.rotation.x = -Math.PI / 2;
scene.add(root);

const tileset = new S3MTileset({
  configUrl: '.../jingmo.scp',
  maxTiles: 64,
  uniforms,
  onTile: (node) => root.add(node.group),  // 每个瓦片一个 Group，坐标是米制局部 ENU
});
await tileset.init();  // 返回时首棵瓦片已构建完成

// 每帧驱动 LOD：相机位置要反算回 ENU（world x,y,z ← ENU x,-z,y）
tileset.update(
  [camera.position.x, -camera.position.z, camera.position.y],
  THREE.MathUtils.degToRad(camera.fov),
  renderer.domElement.height
);
```

需要自己补的部分（`S3MLayer` 不代劳）：

| 事项 | 说明 |
|---|---|
| 光照 | 渲染用的是 `MeshStandardMaterial`，自己加 `HemisphereLight` + `DirectionalLight` |
| 多数据集对齐 | 每份数据各有锚点，`S3MLayer` 会把锚点差写进数据集的 `Group.position`（米），纯 three 需要自己算一次 |
| 贴地与经纬度 | 没有地图就没有墨卡托那一步，只有局部米制坐标 |
| 拾取 / 描边 / 样式 UI | `Picker`、等宽棱线、`setStyle` 都在 `S3MLayer` 上，纯 three 用法要直接操作 `uniforms` 和 Mesh |
| 瓦片卸载 | 超出 `maxTiles` 时按「最久没进有效范围」淘汰，同帧再比距离 |

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
| 关闭 `edges` | 棱线是 CPU 端构建的等宽线几何（每段线段 4 个顶点），内存和 drawcall 都随网格数增长，大场景慎用 |
| `shading: 'flat'` | 与 `'smooth'` 性能相当，但视觉更干净 |
| 不透明度 < 1 | 会开启混合并关闭深度写入，overdraw 明显上升，仅用于演示 |
| 批量改单体样式 | 同一同步块里的多次 `setFeatureStyle` 会合并成一次状态纹理重写，见下 |
| `pick` 只渲染 1 个像素 | 已内置；hover 高亮、框选这类高频拾取不再有整屏开销 |

实测（上海某区，5 数据集叠加，45 万三角面，1440×900）：**85~90 fps**。

### 批量改单体样式

单体状态（颜色 / 抬高 / 隐藏）写在**每个网格各自一张一维纹理**里，改一个单体就是重写这张纹理。
逐个高亮时最贵的就是这里：一块白模网格常有几千个 batch，每改一个单体就全量重算一遍，500 个门店 × 6848 个 batch 就是 340 万次迭代。

所以内部做了两层合并：

- **按 SMID 定位网格**：维护 `SMID → 网格` 反查表，改一个只重算包含它的那几块；
- **脏标记 + 微任务合并**：同一个同步块里的多次调用只重算一次。微任务一定在下一帧 `render()` 之前跑完，画面不会看到中间状态。

```ts
// 300 次调用 → 1 次纹理重写
for (const smid of hits) layer.setFeatureStyle(smid, { color: '#ef4444' });

// 需要同步拿到结果（紧接着读纹理、截图、导出）时手动刷
layer.flushOverrides();
```

`filterByField` / `colorByField` / `elevateByField` / `setThematicColors` 这类**全局**改动会重算所有网格，但同样被合并成一次。

---

## 已知限制

- **Draco 压缩几何**能识别、不能解码，遇到会抛明确错误。接法与 MeshOpt 相同（内联 wasm、按需 `import`、解码后走同一套 attribute 组装），但必须先拿 Draco 瓦片标定容器结构。MeshOpt 已支持，且是逐字节对过 60 个真实瓦片才做对的。
- **实例化单体**（`pickInfo` 里给的是 `instanceIds` 而不是 `batchId`，白模常见）只做了渲染，没做按单体控制：`setFeatureStyle` / `filterByField` / `elevateByField` / GPU 拾取走的都是 `aBatchId`，这条路径对实例化几何不生效。要支持得把每个实例单独上色，得改 InstancedMesh 的 instanceColor + 拾取编码。
- **CRN 纹理**已支持，且已在真实服务上验证：内联的 crunch wasm 转回 DXT 后走现成解码，DXT 具体格式看 CRN 头，wasm 约 76KB、只有真遇到 CRN 时才动态加载。**判定看 `compressType` 而不是 `pixelFormat`**——实测 v3.00 是 `ct=26 / pf=13`、行标是 `ct=50000 / pf=32856`，按 `pixelFormat` 26 / 27 判断会把真实 CRN 整包丢掉（模型变灰模）。判定收敛在 `src/core/TextureFormat.ts`（`resolveTextureKind` / `TextureCompress` / `dxtPixelFormatOf`，已从包入口导出）。用 `npm run probe:crn -- --crn <数据集 config 地址>` 可以对任意服务跑「尺寸吻合 / 色数 / 粗糙度 / ASCII 预览」的实测。
- **纹理分包（`s3m:TextureSharing`）未支持**：这类数据集的 `tiles` 全是 `.s3mblock`，不是 `.s3mb`，加载会失败（例：SuperMap Online `3D-CBD/Xiaopin@CBD`）。
- **多块 MeshOpt 骨架**（`blockCount > 1`）暂未对齐：例 `3D-WorkSpace_pbr1/pbrmodel`，第二块头部按现有布局读会错位，会给出「流尺寸异常」的可定位报错而不是底层 RangeError。
- **切线顶点流**只跳过不解码（渲染没有法线贴图通道），带 TANGENT 的数据不会被判失败。
- **KTX2** 不在 S3M 的 `pixelFormat` 枚举里，iServer 也不会发；要支持需自行引入 `basis_transcoder.wasm` 并解析容器，属于「换数据源才需要考虑」的项。
- **骨骼动画**解析了但未驱动。
- **地形遮挡**未实现：MapLibre 的地形深度没有写进 custom layer 的深度缓冲，建筑不会被地形裁掉。
- 跨城市量级的数据集叠加会有 float32 精度问题。

---

## 数据与许可

- 本库代码 Apache-2.0。
- `src/core/DXTTextureDecode.ts` 来自 [SuperMap/s3m-spec](https://github.com/supermap/s3m-spec)（Apache-2.0）。
- `src/vendor/crunch_decoder.module.js` 是 crunch 的 emscripten 构建（Apache-2.0），wasm 内联、仅改动加载方式。
- `src/vendor/meshopt_decoder.module.js` 是 [meshoptimizer](https://github.com/zeux/meshoptimizer) 官方解码器（MIT，© Arseny Kapoulkine），未做修改。
- S3M 规范文本遵循 CC BY-ND 4.0，不得修改规范文本后再发布。
