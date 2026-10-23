/**
 * 屏幕空间等宽棱线
 *
 * 为什么不用 `LineBasicMaterial`：WebGL 下 `linewidth` 在绝大多数平台被忽略，
 * 线宽恒定 1px，想「调粗细」是做不到的。所以要自己把每条线段摊成一条面向屏幕的四边形：
 * 每条棱 4 个顶点，顶点着色器里把两端点投到屏幕空间，沿屏幕法线方向撑开 `uWidth` 个像素，
 * 再沿线段方向各外延半线宽，把相邻棱线的接缝盖住，避免拐角处出现缺口。
 *
 * 顶点布局（每段 4 个顶点，2 个三角形）：
 *   v0 = A 端, aSide = -1      v1 = A 端, aSide = +1
 *   v2 = B 端, aSide = +1      v3 = B 端, aSide = -1
 * B 端的 side 之所以反号，是因为着色器里方向向量统一取「aOther → position」，
 * B 端算出来的法线正好和 A 端相反，反号一次才能拼成同一个四边形。
 */
import * as THREE from 'three';

/** 所有等宽线材质共享的分辨率 uniform（每帧更新一次即可） */
export interface LineSharedUniforms {
  uResolution: { value: THREE.Vector2 };
  uDpr: { value: number };
}

export interface ThickLineMaterial extends THREE.ShaderMaterial {
  uniforms: LineSharedUniforms & {
    uColor: { value: THREE.Color };
    uOpacity: { value: number };
    uWidth: { value: number };
    uElevation: { value: number };
    [uniform: string]: THREE.IUniform;
  };
}

export function createLineSharedUniforms(): LineSharedUniforms {
  return {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
  };
}

const VERT = /* glsl */ `
  attribute vec3 aOther;
  attribute float aSide;

  uniform vec2 uResolution;
  uniform float uDpr;
  uniform float uWidth;
  uniform float uElevation;

  void main() {
    // 选中单体拔高：与着色器里 transformed.z += uSelElevation 保持同一口径（物体空间）
    vec4 clipA = projectionMatrix * modelViewMatrix * vec4( position + vec3( 0.0, 0.0, uElevation ), 1.0 );
    vec4 clipB = projectionMatrix * modelViewMatrix * vec4( aOther + vec3( 0.0, 0.0, uElevation ), 1.0 );

    if ( clipA.w <= 0.0 || clipB.w <= 0.0 ) {
      // 端点跑到相机后面，整段丢弃（裁到近平面的线段会有轻微截断，可接受）
      gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
      return;
    }

    vec2 sA = clipA.xy / clipA.w;
    vec2 sB = clipB.xy / clipB.w;

    // 屏幕空间方向（设备像素），再取法线
    vec2 dirPx = ( sB - sA ) * uResolution;
    float len = length( dirPx );
    dirPx = len > 1e-6 ? dirPx / len : vec2( 1.0, 0.0 );
    vec2 nrm = vec2( -dirPx.y, dirPx.x );

    // 半线宽：一侧撑开，一端外延（-dirPx 对两端都是「往外」的，见文件头）
    float halfPx = 0.5 * uWidth * uDpr;
    vec2 offsetPx = ( nrm * aSide - dirPx ) * halfPx;
    vec2 ndc = clipA.xy / clipA.w + offsetPx * 2.0 / uResolution;

    gl_Position = vec4( ndc * clipA.w, clipA.z, clipA.w );
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  void main() {
    if ( uOpacity <= 0.003 ) discard;
    gl_FragColor = vec4( uColor, uOpacity );
  }
`;

export function createThickLineMaterial(
  shared: LineSharedUniforms,
  opts: { color?: THREE.ColorRepresentation; opacity?: number; width?: number; elevation?: number } = {}
): ThickLineMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uResolution: shared.uResolution,
      uDpr: shared.uDpr,
      uColor: { value: new THREE.Color(opts.color ?? '#ffffff') },
      uOpacity: { value: opts.opacity ?? 1 },
      uWidth: { value: opts.width ?? 1.5 },
      uElevation: { value: opts.elevation ?? 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // 棱线本来就和建筑表面共面，往前推一点避免 z-fighting
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }) as ThickLineMaterial;
  (mat.userData as Record<string, unknown>).isThickLine = true;
  return mat;
}

