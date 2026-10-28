/**
 * 高斯泼溅材质（屏幕空间 EWA 投影）
 *
 * 每个高斯是一个四边形，顶点在 **ndc** 里按自身协方差的两个特征轴展开，
 * 片元里做二维高斯衰减。公式与 core/SplatProjection.ts 逐行对应（那是它的
 * 可单测版本，改公式两边同步）：
 *
 *   Σ′ = J · (W R S Sᵀ Rᵀ Wᵀ) · Jᵀ
 *
 * J 是 ndc 对视图坐标的雅可比，直接用投影矩阵元素求 —— 本项目的
 * projectionMatrix 是 ENU→clip 的完整矩阵，w 行不是标准针孔的 (0,0,-1,0)，
 * 套教科书简式会算错。顶点输出是 clip.xy += ndcOffset * clip.w，与宿主投影
 * 矩阵的具体形式完全解耦。
 *
 * 为什么不是早先的「主轴投到垂直视线平面、丢掉 z 分量」：薄片高斯侧对相机时
 * 被丢的那根轴归零，四边形塌成一条线 → 满墙空洞。EWA 的 2×2 协方差不会退化。
 *
 * **半轴不放大，只剔除。** 官方顶点着色器在展开前有一句
 * `dot(cov.xy,cov.xy) < 4.0 && dot(cov.zw,cov.zw) < 4.0 → discard`，
 * 即两轴都短于 2px 的高斯根本不画。泼溅瓦片细分到亚像素时，一个像素上会压着
 * 几十个高斯，逐个抬成 1px 硬点就是那层彩色马赛克 —— 丢掉它们，画面才干净。
 *
 * 彩色噪点还有另一半原因：alpha 混合顺序相关，实例必须按视深 back-to-front，
 * 见 render/SplatSorter.ts（每帧相机变化时重排）。
 *
 * ⚠️ 改这个文件时注意：GLSL 是用模板字符串写的，**着色器源码里的注释绝不能出现反引号**。
 * 反引号会提前终止模板字符串，剩下的 GLSL 被当成 JS 求值 —— 报错信息通常是
 * "ReferenceError: position is not defined"，而且只在运行时炸，很难一眼看出根源。
 */
import * as THREE from 'three';
import {
  SPLAT_SIGMA,
  SPLAT_LOW_PASS_PIXELS,
  SPLAT_MIN_AXIS_PIXELS,
  SPLAT_MAX_AXIS_PIXELS,
} from '../core/SplatProjection.js';

/**
 * 全瓦片共享的绘图缓冲尺寸（像素）。
 *
 * 泼溅材质与拾取材质都要把像素换算成 ndc，必须看到**同一个**尺寸；
 * 每帧由 `setSplatViewport()` 就地更新这一个 Vector2，所有引用它的 uniform 自动跟着变。
 */
export const SPLAT_VIEWPORT = new THREE.Vector2(1000, 1000);

/** 拾取时每个高斯至少撑开这么多像素半径（否则细高斯在 1px 采样下点不中） */
const PICK_MIN_PIXELS = 4;

export interface SplatMaterialOptions {
  /** 不透明度整体缩放（0~1），默认 1 */
  opacity?: number;
  /**
   * 两根轴都短于这个像素数就整片丢弃，默认 2（官方口径）。
   * 0 = 不剔除：亚像素高斯会全部绘制，密集区域立刻变成彩色噪点。
   */
  cullPixels?: number;
  /**
   * 半轴像素上限，默认 1024。中心贴近相机平面时 EWA 会数值爆炸（实测能到
   * 几百万像素），巨大 quad 与视锥只相交出一个角 → 锐角三角面 / 放射拉丝。
   * 0 = 不封顶。
   */
  maxPixels?: number;
}

