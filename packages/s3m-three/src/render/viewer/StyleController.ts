/**
 * 图层视觉状态：样式补间、uniform 下发、不透明度、点云着色、材质档位重建。
 *
 * 从 `S3MViewer.ts` 搬出来（issue #27 第二轮 P12 阶段），行为逐字未变。
 *
 * 这里有两个容易搞混的样式对象，必须分清：
 *   - `style`        ——「当前显示的」，动画每帧直接改它；
 *   - `styleTarget`  ——「用户想要的」，`setStyle` 写的是它，动画朝它收敛。
 * 两者都是**普通对象引用**，由宿主持有（`style` 还是公共字段，`viewer-api-surface`
 * 钉住了它在实例自有属性上）。本模块只改它们的内容，不替换引用 ——
 * 返回拷贝会让动画失效，而且很难查。
 *
 * 另一条：所有影响 uniform 的写入都走共享 uniform 对象（`uOpacity` / `uFlatShading` …），
 * 不写 `material.opacity` / `material.flatShading` —— 后者会触发 program 重编译，
 * 让「切透明度」变成「全场卡一下」。
 */
import * as THREE from 'three';
import type { Animator, TransitionOptions } from '../../anim/Animator.js';
import type { Stats, StyleUniforms } from '../../core/types.js';
import type { FeatureStyleManager } from '../FeatureStyleManager.js';
import type { GroundManager } from '../GroundManager.js';
import type { DatasetManager } from '../DatasetManager.js';
import type { PickService } from './PickService.js';
import type { SelectionDecorator } from './SelectionDecorator.js';
import type { EdgeDecorator } from './EdgeDecorator.js';
import {
  SELECT_MODE,
  STYLE,
  STYLE_LABELS,
  createStyledMaterial,
  getColorPipeline,
  normalizeColorPipeline,
  normalizeMaterialQuality,
  restoreBaseBlendState,
} from '../StyleMaterial.js';
import { applyAnisotropyCap, setMaxAnisotropy } from '../TextureFactory.js';
import { applyPointCloudStyle } from '../PointCloudMaterial.js';
import type { ThickLineMaterial } from '../EdgeLines.js';
import type {
  ColorPipeline,
  EdgeModes,
  EdgesOption,
  MaterialQuality,
  OutlineMaterial,
  S3MStyle,
  StyledMaterial,
  StyledMaterialOptions,
  StyleMode,
} from '../StyleMaterial.js';
import type { TextureCreateOptions } from '../TextureFactory.js';
import type { S3MViewerOptions } from './types.js';
import { clampOpacity, isPointCloudObject, styledMaterialOf } from './materialHelpers.js';

/** `StyleController` 需要的宿主入口 */
export interface StyleHost {
  readonly animator: Animator;
  readonly uniforms: StyleUniforms;
  /** 当前显示的样式（动画改它，公共字段不能被替换） */
  readonly style: S3MStyle;
  /** 用户想要的样式（`setStyle` 写它，动画朝它收敛） */
  readonly styleTarget: S3MStyle;
  readonly outlineMaterial: OutlineMaterial;
  readonly edgeMaterial: ThickLineMaterial;
  readonly groundManager: GroundManager;
  readonly datasetManager: DatasetManager;
  readonly featureStyles: FeatureStyleManager;
  readonly picks: PickService;
  readonly sel: SelectionDecorator;
  readonly edges: EdgeDecorator;
  /** 泼溅 / 点云网格集合 */
  readonly pointClouds: Set<THREE.Points>;
  /** 已加载数据集（重建材质时逐个下发渲染 profile） */
  readonly datasets: Map<string, import('../DatasetManager.js').S3MDatasetEntry>;
  /** 图层 options（各向异性上限 / 纹理尺寸上限从这里读） */
  readonly options: S3MViewerOptions;
  camera(): THREE.Camera | null;
  renderer(): THREE.WebGLRenderer | null;
  scene(): THREE.Scene | null;
  /** 图层是否处于「整体半透明」 */
  opacityTransparent(): boolean;
  setOpacityTransparent(v: boolean): void;
  /** 管线代号自增：材质重建后旧缓存要失效 */
  nextPipelineGen(): number;
  /** 阴影预热状态（切档位后要重新预热一次） */
  shadingPrewarmed(): boolean;
  setShadingPrewarmed(v: boolean): void;
  prewarming(): boolean;
  setPrewarming(v: boolean): void;
  /** 当前颜色管线 / 材质档位（字段留在宿主，因为公共 getter 与渲染帧也要读） */
  colorPipeline(): ColorPipeline;
  setColorPipeline(v: ColorPipeline): void;
  materialQuality(): MaterialQuality;
  /** 切棱线画法（`setStyle` 里 edges 变化时同步） */
  setEdges(edges: EdgesOption, transition?: TransitionOptions): void;
  select(result: import('./types.js').PickResult | null, opts?: { silent?: boolean }): void;
  /** 重绘信号：走宿主的公共 triggerRepaint */
  requestRepaint(): void;
}

