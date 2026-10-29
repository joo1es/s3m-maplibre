/**
 * 光照与色调映射：四个光源 + 光照预设 + 环境贴图。
 *
 * 从 `S3MViewer` 里整体搬出来的第一块 —— 它只依赖 `scene` / `renderer` / 共享
 * uniform / 宿主方位角，不碰几何、瓦片、拾取，是耦合最低的一块。
 *
 * ## 颜色管线是图层级的
 *
 * 颜色管线 / 纹理解码 / 各向异性三者一起决定「官方 supermap 观感」，都由
 * `ctx.applyRenderProfile` 落到本图层（见 `S3MViewer._applyRenderProfile`），
 * 不再写模块级全局 —— 同页两个 viewer 用不同预设互不影响，已加载瓦片也会
 * 当场重建材质、重传纹理，不用重载。
 */
import * as THREE from 'three';
import { resolveLightingPreset, type LightingPreset } from '../lightingPreset.js';
import type { ColorPipeline } from '../StyleMaterial.js';
import type { LightOptions, S3MViewerOptions } from '../S3MViewer.js';
import type { StyleUniforms } from '../../core/types.js';

/** 四个光源的强度 / 颜色 / 朝向。`mainIntensity` / `mainColor` 是 keyLight 的别名 */
type LightState = Required<Omit<LightOptions, 'mainIntensity' | 'mainColor'>>;

const DEFAULT_LIGHT: LightState = {
  ambientIntensity: 0.4,
  ambientColor: 0xffffff,
  hemisphereIntensity: 0.8,
  hemisphereColor: 0xffffff,
  hemisphereGroundColor: 0xb6c0cb,
  keyLightIntensity: 1.0,
  keyLightColor: 0xffffff,
  fillLightIntensity: 0.35,
  fillLightColor: 0xffffff,
  mode: 'headlamp',
  azimuth: 150,
  altitude: 50,
};

/**
 * 宿主侧依赖。全部用取值函数而不是对象引用 —— 宿主可能在 mount 之前构造 viewer，
 * 而 `scene` / `renderer` 在 mount 时才存在，存快照会拿到 null。
 */
export interface LightRigContext {
  scene: () => THREE.Scene | null;
  renderer: () => THREE.WebGLRenderer | null;
  uniforms: StyleUniforms;
  options: S3MViewerOptions;
  /** 地图方位角（度），让主光跟着视角走；纯 three 宿主可以不传 */
  getBearing?: () => number | undefined;
  /** 宿主需要重画的信号 */
  repaint: () => void;
  /**
   * 应用图层级渲染 profile（颜色管线 + 各向异性）。
   *
   * `initial = true` 是构造期：那时还没有瓦片与材质，落地方只记状态即可。
   * 换掉以前的 `setColorPipeline` / `setSrgbTextureDecode` / `setAnisotropyCap`
   * 三个模块级全局调用 —— 它们会让同页多图层互相污染。
   */
  applyRenderProfile: (p: { colorPipeline: ColorPipeline; anisotropyCap: number }, initial?: boolean) => void;
}

export class LightRig {
  ambient: THREE.AmbientLight | null = null;
  hemi: THREE.HemisphereLight | null = null;
  key: THREE.DirectionalLight | null = null;
  fill: THREE.DirectionalLight | null = null;

  private readonly _state: LightState;
  /** 环境贴图的 PMREM 渲染目标（setEnvironment 建的，dispose 时释放） */
  private _envRT: THREE.WebGLRenderTarget | null = null;

  /** @internal 环境贴图 RT，供单测观察「有没有释放旧的」 */
  get envRT(): THREE.WebGLRenderTarget | null {
    return this._envRT;
  }
  set envRT(v: THREE.WebGLRenderTarget | null) {
    this._envRT = v;
  }

  constructor(private readonly ctx: LightRigContext) {
    this._state = { ...DEFAULT_LIGHT };
    const options = ctx.options;
    if (options.lightingPreset && options.lightingPreset !== 'default') {
      Object.assign(this._state, resolveLightingPreset(options.lightingPreset));
      this.applyColorPipeline(options.lightingPreset, true);
    }
    if (options.light) Object.assign(this._state, options.light);
  }