export function createSplatMaterial(options: SplatMaterialOptions = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: options.opacity ?? 1 },
      uViewport: { value: SPLAT_VIEWPORT },
      uCullPixels: { value: options.cullPixels ?? 2.0 },
      uMaxPixels: { value: options.maxPixels ?? SPLAT_MAX_AXIS_PIXELS },
    },
    vertexShader: /* glsl */ `
      // position 由 three 的 ShaderMaterial 前缀自动声明（vec3），这里直接取 .xy
      attribute vec3 iCenter;
      attribute vec4 iQuat;    // (x, y, z, w)
      attribute vec3 iScale;   // 米
      attribute vec4 iColor;   // RGBA，已归一化到 0~1

      uniform vec2 uViewport;
      uniform float uCullPixels;
      uniform float uMaxPixels;

      varying vec2 vQuad;
      varying vec4 vColor;

      void main() {
        vec4 centerView = modelViewMatrix * vec4(iCenter, 1.0);
        vec4 clip = projectionMatrix * centerView;

        // 相机后方 / 退化实例：整个四边形扔到裁剪体外，不做任何透视除法
        if (clip.w <= 0.000001) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vQuad = position.xy;
          vColor = vec4(0.0);
          return;
        }

        // M = W · R · diag(s)，R 由四元数展开（列主序）
        vec4 q = iQuat;
        float xx = q.x * q.x, yy = q.y * q.y, zz = q.z * q.z;
        float xy = q.x * q.y, xz = q.x * q.z, yz = q.y * q.z;
        float wx = q.w * q.x, wy = q.w * q.y, wz = q.w * q.z;
        mat3 R = mat3(
          1.0 - 2.0 * (yy + zz), 2.0 * (xy + wz),       2.0 * (xz - wy),
          2.0 * (xy - wz),       1.0 - 2.0 * (xx + zz), 2.0 * (yz + wx),
          2.0 * (xz + wy),       2.0 * (yz - wx),       1.0 - 2.0 * (xx + yy)
        );
        mat3 M = mat3(modelViewMatrix) * R * mat3(
          iScale.x, 0.0, 0.0,
          0.0, iScale.y, 0.0,
          0.0, 0.0, iScale.z
        );

        // Σ = M Mᵀ，只算对称上三角（行向量点积）
        vec3 r0 = vec3(M[0][0], M[1][0], M[2][0]);
        vec3 r1 = vec3(M[0][1], M[1][1], M[2][1]);
        vec3 r2 = vec3(M[0][2], M[1][2], M[2][2]);
        float v00 = dot(r0, r0), v01 = dot(r0, r1), v02 = dot(r0, r2);
        float v11 = dot(r1, r1), v12 = dot(r1, r2), v22 = dot(r2, r2);

        // 雅可比：ndc = clip.xy / w 对视图坐标的偏导（通用投影矩阵）
        float w2 = clip.w * clip.w;
        vec3 J0 = (vec3(projectionMatrix[0][0], projectionMatrix[1][0], projectionMatrix[2][0]) * clip.w
                   - clip.x * vec3(projectionMatrix[0][3], projectionMatrix[1][3], projectionMatrix[2][3])) / w2;
        vec3 J1 = (vec3(projectionMatrix[0][1], projectionMatrix[1][1], projectionMatrix[2][1]) * clip.w
                   - clip.y * vec3(projectionMatrix[0][3], projectionMatrix[1][3], projectionMatrix[2][3])) / w2;

        // C = J Σ Jᵀ（2×2 对称）
        float c00 = dot(J0, vec3(v00 * J0.x + v01 * J0.y + v02 * J0.z,
                                 v01 * J0.x + v11 * J0.y + v12 * J0.z,
                                 v02 * J0.x + v12 * J0.y + v22 * J0.z));
        float c01 = dot(J0, vec3(v00 * J1.x + v01 * J1.y + v02 * J1.z,
                                 v01 * J1.x + v11 * J1.y + v12 * J1.z,
                                 v02 * J1.x + v12 * J1.y + v22 * J1.z));
        float c11 = dot(J1, vec3(v00 * J1.x + v01 * J1.y + v02 * J1.z,
                                 v01 * J1.x + v11 * J1.y + v12 * J1.z,
                                 v02 * J1.x + v12 * J1.y + v22 * J1.z));

        // 抗锯齿低通：对角各加 0.3px 的方差（3DGS 论文口径）
        vec2 lp = 2.0 * ${SPLAT_LOW_PASS_PIXELS.toFixed(1)} / uViewport;
        float d00 = c00 + lp.x * lp.x;
        float d11 = c11 + lp.y * lp.y;

        // 2×2 特征分解（解析解）
        float mid = 0.5 * (d00 + d11);
        float halfDiff = 0.5 * (d00 - d11);
        float disc = sqrt(max(halfDiff * halfDiff + c01 * c01, 0.0));
        float l1 = mid + disc;
        float l2 = max(mid - disc, 0.0);
        vec2 e1 = vec2(c01, l1 - d00);
        float elen = length(e1);
        e1 = elen > 1e-20 ? e1 / elen : vec2(1.0, 0.0);
        vec2 e2 = vec2(-e1.y, e1.x);

        vec2 A = e1 * (${SPLAT_SIGMA.toFixed(1)} * sqrt(max(l1, 0.0)));
        vec2 B = e2 * (${SPLAT_SIGMA.toFixed(1)} * sqrt(l2));

        // 两道像素级处理，口径逐字照抄官方顶点着色器：
        //
        // ① 细轴下限：官方 lambda2 = max(mid - radius, 0.1) 对应半轴 0.447px，
        //    只防完全退化，不把 1mm 的薄轴放大成可见的硬点。
        // ② 亚像素剔除：官方 dot(cov.xy,cov.xy) < 4.0 && dot(cov.zw,cov.zw) < 4.0
        //    就 discard。泼溅数据被过度细化时一个像素压着几十个亚像素高斯，
        //    逐个抬成 1px 硬点就是满屏彩色马赛克；丢掉它们，粗层的大高斯接管。
        vec2 pxScale = uViewport * 0.5;
        float la = length(A * pxScale);
        float lb = length(B * pxScale);

        // ③ 上限封顶：必须在下限之前。中心贴近相机平面时雅可比爆炸，半轴能到
        //    几百万像素；等比缩小两根轴（长宽比不变），quad 不再跨满屏。
        //    不封顶的表现就是散落的锐角三角面与放射状拉丝。
        if (uMaxPixels > 0.0) {
          float biggest = max(la, lb);
          if (biggest > uMaxPixels) {
            float k = uMaxPixels / biggest;
            A *= k;
            B *= k;
            la *= k;
            lb *= k;
          }
        }

        if (la < ${SPLAT_MIN_AXIS_PIXELS.toFixed(2)}) {
          A = la > 1e-20 ? A * (${SPLAT_MIN_AXIS_PIXELS.toFixed(2)} / la) : vec2(${(SPLAT_MIN_AXIS_PIXELS * 2).toFixed(2)} / uViewport.x, 0.0);
        }
        if (lb < ${SPLAT_MIN_AXIS_PIXELS.toFixed(2)}) {
          B = lb > 1e-20 ? B * (${SPLAT_MIN_AXIS_PIXELS.toFixed(2)} / lb) : vec2(0.0, ${(SPLAT_MIN_AXIS_PIXELS * 2).toFixed(2)} / uViewport.y);
        }
        if (uCullPixels > 0.0
            && length(A * pxScale) < uCullPixels
            && length(B * pxScale) < uCullPixels) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vQuad = vec2(0.0);
          vColor = vec4(0.0);
          return;
        }

        gl_Position = clip;
        gl_Position.xy += (position.x * A + position.y * B) * clip.w;

        vQuad = position.xy;
        vColor = iColor;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;

      varying vec2 vQuad;
      varying vec4 vColor;

      void main() {
        float r2 = dot(vQuad, vQuad);
        // 3σ 之外直接丢，配合下面的高斯核就是「椭圆边界」而不是硬切一个方框
        if (r2 > 1.0) discard;

        // 高斯核：r=0 时为 1，r=1（3σ）时降到 e^-4 ≈ 0.018
        float alpha = exp(-4.0 * r2) * vColor.a * uOpacity;
        if (alpha < 0.002) discard;

        // 预乘 alpha：混合用 One / OneMinusSrcAlpha
        gl_FragColor = vec4(vColor.rgb * alpha, alpha);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    // 预乘 alpha 混合：src 已经是 rgb*alpha
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    // 泼溅是逐点混合，实例顺序由 SplatSorter 保证 back-to-front；
    // 瓦片之间交给 three 的透明对象排序
    side: THREE.DoubleSide,
  });
}

/**
 * 1×1 的四边形，所有实例共用。
 *
 * ⚠️ 必须是 **6 个顶点（两个三角形）**，不能写成 4 顶点 TRIANGLE_STRIP 那样省两个点：
 * three 的 renderBufferDirect 对 `object.isMesh` 一律 `gl.TRIANGLES`，不看
 * drawMode / 是不是 strip。4 顶点只会画出前 3 个组成的一个三角形 —— 表现就是
 * 满屏三角片、沿对角线的拉丝，而且每个高斯只覆盖了一半面积（叠加起来又是空洞）。
 */
export function createQuadGeometry(): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  // 必须叫 `position` 且是 vec3：three 的 renderBufferDirect 拿它取 drawCount，
  // 找不到就直接 console.error 后 return —— 表现是「瓦片有请求、画面全空」。
  // ShaderMaterial 的顶点前缀会自己声明 `attribute vec3 position`，shader 里不要再写一遍。
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      // 左下→右下→左上 | 左上→右下→右上，两个三角形拼满 [-1,1]²
      new Float32Array([
        -1, -1, 0, 1, -1, 0, -1, 1, 0,
        -1, 1, 0, 1, -1, 0, 1, 1, 0,
      ]),
      3
    )
  );
  // 顶点着色器完全用实例属性定位，包围球无意义；关掉剔除免得整块被误裁
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geo;
}

/**
 * 泼溅网格的 raycast。
 *
 * 原来这里挂的是 `() => {}`（完全不参与射线求交），后果不只是「点不中」：拾取结果里
 * 的精确命中点也拿不到，回退去算 `geometry.boundingBox` —— 而那只是原点处那个
 * 2×2 方块的包围盒，于是返回的经纬度/高程全是错的。
 *
 * 每个高斯近似成一个球，半径取 3σ 里最长的那根轴（跟画面上看到的范围一致）。
 */
export function splatRaycast(
  this: THREE.Mesh,
  raycaster: THREE.Raycaster,
  intersects: THREE.Intersection[]
): void {
  const geo = this.geometry as THREE.InstancedBufferGeometry;
  const center = geo.getAttribute('iCenter');
  const scale = geo.getAttribute('iScale');
  const n = geo.instanceCount ?? 0;
  if (!center || !scale || n <= 0) return;

  const sphere = geo.boundingSphere;
  if (sphere && Number.isFinite(sphere.radius)) {
    _raySphere.copy(sphere).applyMatrix4(this.matrixWorld);
    if (!raycaster.ray.intersectsSphere(_raySphere)) return;
  }

  _rayInv.copy(this.matrixWorld).invert();
  _rayLocal.copy(raycaster.ray).applyMatrix4(_rayInv);
  const o = _rayLocal.origin;
  const d = _rayLocal.direction;

  let bestT = Infinity;
  let bestIdx = -1;
  const ca = center.array as Float32Array;
  const sa = scale.array as Float32Array;

  for (let i = 0; i < n; i++) {
    const cx = ca[i * 3]!;
    const cy = ca[i * 3 + 1]!;
    const cz = ca[i * 3 + 2]!;
    const vx = cx - o.x;
    const vy = cy - o.y;
    const vz = cz - o.z;
    const t = vx * d.x + vy * d.y + vz * d.z;
    if (t <= 0 || t >= bestT) continue;
    // 垂距² 与球半径² 比较：半径 = 3 × 最长轴
    const r = SPLAT_SIGMA * Math.max(sa[i * 3]!, sa[i * 3 + 1]!, sa[i * 3 + 2]!);
    const perp2 = vx * vx + vy * vy + vz * vz - t * t;
    if (perp2 > r * r) continue;
    bestT = t;
    bestIdx = i;
  }
  if (bestIdx < 0) return;

  const point = new THREE.Vector3(
    ca[bestIdx * 3]!,
    ca[bestIdx * 3 + 1]!,
    ca[bestIdx * 3 + 2]!
  ).applyMatrix4(this.matrixWorld);

  intersects.push({
    distance: raycaster.ray.origin.distanceTo(point),
    point,
    object: this,
    instanceId: bestIdx,
  });
}

const _raySphere = new THREE.Sphere();
const _rayInv = new THREE.Matrix4();
const _rayLocal = new THREE.Ray();

/**
 * 泼溅专用的 **拾取材质**（走 GPU 拾取那一趟渲染）。
 *
 * 为什么必须单独做：拾取通道（render/Picker.ts）换的是它自己的通用拾取着色器，
 * 那个着色器只读 `position`，根本不知道 `iCenter`。把泼溅的几何交给它，每个实例
 * 都会塌在模型原点，画出一个 2×2 的像素块 —— 表现就是「模型完全点不中」。
 *
 * 这里只需要把每个高斯的**中心**摊成一个 `PICK_MIN_PIXELS` 半径的屏幕方块，
 * 不需要复刻 EWA（拾取只关心「这个像素属于哪块瓦片」以及谁更近）。颜色编码
 * 与 Picker 的 PICK_FRAG 逐位一致：R/G 存 objectId + 1，B/A 留 0。
 */
export function createSplatPickMaterial(objectId: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uObjectId: { value: objectId },
      uViewport: { value: SPLAT_VIEWPORT },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iCenter;

      uniform vec2 uViewport;

      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(iCenter, 1.0);
        // 相机后方：扔出裁剪体，避免透视除法把方块翻到屏幕另一侧
        if (clip.w <= 0.000001) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        // position ∈ [-1,1]，乘上「半个方块以 ndc 计」的尺寸
        vec2 half2 = (${(PICK_MIN_PIXELS * 2).toFixed(1)} / uViewport);
        gl_Position = clip;
        gl_Position.xy += position.xy * half2 * clip.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uObjectId;

      void main() {
        float o = uObjectId + 1.0;
        gl_FragColor = vec4(mod(o, 256.0) / 255.0, floor(o / 256.0) / 255.0, 0.0, 0.0);
      }
    `,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
  });
}

/** 泼溅实例中心的局部 AABB */
export interface SplatBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  count: number;
}

/**
 * 泼溅的包围盒只能由 `iCenter` 算。
 *
 * geometry 的 `position` 只是 `[-1,1]²` 的四边形角点，真实位置全在实例属性里；
 * 拿 `position` 去 computeBoundingBox 会得到一个跟模型毫无关系的 2m 立方体，
 * 拾取结果里的中心经纬度、包围盒属性就全是错的。
 */
export function splatCenterBounds(geo: THREE.BufferGeometry): SplatBounds | null {
  const attr = geo.getAttribute('iCenter') as THREE.BufferAttribute | undefined;
  if (!attr) return null;
  const a = attr.array as ArrayLike<number>;
  const n = attr.count;
  if (!n) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = a[i * 3]!;
    const y = a[i * 3 + 1]!;
    const z = a[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ, count: n };
}
