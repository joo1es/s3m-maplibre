/**
 * 覆盖物底座：把「一个 three 对象 + 一个经纬度锚点」挂进 S3M 场景。
 *
 * 它**不预设任何图元形态**。飞线、光柱、雷达扫描、glb 模型走的是同一条路：
 * 使用者自己造 Object3D，底座负责把它锚在经纬度上、跟着锚点重锚、按需逐帧推进。
 *
 * 三条设计约束（见 AGENTS.md 的依赖方向判据）：
 *   1. 只依赖 scene / 锚点 / 重绘三样设施，不认识 smid、瓦片、dataset；
 *   2. 重绘请求只有一条来源 —— 动态对象的活跃状态交给宿主并入 `needsNextFrame`，
 *      这里不自己起 rAF，否则单测没法观察「有没有重绘」；
 *   3. 静态对象不进帧循环。200 个静态 glb 挂着不能把地图逼成 60fps。
 */
import * as THREE from 'three';
import type {
  OverlayAnchor,
  OverlayBuilder,
  OverlayFrame,
  OverlayHandle,
  OverlaySpec,
} from './types.js';

/** 宿主锚点：与 `S3MViewer.sceneAnchor` 同形，只取这里用得到的字段 */
export interface OverlayAnchorLike {
  x: number;
  y: number;
  z: number;
  altitude?: number;
  meterInMercator: number;
  meterInMercatorEast?: number;
  meterInMercatorNorth?: number;
  meterInMercatorUp?: number;
}

/**
 * 底座需要的宿主设施。
 *
 * 刻意收得很窄：换成纯 three 场景时，只要给一个 scene、一个手写的锚点、
 * 一个 `lngLatToPoint` 和一个 `requestRepaint` 就能用，不需要 S3M 数据集。
 */
export interface OverlayHost {
  readonly scene: THREE.Scene | null;
  /** 当前场景锚点。数据集未加载时为 null，此时经纬度换算退化到原点 */
  getAnchor(): OverlayAnchorLike | null;
  /** 经纬度 + 绝对高程 → 场景 ENU 米制坐标（与 `S3MViewer.lngLatToPoint` 同签名，高程必填） */
  lngLatToPoint(p: { lng: number; lat: number; altitude: number }): [number, number, number];
  requestRepaint(): void;
}

interface Item {
  spec: OverlaySpec;
  /** 锚点补偿容器：translate 模式下只有它的位置会变 */
  root: THREE.Group;
  /** 偏移容器：锚点位置 + offset。工厂模式下只放 offset */
  pivot: THREE.Group;
  /** 使用者的对象 */
  content: THREE.Object3D;
  /** 是工厂还是现成实例，决定重锚策略 */
  rebuilt: boolean;
  alive: boolean;
}

/** 深度策略 `'always'` 用的渲染序号：盖过场景里的普通物体 */
const ALWAYS_RENDER_ORDER = 10;

function normalizeAnchor(a: OverlaySpec['anchor']): OverlayAnchor {
  if (Array.isArray(a)) return { lng: a[0], lat: a[1], altitude: a[2] ?? 0 };
  return { lng: a.lng, lat: a.lat, altitude: a.altitude ?? 0 };
}

export class OverlayLayer {
  /** 所有覆盖物的父容器。由宿主的 mount 过程挂进场景 */
  readonly group = new THREE.Group();

  private readonly _host: OverlayHost;
  private readonly _items: Item[] = [];
  private _lastNow: number | null = null;
  private _t = 0;
  private _lastAnchor: OverlayAnchorLike | null = null;
  /** 是否已经记过一次锚点。区分「没记过」和「记过但当时是 null」 */
  private _anchorKnown = false;

  constructor(host: OverlayHost) {
    this._host = host;
    this.group.name = 's3m-overlay';
    // 覆盖物自己不会画到墙上，基容器不参与拾取
    this.group.matrixAutoUpdate = true;
  }

  /** 是否有动态对象。宿主把它并进 `needsNextFrame`，决定要不要继续驱动下一帧 */
  get hasAnimated(): boolean {
    return this._items.some((i) => !!i.spec.update);
  }

  /** 当前挂着的数量（调试 / 测试用） */
  get size(): number {
    return this._items.length;
  }

  /** 把容器挂到当前 scene 上。重复调用无副作用，scene 换了会跟着换 */
  attachToScene(): void {
    const scene = this._host.scene;
    if (!scene) return;
    if (this.group.parent !== scene) scene.add(this.group);
  }

