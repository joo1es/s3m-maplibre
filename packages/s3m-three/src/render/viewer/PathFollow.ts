/**
 * 沿路径运动：CPU 路径补间（`followPath`）+ GPU 路径实例化（`bindGPUPath`）两套。
 *
 * 从 `S3MViewer.ts` 搬出来（issue #27 第二轮 P9 阶段），行为逐字未变。
 *
 * 两套的区别值得先说清楚，因为它们的接口几乎同名：
 *   - **CPU**：把「进度 0→1」当成一条普通补间，通道的 write 把进度映射成弧长再查表得位置，
 *     每帧在 JS 里写 `translation`。适合几十个单体。
 *   - **GPU**：位移发生在顶点着色器里（`StyleMaterial` 的 row5 分支），JS 侧只在需要回答
 *     「屏幕上现在在哪」时按同一套公式复算。适合几千个实例。
 *     两边公式必须逐行对应 —— 改 `_gpuPathPoseAt` 就要同步改 shader，反之亦然。
 *
 * 状态归属：两个采样缓冲（`_pathScratch`）跟着本模块走；`pathSpecs` 留在宿主 ——
 * `unmount` 和 `removeFeatureStyle` 都要清它，属于跨模块的生命周期。
 */
import type * as THREE from 'three';
import { Path } from '../../anim/Path.js';
import type { Animator } from '../../anim/Animator.js';
import type { StyleUniforms } from '../../core/types.js';
import type { GPUPathManager } from '../GPUPathManager.js';
import type { FeatureStyleManager, GPUPathOptions } from '../FeatureStyleManager.js';
import type { PathFollowOptions } from './types.js';

/** 一条 CPU 路径的规格：折线 + 相对基准点的偏移 */
export interface PathSpec {
  path: Path;
  offset: [number, number, number];
}

/** `PathFollow` 需要的宿主入口 */
export interface PathFollowHost {
  /** 补间调度器（`Path` 复用它的通道、循环、缓动与预算） */
  readonly animator: Animator;
  /** GPU 路径库（路径注册表 + uniform 上传） */
  readonly gpuPathManager: GPUPathManager;
  /** 共享 uniform（`uPathTime` 在这里） */
  readonly uniforms: StyleUniforms;
  /** 单体样式（CPU 路径写 `translation`，GPU 路径写 `gpuPath`） */
  readonly styles: FeatureStyleManager;
  /** `feature.<smid>.path` → 路径规格；宿主在 unmount 与移除样式时也会清 */
  readonly pathSpecs: Map<string, PathSpec>;
  /** smid → 该单体的全部网格 */
  meshesOf(smids: Iterable<number>): Set<THREE.Mesh>;
  /** 全局路径时间是否由 JS 手动控制（`setGPUPathTime(t, false)` 之后为 true） */
  setCustomPathTime(custom: boolean): void;
}

export class PathFollow {
  /** 最近一次采样结果；复用一个缓冲避免每帧分配 */
  private readonly _pathScratch = new Float32Array(3);
  private readonly _pathScratch2 = new Float32Array(3);

  constructor(private readonly host: PathFollowHost) {}

  /**
   * 让单体沿折线运动。
   *
   * 路径先做**弧长参数化**（见 anim/Path.ts）：缓动作用在「已走距离」上，而不是
   * 顶点索引上，所以顶点疏密不均也不会忽快忽慢。
   *
   * 实现上没有引入新的 track 类型——把「进度 0→1」当成一条普通补间，通道的 write
   * 把进度映射成弧长再查表得位置。这样打断、循环、缓动、预算全部复用现有调度器。
   *
   * 注意：不要和 `moveFeature` 同时驱动同一个单体，两者都写 `translation`。
   */
  followPath(
    smid: number,
    points: Path | ArrayLike<number> | Array<[number, number, number]>,
    opts: PathFollowOptions = {}
  ): void {
    const path = points instanceof Path ? points : new Path(points, { closed: opts.closed });
    if (path.length <= 0) return;

    const offset = opts.offset ?? [0, 0, 0];
    const duration =
      opts.duration ??
      (opts.speed && opts.speed > 0 ? (path.length / opts.speed) * 1000 : 2000);

    const key = `feature.${smid}.path`;
    this.host.pathSpecs.set(key, { path, offset });
    if (!this.host.animator.has(key)) {
      this.host.animator.register(key, {
        dim: 1,
        // 每次都从起点开始：进度通道没有「当前值」的概念，循环时正好重置
        read: (out) => {
          out[0] = 0;
        },
        write: (v) => {
          const spec = this.host.pathSpecs.get(key);
          if (!spec) return;
          spec.path.sampleAt(v[0], this._pathScratch);
          const meshes = this.host.meshesOf([smid]);
          const cur = this.host.styles.getFeatureStyle(smid) ?? {};
          this.host.styles.setFeatureStyle(
            smid,
            {
              ...cur,
              translation: [
                spec.offset[0] + this._pathScratch[0],
                spec.offset[1] + this._pathScratch[1],
                spec.offset[2] + this._pathScratch[2],
              ],
            },
            meshes
          );
          // 轨迹可能跑到原始包围球外，关掉视锥剔除免得整块瓦片被剔掉
          for (const mesh of meshes) mesh.frustumCulled = false;
        },
      });
    }

    const run = (): void => {
      this.host.animator.to(key, 1, {
        duration,
        easing: opts.easing ?? 'linear',
        onComplete: () => {
          if (opts.loop) run();
          else opts.onComplete?.();
        },
      });
    };
    run();
  }