  /* ---------------------------------------------------------------- 场景挂载 */

  private _create(): void {
    this.ambient = new THREE.AmbientLight(this._state.ambientColor as THREE.ColorRepresentation, this._state.ambientIntensity);
    this.hemi = new THREE.HemisphereLight(
      this._state.hemisphereColor as THREE.ColorRepresentation,
      this._state.hemisphereGroundColor as THREE.ColorRepresentation,
      this._state.hemisphereIntensity
    );
    this.key = new THREE.DirectionalLight(this._state.keyLightColor as THREE.ColorRepresentation, this._state.keyLightIntensity);
    this.fill = new THREE.DirectionalLight(this._state.fillLightColor as THREE.ColorRepresentation, this._state.fillLightIntensity);
    this.update();
  }

  /** 把四个光源挂进场景；重复调用是幂等的 */
  addToScene(): void {
    const scene = this.ctx.scene();
    if (!scene) return;
    if (!this.ambient) this._create();
    scene.add(this.ambient!, this.hemi!, this.key!, this.fill!);
  }

  /** 光源实例是否已建（构造后、mount 前是 false） */
  get created(): boolean {
    return this.ambient !== null;
  }

  /* ---------------------------------------------------------------- 参数 */

  private _applyOptions(): void {
    const s = this._state;
    if (this.ambient) {
      this.ambient.intensity = s.ambientIntensity;
      this.ambient.color.set(s.ambientColor as THREE.ColorRepresentation);
    }
    if (this.hemi) {
      this.hemi.intensity = s.hemisphereIntensity;
      this.hemi.color.set(s.hemisphereColor as THREE.ColorRepresentation);
      this.hemi.groundColor.set(s.hemisphereGroundColor as THREE.ColorRepresentation);
    }
    if (this.key) {
      this.key.intensity = s.keyLightIntensity;
      this.key.color.set(s.keyLightColor as THREE.ColorRepresentation);
    }
    if (this.fill) {
      this.fill.intensity = s.fillLightIntensity;
      this.fill.color.set(s.fillLightColor as THREE.ColorRepresentation);
    }
  }

  /**
   * 更新光照位置与方向：
   * - `'headlamp'`：随地图方位角 bearing 旋转，主光始终在镜头上方，受光面面向镜头；
   * - `'fixed'`：固定世界方位角（如模拟恒定日光）。
   */
  update(): void {
    if (!this.key || !this.fill) return;
    const s = this._state;
    const bearing = s.mode === 'fixed' ? 0 : ((this.ctx.getBearing?.() ?? 0) * Math.PI) / 180;
    const place = (light: THREE.DirectionalLight | null, azOffsetDeg: number, elevDeg: number): void => {
      if (!light) return;
      const az = bearing + (azOffsetDeg * Math.PI) / 180;
      const el = (elevDeg * Math.PI) / 180;
      const c = Math.cos(el);
      light.position.set(Math.sin(az) * c, Math.cos(az) * c, Math.sin(el)).multiplyScalar(1000);
    };
    place(this.key, s.azimuth, s.altitude);
    place(this.fill, s.azimuth + 65, Math.max(10, s.altitude - 20));
    // direct 管线的官方 Lambert 用主光方向（共享 uniform，所有材质同步生效）
    const sun = this.ctx.uniforms?.uSunDirection;
    if (sun) (sun.value as THREE.Vector3).copy(this.key.position).normalize();
  }

  /**
   * supermap 完整版 = 光照强度 + 颜色管线一起切：
   * direct 管线下纹理不做 sRGB 解码、片元按官方常数 Lambert 直乘（见 lightingPreset.ts）。
   *
   * 这三样（管线 / 解码 / 各向异性）以前都是模块级全局，同页两个图层用不同预设
   * 会互相污染；现在交给 `ctx.applyRenderProfile`，由图层自己持有并透传给材质与纹理。
   */
  applyColorPipeline(preset: LightingPreset, initial = false): void {
    const direct = preset === 'supermap';
    // 官方不开各向异性：远处直接采高 mip 平均成纯色（"灰色滤镜"的一部分）。
    // 我们默认 Infinity（倾斜摄影立面清晰度优先），supermap 模式必须收回。
    this.ctx.applyRenderProfile(
      { colorPipeline: direct ? 'direct' : 'linear', anisotropyCap: direct ? 1 : Infinity },
      initial
    );
  }

