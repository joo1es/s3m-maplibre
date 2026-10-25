/**
 * 3D 物理地表面与基坑开挖管理器
 *
 * 解决地下工程无法表达「真实覆盖/遮挡关系」的核心痛点：
 * 1. 在场景 ENU 高程 Z = 0（真实地表面）建立物理 3D 覆盖网格。
 * 2. 参与 WebGL 深度测试：
 *    - 地上部分（出入口站房 Z > 0）：位于地表面前方，无遮挡突出于地表；
 *    - 地下部分（站台/站厅/隧道 Z < 0）：位于地表面后方，被地表物理覆盖并透过半透明地质网格展现；
 *    - 地表相交线（Z = 0）：出入口穿透地表处有清晰物理交线。
 * 3. 支持「基坑开挖模式（Excavate）」与「地下透视模式（Translucent）」，
 *    可开辟虚拟基坑井口或全域透视地表。
 *
 * 关于「遮挡」：地表能不能挡住建筑，只取决于有没有一块**先于建筑绘制、并且写了深度**的
 * 几何进到同一深度缓冲里。半透明覆盖网格 `depthWrite = false` 且排在 transparent 队列末尾，
 * 它只是画在上面的一层色，不参与遮挡；真正的遮挡由独立的**纯深度代理**（`_depthMesh`，
 * `colorWrite = false` + `renderOrder` 负值）负责，可用 `occlude` 开关控制。
 * 与 MapLibre terrain 共用同一深度缓冲，两者是「深度来源」的关系而非替代关系。
 */
import * as THREE from 'three';

export type GroundMode = 'none' | 'translucent' | 'excavate';

export interface GroundOptions {
  mode?: GroundMode;
  /** 地表不透明度 (0~1，默认 0.65) */
  opacity?: number;
  /** 地表基础土层底色 */
  color?: string;
  /** 地表网格线颜色 */
  gridColor?: string;
  /** 网格线间距（米，默认 10） */
  gridSize?: number;
  /** 基坑开挖范围 [minX, minY, maxX, maxY]（ENU 米坐标），留空自动根据模型范围推算 */
  excavationBounds?: [number, number, number, number] | null;
  /** 地表范围大小（米，默认 6000） */
  size?: number;
  /**
   * 地表高度是否跟随主数据集的抬升量（`setDatasetHeight`），默认 `true`。
   *
   * `true` 服务贴地工作流：模型整体抬到地面高程时，切割面必须跟着抬到同一高程，
   * 否则整个模型会被齐根切掉。
   * `false` 把地表钉死在当前高度（默认场景 z=0）：高程调整只动模型不动切割面，
   * 滑杆变成直观的「控制埋深 / 切掉多少」。
   */
  trackHeight?: boolean;
  /**
   * 地表是否作为深度遮挡源：开启后，位于地表以下的几何（地下站厅 / 隧道 / 管线）
   * 会被地表真正切掉，而不是透过半透明地表显露。
   *
   * **与 mode 解耦**：`mode: 'none'` 时也可以单独开启 —— 不显示任何地表，
   * 只留一块隐形地面把地面以下切掉。默认值取 `mode === 'excavate'`
   * （开挖模式下坑外的地下部分本就该被土体挡住），`'translucent'` 下默认关闭
   * —— 那一模式的全部意义就是「能看穿地表」。
   *
   * 实现上由一块 `colorWrite = false`、排在 opaque 队列最前的纯深度代理完成，
   * 与 MapLibre terrain 写入的深度共用同一个深度缓冲，互不冲突（谁更近谁赢）。
   */
  occlude?: boolean;
}

export class GroundManager {
  mode: GroundMode;
  opacity: number;
  color: THREE.Color;
  gridColor: THREE.Color;
  gridSize: number;
  excavationBounds: [number, number, number, number] | null = null;
  size: number;
  /** 物理地表网格的高度（米，场景 ENU Z 坐标），默认 0 */
  groundHeight = 0;
  /** 地表是否作为深度遮挡源（见 `GroundOptions.occlude`） */
  occlude: boolean;
  /** 地表高度是否跟随主数据集抬升量（见 `GroundOptions.trackHeight`），默认 true */
  trackHeight: boolean;

