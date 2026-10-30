/**
 * `S3MViewer` 的公共类型：选项、光照、拾取结果、路径跟随。
 *
 * 从 `S3MViewer.ts` 整块搬出来的纯类型定义（零运行时）。搬出去的原因只有一个：
 * 这些类型占了两百多行，和「类怎么实现」没有关系，留在主类里会把真正的逻辑冲淡。
 *
 * `S3MViewer.ts` 仍然 re-export 它们，所以 `import { S3MViewerOptions } from '.../S3MViewer'`
 * 这类既有写法不受影响。
 */
import * as THREE from 'three';
import type { Path } from '../../anim/Path.js';
import type { EasingFn, EasingName } from '../../anim/easing.js';
import type { FeatureAttributes, GeoPackageEntry, ParsedTile, Stats } from '../../core/types.js';
import type { UnsupportedPolicy } from '../../core/degradations.js';
import type { AttributeQueryOptions } from '../../core/AttributeQuery.js';
import type { AuthenticateFn } from '../../core/AuthFetch.js';
import type { LightingPreset } from '../lightingPreset.js';
import type { MotionBlurOptions } from '../MotionBlurPass.js';
import type { S3MStyle } from '../StyleMaterial.js';
import type { BuildTileFn } from '../../tileset/S3MTileset.js';
import type { S3MDatasetEntry, S3MDatasetOptions } from '../DatasetManager.js';
import type { GroundOptions } from '../GroundManager.js';

export interface PickResult extends FeatureAttributes {
  datasetId: string;
  datasetName: string;
  /** 网格编号 */
  objectId: number;
  /** 单体控制位（顶点区间型 = batchId，实例化型 = 状态纹理下标），-1 表示没有单体化信息 */
  batchId: number;
  /** 实例化几何命中的实例序号；非实例化为 undefined */
  instanceIndex?: number;
  skeletonName: string;
  /** 单体中心经纬度，拿不到时为 null */
  centerLngLat: [number, number] | null;
  /** 命中点三维场景坐标 [x, y, z]（米，场景 ENU） */
  point?: [number, number, number] | null;
  /** 命中点经纬度 [lng, lat] */
  lngLat?: [number, number] | null;
  /** 命中点高程（米） */
  altitude?: number | null;
  mesh: THREE.Mesh;
}

export interface LightOptions {
  /** 环境光强度，默认 0.4 */
  ambientIntensity?: number;
  /** 环境光颜色，十六进制或 CSS 颜色字符串，默认 0xffffff */
  ambientColor?: number | string;
  /** 半球光天空强度，默认 0.8 */
  hemisphereIntensity?: number;
  /** 半球光天空颜色，默认 0xffffff */
  hemisphereColor?: number | string;
  /** 半球光地面颜色，默认 0xb6c0cb */
  hemisphereGroundColor?: number | string;
  /** 主平行光强度，默认 1.0 */
  keyLightIntensity?: number;
  /** 主平行光强度别名（兼容写法） */
  mainIntensity?: number;
  /** 主平行光颜色，默认 0xffffff */
  keyLightColor?: number | string;
  /** 主平行光颜色别名（兼容写法） */
  mainColor?: number | string;
  /** 补光强度，默认 0.35 */
  fillLightIntensity?: number;
  /** 补光颜色，默认 0xffffff */
  fillLightColor?: number | string;
  /**
   * 光照朝向模式：
   * - 'headlamp': 默认头灯模式（随相机 bearing 旋转，受光面始终面向镜头）
   * - 'fixed': 固定世界坐标方位角（如太阳光模拟）
   */
  mode?: 'headlamp' | 'fixed';
  /** 方位角（度，0~360），固定模式下以正北为 0 顺时针，头灯模式下为相机相对偏角，默认 150 */
  azimuth?: number;
  /** 太阳/光源仰角（度，0~90），默认 50 */
  altitude?: number;
}

