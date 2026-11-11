/**
 * 示例：高级发光的线框立方体（选择性辉光）
 *
 * 这个文件**不是库的一部分**，和 flow-line / range-canopy 一样只是一份可抄的用法说明。
 *
 * ## 为什么不用全局 bloom
 *
 * demo 里有 `createPostPresenter` 的辉光后处理，但它是**整张 S3M 颜色 RT** 的亮部提取：
 * 阈值调低，建筑高光跟着起晕；调高，立方体又不够亮。而且 `setPresenter` 是独占的，
 * 开了它就占掉运动模糊的位置。为「只有这一个立方体该发光」去接管上屏不划算。
 *
 * 这里改成**几何层的多尺度辉光**：不产生任何全屏 pass，只有 4 个 draw call、96 个顶点，
 * 光晕全部在自己这份线段的片元里算出来。真实 bloom 的本质就是多尺度高斯能量叠加，
 * 所以只要把能量分布写对，视觉层次是可以对齐的，而且能精确到「哪一根棱亮」。
 *
 * 发光由五层叠出来（缺一层就会显得像廉价描边）：
 *   1. 三层不同 sigma 的高斯光晕，逐通道 sigma 不同 ⇒ 边缘有色散，不是单色渐变
 *   2. HDR 白热核心：中心颜色往白推、亮度 >1 被 clamp ⇒ 过曝芯 + 饱和边
 *   3. 沿线流光 + 8 个角点热点，能量不是均匀糊在棱上
 *   4. 缓慢呼吸，每条棱相位错开
 *   5. 地面光池（扩散环 + 方形边缘光）+ 内壁 fresnel 微光，给纯线框补上体积感
 *
 * 附带一个免费的升级：核心输出的是 HDR 值，所以这时再到面板里开「辉光 (bloom)」
 * 后处理，亮部提取会把它抓出来，叠一层更大范围的扩散 —— 两层辉光不冲突。
 *
 * ## 三个坐标/渲染上的坑
 *
 * - 场景是 **Z-up**（x 东、y 北、z 高）。这里直接按 [东, 北, 高] 写 8 个角点，
 *   不用 BoxGeometry 再绕 X 转 90°（range-canopy 的圆柱才需要转）。
 * - 用 `buildThickLineGeometry` 而不是 LineSegments：WebGL 的 linewidth 基本恒为 1px，
 *   而光晕需要几十像素宽的屏幕空间四边形。它插值的 `aSide`（-1→+1）正好就是
 *   「到中心线的归一化距离」，片元里 `vSide*vSide` 直接当高斯的距离平方用。
 * - 所有材质走 **AdditiveBlending + depthWrite:false**，但保留 depthTest（occluded），
 *   所以立方体会被前面的楼正确挡住，又不会在自身前后棱之间挖出黑边。
 */
import * as THREE from 'three';
import { buildThickLineGeometry, createThickLineMaterial } from 's3m-maplibre';
import type { OverlayHandle, S3MLayer } from 's3m-maplibre';
import { datasetBaseHeight } from './model-cover';

/* ------------------------------------------------------------------ 着色器 */

/**
 * 所有片元共用的出口守卫。
 *
 * additive 混合是「src + dst」，只要 src 里出现一个 NaN，整片像素就会被写成纯黑
 * —— 而且黑的不是一条线，是那个三角形的整个覆盖范围。GLSL ES 1.0 没有 isnan，
 * 但 NaN 与任何数比较都返回 false，所以用 `!(x >= 0.0)` 就能把它挡下来。
 * pow 只是 NaN 的来源之一（近平面投影爆炸、normalize(0) 都会产生），不如在出口
 * 一次性兜住：任何层算脏了就丢弃该片元，宁可少一点光，也不能开个黑洞。
 */
const NAN_GUARD = /* glsl */ `
    if ( !( rgb.r >= 0.0 && rgb.g >= 0.0 && rgb.b >= 0.0 ) ) discard;
`;

