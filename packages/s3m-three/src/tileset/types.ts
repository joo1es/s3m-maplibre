/**
 * `tileset/` 的公共类型面。
 *
 * 这些声明原本和 `S3MTileset` 类挤在同一个文件里，但它们被 `index.ts`、
 * `DatasetManager`、`S3MViewer` 和 `render/viewer/types.ts` 各自 import，
 * 留在单体里会让每个子模块都不得不 import 宿主的值（ESM 循环引用在 bun/vite 下
 * 不报错，运行时才拿到 undefined）。全部改成纯类型文件后，子模块只 `import type`。
 */
import type { Group, Texture } from 'three';
import type { AuthenticateFn } from '../core/AuthFetch.js';
import type { UnsupportedPolicy } from '../core/degradations.js';
import type { TileGeometryData } from '../core/TileGeometry.js';
import type { ParsedTile, Stats, StyleUniforms } from '../core/types.js';
import type { TextureCreateOptions } from '../render/TextureFactory.js';

/** 配置文件里的经纬度范围 */
export interface GeoBounds {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** config 能认出的数据集类别（判别规则见 config.ts 的 classifyDatasetKind） */
export type DatasetKind = 'model' | 'terrain' | 'imagery';

/** 视锥可见性判定回调（返回 false 表示瓦片完全在视锥外，应跳过进一步细化） */
export type TileVisibilityTest = (
  center: { x: number; y: number; z: number },
  radius: number,
  node?: TileNode
) => boolean;

/** 瓦片构建器可注入，用于测试 / 服务端渲染（此时不需要 three） */
export type BuildTileFn = (
  tile: ParsedTile,
  options: {
    textureCache: Map<string, Texture>;
    uniforms: StyleUniforms | null;
    /** Worker 侧已完成的纯数据几何组装（经典 .s3mb 路径），构建器直接包装成 three 对象 */
    assembled?: TileGeometryData;
    /** 深度偏移配置（透传给 buildTileObjects），见 BuildTileOptions.polygonOffset */
    polygonOffset?: { factor: number; units: number };
    /** 光照模型档位（透传给 buildTileObjects），见 BuildTileOptions.materialQuality */
    materialQuality?: 'pbr' | 'lambert';
    /** 颜色管线（透传给 buildTileObjects），见 BuildTileOptions.colorPipeline */
    colorPipeline?: 'linear' | 'direct';
    /** 纹理创建参数（透传给 buildTileObjects → createTexture） */
    textureOptions?: TextureCreateOptions;
    bakeMercator?: boolean;
    tileAnchor?: { lon: number; lat: number; height?: number };
    tileCenter?: { x: number; y: number; z?: number };
  }
) => Promise<{ group: Group; stats: Partial<Stats> }>;

/** 已落地的瓦片节点。字段全部由各自的读写方定义，含义见各字段注释 */
export interface TileNode {
  url: string;
  tile: ParsedTile;
  group: Group;
  sphere: { center: { x: number; y: number; z: number }; radius: number } | null;
  rangeValue: number;
  rangeMode: number;
  childUrl: string | null;
  childUrls?: string[];
  state: string;
  /** 最近一次 update() 到相机的距离（米），淘汰时按它排序 */
  distance?: number;
  /** 最近一次「在有效范围内」的帧号，越小越该被淘汰 */
  lastSeen?: number;
  /** 上一级瓦片的 URL（淘汰到最细一级时，要把上一级找回来补洞） */
  parentUrl?: string;
  /** 当前帧是否满足细化条件 */
  needRefine?: boolean;
  /**
   * 该瓦片高斯的最长轴中位长度（米）。非泼溅瓦片为 undefined。
   * 有值时细化判据改走 core/SplatLod.ts —— 点云的各层 σ 恒定，
   * 包围球像素误差那套判据对它无效（见该文件头部）。
   */
  splatSigma?: number;
  /** 该瓦片的高斯实例数（泼溅瓦片才有） */
  splatCount?: number;
  /** 该瓦片引用的纹理 key 清单，用于引用计数与显存释放 */
  textureKeys?: string[];
  /** 瓦片构建产生的统计信息，用于淘汰时准确扣减 stats */
  stats?: { meshes: number; vertices: number; triangles: number; memory?: number };
}

/**
 * 显式场景锚点：给「没有地理参考」的局部米数据指定该摆在哪。
 *
 * 官方 S3M 规范允许 .scp 用 `position.unit = Meter` + 非地理 `crs`（如 epsg:0 平面
 * 坐标系），这类数据只有局部米坐标，没有经纬度（见 gaussianSplatting/sculpture.scp）。
 * 库不做 EPSG 反算 —— 投影由生产端负责 —— 但需要 App 能把局部米原点挂到地图上。
 * 数值单位：lon / lat 为**度**，height 为**米**。
 */
export interface AnchorOverride {
  lon: number;
  lat: number;
  /** 高程（米），默认 0 */
  height?: number;
}

/** .scp 里读出来的空间参考信息。只做记录与告警，不做任何重投影 */
export interface SpatialReference {
  /** 顶层 crs 原值，如 `epsg:0` / `epsg:4490` / `wkt:...`；缺失为 null */
  crs: string | null;
  /** `epsg:` 前缀后抠出的码；wkt / 缺失 / 非数字为 null */
  epsg: number | null;
  /** `position.unit`（v3.01）或 `position.units`（老版）；缺失为 null */
  unit: string | null;
  /** `extensions.crs` 里的 WKT / XML 文本（平面坐标系常写在这里） */
  wkt: string | null;
  /** 是否按经纬度解释 position。unit 缺失时按地理数据兜底（旧行为） */
  isGeographic: boolean;
}

export interface S3MTilesetOptions {
  bakeMercator?: boolean;
  configUrl: string;
  /**
   * 显式锚点覆盖，**默认关闭**。
   *
   * 传了才生效：把 config.position / geoBounds 整体平移到指定经纬度，顶点仍按
   * 数据集局部 ENU 米处理，于是平面工程坐标的数据能挂到地图上。不传时 config
   * 与锚点的解析路径与改动前逐字一致（不变式 ①）——包括「米被当成度」这个旧行为，
   * 但此时 init() 会明确告警，不再静默画错。
   *
   * 只用于单个数据集：多数据集时请在各自的 `S3MDatasetOptions.anchorOverride` 上指定，
   * 避免一个图层级锚点把所有数据集都搬走。
   */
  anchorOverride?: AnchorOverride;
  maxTiles?: number;
  maxConcurrent?: number;
  /** 原始图像/子图集缓存上限（LRU），默认 128 */
  maxImageCache?: number;
  buildTile?: BuildTileFn | null;
  /** 三角面材质深度偏移（共面摩尔纹 / 重合面归属），透传给 buildTileObjects */
  polygonOffset?: { factor: number; units: number };
  /**
   * 光照模型档位，透传给 buildTileObjects。不传 = 读模块级默认。
   * 由 DatasetManager 从图层 / 数据集设置带下来。
   */
  materialQuality?: 'pbr' | 'lambert';
  /** 颜色管线，透传给 buildTileObjects。不传 = 读模块级默认。由图层的渲染 profile 带下来 */
  colorPipeline?: 'linear' | 'direct';
  /** 纹理创建参数（sRGB 解码 / 尺寸上限 / 各向异性上限），透传给 createTexture */
  textureOptions?: TextureCreateOptions;
  /**
   * 是否用 Web Worker 解析经典 `.s3mb` 瓦片（默认开）。
   *
   * Worker 里跑 parseS3MB 全链路（inflate / Draco / MeshOpt 内联 wasm 解码），
   * 主线程只做 fetch 与几何组装，消除加载阶段的解析卡顿。
   * Worker 创建失败或崩溃时自动**永久**降级回主线程解析，行为与关闭时完全一致。
   * S3MBLOCK 路径（图集补齐与主线程缓存强耦合）暂不进 Worker，仍主线程解析。
   */
  useWorker?: boolean;
  uniforms?: StyleUniforms | null;
  onTile?: (node: TileNode) => void;
  /** 超过 maxTiles 被淘汰时回调，调用方要自己把场景里的对象和拾取表清掉 */
  onTileRemoved?: (node: TileNode) => void;
  onProgress?: (stats: Stats) => void;
  onError?: (error: unknown) => void;
  /** 单块瓦片加载失败后的重试次数，默认 2（退避 0.8s / 1.6s） */
  maxRetries?: number;
  /** LOD 切换范围缩放系数（默认 1.0），> 1 更倾向保留粗模，< 1 提前换细模 */
  lodRangeScale?: number;
  /**
   * 本数据集**驻留三角形总数**的软上限（默认不限制）。
   *
   * `maxTiles` 只数瓦片个数：一块精模瓦片几十万面，64 块照样能把差设备压垮，
   * 所以在瓦片数之外再给一条按面数的刹车。超了走同一套 make-before-break 淘汰
   * （只踢「当前不显示」或「位置已被可见子瓦接管」的瓦片），不在画面上开洞。
   *
   * 不传 = 不限制，行为与旧版完全一致。运行时可用 `setMaxTriangles()` 调整。
   */
  maxTriangles?: number;
  /**
   * 本数据集**驻留显存/内存字节数**的软上限（默认不限制）。
   * 包含几何顶点缓冲（精确字节）与纹理显存估计。超限时按同一套 make-before-break
   * 主动淘汰非显示瓦片及其独占纹理。
   *
   * 不传 = 不限制（Infinity），行为与旧版完全一致。运行时可用 `setMaxMemory()` 调整。
   */
  maxMemory?: number;
  /**
   * 是否请求 `.texblock` 子图集（S3MBLOCK 根图集的清晰版）。**默认关**。
   *
   * 不是没实现，而是「换图不换归一化 rect」这条规则只在部分链上成立：实测三对样本里
   * 有一对的比例是 2.000×1.579（不成比例），打开后整场景建筑会碎成满屏空洞
   * （错裁到 alpha=0 的区域被 alphaTest 丢弃）。要安全启用必须先做逐图集一致性自检
   * （把子图集按归一化 rect 裁回来与根槽位比 alpha 轮廓 IoU + 色差），通过才换。
   * 度量方式见 `_tmp/atlas/rule2.mts`。
   */
  atlasLod?: boolean;
  /**
   * 鉴权适配函数（默认不传 = 行为与旧版一致）。每个请求（配置 scp / 瓦片 /
   * 子图集）发出前过一遍，可改写 URL（加 `?token=`）或附加请求头。见 `AuthenticateFn`。
   */
  authenticate?: AuthenticateFn;
  /**
   * 遇到「解析得了但画不出该有的样子」的数据时怎么办。**默认 `'warn'`**。
   *
   * 目前只有一类：3DGS 数据按点渲染（`gsScale` / `gsRotation` 的量化格式未标定）。
   *   'warn'   —— 首次遇到告警一次，照常出图。旧版没有这个开关，但也不告警，
   *               所以这里的差异只有多一条日志，不传参时的渲染路径逐字未变。
   *   'throw'  —— 直接拒绝这类瓦片（标 `permanent`，不重试）。给「宁可不显示，
   *               也不要显示一个看不出是错的画面」的场景。
   *   'silent' —— 只记录到 `stats.degradations`，由 UI 自己决定怎么提示。
   */
  unsupported?: UnsupportedPolicy;
  /**
   * LOD 细化过渡策略：
   * - 'binary'（默认）：整节点二值切换。所有子瓦片全部就绪或失败后，父瓦片整块隐藏、子瓦片整块接替。
   * - 'incremental'：增量细化（primary / fallback 双列表 + LEQUAL 深度推移）。
   *   子瓦片就绪一个显示一个，未就绪区域由父级（fallback）兜底填充，消除整块跳变与慢 child 阻塞。
   */
  lodTransition?: 'binary' | 'incremental';
  /**
   * 增量细化模式下 fallback 兜底瓦片的材质深度偏移系数。
   * 默认 { factor: 1, units: 2 }，通过向远处推移深度配合 gl.LEQUAL 消除共面 z-fighting。
   */
  fallbackOffset?: { factor?: number; units?: number };
}
