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
import { DEFAULT_FLOOR_HEIGHT } from '../core/FeatureInfo.js';

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

/* ------------------------------------------------------------------ 样式配置 */

/** 图层整体样式（宿主无关，S3MViewer 与 s3m-maplibre 的 S3MLayer 共用） */
export interface S3MStyle {
  /** 着色模式，见 STYLE */
  mode: StyleMode;
  /** 主色：白膜 / 单色 / 渐变起点 / 动态扫描底色 */
  colorA: string;
  /** 渐变终点 / 楼层高段色 */
  colorB: string;
  /** 动态扫描的高亮带颜色 */
  colorC: string;
  /** 选中单体的高亮色 */
  selectColor: string;
  /** 选中单体的高亮模式：'overlay' 叠加原图 | 'replace' 纯色覆盖 | 'multiply' 叠乘 | 'glowOnly' 仅描边发光 */
  selectMode?: SelectMode;
  /** 选中高亮叠色强度 / 透明度（0~1，默认 0.65） */
  selectOpacity?: number;
  /** 选中自发光强度（0~1，默认 0.35） */
  selectEmissive?: number;
  /** 选中单体垂直拔高高度（米，默认 0） */
  selectElevation?: number;
  /** 楼层估算层高（米） */
  floorHeight: number;
  /** 动态扫描速度倍率 */
  speed: number;
  /** 整体不透明度，< 1 时自动开启混合并关闭深度写入 */
  opacity: number;
  /** 'flat' 平面着色（白模更干净） | 'smooth' 平滑着色（倾斜摄影更自然） */
  shading: 'flat' | 'smooth';
  /** 选中单体时是否压暗其余建筑 */
  dimOthers: boolean;
  /** 未选中建筑压暗系数（0~1，默认 0.42） */
  dimFactor?: number;
  /** 是否给选中单体描边 */
  outline: boolean;
  /** 选中描边的画法：'edges' 单体棱线（默认）| 'hull' 背面外扩轮廓 */
  outlineStyle?: 'edges' | 'hull';
  /** 描边颜色（默认跟随 selectColor） */
  outlineColor?: string;
  /** 外扩轮廓的粗细（米，默认 0.9，仅 outlineStyle: 'hull' 生效） */
  outlineWidth?: number;
  /** 选中棱线的粗细（像素，默认 3，仅 outlineStyle: 'edges' 生效，缩放时保持恒定） */
  outlineWidthPx?: number;
  /** 是否显示几何棱线（CPU 端生成，有开销） */
  edges: boolean;
  /** 全局棱线粗细（像素，默认 1.2） */
  edgeWidth?: number;
  edgeColor: string;
  edgeOpacity?: number;
  roofThreshold?: number;
  /** 是否与模型原色贴图叠加混合（0 = 纯色覆盖，1 = 叠乘原色贴图） */
  texMix?: number;
  /** 半透明时是否保持深度写入（默认 true，保持写入可彻底遮挡背面与内部棱线，避免背面透出） */
  depthWrite?: boolean;
}

