/**
 * 示例：用 `viewer.setPresenter()` 接管「场景 → 屏幕」，做两种后处理。
 *
 * - `blur`：可分离高斯模糊（横一趟 + 竖一趟）
 * - `glow`：亮部提取 → 两趟模糊 → 原图 + 辉光叠加
 *
 * 这个文件想说明的不是「怎么写 blur / bloom」，而是**接管上屏要付的三笔账**：
 *
 * 1. 场景进 RT 之后，颜色是**线性空间 + premultiplied**，不是屏幕上的像素值。
 *    直接贴到屏幕会发暗发灰，所以合成末尾必须补 tone mapping 与 linear→输出色彩空间。
 * 2. RT 里的深度默认不会回到宿主 framebuffer。不写 `gl_FragDepth`，后画的宿主图层
 *    （标注、其它 custom layer）就挡不住楼，会被楼穿过去。
 * 3. 上屏这一步是自己的责任：`setRenderTarget(null)` 之后才画，否则画回 RT 里，
 *    屏幕停在上一次。
 *
 * 另外注意这层只处理 S3M：底图（MapLibre 的矢量和地形）根本不在这个 RT 里，
 * 所以它保持清晰。这是 presenter 相比「拷整张画布再后处理」最实际的好处。
 *
 * GLSL3 下 three 不注入 `gl_FragColor` 别名（见 WebGLProgram 的 glslVersion 分支），
 * 片元必须自己声明 `out vec4 fragColor`。
 */
import * as THREE from 'three';
import type { S3MLayer, PresenterContext, ViewerPresenter } from 's3m-maplibre';

/** 全屏三角带的顶点：直接输出 NDC，uv 由 PlaneGeometry 提供 */
const QUAD_VERT = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

/**
 * 可分离高斯的一趟：5 次采样（线性过滤让相邻两个 tap 合成一次采样），
 * 权重和为 1，方向由 uDir 决定，横竖各跑一遍。
 */
const BLUR_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;    // 1/宽, 1/高
  uniform vec2 uDir;      // (1,0) 横向 / (0,1) 纵向
  uniform float uRadius;  // 像素
  in vec2 vUv;
  out vec4 fragColor;

  void main() {
    vec2 step = uTexel * uDir * uRadius;
    vec4 c = texture( tSrc, vUv ) * 0.2270270270;
    c += texture( tSrc, vUv + step * 1.3846153846 ) * 0.3162162162;
    c += texture( tSrc, vUv - step * 1.3846153846 ) * 0.3162162162;
    c += texture( tSrc, vUv + step * 3.2307692308 ) * 0.0702702703;
    c += texture( tSrc, vUv - step * 3.2307692308 ) * 0.0702702703;
    fragColor = c;
  }
`;

/**
 * 亮部提取：只留下超过阈值的部分，辉光才有「亮的更亮」而不是整层发白。
 *
 * 注意 `uThreshold` 比的是**线性空间的绝对亮度**，不是屏幕上的观感值。
 * 场景先渲进 RT（未经 tone mapping），普通建筑立面的线性亮度常在 0.2~0.5，
 * 所以这个值要按数据集调：给 0.7 这种「看起来很高」的阈值，多数场景会一粒都不发光。
 * 乘 alpha 是因为颜色是 premultiplied 的，不一起缩放会破坏半透明边缘。
 */
const BRIGHT_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform float uThreshold;
  in vec2 vUv;
  out vec4 fragColor;

  void main() {
    vec4 src = texture( tSrc, vUv );
    float lum = dot( src.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    // 软膝：阈值附近平滑过渡，硬切会让高光边界出现一圈台阶
    float k = max( lum - uThreshold, 0.0 ) / max( lum, 1e-4 );
    fragColor = src * k;
  }
`;

/**
 * 上屏。`uBloom = 0` 时就是纯透传（模糊模式），绑同一张纹理即可，不用两套 shader。
 */
const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform sampler2D tBloom;
  uniform sampler2D tDepth;
  uniform float uBloom;
  in vec2 vUv;
  out vec4 fragColor;

  void main() {
    float d = texture( tDepth, vUv ).x;
    // 没有几何（天空 / 底图）的像素不画也不写深度，与直渲「这里没画过」完全一致
    if ( d >= 0.999999 ) discard;
    vec4 base = texture( tSrc, vUv );
    if ( base.a <= 0.004 ) discard;
    // 深度写回：后画的宿主图层照旧能被建筑挡住
    gl_FragDepth = d;
    vec3 rgb = base.rgb + texture( tBloom, vUv ).rgb * uBloom;
    fragColor = vec4( rgb, base.a );
    // 这两步不能省：省了能出画，只是整层发亮发灰，最难查的那种
    #if defined( TONE_MAPPING )
      fragColor.rgb = toneMapping( fragColor.rgb );
    #endif
    fragColor = linearToOutputTexel( fragColor );
  }