/**
 * 能逐帧插值的标量样式键。
 *
 * 判据：写一次只是「改一个 uniform 或一个字段」，不重建几何、不换 program。
 * `mode` / `shading` / `edges` 不在此列——它们是结构变更，只能编排不能插值。
 */
const STYLE_SCALAR_KEYS = [
  'opacity',
  'floorHeight',
  'selectOpacity',
  'selectEmissive',
  'selectElevation',
  'dimFactor',
  'texMix',
  'roofThreshold',
  'ambientGain',
  'metalness',
  'roughness',
  'edgeWidth',
  'edgeOpacity',
  'edgeOffset',
  'edgeHullWidth',
  'outlineWidth',
] as const;

/**
 * 标量样式键在「用户还没设过」时的动画起点。
 *
 * 只对 `metalness` / `roughness` 有意义：它们的 uniform 默认是 -1（不覆盖，保持数据
 * 自身的值），从 -1 插值没意义 —— 取数据侧常见值当起点，过渡才不会先跳到 0。
 * 其余键缺省仍是 0（与旧行为一致）。
 */
const SCALAR_ANIM_START: Partial<Record<(typeof STYLE_SCALAR_KEYS)[number], number>> = {
  metalness: 0, // S3M 数据的 metalness 恒为 0
  roughness: 0.95, // shininess 映射后的常见值，见 GeometryBuilder 的 roughness
};

/** 能逐帧插值的颜色键（在线性空间插值，与 shader 消费端一致） */
const STYLE_COLOR_KEYS = ['colorA', 'colorB', 'colorC', 'selectColor', 'edgeColor'] as const;

export class StyleController {
  /** uniform 取色的复用缓冲（每帧多次取色，避免分配） */
  private readonly _colorScratch = new THREE.Color();

  constructor(private readonly host: StyleHost) {}

  /** 动态设置图层整体透明度 (0.0 ~ 1.0) */
  setOpacity(opacity: number, transition?: TransitionOptions): void {
    this.setStyle({ opacity }, transition);
  }

  /**
   * 合并并应用样式。
   *
   * 只改 uniform 的项不会触发几何 / 着色器重建。带 `transition` 时，能插值的项
   * 交给动画调度器逐帧推进；不能插值的项（`mode` / `shading` / `edges`）走各自的
   * 编排逻辑（`edges` 由 setEdges 做淡入淡出，`mode` 建议配 fade-through）。
   */
  setStyle(patch: Partial<S3MStyle> = {}, transition?: TransitionOptions): void {
    Object.assign(this.host.styleTarget, patch);

    const duration = transition?.duration ?? 0;
    const wantAnim = duration > 0 || !!transition?.spring;

    // 棱线开关是结构变更，不是插值：交给 setEdges 编排
    let rest = patch;
    if ('edges' in patch) {
      const { edges, ...others } = patch;
      rest = others;
      this.host.setEdges(edges as EdgesOption, wantAnim ? transition : undefined);
      if (Object.keys(rest).length === 0) {
        this.host.requestRepaint();
        return;
      }
    }

    const animated: string[] = [];
    const immediate: Record<string, unknown> = {};
    for (const key of Object.keys(rest) as (keyof S3MStyle)[]) {
      if (wantAnim && this.host.animator.has(`style.${String(key)}`)) animated.push(String(key));
      else immediate[key] = rest[key];
    }

    if (Object.keys(immediate).length > 0) {
      Object.assign(this.host.style, immediate);
      this.applyStyleEffects(immediate as Partial<S3MStyle>);
    }

    for (const key of animated) {
      this.host.animator.to(`style.${key}`, this.animTargetOf(key, rest), {
        ...transition,
        duration,
      });
    }

    this.host.requestRepaint();
  }