/**
 * 线段对（每 6 个 float：x1 y1 z1 x2 y2 z2）→ 可绘制等宽线的几何体。
 */
export function buildThickLineGeometry(segments: ArrayLike<number>): THREE.BufferGeometry {
  const count = Math.floor(segments.length / 6);
  const vertexCount = count * 4;

  const position = new Float32Array(vertexCount * 3);
  const other = new Float32Array(vertexCount * 3);
  const side = new Float32Array(vertexCount);
  const index = vertexCount > 65535 ? new Uint32Array(count * 6) : new Uint16Array(count * 6);

  for (let i = 0; i < count; i++) {
    const s = i * 6;
    const ax = segments[s];
    const ay = segments[s + 1];
    const az = segments[s + 2];
    const bx = segments[s + 3];
    const by = segments[s + 4];
    const bz = segments[s + 5];

    const v = i * 4;
    // A 端两枚
    setVertex(v, ax, ay, az, bx, by, bz, -1);
    setVertex(v + 1, ax, ay, az, bx, by, bz, 1);
    // B 端两枚（side 反号）
    setVertex(v + 2, bx, by, bz, ax, ay, az, 1);
    setVertex(v + 3, bx, by, bz, ax, ay, az, -1);

    const o = i * 6;
    index[o] = v;
    index[o + 1] = v + 1;
    index[o + 2] = v + 2;
    index[o + 3] = v;
    index[o + 4] = v + 2;
    index[o + 5] = v + 3;
  }

  function setVertex(
    k: number,
    px: number,
    py: number,
    pz: number,
    ox: number,
    oy: number,
    oz: number,
    sd: number
  ): void {
    const p = k * 3;
    position[p] = px;
    position[p + 1] = py;
    position[p + 2] = pz;
    other[p] = ox;
    other[p + 1] = oy;
    other[p + 2] = oz;
    side[k] = sd;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aOther', new THREE.BufferAttribute(other, 3));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------------ 单体棱线提取 */

export interface EdgeVertexRange {
  vertexOffset: number;
  vertexCount: number;
}

/** 单体棱线的线段上限，超过就放弃（宁可没有线，也不要把主线程卡住） */
const MAX_EDGE_SEGMENTS = 60000;
/** 非索引几何按位置量化去重用的小数位（0.01m 足够区分不同顶点） */
const QUANT = 100;

/**
 * 从几何里只挑出「指定顶点区间」的棱线，作为线段对返回。
 *
 * `ranges` 为空表示整块网格。判定规则与 `THREE.EdgesGeometry` 一致：
 *   - 只被一个三角形用到的边 → 边界边，保留；
 *   - 被两个三角形共用、且两面夹角大于 `creaseAngle` → 折边，保留；
 *   - 其余（共面内部边）→ 丢掉，否则平面会被切成三角网格。
 *
 * 非索引几何没有共享顶点，直接用顶点号去重会让每条边都被判成边界边。
 * 所以这里先按位置量化把顶点归一化成 canonical id，再走同一套逻辑。
 */
export function buildFeatureEdgeSegments(
  geometry: THREE.BufferGeometry,
  ranges?: EdgeVertexRange[] | null,
  creaseAngle = 40
): Float32Array | null {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position) return null;
  const total = position.count;
  if (total < 3) return null;

  const px = new Float32Array(total);
  const py = new Float32Array(total);
  const pz = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    px[i] = position.getX(i);
    py[i] = position.getY(i);
    pz[i] = position.getZ(i);
  }

  // 顶点归一化：canon[i] → canonical id，rep[id] → 用于取坐标的代表顶点
  let canon: Uint32Array | null = null;
  let rep: Uint32Array | null = null;
  if (!geometry.index) {
    const lookup = new Map<string, number>();
    canon = new Uint32Array(total);
    rep = new Uint32Array(total);
    let n = 0;
    for (let i = 0; i < total; i++) {
      const k = `${Math.round(px[i] * QUANT)},${Math.round(py[i] * QUANT)},${Math.round(pz[i] * QUANT)}`;
      let id = lookup.get(k);
      if (id === undefined) {
        id = n++;
        lookup.set(k, id);
        rep[id] = i;
      }
      canon[i] = id;
    }
  }
  const cid = (i: number): number => (canon ? canon[i] : i);
  const repIdx = (c: number): number => (rep ? rep[c] : c);

  const index = geometry.index;
  const idxArr = index ? (index.array as ArrayLike<number>) : null;
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(total / 3);
  if (triCount < 1) return null;

  let mask: Uint8Array | null = null;
  if (ranges && ranges.length > 0) {
    mask = new Uint8Array(total);
    for (const r of ranges) {
      const start = Math.max(0, r.vertexOffset | 0);
      const end = Math.min(total, start + (r.vertexCount | 0));
      if (end > start) mask.fill(1, start, end);
    }
    if (!mask.includes(1)) return null;
  }

  const normals = new Float32Array(triCount * 3);
  // key → 首次出现的三角形号；-1 已判定为折边，-2 已判定为平面内部边
  const seen = new Map<number, number>();
  const span = total + 1;
  const out: number[] = [];
  const cosLimit = Math.cos((creaseAngle * Math.PI) / 180);
  let tri = -1;
  let nx = 0;
  let ny = 0;
  let nz = 0;

  const emit = (lo: number, hi: number): boolean => {
    if (out.length >= MAX_EDGE_SEGMENTS * 6) return false;
    const a = repIdx(lo);
    const b = repIdx(hi);
    out.push(px[a], py[a], pz[a], px[b], py[b], pz[b]);
    return true;
  };

  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * span + hi;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, tri);
      return;
    }
    if (first < 0) return;
    // 与首个共用该边的三角形比夹角
    const dot = nx * normals[first * 3] + ny * normals[first * 3 + 1] + nz * normals[first * 3 + 2];
    if (dot < cosLimit) {
      emit(lo, hi);
      seen.set(key, -1);
    } else {
      seen.set(key, -2);
    }
  };

  for (tri = 0; tri < triCount; tri++) {
    const i0 = idxArr ? idxArr[tri * 3] : tri * 3;
    const i1 = idxArr ? idxArr[tri * 3 + 1] : tri * 3 + 1;
    const i2 = idxArr ? idxArr[tri * 3 + 2] : tri * 3 + 2;
    if (mask && !(mask[i0] && mask[i1] && mask[i2])) continue;

    const e1x = px[i1] - px[i0];
    const e1y = py[i1] - py[i0];
    const e1z = pz[i1] - pz[i0];
    const e2x = px[i2] - px[i0];
    const e2y = py[i2] - py[i0];
    const e2z = pz[i2] - pz[i0];
    nx = e1y * e2z - e1z * e2y;
    ny = e1z * e2x - e1x * e2z;
    nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue; // 退化三角形，法线无意义
    nx /= len;
    ny /= len;
    nz /= len;
    normals[tri * 3] = nx;
    normals[tri * 3 + 1] = ny;
    normals[tri * 3 + 2] = nz;

    addEdge(cid(i0), cid(i1));
    addEdge(cid(i1), cid(i2));
    addEdge(cid(i2), cid(i0));
  }

  // 只出现一次的边 = 边界边（洞口、女儿墙顶沿等），保留
  for (const [key, first] of seen) {
    if (first < 0) continue;
    const lo = Math.floor(key / span);
    const hi = key - lo * span;
    if (!emit(lo, hi)) break;
  }

  return out.length > 0 ? new Float32Array(out) : null;
}