  readonly group: THREE.Group;
  private _mesh: THREE.Mesh | null = null;
  private _material: THREE.ShaderMaterial | null = null;
  /** 纯深度代理：只写深度不写颜色，负责真正的遮挡 */
  private _depthMesh: THREE.Mesh | null = null;
  private _depthMaterial: THREE.ShaderMaterial | null = null;
  private _geom: THREE.PlaneGeometry | null = null;
  /** 用户显式指定过 occlude 后，setMode 不再自动改写它 */
  private _occludeExplicit: boolean;

  constructor(options: GroundOptions = {}) {
    this.mode = options.mode ?? 'none';
    this.opacity = options.opacity ?? 0.62;
    this.color = new THREE.Color(options.color ?? '#0f172a');
    this.gridColor = new THREE.Color(options.gridColor ?? '#38bdf8');
    this.gridSize = options.gridSize ?? 10.0;
    this.excavationBounds = options.excavationBounds ?? null;
    this.size = options.size ?? 6000;
    this._occludeExplicit = options.occlude !== undefined;
    this.occlude = options.occlude ?? this.mode === 'excavate';
    this.trackHeight = options.trackHeight ?? true;

    this.group = new THREE.Group();
    this.group.name = 's3m-ground-surface';
    this._initMesh();
    // 构造时就按当前 mode 应用一次：以前 depthWrite / 可见性只在 setMode 里改，
    // 用 `{ mode: 'excavate' }` 建出来的实例会一直停在 depthWrite = false。
    this._applyMode();
  }

