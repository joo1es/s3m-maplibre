/**
 * 世界高度范围的增量维护。
 *
 * 原来每注册一块瓦片都要把所有网格重新遍历一遍、每个都 clone 一个 Box3 再乘矩阵，
 * 加载 n 块瓦片就是 O(n²) 次矩阵乘 + n² 个垃圾对象。现在只在网格进出的记一次，
 * 全局值从缓存里滚：只有被移除的那块正好卡在边界上时，才回退到一次 O(n) 重算。
 *
 * 结果写进共享 uniform `uHeightMin` / `uHeightMax`，供着色器做高度渐变 / 拔高。
 */
import * as THREE from 'three';
import type { StyleUniforms } from '../../core/types.js';

export class HeightIndex {
  /** 每块网格的世界高度范围 */
  private readonly _meshHeight = new Map<THREE.Mesh, { min: number; max: number }>();
  private _min = Infinity;
  private _max = -Infinity;
  /** 换算世界包围盒用的临时对象，避免每次 new */
  private readonly _box = new THREE.Box3();

  constructor(private readonly uniforms: StyleUniforms) {}

  get size(): number {
    return this._meshHeight.size;
  }

  add(mesh: THREE.Mesh): void {
    const bb = mesh.geometry?.boundingBox;
    if (!bb) return;
    this._box.copy(bb).applyMatrix4(mesh.matrixWorld);
    const min = this._box.min.z;
    const max = this._box.max.z;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    this._meshHeight.set(mesh, { min, max });
    if (min < this._min) this._min = min;
    if (max > this._max) this._max = max;
    this._push();
  }

  remove(mesh: THREE.Mesh): void {
    const rec = this._meshHeight.get(mesh);
    if (!rec) return;
    this._meshHeight.delete(mesh);
    // 只有正好卡在边界上才需要重算，否则滚动的 min/max 依然成立
    if (rec.min === this._min || rec.max === this._max) this._recompute();
    else this._push();
  }

  /** 数据集整体位移（换高程偏移 / 重新布局）后，缓存的世界高度全部失效 */
  refreshAll(): void {
    if (this._meshHeight.size === 0) return;
    const meshes = [...this._meshHeight.keys()];
    this._meshHeight.clear();
    this._min = Infinity;
    this._max = -Infinity;
    for (const mesh of meshes) this.add(mesh);
    this._push();
  }

  /** 场景清空时重置 */
  clear(): void {
    this._meshHeight.clear();
    this._min = Infinity;
    this._max = -Infinity;
  }

  /** 当前高度范围（未初始化时是 Infinity / -Infinity，调用方自己兜底） */
  get range(): { min: number; max: number } {
    return { min: this._min, max: this._max };
  }

  private _recompute(): void {
    let min = Infinity;
    let max = -Infinity;
    for (const h of this._meshHeight.values()) {
      if (h.min < min) min = h.min;
      if (h.max > max) max = h.max;
    }
    this._min = min;
    this._max = max;
    this._push();
  }

  private _push(): void {
    let min = this._min;
    let max = this._max;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      min = 0;
      max = 100;
    }
    this.uniforms.uHeightMin.value = min;
    this.uniforms.uHeightMax.value = max;
  }
}
