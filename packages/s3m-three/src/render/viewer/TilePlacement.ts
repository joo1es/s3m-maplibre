/**
 * 瓦片级放置（`perTilePlacement`）：按每块瓦片自己的中心纬度算尺度，并缓存拾取用的逆矩阵。
 *
 * 从 `S3MViewer.ts` 搬出来（issue #27 的 P7 阶段），行为逐字未变。
 *
 * 为什么单独成模块：这套东西的状态全在 `group.userData` 上（`tileCenter` 和
 * `placementInverse`），和视图层共享的只有「场景锚点 / geo / 数据集表」三个只读入口。
 * 它被三处调用：注册瓦片时摆位置、锚点变了整体重摆、拾取时反解回规范 ENU。
 *
 * 两条不能动的约定：
 *   ① `_applyTilePlacement` 只写 `group.matrix`，**不碰** `position / rotation / scale`。
 *      three 在 `matrixAutoUpdate = false` 时直接用 `matrix`，但那三个字段留着无害；
 *      一旦让 `updateMatrix()` 有机会覆盖回来，缩放就白算了。
 *   ② 关掉本功能或网格不在已放置的瓦片里时，`toCanonicalScene` **原样返回同一个对象**，
 *      默认路径一次矩阵运算都不做。
 */
import * as THREE from 'three';
import { computeTilePlacement } from '../tilePlacement.js';
import type { GeoAdapter } from '../GeoAdapter.js';
import type { S3MDatasetEntry } from '../DatasetManager.js';

/** 场景锚点（`S3MViewer.sceneAnchor` 的只读视图） */
interface SceneAnchorLike {
  x: number;
  y: number;
  z: number;
  meterInMercator: number;
  meterInMercatorEast?: number;
  meterInMercatorNorth?: number;
  meterInMercatorUp?: number;
  altitude?: number;
}

/** `TilePlacement` 需要的宿主入口。全是取值函数，没有控制流回调 */
export interface TilePlacementHost {
  /** 是否开启瓦片级放置（`perTilePlacement` 选项，默认开） */
  perTilePlacement(): boolean;
  /** 当前场景锚点（第一个数据集的锚点，`recomputeAnchors` 之后会变） */
  sceneAnchor(): SceneAnchorLike | null;
  /** 经纬度 ↔ 世界坐标适配器 */
  geo(): GeoAdapter | null;
  /** 已加载的数据集，重摆时遍历用 */
  datasets(): Iterable<S3MDatasetEntry>;
}

/**
 * 复用一个实例避免每次分配；不可重入（`toCanonicalScene` 内部不递归调用）。
 */
const _tilePlacementInverse = new THREE.Matrix4();

export class TilePlacement {
  constructor(private readonly host: TilePlacementHost) {}