/** 三层共用的 uniform 面与「能量场」：沿线流光 / 角点热点 / 呼吸 */
const COMMON = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uGlow;
  uniform float uSpeed;
  uniform float uChroma;

  varying float vAlong;
  varying float vSeg;
  varying float vSide;

  float energy() {
    // 每条棱用 vSeg 错开相位，否则 12 条棱会像被同一根绳子牵着一起闪
    float head  = fract( uTime * uSpeed + vSeg * 0.083 );
    float trail = fract( head - vAlong );
    float flow  = exp( -trail * 9.0 );
    // vAlong 两端即立方体的 8 个角点，给它们额外的热点
    float node  = exp( -min( vAlong, 1.0 - vAlong ) * 34.0 );
    float pulse = 0.88 + 0.12 * sin( uTime * 1.7 + vSeg * 0.9 );
    return ( 0.62 + flow * 0.85 + node * 0.55 ) * pulse;
  }
`;

/**
 * 光晕层（uWidth 几十像素）。
 *
 * 三层 sigma 逐通道不同：红扩散最宽、蓝最紧 —— 这是真实镜头/传感器的色散方向。
 * uChroma = 0 时三层 sigma 对齐，退回无色散，方便对比。
 */
const HALO_FRAG = /* glsl */ `
  ${COMMON}
  void main() {
    float d2 = vSide * vSide;
    float c  = clamp( uChroma, 0.0, 2.0 );
    vec3 k1 = mix( vec3( 18.5 ), vec3( 16.0, 18.5, 22.0 ), c );
    vec3 k2 = mix( vec3(  5.0 ), vec3(  4.0,  5.0,  6.4 ), c );
    vec3 k3 = mix( vec3(  1.35 ), vec3(  1.05, 1.35, 1.8 ), c );
    vec3 halo = exp( -k1 * d2 ) * 0.72
              + exp( -k2 * d2 ) * 0.44
              + exp( -k3 * d2 ) * 0.22;

    vec3 tint = mix( uColor, vec3( 1.0 ), 0.18 );
    vec3 rgb  = halo * tint * energy() * uGlow;
    if ( max( rgb.r, max( rgb.g, rgb.b ) ) < 0.002 ) discard;
    // additive 是 src.rgb * src.a + dst，能量已经算在 rgb 里，a 只当总开关
    ${NAN_GUARD}
    gl_FragColor = vec4( rgb, uOpacity );
  }
`;

/** 芯层（uWidth 几像素）：中心过曝成白，边缘保留饱和主色 */
const CORE_FRAG = /* glsl */ `
  ${COMMON}
  void main() {
    float d2   = vSide * vSide;
    float core = exp( -10.0 * d2 );
    float hot  = exp( -42.0 * d2 );
    float e    = energy();
    vec3  rgb  = mix( uColor, vec3( 1.0 ), 0.42 + 0.5 * hot )
               * ( core * 1.15 + hot * 1.9 ) * e * ( 0.85 + uGlow * 0.25 );
    if ( max( rgb.r, max( rgb.g, rgb.b ) ) < 0.003 ) discard;
    ${NAN_GUARD}
    gl_FragColor = vec4( rgb, uOpacity );
  }
`;

const POOL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

/** 地面光池：柔和落光 + 贴着底面的方形边缘光 + 一圈向外扩散的环 */
const POOL_FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uGlow;
  varying vec2 vUv;

  void main() {
    vec2  p    = ( vUv - 0.5 ) * 2.0;
    float r    = length( p );
    float box  = max( abs( p.x ), abs( p.y ) );
    float fall = exp( -r * r * 2.6 );
    // 平方一律写 x*x：GLSL 的 pow(x, 2.0) 在 x<0 时是未定义行为（返回 NaN），
    // NaN 混进 additive 混合会把整片像素写成纯黑 —— 抬头看天空时最明显
    float e = ( box - 0.62 ) * 13.0;
    float edge = exp( -e * e );
    float ringR = fract( uTime * 0.16 );
    float q = ( r - ringR ) * 11.0;
    float ring  = exp( -q * q ) * ( 1.0 - ringR );
    vec3  rgb   = mix( vec3( 1.0 ), uColor, 0.6 )
                * ( fall * 0.16 + edge * 0.34 + ring * 0.22 ) * uGlow;
    ${NAN_GUARD}
    gl_FragColor = vec4( rgb, uOpacity );
  }
`;

