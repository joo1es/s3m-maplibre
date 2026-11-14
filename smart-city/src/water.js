/**
 * 水面材质层：把 `*.water` 解析出来的参数变成真的流动水纹。
 *
 * 内核侧（tileset/water.ts + GeometryBuilder）已经做了两件事：
 *   1. 认出 `103.water` 纹理单元的几何是水面；
 *   2. 用数据集 config 的 `*.water` 附件里的 waterColour / brightness / alpha
 *      替代内置的常量兜底色，并给材质打上 `userData.s3mWater` 标记。
 * 但官方 Ogre shader 里的反射 / 折射 / 噪声法线扰动是运行时 RT + 内置 shader，
 * 解析结果只挂参数，本库不画。这一层补的是「画」：
 *
 *   - 不替换内核材质（那会丢掉共享 uniform / 淡入 / 拾取 / 样式系统），
 *     而是在水面 mesh 上挂一个**共用同一份 geometry** 的子 Mesh 做叠加；
 *   - 几何直接复用父网格 → 水纹形状严格等于湖的真实轮廓，零额外几何显存；
 *   - 参数从 `S3MTileset.waterEffect` 读，解析没好之前用官方 default_params 兜底。
 *
 * 所有量都有上限保护：这份配置里 fresnelPower = 0.1、minFresnel = 0，
 * 直接照搬会让 pow() 几乎恒为 1、整片湖变成纯天空色。
 */
import * as THREE from 'three';

/** 与 tileset/water.ts 的 DEFAULT_WATER_EFFECT 一致，仅用于解析完成前的兜底 */
const FALLBACK = {
  waterColour: [0.1804, 0.2706, 0.3294, 1],
  tintColour: [0, 0.05, 0.05, 1],
  waterBrightness: 0.95,
  fresnelPower: 1.8,
  minFresnel: 0.3,
  maxFresnel: 0.7,
  noiseScale: 0.05,
  scale: 80,
  scroll: 1,
  noise: 1,
  bumpSpeed: [3, -3],
};

const VERT = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vWorld = wp.xyz;
    // w = 0 只取旋转/缩放，忽略平移；比 mat3(mat4) 在 GLSL ES 1.00 下更稳
    vNormalW = normalize( ( modelMatrix * vec4( normal, 0.0 ) ).xyz );
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3  uWater;
  uniform vec3  uTint;
  uniform float uBrightness;
  uniform float uFresnelPower;
  uniform float uMinFresnel;
  uniform float uMaxFresnel;
  uniform float uNoiseScale;
  uniform float uScale;
  uniform float uScroll;
  uniform float uNoise;
  uniform vec2  uBumpSpeed;
  uniform float uStrength;
  varying vec3 vWorld;
  varying vec3 vNormalW;

  float hash21( vec2 p ) {
    return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  }
  float vnoise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( hash21( i ), hash21( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( hash21( i + vec2( 0.0, 1.0 ) ), hash21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }

  void main() {
    // scale = 一米对应多少个纹理 tile；世界坐标是 ENU 米，直接用 xy 做噪声域
    vec2 uv = vWorld.xy / max( uScale, 8.0 );
    float t = uTime * 0.11;
    vec2 drift = uBumpSpeed * t * 0.02
               + vec2( uScroll, -uScroll * 0.7 ) * t * 0.06;

    float n1 = vnoise( uv * 6.0  + drift );
    float n2 = vnoise( uv * 13.0 - drift * 1.6 + vec2( 3.1, 8.7 ) );
    float n3 = vnoise( uv * 29.0 + drift * 2.2 + vec2( 11.3, 2.9 ) );

    // 有限差分求噪声梯度当作法线扰动；noiseScale 是配置里的 UV 偏移强度
    float e = 0.035;
    float gx = vnoise( uv * 13.0 + vec2( e, 0.0 ) - drift * 1.6 )
             - vnoise( uv * 13.0 - vec2( e, 0.0 ) - drift * 1.6 );
    float gy = vnoise( uv * 13.0 + vec2( 0.0, e ) - drift * 1.6 )
             - vnoise( uv * 13.0 - vec2( 0.0, e ) - drift * 1.6 );
    vec3 N = normalize( vNormalW + vec3( gx, gy, 0.0 ) * uNoiseScale * 26.0 );

    vec3 V = normalize( cameraPosition - vWorld );
    // 下限 0.35 是给 fresnelPower = 0.1 的配置兜底，否则掠射判定退化成全屏常数
    float f = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), max( uFresnelPower, 0.35 ) );
    float fres = mix( uMinFresnel, uMaxFresnel, clamp( f, 0.0, 1.0 ) );

    vec3 base = uWater * uBrightness + uTint;
    vec3 sky  = vec3( 0.42, 0.68, 0.95 );
    vec3 col  = mix( base, sky, fres * 0.62 );

    // 定向镜面高光：光源方向与 main.js 的太阳方位一致
    vec3 L = normalize( vec3( 0.42, 0.31, 0.85 ) );
    float spec = pow( max( dot( reflect( -L, N ), V ), 0.0 ), 88.0 );
    col += vec3( 1.0, 0.96, 0.86 ) * spec * ( 0.55 + 0.45 * n3 ) * 1.15;

    // 细碎波光，随噪声缓慢流动
    float glint = smoothstep( 0.68, 0.94, n1 * 0.55 + n2 * 0.45 );
    col += vec3( 0.62, 0.86, 1.0 ) * glint * 0.24 * uNoise;

    // 亮度上限，避免 additive 叠加时个别像素 NaN / 爆白
    col = clamp( col, vec3( 0.0 ), vec3( 1.6 ) );
    gl_FragColor = vec4( col, uStrength );
  }