  private _initMesh(): void {
    const geom = new THREE.PlaneGeometry(this.size, this.size, 1, 1);
    this._geom = geom;

    // ENU 坐标系下，Z 为天（Up），PlaneGeometry 默认在 XY 平面上，正常法线正是 (0, 0, 1)！
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: this.color },
        uGridColor: { value: this.gridColor },
        uOpacity: { value: this.opacity },
        uGridSize: { value: this.gridSize },
        uMode: { value: this.mode === 'excavate' ? 2 : this.mode === 'translucent' ? 1 : 0 },
        uHasExcavation: { value: 0 },
        uExcavationMin: { value: new THREE.Vector2(-9999, -9999) },
        uExcavationMax: { value: new THREE.Vector2(9999, 9999) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vEnuPos;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vEnuPos = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uGridColor;
        uniform float uOpacity;
        uniform float uGridSize;
        uniform int uMode; // 0: none, 1: translucent, 2: excavate
        uniform int uHasExcavation;
        uniform vec2 uExcavationMin;
        uniform vec2 uExcavationMax;

        varying vec2 vEnuPos;

        void main() {
          if (uMode == 0) discard;

          bool insidePit = false;
          if (uHasExcavation == 1) {
            insidePit = vEnuPos.x >= uExcavationMin.x && vEnuPos.x <= uExcavationMax.x &&
                        vEnuPos.y >= uExcavationMin.y && vEnuPos.y <= uExcavationMax.y;
          }

          // 基坑开挖模式：坑内完全挖空，无遮挡露出地下构造
          if (uMode == 2 && insidePit) {
            discard;
          }

          // 程序化抗锯齿网格
          vec2 coord = vEnuPos / uGridSize;
          vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
          float line = 1.0 - min(min(grid.x, grid.y), 1.0);

          // 大网格线（每 5 格一条粗线）
          vec2 coord5 = coord / 5.0;
          vec2 grid5 = abs(fract(coord5 - 0.5) - 0.5) / fwidth(coord5);
          float line5 = 1.0 - min(min(grid5.x, grid5.y), 1.0);

          float gridFactor = clamp(line * 0.4 + line5 * 0.7, 0.0, 1.0);

          vec3 finalColor = mix(uColor, uGridColor, gridFactor);
          float finalAlpha = uOpacity;

          // 透视模式下如果落在基坑内，地表网格淡化为镂空导引网
          if (uMode == 1 && insidePit) {
            finalAlpha = mix(0.12, 0.35, gridFactor);
          } else {
            finalAlpha = mix(uOpacity * 0.82, min(1.0, uOpacity + 0.3), gridFactor);
          }

          gl_FragColor = vec4(finalColor, finalAlpha);
        }
      `,
    });

    const mesh = new THREE.Mesh(geom, material);
    mesh.position.set(0, 0, 0); // 锚定在场景高程 Z = 0（地表面）
    mesh.renderOrder = 200; // 在不透明物体之后渲染，以正确实现半透明覆盖
    this.group.add(mesh);

    this._mesh = mesh;
    this._material = material;

    // ---- 纯深度代理 ----
    // 遮挡是「片元绘制那一刻」由深度测试决定的：覆盖网格排在 transparent 队列末尾，
    // 房子早就画完了，它写不写深度都挡不住任何东西。所以单独放一块只写深度、
    // 不写颜色、排进 opaque 队列最前的孪生网格，让后续所有片元在它后面被裁掉。
    const depthMaterial = new THREE.ShaderMaterial({
      // 关掉颜色写入但仍走 depthWrite ⇒ 只留一层「隐形墙」
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      transparent: false, // 必须是 opaque，才能靠 renderOrder 抢到全场景最前
      // 只挡「从上方看下去」的方向：相机钻到地下时不该被自己这层地表糊住
      side: THREE.FrontSide,
      uniforms: {
        // 基坑开挖时，坑口是「挖开的地方」，地下必须还能看见 ⇒ 代理也要在这里开洞
        uPunchPit: { value: 0 },
        uHasExcavation: { value: 0 },
        uExcavationMin: { value: new THREE.Vector2(-9999, -9999) },
        uExcavationMax: { value: new THREE.Vector2(9999, 9999) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vEnuPos;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vEnuPos = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform int uPunchPit;
        uniform int uHasExcavation;
        uniform vec2 uExcavationMin;
        uniform vec2 uExcavationMax;
        varying vec2 vEnuPos;
        void main() {
          if (uPunchPit == 1 && uHasExcavation == 1 &&
              vEnuPos.x >= uExcavationMin.x && vEnuPos.x <= uExcavationMax.x &&
              vEnuPos.y >= uExcavationMin.y && vEnuPos.y <= uExcavationMax.y) {
            discard;
          }
          gl_FragColor = vec4(1.0);
        }
      `,
    });

    const depthMesh = new THREE.Mesh(geom, depthMaterial);
    // 比覆盖网格低 2cm：避免与它等深度打架（覆盖层 LEQUAL 时仍能画上去）
    depthMesh.position.set(0, 0, -0.02);
    depthMesh.renderOrder = -1000;
    depthMesh.name = 's3m-ground-depth';
    depthMesh.visible = false;
    this.group.add(depthMesh);

    this._depthMesh = depthMesh;
    this._depthMaterial = depthMaterial;

    this._syncUniforms();
  }

  /**
   * 把 mode / occlude 的状态一次性刷到材质和可见性上。
   * 构造与 setMode / setOcclude 都走这里，避免出现「构造时漏设」的分叉。
   *
   * 覆盖网格与深度代理**各自独立控制**：
   *   - 覆盖网格（视觉）只跟 mode 走；
   *   - 深度代理（遮挡）只跟 occlude 走 —— mode 'none' 时也可以单独开一块
   *     「隐形地面」把地面以下切掉，不显示任何地表。
   */
  private _applyMode(): void {
    if (this._mesh) this._mesh.visible = this.mode !== 'none';
    if (this._material) {
      this._material.uniforms.uMode.value = this.mode === 'excavate' ? 2 : this.mode === 'translucent' ? 1 : 0;
      // 覆盖网格排在最后，写深度的意义已经由代理接管，这里保留 excavate 的历史行为
      this._material.depthWrite = this.mode === 'excavate';
    }
    if (this._depthMesh) {
      this._depthMesh.visible = this.occlude;
      if (this._depthMaterial) {
        // 只有开挖模式才在坑口开洞；translucent / none + occlude 是「一刀切」语义
        this._depthMaterial.uniforms.uPunchPit.value = this.mode === 'excavate' ? 1 : 0;
      }
    }
  }

  /**
   * 每帧根据相机位置更新地表网格中心，实现地表随相机平移而无限延伸且网格线不漂移。
   * 遮挡代理与地表模式已解耦，所以 mode 'none' 时也要跟着相机走。
   */
  update(camera?: THREE.Camera | null): void {
    if (!camera) return;
    this.group.position.set(camera.position.x, camera.position.y, this.groundHeight);
  }

  /**
   * 设置物理地表网格的高度（米，场景 ENU Z 坐标）
   *
   * 数据集被抬到真实地面高程后，地表网格需要同步抬高，
   * 否则「地表覆盖 / 地下透视」的物理关系会与被抬升的模型脱节。
   */
  setGroundHeight(height: number): void {
    this.groundHeight = height;
    this.group.position.z = height;
  }

  setMode(mode: GroundMode): void {
    this.mode = mode;
    // 没显式要过 occlude 的，跟着模式走：开挖模式才遮挡
    if (!this._occludeExplicit) this.occlude = mode === 'excavate';
    this._applyMode();
  }

  /**
   * 开关「地表作为深度遮挡源」。
   *
   * 打开后地表以下的几何会被真正切掉（不再透过地表显露）；关闭后回到纯视觉覆盖。
   * 与宿主是否开启 MapLibre terrain 无关：两者都在同一个深度缓冲里比深度，谁更近谁赢。
   */
  setOcclude(enabled: boolean): void {
    this.occlude = enabled;
    this._occludeExplicit = true;
    this._applyMode();
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity));
    if (this._material) this._material.uniforms.uOpacity.value = this.opacity;
  }

  setColors(color: string, gridColor?: string): void {
    this.color.set(color);
    if (gridColor) this.gridColor.set(gridColor);
    if (this._material) {
      this._material.uniforms.uColor.value = this.color;
      this._material.uniforms.uGridColor.value = this.gridColor;
    }
  }

  setExcavationBounds(bounds: [number, number, number, number] | null): void {
    this.excavationBounds = bounds;
    this._syncUniforms();
  }

  /**
   * 自动根据各数据集的三维包围盒范围计算基坑开挖范围
   */
  autoFitExcavation(datasets: Iterable<{ offset: [number, number, number]; tileset: any }>): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let found = false;

    for (const d of datasets) {
      const cfg = d.tileset?.config;
      const roots = cfg?.rootTiles ?? cfg?.tiles;
      if (!Array.isArray(roots)) continue;
      for (const r of roots) {
        const box = r.boundingBox;
        if (!box) continue;
        const c = box.center ?? { x: 0, y: 0 };
        const xExt = box.xExtent?.x ? Math.abs(box.xExtent.x) : 50;
        const yExt = box.yExtent?.y ? Math.abs(box.yExtent.y) : 50;
        const bMinX = c.x + d.offset[0] - xExt;
        const bMaxX = c.x + d.offset[0] + xExt;
        const bMinY = c.y + d.offset[1] - yExt;
        const bMaxY = c.y + d.offset[1] + yExt;
        if (bMinX < minX) minX = bMinX;
        if (bMaxX > maxX) maxX = bMaxX;
        if (bMinY < minY) minY = bMinY;
        if (bMaxY > maxY) maxY = bMaxY;
        found = true;
      }
    }

    if (found && Number.isFinite(minX)) {
      // 外扩 5 米形成基坑施工边界
      const pad = 5.0;
      this.setExcavationBounds([minX - pad, minY - pad, maxX + pad, maxY + pad]);
    }
  }

  private _syncUniforms(): void {
    const bounds = this.excavationBounds;
    if (this._material) {
      const u = this._material.uniforms;
      if (bounds) {
        u.uHasExcavation.value = 1;
        u.uExcavationMin.value.set(bounds[0], bounds[1]);
        u.uExcavationMax.value.set(bounds[2], bounds[3]);
      } else {
        u.uHasExcavation.value = 0;
      }
    }
    // 深度代理要和覆盖网格用同一套基坑参数，否则坑口会出现「看得见色块、却被挡住地下」
    if (this._depthMaterial) {
      const d = this._depthMaterial.uniforms;
      if (bounds) {
        d.uHasExcavation.value = 1;
        d.uExcavationMin.value.set(bounds[0], bounds[1]);
        d.uExcavationMax.value.set(bounds[2], bounds[3]);
      } else {
        d.uHasExcavation.value = 0;
      }
    }
  }

  dispose(): void {
    // 两块网格共用同一份 geometry，只释放一次
    this._geom?.dispose();
    this._geom = null;
    this._material?.dispose();
    this._material = null;
    this._depthMaterial?.dispose();
    this._depthMaterial = null;
    this._mesh = null;
    this._depthMesh = null;
    this.group.clear();
  }
}