  setLightingPreset(preset: LightingPreset): void {
    Object.assign(this._state, resolveLightingPreset(preset));
    this.applyColorPipeline(preset);
    this.ctx.options.lightingPreset = preset;
    this._applyOptions();
    this.update();
    this.ctx.repaint();
  }

  setLight(options: Partial<LightOptions>): void {
    const normalized: Partial<LightOptions> = { ...options };
    if (normalized.mainColor !== undefined && normalized.keyLightColor === undefined) {
      normalized.keyLightColor = normalized.mainColor;
    }
    if (normalized.mainIntensity !== undefined && normalized.keyLightIntensity === undefined) {
      normalized.keyLightIntensity = normalized.mainIntensity;
    }
    Object.assign(this._state, normalized);
    this._applyOptions();
    this.update();
    this.ctx.repaint();
  }

  getLight(): LightOptions {
    return { ...this._state };
  }

  setToneMapping(toneMapping: THREE.ToneMapping, exposure = 1.0): void {
    this.ctx.options.toneMapping = toneMapping;
    this.ctx.options.toneMappingExposure = exposure;
    const r = this.ctx.renderer();
    if (r) {
      r.toneMapping = toneMapping;
      r.toneMappingExposure = exposure;
        this.ctx.repaint();
    }
  }

  getToneMapping(): { toneMapping: THREE.ToneMapping; toneMappingExposure: number } {
    const r = this.ctx.renderer();
    return {
      toneMapping: r ? r.toneMapping : (this.ctx.options.toneMapping ?? THREE.NoToneMapping),
      toneMappingExposure: r ? r.toneMappingExposure : (this.ctx.options.toneMappingExposure ?? 1.0),
    };
  }

  /* ---------------------------------------------------------------- 环境贴图 */

  /**
   * 挂 / 摘环境贴图。
   *
   * 金属度（`setStyle({ metalness })`）**必须**有环境图才看得出质感：
   * PBR 的金属几乎没有漫反射，画面全靠 `scene.environment` 里的环境反射，
   * 没有它时 metalness 一高就整片发黑，只剩两盏平行灯打成的小高光点。
   *
   * @param source 等距柱状图（.hdr / .jpg / .png，2:1）地址，或已加载的 `THREE.Texture`；
   *               `null` = 关掉环境图
   * @param intensity 环境光强度（`scene.environmentIntensity`，默认 1）
   *
   * 传入 URL 时纹理由内部加载并转成 PMREM（预滤波 mipmap）；传 Texture 时不会接管它的生命周期。
   */
  async setEnvironment(source: string | THREE.Texture | null, intensity = 1): Promise<void> {
    const renderer = this.ctx.renderer();
    const scene = this.ctx.scene();
    if (!renderer || !scene) return;
    scene.environmentIntensity = Math.max(0, intensity);

    if (source == null) {
      scene.environment = null;
      this._envRT?.dispose();
      this._envRT = null;
      this.ctx.repaint();
      return;
    }

    const fromUrl = typeof source === 'string';
    const tex = fromUrl ? await new THREE.TextureLoader().loadAsync(source) : source;
    // PMREM 只认等距柱状图；普通贴图也按 2:1 全景处理
    tex.mapping = THREE.EquirectangularReflectionMapping;

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    if (fromUrl) tex.dispose();

    scene.environment = rt.texture;
    // 上一张（同一个 viewer 反复换）要释放，否则显存里会一直堆
    this._envRT?.dispose();
    this._envRT = rt;
    this.ctx.repaint();
  }

  /** 释放环境贴图与光源（unmount 时调） */
  dispose(): void {
    this._envRT?.dispose();
    this._envRT = null;
  }
}
