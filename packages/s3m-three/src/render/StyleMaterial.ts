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
import { GPUPathManager } from './GPUPathManager.js';

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

/* ------------------------------------------------------------------ 棱线画法 */

/**
 * 全局棱线的画法。
 *
 * - `'line'`   CPU 折边线：焊合 → 折边判定 → 屏幕空间等宽四边形（默认口径）
 * - `'offset'` 同上，但整段沿「边法线」往外推 `edgeOffset` 米。贴在面上的线会被
 *              面的明暗吃掉，推出去一点才看得清，代价是要多带一条 aNormal 属性
 * - `'hull'`   背面外扩轮廓：把整块几何沿法线鼓一圈、只画背面，得到「白模 + 卡通
 *              描边」的观感。不建任何折边几何，成本就是多画一遍网格
 * - `'gpu'`    纯片元描边：在主材质里用屏幕导数找「法线突变」的像素，直接混成棱线色。
 *              零几何、零额外 pass，代价是线宽约 1 个设备像素，且描不出几何外轮廓
 */
export type EdgeStyle = 'line' | 'offset' | 'hull' | 'gpu';

/**
 * `style.edges` 的取值。
 *
 * boolean 是旧口径（`true` = `'line'`），字符串 / 数组用来选画法，数组可叠加，
 * 例如 `['line', 'hull']` = 折边线 + 外扩轮廓同时上。
 * 注意 `'offset'` 隐含折边线：外推是折边线的修饰，不是另一种线。
 */
export type EdgesOption = boolean | EdgeStyle | EdgeStyle[];

/** 归一化后的棱线开关 */
export interface EdgeModes {
  /** 整体开关：任一画法命中就是 true */
  enabled: boolean;
  /** 是否建 CPU 折边线 */
  line: boolean;
  /** 折边线是否沿边法线外推 */
  offset: boolean;
  /** 是否挂背面外扩轮廓 */
  hull: boolean;
  /** 是否在材质里做片元级描边（零几何） */
  gpu: boolean;
}

const EDGE_MODE_OFF: EdgeModes = { enabled: false, line: false, offset: false, hull: false, gpu: false };

/**
 * 把 `EdgesOption` 归一成四个开关。
 *
 * 未知值（宿主 JS 里传错字符串 / 脏数组）一律当关，不抛错也不误开——样式这种东西
 * 出错时最该做的是「保持不动」，而不是把整个图层带崩。
 */
export function resolveEdgeModes(value: EdgesOption | null | undefined): EdgeModes {
  if (value == null || value === false) return { ...EDGE_MODE_OFF };
  if (value === true) return { ...EDGE_MODE_OFF, enabled: true, line: true };

  const list = Array.isArray(value) ? value : [value];
  const modes: EdgeModes = { ...EDGE_MODE_OFF };
  for (const item of list) {
    if (item === 'line') modes.line = true;
    else if (item === 'offset') {
      modes.line = true;
      modes.offset = true;
    } else if (item === 'hull') modes.hull = true;
    else if (item === 'gpu') modes.gpu = true;
  }
  modes.enabled = modes.line || modes.hull || modes.gpu;
  return modes;
}