`;

export type PostEffectMode = 'blur' | 'glow';

export interface PostPresenterOptions {
  mode: PostEffectMode;
  /** 模糊半径（像素）：blur 的整体模糊，glow 的辉光扩散范围 */
  radius?: number;
  /** 仅 glow：辉光叠加强度，0 = 看不出效果 */
  strength?: number;
  /** 仅 glow：亮度阈值，低于它的像素不发光 */
  threshold?: number;
}

export interface PostPresenterHandle {
  /** 直接交给 `layer.setPresenter(...)` */
  presenter: ViewerPresenter;
  /** 改半径。改完会请求重绘 —— 静态画面不会自己再来一帧 */
  setRadius(px: number): void;
  /** 仅 glow：改叠加强度 */
  setStrength(v: number): void;
  /** 仅 glow：改亮度阈值 */
  setThreshold(v: number): void;
  /** 释放 RT 与材质。解除接管用 `layer.setPresenter(null)`，两者互不替代 */
  dispose(): void;
}

export function createPostPresenter(layer: S3MLayer, opts: PostPresenterOptions): PostPresenterHandle {
  const mode = opts.mode;
  // 默认值按「CBD 这类白天建筑」调的：阈值 0.25 已经能盖住大部分立面，
  // 强度 1.5 让光晕明显但不至于糊成一片。换数据集 / 改曝光就得重调这两个。
  let radius = opts.radius ?? (mode === 'glow' ? 10 : 6);
  let strength = opts.strength ?? 1.5;
  let threshold = opts.threshold ?? 0.25;

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const blurMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uDir: { value: new THREE.Vector2(1, 0) },
      uRadius: { value: radius },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: BLUR_FRAG,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });

  const brightMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tSrc: { value: null },
      uThreshold: { value: threshold },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: BRIGHT_FRAG,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });

  const compositeMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tSrc: { value: null },
      tBloom: { value: null },
      tDepth: { value: null },
      uBloom: { value: mode === 'glow' ? strength : 0 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: COMPOSITE_FRAG,
    transparent: true,
    // RT 里是 premultiplied 颜色，用这套混合才和直渲的透明度一致
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
  quad.frustumCulled = false;
  quadScene.add(quad);

  let rtA: THREE.WebGLRenderTarget | null = null;
  let rtB: THREE.WebGLRenderTarget | null = null;
  let w = 0;
  let h = 0;

  const ensureTargets = (width: number, height: number) => {
    if (rtA && rtB && w === width && h === height) return;
    rtA?.dispose();
    rtB?.dispose();
    const mk = () =>
      new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        // 线性空间的高光不能被 clamp 到 1，否则合成后再映射回来就是过曝
        type: THREE.HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    // 两趟模糊要两张：横向写 A，纵向从 A 读、写 B。同一张纹理不能同时读写
    rtA = mk();
    rtB = mk();
    w = width;
    h = height;
  };

  /** 一趟全屏。setRenderTarget 会顺带把 viewport 切到目标尺寸，不用手写 */
  const pass = (renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCamera);
  };

  const presenter: ViewerPresenter = {
    render(ctx: PresenterContext) {
      const { renderer } = ctx;
      let base: THREE.Texture = ctx.color;
      let bloom: THREE.Texture = ctx.color;
      let bloomMix = 0;

      if (mode === 'blur' && radius > 0.5) {
        ensureTargets(ctx.width, ctx.height);
        if (!rtA || !rtB) return;
        const u = blurMat.uniforms;
        u.uTexel.value.set(1 / ctx.width, 1 / ctx.height);
        u.uRadius.value = radius;

        u.uDir.value.set(1, 0);
        u.tSrc.value = ctx.color;
        pass(renderer, blurMat, rtA);
        u.uDir.value.set(0, 1);
        u.tSrc.value = rtA.texture;
        pass(renderer, blurMat, rtB);

        // 模糊模式只上屏模糊结果；tBloom 绑同一张、权重 0，省一套 shader
        base = rtB.texture;
        bloom = rtB.texture;
      } else if (mode === 'glow') {
        ensureTargets(ctx.width, ctx.height);
        if (!rtA || !rtB) return;

        // 1. 亮部提取（不进 RT 的颜色不能直接模糊，否则暗部也会被拉出光晕）
        brightMat.uniforms.tSrc.value = ctx.color;
        brightMat.uniforms.uThreshold.value = threshold;
        pass(renderer, brightMat, rtA);

        // 2. 横向模糊 → B
        const u = blurMat.uniforms;
        u.uTexel.value.set(1 / ctx.width, 1 / ctx.height);
        u.uRadius.value = radius;
        u.uDir.value.set(1, 0);
        u.tSrc.value = rtA.texture;
        pass(renderer, blurMat, rtB);

        // 3. 纵向模糊 → A（回到 A，省一张 RT）
        u.uDir.value.set(0, 1);
        u.tSrc.value = rtB.texture;
        pass(renderer, blurMat, rtA);

        // 原图保持清晰，辉光叠加在上面
        base = ctx.color;
        bloom = rtA.texture;
        bloomMix = strength;
      }

      const cu = compositeMat.uniforms;
      cu.tSrc.value = base;
      cu.tBloom.value = bloom;
      cu.tDepth.value = ctx.depth;
      cu.uBloom.value = bloomMix;

      quad.material = compositeMat;
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, ctx.width, ctx.height);
      // 前面几趟都是我们自己操作的 GL 状态，上屏前清一次缓存，让混合 / 深度设置真正生效
      renderer.resetState();
      renderer.render(quadScene, quadCamera);
    },
  };

  /** 改参数统一走这里：静态画面不会自己产生新一帧，不请求重绘滑块就是「拖着没反应」 */
  const repaint = () => layer.viewer.triggerRepaint();

  return {
    presenter,
    setRadius(px: number) {
      radius = Math.max(0, Math.min(24, px));
      blurMat.uniforms.uRadius.value = radius;
      repaint();
    },
    setStrength(v: number) {
      strength = Math.max(0, Math.min(4, v));
      compositeMat.uniforms.uBloom.value = mode === 'glow' ? strength : 0;
      repaint();
    },
    setThreshold(v: number) {
      threshold = Math.max(0, Math.min(1.5, v));
      brightMat.uniforms.uThreshold.value = threshold;
      repaint();
    },
    dispose() {
      rtA?.dispose();
      rtB?.dispose();
      rtA = null;
      rtB = null;
      blurMat.dispose();
      brightMat.dispose();
      compositeMat.dispose();
      quad.geometry.dispose();
    },
  };
}