export interface S3MViewerOptions {
  /**
   * 光照预设：
   * - `'default'`（默认）：现有 PBR 打光，亮部线性总量 ≈ 2.55；
   * - `'supermap'`：对齐 iClient3D 观感（暗部 0.46 / 亮部 2.44），远处不发灰、饱和度更高。
   *   只改光源，不动材质与色调映射；`light` 里的显式字段仍然优先生效。
   */
  lightingPreset?: LightingPreset;
  /** 光照参数配置（强度、颜色、朝向模式、太阳方位角/仰角等） */
  light?: LightOptions;
  /**
   * 三角面材质深度偏移（共面摩尔纹 / 重合面归属的人工定序）。
   * 例：factor -1 / units -2 把配置材质的片元深度略微拉近。
   * 这是 mesh 粒度开关，见 BuildTileOptions.polygonOffset 的说明。
   */
  polygonOffset?: { factor: number; units: number };
  /**
   * 色调映射模式（默认 THREE.NoToneMapping，避免 ACESFilmic 压暗中暗部及导致底图与建筑色彩失真；
   * 可传入 THREE.ACESFilmicToneMapping、THREE.LinearToneMapping、THREE.ReinhardToneMapping 等）
   */
  toneMapping?: THREE.ToneMapping;
  /** 色调映射曝光度，默认 1.0 */
  toneMappingExposure?: number;
  /** 全局总驻留瓦片上限（多数据集多图层共享预算），在所有可见数据集之间动态均衡分配，彻底防止爆显存 */
  totalMaxTiles?: number;
  /** 单数据集简写 */
  configUrl?: string;
  /** 多数据集 */
  datasets?: S3MDatasetOptions[];
  style?: Partial<S3MStyle>;
  /** 3D 物理地表面 / 基坑开挖配置 */
  ground?: GroundOptions;
  pickable?: boolean;
  /** 每个数据集最多驻留瓦片 */
  maxTiles?: number;
  /** 每个数据集并发请求数 */
  maxConcurrent?: number;
  /**
   * 图层级默认的降级处置策略（默认 `'warn'`），数据集可用 `unsupported` 单独覆盖。
   * 见 `S3MTilesetOptions.unsupported`。
   */
  unsupported?: UnsupportedPolicy;
  /** 是否用 Web Worker 解析经典 .s3mb 瓦片（默认开，崩溃自动降级主线程），见 S3MTilesetOptions.useWorker */
  useWorker?: boolean;
  /** LOD 切换范围缩放系数（默认 1.0），> 1 更倾向保留粗模，< 1 提前换细模 */
  lodRangeScale?: number;
  /**
   * LOD 判定用屏幕高度时的「设备像素比上限」（默认不限制，行为与旧版一致）。
   *
   * LOD 的屏幕空间误差按 `canvasHeight` 物理像素算（与官方 `calcPixFromCam` 同口径），
   * 于是 3x DPR 的手机上判定高度是 2556 而不是 852，细化层数与瓦片数都会远多于桌面。
   * 传 2 表示「按 CSS 高度 × 2 截断」，砍掉 3x 屏的超采样余量；传 `Infinity` = 不截断。
   *
   * 代价：截断会把每块瓦片的屏幕投影放大同样倍数，几何误差与纹理密度同步变差，
   * 所以默认不启用，由接入方按设备档位自行决定。运行时可用 `setLodPixelRatioCap()` 调整。
   */
  lodPixelRatioCap?: number;
  /**
   * 每个数据集驻留三角形总数的软上限（默认不限制）。
   * 见 `S3MTilesetOptions.maxTriangles`：瓦片数管不住的场景（精模、大面片）用这条刹车。
   */
  maxTriangles?: number;
  /**
   * 每个数据集驻留显存/内存字节总数的软上限（默认 Infinity = 不限制）。
   * 包含几何顶点缓冲（精确字节）与纹理显存估计。
   * 超限时在每帧末尾（make-before-break）主动回收非显示的瓦片及其独占纹理。
   */
  maxMemory?: number;
  /**
   * 纹理缓存条数上限（默认 128）。一条对应一张已解码的瓦片纹理，
   * 1024² 的 RGBA 一张约 4MB，128 条就是 512MB 显存 —— 低端设备建议 32~48。
   * 与 `maxTextureSize` 配合使用：后者降单张尺寸，这条降张数。
   */
  maxImageCache?: number;
  /**
   * 各向异性过滤上限（默认不封顶，取 GPU 报的最大值，通常 16）。
   * 移动端封到 4 或 8 肉眼通常无差，采样成本明显下降。只影响**之后创建**的纹理。
   */
  anisotropyCap?: number;
  /**
   * 纹理长边像素上限（默认不限制）。
   * 非图集的 RGBA / WebP 纹理会按 2× 盒式滤波逐次减半到上限内；DXT 压缩直传与
   * 图集（UV 已重映射）不受影响。手机上 1024 与 2048 肉眼几乎无差，显存差 4 倍。
   */
  maxTextureSize?: number;
  /**
   * 光照模型（默认 `'pbr'`）。
   *
   * - `'pbr'`：`MeshStandardMaterial`，GGX + 环境球谐，质感最好也最贵
   * - `'lambert'`：`MeshLambertMaterial`，只保留漫反射 + 平行光，片元开销约省一半；
   *   白模 / 纯色 / 按高度着色这类不需要高光的模式肉眼差别很小
   *
   * **图层级**：只定这一层，同页多个图层各用各的，互不覆盖；构造时不会写模块级
   * 默认（`setMaterialQuality`）。不传 = 跟随模块级默认，老用法照旧有效。
   * 只影响**之后创建**的材质 —— 已加载的瓦片要重载，或在图层上调
   * `setMaterialQuality()` 原位重建。
   */
  materialQuality?: 'pbr' | 'lambert';
  /**
   * 可选的运动模糊后处理（**默认关闭**，不传 = 渲染路径与旧版逐字一致）。
   *
   * 低端 / 移动设备帧率低，运动物体的卡顿（judder）与边缘闪烁（shimmer）靠
   * 「帧间残影」在感知层面填补 —— 它不提升分辨率 / 几何 / 静态画质，只对
   * 正在运动的画面有效，所以只在低端设备上按需开启。
   *
   * - `mode: 'afterimage'`（缺省）：当前帧 + 上一帧全屏混合，几乎零边际 GPU 成本；
   *   不是方向感知的，快速平移时是「拖影」。
   * - `mode: 'velocity'`：按上一帧 ↔ 当前帧相机矩阵逐像素反推屏幕速度，沿速度方向
   *   多 tap 采样（方向感知的真·运动模糊，只覆盖相机运动）。
   * - `damp`：拖尾长度（仅 afterimage），`'auto'`（缺省）按实时 FPS 收敛 ——
   *   帧率越低拖影越长；数值会被钳到 [0, 0.98]。
   *
   * 运行时可用 `setMotionBlur()` 开关（null = 关闭并释放显存）。仅 WebGL2：
   * WebGL1 上静默回退直渲。
   */
  motionBlur?: MotionBlurOptions;
  /**
   * 颜色管线（默认 `'linear'`）。
   *
   * - `'linear'`：纹理 sRGB 解码 → 线性 PBR 光照 → linear→sRGB 输出（three 标准姿势）
   * - `'direct'`：官方 iClient3D 的 sRGB 直乘管线，同时把纹理解码关掉（字节值原样进
   *   shader）。`lightingPreset: 'supermap'` 会选它
   *
   * **图层级**：只定这一层，同页多图层各用各的；不传 = 跟随模块级默认。
   * 已加载瓦片可以在运行时用 `setColorPipeline(q, { duration })` 平滑切过去
   * （重建材质 + 重传纹理，不重新下载瓦片）。
   */
  colorPipeline?: 'linear' | 'direct';
  /** 自定义瓦片构建器（测试 / 服务端渲染时注入） */
  buildTile?: BuildTileFn | null;
  /**
   * 可选：业务属性查询配置（iServer 数据服务）。
   * 配上之后才能用 `colorByField()` 按业务字段着色 —— 属性值不在 S3M 瓦片里，只能去数据服务查。
   */
  attributes?: AttributeQueryOptions;
  /** 宿主请求重画的信号。MapLibre 传 `() => map.triggerRepaint()`；纯 three 宿主传自己的渲染循环 */
  onRequestRepaint?: () => void;
  /** 地图朝向（弧度），用于让灯光跟着视角走。不传则灯光方向固定 */
  getBearing?: () => number;
  /**
   * 鉴权适配函数（全局默认，数据集可用自己的 `authenticate` 覆盖）。
   * 内核主线程发出的全部请求（配置 scp / 瓦片 / 子图集 / 棱线缓存 / 属性查询）
   * 发出前都过一遍，可改写 URL（加 `?token=`）或附加请求头。
   * 不传 = 行为与旧版完全一致。见 `AuthenticateFn`。
   */
  authenticate?: AuthenticateFn;
  onStats?: (stats: Stats) => void;
  onReady?: (entry: S3MDatasetEntry) => void;
  onPick?: (result: PickResult | null) => void;
  onError?: (error: unknown) => void;
  /**
   * 首次出现瓦片后自动预热另一种 `shading` 变体（默认开）。
   *
   * `flat` / `smooth` 是编译期变体，不预热的话第一次 `setStyle({ shading })` 会同步
   * 编译着色器、卡一帧。预热在首帧之后异步做，期间跳一两帧渲染，肉眼不可见。
   */
  prewarmShading?: boolean;
}