  localCenterOf(group: THREE.Object3D): { x: number; y: number; z: number } | null {
    if (!group.children.length) return null;
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3());
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) return null;
    return { x: c.x, y: c.y, z: c.z };
  }

  /**
   * 把一块瓦片摆到「用它自己中心纬度算出的尺度」上（`perTilePlacement` 开启时才走）。
   *
   * 矩阵是 `T(position) · S(k) · T(-pivot)`，展开后即 `v ↦ position + k·(v - pivot)`。
   * 直接用 `makeScale + setPosition` 一次写好，省掉两个临时矩阵：
   * `T(t)·S(k)·T(-c)` 的元素其实就是对角 `k` 加平移 `t - k·c`。
   *
   * 只写 `matrix`，不碰 `rotation / position / scale` —— three 在
   * `matrixAutoUpdate = false` 时直接使用 `matrix`，那些字段留着无害，
   * 但别让 `updateMatrix()` 有机会覆盖回来。
   */
  apply(
    group: THREE.Object3D,
    center: { x: number; y: number; z: number },
    entry: S3MDatasetEntry,
  ): void {
    const sceneAnchor = this.host.sceneAnchor();
    if (!sceneAnchor || !entry.anchor) return;

    const p = computeTilePlacement({
      center,
      datasetAnchor: entry.anchor,
      sceneAnchor,
      datasetOffset: entry.offset,
      geo: this.host.geo(),
    });
    if (!p) return;

    const kEast = p.scaleEast ?? p.scale;
    const kNorth = p.scaleNorth ?? p.scale;
    const kUp = kEast;
    group.matrixAutoUpdate = false;
    group.matrix.makeScale(kEast, kNorth, kUp);
    group.matrix.setPosition(
      p.position[0] - kEast * p.pivot[0],
      p.position[1] - kNorth * p.pivot[1],
      p.position[2] - kUp * p.pivot[2],
    );
    group.matrixWorldNeedsUpdate = true;
    // 重锚点后要能重算：中心只属于注册那一刻，存到 group 上，不依赖 tileset 内部结构
    (group.userData as { tileCenter?: { x: number; y: number; z: number } }).tileCenter = {
      x: center.x,
      y: center.y,
      z: center.z,
    };
    // 逆矩阵缓存：toCanonicalScene 常态路径无需每次拾取反复求逆，失效点仅在瓦片放置或重锚点
    const inv = ((group.userData as { placementInverse?: THREE.Matrix4 }).placementInverse ??= new THREE.Matrix4());
    inv.copy(group.matrix).invert();

    const sSceneEast = sceneAnchor.meterInMercatorEast ?? sceneAnchor.meterInMercator;
    const sSceneNorth = sceneAnchor.meterInMercatorNorth ?? sceneAnchor.meterInMercator;
    const sSceneUp = sceneAnchor.meterInMercatorUp ?? sSceneEast;
    const invScale = p.invTileScale ?? [1.0 / (sSceneEast * kEast), 1.0 / (sSceneNorth * kNorth), 1.0 / (sSceneUp * kUp)];
    this.updateUniforms(group, p.pivot, invScale);
  }

  updateUniforms(
    group: THREE.Object3D,
    pivot: readonly [number, number, number],
    invTileScale: readonly [number, number, number]
  ): void {
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (((obj as any).isMesh || (obj as any).isPoints) && (obj as any).material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const uPivot = (m as any).userData?.uTilePivot;
          const uScale = (m as any).userData?.uInvTileScale;
          if (uPivot?.value) {
            uPivot.value.set(pivot[0], pivot[1], pivot[2]);
          }
          if (uScale?.value) {
            uScale.value.set(invTileScale[0], invTileScale[1], invTileScale[2]);
          }
        }
      }
    });
  }

  /**
   * 世界坐标 → **规范**场景 ENU：把瓦片级放置的缩放反解掉。
   *
   * `perTilePlacement` 开启后，瓦片几何是「绕自身中心缩放 k 倍、再摆到精确位置」的，
   * 所以命中点的世界坐标不再等于数据本身的 ENU。拾取要报的是**坐标本身**——
   * 一个屋顶的经纬度不该因为我们怎么缩放它而改变，否则同一个点在 20 km 外会比
   * 1 km 内偏出几米，量算、贴地、外部标注全都跟着漂。
   *
   * 反解只需要一次矩阵求逆：父级 `entry.root` 只有平移（`layoutDataset` 只写
   * `position`），所以世界坐标 `p` 对应的瓦片局部坐标是
   *
   * ```
   * v = group.matrix⁻¹ · (p − root.position)
   * canonical = root.position + v
   * ```
   *
   * 关掉本功能、或网格不在已放置的瓦片里时**原样返回同一个对象**，
   * 默认路径一次矩阵运算都不做。
   */
  toCanonicalScene(p: THREE.Vector3, mesh?: THREE.Object3D | null): THREE.Vector3 {
    if (!this.host.perTilePlacement() || !mesh) return p;
    // 网格直接挂在瓦片 group 下（`_registerTile` 就是遍历 node.group.children）；
    // 往上找到第一个带 tileCenter 的祖先，避免依赖层级深度
    let group: THREE.Object3D | null = mesh.parent;
    while (group && !(group.userData as { tileCenter?: unknown }).tileCenter) group = group.parent;
    if (!group) return p;
    const root = group.parent;
    if (!root) return p;

    return p
      .clone()
      .sub(root.position)
      .applyMatrix4((group.userData as { placementInverse?: THREE.Matrix4 }).placementInverse ?? _tilePlacementInverse.copy(group.matrix).invert())
      .add(root.position);
  }

  /**
   * 场景锚点变了（`recomputeAnchors`）之后，所有已注册瓦片的放置都要重算 ——
   * `k` 与 `position` 都依赖场景锚点。没存 `tileCenter` 的（未开启本功能时注册的）
   * 一律跳过，保证默认路径不产生任何副作用。
   */
  reapply(): void {
    for (const entry of this.host.datasets()) {
      if (!entry.anchor) continue;
      for (const child of entry.root.children) {
        const c = (child.userData as { tileCenter?: { x: number; y: number; z: number } }).tileCenter;
        if (c) this.apply(child, c, entry);
      }
    }
  }
}