/** 两套开关是否等价（只比较有效位，用来判断要不要重建装饰） */
export function sameEdgeModes(a: EdgeModes, b: EdgeModes): boolean {
  return a.line === b.line && a.offset === b.offset && a.hull === b.hull && a.gpu === b.gpu;
}

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
  /**
   * 是否显示几何棱线。
   *
   * 取值是 `boolean | EdgeStyle | EdgeStyle[]`：`true` 等价于 `'line'`（旧口径），
   * `'hull'` 走背面外扩轮廓，`'offset'` 是折边线 + 法线外推，数组可叠加。
   * 见 `resolveEdgeModes`。
   */
  edges: EdgesOption;
  /** 全局棱线粗细（像素，默认 1.2） */
  edgeWidth?: number;
  edgeColor: string;
  edgeOpacity?: number;
  /** 棱线临界角（度）：相邻面法线夹角超过该值才描边，过滤掉浅坡与曲面细分。默认 55° */
  edgeThreshold?: number;
  /** 折边线沿边法线外推的距离（米，默认 0.15，仅 edges 含 'offset' 生效） */
  edgeOffset?: number;
  /** 背面外扩轮廓的厚度（米，默认 0.9，仅 edges 含 'hull' 生效） */
  edgeHullWidth?: number;
  /**
   * 忽略数据自带的棱线包（primitiveType 13），一律 CPU 现算。默认 false。
   *
   * 数据自带的棱线是 `LineBasicMaterial`，线宽恒 1px，`edgeWidth` / 外扩 / 单体跟随
   * 全都吃不上。想让这些能力对所有数据统一生效就打开它，代价是 CPU 要现算折边。
   */
  forceCpuEdges?: boolean;
  roofThreshold?: number;
  /** 是否与模型原色贴图叠加混合（0 = 纯色覆盖，1 = 叠乘原色贴图） */
  texMix?: number;
  /**
   * 基础漫反射底色增益 / 直通自发光微调（0~1，默认 0.0，建议开启 TOP_SIDE 时可设 0.15~0.3）。
   * 绕过光照夹角直接补偿表面暗部底色，让 TOP_SIDE / 自定义等模式下的背光阴影面保持通透、不至于过黑。
   */
  ambientGain?: number;
  /** 半透明时是否保持深度写入（默认 true，保持写入可彻底遮挡背面与内部棱线，避免背面透出） */
  depthWrite?: boolean;
  /**
   * 新瓦片首次出现时的淡入时长（毫秒，0 = 关闭）。
   *
   * 只影响「刚加载进来」的瓦片，已经显示的不会被重播。LOD 细化换瓦片时也会淡入，
   * 视觉上比「啪」一下换掉柔和得多。
   *
   * 注意代价：淡入期间该瓦片会进透明渲染队列（混合 + 前后排序），首次加载
   * 几百块瓦片同时淡入时会有一小段额外开销，所以默认关闭、按需开启。
   */
  fadeIn?: number;
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
  edgeWidth: 1.5,
  edgeColor: '#334155',
  edgeOpacity: 0.6,
  edgeThreshold: 55,
  edgeOffset: 0.15,
  edgeHullWidth: 0.9,
  forceCpuEdges: false,
  roofThreshold: 0.65,
  texMix: 0,
  ambientGain: 0,
  depthWrite: true,
  fadeIn: 0,
};

/** 光照模型：pbr（默认，MeshStandardMaterial）| lambert（省 GGX 与环境球谐） */
export type MaterialQuality = 'pbr' | 'lambert';

/**
 * 当前光照模型。模块级全局 —— 与 anisotropy / maxTextureSize 同一套设计，
 * 同页多个图层会互相覆盖，后创建的那个决定全局。只影响**之后创建**的材质。
 */
let materialQuality: MaterialQuality = 'pbr';

/**
 * 切换光照模型。
 *
 * 'pbr'（默认）= `MeshStandardMaterial`，GGX + 环境球谐，质感最好也最贵。
 * 'lambert' = `MeshLambertMaterial`，只保留漫反射 + 平行光，片元开销约省一半；
 * 白模 / 纯色 / 按高度着色这类不需要高光的模式，肉眼差别很小。
 *
 * 注意：只影响之后创建的材质 —— 已加载的瓦片要重新加载才会换。
 */
export function setMaterialQuality(q: MaterialQuality): void {
  materialQuality = q === 'lambert' ? 'lambert' : 'pbr';
}

export function getMaterialQuality(): MaterialQuality {
  return materialQuality;
}

export type StyledMaterial = (THREE.MeshStandardMaterial | THREE.MeshLambertMaterial) & {
  userData: {
    uSelBatch: { value: number };
    uSelWhole: { value: number };
    uBatchTex: { value: THREE.Texture };
    uBatchTex2: { value: THREE.Texture };
    uBatchTexWidth: { value: number };
    uBatchTexActive: { value: number };
    /** 单块瓦片的淡入系数（1 = 完全显示） */
    uTileFade: { value: number };
    isStyled: true;
    [key: string]: unknown;
  };
}

