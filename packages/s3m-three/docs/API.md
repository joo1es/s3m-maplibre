# s3m-three API 参考

> 对应 `s3m-three` 的 `packages/s3m-three/src/index.ts` 导出面

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [`S3MViewer`](#s3mviewer)
- [样式（S3MStyle）](#样式s3mstyle)
- [拾取与属性](#拾取与属性)
- [投影](#投影)
- [按业务字段着色](#按业务字段着色)
- [动画与过渡](#动画与过渡)
- [纯 three.js 使用](#纯-threejs-使用)
- [底层 API](#底层-api)
- [性能调优](#性能调优)
- [已知限制](#已知限制)
- [数据与许可](#数据与许可)

---

## 安装

```bash
npm install s3m-three three
```

`three` 是 peer 依赖，需要宿主项目自己提供（要求 `>=0.155.0`）。下限取 0.155 是因为该版本把光照默认值切成物理单位，更早的 three 会把方向光放大约 π 倍，白模直接过曝。

本包**不 import 任何地图 API**，宿主无关：可以单独用于任意 three 场景，也可以被上层适配层驱动（MapLibre / Mapbox 用法见 [s3m-maplibre](../s3m-maplibre/docs/API.md)，它内部就是在用本包）。

### TypeScript

包内置类型声明（`dist/index.d.ts`），由 TS 源码直接编译产出，开箱可用。公开 API 会暴露 `THREE.Mesh` / `THREE.Group` 等对象，three 自身不带类型声明，需要另装 `@types/three`。

```ts
import { S3MViewer, S3MTileset, STYLE, type PickResult } from 's3m-three';
```

---

## 快速开始

`S3MViewer` 是把场景、相机、灯光、拾取、选中、样式都封好的宿主无关查看器，只差你自己喂帧：

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

完整可运行版本见仓库 `demo/three.js`（一个文件，含轨道控制、切片统计、样式切换）。

---

## 核心概念

### 坐标链路

```
S3M 顶点（数据集局部 ENU，米）
  → 数据集 Group 偏移：把各数据集锚点对齐到「场景锚点」
  → L 矩阵：ENU → Web Mercator 归一化坐标
  → 宿主传入的 mercator→clip 矩阵
```

three 场景原点固定在**场景锚点**（第一个成功加载的数据集的位置），所有顶点只保留「相对锚点的米」。这是 3D Tiles `RTC_CENTER` 的同类做法，目的是避免 float32 在墨卡托大坐标下抖动。

多数据集叠加时，每个数据集一个 `THREE.Group`，用 `position` 承担锚点差。因此**所有数据集应当位于同一城市量级**（几公里内），跨城市叠加会重新引入精度问题。

### 锚点

锚点来自数据集配置的 `position`，但会做一致性校验：若 `position` 与 `geoBounds` 中心偏差超过 0.5°，判定为生产时的占位脏数据，回退到 `geoBounds` 中心。

回退的前提是 `geoBounds` 本身可用（`usableGeoBounds()`）：字段缺失、非有限值、超出经纬度量级、或**退化成全 0 / 一个点**的都算不可用。这条是踩过坑加的——OSGB 那类配置根本没有经纬度范围，全 0 的框反过来把唯一正确的 `position` 判成异常，结果是视角和模型一起跑到几内亚湾。`getBounds()` 同样只统计可用的框，宁可不移动视角，也不甩到 `(0,0)`。

`position` 有两种写法都认：老数据是 `position.x/y/z` + `units`，v3.01 起改成 `position.point3D.{x,y,z}` + `unit`。第二个键名必须认，否则投影单位是米的数据会被当成度。

OSGB（`SuperMapCache` XML）的配置只给 `<sml:Position>`（经纬度原点）和 `<sml:BoundingBox>`（以原点为中心的**米制**局部盒），解析时按等距圆柱近似反算成 `geoBounds`：`Δlon = x / (111320·cos φ)`、`Δlat = y / 110540`。

### 瓦片与 LOD

配置里的 `tiles`（桌面导出）或 `rootTiles`（iServer，可多棵）是瓦片树入口。LOD 按规范里的 `RangeMode` 判定：

| rangeMode | 含义 | 判定 |
|---|---|---|
| 0 | `Distance_From_EyePoint` | 相机到包围球中心距离 < rangeValue 时细化 |
| 1 | `Pixel_Size_OnScreen` | 包围球投影像素半径 > rangeValue 时细化 |
| 2 | `Geometric_Error` | 规范枚举里没有这一档。按屏幕像素半径近似处理 |

关于 2：线上高斯泼溅与点云服务的 pageLOD 全是这一档，且 `rangeValue` 与包围球半径成固定比例（实测根瓦片 `0.664 / 10.455`、子瓦片 `0.332 / 3.7`，比例都约 0.064），更像「相对屏幕的几何误差」而不是绝对像素。按 1 处理方向是对的（近处细化），只是阈值偏小时会多下几层，用 `lodRangeScale` 收。

多骨架瓦片（每块 geode 一个 pageLOD）的 `sphere` / `rangeValue` 取自其中一块，细化判定是整块瓦片共用的；子引用则会把**每个 pageLOD 的 `childTile` 都收集**进 `childUrls`，所以一层细化会正确扇出到 N 块子瓦。

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
const audit = viewer.auditBatches();
// { smids, batches, conflicts: [{ datasetId, batchId, smids }], conflictingSmids }
```

`conflicts` 为空说明这批数据可以放心按单体操作；不为空时，这些单体对应「按 batch 罩层」之类的做法，靠本库的单体化通道做不到。

---

## `S3MViewer`

宿主无关的三维查看器：场景、相机、灯光、uniforms、拾取、选中描边、棱线、高度跟踪、数据集注册全在这里，不依赖任何地图 API。宿主只负责两件事——提供 WebGL 上下文（`mount`）和每帧喂矩阵（`renderFrame`）。

### 构造函数

```ts
new S3MViewer(options?: S3MViewerOptions)
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `configUrl` | `string` | — | 单数据集简写 |
| `datasets` | `S3MDatasetOptions[]` | `[]` | 多数据集叠加 |
| `style` | `Partial<S3MStyle>` | 见[样式](#样式s3mstyle) | 初始样式 |
| `ground` | `GroundOptions` | — | 3D 物理地表面 / 基坑开挖配置 |
| `pickable` | `boolean` | `true` | 是否响应拾取 |
| `maxTiles` | `number` | `64` | 每个数据集驻留瓦片上限，超了淘汰最久没用的（不是停止加载） |
| `maxTriangles` | `number` | `Infinity` | 每个数据集**驻留三角形总数**的软上限（不限制）。`maxTiles` 数不了「一块精模几十万面」，这条按实际面数做刹车，走同一套 make-before-break 淘汰，不开洞 |
| `totalMaxTiles` | `number` | — | 多数据集全局驻留瓦片总预算；开启后在可见数据集间动态均衡分配，防止叠加爆显存 |
| `light` | `LightOptions` | — | 场景光照配置，可配环境光与主平行光的颜色、强度、模式与方位角/高度角 |
| `maxConcurrent` | `number` | `4` | 每个数据集并发请求数 |
| `useWorker` | `boolean` | `true` | 用 Web Worker 解析经典 `.s3mb` 瓦片（inflate / Draco / MeshOpt 全在 Worker 跑，主线程只做 fetch 与几何组装）；Worker 不可用或崩溃时自动永久降级主线程。S3MBLOCK 路径仍主线程解析 |
| （随 `useWorker`）纹理解码 | `boolean` | `true` | DXT / CRN / WEBP 纹理解码与 `.s3mb` 解析共用同一个 Worker（`core/TextureDecode.ts` 三方共用同一份实现，WEBP 走可 transfer 的 ImageBitmap）；失败自动回主线程，产物逐字节一致 |
| （随 `useWorker`）几何组装 | `boolean` | `true` | 顶点解交错 / 法线计算 / 同材质合批合并（`core/TileGeometry.ts`）随解析在 Worker 完成，主线程只做 three 对象包装；Worker 不可用时主线程跑同一份实现，产物一致 |
| （随 `useWorker`）DXT 压缩直传 | 自动 | 自动 | 宿主 GL 同时支持 `WEBGL_compressed_texture_s3tc`(+srgb) 时，dxt1/dxt5（含 CRN 转码产物）不解码直接 `CompressedTexture` 上传，显存与上传带宽降为 1/4~1/8；块长与 4×4 对齐公式不符、flipY 图集、移动端无扩展时自动回退 RGBA 解码 |
| `lodRangeScale` | `number` | `1.0` | LOD 切换距离缩放系数，> 1 更倾向保留粗模，< 1 提前细化 |
| `lodPixelRatioCap` | `number` | `Infinity` | LOD 判定屏幕高度的 **DPR 上限**（不截断）。默认按 `canvasHeight` 物理像素算，与官方 `calcPixFromCam` 同口径；3x DPR 手机上由此会多细化、多拉瓦片，传 `2` 即按「CSS 高度 × 2」截断 |
| `anisotropyCap` | `number` | `Infinity` | 各向异性过滤上限（不封顶 = 取 GPU 最大值，通常 16）。移动端封到 4 / 8 肉眼通常无差，采样成本明显下降。只影响之后创建的纹理 |
| `maxTextureSize` | `number` | `Infinity` | 纹理长边像素上限（不限制）。非图集的 RGBA / WebP 产物按 2× 盒式滤波减半到上限内；DXT 压缩直传与图集不受影响 |
| `buildTile` | `BuildTileFn \| null` | — | 自定义瓦片构建器（测试 / 服务端渲染时注入） |
| `attributes` | `AttributeQueryOptions` | — | 业务属性查询配置，配了才能 `colorByField()`，见[按业务字段着色](#按业务字段着色) |
| `onRequestRepaint` | `() => void` | — | 宿主请求重画的信号：纯 three 宿主接自己的渲染循环 |
| `getBearing` | `() => number` | — | 地图朝向（弧度），让灯光跟着视角走；不传则灯光方向固定 |
| `onStats` | `(s: Stats) => void` | — | 统计更新 |
| `onReady` | `(entry) => void` | — | 某个数据集就绪 |
| `onPick` | `(f: PickResult \| null) => void` | — | 拾取结果 |
| `onError` | `(e: unknown) => void` | — | 瓦片加载 / 解析错误 |
| `prewarmShading` | `boolean` | `true` | 首帧后自动预热另一种 `shading` 变体，避免首次切换时现场编译着色器卡一帧。见[样式过渡](#样式过渡) |

`configUrl` 与 `datasets` 二选一；同时给时以 `datasets` 为准。

### 挂载与帧驱动

```ts
mount(canvas: HTMLCanvasElement, gl: WebGLRenderingContext | WebGL2RenderingContext): void
unmount(): void
renderFrame(opts: {
  mvp: ArrayLike<number>;              // 宿主本帧的 world→clip 矩阵（ Mercator 归一化 → clip ）
  cameraEnu: [number, number, number]; // 相机在场景 ENU 中的位置（米）
  fovRad: number;                      // 本帧垂直视场角（弧度）
  canvasHeight: number;                // 绘图缓冲高度，供 LOD 屏幕误差计算
}): boolean                            // 返回 true = 本帧有变化，宿主应继续驱动下一帧
prewarmShading(): Promise<void>        // 手动预热另一种 shading 变体（默认已在首帧后自动做一次）
```

`mvp` 由宿主负责给出：地图宿主（如 s3m-maplibre）从 `render()` 入参提取；纯 three 宿主用自己的投影 × 视图矩阵。viewer 会在其后再乘 ENU → Mercator 矩阵，所以**传进来的 mvp 作用在 Mercator 归一化坐标上**，不是场景米制坐标。

`geo` 是可写的 `GeoAdapter | null`：`null` 用内置的墨卡托兜底（`worldFromLngLat` / `lngLatFromWorld`），地图宿主注入适配器以支持任意 CRS / 自定义投影。

### 数据集管理

```ts
addDataset(ds: S3MDatasetOptions): Promise<S3MDatasetEntry>
removeDataset(id: string): void
clearDatasets(): void
setDatasetVisible(id: string, visible: boolean): void
recomputeAnchors(): void                    // CRS 切换 / geo 重注入后重算锚点与 offset
getDatasetHeight(id?: string): number
setDatasetHeight(idOrHeight: string | number, heightOffset?: number): void
setDatasetAlign(idOrAlign: string | DatasetAlignment, align?: DatasetAlignment): void
computeAlignOffset(tileset: S3MTileset | null, align?: DatasetAlignment): number
```

```ts
interface S3MDatasetOptions {
  id: string;           // 唯一标识
  name?: string;        // 展示名
  configUrl: string;    // .scp 地址
  visible?: boolean;    // 默认 true
  maxTiles?: number;    // 覆盖 viewer 级配置
}
```

`addDataset` 在 `mount()` 之前调用会抛错（此时还没有 WebGL 上下文）。

**垂直高程的两个独立通道**：

| 通道 | 含义 | 改它会影响什么 |
|---|---|---|
| `baseAlignOffset` | 由 `align` 语义算出的基准偏移（`'origin'` / `'bottom'` / `'top'` / `'center'`） | 换基准时自动重算，用户偏移原样保留 |
| `userOffset` | 应用层设置的附加偏移（贴地高程、手动微调） | `setDatasetHeight` 只改这一项 |

最终落位 = `baseAlignOffset + userOffset`。

`setDatasetHeight(id, h)` 语义是**「在当前 align 基准之上再抬升 h 米」**，不覆盖 align 基准。所以把模型贴到真实地面高程（`setDatasetHeight(id, 40)`）不会破坏 `align='top'` 的「顶部对齐地表并下沉」语义；`setDatasetAlign` 切换基准时手动偏移也原样保留。

`getDatasetHeight(id?)` 返回的是 `userOffset`（不含 align 基准）。

### 样式与棱线

```ts
setStyle(patch?: Partial<S3MStyle>, transition?: TransitionOptions): void
getStyle(): S3MStyle & { modeLabel: string }
setOpacity(opacity: number, transition?: TransitionOptions): void
setEdges(enabled: boolean, transition?: TransitionOptions): void
```

`transition` 用来给能插值的字段加过渡，语义见[动画与过渡](#动画与过渡)；不传则和旧版一样即时生效。

`setStyle` 是**合并**语义，只传要改的字段。除了 `shading`（编译期宏，需重编译着色器）、`edges` / `edgeThreshold`（结构变更，走 `setEdges` / 重建棱线）之外，其余字段都是 uniform / 材质状态更新，热切换成本很低。

棱线优先用**数据自带的棱线包**（`primitiveType === 13` 的索引包）：解析时就建好 `LineSegments`，开关只是切 `visible`，成本为零。数据里没有时才用 `EdgesGeometry` 在 CPU 端现算（8ms 一帧切片，超过 12 万索引直接跳过）。棱线画成**屏幕空间等宽线**（`packages/s3m-three/src/render/EdgeLines.ts`）：WebGL 的 `lineWidth` 恒定 1px，只有把每条棱摊成面向屏幕的四边形才能真的调粗细。

> 注意：棱线包**不能**当三角面画。把它当 `TRIANGLES` 提交，每条棱线都会被连成一根几十上百米的尖刺。

### 光照控制 (Adjustable Lighting)

```ts
setLight(patch: Partial<LightOptions>): void
getLight(): LightOptions
```

```ts
interface LightOptions {
  /** 环境光颜色，默认 0xffffff */
  ambientColor?: number | string;
  /** 环境光强度，默认 0.8 */
  ambientIntensity?: number;
  /** 主平行光颜色，默认 0xffffff */
  mainColor?: number | string;
  /** 主平行光强度，默认 0.9 */
  mainIntensity?: number;
  /**
   * 光照模式：
   * - 'headlamp': 头灯模式（默认）。平行光方向随相机视线/地图航向角 (bearing) 旋转，始终保持从观察者斜上方照射。
   * - 'fixed': 固定世界坐标方位。模拟真实太阳光照射，方位角与高度角在世界空间保持固定。
   */
  mode?: 'headlamp' | 'fixed';
  /** 方位角（弧度，默认 0.5）。headlamp 模式为相对视线夹角；fixed 模式 0 为正北 */
  azimuth?: number;
  /** 高度角/仰角（弧度，默认 0.8，约 46°） */
  altitude?: number;
}
```

调用 `setLight` 会即时更新场景光源并自动触发重新绘制（`triggerRepaint()`）。

### 单体样式与状态

```ts
setFeatureStyle(smid: number, style: FeatureStyle): void
setFeaturesStyle(smids: number[], style: FeatureStyle): void
getFeatureStyle(smid: number): FeatureStyle | null
getFeatureStyles(): Map<number, FeatureStyle>
removeFeatureStyle(smid: number): void
clearFeatureStyles(): void
flushOverrides(): void          // 手动刷脏标记（紧接着读纹理 / 截图 / 导出前用）
getAllMeshes(): THREE.Mesh[]    // 当前驻留的全部网格
```

`FeatureStyle.opacity` 支持单体独立透明度（batch 粒度）：写入状态纹理第 2 行 alpha，片元里与全局透明度、贴图 alpha 叠乘。约定 `0 < opacity < 1` 生效，`opacity <= 0` 等价 `hidden`，`1` / 不传 = 不覆盖；有淡化单体时该块材质自动开混合，清除后还原为全局透明度语义。与 LOD / 拾取 / 描边兼容（淡化只是改像素 alpha，不参与深度剔除）。

### 字段着色 / 过滤 / 抬高

```ts
setAttributeSource(options: AttributeQueryOptions | null): void
getLoadedSmids(): number[]
auditBatches(): BatchAudit
getThematicField(): string | null
setThematicColors(colors: Map<number, string> | null, field = 'custom'): void
clearThematic(): void
getFilterField(): string | null
filterByField(options: FieldFilterOptions): Promise<FieldFilterResult>
clearFieldFilter(): void
getElevationField(): string | null
elevateByField(options: FieldElevationOptions): Promise<FieldElevationResult>
setThematicElevation(elevations: Map<number, number> | null, field = 'custom'): void
clearThematicElevation(): void
colorByField(options: ColorByFieldOptions): Promise<ThematicResult>
setFilter(filter: S3MFilter | null): void
getFilter(): S3MFilter | null
clearFilter(): void
```

详见[按业务字段着色](#按业务字段着色)。

### 3D 物理地表与基坑

```ts
setGroundMode(mode: GroundMode): void
setGroundOpacity(opacity: number): void
setGroundOcclude(enabled: boolean): void
setExcavationBounds(bounds: [number, number, number, number] | null): void
```

自带的物理地表网格锚定在**场景 ENU 高程**，解决的是「模型自身地上 / 地下结构的物理覆盖与透视关系」（地铁站、基坑这类数据没有真实地表 DEM 可用）：

- `'translucent'` 半透明地表，地下结构透过地表显现（遮挡默认关闭）
- `'excavate'` 基坑范围内片元 `discard` ⇒ 挖空井口，坑外地下部分被地表挡住（遮挡默认开启）

**遮挡是独立开关**（`ground.occlude` / `setGroundOcclude`），且**与地表模式解耦**：`mode: 'none'` 时也可以单独开启 —— 不显示任何地表，只留一块隐形地面把地面以下切掉。它由一块 `colorWrite = false`、`renderOrder = -1000` 的纯深度代理完成——遮挡是在片元绘制那一刻由深度测试决定的，半透明覆盖网格排在 transparent 队列末尾，写不写深度都挡不住已经画完的建筑。开挖模式下代理会在坑口同步开洞，否则井口就白挖了。

**地表高度默认跟随主数据集抬升量**（`ground.trackHeight`，默认 `true`）：贴地时模型整体抬到地面高程，切割面必须跟到同一高程，否则整个模型被齐根切掉。设为 `false` 则钉死在当前高度——高程调整只动模型不动切割面，适合「调埋深 / 控制切掉多少」的交互。

它与 MapLibre terrain 不存在替代关系，但也不是互斥的两套机制：两者都只是往同一个深度缓冲里写深度，谁更近谁赢。terrain 表达「真实世界地面的起伏遮挡」，物理地表代理表达「模型自身的一刀切地上 / 地下语义」——平面表达不了山体那种半山腰遮挡，而地形已写入更近深度的像素上，平面代理也写不进去。贴地（`setDatasetHeight`）后物理地表网格的高度会跟随主数据集的抬升量自动同步，保证覆盖关系不错位。

### 拾取与空间查询

```ts
pick(x: number, y: number): PickResult | null
pickPosition(x: number, y: number): { lngLat: [number, number]; altitude: number; point: [number, number, number] } | null
drillPick(x: number, y: number, limit?: number): PickResult[]
getRayAt(x: number, y: number): THREE.Ray | null
select(result: PickResult | null, opts?: { silent?: boolean }): void
getFeatureBounds(smid: number): [[number, number], [number, number]] | null
```

坐标是**相对 canvas 左上角的 CSS 像素**（宿主适配层负责把鼠标事件换算过来）。返回值结构见[拾取与属性](#拾取与属性)。

拾取走 GPU：把「物体编号 + batchId」编码成 RGBA 渲染到 **1×1** 离屏目标再读那一个像素——viewport 仍是整块画布、原点平移到点击点，于是整幅画面按原样光栅化，只有点击点那一格落在目标上。代价与三角面数无关，且天然只命中最前面的可见面。

### LOD 与统计

```ts
setLodRangeScale(scale: number, datasetId?: string): void
readonly lodRangeScale: number
setLodPixelRatioCap(cap: number): void        // Infinity = 不截断（默认）
readonly lodPixelRatioCap: number
setMaxTriangles(n: number, datasetId?: string): void   // Infinity = 不限制（默认）
readonly maxTriangles: number
setAnisotropyCap(cap: number): void           // Infinity = 取 GPU 最大值（默认）
readonly anisotropyCap: number
setMaxTextureSize(n: number): void            // Infinity = 不限制（默认）
readonly maxTextureSize: number
readonly stats: Stats
readonly fps: number
getBounds(): [[number, number], [number, number]] | null  // 合并经纬度范围
```

`lodPixelRatioCap` 只在**有限值**时才去读 `canvas.clientHeight`，默认状态下不产生任何额外开销；离屏 canvas（`clientHeight` 为 0）自动退回物理像素口径。截断会把每块瓦片的屏幕投影放大同样倍数，几何误差与纹理密度同步变差，取舍见[性能调优](#性能调优与显存管理)。

```ts
interface Stats {
  tiles: number; loading: number; failed: number;
  meshes: number; vertices: number; triangles: number; datasets: number;
}
```

### 投影

```ts
// S3MViewer 不提供投影切换：内核只消费宿主传入的 mvp。
// 需要正交时由宿主自行替换 mvp；s3m-maplibre 的 S3MLayer 封装了 setProjection(..., transition?)。
```

内核只消费宿主给的 `mvp`；正交 MVP 由宿主在传入前自行替换，数学工具（`buildOrthoMVP` / `extractFovRadians` / `extractNearFar` / `extractProjectionMatrix`）从本包导出，见[投影](#投影)。

### 释放

```ts
dispose(): void
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
  edgeThreshold?: number; // 棱线临界角（度，默认 55）：相邻面法线夹角超过它才描边，调大滤掉浅坡
  roofThreshold?: number; // 顶面法线判定阈值，默认 0.65
  fadeIn?: number;      // 新瓦片淡入时长（毫秒，默认 0 = 关闭）
}
```

### 着色模式

| 常量 | 值 | 说明 |
|---|---|---|
| `STYLE.WHITE` | 0 | 白模：忽略贴图与顶点色，纯色 + 光照 |
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

主光与补光方向**每帧跟随 `getBearing` 回调重算**（主光在镜头后上方偏左 150°、仰角 50°；补光偏右 215°、仰角 30°）。相当于一盏头灯，保证任意旋转角度下白模都是受光的，不会转到背光面就一片死灰。

如果你需要固定的物理太阳方向，可以自行替换 viewer 内部的 `_keyLight` / `_fillLight`（非公开 API，升级可能变化）。

---

## 拾取与属性

```ts
interface PickResult {
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
new S3MViewer({
  onPick: async (f) => {
    if (!f?.smid) return;
    const info = await fetch(`/api/building/${f.smid}`).then((r) => r.json());
    showPanel({ ...f, ...info });
  },
});
```

---

## 投影

内核消费的是宿主给的 `mvp`（Mercator 归一化 → clip），不区分透视 / 正交——**正交 MVP 由宿主在传入前自行替换**。MapLibre 宿主（s3m-maplibre 的 `S3MLayer`）的做法是：MapLibre ≥ 5 的 `render()` 入参会把 `projectionMatrix`（view→clip）和 `modelViewProjectionMatrix`（world→clip）分开给，视图矩阵可以精确解出来：

```
V = P⁻¹ × MVP
正交 MVP = P_ortho · V ，P_ortho 半高 = 相机距 × tan(fov/2)
```

半高取「目标深度处透视视锥的半高」，于是正交与透视在目标平面上逐点重合；zoom 改的是相机距离，距离减半 = 半高减半 = 放大一倍，pan / pitch / rotate 与透视手感一致。拾取、选中描边、按单体着色 / 隐藏 / 抬高都读同一个相机，自动跟随，不需要额外适配。

边界：

- 解出的视图矩阵会做刚体校验（3×3 正交、底行 `[0,0,0,1]`）；校验不过说明两个输入矩阵不同源，同样退回透视并告警。
- MapLibre < 5 只给合并矩阵，解不出独立投影矩阵，宿主会 `console.warn` 一次并保持透视，不会静默画错。

底层数学在 `packages/s3m-three/src/render/OrthoProjection.ts`，从包入口导出（`buildOrthoMVP` / `extractFovRadians` / `extractNearFar` / `extractProjectionMatrix`），`npm test` 里的 `tools/test-ortho.mjs` 用合成矩阵钉住：视图矩阵还原、目标平面重合、正交语义、zoom 映射、near/far 深度映射、三类非法输入拒绝。

---

## 按业务字段着色

S3M 瓦片里**只有单体 ID**（SMID）和顶点区间，没有任何业务字段；业务属性在 iServer 的**数据服务**里（`data-xxx/rest/data`），和三维服务（`3D-xxx/rest/realspace`）是两个服务。所以按字段着色是「三维 + 数据」的跨服务查询，需要单独配一个数据源。

```ts
const viewer = new S3MViewer({
  configUrl: '.../jingmo.scp',
  attributes: {
    dataServiceUrl: 'https://host/iserver/services/data-xxx/rest/data',
    datasetName: 'DataSource:zhoubian',   // 数据源:数据集，只写数据集名时默认补 DataSource:
    // idField 默认 SmID，对应 scp 里的 idFieldName
  },
});

// 分类字段：同一取值同色
const result = await viewer.colorByField({ field: 'KEYID', type: 'category' });

// 数值字段：连续色带 / 按阈值分级
await viewer.colorByField({ field: 'SmMaxZ', type: 'ramp' });
await viewer.colorByField({ field: 'SmMaxZ', type: 'breaks', breaks: [10, 30, 60] });

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
viewer.setThematicColors(new Map([[423, '#ef4444'], [424, '#22c55e']]));
viewer.clearThematic();
```

`AttributeQuery` 也能单独用（不依赖 viewer）：

```ts
import { AttributeQuery } from 's3m-three';

const query = new AttributeQuery({ dataServiceUrl, datasetName: 'DataSource:zhoubian' });
const schema = await query.loadSchema();          // [{ name: 'SmID' }, ...]，也能用来判断有没有属性表
const rows = await query.queryBySmids([423, 424]); // Map<smid, { SmID, ENTITYID, KEYID, ... }>
```

拾取结果里的 `attributes` 不在 `PickResult` 上：`pick()` 只负责拿 SMID，业务字段要按 SMID 再查一次。demo 里的属性卡就是这么补的（点楼 → 查 `featureResults` → 追加字段行）。

### 过滤 / 抬高

同一份属性除了上色，还能直接拿来过滤和抬高——都是「查一次字段 → 写进每网格的单体状态纹理」，不重建几何、不重编译着色器。

```ts
// 只显示 30~80 米之间的建筑
await viewer.filterByField({ field: 'SmMaxZ', min: 30, max: 80 });

// 按编码精确匹配（values 按 String(value) 比）
await viewer.filterByField({ field: 'KEYID', values: ['C10100SVK57YDUALQHRR00'] });

// 反过来：隐藏 20 米以下的
await viewer.filterByField({ field: 'SmMaxZ', max: 20, mode: 'hide' });

// 自定义条件
await viewer.filterByField({ field: 'SmMaxZ', keep: (v) => Number(v) > 100 });

viewer.clearFieldFilter();   // 恢复全量，不影响 setFilter() 的规则

// 抬高：字段值 × 倍率（米）
await viewer.elevateByField({ field: 'SmMaxZ', scale: 0.5 });

// 或者自己映射，第二个参数是数据分布
await viewer.elevateByField({
  field: 'SmMaxZ',
  map: (v, r) => ((v - r.min) / (r.max - r.min)) * 200,
  max: 120, // 封顶
});
viewer.clearThematicElevation();
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

## 动画与过渡

> 设计取舍与性能模型见仓库内 `packages/s3m-three/docs/ANIMATION.md`；本节是面向调用方的 API 契约。

动画系统只有一个判据：

> **能不能在不碰 material / program / geometry 的前提下，用一个 float 把这一帧画出来？**

能，就走 `Animator` 逐帧插值，成本 O(1)（单体是 O(受影响网格)）；不能，就只能编排「淡出 → 换 → 淡入」，不要试图对结构做插值。

三条必须知道的约定：

1. **单一写者**：每帧只有 `Animator.tick()` 写渲染状态。公开 API 只写目标值，所以 `getStyle()` 会立刻返回终值，屏幕上的值由 `viewer.style` / uniforms 逐步推进。
2. **同 key 覆盖，不排队**：连续调用不会积压，新动画从**当前显示值**续走。
3. **空闲零成本**：没有活跃 track 时 `tick()` 第一行就返回 `false`，宿主据此停止重绘。

### 快速开始

```ts
import { S3MViewer, STYLE, Path } from 's3m-three';

const viewer = new S3MViewer({ /* ... */ });

// 样式过渡：能插值的字段走动画，不能插值的仍即时生效
viewer.setStyle({ colorA: '#ef4444', opacity: 0.6 }, { duration: 600, easing: 'easeOutCubic' });
viewer.setOpacity(0.5, { duration: 400 });

// 单体：抬高与变色各走一条通道，互不覆盖
viewer.animateFeature(smid, { elevation: 120, color: '#ef4444' }, { duration: 800 });
viewer.animateFeatures(smids, { opacity: 0 }, { duration: 500, stagger: 8 });

// 位移 / 姿态
viewer.moveFeature(smid, [120, 0, 0], { duration: 1200, easing: 'easeInOutCubic' });
viewer.rotateFeature(smid, Math.PI / 2, [pivotX, pivotY, 0], { duration: 600 });

// 沿折线运动（弧长参数化）
viewer.followPath(smid, [[0, 0, 0], [80, 0, 0], [80, 60, 0]], {
  duration: 6000,
  loop: true,
  offset: [baseX, baseY, 0],
});
viewer.stopPath(smid);

// 整批换色 / 换高度：双纹理交叉淡化（目标表是全量替换，先复制现有表）
const nextStyles = new Map(viewer.getFeatureStyles());
nextStyles.set(smid, { ...(nextStyles.get(smid) ?? {}), color: '#22c55e' });
viewer.crossFadeStyles(nextStyles, { duration: 800 });

// 结构变更：只能编排
viewer.setEdges(true, { duration: 400 });
await viewer.setMode(STYLE.HEIGHT, { duration: 300, dim: 0.35 });

// 调度器直连
viewer.animator.cancel('style.opacity');   // 停在当前值
viewer.animator.finish('style.opacity');   // 直接到终值
```

### 过渡参数（TransitionOptions）

```ts
interface TransitionOptions {
  /** 时长（毫秒）。0 / 不传 = 立即生效 */
  duration?: number;
  /** 延迟（毫秒） */
  delay?: number;
  /** 缓动曲线：内置名或自定义 (t) => number。默认 'linear' */
  easing?: EasingName | EasingFn;
  /** 打断策略，默认 'proportional' */
  retarget?: 'proportional' | 'fixed';
  /** 弹簧。给了它就忽略 duration / easing */
  spring?: { stiffness: number; damping: number; epsilon?: number };
  /** 批量错峰间隔（毫秒），仅 animateFeatures 消费 */
  stagger?: number;
  /** 自然结束或 finish() 时回调；cancel() 不调用 */
  onComplete?: () => void;
}
```

- **`duration: 0` 且没有 `delay` / `spring` 时立即写入**，不建 track；带 `delay` 仍会建 track，延迟结束后瞬间到位。`animator.to()` 的立即分支会同步调用 `onComplete`，但 `setStyle` / `setEdges` 的即时分支不会回调；要确保回调触发，就给一个大于 0 的时长、加 `delay`，或自己调用。
- **`easing` 首次默认 `linear`；retarget 时省略 `easing` 会沿用该通道上一次的曲线**（不是重置成 linear）。要固定观感就每次都显式传。
- **`onComplete` 是通道级的**：一次调用驱动 N 条通道（例如 `setStyle({ colorA, opacity }, ...)` 或 `animateFeature` 同时改多个属性），回调就会在各通道结束时各触发一次。需要「全部结束只回调一次」就自己在调用方计数，或拆成多次单属性调用。retarget 时旧的 `onComplete` 会被新调用的值覆盖（不传就是清空）。
- **打断保速**（`retarget: 'proportional'`，默认）：新时长为 `base × 剩余距离 / 总距离`，并夹在 `[15%, 100%] × base`；`base` 是本次传入的 `duration`，不传则沿用上一次。只差 1% 的修正不会也走完整 600ms。`'fixed'` 则每次都走完整时长。
- **spring**：没有时长概念，靠物理收敛，中途改目标位置和速度都连续。收敛判据是位移与速度同时小于 `epsilon`（默认 `1e-3`），判定后 track 结束；`epsilon` 设得过小会长时间不收敛，让 `tick()` 一直返回 `true`。典型 `{ stiffness: 120, damping: 14 }`。
- **一次调用的参数对所有通道生效**。要「透明度 800ms、颜色 200ms」，分两次 `setStyle` 调用，不要指望一个对象里逐通道配置（目前没有 per-channel transition 表）。
- `easing` 默认是 **`linear`**，不是 CSS 的 `ease`。想要网页常见手感就显式写 `easeInOutCubic` / `cubicBezier(...)`。

#### 曲线库

```ts
import { easing, cubicBezier, steps, EASING_NAMES } from 's3m-three';

easing('easeOutCubic');
cubicBezier(0.4, 0, 0.2, 1);   // 与 CSS cubic-bezier() 数值对齐
steps(6, 'end');                // 6 档离散跳变
easing((t) => t * t);           // 自定义曲线：(t: number) => number
EASING_NAMES;                   // 全部内置名，适合生成下拉框
```

内置 31 条：`linear`，以及 `{In, Out, InOut} × {Quad, Cubic, Quart, Quint, Sine, Expo, Circ, Back, Elastic, Bounce}`。名字拼错会直接抛错，不会静默退化成「没动画」。自定义曲线约定 `0 → 0`、`1 → 1`；库不做钳制。

打断时缓动会从 `t=0` 重新起算。`easeOutCubic` 恰恰是起点速度最大，方向突变会有点「顿」；连续拖拽 / 跟随类交互优先用 `spring`，或者把 `retarget` 保速交给默认策略。

### 样式过渡

```ts
setStyle(patch?: Partial<S3MStyle>, transition?: TransitionOptions): void
setOpacity(opacity: number, transition?: TransitionOptions): void
setEdges(enabled: boolean, transition?: TransitionOptions): void
setMode(mode: StyleMode, opts?: { duration?: number; dim?: number }): Promise<void>
```

已注册的样式通道（其余键即使带了 `transition` 也即时生效）：

| 通道 | 维度 | 写回 |
|---|---|---|
| `style.opacity` | 1 | 共享 `uOpacity`；混合开关只在跨 `0.999` 时切一次 |
| `style.colorA` / `colorB` / `colorC` / `selectColor` / `edgeColor` | 3 | 线性空间 RGB |
| `style.texMix` / `floorHeight` / `selectOpacity` / `selectEmissive` / `selectElevation` / `dimFactor` / `roofThreshold` / `ambientGain` / `edgeWidth` / `edgeOpacity` / `outlineWidth` | 1 | 直接写 uniform / 字段 |
| `style.edgeFade` | 1 | 棱线淡入乘子，`setEdges` 内部使用 |
| `style.fade` | 1 | 整体压暗乘子，`setMode` 内部使用 |

**不能插值的字段**：`mode`（用 `setMode`）、`shading`（编译期变体，切换会取预热好的 program）、`edges`（用 `setEdges`，走 `uEdgeFade` 淡入淡出）、`edgeThreshold`（要重建棱线几何）、`selectMode` / `outline` / `outlineStyle` / `outlineColor` / `outlineWidthPx`、`speed` / `depthWrite` / `fadeIn`。它们会即时生效，过渡参数对它们无效。

几个容易误解的点：

- **颜色在线性空间插值**。端点严格吻合，但中间色比 CSS 的 sRGB 过渡更亮、更灰。目前没有 `colorSpace: 'srgb'` 开关；要 CSS 观感就自己算中间色再分段 set，或接受这个差异。
- **`getStyle()` 返回目标值**，动画进行中也一样。判断「现在显示到哪」读 `viewer.style` 或对应 uniform，不要拿 `getStyle()` 做帧间逻辑。
- **全局透明度允许到 0**。`setOpacity(0)` 就是彻底看不见：`uOpacity` 写 0，同时 `renderFrame()` 跳过本层绘制——**不画颜色也不写深度**，所以不会出现「看不见却把底图挡出一个洞」的经典问题。`getStyle().opacity` 与屏幕值一致。
- **`transparent` 只在跨阈值时切一次**，不会逐帧抖 program。但「从 1 到 0.5」的第一帧仍会有一次 program 切换/编译，几十毫秒级的首帧卡顿落在这里。
- **`setEdges(true, { duration })` 只对屏幕空间等宽棱线做 `uEdgeFade` 淡入**：几何仍旧 8ms 一片地建，建好一块亮一块。数据自带的线段包是直接切 `visible`，不会淡入。关闭时淡完才 `dispose`，避免「啪」一下消失。
- **`setMode` 是压暗 → 换 → 亮回来**：`duration` 默认 300ms，`dim` 默认 0.35（夹在 0.05~1），Promise 在亮回来后 resolve。重复调用靠代次号作废旧编排；切到当前模式是空操作。`uFade` 与 `dimFactor` 是两条独立通道，不会打架。
- **`fadeIn` 只作用于之后新加载的瓦片**（首次加载 / LOD 换瓦），不是「当前瓦片淡入」。默认 0；开启后淡入期间瓦片进透明队列，几百块同时淡入有一小段额外开销。

### 单体动画

```ts
animateFeature(smid: number, style: Partial<FeatureStyle>, transition?: TransitionOptions): void
animateFeatures(smids: number[], style: Partial<FeatureStyle>, transition?: TransitionOptions): void
moveFeature(smid: number, translation: [number, number, number], transition?: TransitionOptions): void
moveFeatureBy(smid: number, delta: [number, number, number], transition?: TransitionOptions): void
rotateFeature(smid: number, rotation: FeatureStyle['rotation'], pivot?: [number, number, number], transition?: TransitionOptions): void
rotateFeatureBy(smid: number, deltaRotation: number | [number, number, number], pivot?: [number, number, number], transition?: TransitionOptions): void
```

`animateFeature` 能动画的属性：

| 字段 | 通道 | 维度 | 说明 |
|---|---|---|---|
| `translation` | `feature.<smid>.translation` | 3 | 相对原始位置的**绝对**偏移（米，数据集局部 ENU：x 东 / y 北 / z 天；多数据集相对各自锚点） |
| `elevation` | `feature.<smid>.elevation` | 1 | 单体垂直拔高（米） |
| `opacity` | `feature.<smid>.opacity` | 1 | 单体透明度（batch 粒度；`<= 0` 等价 `hidden`） |
| `color` | `feature.<smid>.color` | 3 | 单体自定义色，线性空间插值 |
| `rotation` | `feature.<smid>.rotation` | 3 | 姿态旋转（欧拉角分量插值） |

- **每个属性一条独立通道**，同一单体「一边抬高一边变色一边平移」互不覆盖。重复设置同一属性会 retarget，不会排队。
- **`translation` 是绝对偏移**，不是增量。增量用 `moveFeatureBy`；它的起点读当前 `translation`，连续调用会累加。
- **`rotation` 的写法**：`number` = 绕 Z 轴（天向）的弧度；`[rx, ry, rz]` = 欧拉角；`[x, y, z, w]` = 四元数；也接受 `THREE.Euler` / `Quaternion` / `Matrix3` / `Matrix4`。`pivot` 是**局部坐标**的旋转轴心，默认 `[0,0,0]`——绕模型原点转通常会把楼甩出去，记得传包围盒中心。
- **旋转按欧拉角三分量线性插值**。目标与当前相差接近 ±π 时可能走「长边」。连续自转别用一次性大角度，改用 `rotateFeatureBy` 每次加小角度，或拆成多段。
- **`hidden` 不可插值**，会立即生效。要「淡出再隐藏」：
  ```ts
  viewer.animateFeature(smid, { opacity: 0 }, {
    duration: 300,
    onComplete: () => viewer.setFeatureStyle(smid, { hidden: true }),
  });
  ```
- **`stagger` 只被 `animateFeatures` 消费**：第 i 个单体的延迟 = `delay + i × stagger`。一万个单体错峰 8ms，总时长不变，但每帧只推进一小批，峰值自然摊平。
- **位移 / 旋转会自动关掉受影响网格的 `frustumCulled`**，否则移出原始包围球后整块瓦片会凭空消失；值回到 0 时恢复。
- **未加载的 smid 也会保留目标样式**，等对应瓦片加载后自动套用。通道写入对空网格是无害的。
- **`removeFeatureStyle` / `clearFeatureStyles` 会回收该单体的全部通道**，动画随之中断（不会回调 `onComplete`）。

`FeatureStyle` 里剩下的 `hidden` 是即时字段；`gpuPath` 不通过 `animateFeature` 驱动，见下一节。

### 路径运动（CPU）

```ts
class Path {
  constructor(points: ArrayLike<number> | Array<[number, number, number]>, opts?: { closed?: boolean });
  readonly length: number;                       // 总弧长（米）
  sample(s: number, out: Float32Array | number[]): void;   // 按已走距离取点
  sampleAt(t: number, out: Float32Array | number[]): void; // 按归一化进度取点
}

followPath(smid, points: Path | ArrayLike<number> | Array<[number, number, number]>, opts?: PathFollowOptions): void
stopPath(smid: number): void
```

```ts
interface PathFollowOptions {
  duration?: number;          // 走完全程的时长（毫秒）
  speed?: number;             // 线速度（米/秒）；给了 duration 就以 duration 为准
  loop?: boolean;             // 循环
  closed?: boolean;           // 折线首尾相连（传 Path 实例时无效，构造时决定）
  easing?: EasingName | EasingFn;  // 作用在**已走距离**上，默认 linear（恒速）
  offset?: [number, number, number]; // 路径整体偏移（米）
  onComplete?: () => void;    // 非循环走完时回调
}
```

- 缓动作用在**弧长**上，不是顶点索引。顶点疏密不均也不会忽快忽慢；`easeInQuad` 半程只走 1/4 距离。
- `duration` 与 `speed` 都不给时默认 2000ms。`speed` 按米/秒换算时长。
- 路径点是**数据集局部 ENU 米坐标**（相对该单体所属数据集的锚点；单数据集时就是场景 ENU），不是经纬度；`offset` 相当于路径原点。落点写进 `translation`，所以拾取、选中描边、棱线会整体跟随。
- `loop: true` 时每次走完从起点重来（进度通道的 `read` 恒为 0）；`onComplete` 只在非循环时回调。闭合路径 + 循环才是无缝的。
- 对同一 smid 再次 `followPath` 也会从新路径的**起点**重新开始，不是从当前位置接续；要接续就先 `stopPath`，自行裁掉已走路段并换算 `offset`。
- `stopPath` 停在当前位置并回收通道，不回弹。零长路径直接忽略，不建 track。
- **不要和 `moveFeature` 同时驱动同一个单体**：两者都写 `translation`，后写的会覆盖前者。
- CPU 路线适合几十到几千个 mover；上万个请用下面的 GPU 路径。

### GPU 路径动画（万级）

```ts
registerGPUPath(points, opts?: { id?: number; name?: string; closed?: boolean }): number
unregisterGPUPath(id: number): boolean
getGPUPathManager(): GPUPathManager

bindGPUPath(smid: number, path: number | Path | ArrayLike<number> | Array<[number, number, number]>, options?: Omit<GPUPathOptions, 'pathId'>): number
unbindGPUPath(smid: number): void
setGPUPathProgress(smid: number, progress: number): void
setGPUPathTime(time: number, autoAdvance?: boolean): void
getGPUPathTime(): number
```

```ts
interface GPUPathOptions {
  pathId: number;                 // registerGPUPath 返回的 ID
  speed?: number;                 // 归一化进度/秒，0.05 ≈ 20 秒一圈
  phase?: number;                 // 初始相位（0~1）
  loop?: 'loop' | 'pingpong' | 'clamp' | boolean;  // boolean false = clamp
  autoHeading?: boolean;          // 按路径切线自动转向（默认 true）
}
```

- 路径按**等弧长**烘成一张 `RGBA32F` 纹理：每行一条路径，256 个采样点，`RGBA = x, y, z, yaw`。yaw 做了连续角度展开，避免 ±π 处插值回旋。GPU 双线性采样得到平滑位置与朝向。路径点同样是**数据集局部 ENU**。
- `autoHeading` 把模型 **+X 轴**转到路径切线方向（`yaw = atan2(dy, dx)`，逆时针为正）。如果你的模型正前方不是 +X，需要自己在建模侧转好，或用 `autoHeading: false` 自己算朝向。
- 单体参数写进状态纹理第 5 行 `[pathId, speed, phase, modeFlag]`，顶点着色器自己算位置，CPU 每帧只写一个 `uPathTime`。几万个单体也只有一次 uniform 写入。
- **路径 ID 决定纹理行**。`height = maxId + 1`，不要用很大的稀疏 ID；不传 `id` 时自增分配。
- `bindGPUPath` 传折线时会自动注册并返回 pathId；传数字则复用已注册路径。绑定后该网格的视锥剔除会被关闭（解绑不会自动恢复）。
- `setGPUPathProgress` 会把该单体的 `speed` 置 0、`phase` 设为进度，用于手动定位。`setGPUPathTime(t, false)`（默认）会冻结自动推进并写入指定秒数；`setGPUPathTime(t, true)` 写入后恢复自动推进。
- **自动推进按帧累加 `0.016` 秒**，不是真实时钟。低帧率下会变慢；需要严格速度时每帧用 `setGPUPathTime(elapsedSeconds, false)` 自己驱动。
- **只要 GPU 路径库非空，`renderFrame()` 就会一直返回 `true`**（即使没有单体绑定、或你把 `uPathTime` 冻结），宿主会持续重绘。暂停 / 结束时应 `unbindGPUPath` 并 `unregisterGPUPath`，否则等于空转烧电。
- `unbindGPUPath` 删除 `FeatureStyle.gpuPath`，单体回到静态状态。
- **拾取与包围盒都跟着走**：`PICK_VERT` 与主着色器采样同一份路径纹理（row5 → 路径纹理 → 位置 + yaw），所以运动中的单体点得中；`getFeatureBounds()` 用同一套公式（`phase + uPathTime × speed`，再按 loop 模式夹取）在 CPU 复算位置与朝向。三者共用一份语义，改其中一处必须同步另外两处。
- **仍然按原位置的**：属性过滤、以及你自己按 `pickId` 建的空间索引——它们不碰渲染状态，没有「当前显示位置」的概念。
- GPU 路径与 `followPath` / `moveFeature` 不要同时作用于同一个单体。

`getGPUPathManager()` 返回的 `GPUPathManager` 还提供 `registerPath` / `unregisterPath` / `getPath` / `hasPath` / `getPathIds` / `clear` / `count` / `getTexture` / `dispose`，一般用上面的 viewer 包装即可。

### 双纹理交叉淡化（crossFadeStyles）

```ts
crossFadeStyles(
  targetStyles: Map<number, FeatureStyle> | Record<string | number, FeatureStyle>,
  transition?: TransitionOptions
): void
```

把目标单体状态烘到第二张状态纹理，只动一个 `uBatchMix` 从 0 到 1，顶点 / 片元采样状态纹理时按它 `mix(A, B)`。整套状态（颜色 / 抬高 / 平移 / 透明度 / 隐藏 / 姿态 / GPU 路径参数）都能过渡，CPU 每帧只写一个 float；`hidden` 这种布尔量在 50% 处切换。

- **目标表是「全量替换」，不是合并**。提交时会 `clear()` 现有 `featureStyles` 再写入 `targetStyles`；没出现在目标表里的单体将失去自定义样式。要保留的条目必须自己带上。
- 没有过渡（`duration` 为 0 且无 `spring`）时直接提交，不建 track。
- 过渡期间状态纹理多一次采样；大规模换色 / 换高时这仍比逐单体建动画通道便宜几个数量级。
- 这是「全城换色」的正确入口。`setThematicColors` / `colorByField` 本身是即时批量操作，不会自动走交叉淡化；需要过渡就自己构造目标样式表再调 `crossFadeStyles`。
- **不要手动 `animator.cancel('batch.mix')`**：它只会停在中间混合值，且不提交目标。要终止就再调一次 `crossFadeStyles`（会重置 mix 并重新准备），或用 `animator.finish('batch.mix')` 让它走完提交。
- 过渡按调用时的网格快照准备，中途新加载的瓦片不参与这次混合，会按提交前状态显示。瓦片频繁进出的场景建议等稳定后再切。

### 调度器直连（Animator）

`viewer.animator` 是公开的 `Animator` 实例；也可以脱离 three 单独使用（纯数学，Node 可跑）。

```ts
import { Animator, type Channel } from 's3m-three';

const animator = new Animator(() => performance.now()); // 可注入时钟，便于测试

let value = 0;
const channel: Channel = {
  dim: 1,
  read: (out) => { out[0] = value; },
  write: (v) => { value = v[0]; },   // 必须 O(1) 且不分配
};

animator.register('demo.value', channel);
animator.onActive = () => requestAnimationFrame(loop);
animator.to('demo.value', 1, { duration: 600, easing: 'easeOutCubic' });

function loop(now: number) {
  if (animator.tick(now)) requestAnimationFrame(loop);
}
```

| 成员 | 说明 |
|---|---|
| `register(key, channel)` / `unregister(key)` / `unregisterPrefix(prefix)` | 通道注册与回收；注册同名会覆盖 |
| `has(key)` / `isActive(key)` | 通道是否存在 / 是否有活跃 track |
| `to(key, target, opts?)` | 推向目标；未注册的 key 抛错；`dim=3` 必须传三元数组 |
| `cancel(key)` | 停在当前值，不写终值、不回调 |
| `finish(key)` | 直接写终值并结束，回调 `onComplete` |
| `clear()` | 丢弃全部 track（不回调） |
| `tick(now?)` | 推进一帧，返回是否还有活跃动画；无 track 时零成本早退 |
| `onActive` | 新建 track / 立即写值 / `finish` 时触发，宿主用它踢一帧重绘；retarget 不触发 |
| `budgetMs` | 单帧写入预算，默认 2.5ms；超了把剩余通道推到下一帧 |
| `skippedLastTick` | 上一帧因超预算没推进的通道数 |
| `activeCount` / `active` | 活跃 track 数量 / 是否有动画 |

内置通道 key：

| 前缀 | 用途 |
|---|---|
| `style.*` | 样式字段（见上表）、`style.edgeFade`、`style.fade` |
| `feature.<smid>.translation` / `.elevation` / `.opacity` / `.color` / `.rotation` | 单体属性，按需惰性注册 |
| `feature.<smid>.path` | 路径进度 0→1 |
| `tile.<seq>.fade` | 新瓦片淡入，用完即回收 |
| `batch.mix` | 交叉淡化混合系数 |
| `projection.t` | 仅 `S3MLayer` 注册，正交投影插值 |

超预算时被跳过的通道**这一帧完全不推进**，下一帧按绝对时间追上——跳一帧不丢状态，只是晚一帧显示。`budgetMs` 是整帧写入预算，不是每通道预算；相机也在动时不要把它吃满。

### 帧驱动与生命周期

`S3MViewer.renderFrame()` 内部已经在渲染前调用 `animator.tick()`，并把「是否还有动画」并入返回值。宿主只需要：

```ts
function frame(now: number) {
  const needsNextFrame = viewer.renderFrame({ /* mvp / cameraEnu / fovRad / canvasHeight */ });
  if (needsNextFrame) requestAnimationFrame(frame);
}
```

- **不要自己再调一次 `animator.tick()`**，会双倍推进。
- `renderFrame()` 返回 `true` 的条件：动画进行中、`STYLE.DYNAMIC`、GPU 路径活跃、瓦片加载中、瓦片层级变化。动画结束那一帧必须回到 `false`，否则宿主会永远重绘。
- 时钟是 `performance.now()` 的绝对时间。标签页切回来不会补帧，而是直接到当前时间对应的进度；弹簧则会因长时间未推进直接判定收敛。
- `onActive` 负责在空闲时踢第一帧。宿主是按需渲染的（MapLibre 尤其如此），漏了这一步的现象就是「点了按钮没反应，直到别的操作触发重绘才跳到终态」。
- **动画期间不要绕过 animator 直写 uniform**（例如 `viewer.uniforms.uColorA.value.set(...)`），否则会和动画互相覆盖。公开 API 一律走 `setStyle` / `animateFeature`。

### 已知边界

下面这些是**设计上就不会做**的，不是待办：

- `mode` / `shading` / `edgeThreshold` 不是可插值属性：`mode` 是着色分支，`shading` 是编译期变体，`edgeThreshold` 要重建 `EdgesGeometry`。前者用 `setMode` 的 fade-through，后两者即时切换。`edges` 的开关本身有 `uEdgeFade` 淡入淡出（`setEdges(true, { duration })`），只是几何构建仍然分片。
- `fadeIn` 会让淡入中的瓦片进入透明队列；首次加载几百块瓦片时有一小段额外开销，默认关闭。想彻底躲开透明队列只能改成抖动透明，观感会变成「点状渐显」，没有做。
- 地图宿主（MapLibre / Mapbox）下相机矩阵每帧由宿主喂入，**不要自己 tween `camera.position`**，相机动效走 `map.easeTo` / `flyTo` / `fitBounds`（`flyToFeature` 已经是这个路子）。纯 three 宿主没人覆盖相机，才可以在 animator 里做轨道插值。

下面这些是**已经解决、但需要知道实现口径**的：

- `shading` 首次切换不再现场编译：首帧后会自动预热另一种变体（选项 `prewarmShading`，默认开），切换时直接取 program 缓存。预热期间跳一两帧渲染，肉眼不可见；要自己挑时机就关掉选项、手动调 `prewarmShading()`。
- 全局 `opacity` 可以到 0：到 0 时本层**跳过绘制**，不写颜色也不写深度，不会在底图上留洞。
- GPU 路径运动中的单体：**拾取已经准确**（`PICK_VERT` 与主着色器采样同一份路径纹理，含 loop / pingpong / clamp 与自动朝向），**`getFeatureBounds()` 也按同一公式在 CPU 复算**。仍按原位置计算的只剩「属性过滤」这类不涉及空间的逻辑，以及你自己按 `pickId` 做的空间索引。

---

## 纯 three.js 使用

`S3MViewer` 之下还有一层完全裸的用法：`core/` 解析与 `tileset/` 瓦片树都是宿主无关的，可以直接塞进任意 three 场景（`demo/three.js` 是一个完整例子，走的就是 `S3MViewer`；下面是不用 viewer 的最底层接法）：

```ts
import * as THREE from 'three';
import { S3MTileset, createSharedUniforms, STYLE, setMaxAnisotropy } from 's3m-three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy()); // 纹理各向异性，越早调用越好

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

需要自己补的部分（`S3MViewer` 不代劳）：

| 事项 | 说明 |
|---|---|
| 光照 | 渲染用的是 `MeshStandardMaterial`，自己加 `HemisphereLight` + `DirectionalLight` |
| 多数据集对齐 | 每份数据各有锚点，`S3MViewer` 会把锚点差写进数据集的 `Group.position`（米），裸用法需要自己算一次 |
| 贴地与经纬度 | 没有地图就没有墨卡托那一步，只有局部米制坐标 |
| 拾取 / 描边 / 样式 UI | `Picker`、等宽棱线、`setStyle` 都在 `S3MViewer` 上，裸用法要直接操作 `uniforms` 和 Mesh |
| 瓦片卸载 | 超出 `maxTiles` 时按「最久没进有效范围」淘汰，同帧再比距离 |

---

## 底层 API

### `parseS3MB`

```ts
parseS3MB(buffer: ArrayBuffer, options?): Promise<S3MParsedTile>
```

纯解析，**不依赖 three**，可在 Node 里跑：

```ts
import { parseS3MB } from 's3m-three/core';
import { inflateSync } from 'node:zlib';

const tile = await parseS3MB(buf, { inflate: inflateSync });
console.log(tile.version, Object.keys(tile.geoPackage));
```

解析结果可用 `bytesRead === bytesTotal` 自检——不等说明偏移算错了。

**v3 骨架条目额外暴露 `obb`**（`GeoPackageEntry.obb`，局部 ENU 系的中心 + 三个半轴）。多骨架瓦片里每块 geode 范围各不相同，而 pageLOD 的包围球只取自其中一块，做按块剔除 / 贴地要用条目自带的这个。它是按 `skeletonStreamSize` 定位到「条目末尾 96 字节」读出来的，而不是靠猜——几何段与 OBB 之间可能还有对齐填充（实测高斯泼溅 / 点云多块瓦片里就有块比别的块多 4 字节），靠固定长度往后推会整条流错位，下一块骨架的名字长度会读到垃圾，报出来是「未知骨架标记」。

**S3M 1.x 容器会被识别并抛错**，而不是抛一个看不懂的类型错误：

```ts
import { parseS3MB, S3MFormatError } from 's3m-three/core';

try {
  await parseS3MB(buf);
} catch (e) {
  if (e instanceof S3MFormatError) {
    // e.permanent === true：格式层面的永久错误，重试没有意义
    // 典型是 .s3m（OSGB 转的 SuperMapCache 瓦片，头 4 字节是魔数 "s3m\0" 而不是版本号）
  }
}
```

不识别的话，`s3m\0` 会被 float32 读成 1e-38 的「版本号」，接着把 zlib 头 `78 da cc bd` 当压缩长度，最终报 `RangeError: Invalid typed array length: 3184319096`——完全看不出是格式问题。`S3MTileset` 见到 `permanent` 就不退避重试，同类错误也只上报一次。

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
bun run test:meshopt
```

需要 WebAssembly；不支持 wasm 的环境会在遇到 MeshOpt 瓦片时抛明确错误。

**自定义属性流与高斯泼溅属性不再被丢弃**：`CUSTOM0` / `CUSTOM1` / `GS_SCALE` / `GS_ROTATION` 四条语义会原样保留成顶点属性（`custom0` / `custom1` / `gsScale` / `gsRotation`，每点 4 字节），名字到槽位的映射来自数据自带的 `vertexAttributeDescript`（实测高斯服务是 `{"GS_Rotation":1,"GS_Scale":0}`）。以前这几条流解码后直接扔掉，于是 `3DGaussianSplatting` 数据到渲染层只剩「位置 + 颜色」，上层拿不到泼溅的尺寸与朝向。

每块骨架还带一份原始流清单 `vertexPackage.meshOptInfo`（各语义的压缩字节数与解码后每点 stride），排查新数据时先看它，比对着十六进制猜快得多。

**这两条 GS 流的量化格式还没标定**（4 字节 / 点，既不像 3 个 float，也不像明显四元数），所以渲染层目前只是把它们带到顶点属性上备用，没有接进真正的 splat 着色器。

### Draco 点云几何

v3.01 的点云数据还有一条 Draco 压缩分支（骨架 tag = `DRACO`）。接法与 MeshOpt 相同：内联 wasm 解码器（约 266KB）只在真的遇到时动态 `import`，解码后并入同一套 attribute 组装，点云按 `primitiveType = 1` 交给 `THREE.Points`，分类码 / 强度 / 权重三种自定义属性一并解出来。

**这个分支的字段顺序与规范描述对不上，是从真实瓦片逐字节标定的**（偏移以骨架 tag 字段之后为 0）：

```
u32  payloadSize       // 覆盖「本字段之后 … 条目末尾 OBB 之前」
u32  未知（实测恒 32）
i32  pos / normal / color / secondColor 各自的 draco 属性 uid（-1 = 无）
u32  自定义属性个数（实测 3）+ i32[] 各自的 uid
u32  vertexAttrCount   // 实测恒 0
u32  dracoSize; byte[dracoSize]   // 标准 draco 比特流，开头 5 字节 "DRACO"
String descript        // {"PointCloudClassCode":2,"PointCloudIntensity":1,"VertexWeight":0}
```

`descript` 的值是「该属性在自定义 uid 数组里的**下标**」，不是分量数。OBB 不在这段里读，由 `parseSkeletonEntries` 统一按条目末尾 96 字节取。

官方 SDK 的 `parseDracoSkeleton` 在这个分支上**解析不了同一个服务**：字段顺序里多了一个 `materialCount`，而且 `version === 3` 的判定对 v3.01 瓦片不成立。所以这里不能照官方实现抄。

读偏的兜底是四重自校验（`payloadSize` 覆盖范围 / `dracoSize` / `"DRACO"` 魔数 / 骨架自带的 `skeletonStreamSize`）加单骨架 64M 点数上限。实测两个瓦片 5 个骨架逐字节一致；**这条路径尚未纳入 `tests/`**，改动 `core/Draco.ts` 前请拿真实瓦片复验。

### `S3MTileset`

单个数据集的瓦片树。不依赖 three，可以用注入的 `buildTile` 在 Node 里跑通完整链路（URL 解析 → 解析 → LOD 调度），适合做数据体检。

```ts
const ts = new S3MTileset({ configUrl, buildTile: async () => ({ group: null, stats: {} }) });
await ts.init();
ts.update([0, 0, 500], 0.64, 900); // 相机在局部 ENU 的位置
```

`configUrl` 必须指向**某个数据源的 config**，不是 `datas` 目录：

```
https://host/iserver/services/3D-xxx/rest/realspace/datas/<数据源名>/config
```

数据源名可以是中文（如 `寿宁阁`），`new URL()` 会自动百分号编码；后缀只能写 `config`，写 `config.xml` 会 406。只给到 `…/realspace/datas` 时拿到的是一个资源清单数组，`JSON.parse` 不报错但没有 `position` / `rootTiles`，表现为「视角跳到 (0,0) + 一句缺少 root tile」——先用 `…/datas.json` 列出数据源，再逐个拼 `/config`。

配套导出的三个纯函数，方便自建数据集列表与做体检：

```ts
parseConfigText(text)      // JSON 与 SuperMapCache XML 两种配置统一成同一种形状（含 fileType）
usableGeoBounds(bounds)    // 判断 geoBounds 是否真的可用；不可用返回 null（见「锚点」）
fixPathEncoding(url)       // 补路径里没编码但服务端会改写的字符：+ → %2B、空格 → %20
```

`fixPathEncoding` 这条是硬需求：OSGB 转出来的瓦片名就是 `Tile_+002_+001`，而 iServer 按 `URLDecoder` 解路径，未编码的 `+` 会变成空格 → 404「瓦片数据不存在」。`new URL()` 认为 `+` 在 path 里合法，不会替我们编码，所以拼完 URL 必须补这一刀（query 里的 `+` 不动，那本来就是空格约定）。

失败处理分两类：**网络类**错误退避重试（`maxRetries`，默认 2 次）；**格式类**错误（`e.permanent === true`，例如 S3M 1.x 容器）直接判失败不重试，并且整棵瓦片树里同类错误只回调一次 `onError`，避免几十块瓦片刷同样的日志。

### 单体属性工具

```ts
resolveFeature(geo, batchId)   // → { smid, segments }
measureSegments(geometry, segments)  // → 包围盒 + 单体三角面数
buildAttributes({ smid, box, triangles, floorHeight })  // → S3MFeatureAttributes
```

---

## 性能调优与显存管理

| 手段 | 说明 |
|---|---|
| `totalMaxTiles` | 多数据集全局瓦片总预算（如 `96` 或 `128`），自动在可见数据集间均衡分配配额，隐藏数据集时自动回收预算，防止多图层叠加爆显存 |
| `maxTiles` | 单数据集瓦片驻留上限，默认 64。叠加多个数据集时建议配合 `totalMaxTiles` 或下调至 32~48 |
| `maxTriangles` | 单数据集驻留面数软上限，默认不限制。`maxTiles` 只数瓦片个数，精模场景（一块几十万面）建议配 60 万~120 万 |
| `lodPixelRatioCap` | LOD 判定用屏幕高度的 DPR 上限，默认不截断。见下方「移动端 / 差设备」 |
| `anisotropyCap` | 各向异性过滤上限，默认取 GPU 最大值。移动端 4 / 8 通常肉眼无差 |
| `maxTextureSize` | 纹理长边像素上限，默认不限制。手机上 1024 即可，显存降到 1/4 |
| `maxImageCache` | 原始图集与 leaf 段图像记录的 LRU 缓存容量上限（默认 128），超限自动淘汰旧缓存，防止漫游时内存不断累积 |
| 纹理引用计数 | 瓦片淘汰时按引用计数释放未被其他瓦片复用的 `Texture` 并调用 `dispose()`，真正归还 GPU 显存 |
| 几何/材质深度释放 | 瓦片注销时深度遍历对象树，彻底释放 `Mesh`、`Points`（点云/高斯泼溅）以及 `LineSegments`（棱线包）的 `BufferGeometry` 与材质 |
| `maxConcurrent` | 每数据集并发，默认 4。公开服务建议 2~3 |
| 关闭 `edges` | 棱线是 CPU 端构建的等宽线几何（每段线段 4 个顶点），内存和 drawcall 都随网格数增长，大场景慎用 |
| `shading: 'flat'` | 与 `'smooth'` 性能相当，但视觉更干净 |
| 不透明度 < 1 | 会开启混合并关闭深度写入，overdraw 明显上升，仅用于演示 |
| 批量改单体样式 | 同一同步块里的多次 `setFeatureStyle` 会合并成一次状态纹理重写，见下 |
| `pick` 只渲染 1 个像素 | 已内置；hover 高亮、框选这类高频拾取不再有整屏开销 |

实测（上海某区，5 数据集叠加，45 万三角面，1440×900）：**85~90 fps**。

### 移动端 / 差设备

库本身不检测设备，所有刹车都由接入方按档位决定，**默认全部不启用，行为与旧版一致**：

```ts
// 低端档
new S3MLayer({
  lodPixelRatioCap: 2,      // 3x 屏 → 判定高度 2556 压到 ~1704，少约半层细化
  maxTriangles: 800_000,    // 驻留面数超了就淘汰最久没用的瓦片
  maxTiles: 40,
  maxConcurrent: 2,         // 并发 4 → 2：Worker 省了解析，但几何组装与纹理上传仍在主线程
  anisotropyCap: 4,         // 各向异性 16 → 4
  maxTextureSize: 1024,     // 纹理长边 2048 → 1024，显存降到 1/4
});
```

五个开关性质不同，按「改不改画质」分两类：

| 开关 | 性质 | 观感代价 |
|---|---|---|
| `lodPixelRatioCap` | 画质换性能 | 有，见下表 |
| `maxTextureSize` | 画质换显存 | 贴图略软；1024 与 2048 在手机上肉眼几乎无差 |
| `anisotropyCap` | 画质换采样成本 | 斜视角立面清晰度略降；4 / 8 通常看不出 |
| `maxConcurrent` | 纯加载节奏 | 无（只是瓦片到达得慢一点，掉帧少） |
| `maxTriangles` | 兜底刹车 | 正常无感，见下 |

**为什么 `lodPixelRatioCap` 在手机上收益最大**：LOD 的屏幕空间误差按 `canvasHeight` 物理像素算（与官方 `calcPixFromCam` 同口径），而手机 DPR 3 的绘图缓冲高度比 1440×900 桌面还高——细化层数与瓦片请求会多出近 3 倍，同时片元填充量再乘 2 倍多。截断只吃掉超采样的那部分，代价是每块瓦片在屏幕上铺得更开，几何误差与纹理密度同步变差：

| 力度 | 判定高度（iPhone 15） | 几何误差 / 纹理密度 | 体感 |
|---|---|---|---|
| 不截断（默认） | 2556 | 基准 | 最清晰，最费 |
| `2` | 1704 | ×1.5 / ×1/1.5 | 近景细看略软，整体几乎无感 |
| `1.5` | 1278 | ×2 / ×1/2 | 立面与地面贴图明显变软 |
| `1`（等价于按 CSS 高度） | 852 | ×2.84 / ×1/2.84 | 糊，圆形构件出棱角，不建议 |

**`maxTextureSize` 的三个边界**（都需要知道，否会踩意外的坑）：

- **图集不缩放**：S3MBLOCK 的 `AtlasPack` 大图与 leaf 组合画布的 UV 已重映射到子区域，缩放会让整体错位，`createTexture` 里直接跳过。
- **压缩直传不缩放**：走 `CompressedTexture`（DXT / CRN 转码）时纹理在 GPU 里就是块数据，重采样没意义；真要省显存就在调用侧关掉压缩直传，或接受它已经是 1/4~1/8 的体积。
- **缩放发生在 Worker 里**：`maxSize` 随解码请求一起传给共享 Worker，主线程零成本；Worker 不可用时才回落到主线程（4096² 减半一次约 10~50ms，属于一次性成本）。

**`maxTriangles` 是兜底刹车而不是画质档位**：没超预算时代码路径不触发，画质零损失；超了只在「不显示」或「位置已被可见子瓦接手」的瓦片里淘汰，所以不会开洞。

### 批量改单体样式

单体状态（颜色 / 抬高 / 隐藏）写在**每个网格各自一张一维纹理**里，改一个单体就是重写这张纹理。
逐个高亮时最贵的就是这里：一块白模网格常有几千个 batch，每改一个单体就全量重算一遍，500 个门店 × 6848 个 batch 就是 340 万次迭代。

所以内部做了两层合并：

- **按 SMID 定位网格**：维护 `SMID → 网格` 反查表，改一个只重算包含它的那几块；
- **脏标记 + 微任务合并**：同一个同步块里的多次调用只重算一次。微任务一定在下一帧 `renderFrame()` 之前跑完，画面不会看到中间状态。

```ts
// 300 次调用 → 1 次纹理重写
for (const smid of hits) viewer.setFeatureStyle(smid, { color: '#ef4444' });

// 需要同步拿到结果（紧接着读纹理、截图、导出）时手动刷
viewer.flushOverrides();
```

`filterByField` / `colorByField` / `elevateByField` / `setThematicColors` 这类**全局**改动会重算所有网格，但同样被合并成一次。

---

## 已知限制

- **Draco 压缩几何**已支持（v3.01 点云分支）：内联 wasm 按需 `import`，解码后与标准骨架同路输出 attribute，点云按 `primitiveType = 1` 走 `THREE.Points`，分类码 / 强度 / 权重三种自定义属性一并解出。两点要留意：一是**容器与规范描述对不上**，字段顺序是从真实瓦片逐字节标定的（`payloadSize` / `dracoSize` / `"DRACO"` 魔数 / `skeletonStreamSize` 四重自校验兜读偏，另有单骨架 64M 点数上限），官方 SDK 的 `parseDracoSkeleton` 字段顺序多一个 `materialCount` 且 `version === 3` 的判定对 v3.01 不成立，解析不了同一个服务，不能照抄；二是这条路径**还没有回归测试钉住**（目前只有排查探针脚本），改 `core/Draco.ts` 的字段顺序必须拿真实瓦片复验。
- **实例化单体**（`pickInfo` 里给的是 `instanceIds` 而不是 `batchId`，白模常见）只做了渲染，没做按单体控制：`setFeatureStyle` / `filterByField` / `elevateByField` / GPU 拾取走的都是 `aBatchId`，这条路径对实例化几何不生效。要支持得把每个实例单独上色，得改 InstancedMesh 的 instanceColor + 拾取编码。
- **CRN 纹理**已支持，且已在真实服务上验证：内联的 crunch wasm 转回 DXT 后走现成解码，DXT 具体格式看 CRN 头，wasm 约 76KB、只有真遇到 CRN 时才动态加载。**判定看 `compressType` 而不是 `pixelFormat`**——实测 v3.00 是 `ct=26 / pf=13`、行标是 `ct=50000 / pf=32856`，按 `pixelFormat` 26 / 27 判断会把真实 CRN 整包丢掉（模型变灰模）。判定收敛在 `packages/s3m-three/src/core/TextureFormat.ts`（`resolveTextureKind` / `TextureCompress` / `dxtPixelFormatOf`，已从包入口导出）。用 `bun run probe:crn -- --crn <数据集 config 地址>` 可以对任意服务跑「尺寸吻合 / 色数 / 粗糙度 / ASCII 预览」的实测。
- **纹理分包（`s3m:TextureSharing` / S3MBLOCK）已完整支持**：
  - **容器结构**：`.s3mblock` 单文件容器 = 若干 RO 组，每组包含一段 pageLOD 元信息 + zlib 压缩的 v2 瓦片体（段目录：groupNode / 骨架 / secondColor / 图集 / 材质 / 单体化）；纹理是图集（`isSaveData`），材质按图集 id（`-N.texblock`）引用，几何顶点区间绑定到图集子区域；
  - **解析与 UV 重映射**：解析端把顶点 UV 用 `fract` 平铺语义重映射进图集空间，多图集自动走货架式装箱合并（`AtlasPack`），下游材质直接绑定整张图集；
  - **细级 LOD（leaf）外部图集加载**：细级瓦片的图集未内嵌原始像素（`data = null`），由 `_fillExternalAtlases` 解析子请求名（`_subRequestNames`）：
    - 支持展开 `Tex_x.texblock#<三位数字串>` 多精灵容器索引；
    - 对齐官方 `Uci` 规范的 pack 请求：URL 拼装 `extratiles=<names>` 批量合并拉取，避免高并发零碎请求；
    - 响应体通过 `parseTexblockSegments` 解码 `kMi` 分段记录，并通过 `leafRequestCache` 与 `_leafPending` 实现跨瓦片并发请求自动去重缓存；
    - **组合画布与装配**：对 leaf 模式，解出子精灵 RGBA 缓冲，按 `subTexInfos[i]` 的偏移量（`offsetX`、`offsetY`）以标准自上而下行序拷贝进高分辨率组合画布；
    - **安全判定与重拼**：外部图集接入前通过 `evaluateAtlasUpgrade` 进行长宽比与下采样色差校验，判定通过后由 `rebuildBlockTextureState` 重新生成拼图与重算归一化 `texRect`；
  - 实现位于 `core/S3MBlockParser.ts`、`core/AtlasPack.ts` 与 `tileset/S3MTileset.ts`，并通过 `tests/unit/s3mblock.test.ts`、`tests/unit/leaf-atlas.test.ts` 和 `tests/unit/leaf-uv-render.test.ts` 交叉验证钉住。
- **多块 MeshOpt 骨架**（`blockCount > 1`）已支持。这类骨架里**每块后面紧跟自己的索引包**（不是所有块之后再统一放一份），索引是块内局部编号；解析时按块顺序合并顶点流，再把每块索引加上顶点基数偏移，对外仍是一份顶点缓冲 + 多组索引包。实测 `3D-WorkSpace_pbr1/pbrmodel` 的 `blockCount=2` / `3` 瓦片可正常加载。
- **切线顶点流**只跳过不解码（渲染没有法线贴图通道），带 TANGENT 的数据不会被判失败。
- **S3M 1.x（`.s3m`，SuperMapCache）已支持**。这类服务的 `config` 返回 `SuperMapCache` XML（`sml:FileType = OSGBFile`），位置与范围按米制盒反算（见「锚点」）；瓦片是 `73 33 6D 00` 魔数 + zlib 的老容器，`parseS3MB` 认出魔数后交给 `core/S3M1Parser.ts`，输出同形状的 `ParsedTile`，下游渲染 / LOD / 拾取零改动。
  **注意：它的下一级 LOD 并不是 `.osgb`** —— XML 里 `RangeDataList` 写的 `..._L16_0.osgb` 只是切片时的原始文件名，服务实际发布的是同名换 `.s3m` 后缀，走 `datas/<数据源>/data/path/<瓦片目录>/<名>.s3m`（实测 L16/L17/L18 全部 200，`?sceneName=` 不参与寻址）。所以整棵 LOD 树都是同一种容器，**不需要 OSG Binary 解码器**；早先「因为子瓦是 .osgb 所以做不了」的结论是没验证就下的，已作废。
  已标定：`73 33 6D 00` 魔数 + zlib；解压后 `uint32 xmlSize + XML + 补齐 4 字节对齐（实测 2~3 个 0x30，不是固定标记）+ (uint32 size + data) × 3`，三段长度链在四块样本上全部精确闭合；几何流 = `uint32 meshCount` + 每块网格 `{ geoName, 7, 772, V, 0 }` + `V × 16B` 顶点 `(x, y, z, z)` + 数组区 + `uint32 1` + `uint32 materialId`（与 XML 材质号一致）；纹理流 = `uint32 count` + 每条 `{ id, width, height, format, size, flag }` + `size` 字节（实测 `format=14`、0.5 B/px = DXT1，`28 + size` 精确等于段长）；索引确认为 u16（值域最大恰为 `V-1`）；几何里**没有法线数组**，接解码时要 `computeVertexNormals()`。
  接这种格式时有三个坑，都是实测出来的，别凭直觉：
  1. **几何里没有法线数组**（全段扫 `|v|≈1` 的最长游程只有 4~10 个），建完要 `computeVertexNormals()`；
  2. **头里的 `format` 不是 `S3MPixelFormat` 枚举** —— 实测四块瓦片都是 `14`，而这枚举里 14 = BGRA（4 B/px），照搬就会把 0.5 B/px 的 DXT1 当 4 字节读，满屏彩噪。必须按 `size / (width*height)` 反推（`pixelFormatOfBpp`）；
  3. **UV 是「v = 0 对应文件首行」**，与 DXT 解码器内部那次 GL 方向的 Y 翻转相反。不抵消的话几何的 v（实测 0.483~0.983）会正好采到图集空的那半张 —— 区域均值亮度 5.6 对比 76.1，模型上就是一片黑块。所以 v1 纹理要置 `S3MTexture.flipY = true`。

  子瓦地址规则见 `s3m1ChildUrl`：XML 的 `RangeDataList` 给的是切片时残留的 `.osgb` 名，实际发布是同名换 `.s3m` 并插在 `datas/<数据源>/data/path/<瓦片目录>/` 下；父瓦自己已经在 `data/path` 下时只能换文件名，再插一层就成了 `data/path/data/path/...` 全部 404（有回归测试钉住）。
- **高斯泼溅（`3DGaussianSplatting`）只按点渲染**。加载、细化、出图整条链路是通的（这类瓦片没有索引包，顶点即点，`GeometryBuilder` 会补一个「顶点即点」的伪包走 `THREE.Points`；不补的话整块瓦片落到「无可用几何」被丢掉，这是之前"加载不出来"的第二个原因）。但画出来的是带顶色的点集，不是真正的泼溅：`gsScale` / `gsRotation` 两条自定义流的量化格式还没标定，而且颜色是 RGBA（A 通道是泼溅不透明度），现在的顶点色路径会丢掉 alpha。要上 EWA splatting 得先按深度层级取样把这两条流对准，再补协方差 + 深度排序的 alpha 混合。
- **KTX2** 不在 S3M 的 `pixelFormat` 枚举里，iServer 也不会发；要支持需自行引入 `basis_transcoder.wasm` 并解析容器，属于「换数据源才需要考虑」的项。
- **骨骼动画**解析了但未驱动。
- 跨城市量级的数据集叠加会有 float32 精度问题。

---

## 数据与许可

- 本库代码 Apache-2.0。
- `packages/s3m-three/src/core/DXTTextureDecode.ts` 来自 [SuperMap/s3m-spec](https://github.com/supermap/s3m-spec)（Apache-2.0）。
- `packages/s3m-three/src/vendor/crunch_decoder.module.js` 是 crunch 的 emscripten 构建（Apache-2.0），wasm 内联、仅改动加载方式。
- `packages/s3m-three/src/vendor/meshopt_decoder.module.js` 是 [meshoptimizer](https://github.com/zeux/meshoptimizer) 官方解码器（MIT，© Arseny Kapoulkine），未做修改。
- S3M 规范文本遵循 CC BY-ND 4.0，不得修改规范文本后再发布。
