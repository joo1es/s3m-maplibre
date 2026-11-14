/**
 * 特效层：把「库能做出来什么」集中摆在这里。
 *
 * 现成的四件套直接复用 site/src/examples（它们本来就是给使用者抄的用法说明）：
 *   glow-cube        发光线框边界盒（4 draw call、HDR 芯 + 三层色散光晕 + 地面光池）
 *   flow-line        三维飞线（buildThickLineGeometry + 片元注入流光拖尾）
 *   range-canopy     范围光柱
 *   post-presenter   接管上屏的亮部提取辉光
 * 另外自己写一层地面扫描波，配合「限高生长」当唤醒城市的涟漪。
 *
 * 场景是 Z-up：PlaneGeometry 的法线朝 +Z，天然就是水平的地面，不用绕 X 转。
 */
import * as THREE from 'three';
import { addGlowCube } from '../../site/src/examples/glow-cube.ts';
import { addFlowLine } from '../../site/src/examples/flow-line.ts';
import { clearFlowAnim } from '../../site/src/examples/flow-line.ts';
import { addRangeCanopy } from '../../site/src/examples/range-canopy.ts';
import { createPostPresenter } from '../../site/src/examples/post-presenter.ts';
import { CITY, THEME } from './config.js';

/* ------------------------------------------------------------ 地面扫描波 */

const SCAN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

/**
 * 平方一律写 x*x：GLSL 的 pow(x, 2.0) 在 x<0 时是未定义行为，会吐 NaN；
 * additive 混合下只要一个分量是 NaN，整片像素就变黑（glow-cube 里踩过这个坑）。
 */
const SCAN_FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uProgress;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    vec2  p    = ( vUv - 0.5 ) * 2.0;
    float r    = length( p );
    float fade = smoothstep( 1.02, 0.30, r );

    float q    = ( r - uProgress ) * 26.0;
    float ring = exp( -q * q );

    float a = ( r - fract( uProgress * 0.72 ) ) * 34.0;
    float b = ( r - fract( uProgress * 0.45 ) ) * 42.0;
    float ripple = exp( -a * a ) * 0.34 + exp( -b * b ) * 0.20;

    float ang    = atan( p.y, p.x );
    float spokes = pow( max( 0.0, sin( ang * 16.0 + uTime * 0.55 ) ), 10.0 ) * 0.10;

    vec2  g    = abs( fract( vUv * 36.0 ) - 0.5 );
    float grid = smoothstep( 0.47, 0.5, max( g.x, g.y ) ) * 0.05;

    float e = ring * 1.15 + ripple + spokes + grid;
    vec3 rgb = mix( uColor, vec3( 1.0 ), min( ring * 0.75, 1.0 ) ) * e * uOpacity * fade;
    if ( !( rgb.r >= 0.0 && rgb.g >= 0.0 && rgb.b >= 0.0 ) ) discard;
    if ( max( rgb.r, max( rgb.g, rgb.b ) ) < 0.003 ) discard;
    gl_FragColor = vec4( rgb, 1.0 );
  }