export const DEFAULT_STYLE: S3MStyle = {
  mode: STYLE.TEXTURE,
  colorA: '#dfe6ee',
  colorB: '#1d4ed8',
  colorC: '#fbbf24',
  selectColor: '#22d3ee',
  selectMode: SELECT_MODE.OVERLAY,
  selectOpacity: 0.65,
  selectEmissive: 0.35,
  selectElevation: 0,
  floorHeight: DEFAULT_FLOOR_HEIGHT,
  speed: 1,
  opacity: 1,
  shading: 'flat',
  dimOthers: true,
  dimFactor: 0.42,
  outline: true,
  outlineStyle: 'edges',
  outlineColor: '#22d3ee',
  outlineWidth: 0.9,
  outlineWidthPx: 3,
  edges: false,
  edgeWidth: 1.2,
  edgeColor: '#334155',
  edgeOpacity: 0.45,
  roofThreshold: 0.65,
  texMix: 0,
  depthWrite: true,
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

const DUMMY_DATA = new Float32Array([-1, -1, -1, 0, 0, 0, 0, 0]);
export const DUMMY_BATCH_TEX = new THREE.DataTexture(DUMMY_DATA, 1, 2, THREE.RGBAFormat, THREE.FloatType);
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
  #ifdef S3M_ATLAS
    attribute vec4 aAtlasRect;
    #ifdef S3M_ATLAS_SEC
      attribute vec4 aAtlasRect1;
      attribute vec2 aSecUv;
      varying vec2 vSecUv;
      varying vec4 vSecRect;
    #endif
    varying vec4 vAtlasRect;
  #endif
  // 实例化几何没有逐顶点 batchId：顶点是 base mesh 的，单体粒度落在实例上
  #ifdef USE_INSTANCING
    attribute float aInstanceBatchId;
  #endif
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

  /** 当前图元所属单体的控制位：实例化取实例属性，其余取逐顶点属性 */
  float s3mBatchRaw() {
    #ifdef USE_INSTANCING
      return aInstanceBatchId;
    #else
      return aBatchId;
    #endif
  }
`;

const VERT_ELEVATION = /* glsl */ `
  float s3mBatch = s3mBatchRaw();
  vec3 s3mCustomOffset = vec3( 0.0 );
  if ( uBatchTexActive > 0 && s3mBatch >= 0.0 ) {
    vec4 bState = texture2D( uBatchTex, vec2( ( s3mBatch + 0.5 ) / uBatchTexWidth, 0.25 ) );
    if ( bState.a < -0.5 ) {
      transformed = vec3( 0.0 );
    } else {
      vec4 bOffset = texture2D( uBatchTex, vec2( ( s3mBatch + 0.5 ) / uBatchTexWidth, 0.75 ) );
      s3mCustomOffset = bOffset.xyz;
      if ( s3mCustomOffset.z == 0.0 && bState.a > 0.0 ) {
        s3mCustomOffset.z = bState.a;
      }
    }
  }

  float s3mSelElev = max( step( 0.0, uSelBatch ) * step( abs( s3mBatch - uSelBatch ), 0.5 ), uSelWhole );
  // 实例化时这是局部坐标，实例矩阵只含平移 + 绕 z 旋转（白模摆位），所以偏移仍沿局部轴生效
  transformed += s3mCustomOffset;
  transformed.z += s3mSelElev * uSelElevation;
`;

const VERT_WORLD = /* glsl */ `
  vec4 s3mWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    s3mWorld = instanceMatrix * s3mWorld;
  #endif
  s3mWorld = modelMatrix * s3mWorld;
  vWorldZ = s3mWorld.z;
  vWorldPos = s3mWorld.xyz;
  vBatchId = s3mBatchRaw();
  vVertColor = aColor;

  #ifdef S3M_ATLAS
    vAtlasRect = aAtlasRect;
    #ifdef S3M_ATLAS_SEC
      vSecUv = aSecUv;
      vSecRect = aAtlasRect1;
    #endif
  #endif

  #ifdef USE_INSTANCING
    mat3 s3mNormMat = mat3( modelMatrix ) * mat3( instanceMatrix );
  #else
    mat3 s3mNormMat = mat3( modelMatrix );
  #endif
  vWorldNormal = normalize( s3mNormMat * normal );
`;

const FRAG_PARS = /* glsl */ `
  #ifdef S3M_ATLAS
    varying vec4 vAtlasRect;
    uniform vec2 uAtlasDim;
    #ifdef S3M_ATLAS_SEC
      uniform sampler2D uSecMap;
      uniform vec2 uAtlasDim1;
      varying vec2 vSecUv;
      varying vec4 vSecRect;
    #endif
    /**
     * S3MBLOCK 图集采样 —— 照抄官方 iClient3D 12.1.1 的片元实现
     * （着色器原文截获自 gl.shaderSource，存 _tmp/og/full.txt）。
     *
     * 官方 sampleLod 永远传 LOD 0，层级靠「把子区域 rect 平移 + 内缩」选出来；
     * 因此图集必须关掉 GPU mip（见 TextureFactory.configureAtlas），否则自动层级
     * 会把相邻子区域混进来。
     * 注：官方 width *= 2/3 只是算 maxMip 的收缩系数 —— 实测子区域右侧邻着的是
     * 另一张子纹理（1094_3 旁边是 1130_3），不是它的内联 mip，别照字面理解成 mip 链。
     */
    vec2 s3mBatchUV( vec2 uv, vec2 translate, vec2 scale, vec2 dim, float mip ) {
      vec2 t = translate;
      if ( mip > 0.0 ) {
        t.x = translate.x + scale.x;
        float temp = pow( 2.0, mip - 1.0 );
        t.y = translate.y + scale.y * ( temp - 1.0 ) / temp;
      }
      float texScale = 1.0 / pow( 2.0, mip );
      vec2 o = fract( uv );
      vec2 off = vec2( pow( 2.0, mip ) / dim.x, pow( 2.0, mip ) / dim.y );
      o = clamp( o, off, vec2( 1.0 ) - off );
      return o * texScale * scale + t;
    }
    /**
     * 图集采样（S3MBLOCK 共享纹理）。
     *
     * 公式照抄官方 SDK 的着色器（s3m-spec 仓库
     * S3M_SDK/S3M_JS/S3M_module/S3MTiles/Shaders/S3MTilesFS.js 里的
     * getTextureAtlasColor / calculateMipLevel）：fract 取平铺周期内的位置，
     * 再按子区域 rect 平移缩放进去。
     *
     * 与官方唯一的差异：官方把 width 乘 2.0 / 3.0，因为它的图集在精灵右侧
     * 三分之一内联了一整条 mip 链，采样 mip > 0 时会平移到那块区域。我们解出来的
     * 图集里没有这条内联链（放大单个槽位看不到逐级缩小的副本），一旦按官方
     * 公式采样 mip > 0，就会采到邻居槽位 —— 整面墙碎成拼贴。
     * 所以这里：精灵按 rect 的满宽取，mip 固定 0。
     */
    vec4 s3mAtlasUnit( vec2 uv, vec4 rect, vec2 atlasDim, sampler2D tex ) {
      // 退化矩形 = 官方 batchId < 0：该纹理单元不参与合成
      if ( rect.z <= 0.0 || rect.w <= 0.0 ) return vec4( 1.0 );
      vec2 dim = vec2( rect.z * atlasDim.x, rect.w * atlasDim.y );
      vec2 scale = dim / atlasDim;
      vec2 translate = rect.xy;
      return texture2D( tex, s3mBatchUV( uv, translate, scale, dim, 0.0 ) );
    }
  #endif
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

  /**
   * 取整后的 batchId。
   *
   * vBatchId 是 varying：GPU 按像素做透视校正插值，即便一个三角形三个顶点的
   * aBatchId 完全相等，三次乘加各自的舍入误差也不会正好抵消，结果会带
   * 1e-7 量级的相对误差，而且逐像素不同（不同 GPU / 驱动还不一样）。
   *
   * 这个误差本身无害，但后面的哈希是混沌放大器：p → fract(p*0.1031) →
   * p*(p+33.33) → p*2p，每一级都把误差放大几十倍，三级下来 1e-7 就能放大到 O(1)。
   * 实测 batchId≈4.2 万时，1e-7 的抖动会让哈希输出在 0.20~0.78 之间乱跳，
   * 直接表现为整屏彩色噪点。所以凡是要「按 id 取值」的地方都必须先取整。
   */
  float s3mBatchId() {
    return floor( vBatchId + 0.5 );
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
  // 所有按单体取值（配色 / 状态纹理 / 选中判定）都走取整后的 id，避免插值噪声
  float s3mBid = s3mBatchId();

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
    // 按单体：同一个 batchId 同色，相邻单体色相拉开（必须用取整后的 id，见 s3mBatchId）
    diffuseColor.rgb = s3mHsv( s3mHash( s3mBid * 7.31 + 1.0 ), 0.52, 0.95 );
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
  if ( uBatchTexActive > 0 && s3mBid >= 0.0 ) {
    // 用取整后的 id 采样：否则逐像素的插值误差会让纹素在边界上来回跳，同样出彩色噪点
    vec4 bState = texture2D( uBatchTex, vec2( ( s3mBid + 0.5 ) / uBatchTexWidth, 0.25 ) );
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
  float s3mSel = max( step( 0.0, uSelBatch ) * step( abs( s3mBid - uSelBatch ), 0.5 ), uSelWhole );
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
  float s3mSelE = max( step( 0.0, uSelBatch ) * step( abs( s3mBatchId() - uSelBatch ), 0.5 ), uSelWhole );
  // glowOnly 模式下表面不自发光，只保留描边边框；其他模式下适度发光
  if ( uSelMode != 3 ) {
    totalEmissiveRadiance += uSelColor * s3mSelE * uSelMix * ( uSelEmissive * 0.4 );
  }
`;

const FRAG_BAKE = /* glsl */ `
  #ifdef S3M_ATLAS_SEC
    // 官方 getTextureColorForS3M = firstColor(base) * secColor(bake)，
    // 两套独立的 rect / 尺寸（实测 base 11 条、bake 1 条，条数并不相同）
    diffuseColor *= s3mAtlasUnit( vSecUv, vSecRect, uAtlasDim1, uSecMap );
  #endif
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
  /** >0 时开启 alphaTest：镂空贴图（S3MBLOCK 图集）的透明片元直接丢弃，避免渲染成黑面 */
  alphaTest?: number;
  /** 贴图为 S3MBLOCK 图集：几何需带 aAtlasRect，平铺改由片元按子区域做 */
  atlas?: boolean;
  /** 图集材质的第二套纹理（官方 BakeTex，光照烘焙），与 base 相乘 */
  secMap?: THREE.Texture | null;
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
    alphaTest: opts.alphaTest ?? 0,
  }) as StyledMaterial;

  // 选中单体编号：每个 Mesh 独立，默认 -1 表示无选中
  const uSelBatch = { value: -1 };
  // 没有单体化信息的几何（batchId = -1）只能整块选中
  const uSelWhole = { value: 0 };
  const uBatchTex = { value: DUMMY_BATCH_TEX };
  const uBatchTexWidth = { value: 1.0 };
  const uBatchTexActive = { value: 0 };

  // 图集材质：只有几何确实带了 aAtlasRect 才开这个宏，否则缺属性会采到 (0,0) 的默认值
  const atlas = !!opts.atlas && !!opts.map;
  const secMap = atlas ? (opts.secMap ?? null) : null;
  if (atlas) mat.defines = { ...(mat.defines as Record<string, string>), S3M_ATLAS: '' };
  if (secMap) mat.defines = { ...mat.defines, S3M_ATLAS_SEC: '' };
  // 官方 uTextureDim = (base宽, base高, bake宽, bake高)，取实际绑定纹理的像素尺寸
  const uAtlasDim = { value: new THREE.Vector2(opts.map?.image?.width || 1, opts.map?.image?.height || 1) };
  const uAtlasDim1 = { value: new THREE.Vector2(secMap?.image?.width || 1, secMap?.image?.height || 1) };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uSelBatch,
      uSelWhole,
      uBatchTex,
      uBatchTexWidth,
      uBatchTexActive,
      uSecMap: { value: secMap },
      uAtlasDim,
      uAtlasDim1,
    });

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_ELEVATION}`)
      .replace('#include <worldpos_vertex>', VERT_WORLD);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);

    if (atlas) {
      // map_fragment 里是 `vec4 sampledDiffuseColor = texture2D( map, vMapUv );`
      shader.fragmentShader = shader.fragmentShader.replace(
        'texture2D( map, vMapUv )',
        's3mAtlasUnit( vMapUv, vAtlasRect, uAtlasDim, map )'
      );
    }
    if (secMap) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_BAKE}`);
    }
  };

  // 不同材质共用同一段注入代码，必须让 three 认为它们的 program 可复用；
  // 但图集 / 烘焙两套宏会改注入结果，必须进 cacheKey，否则会复用错 program。
  mat.customProgramCacheKey = () => `s3m-styled${atlas ? '-atlas' : ''}${secMap ? '-bake' : ''}`;

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
    vec3 s3mCustomOffset = vec3( 0.0 );
    if ( uBatchTexActive > 0 && aBatchId >= 0.0 ) {
      vec4 bState = texture2D( uBatchTex, vec2( ( aBatchId + 0.5 ) / uBatchTexWidth, 0.25 ) );
      if ( bState.a < -0.5 ) {
        vSel = 0.0; // 过滤隐藏的单体不显示描边
      } else {
        vec4 bOffset = texture2D( uBatchTex, vec2( ( aBatchId + 0.5 ) / uBatchTexWidth, 0.75 ) );
        s3mCustomOffset = bOffset.xyz;
        if ( s3mCustomOffset.z == 0.0 && bState.a > 0.0 ) {
          s3mCustomOffset.z = bState.a;
        }
      }
    }
    vec3 p = position + normal * uWidth * vSel;
    p += s3mCustomOffset;
    p.z += vSel * uElevation;
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
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }) as OutlineMaterial;
  (mat.userData as Record<string, unknown>).isOutline = true;
  return mat;
}
