/**
 * S3M 着色系统
 *
 * 设计要点：**不重建几何、不重建材质**，所有样式靠 uniform 在片元着色器里算。
 * 这样「白膜 → 按高度 → 动态扫描」之间切换只是改一个 int，几十万三角面零开销。
 *
 * uniform 分两类：
 *   shared —— 全局共享同一个对象引用，改一次全场景生效
 *   own    —— 每个 Mesh 独有（比如选中单体编号），避免互相干扰
 */
import * as THREE from 'three';
import type { StyleUniforms } from '../core/types.js';

/** 着色模式，数值与着色器里的 uMode 一一对应 */
export const STYLE = {
  WHITE: 0, // 白膜：忽略贴图与顶点色，纯色 + 光照
  TEXTURE: 1, // 原色：贴图 × 顶点色
  SOLID: 2, // 单色
  HEIGHT: 3, // 按高度连续渐变
  FLOORS: 4, // 按楼层离散分层（高度 / 3.2m 取整）
  BATCH: 5, // 按单体随机色，便于区分建筑
  DYNAMIC: 6, // 动态扫描：扫描线沿高度循环
} as const;

export type StyleMode = (typeof STYLE)[keyof typeof STYLE];

export const STYLE_LABELS: Record<StyleMode, string> = {
  [STYLE.WHITE]: '白膜',
  [STYLE.TEXTURE]: '原色',
  [STYLE.SOLID]: '单色',
  [STYLE.HEIGHT]: '按高度',
  [STYLE.FLOORS]: '按楼层',
  [STYLE.BATCH]: '按单体',
  [STYLE.DYNAMIC]: '动态扫描',
};

export interface StyledMaterial extends THREE.MeshStandardMaterial {
  userData: {
    uSelBatch: { value: number };
    uSelWhole: { value: number };
    isStyled: true;
    [key: string]: unknown;
  };
}

/** 全局共享 uniform（所有材质引用同一批对象，改 .value 即全场景生效） */
export function createSharedUniforms(): StyleUniforms {
  return {
    uMode: { value: STYLE.TEXTURE },
    uColorA: { value: new THREE.Color('#dfe6ee') },
    uColorB: { value: new THREE.Color('#1d4ed8') },
    uColorC: { value: new THREE.Color('#fbbf24') },
    uTime: { value: 0 },
    uHeightMin: { value: 0 },
    uHeightMax: { value: 120 },
    uFloorHeight: { value: 3.2 },
    /** 0 = 不压暗其他建筑；1 = 选中时其余建筑压到 42% */
    uDim: { value: 0 },
    /** 选中单体的高亮色 */
    uSelColor: { value: new THREE.Color('#22d3ee') },
    /** 高亮强度，0 表示不做选中着色 */
    uSelMix: { value: 0 },
  };
}

const VERT_PARS = /* glsl */ `
  attribute float aBatchId;
  attribute vec3 aColor;
  varying float vBatchId;
  varying vec3 vVertColor;
  varying float vWorldZ;
`;

const VERT_WORLD = /* glsl */ `
  vec4 s3mWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    s3mWorld = instanceMatrix * s3mWorld;
  #endif
  s3mWorld = modelMatrix * s3mWorld;
  vWorldZ = s3mWorld.z;
  vBatchId = aBatchId;
  vVertColor = aColor;
`;

const FRAG_PARS = /* glsl */ `
  uniform int uMode;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform vec3 uSelColor;
  uniform float uTime;
  uniform float uHeightMin;
  uniform float uHeightMax;
  uniform float uFloorHeight;
  uniform float uDim;
  uniform float uSelMix;
  uniform float uSelBatch;
  uniform float uSelWhole;
  varying float vBatchId;
  varying vec3 vVertColor;
  varying float vWorldZ;

  float s3mHash( float p ) {
    p = fract( p * 0.1031 );
    p *= p + 33.33;
    p *= p + p;
    return fract( p );
  }

  vec3 s3mHsv( float h, float s, float v ) {
    vec3 k = vec3( 1.0, 2.0 / 3.0, 1.0 / 3.0 );
    vec3 p = abs( fract( vec3( h ) + k.xyz ) * 6.0 - vec3( 3.0 ) );
    return v * mix( vec3( 1.0 ), clamp( p - vec3( 1.0 ), 0.0, 1.0 ), s );
  }
`;

