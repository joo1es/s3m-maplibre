# s3m-maplibre API 参考

> 对应 `s3m-maplibre` 的 `packages/s3m-maplibre/src/index.ts` 导出面

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [与 s3m-three 的分界](#与-s3m-three-的分界)
- [`S3MLayer`](#s3mlayer)
- [投影](#投影)
- [宿主兼容与已知限制](#宿主兼容与已知限制)
- [数据与许可](#数据与许可)

---

## 安装

```bash
npm install s3m-maplibre three
```

`three` 是 peer 依赖，需要宿主项目自己提供（要求 `>=0.155.0`）。下限取 0.155 是因为该版本把光照默认值切成物理单位，更早的 three 会把方向光放大约 π 倍，白模直接过曝。

`maplibre-gl` **不是**本包的依赖：图层只是一个符合 `CustomLayerInterface` 的普通对象，你通过 `map.addLayer()` 挂上去即可。

渲染内核是 [s3m-three](../s3m-three/docs/API.md)（本包的依赖，安装时自动带上）；不用地图、只要渲染内核的用法见那份文档。

### TypeScript

包内置类型声明（`dist/index.d.ts`），由 TS 源码直接编译产出，开箱可用。公开 API 会暴露 `THREE.Mesh` / `THREE.Group` 等对象，three 自身不带类型声明，需要另装 `@types/three`。

```ts
import { S3MLayer, STYLE, type PickResult } from 's3m-maplibre';
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

## 与 s3m-three 的分界

`S3MLayer` 只做「宿主协议 ↔ 渲染内核」的翻译，自身不持有场景状态：

| 归属 | 内容 |
|---|---|
| `s3m-maplibre`（本包） | custom layer 生命周期（`onAdd` / `onRemove` / `render`）、每帧矩阵提取、`click` 事件、`fitBounds` 飞向、MapLibre 侧 `GeoAdapter`（`extractWorldCoordinateHelper`） |
| `s3m-three`（内核） | 场景 / 相机 / 灯光 / uniforms / 拾取 / 选中描边 / 棱线 / 高度跟踪 / 数据集注册，即 `S3MViewer` |

`S3MLayer` 上绝大多数方法是原样委托给内部 `viewer`（`S3MViewer` 实例）的。本包入口 `export * from 's3m-three'`，所以 `S3MViewer`、`S3MTileset`、`parseS3MB`、`STYLE`、样式 / 字段着色 / 过滤 / 抬高等内核 API 也能直接从 `'s3m-maplibre'` 导入——0.2.x 的用法完全不变。

以下内容本文档不再重复，见 [s3m-three API 参考](../s3m-three/docs/API.md)：

- **样式系统**（`S3MStyle` 全字段、着色模式、`shading` / 光照细节）
- **核心概念**（坐标链路、锚点、瓦片与 LOD、单体化与 batch 粒度）
- **按业务字段着色 / 过滤 / 抬高**（`colorByField` / `filterByField` / `elevateByField` / `AttributeQuery`）
- **底层 API**（`parseS3MB` / MeshOpt / `S3MTileset` / 单体属性工具）
- **性能调优**与解析 / 几何 / 纹理类的**已知限制**

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
| `style` | `Partial<S3MStyle>` | 见[s3m-three 样式章节](../s3m-three/docs/API.md#样式s3mstyle) | 初始样式 |
| `ground` | `GroundOptions` | — | 3D 物理地表面 / 基坑开挖配置 |
| `pickable` | `boolean` | `true` | 是否响应点击 |
| `maxTiles` | `number` | `64` | 每个数据集驻留瓦片上限，超了淘汰最久没用的（不是停止加载） |
| `totalMaxTiles` | `number` | — | 多数据集全局瓦片总预算，在可见数据集间动态均衡分配配额，防止多图层叠合爆显存 |
| `light` | `LightOptions` | — | 场景光照配置（环境光、主光、方位角、高度角及 headlamp/fixed 模式） |
| `maxConcurrent` | `number` | `4` | 每个数据集并发请求数 |
| `lodRangeScale` | `number` | `1.0` | LOD 切换距离缩放系数，> 1 更倾向保留粗模，< 1 提前细化 |
| `attributes` | `AttributeQueryOptions` | — | 业务属性查询配置，见[s3m-three 字段着色章节](../s3m-three/docs/API.md#按业务字段着色) |
| `projection` | `'perspective' \| 'orthographic'` | `'perspective'` | 投影模式，见[投影](#投影) |
| `onStats` | `(s: Stats) => void` | — | 统计更新 |
| `onReady` | `(entry) => void` | — | 某个数据集就绪 |
| `onPick` | `(f: PickResult \| null) => void` | — | 点击拾取结果 |
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
  configUrl: string;    // .scp 地址，或 iServer 的数据源 config（见下）
  visible?: boolean;    // 默认 true
  maxTiles?: number;    // 覆盖图层级配置
}
```

`configUrl` 接受三种形态：本地 / 静态托管的 `.scp`；`.s3mb` 瓦片地址；以及 iServer realspace 服务的**数据源 config**：

```
https://host/iserver/services/3D-xxx/rest/realspace/datas/<数据源名>/config
```

三个容易踩的点（详见 [s3m-three 的 S3MTileset 一节](../../s3m-three/docs/API.md#s3mtileset)）：后缀只能写 `config`，写成 `config.xml` 会 406；`<数据源名>` 可以是中文，直接给到 `…/datas` 拿到的是资源清单而不是配置；OSGB 倾斜摄影那类服务的 `config` 返回 XML 且瓦片是 S3M 1.x，位置能定准但几何不支持，会明确报错。

`addDataset` 在图层 `onAdd` 之前调用会抛错（此时还没有 WebGL 上下文）。

### 样式

```ts
setStyle(patch?: Partial<S3MStyle>): void
getStyle(): S3MStyle & { modeLabel: string }
setOpacity(opacity: number): void
```

`setStyle` 是**合并**语义，只传要改的字段。除了 `shading`（编译期宏，需重编译着色器）之外，其余字段都是 uniform / 材质状态更新，热切换零成本。字段含义见 [s3m-three 样式章节](../s3m-three/docs/API.md#样式s3mstyle)。

### 棱线

```ts
setEdges(enabled: boolean): void
```

优先用**数据自带的棱线包**（`primitiveType === 13` 的索引包，本质是线段对）：解析时就建好 `LineSegments`，开关只是切 `visible`，成本为零，颜色跟随 `style.edgeColor`。

数据里没有棱线包时才用 `EdgesGeometry` 在 CPU 端现算。几十万面一次性建会卡住主线程（实测 20 个网格 1.9s），所以内部按 8ms 一帧切片执行，超过 12 万索引的几何直接跳过。

棱线本身画成**屏幕空间等宽线**（`packages/s3m-three/src/render/EdgeLines.ts`）：WebGL 的 `lineWidth` 在绝大多数平台被忽略、恒定 1px，只有把每条棱摊成面向屏幕的四边形才能真的调粗细。因此：

- `edgeWidth`（像素）控全局棱线粗细，缩放时线宽恒定；
- 选中单体的描边默认也走同一套画法（`outlineStyle: 'edges'`），只挑这个单体自己的三角面算折边，`outlineWidthPx` 控粗细；
- 数据自带的棱线包是原始线段，仍是 1px，只受颜色 / 透明度控制。

> 注意：棱线包**不能**当三角面画。把它当 `TRIANGLES` 提交，每条棱线都会被连成一根几十上百米的尖刺，整片模型变成放射状三角面。

### 光照控制

```ts
setLight(patch: Partial<LightOptions>): void
getLight(): LightOptions
```

委托内部 `viewer.setLight` / `viewer.getLight`，支持动态调整环境光与主平行光的颜色、强度、方位角、高度角以及 `headlamp`（跟随地图航向视角）与 `fixed`（固定世界太阳方位）模式，并自动触发地图重绘。参数定义见 [s3m-three 光照章节](../s3m-three/docs/API.md#光照控制-adjustable-lighting)。

### 拾取与空间查询

```ts
pick(x: number, y: number): PickResult | null
pickFromEvent(e): PickResult | null
pickPosition(x: number, y: number): { lngLat: [number, number]; altitude: number; point: [number, number, number] } | null
drillPick(x: number, y: number, limit?: number): PickResult[]
select(result: PickResult | null, opts?: { silent?: boolean }): void
getFeatureBounds(smid: number): [[number, number], [number, number]] | null
flyToFeature(smid: number, options?: Record<string, unknown>): boolean
```

`pick` 的坐标是**相对 canvas 左上角的 CSS 像素**。`pickFromEvent` 接受 MapLibre 的 `MouseEvent` 或原生事件，自动换算。返回值包含单体属性、中心经纬度、以及精确交点世界坐标（`point: [x,y,z]`, `lngLat: [lng,lat]`, `altitude: number`），结构见 [s3m-three 拾取章节](../s3m-three/docs/API.md#拾取与属性)。

- `pickPosition(x, y)`：拾取指定屏幕像素对应的精确三维世界坐标。优先对命中的建筑网格精确表面求交；未命中建筑时与地表面（z=0）求交。
- `drillPick(x, y, limit?)`：视线穿透拾取，沿射线命中所有单体，按由近至远距离排序返回。
- `getFeatureBounds(smid)`：获取指定 SMID 单体的经纬度包围盒 `[[minLng, minLat], [maxLng, maxLat]]`（自动叠加单体平移/拔高）。
- `flyToFeature(smid, options?)`：聚焦飞向单体，内部自动调用宿主地图的 `map.fitBounds`。

拾取走 GPU：把「物体编号 + batchId」编码成 RGBA 渲染到离屏目标，再读那一个像素。代价与三角面数无关，且天然只命中最前面的可见面。

离屏目标只有 **1×1**：viewport 尺寸仍是整块画布、原点平移到 `(-px, -(h-1-py))`，于是整幅画面按原样光栅化，只有点击点那一格落在目标上。着色器、矩阵、深度测试全都不变，但每点一次不再渲染一整屏（移动端收益最明显）。

`select` 负责高亮与描边，传 `null` 清除选中。

### 单体样式与字段

以下方法均为委托 `viewer`，语义与参数见 [s3m-three 对应章节](../s3m-three/docs/API.md#按业务字段着色)：

```ts
setFeatureStyle(smid: number, style: FeatureStyle): void
setFeaturesStyle(smids: number[], style: FeatureStyle): void
getFeatureStyle(smid: number): FeatureStyle | null
getFeatureStyles(): Map<number, FeatureStyle>
removeFeatureStyle(smid: number): void
clearFeatureStyles(): void
flushOverrides(): void
auditBatches(): BatchAudit
setAttributeSource(options: AttributeQueryOptions | null): void
getLoadedSmids(): number[]
colorByField(options: ColorByFieldOptions): Promise<ThematicResult>
setThematicColors(colors: Map<number, string> | null, field = 'custom'): void
clearThematic(): void
filterByField(options: FieldFilterOptions): Promise<FieldFilterResult>
clearFieldFilter(): void
elevateByField(options: FieldElevationOptions): Promise<FieldElevationResult>
setThematicElevation(elevations: Map<number, number> | null, field = 'custom'): void
clearThematicElevation(): void
setFilter(filter: S3MFilter | null): void
getFilter(): S3MFilter | null
clearFilter(): void
```

### 3D 物理地表与基坑

```ts
setGroundMode(mode: GroundMode): void
setGroundOpacity(opacity: number): void
setExcavationBounds(bounds: [number, number, number, number] | null): void
```

### 其他

```ts
getBounds(): [[number, number], [number, number]] | null  // 合并经纬度范围
setProjection(mode: 'perspective' | 'orthographic'): void  // 投影模式，见[投影](#投影)
setLodRangeScale(scale: number, datasetId?: string): void  // 缩放 LOD 切换距离阈值（>1 更倾向粗模，<1 提前细化）
readonly lodRangeScale: number
readonly stats: Stats
readonly fps: number
readonly projection: 'perspective' | 'orthographic'
dispose(): void
```

```ts
interface Stats {
  tiles: number; loading: number; failed: number;
  meshes: number; vertices: number; triangles: number; datasets: number;
}
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

底层数学在 `packages/s3m-three/src/render/OrthoProjection.ts`（从 `s3m-three` 入口导出），`npm test` 里的 `tools/test-ortho.mjs` 用合成矩阵钉住：视图矩阵还原、目标平面重合、正交语义、zoom 映射、near/far 深度映射、三类非法输入拒绝。

---

## 宿主兼容与已知限制

- **遮挡靠的是深度来源，不是「开没开地形」**：本层全程不清深度缓冲（`autoClear = false`），凡是往同一深度缓冲写了更近深度的东西都能遮挡建筑。MapLibre 地形网格与本层（`renderingMode: '3d'`）共用主 framebuffer、同一 `depthRangeFor3D`、同一 `LEQUAL + ReadWrite` 深度模式，所以地形可以遮挡；前提是宿主开启 `map.setTerrain({ source: 'dem' })`、提供 DEM 源，且地形需要有 raster / hillshade 层供图（否则地形面空白）。另外 S3M 数据通常按海拔 0 建模，需要用 `setDatasetHeight()` 把模型抬到真实地面高程，否则深度虽可比但空间位置对不上。不想接 DEM 时用 `setGroundOcclude(true)` 让自带物理地表充当遮挡源（平面一刀切）。
- **物理地表（地下透视 / 基坑）**与 terrain 是两个维度但不是两套机制：前者表达模型自身的地上 / 地下结构覆盖关系，后者表达真实地面的起伏遮挡；两者只是都往同一个深度缓冲写深度。平面代理表达不了山体起伏，而地形已写入更近深度的像素上平面也写不进去，所以地铁站 / 基坑这类没有真实 DEM 的数据靠前者，有 DEM 的山地靠后者。
- **正交投影**需要 MapLibre ≥ 5；v4 / v5 以下（含 Mapbox v2）只给合并矩阵，会告警一次并保持透视，见[投影](#投影)。
- **多数据集叠加**应位于同一城市量级（几公里内），跨城市叠加会重新引入 float32 精度问题。

解析 / 几何 / 纹理 / 单体化相关的已知限制（Draco 回归覆盖、实例化单体、CRN 判定、切线流、KTX2、骨骼动画）见 [s3m-three 已知限制](../s3m-three/docs/API.md#已知限制)。

---

## 数据与许可

- 本包代码 Apache-2.0。
- 解析 / 纹理 / 几何相关的第三方组件（DXT 解码、crunch wasm、meshoptimizer wasm）随 `s3m-three` 分发，许可见 [s3m-three 数据与许可](../s3m-three/docs/API.md#数据与许可)。
- S3M 规范文本遵循 CC BY-ND 4.0，不得修改规范文本后再发布。
