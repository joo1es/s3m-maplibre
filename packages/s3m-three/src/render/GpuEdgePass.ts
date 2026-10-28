/**
 * GPU 描边后处理（深度 + 法线）
 *
 * 为什么不用「材质里求法线导数」：`dFdx` 只在 2×2 quad 内求差，quad 里落到三角形外的
 * 像素是**同一个三角形的外推值**，不是隔壁三角形的真实值 —— 所以片元着色器永远看不到
 * 三角形边界，而平面着色几何的折边恰好就是三角形边界，一条都描不出来（实测法线导数
 * 恒为 0）。业界做描边都走「法线/深度缓冲 + 后处理」，就是这里这套。
 *
 * 流程（每帧）：
 *   1. 用 `MeshNormalMaterial` 覆盖材质把整个场景渲进一张 RT：颜色 = 视空间法线，
 *      深度 = 深度纹理。这一遍没有贴图、没有光照，成本基本就是几何 + 填充。
 *   2. 画一个全屏 quad：在 RT 上按 `uRadius` 采样 4 邻域，取「法线差」和「相对深度差」
 *      的最大值当描边强度。采样偏移就是线宽，也就是「外扩」半径。
 *   3. quad 里 `gl_FragDepth` 写回该像素在 RT 里的深度，于是它和宿主（MapLibre 的底图 /
 *      地形 / 其他图层）共用同一个深度缓冲 —— 被地形挡住的地方描边也会被挡住。
 *
 * 只支持 WebGL2（`gl_FragDepth` + `DepthTexture` 都是核心特性）。WebGL1 上 `supported()`
 * 返回 false，调用方静默跳过，不影响其它画法。
 */
import * as THREE from 'three';

/** 描边参数（全部来自 style，每帧传一次） */
export interface GpuEdgeParams {
  /** 描边颜色 */
  color: THREE.Color;
  /** 描边强度（已乘过 edgeOpacity / 整体不透明度 / 淡入系数） */
  opacity: number;
  /** 采样偏移（设备像素）：线宽 ≈ 2×radius，也就是「外扩」半径 */
  radius: number;
  /** 法线差阈值：相邻采样的法线差超过它就算棱（|Δn| = 2·sin(θ/2) 量级） */
  normalThreshold: number;
  /** 相对深度差阈值：深度突变（几何轮廓 / 前后遮挡）也算棱 */
  depthThreshold: number;
}

const QUAD_VERT = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    // 直接给裁剪空间坐标，不走任何矩阵 —— 全屏 quad 没有相机语义
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

const QUAD_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uRadius;
  uniform float uNormalThreshold;
  uniform float uDepthThreshold;
  uniform vec3 uColor;
  uniform float uOpacity;

  in vec2 vUv;
  out vec4 fragColor;

  /** 两个采样的法线差（法线在 RT 里编码成 0.5 + n/2） */
  float normalDelta( vec2 a, vec2 b ) {
    vec3 na = texture( tNormal, a ).xyz * 2.0 - 1.0;
    vec3 nb = texture( tNormal, b ).xyz * 2.0 - 1.0;
    return length( na - nb );
  }

  /**
   * 两个采样的相对深度差。
   * 除以较小深度是为了让「远处同样米级的落差」也有可比性：深度缓冲是非线性的，
   * 远处 1 米的落差在缓冲里可能只差 1e-5，不归一化就永远达不到阈值。
   */
  float depthDelta( vec2 a, vec2 b ) {
    float da = texture( tDepth, a ).x;
    float db = texture( tDepth, b ).x;
    return abs( da - db ) / max( min( da, db ), 1e-6 );
  }

  void main() {
    float d = texture( tDepth, vUv ).x;
    // 没有几何的地方（清屏深度）不画，否则整片天空都会描边
    if ( d >= 0.999999 ) discard;

    vec2 o = uTexel * max( uRadius, 1.0 );
    vec2 dx = vec2( o.x, 0.0 );
    vec2 dy = vec2( 0.0, o.y );

    float n = max(
      max( normalDelta( vUv, vUv + dx ), normalDelta( vUv, vUv - dx ) ),
      max( normalDelta( vUv, vUv + dy ), normalDelta( vUv, vUv - dy ) )
    );
    float dd = max(
      max( depthDelta( vUv, vUv + dx ), depthDelta( vUv, vUv - dx ) ),
      max( depthDelta( vUv, vUv + dy ), depthDelta( vUv, vUv - dy ) )
    );

    float m = max(
      smoothstep( uNormalThreshold, uNormalThreshold * 1.6, n ),
      smoothstep( uDepthThreshold, uDepthThreshold * 2.0, dd )
    );
    float a = m * uOpacity;
    if ( a <= 0.004 ) discard;

    // 写回该像素在本层里的深度：与宿主共用深度缓冲，被地形挡住就不显示
    gl_FragDepth = d;
    fragColor = vec4( uColor, a );
  }