  getStyle(): S3MStyle & { modeLabel: string } {
    return { ...this.host.styleTarget, modeLabel: STYLE_LABELS[this.host.styleTarget.mode] };
  }

  /** 把某个样式键的取值转成动画通道能吃的形状（标量 or 线性 RGB 三元组） */
  animTargetOf(key: string, patch: Partial<S3MStyle>): number | number[] {
    const value = (patch as Record<string, unknown>)[key];
    const dim = this.animDimOf(key);
    if (dim === 1) return Number(value);
    this._colorScratch.set(String(value));
    return [this._colorScratch.r, this._colorScratch.g, this._colorScratch.b];
  }

  /** 该样式键的动画维度：3 = 颜色，1 = 标量 */
  animDimOf(key: string): 1 | 3 {
    return STYLE_COLOR_KEYS.includes(key as (typeof STYLE_COLOR_KEYS)[number]) ? 3 : 1;
  }

  /**
   * 注册样式动画通道。
   *
   * 每个通道的 write 都是 O(1)：只改 `this.host.style` 的一个字段 + 一次 uniform 赋值。
   * 这里不注册 `mode` / `shading` / `edges`——它们不可插值，见类文档。
   */
  registerAnimChannels(): void {
    for (const key of STYLE_SCALAR_KEYS) {
      this.host.animator.register(`style.${key}`, {
        dim: 1,
        read: (out) => {
          // 金属度 / 粗糙度没设过时 uniform 是 -1（= 不覆盖，保持数据自身的值），
          // 动画起点不能取 0：那会让 roughness 从 0.95 先跳到 0 再爬回去。
          // 这里给的是数据侧的常见值（S3M 的 shininess 映射后 ≈0.95、metalness 恒 0），
          // 过渡起点因此是连续的。
          out[0] = Number(
            (this.host.style as unknown as Record<string, number>)[key] ?? SCALAR_ANIM_START[key] ?? 0
          );
        },
        write: (v) => {
          (this.host.style as unknown as Record<string, number>)[key] = v[0];
          this.onStyleChannelWrote(key);
        },
      });
    }

    for (const key of STYLE_COLOR_KEYS) {
      this.host.animator.register(`style.${key}`, {
        dim: 3,
        read: (out) => {
          const c = this.uniformColorOf(key);
          out[0] = c.r;
          out[1] = c.g;
          out[2] = c.b;
        },
        write: (v) => {
          const c = this.uniformColorOf(key);
          // 直接写线性分量：shader 消费的就是线性值，端点严格吻合
          c.setRGB(v[0], v[1], v[2]);
          (this.host.style as unknown as Record<string, string>)[key] = `#${c.getHexString()}`;
          this.onStyleChannelWrote(key);
        },
      });
    }

    // 棱线淡入淡出乘子：不属于 S3MStyle，单独一条通道
    this.host.animator.register('style.edgeFade', {
      dim: 1,
      read: (out) => {
        out[0] = this.host.uniforms.uEdgeFade?.value ?? 1;
      },
      write: (v) => {
        if (this.host.uniforms.uEdgeFade) this.host.uniforms.uEdgeFade.value = v[0];
        this.host.edges.syncStyle();
      },
    });

    // 整体压暗乘子：setMode 的 fade-through 用它，也不是 S3MStyle 字段
    this.host.animator.register('style.fade', {
      dim: 1,
      read: (out) => {
        out[0] = this.host.uniforms.uFade?.value ?? 1;
      },
      write: (v) => {
        if (this.host.uniforms.uFade) this.host.uniforms.uFade.value = v[0];
        this.host.requestRepaint();
      },
    });
  }

  /** 通道写完一个样式键后的最小副作用（全部 O(1)） */
  onStyleChannelWrote(key: string): void {
    if (key === 'opacity') {
      this.applyOpacity();
      return;
    }
    this.applyStyleUniforms();
    if (
      key === 'edgeColor' ||
      key === 'edgeWidth' ||
      key === 'edgeOpacity' ||
      key === 'edgeOffset' ||
      key === 'edgeHullWidth'
    ) {
      this.host.edges.refreshLines();
    }
  }

  /** 取某个颜色键对应的共享 uniform Color 对象 */
  uniformColorOf(key: string): THREE.Color {
    const u = this.host.uniforms;
    switch (key) {
      case 'colorA':
        return u.uColorA.value;
      case 'colorB':
        return u.uColorB.value;
      case 'colorC':
        return u.uColorC.value;
      case 'selectColor':
        return u.uSelColor.value;
      case 'edgeColor':
        return this.host.edgeMaterial.uniforms.uColor.value;
      default:
        return u.uColorA.value;
    }
  }