const DUMMY_DATA = new Float32Array([
  -1, -1, -1, 0, // Row 0: color rgb, elevation/hidden
  0, 0, 0, 0,    // Row 1: translation xyz, opacity
  1, 0, 0, 0,    // Row 2: rot row 0, pivot.x
  0, 1, 0, 0,    // Row 3: rot row 1, pivot.y
  0, 0, 1, 0,    // Row 4: rot row 2, pivot.z
  -1, 0, 0, 0,   // Row 5: pathId (-1=none), speed, phase, modeFlag
]);
export const DUMMY_BATCH_TEX = new THREE.DataTexture(DUMMY_DATA, 1, 6, THREE.RGBAFormat, THREE.FloatType);
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
    /** 基础底色增益 / 暗部补偿（0~1，默认 0.0） */
    uAmbientGain: { value: 0 },
    /** 双纹理交叉淡化插值系数（0 = 纯 uBatchTex, 1 = 纯 uBatchTex2） */
    uBatchMix: { value: 0 },
    /** GPU 路径数据采样纹理 */
    uPathTex: { value: GPUPathManager.DUMMY_PATH_TEX },
    /** GPU 路径纹理中包含的路径条数（高度） */
    uPathCount: { value: 1 },
    /** 是否激活 GPU 路径动画（0 = 未激活，1 = 激活） */
    uPathTexActive: { value: 0 },
    /** GPU 路径时间戳（秒） */
    uPathTime: { value: 0 },
    /**
     * 图层整体透明度：在片元里乘进 diffuseColor.a。
     *
     * 为什么不做成 `material.opacity`：那是逐材质写入，几百块瓦片就是 O(meshes)，
     * 而且跨 0.999 改 `material.transparent` 会换 program（`opaque` 参与缓存键）。
     * 放到共享 uniform 里，透明度动画就退化成一次 float 赋值。
     */
    uOpacity: { value: 1 },
    /** 棱线淡入淡出乘子：setEdges 过渡期间 0→1，新插入的瓦片自动继承 */
    uEdgeFade: { value: 1 },
    /**
     * 整体压暗乘子：`mode` 这类不可插值的切换用它做 fade-through
     * （压暗 → 换模式 → 亮回来），比硬切自然得多。
     */
    uFade: { value: 1 },
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
  uniform sampler2D uBatchTex2;
  uniform float uBatchMix;
  uniform float uBatchTexWidth;
  uniform int uBatchTexActive;
  uniform sampler2D uPathTex;
  uniform float uPathCount;
  uniform float uPathTime;
  uniform int uPathTexActive;
  varying float vBatchId;
  varying vec3 vVertColor;
  varying float vWorldZ;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  // 跨 chunk 共享的顶点姿态变量（在 beginnormal_vertex 建立，begin_vertex / worldpos 使用）
  vec3 s3mCustomOffset;
  mat3 s3mRot;
  vec3 s3mPivot;

  /** 当前图元所属单体的控制位：实例化取实例属性，其余取逐顶点属性 */
  float s3mBatchRaw() {
    #ifdef USE_INSTANCING
      return aInstanceBatchId;
    #else
      return aBatchId;
    #endif
  }

  vec4 s3mSampleBatch( sampler2D texA, sampler2D texB, vec2 uv, float mixVal ) {
    vec4 vA = texture2D( texA, uv );
    if ( mixVal <= 0.0001 ) return vA;
    vec4 vB = texture2D( texB, uv );
    return mix( vA, vB, mixVal );
  }

  vec4 s3mSampleBatchRow0( sampler2D texA, sampler2D texB, vec2 uv, float mixVal ) {
    vec4 vA = texture2D( texA, uv );
    if ( mixVal <= 0.0001 ) return vA;
    vec4 vB = texture2D( texB, uv );
    vec4 res = mix( vA, vB, mixVal );
    if ( vA.r < 0.0 && vB.r >= 0.0 ) {
      res.rgb = vB.rgb;
    } else if ( vA.r >= 0.0 && vB.r < 0.0 ) {
      res.rgb = vA.rgb;
    }
    if ( vA.a < -0.5 || vB.a < -0.5 ) {
      res.a = ( mixVal >= 0.5 ) ? vB.a : vA.a;
    }
    return res;
  }

  vec4 s3mSampleBatchRow1( sampler2D texA, sampler2D texB, vec2 uv, float mixVal ) {
    vec4 vA = texture2D( texA, uv );
    if ( mixVal <= 0.0001 ) return vA;
    vec4 vB = texture2D( texB, uv );
    vec4 res = mix( vA, vB, mixVal );
    if ( vA.a == 0.0 && vB.a > 0.0 ) {
      res.a = mix( 1.0, vB.a, mixVal );
    } else if ( vA.a > 0.0 && vB.a == 0.0 ) {
      res.a = mix( vA.a, 1.0, mixVal );
    }
    return res;
  }