`;

export class WaterSurface {
  constructor({ layer, map, datasetId = 'Lake@CBD' }) {
    this.layer = layer;
    this.map = map;
    this.datasetId = datasetId;
    this.seen = new WeakSet();
    this.children = [];
    this._timer = 0;
    this._raf = 0;
    this._running = false;
    this._paramsApplied = false;

    const p = FALLBACK;
    this.uniforms = {
      uTime: { value: 0 },
      uWater: { value: new THREE.Color(...p.waterColour.slice(0, 3)) },
      uTint: { value: new THREE.Color(...p.tintColour.slice(0, 3)) },
      uBrightness: { value: p.waterBrightness },
      uFresnelPower: { value: p.fresnelPower },
      uMinFresnel: { value: p.minFresnel },
      uMaxFresnel: { value: p.maxFresnel },
      uNoiseScale: { value: p.noiseScale },
      uScale: { value: p.scale },
      uScroll: { value: p.scroll },
      uNoise: { value: p.noise },
      uBumpSpeed: { value: new THREE.Vector2(...p.bumpSpeed) },
      uStrength: { value: 0 },
    };

    this._material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    this._loop = this._loop.bind(this);
  }

  /** 解析结果是异步到的，每次扫描都顺手同步一次；成功后只写一次 */
  _readParams() {
    if (this._paramsApplied) return;
    const entry = this.layer.datasets?.get(this.datasetId)
      ?? [...(this.layer.datasets?.values() ?? [])].find((e) => /Lake/i.test(e.id));
    const w = entry?.tileset?.waterEffect;
    if (!w) return;

    const u = this.uniforms;
    u.uWater.value.setRGB(
      Math.max(0, w.waterColour[0]), Math.max(0, w.waterColour[1]), Math.max(0, w.waterColour[2]),
    );
    u.uTint.value.setRGB(
      Math.max(0, w.tintColour[0]), Math.max(0, w.tintColour[1]), Math.max(0, w.tintColour[2]),
    );
    u.uBrightness.value = w.waterBrightness;
    u.uFresnelPower.value = w.fresnelPower;
    u.uMinFresnel.value = w.minFresnel;
    u.uMaxFresnel.value = w.maxFresnel;
    u.uNoiseScale.value = w.noiseScale;
    u.uScale.value = w.scale;
    u.uScroll.value = w.scroll;
    u.uNoise.value = w.noise;
    u.uBumpSpeed.value.set(w.bumpSpeed[0], w.bumpSpeed[1]);
    this._paramsApplied = true;
  }

  /** 瓦片是动态加载/卸载的：每 320ms 补挂新出现的水面网格 */
  scan() {
    this._readParams();
    const entry = this.layer.datasets?.get(this.datasetId)
      ?? [...(this.layer.datasets?.values() ?? [])].find((e) => /Lake/i.test(e.id));
    if (!entry?.root) return;

    entry.root.traverse((o) => {
      if (!o.isMesh || this.seen.has(o) || !o.userData?.s3mWater) return;
      this.seen.add(o);
      // 共用父网格的 geometry：轮廓就是数据本身，不 clone、不占额外显存
      const child = new THREE.Mesh(o.geometry, this._material);
      child.position.z = 0.09;       // ENU Z-up，抬 9cm 避开与底层的 z-fighting
      child.renderOrder = (o.renderOrder || 0) + 1;
      child.frustumCulled = false;
      o.add(child);
      this.children.push({ child, parent: o });
    });

    // LOD 会持续换瓦：把已经从场景摘掉的父网格连同叠加层一起回收，
    // 否则 children 数组会一直攥着旧瓦片的引用
    this.children = this.children.filter(({ child, parent }) => {
      if (parent.parent) return true;
      parent.remove(child);
      return false;
    });
    if (this.children.length) this.uniforms.uStrength.value = 0.62;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.scan();
    this._timer = setInterval(() => this.scan(), 320);
    this._raf = requestAnimationFrame(this._loop);
  }

  _loop(now) {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._loop);
    this.uniforms.uTime.value = now / 1000;
    if (this.children.length) this.map.triggerRepaint();
  }

  dispose() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    clearInterval(this._timer);
    for (const { child, parent } of this.children) parent.remove(child);
    this.children = [];
    this._material.dispose();
  }
}