/* ------------------------------------------------------------------ 内部类型 */

export interface PickableRef {
  datasetId: string;
  mesh: THREE.Mesh;
  tile: ParsedTile;
  skeletonName: string;
}

export interface MeshUserData {
  pickId?: number;
  datasetId?: string;
  skeletonName?: string;
  geoRef?: GeoPackageEntry;
  tileRef?: ParsedTile;
  primitiveType?: number;
  /** 点云对象（THREE.Points）：不吃面着色，也没有棱可描 */
  isPointCloud?: boolean;
  /** CPU 端现算的棱线对象（等宽线 Mesh） */
  edges?: THREE.Object3D | null;
  /** 背面外扩轮廓壳（edges 含 'hull' 时挂上） */
  edgeHull?: THREE.Mesh | null;
  /** 数据自带棱线包（此时不再用 EdgesGeometry 现算） */
  nativeEdges?: boolean;
  /** 数据本身有没有棱线包（不受 forceCpuEdges 影响，用来运行中切换时重算 nativeEdges） */
  nativeEdgesRaw?: boolean;
  /** 数据自带的棱线对象本身 */
  isEdgeLines?: boolean;
  /** CPU 现算的等宽棱线（与 isEdgeLines 区分，便于刷新样式） */
  isThickEdge?: boolean;
  /** 背面外扩轮廓壳（edges 含 'hull' 时挂上） */
  isEdgeHull?: boolean;
  /** 选中单体的棱线对象 */
  isSelectionEdge?: boolean;
  /** 该网格正在淡入时占用的动画通道 key，瓦片淘汰时要回收 */
  tileFadeKey?: string;
  pickMaterial?: THREE.Material;
  [key: string]: unknown;
}

export interface PathFollowOptions {
  /** 走完全程的时长（毫秒）。不传则按 speed 或默认 2000ms 推算 */
  duration?: number;
  /** 线速度（米/秒）。给了 duration 就以 duration 为准 */
  speed?: number;
  /** 是否循环 */
  loop?: boolean;
  /** 是否把折线首尾相连 */
  closed?: boolean;
  /** 缓动曲线：作用在**已走距离**上，默认 linear（恒速） */
  easing?: EasingName | EasingFn;
  /** 路径整体偏移（米），相当于路径原点 */
  offset?: [number, number, number];
  /** 单次走完（非循环）时回调 */
  onComplete?: () => void;
}

/* ------------------------------------------------------------------ 图层 */