const SHELL_VERT = /* glsl */ `
  varying vec3  vN;
  varying vec3  vV;
  varying float vZ;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    vN = normalize( normalMatrix * normal );
    vV = normalize( -mv.xyz );
    vZ = position.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/** 内壁：很淡的 fresnel + 一道缓慢上升的扫描带，只负责给线框补体积，不抢戏 */
const SHELL_FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uGlow;
  varying vec3  vN;
  varying vec3  vV;
  varying float vZ;

  void main() {
    // 相机在立方体内部（抬头看天空）时看到的都是背面：顶盖会糊住整片视野，
    // 线框立方体该保持通透，所以内壁只从外部画
    if ( !gl_FrontFacing ) discard;
    float fres = pow( 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) ), 2.5 );
    float s = ( fract( vZ - uTime * 0.11 ) - 0.5 ) * 9.0;
    float scan = exp( -s * s );
    vec3  rgb  = mix( uColor, vec3( 1.0 ), 0.3 )
               * ( fres * 0.09 + scan * 0.035 ) * uGlow;
    ${NAN_GUARD}
    gl_FragColor = vec4( rgb, uOpacity );
  }
`;

/* ------------------------------------------------------------------ 几何 */

/**
 * 单位高度的立方体 12 条棱 → 等宽线几何。
 *
 * 顶点布局固定是 [A-, A+, B+, B-]（EdgeLines.ts 文件头 + thick-line-geometry.test.ts
 * 都钉住了），所以 aAlong 按 [0, 0, 1, 1] 填；aSeg 给每条棱一个 id 用来错开相位。
 * 高度不烘进几何：body.scale.z = h，拖高度滑块不产生新的 BufferGeometry。
 */
function buildEdges(w: number, d: number): THREE.BufferGeometry {
  const x = w / 2;
  const y = d / 2;
  const p: [number, number, number][] = [
    [-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0],
    [-x, -y, 1], [x, -y, 1], [x, y, 1], [-x, y, 1],
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0], // 底
    [4, 5], [5, 6], [6, 7], [7, 4], // 顶
    [0, 4], [1, 5], [2, 6], [3, 7], // 竖
  ];

  const segments = new Float32Array(edges.length * 6);
  const along = new Float32Array(edges.length * 4);
  const segIds = new Float32Array(edges.length * 4);
  edges.forEach(([a, b], i) => {
    segments.set(p[a], i * 6);
    segments.set(p[b], i * 6 + 3);
    along.set([0, 0, 1, 1], i * 4);
    segIds.fill(i, i * 4, i * 4 + 4);
  });

  const geo = buildThickLineGeometry(segments);
  geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  geo.setAttribute('aSeg', new THREE.BufferAttribute(segIds, 1));
  return geo;
}

/**
 * 内壁只画四个侧面，**不画顶盖和底盖**。
 *
 * 相机在包围盒内部（demo 里最常见的视角）抬头看时，封闭盒子的顶盖会横跨地平线
 * 以上的整片天空；只要它在 additive 下出过一次异常值，那片天空就整块变黑。
 * 开放侧面从结构上杜绝这件事，也更贴合「线框」该有的通透感。
 */
