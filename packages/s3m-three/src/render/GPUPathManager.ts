/**
 * GPU 路径动画管理器
 *
 * 负责：
 * 1. 注册与管理多条三维离散路径（Path）
 * 2. 将空间折线等弧长采样并烘焙为 Float32Array 格式的 2D 数据纹理 (uPathTex)：
 *    - Width: SAMPLES_PER_PATH (默认 256)
 *    - Height: max(pathCount, 1)
 *    - Format: RGBAFormat, FloatType
 *    - 像素通道:
 *      - R: X 坐标 (米)
 *      - G: Y 坐标 (米)
 *      - B: Z 坐标 (米)
 *      - A: 切线偏航角 yaw (弧度, atan2(dy, dx), 经过连续角度展开 unwrap)
 * 3. 硬件双线性插值 (LinearFilter) 支持：
 *    GPU 在顶点着色器中按归一化进度 t (0~1) 采样，硬件自动插值获得平滑轨迹与朝向
 */
import * as THREE from 'three';
import { Path } from '../anim/Path.js';

export const SAMPLES_PER_PATH = 256;

export interface GPUPathInfo {
  id: number;
  name?: string;
  path: Path;
}

export class GPUPathManager {
  private _paths: Map<number, GPUPathInfo> = new Map();
  private _nextId = 0;
  private _texture: THREE.DataTexture | null = null;
  private _data: Float32Array | null = null;
  private _dirty = false;

  /** 默认空纹理，防止 WebGL 未绑定报错 */
  static readonly DUMMY_PATH_TEX: THREE.DataTexture = (() => {
    const data = new Float32Array(SAMPLES_PER_PATH * 1 * 4);
    const tex = new THREE.DataTexture(data, SAMPLES_PER_PATH, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  })();

  constructor() {}

  /**
   * 注册一条路径到 GPU 路径库
   * @param pointsOrPath 折线点数组或现有的 Path 实例
   * @param opts 注册选项（可指定固定 id 或 name）
   * @returns 分配的路径 ID (从 0 开始的连续或离散索引)
   */
  registerPath(
    pointsOrPath: Path | ArrayLike<number> | Array<[number, number, number]>,
    opts: { id?: number; name?: string; closed?: boolean } = {}
  ): number {
    const path =
      pointsOrPath instanceof Path
        ? pointsOrPath
        : new Path(pointsOrPath, { closed: opts.closed });

    let id = opts.id;
    if (id == null) {
      id = this._nextId++;
      while (this._paths.has(id)) {
        id = this._nextId++;
      }
    } else {
      if (id >= this._nextId) {
        this._nextId = id + 1;
      }
    }

    this._paths.set(id, { id, name: opts.name, path });
    this._dirty = true;
    return id;
  }

  /**
   * 注销一条路径
   */
  unregisterPath(id: number): boolean {
    const removed = this._paths.delete(id);
    if (removed) {
      this._dirty = true;
    }
    return removed;
  }

  /**
   * 获取指定 ID 的路径对象
   */
  getPath(id: number): Path | undefined {
    return this._paths.get(id)?.path;
  }

  /**
   * 是否存在指定 ID 的路径
   */
  hasPath(id: number): boolean {
    return this._paths.has(id);
  }

  /**
   * 获取所有已注册的路径 ID
   */
  getPathIds(): number[] {
    return Array.from(this._paths.keys()).sort((a, b) => a - b);
  }

  /**
   * 清空所有已注册的路径
   */
  clear(): void {
    if (this._paths.size > 0) {
      this._paths.clear();
      this._nextId = 0;
      this._dirty = true;
    }
  }

  /**
   * 当前注册的有效路径数量
   */
  get count(): number {
    return this._paths.size;
  }

  /**
   * 获取 GPU 路径数据纹理，若有变动会自动触发重新烘焙
   */
  getTexture(): THREE.DataTexture {
    if (this._dirty || !this._texture) {
      this._bake();
    }
    return this._texture ?? GPUPathManager.DUMMY_PATH_TEX;
  }

  /**
   * 将当前路径纹理与 uniform 状态同步到材质 uniform 字典
   */
  updateUniforms(uniforms: Record<string, any>): void {
    const tex = this.getTexture();
    const active = this._paths.size > 0 ? 1 : 0;
    const maxId = this._getMaxPathId();
    const height = Math.max(maxId + 1, 1);

    if (uniforms.uPathTex) uniforms.uPathTex.value = tex;
    if (uniforms.uPathCount) uniforms.uPathCount.value = height;
    if (uniforms.uPathTexActive) uniforms.uPathTexActive.value = active;
  }

  /**
   * 烘焙路径数据到纹理
   */
  private _bake(): void {
    this._dirty = false;
    if (this._paths.size === 0) {
      if (this._texture && this._texture !== GPUPathManager.DUMMY_PATH_TEX) {
        this._texture.dispose();
      }
      this._texture = GPUPathManager.DUMMY_PATH_TEX;
      this._data = null;
      return;
    }

    const maxId = this._getMaxPathId();
    const height = Math.max(maxId + 1, 1);
    const totalPixels = SAMPLES_PER_PATH * height;
    const bufferLength = totalPixels * 4;

    if (!this._data || this._data.length !== bufferLength) {
      if (this._texture && this._texture !== GPUPathManager.DUMMY_PATH_TEX) {
        this._texture.dispose();
      }
      this._data = new Float32Array(bufferLength);
      this._texture = new THREE.DataTexture(
        this._data,
        SAMPLES_PER_PATH,
        height,
        THREE.RGBAFormat,
        THREE.FloatType
      );
      this._texture.minFilter = THREE.LinearFilter;
      this._texture.magFilter = THREE.LinearFilter;
      this._texture.wrapS = THREE.ClampToEdgeWrapping;
      this._texture.wrapT = THREE.ClampToEdgeWrapping;
    } else {
      this._data.fill(0);
    }

    const scratchA = [0, 0, 0];
    const scratchB = [0, 0, 0];
    const N = SAMPLES_PER_PATH;

    for (const [id, info] of this._paths) {
      if (id < 0 || id >= height) continue;
      const path = info.path;
      const rowOffset = id * N * 4;

      // 提取 N 个等弧长采样点位置与航向切线角
      let lastYaw = 0;
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        path.sampleAt(t, scratchA);

        // 计算切线方向：取一个极小的前向步长
        let yaw = lastYaw;
        if (path.length > 1e-4) {
          const deltaT = Math.min(1.0, t + 1e-3);
          path.sampleAt(deltaT, scratchB);
          let dx = scratchB[0] - scratchA[0];
          let dy = scratchB[1] - scratchA[1];
          if (dx * dx + dy * dy < 1e-8 && t > 0) {
            // 前向位移过小则尝试后向差分
            const prevT = Math.max(0.0, t - 1e-3);
            path.sampleAt(prevT, scratchB);
            dx = scratchA[0] - scratchB[0];
            dy = scratchA[1] - scratchB[1];
          }
          if (dx * dx + dy * dy >= 1e-8) {
            yaw = Math.atan2(dy, dx);
          }
        }

        // 连续角度展开 (Angle Unwrap)：避免在 ±PI 处发生 360° 线性插值回旋
        if (i > 0) {
          let diff = yaw - lastYaw;
          while (diff > Math.PI) {
            yaw -= 2 * Math.PI;
            diff = yaw - lastYaw;
          }
          while (diff < -Math.PI) {
            yaw += 2 * Math.PI;
            diff = yaw - lastYaw;
          }
        }
        lastYaw = yaw;

        const pIdx = rowOffset + i * 4;
        this._data[pIdx + 0] = scratchA[0];
        this._data[pIdx + 1] = scratchA[1];
        this._data[pIdx + 2] = scratchA[2];
        this._data[pIdx + 3] = yaw;
      }
    }

    if (this._texture) {
      this._texture.needsUpdate = true;
    }
  }