`;

const VERT_SETUP = /* glsl */ `
  s3mCustomOffset = vec3( 0.0 );
  s3mRot = mat3( 1.0 );
  s3mPivot = vec3( 0.0 );
  float s3mBatchSetup = s3mBatchRaw();
  if ( uBatchTexActive > 0 && s3mBatchSetup >= 0.0 ) {
    float s3mU = ( s3mBatchSetup + 0.5 ) / uBatchTexWidth;
    vec4 bState = s3mSampleBatchRow0( uBatchTex, uBatchTex2, vec2( s3mU, 0.08333333 ), uBatchMix );
    if ( bState.a >= -0.5 ) {
      vec4 bOffset = s3mSampleBatchRow1( uBatchTex, uBatchTex2, vec2( s3mU, 0.25 ), uBatchMix );
      s3mCustomOffset = bOffset.xyz;
      if ( s3mCustomOffset.z == 0.0 && bState.a > 0.0 ) {
        s3mCustomOffset.z = bState.a;
      }
      vec4 r2 = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.41666667 ), uBatchMix );
      vec4 r3 = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.58333333 ), uBatchMix );
      vec4 r4 = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.75 ), uBatchMix );
      s3mRot = mat3(
        vec3( r2.x, r3.x, r4.x ),
        vec3( r2.y, r3.y, r4.y ),
        vec3( r2.z, r3.z, r4.z )
      );
      s3mPivot = vec3( r2.w, r3.w, r4.w );

      // Row 5: GPU 路径动画计算
      if ( uPathTexActive > 0 ) {
        vec4 r5 = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.91666667 ), uBatchMix );
        float pathId = r5.x;
        float speed = r5.y;
        float phase = r5.z;
        float mode = r5.w;
        if ( pathId >= 0.0 && mode > 0.5 && uPathCount > 0.0 ) {
          float t = phase + uPathTime * speed;
          bool autoHeading = true;
          if ( mode >= 4.0 ) {
            autoHeading = false;
            mode -= 3.0;
          }
          if ( mode < 1.5 ) {
            t = fract( t );
          } else if ( mode < 2.5 ) {
            t = clamp( t, 0.0, 1.0 );
          } else {
            t = mod( t, 2.0 );
            t = ( t > 1.0 ) ? ( 2.0 - t ) : t;
          }
          float pathU = ( t * 255.0 + 0.5 ) / 256.0;
          float pathV = ( pathId + 0.5 ) / uPathCount;
          vec4 pathSample = texture2D( uPathTex, vec2( pathU, pathV ) );
          vec3 pathPos = pathSample.xyz;
          float pathYaw = pathSample.w;
          if ( autoHeading ) {
            float c = cos( pathYaw );
            float s = sin( pathYaw );

            // GLSL 的 mat3 是列优先：下面两行是「第 0 列 = (c, s)」，等价于绕 Z 转 +yaw，
            // 把模型 +X 朝向对到切线方向（yaw = atan2(dy, dx)）。写成 (c,-s; s,c) 会左右镜像。
            mat3 rotHeading = mat3(
              c,  s, 0.0,
              -s, c, 0.0,
              0.0, 0.0, 1.0
            );
            s3mRot = rotHeading * s3mRot;
          }
          s3mCustomOffset += pathPos;
        }
      }
    }
  }
  objectNormal = normalize( s3mRot * objectNormal );
