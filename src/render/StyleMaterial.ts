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
  TOP_SIDE: 7, // 顶面/侧面分色：顶面一种颜色，侧面另一种颜色
  CUSTOM: 8, // 自定义/复合着色：顶面分色 + 侧面高度渐变
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
  [STYLE.TOP_SIDE]: '顶/侧分色',
  [STYLE.CUSTOM]: '自定义',
};

/** 选中单体的高亮模式 */
export const SELECT_MODE = {
  /** 纯色覆盖（经典白模 / 纯色高亮） */
  REPLACE: 'replace',
  /** 叠加在原图上（半透明混合，保留原模型贴图与门窗细节） */
  OVERLAY: 'overlay',
  /** 叠乘模式（与原模型贴图乘算，明暗对比强烈） */
  MULTIPLY: 'multiply',
  /** 仅描边与自发光（原图本体不染色） */
  GLOW_ONLY: 'glowOnly',
} as const;

export type SelectMode = (typeof SELECT_MODE)[keyof typeof SELECT_MODE];

export const SELECT_MODE_LABELS: Record<SelectMode, string> = {
  [SELECT_MODE.OVERLAY]: '叠加原图 (Overlay)',
  [SELECT_MODE.REPLACE]: '纯色覆盖 (Replace)',
  [SELECT_MODE.MULTIPLY]: '叠乘模式 (Multiply)',
  [SELECT_MODE.GLOW_ONLY]: '仅描边发光 (Glow)',
};

export interface StyledMaterial extends THREE.MeshStandardMaterial {
  userData: {
    uSelBatch: { value: number };
    uSelWhole: { value: number };
    uBatchTex: { value: THREE.Texture };
    uBatchTexWidth: { value: number };
    uBatchTexActive: { value: number };
    isStyled: true;
    [key: string]: unknown;
  };
}

const DUMMY_DATA = new Float32Array([-1, -1, -1, 0]);
export const DUMMY_BATCH_TEX = new THREE.DataTexture(DUMMY_DATA, 1, 1, THREE.RGBAFormat, THREE.FloatType);
DUMMY_BATCH_TEX.minFilter = THREE.NearestFilter;
DUMMY_BATCH_TEX.magFilter = THREE.NearestFilter;
DUMMY_BATCH_TEX.needsUpdate = true;

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
    /** 0 = 不压暗其他建筑；1 = 选中时其余建筑压暗 */
    uDim: { value: 0 },
    /** 其余建筑压暗系数（默认 0.42） */
    uDimFactor: { value: 0.42 },
    /** 选中单体的高亮色 */
    uSelColor: { value: new THREE.Color('#22d3ee') },
    /** 高亮强度，0 表示不做选中着色 */
    uSelMix: { value: 0 },
    /** 选中高亮混合模式：0 = 纯色覆盖, 1 = 叠加原图(mix), 2 = 叠乘(multiply), 3 = 仅描边发光(glowOnly) */
    uSelMode: { value: 1 },
    /** 选中高亮叠色强度 / 透明度（0~1，默认 0.65） */
    uSelOpacity: { value: 0.65 },
    /** 选中自发光强度（0~1，默认 0.35） */
    uSelEmissive: { value: 0.35 },
    /** 选中单体垂直拔高高度（米，默认 0） */
    uSelElevation: { value: 0 },
    /** 高度过滤下界 */
    uFilterMinZ: { value: -99999 },
    /** 高度过滤上界 */
    uFilterMaxZ: { value: 99999 },
    /** 是否启用高度过滤 */
    uFilterHeightActive: { value: 0 },
    /** 顶面法线判定阈值：Z 分量余弦大于该值判定为顶面 */
    uRoofThreshold: { value: 0.65 },
    /** 与模型原色贴图混合强度：0 = 纯色覆盖，1 = 叠乘原色贴图 */
    uTexMix: { value: 0 },
  };
}

const VERT_PARS = /* glsl */ `
  attribute float aBatchId;
  attribute vec3 aColor;
  uniform float uSelBatch;
  uniform float uSelWhole;
  uniform float uSelElevation;
  uniform sampler2D uBatchTex;
  uniform float uBatchTexWidth;
  uniform int uBatchTexActive;
  varying float vBatchId;
  varying vec3 vVertColor;
  varying float vWorldZ;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
`;

