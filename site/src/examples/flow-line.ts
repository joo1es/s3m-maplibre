/**
 * 示例：A → B 的三维飞线（流光拖尾）
 *
 * 这个文件**不是库的一部分**，它只为说明 `layer.overlay` 该怎么用。
 * 拆开看只有四步，换成光柱 / 扫描圈 / 车流，改的只有第 2、3 步：
 *
 *   1. 经纬度 → ENU         layer.lngLatToPoint（库提供）
 *   2. 造几何               弧线采样 + buildThickLineGeometry（库提供）+ 自己的 aAlong
 *   3. 造材质               createThickLineMaterial 的片元注入点（不用抄顶点着色器）
 *   4. 挂上去               overlay.add，update 里推进 uTime（库提供）
 *
 * 一个容易踩的点：场景是 **Z-up**（z 是高度），不是 three 默认的 Y-up。
 * 所以自己造几何时坐标按 [东, 北, 高] 给；用 Cylinder/Boc 这类 Y 轴为主轴的
 * 内置几何，要绕 X 转 90° 才立起来。见 range-canopy.ts。
 */
import * as THREE from 'three';
import { buildThickLineGeometry, createThickLineMaterial } from 's3m-maplibre';
import type { LngLatAlt, OverlayHandle, S3MLayer } from 's3m-maplibre';

/**
 * 沿弧长的拖尾。
 *
 * `vAlong` 是顶点在整条线上的归一化位置，`head` 是当前光带头部的位置。
 * 两者相减取 fract，就得到「这个像素落后头部多远」，再用 smoothstep 衰减。
 * 注意 fract 的回绕会让「上一圈」的尾巴出现在 0 附近，这也是要的：
 * 光带跑完一圈接着从头再来，中间不断档。
 */
const FLOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uTrail;
  varying float vAlong;

  void main() {
    float head = fract(uTime * uSpeed);
    float d = fract(head - vAlong);
    float glow = smoothstep(uTrail, 0.0, d);
    float core = smoothstep(0.08, 0.0, d);
    float a = (glow * 0.7 + core) * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * (1.0 + core * 1.2), a);
  }
