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
}

export class GroundManager {
  mode: GroundMode;
  opacity: number;
  color: THREE.Color;
  gridColor: THREE.Color;
  gridSize: number;
  excavationBounds: [number, number, number, number] | null = null;
  size: number;

  readonly group: THREE.Group;
  private _mesh: THREE.Mesh | null = null;
  private _material: THREE.ShaderMaterial | null = null;

  constructor(options: GroundOptions = {}) {
    this.mode = options.mode ?? 'none';
    this.opacity = options.opacity ?? 0.62;
    this.color = new THREE.Color(options.color ?? '#0f172a');
    this.gridColor = new THREE.Color(options.gridColor ?? '#38bdf8');
    this.gridSize = options.gridSize ?? 10.0;
    this.excavationBounds = options.excavationBounds ?? null;
    this.size = options.size ?? 6000;

    this.group = new THREE.Group();
    this.group.name = 's3m-ground-surface';
    this._initMesh();
  }

  private _initMesh(): void {
    const geom = new THREE.PlaneGeometry(this.size, this.size, 1, 1);

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
    this.group.visible = this.mode !== 'none';
    this._syncUniforms();
  }

  /**
   * 每帧根据相机位置更新地表网格中心，实现地表随相机平移而无限延伸且网格线不漂移
   */
  update(camera?: THREE.Camera | null): void {
    if (!camera || this.mode === 'none') return;
    this.group.position.set(camera.position.x, camera.position.y, 0);
  }

  setMode(mode: GroundMode): void {
    this.mode = mode;
    this.group.visible = mode !== 'none';
    if (this._material) {
      this._material.uniforms.uMode.value = mode === 'excavate' ? 2 : mode === 'translucent' ? 1 : 0;
      this._material.depthWrite = mode === 'excavate';
    }
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
    if (!this._material) return;
    const u = this._material.uniforms;
    if (this.excavationBounds) {
      u.uHasExcavation.value = 1;
      u.uExcavationMin.value.set(this.excavationBounds[0], this.excavationBounds[1]);
      u.uExcavationMax.value.set(this.excavationBounds[2], this.excavationBounds[3]);
    } else {
      u.uHasExcavation.value = 0;
    }
  }

  dispose(): void {
    if (this._mesh) {
      this._mesh.geometry.dispose();
      this._material?.dispose();
    }
    this.group.clear();
  }
}