const VERT_ELEVATION = /* glsl */ `
  float s3mCustomElev = 0.0;
  if ( uBatchTexActive > 0 && aBatchId >= 0.0 ) {
    vec4 bState = texture2D( uBatchTex, vec2( ( aBatchId + 0.5 ) / uBatchTexWidth, 0.5 ) );
    if ( bState.a < -0.5 ) {
      transformed = vec3( 0.0 );
    } else if ( bState.a > 0.0 ) {
      s3mCustomElev = bState.a;
    }
  }

  float s3mSelElev = max( step( 0.0, uSelBatch ) * step( abs( aBatchId - uSelBatch ), 0.5 ), uSelWhole );
  transformed.z += s3mSelElev * uSelElevation + s3mCustomElev;
`;

const VERT_WORLD = /* glsl */ `
  vec4 s3mWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    s3mWorld = instanceMatrix * s3mWorld;
  #endif
  s3mWorld = modelMatrix * s3mWorld;
  vWorldZ = s3mWorld.z;
  vWorldPos = s3mWorld.xyz;
  vBatchId = aBatchId;
  vVertColor = aColor;

  #ifdef USE_INSTANCING
    mat3 s3mNormMat = mat3( modelMatrix ) * mat3( instanceMatrix );
  #else
    mat3 s3mNormMat = mat3( modelMatrix );
  #endif
  vWorldNormal = normalize( s3mNormMat * normal );
`;

const FRAG_PARS = /* glsl */ `
  uniform int uMode;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform vec3 uSelColor;
  uniform int uSelMode;
  uniform float uSelOpacity;
  uniform float uSelEmissive;
  uniform float uDimFactor;
  uniform sampler2D uBatchTex;
  uniform float uBatchTexWidth;
  uniform int uBatchTexActive;
  uniform float uFilterMinZ;
  uniform float uFilterMaxZ;
  uniform int uFilterHeightActive;
  uniform float uTime;
  uniform float uHeightMin;
  uniform float uHeightMax;
  uniform float uFloorHeight;
  uniform float uDim;
  uniform float uSelMix;
  uniform float uSelBatch;
  uniform float uSelWhole;
  uniform float uRoofThreshold;
  uniform float uTexMix;
  varying float vBatchId;
  varying vec3 vVertColor;
  varying float vWorldZ;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

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

  // 法线：优先使用顶点插值法线；若退化或为平面着色，使用屏幕导数精确计算真实几何法线
  vec3 s3mNorm = length( vWorldNormal ) > 0.1 ? normalize( vWorldNormal ) : normalize( cross( dFdx( vWorldPos ), dFdy( vWorldPos ) ) );

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
  } else if ( uMode == 6 ) {
    // 动态扫描：底色按高度渐变，一条亮带自下而上循环
    float scan = fract( uTime * 0.18 );
    float glow = smoothstep( 0.10, 0.0, abs( s3mH - scan ) );
    diffuseColor.rgb = mix( uColorA, uColorB, s3mH ) + uColorC * glow * 1.2;
  } else if ( uMode == 7 ) {
    // 顶面/侧面分色：uColorA 为顶面（屋顶），uColorB 为侧面（立面）
    // 局部 ENU 坐标系以 Z 为朝天方向，abs(s3mNorm.z) 接近 1 为顶面/底面，接近 0 为立面
    float th = uRoofThreshold > 0.0 ? uRoofThreshold : 0.65;
    float isRoof = smoothstep( th - 0.08, th + 0.08, abs( s3mNorm.z ) );
    diffuseColor.rgb = mix( uColorB, uColorA, isRoof );
  } else {
    // 自定义复合模式：顶面使用 uColorA，侧面叠加高度渐变（uColorB 到 uColorC）
    float th = uRoofThreshold > 0.0 ? uRoofThreshold : 0.65;
    float isRoof = smoothstep( th - 0.08, th + 0.08, abs( s3mNorm.z ) );
    vec3 sideGrad = mix( uColorB, uColorC, s3mH );
    diffuseColor.rgb = mix( sideGrad, uColorA, isRoof );
  }

  // 叠加在原色贴图上：保留窗框、玻璃幕墙、材质纹理与顶点色
  if ( uMode != 1 && uTexMix > 0.001 ) {
    vec3 origTex = s3mBase * vVertColor;
    vec3 overlay = origTex * diffuseColor.rgb * 1.35;
    diffuseColor.rgb = mix( diffuseColor.rgb, overlay, uTexMix );
  }

  // 1. 高度范围过滤
  if ( uFilterHeightActive > 0 ) {
    if ( vWorldZ < uFilterMinZ || vWorldZ > uFilterMaxZ ) discard;
  }

  // 2. 单体状态过滤（隐藏）与单体独立改色
  bool hasCustomColor = false;
  if ( uBatchTexActive > 0 && vBatchId >= 0.0 ) {
    vec4 bState = texture2D( uBatchTex, vec2( ( vBatchId + 0.5 ) / uBatchTexWidth, 0.5 ) );
    if ( bState.a < -0.5 ) {
      discard; // 属于被过滤隐藏的单体
    }
    if ( bState.r >= 0.0 ) {
      // 单体独立自定义颜色
      diffuseColor.rgb = bState.rgb;
      hasCustomColor = true;
    }
  }

  // 3. 选中单体高亮 + 其余压暗
  float s3mSel = max( step( 0.0, uSelBatch ) * step( abs( vBatchId - uSelBatch ), 0.5 ), uSelWhole );
  if ( s3mSel > 0.5 && uSelMix > 0.001 ) {
    if ( hasCustomColor ) {
      // 若当前建筑已有用户固定的独立颜色，选中时保留该颜色，仅做轻微高亮叠色提示
      if ( uSelMode == 0 || uSelMode == 1 ) {
        diffuseColor.rgb = mix( diffuseColor.rgb, uSelColor, uSelOpacity * 0.35 );
      }
    } else {
      if ( uSelMode == 0 ) {
        // 纯色覆盖（经典纯高亮色）
        diffuseColor.rgb = uSelColor;
      } else if ( uSelMode == 1 ) {
        // 叠加原图（半透明混色，保留纹理贴图）
        diffuseColor.rgb = mix( diffuseColor.rgb, uSelColor, uSelOpacity );
      } else if ( uSelMode == 2 ) {
        // 叠乘模式（明暗对比强）
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uSelColor * 1.5, uSelOpacity );
      }
    }
    // uSelMode == 3 为 glowOnly，保持 diffuseColor.rgb 不变
  } else {
    diffuseColor.rgb *= mix( 1.0, uDimFactor, uDim );
  }
`;