const FRAG_COLOR = /* glsl */ `
  float s3mH = clamp( ( vWorldZ - uHeightMin ) / max( uHeightMax - uHeightMin, 0.001 ), 0.0, 1.0 );
  vec3 s3mBase = diffuseColor.rgb;   // 已含 diffuse × map

  if ( uMode == 0 ) {
    // 白膜：丢掉贴图，只留光照
    diffuseColor.rgb = uColorA;
  } else if ( uMode == 1 ) {
    // 原色：贴图 × 顶点色
    diffuseColor.rgb = s3mBase * vVertColor;
  } else if ( uMode == 2 ) {
    diffuseColor.rgb = uColorA;
  } else if ( uMode == 3 ) {
    // 按高度连续渐变
    diffuseColor.rgb = mix( uColorA, uColorB, s3mH );
  } else if ( uMode == 4 ) {
    // 按楼层：先算楼层数再归一化，形成分层色带
    float floors = floor( ( vWorldZ - uHeightMin ) / max( uFloorHeight, 0.5 ) );
    float total = max( floor( ( uHeightMax - uHeightMin ) / max( uFloorHeight, 0.5 ) ), 1.0 );
    diffuseColor.rgb = mix( uColorA, uColorB, floors / total );
  } else if ( uMode == 5 ) {
    // 按单体：同一个 batchId 同色，相邻单体色相拉开
    diffuseColor.rgb = s3mHsv( s3mHash( vBatchId * 7.31 + 1.0 ), 0.52, 0.95 );
  } else {
    // 动态扫描：底色按高度渐变，一条亮带自下而上循环
    float scan = fract( uTime * 0.18 );
    float glow = smoothstep( 0.10, 0.0, abs( s3mH - scan ) );
    diffuseColor.rgb = mix( uColorA, uColorB, s3mH ) + uColorC * glow * 1.2;
  }

  // 选中单体高亮 + 其余压暗
  float s3mSel = max( step( 0.0, uSelBatch ) * step( abs( vBatchId - uSelBatch ), 0.5 ), uSelWhole );
  diffuseColor.rgb = mix( diffuseColor.rgb, uSelColor, s3mSel * uSelMix );
  diffuseColor.rgb *= mix( 1.0, 0.42, uDim * ( 1.0 - s3mSel ) );
`;

const FRAG_EMISSIVE = /* glsl */ `
  float s3mSelE = max( step( 0.0, uSelBatch ) * step( abs( vBatchId - uSelBatch ), 0.5 ), uSelWhole );
  totalEmissiveRadiance += uSelColor * s3mSelE * uSelMix * 0.45;
`;

export interface StyledMaterialOptions {
  uniforms: StyleUniforms;
  map?: THREE.Texture | null;
  color?: THREE.Color;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  roughness?: number;
  flatShading?: boolean;
}

/**
 * 创建一个带样式的 PBR 材质。
 * 每个 Mesh 独享一个材质实例，但 uniform 对象是全局共享的。
 */
export function createStyledMaterial(opts: StyledMaterialOptions): StyledMaterial {
  const uniforms = opts.uniforms;
  const mat = new THREE.MeshStandardMaterial({
    color: opts.color ?? new THREE.Color(0xffffff),
    map: opts.map ?? null,
    roughness: opts.roughness ?? 0.95,
    metalness: 0,
    side: opts.side ?? THREE.DoubleSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.transparent ? false : true,
    // 白模 / OSGB 的法线多是共享顶点平均出来的，平滑插值会让墙面出现斑驳，
    // 默认走平面着色（片元里用导数算法线），墙面才干净。
    flatShading: opts.flatShading !== false,
    // 顶点色、贴图全部在自定义 chunk 里处理，不让 three 插手
    vertexColors: false,
  }) as StyledMaterial;

  // 选中单体编号：每个 Mesh 独立，默认 -1 表示无选中
  const uSelBatch = { value: -1 };
  // 没有单体化信息的几何（batchId = -1）只能整块选中
  const uSelWhole = { value: 0 };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uSelBatch, uSelWhole });

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <worldpos_vertex>', VERT_WORLD);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);
  };

  // 不同材质共用同一段注入代码，必须让 three 认为它们的 program 可复用
  mat.customProgramCacheKey = () => 's3m-styled';

  mat.userData.uSelBatch = uSelBatch;
  mat.userData.uSelWhole = uSelWhole;
  mat.userData.isStyled = true;
  return mat;
}

/* ------------------------------------------------------------------ 选中描边 */

const OUTLINE_VERT = /* glsl */ `
  attribute float aBatchId;
  uniform float uSelBatch;
  uniform float uWidth;
  varying float vSel;
  void main() {
    vSel = step( 0.0, uSelBatch ) * step( abs( aBatchId - uSelBatch ), 0.5 );
    // 沿法线外扩，背面渲染 → 形成一圈等宽描边
    vec3 p = position + normal * uWidth * vSel;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
  }
`;

const OUTLINE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vSel;
  void main() {
    if ( vSel < 0.5 ) discard;
    gl_FragColor = vec4( uColor, 1.0 );
  }
`;

export interface OutlineMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uSelBatch: { value: number };
    uWidth: { value: number };
    uColor: { value: THREE.Color };
  };
}

/** 选中单体的描边材质（背面外扩法） */
export function createOutlineMaterial(shared: StyleUniforms): OutlineMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSelBatch: { value: -1 },
      uWidth: { value: 0.9 },
      uColor: shared.uSelColor,
    },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    transparent: false,
    // 描边要压在建筑后面一点，避免和本体 z-fighting
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  }) as OutlineMaterial;
  (mat.userData as Record<string, unknown>).isOutline = true;
  return mat;
}
