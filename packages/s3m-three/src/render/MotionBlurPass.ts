/**
 * 可选的运动模糊后处理（默认关闭）—— issue #4
 *
 * 动机：低端 / 移动设备 FPS 低，运动物体出现卡顿（judder）与边缘闪烁（shimmer）。
 * 运动模糊本质是「骗眼睛」的特效：把离散帧之间的跳变填成连续模糊，在感知层面
 * 弥补低帧率的不顺滑。它不提升分辨率 / 几何 / 静态画质，只对「正在运动」的画面有效。
 *
 * 两种模式（成本差异大）：
 *
 * - `afterimage`（推荐低端机）：当前帧 + 上一帧全屏混合，每帧 3 个全屏 pass
 *   （场景 → RT、混合 → RT、合成 → 宿主 framebuffer），几乎零边际 GPU 成本。
 *   不是方向感知的：快速平移 / 旋转时像「拖影」而非「方向模糊」，damp 太高会出重影。
 * - `velocity`：相机运动模糊。用「上一帧 MVP ↔ 当前帧 MVP」在 shader 里逐像素反推
 *   裁剪空间速度，沿速度向量 8 tap 采样求平均（方向感知，快速平移是真正的方向拉丝）。
 *   只覆盖相机运动（地图场景的主要运动源），单体动画不产生拖影。
 *
 * 宿主共享上下文下的三条硬约束（与 GpuEdgePass 同一套思路）：
 *
 * 1. **本层是画在宿主（MapLibre）framebuffer 上的**，不能整帧后处理宿主画面 ——
 *    场景先进自己的 RT（线性空间，three 往非 XR RT 渲染时不做色调映射 / sRGB 转换，
 *    见 WebGLPrograms 的 outputColorSpace 分支），再用全屏 quad 合成回宿主 framebuffer。
 * 2. **深度不能丢**：直渲时 S3M 几何写宿主深度，后画的宿主图层靠它遮挡。合成 quad
 *    用 `gl_FragDepth` 写回 RT 里记录的深度，遮挡关系与直渲一致；被宿主地形挡住的
 *    像素照样不出现。没有几何的像素（天空）discard，不写深度。
 * 3. **色调映射 / 色彩空间要补**：three 只在渲染到屏幕（target=null）时才对片元做
 *    tone mapping 与 linear→sRGB 转换；RT 里存的是线性值，合成 shader 末尾必须
 *    `#include <tonemapping_fragment>` + `#include <colorspace_fragment>` 补上，
 *    否则整层会比直渲发暗发灰。
 *
 * 已知限制（有意为之，见 docs/API.md）：
 * - 拖影只出现在「当前帧几何覆盖范围内」：合成 quad 依赖本帧深度，快速甩动时
 *   轮廓之外的残影会被丢弃（不写深度就不能保住遮挡正确性）。
 * - 透明混合的顺序语义有细微变化：直渲是「逐片元 tone map 后混合」，这里是
 *   「线性混合后统一 tone map」，半透明重叠区的色值有极小偏差。
 * - RT 用 HalfFloatType（半精度浮点）：线性空间的高光 / 自发光不被 clamp 到 [0,1]，
 *   代价是三张全屏纹理显存 ×2、带宽 ×2 —— 低端机的取舍见 docs 的性能调优。
 *
 * 只支持 WebGL2（`gl_FragDepth` + `DepthTexture`）。WebGL1 上 `supported()` 返回
 * false，调用方回退直渲路径，行为与不开运动模糊一致。
 */
import * as THREE from 'three';

/** 公共选项（S3MViewerOptions.motionBlur 的形状） */
export interface MotionBlurOptions {
  /**
   * 模式：`'afterimage'`（帧间混合，便宜，默认）/ `'velocity'`（相机速度方向模糊，贵一点）。
   * 不传整个 `motionBlur` 对象 = 关闭；传了对象但没写 mode = afterimage。
   */
  mode?: 'afterimage' | 'velocity';
  /**
   * 拖尾长度（仅 afterimage 用）：上一帧在结果里的保留比例，0~0.98。
   * `'auto'`（默认）按实时 FPS 收敛 —— 帧率越低拖影越长，公式见 `autoMotionBlurDamp`。
   */
  damp?: number | 'auto';
  /**
   * 拖影上限（仅 velocity 用）：速度向量的最大屏幕偏移，取绘图缓冲宽度的百分比，0~1。
   * 默认 `0.05`（屏宽 5%）—— 瞬移 / 视角跳变时不整屏拉丝。快速甩动想要更长拖尾调大即可。
   */
  maxOffset?: number;
}