const FRAG_EMISSIVE = /* glsl */ `
  float s3mSelE = max( step( 0.0, uSelBatch ) * step( abs( vBatchId - uSelBatch ), 0.5 ), uSelWhole );
  // glowOnly 模式下表面不自发光，只保留描边边框；其他模式下适度发光
  if ( uSelMode != 3 ) {
    totalEmissiveRadiance += uSelColor * s3mSelE * uSelMix * ( uSelEmissive * 0.4 );
  }
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
  const uBatchTex = { value: DUMMY_BATCH_TEX };
  const uBatchTexWidth = { value: 1.0 };
  const uBatchTexActive = { value: 0 };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uSelBatch,
      uSelWhole,
      uBatchTex,
      uBatchTexWidth,
      uBatchTexActive,
    });

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_ELEVATION}`)
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
  mat.userData.uBatchTex = uBatchTex;
  mat.userData.uBatchTexWidth = uBatchTexWidth;
  mat.userData.uBatchTexActive = uBatchTexActive;
  mat.userData.isStyled = true;
  return mat;
}

/* ------------------------------------------------------------------ 选中描边 */

const OUTLINE_VERT = /* glsl */ `
  attribute float aBatchId;
  uniform float uSelBatch;
  uniform float uSelWhole;
  uniform float uWidth;
  uniform float uElevation;
  uniform sampler2D uBatchTex;
  uniform float uBatchTexWidth;
  uniform int uBatchTexActive;
  varying float vSel;
  void main() {
    vSel = max( step( 0.0, uSelBatch ) * step( abs( aBatchId - uSelBatch ), 0.5 ), uSelWhole );
    float s3mCustomElev = 0.0;
    if ( uBatchTexActive > 0 && aBatchId >= 0.0 ) {
      vec4 bState = texture2D( uBatchTex, vec2( ( aBatchId + 0.5 ) / uBatchTexWidth, 0.5 ) );
      if ( bState.a < -0.5 ) {
        vSel = 0.0; // 过滤隐藏的单体不显示描边
      } else if ( bState.a > 0.0 ) {
        s3mCustomElev = bState.a;
      }
    }
    vec3 p = position + normal * uWidth * vSel;
    p.z += vSel * ( uElevation + s3mCustomElev );
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
    uSelWhole: { value: number };
    uWidth: { value: number };
    uElevation: { value: number };
    uBatchTex: { value: THREE.Texture };
    uBatchTexWidth: { value: number };
    uBatchTexActive: { value: number };
    uColor: { value: THREE.Color };
  };
}

/** 选中单体的描边材质（背面外扩法） */
export function createOutlineMaterial(shared: StyleUniforms, initialWidth = 0.9): OutlineMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSelBatch: { value: -1 },
      uSelWhole: { value: 0 },
      uWidth: { value: initialWidth },
      uElevation: { value: 0 },
      uBatchTex: { value: DUMMY_BATCH_TEX },
      uBatchTexWidth: { value: 1.0 },
      uBatchTexActive: { value: 0 },
      uColor: { value: shared.uSelColor.value.clone() },
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