  /** 应用一批样式键带来的副作用（uniform / 材质 / 棱线 / 选中态） */
  applyStyleEffects(patch: Partial<S3MStyle>): void {
    this.applyStyleUniforms();
    if ('opacity' in patch || 'depthWrite' in patch) this.applyOpacity();
    // 点云不走 StyleMaterial 的 uMode，模式切换要单独同步它的材质
    if ('mode' in patch) this.applyPointCloudStyles();
    if ('shading' in patch) this.applyShading();
    // 临界角变了要重建 CPU 棱线（EdgesGeometry 的参数），开 / 关走 setEdges 整体刷新。
    // 必须先 _disposeEdges()：setEdges 只挑「还没有棱线」的网格来建，
    // 不先拆掉的话已经建好的会被全部跳过，临界角改了等于没改。
    if (('edgeThreshold' in patch || 'forceCpuEdges' in patch) && this.host.edges.enabled) {
      this.host.edges.disposeEdgeGeometry();
      this.host.setEdges(this.host.style.edges);
    } else if (
      'edgeColor' in patch ||
      'edgeWidth' in patch ||
      'opacity' in patch ||
      'edgeOpacity' in patch ||
      'edgeOffset' in patch ||
      'edgeHullWidth' in patch
    ) {
      // 颜色 / 粗细 / 外推距离 / 外扩厚度都只是 uniform，拖着滑块逐帧改也不重建几何
      this.host.edges.refreshLines();
    }
    if (this.host.sel.selection) {
      // 换描边画法要重建几何；颜色 / 粗细 / 拔高只是 uniform，拖着滑块也不卡
      if ('outline' in patch || 'outlineStyle' in patch) this.host.select(this.host.sel.selection, { silent: true });
      else this.host.sel.syncStyle();
    }
  }

  applyStyleUniforms(): void {
    const u = this.host.uniforms;
    const s = this.host.style;
    u.uMode.value = s.mode;
    u.uColorA.value.set(s.colorA);
    u.uColorB.value.set(s.colorB);
    u.uColorC.value.set(s.colorC);
    u.uSelColor.value.set(s.selectColor);
    u.uFloorHeight.value = s.floorHeight;

    const selMode = s.selectMode ?? SELECT_MODE.OVERLAY;
    if (u.uSelMode) {
      u.uSelMode.value =
        selMode === SELECT_MODE.REPLACE
          ? 0
          : selMode === SELECT_MODE.MULTIPLY
            ? 2
            : selMode === SELECT_MODE.GLOW_ONLY
              ? 3
              : 1;
    }
    if (u.uSelOpacity && s.selectOpacity != null) u.uSelOpacity.value = s.selectOpacity;
    if (u.uSelEmissive && s.selectEmissive != null) u.uSelEmissive.value = s.selectEmissive;
    if (u.uSelElevation && s.selectElevation != null) u.uSelElevation.value = s.selectElevation;
    if (u.uDimFactor && s.dimFactor != null) u.uDimFactor.value = s.dimFactor;

    if (u.uRoofThreshold && s.roofThreshold != null) {
      u.uRoofThreshold.value = s.roofThreshold;
    }
    if (u.uTexMix && s.texMix != null) {
      u.uTexMix.value = s.texMix;
    }
    if (u.uAmbientGain && s.ambientGain != null) {
      u.uAmbientGain.value = s.ambientGain;
    }
    // 金属度 / 粗糙度：负值 = 不覆盖，保持材质（数据）自身的值
    if (u.uMetalness) u.uMetalness.value = s.metalness ?? -1;
    if (u.uRoughness) u.uRoughness.value = s.roughness ?? -1;
    if (u.uOpacity && s.opacity != null) {
      u.uOpacity.value = clampOpacity(s.opacity);
    }
    if (this.host.outlineMaterial) {
      if (this.host.outlineMaterial.uniforms.uElevation && s.selectElevation != null) {
        this.host.outlineMaterial.uniforms.uElevation.value = s.selectElevation;
      }
      if (s.outlineWidth != null) this.host.outlineMaterial.uniforms.uWidth.value = s.outlineWidth;
      if (s.outlineColor != null) {
        this.host.outlineMaterial.uniforms.uColor.value.set(s.outlineColor);
      } else {
        this.host.outlineMaterial.uniforms.uColor.value.set(s.selectColor);
      }
    }
  }