`;

export class GpuEdgePass {
  private rt: THREE.WebGLRenderTarget | null = null;
  private width = 0;
  private height = 0;
  /** 法线通道用的覆盖材质：视空间法线编码进颜色，深度走深度纹理 */
  private readonly normalMaterial = new THREE.MeshNormalMaterial();
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tNormal: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: 1.5 },
        uNormalThreshold: { value: 0.55 },
        uDepthThreshold: { value: 0.08 },
        uColor: { value: new THREE.Color('#334155') },
        uOpacity: { value: 0.6 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    quad.raycast = () => {};
    this.quadScene.add(quad);
  }

  /** `gl_FragDepth` 与深度纹理都是 WebGL2 核心特性，WebGL1 直接不参与 */
  supported(renderer: THREE.WebGLRenderer): boolean {
    return (renderer.capabilities as { isWebGL2?: boolean }).isWebGL2 === true;
  }

  /** 尺寸变了就重建 RT（canvas 跟着宿主缩放，必须每帧校验） */
  private ensureTarget(width: number, height: number): THREE.WebGLRenderTarget {
    if (this.rt && this.width === width && this.height === height) return this.rt;
    this.disposeTarget();
    const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.generateMipmaps = false;
    rt.depthTexture = new THREE.DepthTexture(Math.max(1, width), Math.max(1, height), THREE.UnsignedIntType);
    this.rt = rt;
    this.width = width;
    this.height = height;
    return rt;
  }

  /**
   * 渲一遍法线 + 深度，再把描边叠加到当前 framebuffer（调用方已画完主场景）。
   *
   * 注意顺序：主场景必须先画完 —— 描边 quad 要参与宿主的深度测试，
   * 依赖主场景已经写好的深度。
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
    params: GpuEdgeParams
  ): void {
    if (!this.supported(renderer) || width <= 0 || height <= 0) return;
    const rt = this.ensureTarget(width, height);

    // ---- 1. 法线 + 深度到 RT（覆盖材质，无贴图无光照） ----
    const prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    scene.overrideMaterial = this.normalMaterial;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevClear, prevClearAlpha);

    // ---- 2. 全屏描边叠加 ----
    const u = this.material.uniforms;
    u.tNormal.value = rt.texture;
    u.tDepth.value = rt.depthTexture;
    (u.uTexel.value as THREE.Vector2).set(1 / Math.max(1, width), 1 / Math.max(1, height));
    u.uRadius.value = Math.max(1, params.radius);
    u.uNormalThreshold.value = Math.max(0.001, params.normalThreshold);
    u.uDepthThreshold.value = Math.max(0.001, params.depthThreshold);
    (u.uColor.value as THREE.Color).copy(params.color);
    u.uOpacity.value = params.opacity;

    renderer.setViewport(0, 0, width, height);
    renderer.resetState();
    renderer.render(this.quadScene, this.quadCamera);
  }

  private disposeTarget(): void {
    if (!this.rt) return;
    this.rt.depthTexture?.dispose();
    this.rt.dispose();
    this.rt = null;
    this.width = 0;
    this.height = 0;
  }

  dispose(): void {
    this.disposeTarget();
    this.material.dispose();
    this.normalMaterial.dispose();
    this.quadScene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
  }
}
