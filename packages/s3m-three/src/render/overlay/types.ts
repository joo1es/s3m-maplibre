/**
 * 覆盖物底座的公共类型面。
 *
 * 这里**不定义任何图元形态**：没有 Marker / FlowLine / Polygon 这些概念，
 * 只有「一个 three 对象 + 一个锚点 + 一个可选的每帧钩子」。
 * 具体长什么样由使用者在 `object` 里自己造，飞线、光柱、雷达扫描都是同一条路。
 *
 * 之所以能留在 `s3m-three` 而不是独立包：它只依赖 scene / 锚点 / 重绘三样设施，
 * 不认识 smid、瓦片、dataset。见 AGENTS.md 的依赖方向判据。
 */
import type * as THREE from 'three';

/** 锚点：经纬度 + 绝对高程（米） */
export interface OverlayAnchor {
  lng: number;
  lat: number;
  altitude?: number;
}

/**
 * 每帧回调的入参。
 *
 * `t` 是底座创建以来的秒数、`dt` 是距上一帧的秒数 —— 两者都由底座统一计时，
 * 使用者不要在对象里自己 `performance.now()`，否则暂停 / 恢复上下文后会跳变。
 */
export interface OverlayFrame {
  /** 距上一帧的秒数（首帧等于 0） */
  dt: number;
  /** 底座启动以来的秒数 */
  t: number;
  /** 本帧是否刚发生过锚点重锚（rebuild 模式的对象已在回调前重建） */
  anchorMoved: boolean;
}

/** 构造工厂：拿到锚点的 ENU 米制坐标，返回要挂进场景的对象 */
export type OverlayBuilder = (enu: [number, number, number]) => THREE.Object3D;

/**
 * 深度策略。
 *
 * - `'occluded'`（默认）：与建筑共用深度缓冲，被楼挡住就看不见 —— 三维覆盖物该有的样子。
 * - `'always'`：永远画在最前。底座会把对象上所有材质的 `depthTest` / `depthWrite` 关掉，
 *   并抬高 `renderOrder`。**之后使用者自己换材质不会自动应用**，需要重新 `refresh()`。
 */
export type OverlayDepth = 'occluded' | 'always';

/**
 * 一条覆盖物的描述。
 *
 * `object` 传实例还是传工厂，决定了锚点变化时的行为，这两种语义不能混：
 * - 传**实例**（例如加载好的 glb）：底座把它摆到锚点，锚点变了就用 group 位移补偿。
 *   对象内部的坐标必须是以原点为中心的局部坐标。
 * - 传**工厂**（例如飞线：经纬度已经烘进顶点）：底座在锚点变化时重新调用工厂，
 *   用新的锚点重造几何。工厂收到的是锚点的 ENU 坐标，直接拿来换算即可。
 */
export interface OverlaySpec {
  /** 要挂进场景的对象，或造它的工厂。工厂形式支持随锚点重建 */
  object: THREE.Object3D | OverlayBuilder;

  /** 这条覆盖物锚定的位置。传经纬度，底座负责换算成 ENU 米制坐标 */
  anchor: OverlayAnchor | [number, number] | [number, number, number];

  /** 朝向（弧度），按 XYZ 顺序。Z-up 导出的 BIM / glb 常用 `[-Math.PI/2, 0, 0]` 摆正 */
  rotation?: [number, number, number];
  /** 缩放。单值等比，或三轴分开 */
  scale?: number | [number, number, number];
  /** 相对锚点的 ENU 偏移（米），做微调用 */
  offset?: [number, number, number];

  /** 深度策略，默认 `'occluded'` */
  depth?: OverlayDepth;

  /** 每帧回调。**不传就是静态对象**：不进帧循环、不请求重绘，地图该空闲就空闲 */
  update?: (frame: OverlayFrame) => void;

  /**
   * 对象被摘掉时的回调（`remove()` / `clear()` / 工厂重建替换旧对象 / 底座销毁）。
   * 底座不替使用者 dispose 几何与材质 —— 那些是他造的，只有他知道要不要复用。
   */
  onRemove?: (object: THREE.Object3D) => void;

  /** 初始可见性，默认 `true` */
  visible?: boolean;
}

/** `add()` 返回的句柄 */
export interface OverlayHandle {
  /** 当前实际挂着的对象。工厂模式下锚点重锚后会指向新对象 */
  readonly object: THREE.Object3D;
  /** 摘掉并触发 `onRemove`。重复调用无副作用 */
  remove(): void;
  setVisible(visible: boolean): void;
  /**
   * 重新套用 rotation / scale / offset / depth（手工改了材质或锚点后调用）。
   * 结尾会请求一次重绘。
   */
  refresh(): void;
  /**
   * 只请求一次重绘，**不动位姿**。
   *
   * 静态覆盖物（不传 `update`）不进帧循环，地图空闲时不会产生新帧。手工改了材质、
   * 几何或缩放之后必须调它，否则拖滑块这类连续交互会「看着没反应」—— 值其实已经
   * 写进去了，只是没人重画。`refresh()` 也管用，但它会重算位姿，用于改材质属于误用。
   */
  requestRepaint(): void;
}