`;

const VERT_ELEVATION = /* glsl */ `
  float s3mBatchElev = s3mBatchRaw();
  if ( uBatchTexActive > 0 && s3mBatchElev >= 0.0 ) {
    float s3mU = ( s3mBatchElev + 0.5 ) / uBatchTexWidth;
    vec4 bState = s3mSampleBatchRow0( uBatchTex, uBatchTex2, vec2( s3mU, 0.08333333 ), uBatchMix );
    if ( bState.a < -0.5 ) {
      transformed = vec3( 0.0 );
    }
  }

  float s3mSelElev = max( step( 0.0, uSelBatch ) * step( abs( s3mBatchElev - uSelBatch ), 0.5 ), uSelWhole );
  // 刚体旋转以 s3mPivot 为中心，再叠加自定义平移与选中拔高
  transformed = s3mRot * ( transformed - s3mPivot ) + s3mPivot + s3mCustomOffset;
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
  vWorldNormal = normalize( s3mNormMat * ( s3mRot * normal ) );
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
     * 官方 CalculateMipLevel（vec2 版），逐字照抄 iClient3D 12.1.1。
     * 用**未 fract** 的 uv 求屏幕空间导数 —— 先 fract 再求导会在平铺接缝处炸出
     * 一个巨大导数，GPU 直接把整块砖采成最糊的 mip，表现为每块砖边缘一条暗线。
     */
    void s3mMipLevel( vec2 uv, vec2 texSize, float maxMip, out float mip ) {
      vec2 dx = dFdx( uv * texSize.x );
      vec2 dy = dFdy( uv * texSize.y );
      float dotX = dot( dx, dx );
      float dotY = dot( dy, dy );
      float dMax = max( dotX, dotY );
      float dMin = min( dotX, dotY );
      float off = clamp( ( dMax - dMin ) / max( dMax + dMin, 1e-8 ), 0.0, 1.0 );
      float d = dMax * ( 1.0 - off ) + dMin * off;
      mip = clamp( 0.5 * log2( max( d, 1e-8 ) ), 0.0, maxMip - 1.62 );
    }

    /**
     * 按指定 mip 档采样子区域（官方 czm_getTexColorForS3M 的内层循环体）。
     *
     * ★ 子区域 rect 的**右 1/3 不是贴图内容，是内联 mip 金字塔**：
     *   mip0 只占左 2/3，右 1/3 从上往下依次堆 1/2、1/4、1/8 缩略图，总高恰好 = rect 高。
     *   官方那句 width *= 2.0/3.0 就是为这个，不是「经验收缩系数」。
     *   数值实证：14 个块 691 条子纹理里 96.7% 满足「右侧 1/3 ≈ 左 2/3 的 1/2 下采样」
     *   （平均误差 6.8 vs 27.3）。
     *   所以 mip > 0 时采样点必须右移到 x + 2/3·w，并下移到 (2^(m-1)-1)/2^(m-1)。
     */
    vec4 s3mAtlasLod( vec2 uv, vec2 translate, vec2 scale, vec2 texSize, sampler2D tex, float mip ) {
      vec2 t = translate;
      if ( mip > 0.0 ) {
        t.x = translate.x + scale.x;
        float temp = pow( 2.0, mip - 1.0 );
        t.y = translate.y + scale.y * ( temp - 1.0 ) / temp;
      }
      float inv = 1.0 / pow( 2.0, mip );
      vec2 o = fract( uv );
      // 半纹素内缩，避免双线性把邻格内容混进来
      vec2 guard = vec2( pow( 2.0, mip ) / texSize.x, pow( 2.0, mip ) / texSize.y );
      o = clamp( o, guard, vec2( 1.0 ) - guard );
      return texture2D( tex, o * inv * scale + t );
    }

    /**
     * 图集采样入口：层级由 ceil/floor 两档各采一次再平均（官方同样做法），
     * 因为内联金字塔只有 2 的整数次幂，中间档必须靠混合。
     */
    vec4 s3mAtlasUnit( vec2 uv, vec4 rect, vec2 atlasDim, sampler2D tex ) {
      // 退化矩形 = 官方 batchId < 0：该纹理单元不参与合成
      if ( rect.z <= 0.0 || rect.w <= 0.0 ) return vec4( 1.0 );
      vec2 dimPx = vec2( rect.z * atlasDim.x, rect.w * atlasDim.y );
      vec2 texSize = vec2( dimPx.x * ( 2.0 / 3.0 ), dimPx.y );
      float maxMip = log2( max( min( texSize.x, texSize.y ), 1.0 ) );
      vec2 scale = texSize / atlasDim;
      float mip = 0.0;
      s3mMipLevel( uv, texSize, maxMip, mip );
      vec4 hi = s3mAtlasLod( uv, rect.xy, scale, texSize, tex, ceil( mip ) );
      vec4 lo = s3mAtlasLod( uv, rect.xy, scale, texSize, tex, floor( mip ) );
      return hi * 0.5 + lo * 0.5;
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
  uniform sampler2D uBatchTex2;
  uniform float uBatchMix;
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
  uniform float uAmbientGain;
  uniform float uOpacity;
  uniform float uTileFade;
  uniform float uFade;
  varying float vBatchId;
  varying vec3 vVertColor;
  varying float vWorldZ;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  vec4 s3mSampleBatchRow0( sampler2D texA, sampler2D texB, vec2 uv, float mixVal ) {
    vec4 vA = texture2D( texA, uv );
    if ( mixVal <= 0.0001 ) return vA;
    vec4 vB = texture2D( texB, uv );
    vec4 res = mix( vA, vB, mixVal );
    if ( vA.r < 0.0 && vB.r >= 0.0 ) {
      res.rgb = vB.rgb;
    } else if ( vA.r >= 0.0 && vB.r < 0.0 ) {
      res.rgb = vA.rgb;
    }
    if ( vA.a < -0.5 || vB.a < -0.5 ) {
      res.a = ( mixVal >= 0.5 ) ? vB.a : vA.a;
    }
    return res;
  }

  vec4 s3mSampleBatchRow1( sampler2D texA, sampler2D texB, vec2 uv, float mixVal ) {
    vec4 vA = texture2D( texA, uv );
    if ( mixVal <= 0.0001 ) return vA;
    vec4 vB = texture2D( texB, uv );
    vec4 res = mix( vA, vB, mixVal );
    if ( vA.a == 0.0 && vB.a > 0.0 ) {
      res.a = mix( 1.0, vB.a, mixVal );
    } else if ( vA.a > 0.0 && vB.a == 0.0 ) {
      res.a = mix( vA.a, 1.0, mixVal );
    }
    return res;
  }

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
  // 图层整体透明度（共享 uniform）+ 单瓦片淡入系数（逐材质），逐帧改都不产生重编译
  diffuseColor.a *= uOpacity * uTileFade;
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
    float s3mU = ( s3mBid + 0.5 ) / uBatchTexWidth;
    vec4 bState = s3mSampleBatchRow0( uBatchTex, uBatchTex2, vec2( s3mU, 0.08333333 ), uBatchMix );
    if ( bState.a < -0.5 ) {
      discard; // 属于被过滤隐藏的单体
    }
    if ( bState.r >= 0.0 ) {
      // 单体独立自定义颜色
      diffuseColor.rgb = bState.rgb;
      hasCustomColor = true;
    }
    // 单体独立透明度（状态纹理第 2 行 alpha，0 = 无覆盖）。
    // 与全局 uOpacity（diffuseColor.a 初值）和图集贴图自带 alpha 逐级叠乘
    vec4 bOffset = s3mSampleBatchRow1( uBatchTex, uBatchTex2, vec2( s3mU, 0.25 ), uBatchMix );
    if ( bOffset.a > 0.0 ) {
      diffuseColor.a *= bOffset.a;
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

  // 压暗乘子放在最后：mode 分支会整体覆写 diffuseColor.rgb，
  // 放在前面会被覆盖掉。setMode 的 fade-through 就靠它。
  diffuseColor.rgb *= uFade;
`;

const FRAG_EMISSIVE = /* glsl */ `
  float s3mSelE = max( step( 0.0, uSelBatch ) * step( abs( s3mBatchId() - uSelBatch ), 0.5 ), uSelWhole );
  // glowOnly 模式下表面不自发光，只保留描边边框；其他模式下适度发光
  if ( uSelMode != 3 ) {
    totalEmissiveRadiance += uSelColor * s3mSelE * uSelMix * ( uSelEmissive * 0.4 );
  }
  // 直通自发光微调 / 环境光底色提升：补偿背光阴影面（尤其 TOP_SIDE 立面），避免光照阴影面过暗
  if ( uAmbientGain > 0.001 ) {
    totalEmissiveRadiance += diffuseColor.rgb * uAmbientGain;
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
  // 两种光照模型共用的参数。注入的 chunk 只动 diffuseColor / normal / transformed，
  // 在 Standard 与 Lambert 的 shader 里都存在同名 include，所以模板不用分支。
  const baseParams = {
    color: opts.color ?? new THREE.Color(0xffffff),
    map: opts.map ?? null,
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
  };
  const mat = (
    materialQuality === 'lambert'
      ? new THREE.MeshLambertMaterial(baseParams)
      : new THREE.MeshStandardMaterial({
          ...baseParams,
          roughness: opts.roughness ?? 0.95,
          metalness: 0,
        })
  ) as StyledMaterial;

  // 选中单体编号：每个 Mesh 独立，默认 -1 表示无选中
  const uSelBatch = { value: -1 };
  // 没有单体化信息的几何（batchId = -1）只能整块选中
  const uSelWhole = { value: 0 };
  const uBatchTex = { value: DUMMY_BATCH_TEX };
  const uBatchTex2 = { value: DUMMY_BATCH_TEX };
  const uBatchTexWidth = { value: 1.0 };
  const uBatchTexActive = { value: 0 };
  /** 单块瓦片的淡入系数：逐材质独享（每块网格一份材质），默认 1 = 完全显示 */
  const uTileFade = { value: 1 };

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
      uBatchTex2,
      uBatchTexWidth,
      uBatchTexActive,
      uTileFade,
      uSecMap: { value: secMap },
      uAtlasDim,
      uAtlasDim1,
    });

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_SETUP}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_ELEVATION}`)
      .replace('#include <worldpos_vertex>', VERT_WORLD);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);

    if (atlas) {
      // onBeforeCompile 收到的还是未展开的 `#include <map_fragment>`，不是 include 里的
      // `texture2D( map, vMapUv )`。只替换后者会静默 no-op，最终仍按整张图集普通采样。
      const atlasMapFragment = /* glsl */ `
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = s3mAtlasUnit( vMapUv, vAtlasRect, uAtlasDim, map );
          diffuseColor *= sampledDiffuseColor;
        #endif
      `;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `${atlasMapFragment}${secMap ? `\n${FRAG_BAKE}` : ''}`
      );
    } else if (secMap) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_BAKE}`);
    }
  };

  // 不同材质共用同一段注入代码，必须让 three 认为它们的 program 可复用；
  // 但图集 / 烘焙两套宏会改注入结果，必须进 cacheKey，否则会复用错 program。
  mat.customProgramCacheKey = () =>
    `s3m-styled${atlas ? '-atlas' : ''}${secMap ? '-bake' : ''}`;

  mat.userData.uSelBatch = uSelBatch;
  mat.userData.uSelWhole = uSelWhole;
  // 拾取材质要读这些共享 uniform 的当前值：挂引用而不是拷数值，主材质更新后拾取自动跟上
  // （单测里可能不传共享 uniforms，这里按可选处理）
  mat.userData.uSelElevation = uniforms?.uSelElevation;
  mat.userData.uBatchMix = uniforms?.uBatchMix;
  mat.userData.uPathTex = uniforms?.uPathTex;
  mat.userData.uPathCount = uniforms?.uPathCount;
  mat.userData.uPathTime = uniforms?.uPathTime;
  mat.userData.uPathTexActive = uniforms?.uPathTexActive;
  mat.userData.uBatchTex = uBatchTex;
  mat.userData.uBatchTex2 = uBatchTex2;
  mat.userData.uBatchTexWidth = uBatchTexWidth;
  mat.userData.uBatchTexActive = uBatchTexActive;
  mat.userData.uTileFade = uTileFade;
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
  uniform sampler2D uBatchTex2;
  uniform float uBatchMix;
  uniform float uBatchTexWidth;
  uniform int uBatchTexActive;
  uniform sampler2D uPathTex;
  uniform float uPathCount;
  uniform float uPathTime;
  uniform int uPathTexActive;
  varying float vSel;

  vec4 s3mSampleBatch( sampler2D texA, sampler2D texB, vec2 uv, float mixVal ) {
    vec4 vA = texture2D( texA, uv );
    if ( mixVal <= 0.0001 ) return vA;
    vec4 vB = texture2D( texB, uv );
    return mix( vA, vB, mixVal );
  }

  void main() {
    vSel = max( step( 0.0, uSelBatch ) * step( abs( aBatchId - uSelBatch ), 0.5 ), uSelWhole );
    vec3 s3mCustomOffset = vec3( 0.0 );
    mat3 s3mRot = mat3( 1.0 );
    vec3 s3mPivot = vec3( 0.0 );
    if ( uBatchTexActive > 0 && aBatchId >= 0.0 ) {
      float s3mU = ( aBatchId + 0.5 ) / uBatchTexWidth;
      vec4 bState = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.08333333 ), uBatchMix );
      if ( bState.a < -0.5 ) {
        vSel = 0.0; // 过滤隐藏的单体不显示描边
      } else {
        vec4 bOffset = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.25 ), uBatchMix );
        s3mCustomOffset = bOffset.xyz;
        if ( s3mCustomOffset.z == 0.0 && bState.a > 0.0 ) {
          s3mCustomOffset.z = bState.a;
        }
        vec4 r2 = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.41666667 ), uBatchMix );
        vec4 r3 = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.58333333 ), uBatchMix );
        vec4 r4 = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.75 ), uBatchMix );
        s3mRot = mat3(
          vec3( r2.x, r3.x, r4.x ),
          vec3( r2.y, r3.y, r4.y ),
          vec3( r2.z, r3.z, r4.z )
        );
        s3mPivot = vec3( r2.w, r3.w, r4.w );

        if ( uPathTexActive > 0 ) {
          vec4 r5 = s3mSampleBatch( uBatchTex, uBatchTex2, vec2( s3mU, 0.91666667 ), uBatchMix );
          float pathId = r5.x;
          float speed = r5.y;
          float phase = r5.z;
          float mode = r5.w;
          if ( pathId >= 0.0 && mode > 0.5 && uPathCount > 0.0 ) {
            float t = phase + uPathTime * speed;
            bool autoHeading = true;
            if ( mode >= 4.0 ) {
              autoHeading = false;
              mode -= 3.0;
            }
            if ( mode < 1.5 ) {
              t = fract( t );
            } else if ( mode < 2.5 ) {
              t = clamp( t, 0.0, 1.0 );
            } else {
              t = mod( t, 2.0 );
              t = ( t > 1.0 ) ? ( 2.0 - t ) : t;
            }
            float pathU = ( t * 255.0 + 0.5 ) / 256.0;
            float pathV = ( pathId + 0.5 ) / uPathCount;
            vec4 pathSample = texture2D( uPathTex, vec2( pathU, pathV ) );
            vec3 pathPos = pathSample.xyz;
            float pathYaw = pathSample.w;
            if ( autoHeading ) {
              float c = cos( pathYaw );
              float s = sin( pathYaw );

              // GLSL 的 mat3 是列优先：下面两行是「第 0 列 = (c, s)」，等价于绕 Z 转 +yaw，
              // 把模型 +X 朝向对到切线方向（yaw = atan2(dy, dx)）。写成 (c,-s; s,c) 会左右镜像。
              mat3 rotHeading = mat3(
                c,  s, 0.0,
                -s, c, 0.0,
                0.0, 0.0, 1.0
              );
              s3mRot = rotHeading * s3mRot;
            }
            s3mCustomOffset += pathPos;
          }
        }
      }
    }
    vec3 p = position + ( s3mRot * normal ) * uWidth * vSel;
    p = s3mRot * ( p - s3mPivot ) + s3mPivot + s3mCustomOffset;
    p.z += vSel * uElevation;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
  }
`;