  /**
   * 透明度：写共享 uniform，**不再逐 mesh 改材质**。
   *
   * 原来的写法每次都要遍历全部 pickables 改 `material.opacity` + `material.transparent`，
   * 是 O(meshes)；而且 `opaque` 参与 three 的 program 缓存键，跨 0.999 会换一次 program。
   * 拖滑块时一秒钟几十次调用，几十万面的场景就是明显掉帧。
   *
   * 现在逐帧只写一个 float（`uOpacity`），混合开关只在**真正跨过阈值**时切一次。
   */
  applyOpacity(): void {
    const o = clampOpacity(this.host.style.opacity);
    if (this.host.uniforms.uOpacity) this.host.uniforms.uOpacity.value = o;

    const transparent = o < 0.999;
    if (transparent !== this.host.opacityTransparent()) {
      this.host.setOpacityTransparent(transparent);
      // 关键：若 depthWrite 开启（默认开启），即使半透明也保持深度写入，完美遮挡背面棱线，防止背面线条透出
      const keepDepth = this.host.style.depthWrite !== false;
      for (const p of this.host.picks.pickables.values()) {
        if (isPointCloudObject(p.mesh)) continue;
        const m = styledMaterialOf(p.mesh);
        if (!m) continue;
        // 有单体淡化 / 正在淡入的材质，transparent 由各自的流程管，这里不要抢
        if (m.userData.uBatchTexActive?.value) continue;
        if ((m.userData.uTileFade?.value ?? 1) < 1) continue;
        // 材质自身可能是 blend / 顶点 alpha 透明（s3mOpts.transparent），
        // 关全局混合时不能把它一刀切成不透明
        restoreBaseBlendState(m, transparent, keepDepth);
      }
    }

    // 点云不走 StyleMaterial，自己有一套 uOpacity，逐帧刷的只有这几个对象
    for (const pc of this.host.pointClouds) this.applyPointCloudStyle(pc);

    this.host.edges.syncStyle();
    this.host.requestRepaint();
  }

  /** 单个点云对象同步当前样式（着色模式 + 不透明度 + 选中高亮） */
  applyPointCloudStyle(points: THREE.Points, selected = this.host.sel.selectedMeshes.includes(points)): void {
    applyPointCloudStyle(points, this.host.style, this.host.uniforms, selected);
  }

  /** 全部点云刷新：着色模式切换时用（uniform 是共享引用，改色不用走这里） */
  applyPointCloudStyles(): void {
    for (const pc of this.host.pointClouds) this.applyPointCloudStyle(pc);
    this.host.requestRepaint();
  }

  /** 平面/平滑着色：FLAT_SHADED 是编译期宏，改它必须重编译 */
  applyShading(): void {
    // shading 现在是共享 uniform（uFlatShading）驱动的运行期分支，不再是
    // flatShading define：翻一个 float 就完成切换，零重编译、零卡顿。
    const target = this.host.style.shading !== 'smooth' ? 1 : 0;
    for (const p of this.host.picks.pickables.values()) {
      const m = styledMaterialOf(p.mesh);
      const u = m?.userData.uFlatShading;
      if (!u || u.value === target) continue;
      u.value = target;
    }
    this.host.requestRepaint();
  }

  /** 本图层此刻该用的纹理创建参数（图层的渲染 profile 就落在这里） */
  textureOptions(): TextureCreateOptions {
    return {
      // direct 管线的前提是贴图字节值不解码，两者必须一起切
      srgbDecode: this.host.colorPipeline() !== 'direct',
      maxSize: this.host.options.maxTextureSize ?? Infinity,
      anisotropyCap: this.host.options.anisotropyCap ?? Infinity,
    };
  }

  /**
   * 应用图层渲染 profile（颜色管线 / 各向异性上限）。
   *
   * `initial` = 构造期：只记状态并推给数据集管理器，不重建材质、不重传纹理
   * （那时还没有瓦片）。
   */
  applyRenderProfile(
    patch: { colorPipeline?: ColorPipeline; anisotropyCap?: number },
    initial = false
  ): void {
    const prev = this.host.colorPipeline();
    if (patch.colorPipeline !== undefined) {
      this.host.setColorPipeline(normalizeColorPipeline(patch.colorPipeline) ?? 'linear');
    }
    if (patch.anisotropyCap !== undefined) this.host.options.anisotropyCap = patch.anisotropyCap;

    const textureOptions = this.textureOptions();
    // 之后加载的瓦片按新参数走（已建好的数据集也要跟着换）
    this.host.datasetManager.setRenderProfile({ colorPipeline: this.host.colorPipeline(), textureOptions });
    if (initial) return;

    // 管线变了才需要换 program；只改各向异性时重建纯属浪费
    if (this.host.colorPipeline() !== prev) this.rebuildStyledMaterials();
    this.syncCachedTextures(textureOptions);
    this.host.requestRepaint();
  }

