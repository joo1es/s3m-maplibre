/**
 * 泼溅排序的调度：什么时候重排、什么时候整帧跳过。
 *
 * 排序算法本身在 `core/SplatSort.ts`，单瓦片的重写在 `render/SplatSorter.ts`。
 * 这里只管一件事：**相机没动且没有新瓦片时，一帧都不要排**。
 *
 * 跳过条件用的是「视图矩阵完全相等」。地图交互时相机每帧都在变，所以这个条件
 * 实际上只在静止时命中 —— 这是刻意的：移动中必须每帧重排，否则 alpha 混合顺序
 * 会错，画面是彩色噪点。真正把代价压下去的是排序算法本身（基数排序，见 SplatSort）。
 */
import * as THREE from 'three';
import { sortSplatMesh } from '../SplatSorter.js';

export class SplatLayer {
  private readonly _lastView = new THREE.Matrix4();
  private readonly _view = new THREE.Matrix4();
  private _sorted = false;

  /** 有新瓦片进来 / 瓦片被淘汰：下一帧必须重排 */
  markDirty(): void {
    this._sorted = false;
  }

  /**
   * 按当前视角重排所有泼溅瓦片。
   *
   * 视图矩阵**不能**读 `camera.matrixWorldInverse`：内核把 `camera.projectionMatrix`
   * 换成了完整 `MVP · ENU`，为免渲染重复一次视图变换，`matrixWorldInverse` 被钉成单位矩阵
   * （见 `S3MViewer.renderFrame`）。所以这里自己由 `camera.position`（ENU 米）构造
   * `T(−camEnu)`，与旧口径逐位一致。
   *
   * @param pointClouds 场景里的点云集合（含非泼溅的，按 `userData.isGaussianSplat` 过滤）
   */
  sort(camera: THREE.Camera | null, pointClouds: Iterable<THREE.Points>): void {
    if (!camera) return;
    const view = this._view.makeTranslation(-camera.position.x, -camera.position.y, -camera.position.z);
    if (this._sorted && this._lastView.equals(view)) return;
    for (const pc of pointClouds) {
      if (!(pc.userData as { isGaussianSplat?: boolean }).isGaussianSplat) continue;
      sortSplatMesh(pc as unknown as THREE.Mesh, view);
    }
    this._lastView.copy(view);
    this._sorted = true;
  }

  /** 场景清空 / 换相机后重置，避免拿旧矩阵误判「已排过」 */
  reset(): void {
    this._sorted = false;
    this._lastView.identity();
  }
}
