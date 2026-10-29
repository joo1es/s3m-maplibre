/**
 * 棱线装饰：折边线 / 外推 / 背面外扩轮廓 / GPU 后处理描边。
 *
 * 从 `S3MViewer` 整体搬出来的最大一块。它只碰 `mesh.userData`（`edges` / `edgeHull` /
 * `nativeEdges`）与共享 uniform，不碰拾取表、不碰瓦片生命周期 —— 所以能独立成模块。
 *
 * ## 为什么外观 uniform 要共享
 *
 * 棱线材质必须**逐网格一份**（各绑各的单体状态纹理），但外观（颜色 / 粗细 / 透明度 /
 * 外推距离）必须全局统一。做法是外观 uniform 用同一批对象，`syncStyle()` 改一次全部生效，
 * 棱线淡入淡出也只改一个 `uEdgeFade` —— 新建瓦片自动继承当前进度。
 *
 * ## 三种画法的成本
 *
 * - `line` / `offset`：CPU 现算 EdgesGeometry，按 8ms 一帧切片建，几十万面不会卡死；
 * - `hull`：不建几何，把同一块网格沿法线外扩再画一遍，只画背面；
 * - `gpu`：零几何、零额外 pass 的片元描边，线宽约 1 像素。
 */
import * as THREE from 'three';
import type { Animator, TransitionOptions } from '../../anim/Animator.js';
import type { AuthenticateFn } from '../../core/AuthFetch.js';
import { authFetch } from '../../core/AuthFetch.js';
import type { StyleUniforms } from '../../core/types.js';
import {
  createOutlineMaterial,
  resolveEdgeModes,
  sameEdgeModes,
  type EdgeModes,
  type EdgesOption,
  type OutlineStyleUniforms,
  type StyledMaterial,
} from '../StyleMaterial.js';
import {
  buildFeatureEdgeSegments,
  buildPositionBatchMap,
  buildThickLineGeometry,
  createLineSharedUniforms,
  createThickLineMaterial,
  positionQuantKey,
  type LineSharedUniforms,
  type ThickLineMaterial,
  type ThickLineStyleUniforms,
} from '../EdgeLines.js';
import { mergeVerticesByPosition } from '../MergeVertices.js';
import { GpuEdgePass } from '../GpuEdgePass.js';
import type { S3MDatasetEntry } from '../DatasetManager.js';

/** 取网格上的 styled 材质（与 S3MViewer 里那份逐字一致） */
function styledMaterialOf(mesh: THREE.Mesh): StyledMaterial | null {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return (m as StyledMaterial | undefined)?.userData?.isStyled ? (m as StyledMaterial) : null;
}