/** 归一化后的配置（viewer 内部持有） */
export interface MotionBlurConfig {
  mode: 'afterimage' | 'velocity';
  damp: number | 'auto';
  maxOffset: number;
}

/**
 * 选项归一化。不传 / null / 非对象 = 关闭（返回 null）；传了对象 = 开启：
 * mode 缺省或非法回退 `'afterimage'`；damp 缺省 / NaN = `'auto'`，数值钳到 [0, 0.98]；
 * maxOffset 缺省 / NaN = 0.05，数值钳到 [0, 1]。
 * 0.98 封顶是防「永远糊着」——damp 趋近 1 时残影按几何级数衰减，30 帧都散不掉。
 */
export function normalizeMotionBlur(o: MotionBlurOptions | null | undefined): MotionBlurConfig | null {
  if (!o || typeof o !== 'object') return null;
  const mode = o.mode === 'velocity' ? 'velocity' : 'afterimage';
  let damp: number | 'auto' = 'auto';
  if (typeof o.damp === 'number' && Number.isFinite(o.damp)) {
    damp = Math.min(0.98, Math.max(0, o.damp));
  }
  // maxOffset 是屏宽百分比：>1 等于不设上限（整屏拉丝），负数无意义
  let maxOffset = 0.05;
  if (typeof o.maxOffset === 'number' && Number.isFinite(o.maxOffset)) {
    maxOffset = Math.min(1, Math.max(0, o.maxOffset));
  }
  return { mode, damp, maxOffset };
}

/**
 * FPS 自适应拖尾（issue #4 的低端机专项：damp 不写死）。
 *
 * `damp = 0.55^(fps/60)` 封顶 0.92：
 * - 60fps ≈ 0.55（克制，桌面 / 高刷屏几乎无感）；
 * - 30fps ≈ 0.74、15fps ≈ 0.86（帧间隔越长，需要填的时间洞越宽，拖影越长）；
 * - 等价于「拖影覆盖的帧数随帧率降低而增长」，这正是低帧率卡顿需要的补偿；
 * - 未知帧率（0 / NaN，启动前几百毫秒）按 60fps 保守取值，避免开局糊脸。
 */
export function autoMotionBlurDamp(fps: number): number {
  const f = Number.isFinite(fps) && fps > 0 ? fps : 60;
  return Math.min(0.92, 0.55 ** (f / 60));
}

/** 每帧入参：mode/damp 已由 viewer 解析（auto → 数值），mvp 为本帧完整裁剪矩阵 */
export interface MotionBlurParams {
  mode: 'afterimage' | 'velocity';
  damp: number;
  /** velocity 拖影上限（屏宽百分比，来自归一化后的配置） */
  maxOffset: number;
  /** 本帧 world→clip（viewer 的 _frameMvp，已乘 ENU 矩阵） */
  mvp: THREE.Matrix4;
  /** mvp 的逆（viewer 的 camera.projectionMatrixInverse，每帧已维护） */
  mvpInverse: THREE.Matrix4;
}

const QUAD_VERT = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    // 直接给裁剪空间坐标，不走任何矩阵 —— 全屏 quad 没有相机语义（同 GpuEdgePass）
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

/** afterimage 累积：new = cur×(1-damp) + prev×damp，premultiplied 颜色直接线性混合 */
const BLEND_FRAG = /* glsl */ `
  uniform sampler2D tCur;
  uniform sampler2D tPrev;
  uniform float uDamp;
  in vec2 vUv;

  void main() {
    vec4 cur = texture( tCur, vUv );
    vec4 prev = texture( tPrev, vUv );
    // RT 是线性空间（three 往 RT 渲染不做输出转换），混合本身也不涉及 tone map —— 原样直写
    gl_FragColor = cur * ( 1.0 - uDamp ) + prev * uDamp;
  }
`;

/**
 * 上屏合成：把 RT 的线性 premultiplied 结果转回宿主 framebuffer。
 * 色调映射 + linear→sRGB 必须在这里补（three 只对渲染到屏幕的片元做这两步）。
 */