  add(spec: OverlaySpec): OverlayHandle {
    const rebuilt = typeof spec.object === 'function';
    const anchor = normalizeAnchor(spec.anchor);

    const root = new THREE.Group();
    const pivot = new THREE.Group();
    const content = rebuilt
      ? (spec.object as OverlayBuilder)(this._toEnu(anchor))
      : (spec.object as THREE.Object3D);

    pivot.add(content);
    root.add(pivot);
    this._applyPose(spec, pivot, content, rebuilt, anchor);

    const item: Item = { spec, root, pivot, content, rebuilt, alive: true };
    this._items.push(item);
    this.group.add(root);
    this.attachToScene();

    // 第一次挂东西时记下当下锚点：否则「add 之后、首次 tick 之前」发生的重锚会被漏掉，
    // 工厂模式下几何还按旧锚点烘着
    if (!this._anchorKnown) this._rememberAnchor();

    if (spec.visible === false) content.visible = false;
    if (spec.depth === 'always') applyAlwaysDepth(content);
    this._host.requestRepaint();

    return {
      get object() {
        return item.content;
      },
      remove: () => this._remove(item),
      setVisible: (v) => {
        if (item.alive) {
          item.content.visible = v;
          this._host.requestRepaint();
        }
      },
      refresh: () => {
        if (!item.alive) return;
        this._applyPose(item.spec, item.pivot, item.content, item.rebuilt, anchor);
        if (item.spec.depth === 'always') applyAlwaysDepth(item.content);
        this._host.requestRepaint();
      },
      requestRepaint: () => {
        if (item.alive) this._host.requestRepaint();
      },
    };
  }

  /** 摘掉全部，逐个触发 `onRemove` */
  clear(): void {
    for (const item of [...this._items]) this._remove(item);
  }

  /**
   * 每帧推进。宿主在 `renderFrame` 里调用。
   *
   * 顺序是「先校锚点、再跑回调」：使用者在 update 里看到的世界坐标已经是补偿后的，
   * 不会出现一帧的错位闪烁。`anchorMoved` 只在这一帧为 true。
   */
  tick(now: number): void {
    // 没有覆盖物时完全不做：不比较锚点、不推进计时。默认路径零开销，
    // 这是「新增能力默认不生效」在热路径上的具体含义
    if (this._items.length === 0) {
      this._lastNow = now;
      return;
    }

    const dt = this._lastNow === null ? 0 : Math.max(0, (now - this._lastNow) / 1000);
    this._lastNow = now;
    this._t += dt;

    const moved = this._checkAnchor();
    const frame: OverlayFrame = { dt, t: this._t, anchorMoved: moved };
    for (const item of this._items) item.spec.update?.(frame);
  }

