/**
 * 体积雾：把城市边界融进背景，别让 2.3 km² 的数据框硬切在纯色底图上。
 *
 * 三层，各自解决一件事：
 *  1. `scene.fog`（FogExp2）—— three 原生的距离雾。内核材质是 MeshStandardMaterial，
 *     fog 默认开，所以远处建筑/地面会按相机深度衰减到雾色，不用改任何库代码。
 *  2. 低空雾带 —— 三层不同高度的水平面，噪声密度沿半径从城心向外升高，
 *     平铺到 6000 m（远超数据的 2.3 km 范围）。城市边界之外还有雾在延伸，
 *     硬边就是这么化掉的；分层高度 + 各自流速给出「体积」而不是一张贴片。
 *  3. 雾色与 MapLibre sky 的 fog-color / horizon-color 对齐（见 main.js），
 *     远处模型、雾带、天空三者在同一个色调上收束。
 *
 * 两个刻意的取舍：
 *  - 雾带中心区几乎透明（径向 smoothstep 从 r=0.18 才起雾），不糊住建筑贴图；
 *  - `depth: 'occluded'`，楼会挡住它后面的雾，符合低空雾的物理关系。
 *
 * 底座的 update 回调每帧驱动时间与 scene 自愈：WebGL context restore 后
 * S3MViewer.mount() 会 new 一个 Scene，之前挂上去的 fog 会丢，这里顺手补回来。
 */
import * as THREE from 'three';
import { CITY } from './config.js';

/** 与 main.js 的 sky.fog-color 同一个色调，远处模型衰减到这里 */
const SCENE_FOG_COLOR = '#163352';
const SCENE_FOG_DENSITY = 0.00030;
/** 雾带略亮一档，让外围有被天光照亮的层次 */
const BAND_COLOR = '#2a537d';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uLayer;
  uniform float uStrength;
  uniform vec3  uColor;
  varying vec2 vUv;

  float hash21( vec2 p ) {
    return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  }
  float vnoise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( hash21( i ), hash21( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( hash21( i + vec2( 0.0, 1.0 ) ), hash21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }
  float fbm( vec2 p ) {
    float s = 0.0, a = 0.5;
    for ( int i = 0; i < 4; i++ ) {
      s += a * vnoise( p );
      p *= 2.03;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    // 平面 6000 m，r = 1 对应半宽 3000 m；城市半径约 1150 m → r ≈ 0.38
    vec2 p = ( vUv - 0.5 ) * 2.0;
    float r = length( p );

    vec2 q = p * 2.2 + uSeed;
    float t = uTime * 0.035;
    float n = fbm( q * 1.7 + vec2( t, -t * 0.6 ) );
    n += 0.35 * fbm( q * 3.4 - vec2( t * 0.7, t * 0.4 ) );

    // 城心留空、外圈渐浓；最外沿再淡出，免得平面自己露一条硬边
    float radial = smoothstep( 0.18, 0.62, r );
    float edge   = 1.0 - smoothstep( 0.86, 1.0, r );
    float density = radial * edge * ( 0.55 + 0.75 * n );

    float a = clamp( density * uStrength * ( 1.0 - uLayer * 0.28 ), 0.0, 0.46 );
    if ( a < 0.004 ) discard;

    // 噪声亮处当作被天光扫到的雾团，避免整片雾是死板的均匀灰蓝
    vec3 col = mix( uColor, vec3( 0.58, 0.76, 0.94 ), smoothstep( 0.55, 1.10, n ) * 0.42 );
    gl_FragColor = vec4( col, a );
  }
`;

/** 三层低空雾：高度 / 噪声种子 / 浓度 / 尺寸各自错开 */
const BANDS = [
  { z: 14, size: 6000, seed: 0.0, strength: 0.20, layer: 0.0 },
  { z: 42, size: 6600, seed: 3.7, strength: 0.15, layer: 0.5 },
  { z: 82, size: 7200, seed: 8.2, strength: 0.11, layer: 1.0 },
];

export class CityFog {
  constructor({ layer }) {
    this.layer = layer;
    this.sceneFog = new THREE.FogExp2(SCENE_FOG_COLOR, SCENE_FOG_DENSITY);
    this.handles = [];
    this.materials = [];
    this._clock = { value: 0 };
    this._running = false;
  }

  _applySceneFog() {
    const scene = this.layer.scene;
    if (scene) scene.fog = this.sceneFog;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._applySceneFog();

    const group = new THREE.Group();
    for (const b of BANDS) {
      const geo = new THREE.PlaneGeometry(b.size, b.size);
      const uniforms = {
        uTime: this._clock,                 // 与其余层共享同一个 {value}
        uSeed: { value: b.seed },
        uLayer: { value: b.layer },
        uStrength: { value: b.strength },
        uColor: { value: new THREE.Color(BAND_COLOR) },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = b.z;
      mesh.renderOrder = 2 + b.layer;
      mesh.frustumCulled = false;
      group.add(mesh);
      this.materials.push({ geo, mat, base: b.strength });
    }

    // 一条覆盖物管住整组：底座每帧回调，不必自己再开 rAF / triggerRepaint
    this.handles.push(this.layer.overlay.add({
      anchor: { lng: CITY.center[0], lat: CITY.center[1], altitude: 0 },
      object: group,
      depth: 'occluded',
      update: ({ t }) => {
        this._clock.value = t;
        // context restore 之后 viewer 会重建 Scene，fog 要补挂
        if (this.layer.scene?.fog !== this.sceneFog) this._applySceneFog();
      },
      onRemove: () => {
        for (const { geo, mat } of this.materials) { geo.dispose(); mat.dispose(); }
      },
    }));
  }

  /** 控制台实时调：__city.fog.setDensity(0.0005) / setStrength(0.3) */
  setDensity(d) {
    this.sceneFog.density = Math.max(0, Math.min(0.002, d));
    this._applySceneFog();
  }

  /** 倍率而非增量：连调两次不会连乘 */
  setStrength(scale) {
    const s = Math.max(0, Math.min(3, scale));
    for (const { mat, base } of this.materials) mat.uniforms.uStrength.value = base * s;
    for (const h of this.handles) h.requestRepaint();
  }

  dispose() {
    this._running = false;
    for (const h of this.handles) h.remove();
    this.handles = [];
    this.materials = [];
    if (this.layer.scene?.fog === this.sceneFog) this.layer.scene.fog = null;
  }
}