const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform sampler2D tDepth;
  in vec2 vUv;

  void main() {
    float d = texture( tDepth, vUv ).x;
    // 没有几何（天空 / 底图）不画也不写深度：与直渲「这里没画过」完全一致
    if ( d >= 0.999999 ) discard;
    vec4 c = texture( tSrc, vUv );
    if ( c.a <= 0.004 ) discard;
    // 写回本帧几何的深度：后画的宿主图层照旧能被 S3M 建筑挡住
    gl_FragDepth = d;
    gl_FragColor = c;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * velocity：用上一帧 MVP 反推每像素裁剪空间速度，沿速度 8 tap 采样求平均。
 * 速度是相机运动的（地图场景的主要运动源）；单体动画不在其内。
 */
const VELOCITY_FRAG = /* glsl */ `
  uniform sampler2D tCur;
  uniform sampler2D tDepth;
  uniform mat4 uCurInv;
  uniform mat4 uPrevMvp;
  uniform float uMaxOffset;
  in vec2 vUv;

  void main() {
    float d = texture( tDepth, vUv ).x;
    if ( d >= 0.999999 ) discard;

    // ndc → 上一帧 ndc：相机没动 → 速度为 0；快速平移 → 沿运动方向拉丝
    vec4 ray = uCurInv * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    vec4 prevClip = uPrevMvp * ray;
    vec2 prevUv = ( prevClip.xy / prevClip.w ) * 0.5 + 0.5;
    vec2 vel = prevUv - vUv;
    // 拖影上限（屏幕宽度的百分比）：瞬移 / 视角跳变时不整屏拉丝
    float len = length( vel );
    if ( len > uMaxOffset ) vel *= uMaxOffset / len;

    // premultiplied 颜色的平均仍是 premultiplied —— alpha 通道一起被平均
    vec4 acc = vec4( 0.0 );
    for ( int i = 0; i < 8; i++ ) {
      float t = ( float( i ) + 0.5 ) / 8.0 - 0.5;
      acc += texture( tCur, vUv + vel * t );
    }
    acc /= 8.0;
    if ( acc.a <= 0.004 ) discard;

    gl_FragDepth = d;
    gl_FragColor = acc;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class MotionBlurPass {
  /** 本帧场景（线性颜色 + 深度纹理，两种模式共用） */
  rtScene: THREE.WebGLRenderTarget | null = null;
  /** afterimage 的 ping-pong 累积目标：同一张纹理不能同时读写（WebGL 未定义行为） */
  rtPrevRead: THREE.WebGLRenderTarget | null = null;
  rtPrevWrite: THREE.WebGLRenderTarget | null = null;
  /** 上一帧的 MVP（velocity 用；首帧 = 当前帧 → 零速度） */
  readonly _prevMvp = new THREE.Matrix4();
  /** 上一次 render 的模式：模式切换后累积链作废，afterimage 首帧按 damp=0 重新起步 */
  private _lastMode: 'afterimage' | 'velocity' | null = null;
  private _hasPrev = false;

  private width = 0;
  private height = 0;

  /** afterimage 累积材质（渲染进 RT，无混合、无色彩转换） */
  readonly blendMat: THREE.ShaderMaterial;
  /** 上屏合成材质（premultiplied 混合 + gl_FragDepth + tone map / sRGB 补偿） */
  private readonly compositeMat: THREE.ShaderMaterial;
  /** velocity 一步上屏材质（同为 premultiplied + gl_FragDepth） */
  readonly velocityMat: THREE.ShaderMaterial;

  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.blendMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tCur: { value: null },
        tPrev: { value: null },
        uDamp: { value: 0.55 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BLEND_FRAG,
      // 直写累积 RT：混合发生在 shader 里，不能让 fixed-function blending 再叠一次
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tSrc: { value: null },
        tDepth: { value: null },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      transparent: true,
      // RT 里是 premultiplied 颜色（场景以 NormalBlending 渲进透明底必然如此）
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    this.velocityMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tCur: { value: null },
        tDepth: { value: null },
        uCurInv: { value: new THREE.Matrix4() },
        uPrevMvp: { value: new THREE.Matrix4() },
        uMaxOffset: { value: 0.05 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: VELOCITY_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    // 一个 quad 换材质复用：blend / composite / velocity 都是全屏、无相机语义
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMat);
    quad.frustumCulled = false;
    quad.raycast = () => {};
    this.quadScene.add(quad);
  }

  /** gl_FragDepth 与 DepthTexture 都是 WebGL2 核心特性，WebGL1 直接不参与 */
  supported(renderer: THREE.WebGLRenderer): boolean {
    return (renderer.capabilities as { isWebGL2?: boolean }).isWebGL2 === true;
  }

  private ensureSceneTarget(width: number, height: number): void {
    if (this.rtScene && this.width === width && this.height === height) return;
    this.disposeTargets();
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    // 场景 RT：颜色 + 深度纹理（深度既用于 velocity 反推，也用于合成时写回 gl_FragDepth）。
    // HalfFloatType 是必须的：RT 里存的是 tone map 之前的线性值，UnsignedByteType 会把
    // 高光 / 自发光（>1）clamp 到 [0,1]，合成 tone map 后与直渲有可感知色差；代价是显存 ×2。
    this.rtScene = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.rtScene.texture.generateMipmaps = false;
    this.rtScene.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    this.width = w;
    this.height = h;
  }

  /** afterimage 才需要累积 RT；velocity 用不到就不建（省两份全屏 RGBA） */
  private ensurePrevTargets(width: number, height: number): void {
    if (this.rtPrevRead && this.rtPrevWrite) return;
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const mk = () => {
      // WebGL 保证新分配纹理零初始化，配合「首帧 damp=0」不需要显式 clear。
      // 与场景 RT 同为 HalfFloat：累积链的中间值同样在线性空间，clamp 会逐帧劣化高光
      const rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.rtPrevRead = mk();
    this.rtPrevWrite = mk();
  }

  private setQuadMaterial(mat: THREE.Material): void {
    const quad = this.quadScene.children[0] as THREE.Mesh;
    quad.material = mat;
  }

  /**
   * 渲一帧。调用方保证：场景本帧还没画过（本 pass 接管「场景 → 屏幕」这一步），
   * 且 supported() 为 true。帧末 prevMvp 滚动为本帧 mvp。
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
    params: MotionBlurParams
  ): void {
    if (width <= 0 || height <= 0) return;
    this.ensureSceneTarget(width, height);
    const rtScene = this.rtScene;
    if (!rtScene) return;

    // ---- 1. 场景 → RT（线性空间，透明底。clear color 状态要还原，宿主没让我们改它） ----
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(rtScene);
    renderer.setViewport(0, 0, width, height);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // ---- 2. 模糊 + 上屏 ----
    if (params.mode === 'velocity') {
      // velocity：无需累积，沿速度 8 tap 采样直接上屏
      const u = this.velocityMat.uniforms;
      u.tCur.value = rtScene.texture;
      u.tDepth.value = rtScene.depthTexture;
      (u.uCurInv.value as THREE.Matrix4).copy(params.mvpInverse);
      // 首帧（或刚从 afterimage 切过来还没 prev）prev = cur → 零速度，纯透传
      (u.uPrevMvp.value as THREE.Matrix4).copy(this._hasPrev ? this._prevMvp : params.mvp);
      u.uMaxOffset.value = params.maxOffset;
      this.setQuadMaterial(this.velocityMat);
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, width, height);
      renderer.resetState();
      renderer.render(this.quadScene, this.quadCamera);
    } else {
      this.ensurePrevTargets(width, height);
      if (!this.rtPrevRead || !this.rtPrevWrite) return;
      // 累积链刚起步（首帧 / 尺寸重建 / 从 velocity 切回来）：damp 按 0，
      // 本帧只写当前帧 —— 旧残影不该从别的模式或上一段会话里冒出来
      const firstAccum = this._lastMode !== 'afterimage';
      const u = this.blendMat.uniforms;
      u.tCur.value = rtScene.texture;
      u.tPrev.value = this.rtPrevRead.texture;
      // damp 由 normalizeMotionBlur 钳过、auto 已由 viewer 解析成数值，这里直传
      u.uDamp.value = firstAccum ? 0 : params.damp;
      this.setQuadMaterial(this.blendMat);
      renderer.setRenderTarget(this.rtPrevWrite);
      renderer.setViewport(0, 0, width, height);
      renderer.render(this.quadScene, this.quadCamera);

      const cu = this.compositeMat.uniforms;
      cu.tSrc.value = this.rtPrevWrite.texture;
      cu.tDepth.value = rtScene.depthTexture;
      this.setQuadMaterial(this.compositeMat);
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, width, height);
      renderer.resetState();
      renderer.render(this.quadScene, this.quadCamera);
      // ping-pong：本帧的累积结果成为下一帧的 prev
      const t = this.rtPrevRead;
      this.rtPrevRead = this.rtPrevWrite;
      this.rtPrevWrite = t;
    }

    renderer.setClearColor(prevClearColor, prevClearAlpha);

    // 帧末滚动：下一帧的「上一帧」就是本帧
    this._prevMvp.copy(params.mvp);
    this._hasPrev = true;
    this._lastMode = params.mode;
  }

  private disposeTargets(): void {
    for (const rt of [this.rtScene, this.rtPrevRead, this.rtPrevWrite]) {
      if (!rt) continue;
      rt.depthTexture?.dispose();
      rt.dispose();
    }
    this.rtScene = null;
    this.rtPrevRead = null;
    this.rtPrevWrite = null;
    this.width = 0;
    this.height = 0;
    this._hasPrev = false;
    this._lastMode = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.blendMat.dispose();
    this.compositeMat.dispose();
    this.velocityMat.dispose();
    this.quadScene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
  }
}
