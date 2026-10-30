# s3m-maplibre API 参考

> 对应 `s3m-maplibre` 的 `packages/s3m-maplibre/src/index.ts` 导出面

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [与 s3m-three 的分界](#与-s3m-three-的分界)
- [`S3MLayer`](#s3mlayer)
- [动画与过渡](#动画与过渡)
- [投影](#投影)
  - [全局正交（beta，选配）](#全局正交beta选配)
  - [近裁剪面（贴脸看时不消失）](#近裁剪面贴脸看时不消失)
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
- **动画内核**（完整的通道表、曲线库、`Animator` / `Path` / GPU 路径实现细节，见 [s3m-three 动画与过渡](../s3m-three/docs/API.md#动画与过渡)）
- **核心概念**（坐标链路、锚点、瓦片与 LOD、单体化与 batch 粒度）
- **按业务字段着色 / 过滤 / 抬高**（`colorByField` / `filterByField` / `elevateByField` / `AttributeQuery`）—— 可选的内置 iServer 便利版，业务对应关系本应在外部自己实现
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
| `maxTriangles` | `number` | `Infinity` | 每个数据集驻留三角形总数的软上限（不限制）。`maxTiles` 管不住的场景用来做刹车，见[s3m-three 性能调优](../s3m-three/docs/API.md#移动端--差设备) |
| `maxMemory` | `number` | `Infinity` | 每个数据集驻留显存/内存字节数的软上限（不限制）。几何+纹理显存超限触发 make-before-break 主动淘汰 |
| `totalMaxTiles` | `number` | — | 多数据集全局瓦片总预算，在可见数据集间动态均衡分配配额，防止多图层叠合爆显存 |
| `light` | `LightOptions` | — | 场景光照配置（环境光、主光、方位角、高度角及 headlamp/fixed 模式） |
| `maxConcurrent` | `number` | `4` | 每个数据集并发请求数 |
| `lodRangeScale` | `number` | `1.0` | LOD 切换距离缩放系数，> 1 更倾向保留粗模，< 1 提前细化 |
| `lodPixelRatioCap` | `number` | `Infinity` | LOD 判定屏幕高度的 DPR 上限（不截断）。默认按绘图缓冲物理像素算，3x DPR 手机上会显著多拉瓦片；传 `2` 即按「CSS 高度 × 2」截断，见[移动端 / 差设备](../s3m-three/docs/API.md#移动端--差设备) |
| `anisotropyCap` | `number` | `Infinity` | 各向异性过滤上限（不封顶 = GPU 最大值，通常 16）。移动端 4 / 8 通常肉眼无差，见[移动端 / 差设备](../s3m-three/docs/API.md#移动端--差设备) |
| `maxTextureSize` | `number` | `Infinity` | 纹理长边像素上限（不限制）。手机上 1024 即可，显存降到 1/4；图集与 DXT 直传不受影响 |
| `maxImageCache` | `number` | `128` | 纹理缓存条数上限，1024² RGBA 约 4MB / 条。低端设备 32~48，见[移动端 / 差设备](../s3m-three/docs/API.md#移动端--差设备) |
| `materialQuality` | `'pbr' \| 'lambert'` | `'pbr'` | 光照模型，`lambert` 片元约省一半。图层级设置，同页多个图层各用各的、互不覆盖；只影响之后创建的材质 |
| `motionBlur` | `{ mode?: 'afterimage' \| 'velocity'; damp?: number \| 'auto'; maxOffset?: number }` | 不传 = 关闭 | 可选运动模糊后处理，**默认关闭**。低端设备低帧率时用帧间残影在感知层面填补卡顿：`afterimage`（缺省）几乎零边际成本、`velocity` 按相机运动方向模糊；`damp: 'auto'` 按实时 FPS 自适应；`maxOffset`（仅 velocity）为拖影上限（屏宽百分比，缺省 0.05）。运行时 `setMotionBlur(null)` 关闭，详见[s3m-three 构造函数选项](../s3m-three/docs/API.md#构造函数)。仅 WebGL2 |
| `attributes` | `AttributeQueryOptions` | — | 业务属性查询配置，见[s3m-three 业务字段章节](../s3m-three/docs/API.md#业务字段锚点在库内对应关系在外部) |
| `projection` | `'perspective' \| 'orthographic'` | `'perspective'` | 投影模式，见[投影](#投影) |
| `nearPlaneScale` | `number` | `1` | 近裁剪面缩放系数（`0 < scale < 1`，1 = 不改）。MapLibre 的 near 是硬编码的 `canvasHeight/50`，zoom 16.5 时约合 13 米，相机贴近模型会把楼面整片裁掉；缩放后 fov / far 不变，见[近裁剪面](#近裁剪面贴脸看时不消失) |
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

三个容易踩的点（详见 [s3m-three 的 S3MTileset 一节](../../s3m-three/docs/API.md#s3mtileset)）：后缀只能写 `config`，写成 `config.xml` 会 406；`<数据源名>` 可以是中文，直接给到 `…/datas` 拿到的是资源清单而不是配置；OSGB 倾斜摄影那类服务的 `config` 返回 XML 且瓦片是 S3M 1.x，位置能定准但几何不支持，会明确报错。混合服务（模型 + 地形 + 影像共存）里的地形/影像数据集（如 `3D-OlympicGreen_Plan` 的 `beijingdem`）会在 `init` 阶段被 `classifyDatasetKind` 识别并明确报「是地形/影像缓存，本层仅支持模型类 S3M 数据集」，不再伪装成「配置中缺少 root tile」；自建数据集列表时可用导出的 `parseConfigText` + `classifyDatasetKind` 提前标注类型。

`addDataset` 在图层 `onAdd` 之前调用会抛错（此时还没有 WebGL 上下文）。

### 样式

```ts
setStyle(patch?: Partial<S3MStyle>, transition?: TransitionOptions): void
getStyle(): S3MStyle & { modeLabel: string }
setOpacity(opacity: number, transition?: TransitionOptions): void
```

`setStyle` 是**合并**语义，只传要改的字段。除了 `shading`（编译期宏，需重编译着色器）、`edges` / `edgeThreshold` / `forceCpuEdges`（结构变更）之外，其余字段都是 uniform / 材质状态更新，热切换成本很低。字段含义见 [s3m-three 样式章节](../s3m-three/docs/API.md#样式s3mstyle)。

带 `transition` 时，能插值的字段逐帧过渡，不能插值的仍即时生效，详见[动画与过渡](#动画与过渡)。

### 棱线

```ts
setEdges(edges: EdgesOption, transition?: TransitionOptions): void
```

带 `transition` 时只对屏幕空间等宽棱线做淡入淡出（`uEdgeFade`），几何仍按 8ms 切片构建；关闭时淡完才释放几何。数据自带的线段包直接切 `visible`，不会淡入。详见[动画与过渡](#动画与过渡)。

优先用**数据自带的棱线包**（`primitiveType === 13` 的索引包，本质是线段对）：解析时就建好 `LineSegments`，开关只是切 `visible`，成本为零，颜色跟随 `style.edgeColor`。

数据里没有棱线包时才用 `EdgesGeometry` 在 CPU 端现算。几十万面一次性建会卡住主线程（实测 20 个网格 1.9s），所以内部按 8ms 一帧切片执行，超过 12 万索引的几何直接跳过。

棱线本身画成**屏幕空间等宽线**（`packages/s3m-three/src/render/EdgeLines.ts`）：WebGL 的 `lineWidth` 在绝大多数平台被忽略、恒定 1px，只有把每条棱摊成面向屏幕的四边形才能真的调粗细。因此：

- `edgeWidth`（像素）控全局棱线粗细，缩放时线宽恒定；
- 选中单体的描边默认也走同一套画法（`outlineStyle: 'edges'`），只挑这个单体自己的三角面算折边，`outlineWidthPx` 控粗细；
- 数据自带的棱线包是原始线段，仍是 1px，只受颜色 / 透明度控制；想让它们也吃 `edgeWidth` / 外扩 / 单体跟随，把 `style.forceCpuEdges` 打开改由 CPU 现算。
- `setEdges` 收 `boolean | 'line' | 'offset' | 'hull' | 数组`：`'offset'` 是折边线沿边法线外推（`edgeOffset` 米），`'hull'` 是背面外扩轮廓（`edgeHullWidth` 米，整场景版的「白模 + 卡通描边」），`'gpu'` 是后处理描边（法线 + 深度 RT + 全屏 Sobel，零 CPU 成本、线宽像素级可控，只支持 WebGL2），数组可叠加，如 `['line', 'hull']`、`['gpu', 'line']`。

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

以下方法均为委托 `viewer`，语义与参数见 [s3m-three 业务字段章节](../s3m-three/docs/API.md#业务字段锚点在库内对应关系在外部)：

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
setProjection(mode: 'perspective' | 'orthographic', transition?: TransitionOptions): void  // 投影模式，可平滑过渡，见[投影](#投影)
setNearPlaneScale(scale: number): void                    // 近裁剪面缩放，1 = 恢复 MapLibre 原值
setLodRangeScale(scale: number, datasetId?: string): void  // 缩放 LOD 切换距离阈值（>1 更倾向粗模，<1 提前细化）
readonly lodRangeScale: number
setLodPixelRatioCap(cap: number): void                    // LOD 判定屏幕高度的 DPR 上限，Infinity = 不截断（默认）
readonly lodPixelRatioCap: number
setMaxImageCache(n: number, datasetId?: string): void    // 纹理缓存条数，默认 128
setMaxTriangles(n: number, datasetId?: string): void      // 驻留面数软上限，Infinity = 不限制（默认）
readonly maxTriangles: number
setMaxMemory(bytes: number, datasetId?: string): void         // 驻留显存字节软上限，Infinity = 不限制（默认）
readonly maxMemory: number
setAnisotropyCap(cap: number): void                       // 各向异性上限，Infinity = 取 GPU 最大值（默认）；即时应用到已上传纹理
readonly anisotropyCap: number
setColorPipeline(q: 'linear' | 'direct', opts?: { duration?: number; dim?: number }): Promise<void>
readonly colorPipeline: 'linear' | 'direct'               // 图层级；duration > 0 走压暗过渡
setMaterialQuality(q: 'pbr' | 'lambert'): void            // 图层级；原位重建本层材质
readonly materialQuality: 'pbr' | 'lambert'
setMotionBlur(cfg: MotionBlurOptions | null): void       // 运行时开关运动模糊；null = 关闭并释放 RT
readonly motionBlur: MotionBlurOptions | null
lngLatToPoint(p: LngLatAlt): [number, number, number]   // 经纬度 → 场景 ENU（画代理几何用）
pointToLngLat(v: [number, number, number]): LngLatAlt
measureDistance(a: LngLatAlt, b: LngLatAlt): { distance3D; distanceHorizontal; heightDiff }
measurePolyline(points: LngLatAlt[]): { length3D; lengthHorizontal }
measurePolygon(points: LngLatAlt[]): { area3D; areaHorizontal; perimeter }
lineOfSight(a: LngLatAlt, b: LngLatAlt, opts?): LineOfSightResult
setClipping(opt: ClipOptions | null): void                // 平面 / Box / 十字，图层级
readonly clipping: ClipOptions | null
skyline(opts?: { width?; height?; step?; include?: Object3D[] }): SkylineResult | null  // 一次深度 pass，别每帧调
viewshed(opts: { origin; radius; grid?; eyeHeight?; size?; include? }): ViewshedResult | null  // 6 次 pass
setMaxTextureSize(n: number): void                        // 纹理长边像素上限，Infinity = 不限制（默认）
readonly maxTextureSize: number
readonly maxImageCache: number
readonly stats: Stats
readonly fps: number
readonly projection: 'perspective' | 'orthographic'
readonly projectionT: number                              // 0 = 纯透视，1 = 纯正交
readonly animation: S3MViewer['animator']                 // 动画调度器，见[动画与过渡](#动画与过渡)
dispose(): void
```

```ts
interface Stats {
  tiles: number; loading: number; failed: number;
  meshes: number; vertices: number; triangles: number; datasets: number;
}
```

---

## 动画与过渡

> 完整的通道表、曲线库、`Animator` / `Path` / `GPUPathManager` API 与实现细节见 [s3m-three 动画与过渡](../s3m-three/docs/API.md#动画与过渡)。本节只列 `S3MLayer` 的入口，以及 MapLibre 宿主下的差异。

动画能力全部来自内部 `viewer.animator`。**不需要自己开 `requestAnimationFrame`**：`layer.render()` 每帧调用 `viewer.renderFrame()` → `animator.tick()`，返回 `true` 时自动 `map.triggerRepaint()`；启动动画时 `animator.onActive` 也会主动踢一帧。

```ts
// 调度器直连
layer.animation.cancel('style.opacity');   // 停在当前值，不回弹
layer.animation.finish('style.opacity');   // 直接跳到终值
layer.animation.budgetMs = 3;              // 单帧写入预算（默认 2.5ms）
layer.animation.activeCount;               // 当前活跃 track 数
```

`layer.animation` 是只读 getter，返回 `viewer.animator`，不能整体赋值。也不要手动调 `tick()`，否则会双倍推进。

### 过渡参数

`TransitionOptions` 与 s3m-three 完全一致：

```ts
interface TransitionOptions {
  duration?: number;       // 毫秒，0 / 不传 = 立即生效
  delay?: number;
  easing?: EasingName | EasingFn;  // 默认 'linear'
  retarget?: 'proportional' | 'fixed';
  spring?: { stiffness: number; damping: number; epsilon?: number };
  stagger?: number;        // 仅 animateFeatures 消费
  onComplete?: () => void; // cancel 不回调
}
```

语义见 [s3m-three 过渡参数](../s3m-three/docs/API.md#过渡参数transitionoptions)。两个最容易踩的点：**默认曲线是 `linear`**（不是 CSS `ease`）；**一次调用的参数对所有通道生效**，要不同时长请分开调用。

### 样式 / 棱线 / 模式

```ts
setStyle(patch?: Partial<S3MStyle>, transition?: TransitionOptions): void
setOpacity(opacity: number, transition?: TransitionOptions): void
setEdges(edges: EdgesOption, transition?: TransitionOptions): void
setMode(mode: S3MStyle['mode'], options?: { duration?: number; dim?: number }): Promise<void>
prewarmShading(): Promise<void>
```

```ts
// 能插值的字段走过渡
layer.setStyle({ colorA: '#ef4444', opacity: 0.6 }, { duration: 600, easing: 'easeOutCubic' });
layer.setOpacity(0.5, { duration: 400 });

// 棱线淡入淡出（几何仍按 8ms 切片建）
layer.setEdges(true, { duration: 400 });
layer.setEdges(false, { duration: 300 });

// uMode 是 int，插不了值：压暗 → 换 → 亮回来
await layer.setMode(STYLE.HEIGHT, { duration: 300, dim: 0.35 });
```

- 可动画字段表、颜色空间、`fadeIn` 的代价见 [s3m-three 样式过渡](../s3m-three/docs/API.md#样式过渡)。
- `mode` / `shading` / `edges` / `edgeThreshold` / `forceCpuEdges` 不参与插值：`mode` 用 `setMode`，`edges` 用 `setEdges`，`shading` 是编译期宏，`edgeThreshold` 会重建棱线几何。
- `getStyle()` 立即返回目标值，动画进行中也一样；当前显示值在 `viewer.style`。
- 全局 `opacity` 允许到 0：到 0 时本层跳过绘制（不写颜色也不写深度），底图不会被挖洞。`getStyle().opacity` 与屏幕一致。
- `setStyle({ fadeIn: 500 })` 让**之后新加载的瓦片**（含 LOD 换瓦）淡入，默认 0；淡入期间这些瓦片会进透明队列。
- `shading` 首次切换不再现场编译：首帧后会自动预热另一种变体（构造选项 `prewarmShading`，默认开）。要自己挑时机就关掉它再调 `layer.prewarmShading()`。

### 单体动画

```ts
animateFeature(smid: number, style: Partial<FeatureStyle>, transition?: TransitionOptions): void
animateFeatures(smids: number[], style: Partial<FeatureStyle>, transition?: TransitionOptions): void
moveFeature(smid: number, translation: [number, number, number], transition?: TransitionOptions): void
moveFeatureBy(smid: number, delta: [number, number, number], transition?: TransitionOptions): void
rotateFeature(smid: number, rotation: FeatureStyle['rotation'], pivot?: [number, number, number], transition?: TransitionOptions): void
rotateFeatureBy(smid: number, deltaRotation: number | [number, number, number], pivot?: [number, number, number], transition?: TransitionOptions): void
```

```ts
// 点击单体后抬高并变色
map.on('click', (e) => {
  const hit = layer.pickFromEvent(e);
  if (hit?.smid != null) {
    layer.animateFeature(
      hit.smid,
      { elevation: 80, color: '#ef4444' },
      { duration: 600, easing: 'easeOutBack' },
    );
  }
});

// 批量错峰：每个单体延迟 i × 8ms
layer.animateFeatures(smids, { opacity: 0.2 }, { duration: 500, stagger: 8 });
```

- `translation` 是相对原始位置的**绝对**偏移（米，场景 ENU）；增量用 `moveFeatureBy`。
- `rotation` 支持数字（绕 Z 轴弧度）、欧拉角、四元数或 three 的 `Euler` / `Quaternion` / `Matrix`；`pivot` 是**局部坐标**轴心，绕模型原点转通常会把楼甩出去。
- `hidden` 不可插值，立即生效；要淡出再隐藏，用 `animateFeature({ opacity: 0 }, { onComplete: () => layer.setFeatureStyle(smid, { hidden: true }) })`。
- 位移 / 旋转会自动关闭受影响网格的视锥剔除，值归零后恢复。
- `removeFeatureStyle` / `clearFeatureStyles` 会回收该单体的动画通道，动画随之中断且不回调。

完整字段语义与坑见 [s3m-three 单体动画](../s3m-three/docs/API.md#单体动画)。

### 路径运动

```ts
followPath(smid: number, points: Path | ArrayLike<number> | Array<[number, number, number]>, options?: PathFollowOptions): void
stopPath(smid: number): void
```

```ts
layer.followPath(smid, [[0, 0, 0], [80, 0, 0], [80, 60, 0]], {
  duration: 6000,
  loop: true,
  offset: [baseX, baseY, 0],
});
layer.stopPath(smid);   // 停在当前位置
```

- 路径点是**数据集局部 ENU 米坐标**（相对该单体所属数据集的锚点；单数据集时就是场景 ENU），不是经纬度；需要经纬度路线时先换算成 ENU 再加 `offset`。
- 缓动作用在**弧长**上，不是顶点索引，顶点疏密不均也不会忽快忽慢。
- `duration` 与 `speed`（米/秒）二选一，都不给默认 2000ms；`loop` 每次从起点重来，`closed` + `loop` 才是无缝循环。
- 对同一 smid 再次 `followPath` 会从新路径的**起点**重新开始，不是从当前位置接续；要接续就先 `stopPath`，自行裁掉已走路段并换算 `offset`。
- 不要和 `moveFeature` 同时驱动同一个单体，两者都写 `translation`。
- 几十到几千个 mover 用 `followPath`；上万个用下面的 GPU 路径。

### GPU 路径动画（万级）

```ts
registerGPUPath(points, opts?: { id?: number; name?: string; closed?: boolean }): number
unregisterGPUPath(id: number): boolean
getGPUPathManager(): GPUPathManager
bindGPUPath(smid, path: number | Path | ArrayLike<number> | Array<[number, number, number]>, options?: Omit<GPUPathOptions, 'pathId'>): number
unbindGPUPath(smid: number): void
setGPUPathProgress(smid: number, progress: number): void
setGPUPathTime(time: number, autoAdvance?: boolean): void
getGPUPathTime(): number
```

```ts
const pathId = layer.registerGPUPath([[0, 0, 0], [200, 0, 0], [200, 120, 0]]);

// 共享同一条路径的车流；速度是「归一化进度/秒」
for (const smid of vehicleSmids) {
  layer.bindGPUPath(smid, pathId, { speed: 0.05, phase: Math.random(), loop: 'loop' });
}

layer.setGPUPathTime(0);   // 冻结自动推进，改由调用方每帧给时间
```

- 路径按等弧长烘成 `RGBA32F` 纹理（每行一条路径、256 个采样点，`RGBA = x, y, z, yaw`），单体参数写进状态纹理第 5 行；CPU 每帧只写一个 `uPathTime`。
- `speed` 是归一化进度/秒（`0.05` ≈ 20 秒一圈），`phase` 是初始相位，`loop` 支持 `'loop' | 'pingpong' | 'clamp'`，`autoHeading` 默认按切线自动转向。
- 路径 ID 决定纹理行，避免使用很大的稀疏 ID；不传 `id` 时自增分配。
- **自动推进按帧累加 `0.016` 秒**，低帧率下会变慢。需要严格速度时用 `setGPUPathTime(elapsedSeconds)` 自己驱动（默认会冻结自动推进），再传 `true` 恢复。
- `setGPUPathProgress(smid, t)` 会把该单体的 `speed` 置 0、`phase` 设为进度，用于手动定位。
- `unbindGPUPath` 删除 `gpuPath` 配置；绑定后该网格的视锥剔除会被关闭（解绑不会自动恢复）。
- **拾取与包围盒都跟着走**：拾取着色器与主着色器采样同一份路径纹理，`getFeatureBounds()` 用同一公式在 CPU 复算位置与朝向。仍按原位置的只有属性过滤这类不涉及空间的逻辑。

### 整批过渡（双纹理交叉淡化）

```ts
crossFadeStyles(
  targetStyles: Map<number, FeatureStyle> | Record<string | number, FeatureStyle>,
  transition?: TransitionOptions
): void
```

```ts
// 目标表是全量替换：这里只保留 101 / 102 的自定义样式
layer.crossFadeStyles(new Map([
  [101, { color: '#22c55e', elevation: 0 }],
  [102, { color: '#3b82f6', elevation: 20 }],
]), { duration: 800, easing: 'easeInOutCubic' });
```

- 目标表是**全量替换**，不是合并。提交时会清空现有 `featureStyles` 再写入目标表；没出现在表里的单体将失去自定义样式。
- 适合「全城换色 / 换高度 / 换显隐」，CPU 每帧只写一个 `uBatchMix`；`colorByField` / `setThematicColors` 本身不会自动过渡，需要过渡就自己构造目标表。
- 不要手动 `animator.cancel('batch.mix')`（会停在中间混合值且不提交）；要终止就再调一次 `crossFadeStyles`，或 `finish('batch.mix')` 走完提交。
- 过渡按调用时的网格快照准备，中途新加载的瓦片不参与本次混合。

### 投影过渡

```ts
layer.setProjection('orthographic', { duration: 800, easing: 'easeInOutCubic' });
layer.projection;    // 目标模式，立即更新
layer.projectionT;   // 0 = 纯透视，1 = 纯正交，过渡中在两者之间
```

`projection.t` 是 `S3MLayer` 自己注册到 `viewer.animator` 的通道，打断时从当前插值比例续走。默认曲线 `easeInOutCubic`；`duration` 为 0 且无 `spring` 时立即切换。**正交只作用于本层**，底图 / 地形 / DOM 仍是透视，见[投影](#投影)。

### 相机动画

不要 tween 内部 `viewer.camera`：MapLibre 每帧都会用宿主矩阵覆盖它，表现为抖动。相机一律走宿主：

```ts
map.easeTo({ center, zoom, pitch, bearing, duration: 800 });
map.flyTo({ center, zoom, duration: 1200 });
layer.flyToFeature(smid);   // 内部 map.fitBounds
```

### MapLibre 侧注意事项

- **按需重绘**：动画靠 `animator.onActive` + `render()` 返回值驱动 `triggerRepaint`。不要为了动画去关闭 MapLibre 的按需渲染，也不要自己再开一条 `requestAnimationFrame` 调 `tick()`。
- **GPU 路径会持续重绘**：只要路径库里还有已注册路径，`renderFrame()` 就返回 `true`，即使没有单体绑定或 `uPathTime` 已冻结。暂停 / 结束时应 `unbindGPUPath` 并 `unregisterGPUPath`。
- **`onComplete` 是通道级的**：一次驱动多个字段（`setStyle` 多个键、`animateFeature` 多个属性）会回调多次；需要聚合就自己计数。
- **空闲时零成本**：动画结束后 `renderFrame()` 返回 `false`，帧循环停止；如果发现一直重绘，先查是否有未收敛的 `spring`、已注册的 GPU 路径或未结束的瓦片加载。
- **不要绕过 animator 写 uniform**：动画期间 animator 是唯一写者，公开 API 走 `setStyle` / `animateFeature`。
- **交叉淡化是全量替换**（不是合并）、**opacity 到 0 时整层不绘制**、**GPU 路径的位移只在着色器与包围盒里体现**这三点在调试时最容易被误判成 bug。

---

## 投影

```ts
new S3MLayer({ projection: 'orthographic' })   // 构造时指定
layer.setProjection('orthographic' | 'perspective', { duration: 800 })  // 运行时切换，可平滑过渡
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

### 全局正交（beta，选配）

上面那条 `setProjection('orthographic')` 只把 **S3M 层**换成正交，底图仍是透视，两者差 ≈ 楼高 / 相机距，所以一直建议把底图退掉。如果你要的是「整个场景都是正交」——底图、地形、标记与模型共用同一个相机，那需要直接接管 MapLibre 的投影矩阵：

```ts
import { enableMapLibreOrtho } from 's3m-maplibre';

const ortho = enableMapLibreOrtho(map);   // 安装，默认立即生效
ortho.setEnabled(false);                  // 运行时开关
ortho.reinstall();                        // map.setProjection() 重建 transform 后补装
ortho.dispose();                          // 卸载，恢复原生透视
```

开启后**不要再调** `layer.setProjection('orthographic')`——本层继续用透视模式即可，它拿到的 MVP 本身就是正交的。

**原理**：MapLibre v5 的 `_setProjectionInternal` 是写死的 switch（只有 mercator / globe / vertical-perspective），没有注册入口。但它的矩阵计算是分层的：

```
Transform.calcMatrices()                 ← 基类壳，只算像素常量
  └─ this._callbacks.calcMatrices()      ← 固定为 () => this._calcMatrices()
       └─ MercatorTransform._calcMatrices()   ← 真正的投影矩阵链
```

`_callbacks` 走的是 `this._calcMatrices()`（动态查表），所以覆盖实例上的 `_calcMatrices`，在原始计算之后把整条链按正交重算一遍即可。原实现仍照常执行，`_nearZ / _farZ / _pixelPerMeter / cameraToCenterDistance` 这些中间量直接复用。

矩阵链里唯一需要换的是第一步：

```js
n = perspective(fov, aspect, near, far)   // 原文
n = ortho(-w/2, w/2, -h/2, h/2, …)        // 改成这个
```

因为 `cameraToCenterDistance = 0.5 / tan(fov/2) × height`，这一改动让**中心平面上的投影与透视逐点相同**，只是去掉了近大远小。`viewProj / mercatorMatrix / pixelMatrix / pixelMatrix3D / alignedProjMatrix` 全部按同一条链重算，拾取用的 `pixelMatrix` 也在内。

验证方式（`tests/unit/maplibre-ortho.test.ts`，6 条，纯矩阵）：中心点落在屏幕正中、地面点正交与透视差 < 1e-9、1 world 单位 = 1 像素、高处点不再外扩、`pixelMatrix` 与 `viewProj` 同源、缺 helper 时返回 false 保持透视。

**beta 边界，务必先看**：

- **只验证过 maplibre-gl 5.24**。它依赖 `_calcMatrices`、`_helper._nearZ`、`_viewProjMatrix` 等内部字段，MapLibre 大版本升级**一定会**需要重新核对，属于「升级即回归风险」的耦合。这也是它默认不启用、且放在独立函数而不是 `S3MLayer` 选项里的原因。
- **正交视角本来就不自然**。没有灭点，pitch 一大画面就没有纵深感，斜视下看着"扁"。实践里它适合 `pitch = 0` 的俯视量测、规划图、工程图；不适合当常规漫游视图（这也是 deck.gl 把 `OrthographicView` 归到非地理视图的原因）。
- **标签避让、地形高程、fog 仍按透视语义推导**。符号层用的是另一套 `labelPlaneMatrix` 系，正交下会有位置/避让偏差；地形（`terrain`）没有验证，建议正交时关掉。`queryRenderedFeatures` 的拾取已经一起重算，基本可用。
- `map.setProjection()`（含 `vertical-perspective` / `globe`）会重建 transform 实例，patch 会丢，需要 `reinstall()`。监听 `projectiontransition` 事件后补装即可。
- 切换开关时不会自动触发重算（MapLibre 的矩阵是惰性的），`setEnabled()` 内部已经主动调了一次 `_calcMatrices`，你不需要再手动 `triggerRepaint`。

### 近裁剪面（贴脸看时不消失）

**现象**：相机推进到楼体十几米以内，模型整片消失，退回来又出现。这不是瓦片被隐藏，是**近裁剪面把几何裁掉了**。

MapLibre v5 的 near 是写死的（`transform.ts`，dist 里也能直接看到）：

```js
this._helper._nearZ = this._helper._height / 50;   // 画布高度 / 50，CSS 像素单位
```

投影单位是 CSS 像素，zoom 16.5 / 纬度 31° 时 1 px ≈ 0.72 m，所以 near 平面离相机约 **13 米**。MapLibre 没有公开 API 改它，只能在自定义图层里换一个投影矩阵：

```ts
new S3MLayer({ nearPlaneScale: 0.1 });   // 13 m → 1.3 m，可以贴到墙上看
layer.setNearPlaneScale(0.1);            // 运行时调节；传 1 恢复原样
```

实现上只改透视矩阵的两个元素（其余不动，所以**视场角逐点重合**）：

```
e[10] = -(far + near') / (far - near')
e[14] = -2 · far · near' / (far - near')
```

这等价于把 `left / right / top / bottom` 按 `near'/near` 等比缩放 —— 画面与原画面完全一致，只是近处不再被裁。`near'/far` 比值怎么取：

| 场景 | 建议 |
|---|---|
| 只做城市级漫游，不会贴近建筑 | 不用开（默认 1） |
| 允许相机推近看外立面 | `0.1`（13 m → 1.3 m） |
| 允许进入建筑内部 | `0.02`（13 m → 0.26 m），注意深度精度 |

**代价**：near/far 比值变小会让深度缓冲的非线性变陡，远处可用精度下降，极端值下远景可能出现 z-fighting；另外本层写入的深度值与 MapLibre 地形不再完全同尺度，**近处**的地形遮挡判定会有偏差（远处因为都趋近 1，几乎无差）。所以默认关闭，由接入方按「要不要贴脸看」决定。只作用于透视模式——正交模式的 near 由它自己的视锥构造决定。

---

## 宿主兼容与已知限制

- **遮挡靠的是深度来源，不是「开没开地形」**：本层全程不清深度缓冲（`autoClear = false`），凡是往同一深度缓冲写了更近深度的东西都能遮挡建筑。MapLibre 地形网格与本层（`renderingMode: '3d'`）共用主 framebuffer、同一 `depthRangeFor3D`、同一 `LEQUAL + ReadWrite` 深度模式，所以地形可以遮挡；前提是宿主开启 `map.setTerrain({ source: 'dem' })`、提供 DEM 源，且地形需要有 raster / hillshade 层供图（否则地形面空白）。另外 S3M 数据通常按海拔 0 建模，需要用 `setDatasetHeight()` 把模型抬到真实地面高程，否则深度虽可比但空间位置对不上。不想接 DEM 时用 `setGroundOcclude(true)` 让自带物理地表充当遮挡源（平面一刀切）。
- **物理地表（地下透视 / 基坑）**与 terrain 是两个维度但不是两套机制：前者表达模型自身的地上 / 地下结构覆盖关系，后者表达真实地面的起伏遮挡；两者只是都往同一个深度缓冲写深度。平面代理表达不了山体起伏，而地形已写入更近深度的像素上平面也写不进去，所以地铁站 / 基坑这类没有真实 DEM 的数据靠前者，有 DEM 的山地靠后者。
- **正交投影**需要 MapLibre ≥ 5；v4 / v5 以下（含 Mapbox v2）只给合并矩阵，会告警一次并保持透视，见[投影](#投影)。
- **贴近模型时整片消失**大概率是 MapLibre 的近裁剪面（默认离相机约 13 米）裁的，不是瓦片调度问题：用 `nearPlaneScale` 调，见[近裁剪面](#近裁剪面贴脸看时不消失)。另一条路是瓦片预算——相机贴近会让 LOD 深度暴涨、超过 `hardCap` 后可能强制淘汰正在显示的瓦片（开洞），表现为「局部空洞、过几秒补上」，与近裁剪的「整片空白、退回来立刻恢复」可区分。
- **`layer.viewer.geo` 在 MapLibre 上经常是 `null`，这是正常的**：`createMapLibreGeoAdapter()` 只有从宿主拿到 `WorldCoordinateHelper`（`transform.worldCoordinateHelper` 等 4 个候选位置）时才生效，拿不到就返回 `null`，渲染层自动回退标准 Web 墨卡托——正是 MapLibre 的默认 CRS，数值完全一致。当前 MapLibre 5.24 的 dist 里并没有这个成员，所以在 MapLibre 上这条 adapter 分支实际是空跑的。**自己换算经纬度时不要用 `if (viewer.geo)` 当门槛**，直接用 `worldFromLngLat(viewer.geo, lng, lat)`（`s3m-three` 导出，内部自带兜底），否则会把本来能用的墨卡托路径挡掉。
- **多数据集叠加**应位于同一城市量级（几公里内），跨城市叠加会重新引入 float32 精度问题。

解析 / 几何 / 纹理 / 单体化相关的已知限制（实例化单体样式与拾取、切线流、骨骼动画等）见 [s3m-three 已知限制](../s3m-three/docs/API.md#已知限制)。

---

## 数据与许可

- 本包代码 Apache-2.0。
- 解析 / 纹理 / 几何相关的第三方组件（DXT 解码、crunch wasm、meshoptimizer wasm）随 `s3m-three` 分发，许可见 [s3m-three 数据与许可](../s3m-three/docs/API.md#数据与许可)。
- S3M 规范文本遵循 CC BY-ND 4.0，不得修改规范文本后再发布。