/** 与 S3MViewer 里同名的工具（保持逐字一致，避免两处口径漂移） */
function clampOpacity(v: number | null | undefined): number {
  const n = v ?? 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 地形 / 绿地 / 道路 / 地面铺装等不参与自动描边（数据自带棱线包另说） */
const EDGE_SKIP_KEYWORDS = [
  'terrain', 'ground', 'vegetation', 'green', 'road', 'dem',
  '绿地', '道路', '地面', '地形', '植被', '铺装',
];

/** 一块网格的装饰状态（存在 `mesh.userData` 上） */
interface EdgeUserData {
  edges?: THREE.Mesh | null;
  edgeHull?: THREE.Mesh | null;
  nativeEdges?: boolean;
  nativeEdgesRaw?: boolean;
  isThickEdge?: boolean;
  isEdgeHull?: boolean;
  skeletonName?: string;
  [key: string]: unknown;
}

/** 宿主需要提供的东西。只列真正用到的，避免模块偷偷依赖整只 viewer */
export interface EdgeHost {
  readonly uniforms: StyleUniforms;
  /** 当前**显示**的样式（动画推进中会逐帧变） */
  readonly style: {
    edges: EdgesOption;
    forceCpuEdges?: boolean;
    edgeColor: string;
    edgeWidth?: number;
    edgeOpacity?: number;
    edgeOffset?: number;
    edgeHullWidth?: number;
    edgeThreshold?: number;
    opacity?: number;
  };
  /** 用户想要的样式（`setEdges` 要同步写回，`getStyle()` 才拿得到） */
  readonly styleTarget: { edges: EdgesOption };
  readonly animator: Animator;
  readonly pickables: Map<number, { mesh: THREE.Mesh }>;
  scene: THREE.Scene | null;
  renderer: THREE.WebGLRenderer | null;
  camera: THREE.Camera | null;
  readonly authenticate: AuthenticateFn | undefined;
  requestRepaint(): void;
}

export class EdgeDecorator {
  /** 等宽线共享的分辨率 uniform（全局棱线 + 选中棱线共用） */
  readonly lineShared: LineSharedUniforms;
  /** 全局棱线材质（外观 uniform 的持有者，逐网格棱线材质共享它的对象） */
  readonly edgeMaterial: ThickLineMaterial;
  /** 选中棱线材质（同上，选中棱线的逐网格材质共享它的对象） */
  readonly selectionEdgeMaterial: ThickLineMaterial;

  private readonly _edgeStyleUniforms: ThickLineStyleUniforms;
  private readonly _selEdgeStyleUniforms: ThickLineStyleUniforms;
  private readonly _hullStyleUniforms: OutlineStyleUniforms;

  private _enabled = false;
  private _modes: EdgeModes;
  /** 预制棱线缓存（Crease Cache）：外部载入的全局统一 LineSegments */
  private _creaseLines: THREE.LineSegments | null = null;
  /** 数据自带的棱线对象：改颜色时只刷这些，不再全场景 traverse */
  private readonly _nativeLines = new Set<THREE.LineSegments>();
  /** GPU 描边后处理（深度 + 法线），只在 edges 含 'gpu' 时按帧执行 */
  private _gpuEdge: GpuEdgePass | null = null;
  /** 给 GPU 描边传色用的临时 Color，避免每帧 new */
  private readonly _gpuEdgeColor = new THREE.Color();

  constructor(private readonly host: EdgeHost) {
    const style = host.style;
    this._modes = resolveEdgeModes(false);
    this.lineShared = createLineSharedUniforms();
    this._edgeStyleUniforms = {
      uColor: { value: new THREE.Color(style.edgeColor) },
      uWidth: { value: Math.max(0.1, style.edgeWidth ?? 1.5) },
      uOpacity: { value: 0.6 },
      uOffset: { value: style.edgeOffset ?? 0.15 },
    };
    this.edgeMaterial = createThickLineMaterial(this.lineShared, {}, this._edgeStyleUniforms);
    const full = style as unknown as {
      outlineColor?: string;
      selectColor?: string;
      outlineWidthPx?: number;
      selectElevation?: number;
    };
    this._selEdgeStyleUniforms = {
      uColor: { value: new THREE.Color(full.outlineColor ?? full.selectColor ?? '#ffffff') },
      uWidth: { value: Math.max(0.1, full.outlineWidthPx ?? 3) },
      uOpacity: { value: 1 },
      uElevation: { value: full.selectElevation ?? 0 },
    };
    this.selectionEdgeMaterial = createThickLineMaterial(this.lineShared, {}, this._selEdgeStyleUniforms);
    this._hullStyleUniforms = {
      uColor: { value: new THREE.Color(style.edgeColor) },
      uWidth: { value: Math.max(0, style.edgeHullWidth ?? 0.9) },
      uOpacity: { value: 0.6 },
    };
  }

  /** 当前是否开启棱线 */
  get enabled(): boolean {
    return this._enabled;
  }

  /** 当前生效的画法 */
  get modes(): EdgeModes {
    return this._modes;
  }

  /** 数据自带棱线包在当前画法下还算不算数 */
  useNativeEdges(hasNative: boolean): boolean {
    return hasNative && this.host.style.forceCpuEdges !== true && !this._modes.gpu;
  }

  /** 登记数据自带的棱线（注册瓦片时调） */
  registerNativeLine(lines: THREE.LineSegments, visible: boolean): void {
    this._nativeLines.add(lines);
    lines.visible = visible;
    this._styleEdgeLine(lines);
  }

  /** 注销数据自带的棱线（瓦片淘汰时调） */
  unregisterNativeLine(lines: THREE.LineSegments): void {
    this._nativeLines.delete(lines);
  }

  /** 新瓦片是否要自动补棱线装饰（受全局开关 / 数据集开关 / 关键字跳过三道控制） */
  autoDecorate(mesh: THREE.Mesh, entry: S3MDatasetEntry, hasNativeEdges: boolean): void {
    if (hasNativeEdges || isPointCloud(mesh)) return;
    if (!this._datasetEdgesEnabled(entry)) return;
    const ud = mesh.userData as EdgeUserData;
    if (this._shouldSkipAutoEdges(ud, entry.name)) return;
    // 数据集强制开启时全局画法可能还是关的，退回默认折边线；gpu 画法本来就不建几何
    if (this._modes.line || this._modes.hull) this._ensureEdgeDecoration(mesh);
    else if (!this._modes.gpu) this._ensureEdges(mesh);
  }

  /** 释放全部装饰与后处理资源（unmount 时调） */
  disposeAll(): void {
    for (const p of this.host.pickables.values()) this._removeEdges(p.mesh);
    this._gpuEdge?.dispose();
    this._gpuEdge = null;
    this.edgeMaterial.dispose();
    this.selectionEdgeMaterial.dispose();
  }

  /** @internal GPU 描边实例，单测会替换成假对象观察 dispose */
  get gpuEdge(): GpuEdgePass | null {
    return this._gpuEdge;
  }
  set gpuEdge(v: GpuEdgePass | null) {
    this._gpuEdge = v;
  }

  /** GPU 描边资源单独释放（换上下文时调，下一帧按需重建） */
  disposeGpuEdge(): void {
    this._gpuEdge?.dispose();
    this._gpuEdge = null;
  }

  /** 一帧的 GPU 描边，必须画在主场景之后（依赖本帧已写好的深度） */
  renderGpuEdges(canvas: HTMLCanvasElement): void {
    if (!this._modes.gpu) return;
    const renderer = this.host.renderer;
    const scene = this.host.scene;
    const camera = this.host.camera;
    if (!renderer || !scene || !camera) return;
    const s = this.host.style;
    const fade = this.host.uniforms.uEdgeFade?.value ?? 1;
    const opacity = Math.min(1, Math.max(0, s.edgeOpacity ?? 0.6)) * clampOpacity(s.opacity) * fade;
    if (opacity <= 0.004) return;

    if (!this._gpuEdge) this._gpuEdge = new GpuEdgePass();
    if (!this._gpuEdge.supported(renderer)) return;

    // 度数 → 归一化法线差（|Δn| = 2·sin(θ/2)），乘 0.6 让阈值落在「刚好能描出」的位置
    const deg = Math.min(179, Math.max(1, s.edgeThreshold ?? 55));
    const normalThreshold = 2 * Math.sin((deg * Math.PI) / 360) * 0.6;

    this._gpuEdge.render(renderer, scene, camera, canvas.width, canvas.height, {
      color: this._gpuEdgeColor.set(s.edgeColor),
      opacity,
      radius: Math.max(1, s.edgeWidth ?? 1.5),
      normalThreshold,
      depthThreshold: 0.08,
    });
  }

  /** 建逐网格棱线材质；`selection` 为真时用选中棱线那套外观 uniform */
  createPerMeshEdgeMaterial(mesh: THREE.Mesh, selection = false): ThickLineMaterial {
    const styled = styledMaterialOf(mesh);
    const u = this.host.uniforms;
    const batch = styled?.userData?.uBatchTex
      ? {
          uBatchTex: styled.userData.uBatchTex,
          uBatchTex2: styled.userData.uBatchTex2,
          uBatchMix: u.uBatchMix,
          uBatchTexWidth: styled.userData.uBatchTexWidth,
          uBatchTexActive: styled.userData.uBatchTexActive,
          uPathTex: u.uPathTex,
          uPathCount: u.uPathCount,
          uPathTexActive: u.uPathTexActive,
          uPathTime: u.uPathTime,
        }
      : undefined;
    return createThickLineMaterial(
      this.lineShared,
      {},
      selection ? this._selEdgeStyleUniforms : this._edgeStyleUniforms,
      batch
    );
  }
  /**
   * 全局棱线开关。
   *
   * 取值是 `boolean | EdgeStyle | EdgeStyle[]`（见 resolveEdgeModes）：
   *   - `true` / `'line'`   折边线（旧口径）
   *   - `'offset'`          折边线 + 沿边法线外推 `edgeOffset` 米
   *   - `'hull'`            背面外扩轮廓（选中侧 outlineStyle:'hull' 的整场景版）
   *   - `'gpu'`             纯片元描边：零几何、零额外 pass，线宽约 1 像素
   *   - 数组                叠加，例如 `['line', 'hull']`
   *
   * 数据自带棱线包（primitiveType 13）时直接用，成本为零；`style.forceCpuEdges`
   * 可以无视它，改由 CPU 现算 —— 那是 CPU 端的活，几十万面一次性建会卡住主线程
   * （实测 20 个网格 1.9s），所以按 8ms 一帧切片，边建边出。
   *
   * 棱线本身用「屏幕空间等宽线」画（见 EdgeLines.ts）：WebGL 的 lineWidth 基本无效，
   * 只有摊成面向屏幕的四边形，`edgeWidth` 才能真正调粗。
   *
   * 带 `transition` 时做「淡入 / 淡出」，**不对几何做插值**（几何没法插值）：
   * 开：立刻置位 + 开始分片建线，同时 `uEdgeFade` 0→1 —— 建好一块亮一块，视觉上是渐显；
   * 关：`uEdgeFade` 1→0，淡完才 dispose，避免棱线「啪」一下消失。
   */
  setEdges(edges: EdgesOption, transition?: TransitionOptions): void {
    const wantAnim = !!transition && ((transition.duration ?? 0) > 0 || !!transition.spring);
    const modes = resolveEdgeModes(edges);
    // 换画法（line ↔ hull ↔ offset）是结构变更：旧装饰必须拆掉再建，
    // 否则会出现「切到 hull 了折边线还留着」这种叠影。
    // 同一画法重复调用（滑块逐帧 setEdges(true)）不重建，几何是复用的。
    const modesChanged = !sameEdgeModes(this._modes, modes);

    this._modes = modes;
    this._enabled = modes.enabled;
    this.host.style.edges = edges;
    this.host.styleTarget.edges = edges;

    // 数据自带的棱线：直接切可见性（forceCpuEdges 时永远收起，改由 CPU 现算）。
    // 只遍历注册时收集好的那批 LineSegments —— 全数据集 traverse 在几千节点下太贵。
    // gpu 模式下 shader 自己描边，native 线段包必须收起，否则叠成双线
    const nativeVisible = modes.enabled && !modes.gpu && this.host.style.forceCpuEdges !== true;
    for (const lines of this._nativeLines) {
      lines.visible = nativeVisible;
      this._styleEdgeLine(lines);
    }
    this._syncEdgeStyle();

    // 关掉 gpu 画法就把后处理资源还回去（整屏 RT 白占显存没意义）。
    // 必须放在「整体关闭」的早退之前，否则关棱线时永远轮不到它。
    if (!modes.gpu && this._gpuEdge) {
      this._gpuEdge.dispose();
      this._gpuEdge = null;
    }

    if (!modes.enabled) {
      if (wantAnim) {
        this.host.animator.to('style.edgeFade', 0, {
          ...transition,
          onComplete: () => {
            this._disposeEdges();
            this.host.requestRepaint();
            transition?.onComplete?.();
          },
        });
      } else {
        this._setEdgeFade(1);
        this._disposeEdges();
      }
      this.host.requestRepaint();
      return;
    }

    if (modesChanged) this._disposeEdges();

    const pending = [...this.host.pickables.values()]
      .map((p) => p.mesh)
      .filter((m) => {
        const ud = m.userData as EdgeUserData;
        // 点云没有棱可描
        if (isPointCloud(m)) return false;
        // native 棱线还算不算数，取决于**当前**的 forceCpuEdges（它可以在运行中切换），
        // 所以这里按注册时记下的原始标记重算，而不是沿用注册那一刻的结论。
        ud.nativeEdges = ud.nativeEdgesRaw === true && this.host.style.forceCpuEdges !== true;
        return !ud.nativeEdges && this._needsEdgeDecoration(ud);
      });
    let i = 0;
    const step = (): void => {
      const t0 = performance.now();
      while (i < pending.length && performance.now() - t0 < 8) this._ensureEdgeDecoration(pending[i++]);
      if (i < pending.length) setTimeout(step, 0);
      else this.host.requestRepaint();
    };
    step();

    if (wantAnim) {
      // 从 0 起淡入：新建出来的棱线自动继承当前进度，不会半路冒出一条满亮度的线
      this._setEdgeFade(0);
      this.host.animator.to('style.edgeFade', 1, transition);
    } else {
      this._setEdgeFade(1);
    }
  }

  /** 直接写棱线淡入乘子（不走动画通道） */
  private _setEdgeFade(v: number): void {
    if (this.host.uniforms.uEdgeFade) this.host.uniforms.uEdgeFade.value = v;
    this._syncEdgeStyle();
  }

  /** 释放所有现算棱线几何 */
  private _disposeEdges(): void {
    for (const p of this.host.pickables.values()) this._removeEdges(p.mesh);
  }

  /**
   * 挂载预制棱线缓存（Crease Cache）。
   *
   * 直接把 `source-creases.f32` 这类 Float32Array 缓冲载入为一组全局统一的
   * LineSegments —— 相比逐 Mesh 现算 EdgesGeometry，性能高一个量级，视觉也最干净。
   * 坐标按「场景本地坐标」（相对场景锚点的米）处理，与瓦片几何同一坐标系。
   *
   * @param url  棱线缓存地址（二进制 Float32 序列：x,y,z,x,y,z,… 成对成段）
   */
  async loadCreases(url: string): Promise<void> {
    const resp = await authFetch(url, this.host.authenticate, 'creases');
    if (!resp.ok) throw new Error(`[s3m] 棱线缓存加载失败: ${resp.status} ${url}`);
    const buf = await resp.arrayBuffer();
    const arr = new Float32Array(buf);
    if (arr.length < 6) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const s = this.host.style;
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(s.edgeColor),
      transparent: true,
      opacity: Math.min(1, Math.max(0, s.edgeOpacity ?? 0.6)) * clampOpacity(s.opacity),
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 2;
    lines.frustumCulled = false;
    lines.raycast = () => {};

    this.clearCreases();
    this._creaseLines = lines;
    this.host.scene?.add(lines);
    this.host.requestRepaint();
  }

  /** 移除并释放预制棱线缓存 */
  clearCreases(): void {
    if (!this._creaseLines) return;
    this.host.scene?.remove(this._creaseLines);
    this._creaseLines.geometry.dispose();
    (this._creaseLines.material as THREE.Material)?.dispose?.();
    this._creaseLines = null;
    this.host.requestRepaint();
  }

  /**
   * 让全局棱线材质跟上 style.edgeColor / edgeWidth / edgeOpacity / edgeOffset。
   *
   * 全程 O(1)：只有一份共享 edgeMaterial（所有逐 mesh 棱线都用它）+ 一份预制缓存
   * + 一批共享外观对象的轮廓壳，所以棱线淡入淡出只要改一个 uniform，
   * 新建瓦片自动继承当前进度。
   */
  private _syncEdgeStyle(): void {
    const s = this.host.style;
    const fade = this.host.uniforms.uEdgeFade?.value ?? 1;
    const opacity =
      Math.min(1, Math.max(0, s.edgeOpacity ?? 0.6)) *
      clampOpacity(s.opacity) *
      fade;
    const u = this.edgeMaterial.uniforms;
    u.uColor.value.set(s.edgeColor);
    u.uWidth.value = Math.max(0.1, s.edgeWidth ?? 1.5);
    u.uOpacity.value = opacity;
    // 外推距离只在 offset 画法下非 0；其它画法把线钉在面上（与改动前一致）
    u.uOffset.value = this._modes.offset ? Math.max(0, s.edgeOffset ?? 0.15) : 0;
    // 外扩轮廓壳与折边线共用颜色 / 透明度，厚度是米制的单独一项
    const h = this._hullStyleUniforms;
    h.uColor.value.set(s.edgeColor);
    h.uWidth.value = Math.max(0, s.edgeHullWidth ?? 0.9);
    h.uOpacity.value = opacity;
    // GPU 描边（edges: 'gpu'）是后处理，参数每帧从 style 现取，这里不用同步 uniform
    // 预制棱线缓存（LineBasicMaterial）同步颜色 / 不透明度
    if (this._creaseLines) {
      const m = this._creaseLines.material as THREE.LineBasicMaterial;
      m.color.set(s.edgeColor);
      m.opacity = opacity;
    }
  }

  /** 让数据自带的棱线跟着 style.edgeColor / opacity 走（这些是 LineBasicMaterial，改不了粗细） */
  private _styleEdgeLine(lines: THREE.LineSegments): void {
    const mat = lines.material as THREE.LineBasicMaterial;
    if (!mat || !mat.color) return;
    mat.color.set(this.host.style.edgeColor);
    const baseOpacity = this.host.style.edgeOpacity ?? 0.6;
    mat.opacity =
      baseOpacity *
      clampOpacity(this.host.style.opacity) *
      (this.host.uniforms.uEdgeFade?.value ?? 1);
    mat.transparent = true;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    mat.needsUpdate = true;
  }

  /**
   * 刷新所有棱线外观。
   *
   * 数据自带的棱线是逐对象的 LineBasicMaterial，改颜色只能一个个写；但原来每次都要
   * 遍历整个数据集树（几千个节点），颜色动画逐帧跑就是灾难。改成只刷注册时收集好的
   * 那批 LineSegments，复杂度降到 O(棱线条数)。
   */
  private _refreshEdgeLines(): void {
    this._syncEdgeStyle();
    for (const lines of this._nativeLines) {
      if (lines.parent) this._styleEdgeLine(lines);
    }
  }

  /** 地形 / 绿地 / 道路 / 地面铺装等不参与自动描边（数据自带棱线包另说） */
  /** 数据集级别的棱线开关：enableEdges 优先，否则跟随全局 style.edges */
  private _datasetEdgesEnabled(entry: S3MDatasetEntry): boolean {
    const opt = entry.options?.enableEdges;
    if (opt === true) return true;
    if (opt === false) return false;
    return this._enabled;
  }

  /** 该 mesh 是否命中「跳过自动描边」的关键字（skeletonName / 数据集名） */
  private _shouldSkipAutoEdges(ud: EdgeUserData, datasetName: string): boolean {
    const hay = `${ud.skeletonName ?? ''} ${datasetName}`.toLowerCase();
    return EDGE_SKIP_KEYWORDS.some((k) => hay.includes(k));
  }

  /**
   * 这块网格还缺哪种棱线装饰（缺就建，齐了就不动）。
   *
   * setEdges 的分片建线靠它筛「还没建完的」，注册新瓦片也靠它决定要不要动手。
   */
  private _needsEdgeDecoration(ud: EdgeUserData): boolean {
    if (this._modes.line && !ud.edges) return true;
    if (this._modes.hull && !ud.edgeHull) return true;
    return false;
  }

  /** 按当前画法补齐这块网格的棱线装饰 */
  private _ensureEdgeDecoration(mesh: THREE.Mesh): void {
    if (this._modes.line) this._ensureEdges(mesh);
    if (this._modes.hull) this._ensureHull(mesh);
  }

  private _ensureEdges(mesh: THREE.Mesh): void {
    const ud = mesh.userData as EdgeUserData;
    if (ud.edges || ud.nativeEdges || !mesh.geometry) return;
    // 地形 / 绿地 / 道路等不参与自动描边（即使全局开棱线也要跳过）
    if (this._shouldSkipAutoEdges(ud, '')) return;

    const posAttr = mesh.geometry.getAttribute('position');
    const indexCount = mesh.geometry.index?.count ?? (posAttr ? posAttr.count : 0);
    // 棱线是 CPU 端建的，超大几何直接跳过，避免拖慢加载
    if (indexCount > 120000) return;

    // 1. 先做顶点容差焊合，让相邻三角形正确共享边索引。
    //    S3M 几何常为「每面独立顶点」，不焊合的话 EdgesGeometry 会把每条三角形边都当成边界，棱线爆炸。
    //    注意用本地实现而不是 three/examples/jsm —— jsm 子路径导入会在宿主里
    //    制造第二份 three 实例（"Multiple instances of Three.js" 警告的元凶）。
    //    tolerance 取米级模型下的 5mm，足以合并重合顶点又不会误并真实相邻面。
    const welded = mergeVerticesByPosition(mesh.geometry, 0.005);
    // 2. 调大临界角（默认 55°，可在 style.edgeThreshold 调），过滤浅坡与曲面细分，只保留真正的棱。
    const thresholdAngle = this.host.style.edgeThreshold ?? 55;

    // 'offset' 画法要额外带一条「边法线」才知道往哪推，所以走本地实现（它本来就算好了
    // 相邻两面法线）；其余画法保持 EdgesGeometry 这条老路，几何输出与改动前逐字一致。
    let segments: Float32Array | null;
    let normals: Float32Array | undefined;
    if (this._modes.offset) {
      const raw: number[] = [];
      segments = buildFeatureEdgeSegments(welded, null, thresholdAngle, raw);
      if (raw.length > 0) normals = new Float32Array(raw);
    } else {
      const source = new THREE.EdgesGeometry(welded, thresholdAngle);
      const attr = source.getAttribute('position') as THREE.BufferAttribute | undefined;
      segments = attr ? (attr.array as Float32Array) : null;
      source.dispose();
    }
    welded.dispose();
    if (!segments || segments.length < 6) return;

    // 3. 回填每段棱线所属的单体 batchId。
    //    EdgesGeometry 只输出坐标不输出顶点号，只能拿端点坐标去查「位置 → batchId」表。
    //    没有这张表，单体一动棱线就留在原地——这正是「棱线跟随」的关键一环。
    const TOL = 0.005;
    const batchMap = buildPositionBatchMap(mesh.geometry, TOL);
    let batchIds: Float32Array | undefined;
    if (batchMap) {
      const segCount = segments.length / 6;
      batchIds = new Float32Array(segCount);
      for (let i = 0; i < segCount; i++) {
        const s = i * 6;
        batchIds[i] =
          batchMap.get(positionQuantKey(segments[s], segments[s + 1], segments[s + 2], 1 / TOL)) ?? -1;
      }
    }

    const lines = new THREE.Mesh(
      buildThickLineGeometry(segments, batchIds, normals),
      this.createPerMeshEdgeMaterial(mesh)
    );
    lines.renderOrder = 2;
    // 屏幕空间外扩后可能超出原包围球，关掉剔除更稳
    lines.frustumCulled = false;
    lines.raycast = () => {};
    (lines.userData as EdgeUserData).isThickEdge = true;
    ud.edges = lines;
    mesh.add(lines); // 作为子节点，自动继承 mesh 的世界变换
  }

  /**
   * 给一块网格挂「背面外扩轮廓」（整场景版）。
   *
   * 复用选中侧那套 `createOutlineMaterial`：顶点沿法线鼓 `edgeHullWidth` 米、只画背面，
   * 于是被本体挡住的部分不显示，露出来的那圈就是描边。与折边线的差别在于——
   * 这里**不建任何新几何**，成本只是把同一块网格多画一遍，折边判定那套 CPU 活全省了。
   *
   * 实例化几何拿不到逐实例变换（轮廓壳是 mesh 的子节点，不吃 instanceMatrix），
   * 直接跳过：宁可这栋没描边，也不要所有实例的壳叠在原点。
   */
  private _ensureHull(mesh: THREE.Mesh): void {
    const ud = mesh.userData as EdgeUserData;
    if (ud.edgeHull || !mesh.geometry) return;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    // 地形 / 绿地 / 道路等不参与自动描边（即使全局开棱线也要跳过）
    if (this._shouldSkipAutoEdges(ud, '')) return;

    // 逐网格一份材质（各绑各的单体状态纹理），外观 uniform 复用共享对象
    const mat = createOutlineMaterial(
      this.host.uniforms,
      this.host.style.edgeHullWidth ?? 0.9,
      this._hullStyleUniforms,
      true
    );
    // 整块几何都要外扩：选中侧靠 uSelBatch 只扩一栋，全局必须置 whole
    mat.uniforms.uSelWhole.value = 1;
    mat.uniforms.uSelBatch.value = -1;
    const styled = styledMaterialOf(mesh);
    if (styled?.userData?.uBatchTex) {
      mat.uniforms.uBatchTex.value = styled.userData.uBatchTex.value as THREE.Texture;
      mat.uniforms.uBatchTexWidth.value = styled.userData.uBatchTexWidth.value as number;
      mat.uniforms.uBatchTexActive.value = styled.userData.uBatchTexActive.value as number;
    }

    const hull = new THREE.Mesh(mesh.geometry, mat);
    hull.renderOrder = 2;
    hull.frustumCulled = false;
    hull.raycast = () => {};
    (hull.userData as EdgeUserData).isEdgeHull = true;
    ud.edgeHull = hull;
    mesh.add(hull); // 作为子节点，自动继承 mesh 的世界变换
  }

  /**
   * 给一块网格造专属的棱线材质。
   *
   * 棱线材质必须逐网格一份，因为它要绑定**这个网格**的单体状态纹理；但外观
   * （颜色 / 粗细 / 透明度）必须全局统一——所以外观 uniform 直接复用
   * `_edgeStyleUniforms` 里的对象，`_syncEdgeStyle()` 改一次全部生效，
   * program 也因为着色器相同而只编译一次。
   */
  /** 选中棱线的逐网格材质，道理同上 */
  private _createSelectionEdgeMaterial(mesh: THREE.Mesh): ThickLineMaterial {
    const styled = styledMaterialOf(mesh);
    const batch = styled?.userData?.uBatchTex
      ? {
          uBatchTex: styled.userData.uBatchTex,
          uBatchTex2: styled.userData.uBatchTex2,
          uBatchMix: this.host.uniforms.uBatchMix,
          uBatchTexWidth: styled.userData.uBatchTexWidth,
          uBatchTexActive: styled.userData.uBatchTexActive,
          uPathTex: this.host.uniforms.uPathTex,
          uPathCount: this.host.uniforms.uPathCount,
          uPathTexActive: this.host.uniforms.uPathTexActive,
          uPathTime: this.host.uniforms.uPathTime,
        }
      : undefined;
    return createThickLineMaterial(this.lineShared, {}, this._selEdgeStyleUniforms, batch);
  }

  private _removeEdges(mesh: THREE.Mesh): void {
    const ud = mesh.userData as EdgeUserData;

    const lines = ud.edges;
    if (lines) {
      mesh.remove(lines);
      (lines as THREE.Mesh).geometry?.dispose();
      // 棱线材质现在是逐网格一份（要绑各自的 batch 纹理），得跟着释放
      const mat = (lines as THREE.Mesh).material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => (m as any)?.dispose?.());
      } else {
        (mat as any)?.dispose?.();
      }
      ud.edges = null;
    }

    // 外扩壳的 geometry 是**复用主网格的**，只能释放材质，不能 dispose 几何
    const hull = ud.edgeHull;
    if (hull) {
      mesh.remove(hull);
      const hmat = hull.material;
      if (Array.isArray(hmat)) hmat.forEach((m) => (m as any)?.dispose?.());
      else (hmat as any)?.dispose?.();
      ud.edgeHull = null;
    }
  }

  /** 让全局棱线材质跟上当前 style（颜色 / 粗细 / 透明度 / 外推距离），O(1) */
  syncStyle(): void {
    this._syncEdgeStyle();
  }

  /** 刷新所有棱线外观：共享材质 + 数据自带的那批 LineSegments */
  refreshLines(): void {
    this._refreshEdgeLines();
  }

  /** 释放所有现算棱线几何（临界角 / 画法变了要重建，见 setEdges） */
  disposeEdgeGeometry(): void {
    this._disposeEdges();
  }

  /** @internal 给一块网格补折边线（单测直接调，观察顶点焊合 / 临界角） */
  ensureEdges(mesh: THREE.Mesh): void {
    this._ensureEdges(mesh);
  }

  /** 拆掉一块网格的棱线与外扩壳（瓦片淘汰时调） */
  removeEdges(mesh: THREE.Mesh): void {
    this._removeEdges(mesh);
  }

  /** 选中棱线的逐网格材质 */
  createSelectionEdgeMaterial(mesh: THREE.Mesh): ThickLineMaterial {
    return this._createSelectionEdgeMaterial(mesh);
  }
}

function isPointCloud(o: THREE.Object3D): boolean {
  return (o as THREE.Points).isPoints === true;
}