  /** 解绑并清空。对应宿主 unmount */
  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this._lastNow = null;
    this._t = 0;
    this._lastAnchor = null;
    this._anchorKnown = false;
  }

  /* ---------------------------------------------------------------- 内部 */

  private _remove(item: Item): void {
    if (!item.alive) return;
    item.alive = false;
    item.root.removeFromParent();
    const i = this._items.indexOf(item);
    if (i >= 0) this._items.splice(i, 1);
    item.spec.onRemove?.(item.content);
    this._host.requestRepaint();
  }

  /** 摆位置：translate 模式把锚点写进 pivot，工厂模式锚点已经烘进几何，只放 offset */
  private _applyPose(
    spec: OverlaySpec,
    pivot: THREE.Group,
    content: THREE.Object3D,
    rebuilt: boolean,
    anchor: OverlayAnchor
  ): void {
    const enu = this._toEnu(anchor);
    const off = spec.offset ?? [0, 0, 0];
    pivot.position.set(
      (rebuilt ? 0 : enu[0]) + off[0],
      (rebuilt ? 0 : enu[1]) + off[1],
      (rebuilt ? 0 : enu[2]) + off[2]
    );

    if (spec.rotation) content.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    const s = spec.scale ?? 1;
    if (Array.isArray(s)) content.scale.set(s[0], s[1], s[2]);
    else content.scale.setScalar(s);
  }

  private _toEnu(anchor: OverlayAnchor): [number, number, number] {
    const p = this._host.lngLatToPoint({
      lng: anchor.lng,
      lat: anchor.lat,
      altitude: anchor.altitude ?? 0,
    });
    // 宿主给的已经是 ENU 米制；锚点缺失时 S3MViewer 退化为 [0,0,0]，这里原样接受
    return [p[0], p[1], p[2]];
  }

  /**
   * 检查锚点是否变化，变化时按各自语义补偿。
   *
   * 三种情况分开处理，混在一起写会漏：
   *   - 还没记过锚点 → 只记录，不补偿（否则 mount 那一帧会把对象凭空推开一次）；
   *   - 记过但当时是 null（数据集还没加载）→ 全部重摆，工厂对象还要重造；
   *   - 正常平移 → x/z 用「旧减新」，y 用「新减旧」。
   */
  private _checkAnchor(): boolean {
    if (!this._anchorKnown) {
      this._rememberAnchor();
      return false;
    }

    const a = this._host.getAnchor();
    if (this._sameAnchor(a)) return false;

    const prev = this._lastAnchor;
    this._lastAnchor = a ? { ...a } : null;
    if (!a) return false;

    // 锚点从无到有：pivot 里存的 ENU 是当时按原点算的，已经不对
    if (!prev) {
      for (const item of this._items) {
        this._applyPose(item.spec, item.pivot, item.content, item.rebuilt, normalizeAnchor(item.spec.anchor));
        if (item.rebuilt) this._rebuild(item);
      }
      return true;
    }

    const d = enuDelta(prev, a);
    for (const item of this._items) {
      // 工厂模式的几何里烘的是旧锚点下的 ENU，只能整个重造
      if (item.rebuilt) this._rebuild(item);
      else item.root.position.set(d[0], d[1], d[2]);
    }
    return true;
  }

  /**
   * 锚点是否与上次一致。
   *
   * 用字段逐个比较而不是拼指纹字符串：这个函数每帧对每个图层跑一次，
   * 字符串拼接在长跑场景里是白烧的分配。比例尺也要比 —— 切 CRS 时
   * xy 可能不动，但米/墨卡托变了。
   */
  private _sameAnchor(a: OverlayAnchorLike | null): boolean {
    const p = this._lastAnchor;
    if (!a || !p) return a === p;
    return (
      a.x === p.x &&
      a.y === p.y &&
      a.z === p.z &&
      (a.altitude ?? 0) === (p.altitude ?? 0) &&
      (a.meterInMercatorEast ?? a.meterInMercator) === (p.meterInMercatorEast ?? p.meterInMercator) &&
      (a.meterInMercatorNorth ?? a.meterInMercator) === (p.meterInMercatorNorth ?? p.meterInMercator)
    );
  }

  /** 用当前锚点重造工厂对象，替掉旧的 */
  private _rebuild(item: Item): void {
    const old = item.content;
    const anchor = normalizeAnchor(item.spec.anchor);
    item.pivot.remove(old);
    item.content = (item.spec.object as OverlayBuilder)(this._toEnu(anchor));
    item.content.visible = old.visible;
    item.pivot.add(item.content);
    // 重造出来的是全新的对象，朝向 / 缩放要重新套一遍
    this._applyPose(item.spec, item.pivot, item.content, true, anchor);
    if (item.spec.depth === 'always') applyAlwaysDepth(item.content);
    item.spec.onRemove?.(old);
    this._host.requestRepaint();
  }

  private _rememberAnchor(): void {
    const a = this._host.getAnchor();
    this._lastAnchor = a ? { ...a } : null;
    this._anchorKnown = true;
  }
}

/**
 * 锚点平移量：让「同样的 ENU 坐标」继续落在同一个世界位置上。
 *
 * x / z 是「旧减新」，y 是「新减旧」—— 场景 y 轴与世界墨卡托 y 反向
 * （见 `S3MViewer._sceneFromLngLat` 的取负），符号写反了对象会以两倍距离弹开。
 */
export function enuDelta(prev: OverlayAnchorLike, next: OverlayAnchorLike): [number, number, number] {
  const se = next.meterInMercatorEast ?? next.meterInMercator;
  const sn = next.meterInMercatorNorth ?? next.meterInMercator;
  const su = next.meterInMercatorUp ?? se;
  return [(prev.x - next.x) / se, (next.y - prev.y) / sn, (prev.z - next.z) / su];
}

/** 关掉深度测试并抬高渲染序号，让对象永远画在最前 */
function applyAlwaysDepth(obj: THREE.Object3D): void {
  obj.renderOrder = ALWAYS_RENDER_ORDER;
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      mat.depthTest = false;
      mat.depthWrite = false;
    }
  });
}