function buildShell(w: number, d: number): THREE.BufferGeometry {
  const x = w / 2;
  const y = d / 2;
  const corners: [number, number][] = [[-x, -y], [x, -y], [x, y], [-x, y]];
  const pos = new Float32Array(4 * 4 * 3);
  const index: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    // 底A、底B、顶B、顶A：这个绕序的叉积正好是朝外的法线，
    // 配合片元里的 gl_FrontFacing，从内部看时整层不画
    pos.set([ax, ay, 0, bx, by, 0, bx, by, 1, ax, ay, 1], i * 12);
    const v = i * 4;
    index.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ 公共 API */

export interface GlowCubeOptions {
  /** 高度（米），默认 450 */
  height?: number;
  /** 主色，默认 '#4ad8ff' */
  color?: string;
  /** 辉光强度，默认 0.45 */
  glow?: number;
  /** 光晕宽度（CSS 像素，不随距离变细），默认 14 */
  haloWidth?: number;
  /** 芯线宽度（CSS 像素），默认 3 */
  coreWidth?: number;
  /** 流光每秒走完几条棱的比例，默认 0.08 */
  speed?: number;
  /** 色散量 0~2，0 = 无色散，默认 0.6 */
  chroma?: number;
  /** 相对包围盒外扩比例，默认 0.08（贴着模型会 z-fighting） */
  padding?: number;
  /** 地面光池，默认开 */
  pool?: boolean;
  /** 四个侧面的淡 fresnel 微光，默认开。只在外部视角可见（内部视角被 gl_FrontFacing 剔掉） */
  shell?: boolean;
  /** 不传时静止：不进帧循环、地图空闲时不产生新帧 */
  animate?: boolean;
  /** 覆盖锚点（[lng, lat, alt]）。不传用数据集包围盒中心 */
  center?: [number, number, number];
  /** 覆盖尺寸（米，[宽, 深]）。不传用数据集包围盒宽深 */
  size?: [number, number];
}

export interface GlowCube {
  handle: OverlayHandle;
  size: { width: number; depth: number; height: number };
  setColor(color: string): void;
  setGlow(v: number): void;
  setSpeed(v: number): void;
  setChroma(v: number): void;
  setHaloWidth(px: number): void;
  setHeight(h: number): void;
  /** 跟着数据集垂直偏移走，拖高程滑块时调它 */
  setBaseHeight(z: number): void;
}

/**
 * 给当前数据集套一个发光线框立方体。没有数据集、也没给 center/size 时返回 null。
 */
export function addGlowCube(layer: S3MLayer, opts: GlowCubeOptions = {}): GlowCube | null {
  const {
    color = '#4ad8ff',
    glow = 0.45,
    haloWidth = 14,
    coreWidth = 3,
    speed = 0.08,
    chroma = 0.6,
    padding = 0.08,
    pool: withPool = true,
    shell: withShell = true,
    animate = true,
  } = opts;
  const height = Math.max(1, opts.height ?? 450);

  // 尺寸取 geoBounds 而不是遍历已加载瓦片：LOD 一变，后者会让立方体跟着抖
  let width = 0;
  let depth = 0;
  let anchor: [number, number, number];
  const bounds = layer.getBounds();
  if (opts.center && opts.size) {
    anchor = opts.center;
    [width, depth] = opts.size;
  } else if (bounds) {
    const [[westLng, southLat], [eastLng, northLat]] = bounds;
    const sw = layer.lngLatToPoint({ lng: westLng, lat: southLat, altitude: 0 });
    const ne = layer.lngLatToPoint({ lng: eastLng, lat: northLat, altitude: 0 });
    width = Math.abs(ne[0] - sw[0]) * (1 + padding);
    depth = Math.abs(ne[1] - sw[1]) * (1 + padding);
    anchor = opts.center ?? [(westLng + eastLng) / 2, (southLat + northLat) / 2, 0];
  } else {
    return null;
  }
  if (!(width > 0 && depth > 0)) return null;

  // 所有材质共享同一批 { value } 对象：改一次颜色/强度，四层同步生效
  const uColor = { value: new THREE.Color(color) };
  const uOpacity = { value: 1 };
  const uTime = { value: 0 };
  const uGlow = { value: glow };
  const uSpeed = { value: speed };
  const uChroma = { value: chroma };
  const shared = { uColor, uOpacity, uTime, uGlow, uSpeed, uChroma };

  const edges = buildEdges(width, depth);

  const makeLine = (fragmentShader: string, widthPx: number): THREE.ShaderMaterial => {
    const mat = createThickLineMaterial(
      layer.viewer.lineShared,
      { width: widthPx, opacity: 1 },
      undefined,
      undefined,
      {
        attributeDeclarations: 'attribute float aAlong; attribute float aSeg;',
        varyingDeclarations: 'varying float vAlong; varying float vSeg; varying float vSide;',
        vertexTail: 'vAlong = aAlong; vSeg = aSeg; vSide = aSide;',
        fragmentShader,
        // 同名会覆盖内置的 uColor / uOpacity，换成上面共享的那份。
        // 展开一层：让每份材质有自己的 uniforms 字典，只共享 { value } 对象
        uniforms: { ...shared },
      }
    );
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    return mat;
  };

  const haloMat = makeLine(HALO_FRAG, haloWidth);
  const coreMat = makeLine(CORE_FRAG, coreWidth);

  const halo = new THREE.Mesh(edges, haloMat);
  const core = new THREE.Mesh(edges, coreMat);
  // 屏幕空间撑开的四边形不在几何的包围球里，交给宿主裁剪会误判成离屏
  halo.frustumCulled = false;
  core.frustumCulled = false;

  const disposables: { dispose(): void }[] = [edges, haloMat, coreMat];

  // body 只管「单位高度 → h」，base 只管数据集垂直偏移。
  // 两件事写在同一个对象上，拖高程滑块时就会把 scale 覆盖掉（见 model-cover.ts）
  const body = new THREE.Group();
  body.add(halo, core);

  const base = new THREE.Group();
  base.add(body);
  base.position.z = datasetBaseHeight(layer);

  const applyHeight = (h: number): void => {
    body.scale.z = h;
  };
  applyHeight(height);

  if (withShell) {
    // 开放的四个侧面（无顶盖 / 底盖）：抬头看时天空不会被内壁盖住
    const shellGeo = buildShell(width, depth);
    const shellMat = new THREE.ShaderMaterial({
      uniforms: { ...shared },
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    body.add(new THREE.Mesh(shellGeo, shellMat));
    disposables.push(shellGeo, shellMat);
  }

  if (withPool) {
    const poolGeo = new THREE.PlaneGeometry(width * 1.6, depth * 1.6);
    const poolMat = new THREE.ShaderMaterial({
      uniforms: { ...shared },
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      transparent: true,
      depthWrite: false,
      // PlaneGeometry 法线朝 +Z（上）。只留正面，相机贴地或钻到平面下方时
      // 光池不会翻到天空那一侧去
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
    });
    const poolMesh = new THREE.Mesh(poolGeo, poolMat);
    poolMesh.position.z = 0.4; // 抬一点避开与地表的 z-fighting
    base.add(poolMesh);
    disposables.push(poolGeo, poolMat);
  }

  const handle = layer.overlay.add({
    anchor,
    object: base,
    // 保留 depthTest：被前面的楼挡住才像三维物体；'always' 会变成一块贴纸
    depth: 'occluded',
    update: animate ? ({ t }) => { uTime.value = t; } : undefined,
    onRemove: () => {
      for (const d of disposables) d.dispose();
    },
  });

  const repaint = (): void => handle.requestRepaint();
  const size = { width, depth, height };
  return {
    handle,
    size,
    setColor: (c) => { uColor.value.set(c); repaint(); },
    setGlow: (v) => { uGlow.value = Math.max(0, v); repaint(); },
    setSpeed: (v) => { uSpeed.value = Math.max(0, v); repaint(); },
    setChroma: (v) => { uChroma.value = Math.max(0, Math.min(2, v)); repaint(); },
    setHaloWidth: (px) => {
      haloMat.uniforms.uWidth.value = Math.max(1, px);
      repaint();
    },
    setHeight: (h) => {
      const v = Math.max(1, h);
      applyHeight(v);
      size.height = v;
      repaint();
    },
    setBaseHeight: (z) => { base.position.z = z; repaint(); },
  };
}