  /**
   * 把纹理解码方式 / 各向异性同步到**已上传**的纹理上。
   *
   * 两者都不需要重新解码：`colorSpace` 改了 + `needsUpdate` 让 three 重传一次像素，
   * `anisotropy` 同理。所以切管线不用重拉瓦片，代价只有一次纹理上传。
   */
  syncCachedTextures(opts: TextureCreateOptions): void {
    const want = opts.srgbDecode ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    for (const entry of this.host.datasets.values()) {
      const cache = entry.tileset?.textureCache;
      if (!cache) continue;
      for (const tex of cache.values()) {
        if (tex.colorSpace === want) continue;
        tex.colorSpace = want;
        tex.needsUpdate = true;
      }
      applyAnisotropyCap(cache.values(), opts.anisotropyCap ?? Infinity);
    }
  }

  /** 按创建参数原位重建所有 styled 材质（materialQuality 切换用） */
  rebuildStyledMaterials(): void {
    // 逐材质 own uniform 的状态要在重建时搬过去，否则选中高亮 / 瓦片淡入会闪没
    const PRESERVED = [
      'uSelBatch',
      'uSelWhole',
      'uBatchTex',
      'uBatchTex2',
      'uBatchTexWidth',
      'uBatchTexActive',
      'uTileFade',
    ] as const;
    for (const p of this.host.picks.pickables.values()) {
      const mesh = p.mesh;
      const raw = mesh.material;
      if (Array.isArray(raw)) continue; // styled 材质恒为单材质；数组材质（点云等）不归这里管
      const old = raw as StyledMaterial | undefined;
      if (!old?.userData?.isStyled || !old.userData?.s3mOpts) continue;
      const opts = old.userData.s3mOpts as StyledMaterialOptions;
      // 显式传本层档位与管线：s3mOpts 里记的是创建时的参数，可能是 undefined（跟随全局），
      // 重建时必须钉成本层当前值，否则「别处改了全局」会把这一层带跑。
      const fresh = createStyledMaterial({
        ...opts,
        uniforms: this.host.uniforms,
        materialQuality: this.host.materialQuality(),
        colorPipeline: this.host.colorPipeline(),
      });
      for (const key of PRESERVED) {
        const src = old.userData[key] as { value: unknown } | undefined;
        const dst = fresh.userData[key] as { value: unknown } | undefined;
        if (src && dst) dst.value = src.value;
      }
      mesh.material = fresh;
      old.dispose();
    }
  }

  /**
   * 预热着色 program，避免首帧同步编译。
   *
   * shading 改为 `uFlatShading` 共享 uniform 驱动后（见 `applyShading`），
   * flat / smooth 共用同一个 program，不再存在「另一种变体」，也不需要
   * 「翻变体 → 编译 → 翻回来」的那套流程与 `_prewarming` 跳帧。这里只把当前
   * 唯一的 program 编一次（优先 `compileAsync`，KHR_parallel_shader_compile）。
   */
  async prewarmShading(): Promise<void> {
    if (this.host.shadingPrewarmed() || this.host.prewarming()) return;
    const r = this.host.renderer();
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (!r || !scene || !camera) return;

    // 场上还没有材质就没必要预热：program 会在首个材质出现时编译
    let hasMaterial = false;
    for (const p of this.host.picks.pickables.values()) {
      if (styledMaterialOf(p.mesh)) {
        hasMaterial = true;
        break;
      }
    }
    if (!hasMaterial) return;

    this.host.setShadingPrewarmed(true);
    try {
      const anyR = r as unknown as {
        compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown>;
      };
      if (typeof anyR.compileAsync === 'function') await anyR.compileAsync(scene, camera);
      else r.compile(scene, camera);
    } catch {
      // 预热失败不影响主流程：最坏情况退回「首次渲染时编译一次」
    }
    this.host.requestRepaint();
  }
}