`;

/** 城市外围 → 核心的六条数据链路起点 */
const FLOW_SOURCES = [
  { at: [116.4449, 39.9034], color: '#4ad8ff', speed: 0.34 },
  { at: [116.4709, 39.9048], color: '#8fe8ff', speed: 0.29 },
  { at: [116.4706, 39.9206], color: '#ffc86b', speed: 0.38 },
  { at: [116.4454, 39.9204], color: '#ff79c6', speed: 0.31 },
  { at: [116.4432, 39.9122], color: '#5ce6b0', speed: 0.42 },
  { at: [116.4716, 39.9146], color: '#7ea8ff', speed: 0.36 },
];

/** 三个重点片区的位置与高度 */
const BEACONS = [
  { at: [116.4562, 39.9108], radius: 78, height: 250, color: THEME.cyan },
  { at: [116.4624, 39.9152], radius: 62, height: 320, color: THEME.gold },
  { at: [116.4528, 39.9161], radius: 54, height: 210, color: THEME.magenta },
];

export class Effects {
  constructor(layer) {
    this.layer = layer;
    this.scan = null;
    this.glowCube = null;
    this.flows = [];
    this.beacons = [];
    this.bloom = null;
  }

  /* ---------------------------------------------------------- 地面扫描波 */

  addScanWave() {
    if (this.scan) return this.scan;
    const layer = this.layer;
    const geo = new THREE.PlaneGeometry(3200, 3200);
    const uniforms = {
      uColor: { value: new THREE.Color(THEME.cyan) },
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uOpacity: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SCAN_VERT,
      fragmentShader: SCAN_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = 1.6; // 抬离地表，避开与地面数据集的 z-fighting
    mesh.frustumCulled = false;

    const handle = layer.overlay.add({
      anchor: { lng: CITY.center[0], lat: CITY.center[1], altitude: 0 },
      object: mesh,
      depth: 'occluded',
      update: ({ t }) => { uniforms.uTime.value = t; },
      onRemove: () => { geo.dispose(); mat.dispose(); },
    });

    this.scan = {
      handle,
      setProgress: (p) => { uniforms.uProgress.value = p; handle.requestRepaint(); },
      setOpacity: (v) => { uniforms.uOpacity.value = v; handle.requestRepaint(); },
    };
    return this.scan;
  }

  removeScanWave() {
    this.scan?.handle.remove();
    this.scan = null;
  }

  /* ---------------------------------------------------------- 发光线框边界盒 */

  addCube() {
    if (this.glowCube) return this.glowCube;
    this.glowCube = addGlowCube(this.layer, {
      height: 420,
      color: THEME.cyan,
      glow: 0.62,
      haloWidth: 18,
      coreWidth: 3.2,
      speed: 0.11,
      chroma: 0.78,
      pool: true,
      shell: true,
    });
    return this.glowCube;
  }

  removeCube() {
    this.glowCube?.handle.remove();
    this.glowCube = null;
  }

  /* ---------------------------------------------------------- 飞线 / 光柱 */

  addFlows() {
    if (this.flows.length) return;
    const target = [CITY.center[0] + 0.0006, CITY.center[1] + 0.0004, 150];
    for (const s of FLOW_SOURCES) {
      this.flows.push(
        addFlowLine(this.layer, [s.at[0], s.at[1], 8], target, {
          color: s.color,
          width: 3.6,
          lift: 210 + Math.random() * 90,
          speed: s.speed,
          trail: 0.32,
          steps: 72,
          fadeIn: true,
        })
      );
    }
  }

  removeFlows() {
    if (!this.flows.length) return;
    for (const h of this.flows) h.remove();
    this.flows = [];
    // 只有真的注册过渐入通道才去回收；clearAll 在首帧之前也会调到这里，
    // 那时 viewer 可能还没初始化
    clearFlowAnim(this.layer);
  }

  addBeacons() {
    if (this.beacons.length) return;
    for (const b of BEACONS) {
      this.beacons.push(
        addRangeCanopy(this.layer, [b.at[0], b.at[1], 0], {
          radius: b.radius,
          height: b.height,
          shape: 'cylinder',
          color: b.color,
          opacity: 0.13,
        })
      );
    }
  }

  removeBeacons() {
    for (const h of this.beacons) h.remove();
    this.beacons = [];
  }

  /* ---------------------------------------------------------- 辉光后处理 */

  enableBloom() {
    if (this.bloom) return;
    // 阈值按线性空间的绝对亮度给：白天建筑立面常在 0.2~0.5，0.32 能留下一部分高光
    this.bloom = createPostPresenter(this.layer, {
      mode: 'glow',
      radius: 11,
      strength: 1.45,
      threshold: 0.32,
    });
    this.layer.setPresenter(this.bloom.presenter);
  }

  disableBloom() {
    if (!this.bloom) return;
    this.layer.setPresenter(null);
    this.bloom.dispose();
    this.bloom = null;
  }

  /** 演出重播 / 页面销毁：所有覆盖物与接管都还回去 */
  clearAll() {
    this.removeFlows();
    this.removeBeacons();
    this.removeCube();
    this.removeScanWave();
    this.disableBloom();
    this.layer.setMotionBlur(null);
  }
}