  /** 停下路径运动（停在当前位置，不回弹） */
  stopPath(smid: number): void {
    const key = `feature.${smid}.path`;
    this.host.animator.cancel(key);
    this.host.animator.unregister(key);
    this.host.pathSpecs.delete(key);
  }

  /**
   * 换算 GPU 路径单体在**当前时间**的位置与朝向。
   *
   * 位移发生在顶点着色器里，JS 侧要拿到「屏幕上现在在哪」只能按同一套公式在 CPU 复算：
   * `t = phase + uPathTime * speed`，再按 loop 模式夹到 0~1，最后查弧长表。
   * 与 StyleMaterial 的 row5 分支逐行对应，改那边时这里必须同步。
   */
  gpuPathPoseAt(smid: number): { pos: [number, number, number]; yaw: number } | null {
    const gp = this.host.styles.getFeatureStyle(smid)?.gpuPath;
    if (!gp) return null;
    const path = this.host.gpuPathManager.getPath(gp.pathId);
    if (!path || path.length <= 0) return null;

    const time = this.host.uniforms.uPathTime?.value ?? 0;
    let t = (gp.phase ?? 0) + time * (gp.speed ?? 0);
    const loop = gp.loop;
    if (loop === 'clamp' || loop === false) {
      t = Math.min(1, Math.max(0, t));
    } else if (loop === 'pingpong') {
      t = t % 2;
      if (t < 0) t += 2;
      t = t > 1 ? 2 - t : t;
    } else {
      t = t - Math.floor(t);
    }

    path.sampleAt(t, this._pathScratch);
    const pos: [number, number, number] = [this._pathScratch[0], this._pathScratch[1], this._pathScratch[2]];

    let yaw = 0;
    if (gp.autoHeading !== false) {
      const d = 1e-3;
      path.sampleAt(Math.min(1, t + d), this._pathScratch2);
      let dx = this._pathScratch2[0] - pos[0];
      let dy = this._pathScratch2[1] - pos[1];
      if (dx * dx + dy * dy < 1e-8) {
        // 已经在终点：退回用「后一点减前一点」求切线
        path.sampleAt(Math.max(0, t - d), this._pathScratch2);
        dx = pos[0] - this._pathScratch2[0];
        dy = pos[1] - this._pathScratch2[1];
      }
      if (dx * dx + dy * dy >= 1e-8) yaw = Math.atan2(dy, dx);
    }
    return { pos, yaw };
  }

  /**
   * 注册 GPU 路径到路径库
   * @param points 折线点数组或 Path 实例
   * @param opts 选项（可指定路径 ID 或闭合）
   * @returns 路径 ID
   */
  registerGPUPath(
    points: Path | ArrayLike<number> | Array<[number, number, number]>,
    opts: { id?: number; name?: string; closed?: boolean } = {}
  ): number {
    const id = this.host.gpuPathManager.registerPath(points, opts);
    this.host.gpuPathManager.updateUniforms(this.host.uniforms);
    return id;
  }

  /**
   * 注销 GPU 路径
   */
  unregisterGPUPath(id: number): boolean {
    const res = this.host.gpuPathManager.unregisterPath(id);
    this.host.gpuPathManager.updateUniforms(this.host.uniforms);
    return res;
  }

  /**
   * 获取 GPUPathManager 实例
   */
  getGPUPathManager(): GPUPathManager {
    return this.host.gpuPathManager;
  }

  /**
   * 将单体绑定到 GPU 路径动画（智慧交通车流 / 大批量巡检无人机）
   * @param smid 单体 ID
   * @param path 路径 ID 或新的路径折线
   * @param options 动画配置（速度、相位、循环模式、自动朝向等）
   */
  bindGPUPath(
    smid: number,
    path: number | Path | ArrayLike<number> | Array<[number, number, number]>,
    options: Omit<GPUPathOptions, 'pathId'> = {}
  ): number {
    let pathId: number;
    if (typeof path === 'number') {
      pathId = path;
    } else {
      pathId = this.registerGPUPath(path);
    }
    const meshes = this.host.meshesOf([smid]);
    this.host.styles.bindGPUPath(smid, pathId, options, meshes);
    for (const mesh of meshes) mesh.frustumCulled = false;
    this.host.gpuPathManager.updateUniforms(this.host.uniforms);
    return pathId;
  }

  /**
   * 解绑单体的 GPU 路径动画
   */
  unbindGPUPath(smid: number): void {
    const meshes = this.host.meshesOf([smid]);
    this.host.styles.unbindGPUPath(smid, meshes);
    this.host.gpuPathManager.updateUniforms(this.host.uniforms);
  }

  /**
   * 手动设置单体在 GPU 路径上的归一化进度（0.0 ~ 1.0）
   */
  setGPUPathProgress(smid: number, progress: number): void {
    const meshes = this.host.meshesOf([smid]);
    this.host.styles.setGPUPathProgress(smid, progress, meshes);
    for (const mesh of meshes) mesh.frustumCulled = false;
  }

  /**
   * 设置全局 GPU 路径时间（秒）
   */
  setGPUPathTime(time: number, autoAdvance = false): void {
    if (this.host.uniforms.uPathTime) {
      this.host.uniforms.uPathTime.value = time;
    }
    this.host.setCustomPathTime(!autoAdvance);
  }

  /**
   * 获取全局 GPU 路径时间（秒）
   */
  getGPUPathTime(): number {
    return this.host.uniforms.uPathTime?.value ?? 0;
  }
}