const OUTLINE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vSel;
  void main() {
    if ( vSel < 0.5 ) discard;
    if ( uOpacity <= 0.003 ) discard;
    gl_FragColor = vec4( uColor, uOpacity );
  }
`;

/**
 * 外扩轮廓的「外观」uniform。
 *
 * 与棱线一样，全局外扩是逐网格一份材质（要各绑各的单体状态纹理），但颜色 / 厚度 /
 * 不透明度必须全局统一 —— 所以这些 `{ value }` 对象由调用方持有并共享给每一份材质，
 * 改一次全场景生效。
 */
export interface OutlineStyleUniforms {
  uColor: { value: THREE.Color };
  uWidth: { value: number };
  uOpacity: { value: number };
}

export interface OutlineMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uSelBatch: { value: number };
    uSelWhole: { value: number };
    uWidth: { value: number };
    uOpacity: { value: number };
    uElevation: { value: number };
    uBatchTex: { value: THREE.Texture };
    uBatchTex2: { value: THREE.Texture };
    uBatchMix: { value: number };
    uBatchTexWidth: { value: number };
    uBatchTexActive: { value: number };
    uPathTex: { value: unknown };
    uPathCount: { value: number };
    uPathTexActive: { value: number };
    uPathTime: { value: number };
    uColor: { value: THREE.Color };
  };
}

/**
 * 描边材质（背面外扩法）。
 *
 * 选中侧与全局棱线共用这一份实现，差别只在 uniform：
 *   - 选中：`uSelBatch` = 选中单体的 batchId，只扩那一栋，不透明
 *   - 全局：`uSelWhole` = 1，整块几何都扩，走 `edgeOpacity` 混合
 *
 * @param styleUniforms 传入时**直接复用这些 `{ value }` 对象**，让逐网格材质共享外观
 * @param transparent   全局外扩要能吃 `edgeOpacity`，选中侧保持不透明（默认 false）
 */
export function createOutlineMaterial(
  shared: StyleUniforms,
  initialWidth = 0.9,
  styleUniforms?: OutlineStyleUniforms,
  transparent = false
): OutlineMaterial {
  const style: OutlineStyleUniforms = styleUniforms ?? {
    uColor: { value: shared.uSelColor.value.clone() },
    uWidth: { value: initialWidth },
    uOpacity: { value: 1 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSelBatch: { value: -1 },
      uSelWhole: { value: 0 },
      uWidth: style.uWidth,
      uOpacity: style.uOpacity,
      uElevation: { value: 0 },
      uBatchTex: { value: DUMMY_BATCH_TEX },
      uBatchTex2: { value: DUMMY_BATCH_TEX },
      uBatchMix: shared.uBatchMix ?? { value: 0 },
      uBatchTexWidth: { value: 1.0 },
      uBatchTexActive: { value: 0 },
      uPathTex: shared.uPathTex ?? { value: GPUPathManager.DUMMY_PATH_TEX },
      uPathCount: shared.uPathCount ?? { value: 1 },
      uPathTexActive: shared.uPathTexActive ?? { value: 0 },
      uPathTime: shared.uPathTime ?? { value: 0 },
      uColor: style.uColor,
    },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    transparent,
    // 描边要压在建筑后面一点，避免和本体 z-fighting
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }) as OutlineMaterial;
  (mat.userData as Record<string, unknown>).isOutline = true;
  return mat;
}