`;

export interface FlowLineOptions {
  color?: string;
  /** 线宽（屏幕像素，不随距离变细） */
  width?: number;
  /** 弧顶抬升的米数。不传按水平距离的 20% 估 */
  lift?: number;
  /** 采样段数，默认 64。太长会白烧顶点，太短弧线会有折角 */
  steps?: number;
  /** 每秒走完多少比例（0.35 = 约 3 秒一圈） */
  speed?: number;
  /** 拖尾占整条线的比例 */
  trail?: number;
  /**
   * 用宿主的 animator 做一次渐入。
   *
   * 这里演示的是两者的分工：`update` 的 `t` 管「一直在动」（采样时间轴），
   * animator 管「从 A 变到 B」（渐入、涨落、一次性过渡）。
   * 通道要自己 register / unregister，忘了注销就是泄漏。
   */
  fadeIn?: boolean;
}

/** 渐入通道的 key 前缀：卸载时按前缀批量回收，见 clearFlowAnim() */
const FADE_PREFIX = 'overlay.flow.fade.';
let fadeSeq = 0;

/** 一次性回收本示例注册的全部渐入通道（页面销毁时调） */
export function clearFlowAnim(layer: S3MLayer): void {
  layer.viewer.animator.unregisterPrefix(FADE_PREFIX);
}

/** 端点可以写成 [lng, lat]、[lng, lat, alt]，或者 { lng, lat, altitude } */
export type FlowPoint = [number, number] | [number, number, number] | LngLatAlt;

function asLngLatAlt(p: FlowPoint): LngLatAlt {
  return Array.isArray(p) ? { lng: p[0], lat: p[1], altitude: p[2] ?? 0 } : p;
}

/** 两端点之间按正弦抬升取弧线。ENU 是局部平面，线性插值 + 抬升就是视觉上正确的弧 */
function sampleArc(
  layer: S3MLayer,
  from: LngLatAlt,
  to: LngLatAlt,
  lift: number | undefined,
  steps: number
): [number, number, number][] {
  const p0 = layer.lngLatToPoint(from);
  const p1 = layer.lngLatToPoint(to);
  const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const h = lift ?? dist * 0.2;

  const out: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([
      p0[0] + (p1[0] - p0[0]) * t,
      p0[1] + (p1[1] - p0[1]) * t,
      p0[2] + (p1[2] - p0[2]) * t + Math.sin(Math.PI * t) * h,
    ]);
  }
  return out;
}

/**
 * 折线 → 等宽线几何，并为每枚顶点补一个 `aAlong`。
 *
 * `buildThickLineGeometry` 每段吐 4 枚顶点，顺序是 A-、A+、B+、B-，
 * 所以沿弧长参数按 [t0, t0, t1, t1] 填。这个顺序被
 * tests/unit/thick-line-geometry.test.ts 钉住了，改库那边会先红。
 */
function ribbon(points: [number, number, number][]): THREE.BufferGeometry {
  const segCount = points.length - 1;
  const segments = new Float32Array(segCount * 6);
  for (let i = 0; i < segCount; i++) {
    segments.set(points[i], i * 6);
    segments.set(points[i + 1], i * 6 + 3);
  }

  const geo = buildThickLineGeometry(segments);
  const along = new Float32Array(segCount * 4);
  for (let i = 0; i < segCount; i++) {
    const t0 = i / segCount;
    const t1 = (i + 1) / segCount;
    along[i * 4] = t0;
    along[i * 4 + 1] = t0;
    along[i * 4 + 2] = t1;
    along[i * 4 + 3] = t1;
  }
  geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  return geo;
}

/**
 * 加一条飞线。
 *
 * 用**工厂模式**挂在 overlay 上：几何里的坐标是烘死的 ENU，锚点一变就得重造，
 * 所以 `object` 传函数而不是现成对象。材质留在工厂外面，重建时复用 ——
 * 不然每次重锚 `uTime` 都会归零，光带会闪一下。
 */
export function addFlowLine(
  layer: S3MLayer,
  from: FlowPoint,
  to: FlowPoint,
  opts: FlowLineOptions = {}
): OverlayHandle {
  const a = asLngLatAlt(from);
  const b = asLngLatAlt(to);

  const material = createThickLineMaterial(
    layer.viewer.lineShared,
    { color: opts.color ?? '#4ad8ff', width: opts.width ?? 4 },
    undefined,
    undefined,
    {
      attributeDeclarations: 'attribute float aAlong;',
      varyingDeclarations: 'varying float vAlong;',
      vertexTail: 'vAlong = aAlong;',
      fragmentShader: FLOW_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: opts.speed ?? 0.35 },
        uTrail: { value: opts.trail ?? 0.3 },
      },
    }
  );

  // 渐入用宿主 animator：它管「从 A 变到 B」，且 patch 时的 onActive 会自动踢起帧循环
  let fade = opts.fadeIn ? 0 : 1;
  const fadeKey = `${FADE_PREFIX}${fadeSeq++}`;

  const handle = layer.overlay.add({
    // anchor 只用来感知「锚点变了没有」，几何已经自带 ENU 坐标，不会再被平移
    anchor: a,
    object: () => {
      const mesh = new THREE.Mesh(ribbon(sampleArc(layer, a, b, opts.lift, opts.steps ?? 64)), material);
      // 几何是逐帧可重建的，包围球不一定准，交给宿主裁剪
      mesh.frustumCulled = false;
      return mesh;
    },
    onRemove: (obj) => {
      (obj as THREE.Mesh).geometry.dispose();
      // 通道必须注销，否则 animator 里会一直留着一个没人读的 track
      if (opts.fadeIn) layer.viewer.animator.unregister(fadeKey);
    },
    update: ({ t }) => {
      material.uniforms.uTime.value = t;
      material.uniforms.uOpacity.value = fade;
    },
  });

  if (opts.fadeIn) {
    const animator = layer.viewer.animator;
    animator.register(fadeKey, {
      dim: 1,
      read: (out) => {
        out[0] = fade;
      },
      write: (v) => {
        fade = v[0];
      },
    });
    animator.to(fadeKey, 1, { duration: 900, easing: 'easeOutCubic' });
  }

  return handle;
}