  private _getMaxPathId(): number {
    let max = 0;
    for (const id of this._paths.keys()) {
      if (id > max) max = id;
    }
    return max;
  }

  /**
   * 纯数学模拟采样烘焙纹理（用于单测验证硬件线性插值精度）
   */
  sampleBaked(pathId: number, t: number): { position: [number, number, number]; yaw: number } {
    if (!this._data || !this._paths.has(pathId)) {
      return { position: [0, 0, 0], yaw: 0 };
    }
    const maxId = this._getMaxPathId();
    if (pathId < 0 || pathId > maxId) {
      return { position: [0, 0, 0], yaw: 0 };
    }

    const N = SAMPLES_PER_PATH;
    const clampedT = Math.min(1.0, Math.max(0.0, t));
    const sampleCoord = clampedT * (N - 1);
    const i0 = Math.floor(sampleCoord);
    const i1 = Math.min(N - 1, i0 + 1);
    const frac = sampleCoord - i0;

    const rowOffset = pathId * N * 4;
    const idx0 = rowOffset + i0 * 4;
    const idx1 = rowOffset + i1 * 4;

    const x = this._data[idx0 + 0] * (1 - frac) + this._data[idx1 + 0] * frac;
    const y = this._data[idx0 + 1] * (1 - frac) + this._data[idx1 + 1] * frac;
    const z = this._data[idx0 + 2] * (1 - frac) + this._data[idx1 + 2] * frac;
    const yaw = this._data[idx0 + 3] * (1 - frac) + this._data[idx1 + 3] * frac;

    return { position: [x, y, z], yaw };
  }

  /**
   * 释放纹理与显存
   */
  dispose(): void {
    if (this._texture && this._texture !== GPUPathManager.DUMMY_PATH_TEX) {
      this._texture.dispose();
      this._texture = null;
    }
    this._data = null;
    this._paths.clear();
  }
}
