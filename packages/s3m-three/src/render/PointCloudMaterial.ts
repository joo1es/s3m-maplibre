/**
 * 点云着色
 *
 * 点云没有法线、没有 uv、没有楼层概念，所以 StyleMaterial 那套按面着色的模式
 * （顶/侧分色、按楼层、动态扫描…）对 `THREE.Points` 天然不适用。这里只做三种
 * 点云真正能表达的模式，其余一律回退顶点色：
 *
 *   vertex  原色：顶点色上屏（Draco 点云在解析阶段已把分类码烘成分类色带）
 *   solid   单色：整个点云一个颜色
 *   height  按高度：顶点世界坐标 z 在 uColorA → uColorB 之间连续渐变
 *   selected 选中高亮：整块点云混成 uSelColor（点云没有单体粒度，只能整块亮）
 *
 * 两个设计要点：
 *   1. height / selected 的 ShaderMaterial 直接**引用**全局共享 uniform 对象
 *      （`shared.uColorA` 等），所以 `_applyStyleUniforms()` 改一次颜色，
 *      点云渐变自动跟着变，不需要额外同步。
 *   2. 材质由本模块按 mode 创建并打上 `pcOwned` 标记，换 mode 时旧的自己
 *      销毁；GeometryBuilder 里那个共享单例没有标记，替换时不碰它。
 */
import * as THREE from 'three';
import { STYLE, type S3MStyle, type StyleMode } from './StyleMaterial.js';
import type { StyleUniforms } from '../core/types.js';

/** 点云实际持有的材质形态 */
export type PointCloudKind = 'vertex' | 'solid' | 'height' | 'selected';

/** 与 GeometryBuilder 里共享 PointsMaterial 保持同一个点尺寸（屏幕像素，不衰减） */
const POINT_SIZE = 2;

/** S3M 着色模式 → 点云形态。不适用于点云的模式统一回退顶点色。 */
export function pointCloudKindOf(mode: StyleMode): 'vertex' | 'solid' | 'height' {
  if (mode === STYLE.SOLID) return 'solid';
  if (mode === STYLE.HEIGHT) return 'height';
  return 'vertex';
}

/* ------------------------------------------------------------------ 着色器 */

const POINT_VERT = /* glsl */ `
  uniform float uPointSize;
  varying float vWorldZ;
  void main() {
    vec4 world = modelMatrix * vec4( position, 1.0 );
    vWorldZ = world.z;
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_PointSize = uPointSize;
  }
`;

const HEIGHT_FRAG = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uHeightMin;
  uniform float uHeightMax;
  uniform float uOpacity;
  varying float vWorldZ;
  void main() {
    float h = clamp( ( vWorldZ - uHeightMin ) / max( uHeightMax - uHeightMin, 0.001 ), 0.0, 1.0 );
    gl_FragColor = vec4( mix( uColorA, uColorB, h ), uOpacity );
  }
`;

const SELECTED_FRAG = /* glsl */ `
  uniform vec3 uSelColor;
  uniform float uOpacity;
  void main() {
    gl_FragColor = vec4( uSelColor, uOpacity );
  }
`;

function createPointCloudMaterial(
  kind: PointCloudKind,
  style: S3MStyle,
  shared: StyleUniforms
): THREE.Material {
  let mat: THREE.Material;
  if (kind === 'height') {
    mat = new THREE.ShaderMaterial({
      uniforms: {
        // 直接引用共享 uniform 对象：换色不用重建材质
        uColorA: shared.uColorA,
        uColorB: shared.uColorB,
        uHeightMin: shared.uHeightMin,
        uHeightMax: shared.uHeightMax,
        uPointSize: { value: POINT_SIZE },
        uOpacity: { value: style.opacity ?? 1 },
      },
      vertexShader: POINT_VERT,
      fragmentShader: HEIGHT_FRAG,
      transparent: (style.opacity ?? 1) < 0.999,
      depthWrite: (style.opacity ?? 1) >= 0.999,
    });
  } else if (kind === 'selected') {
    mat = new THREE.ShaderMaterial({
      uniforms: {
        uSelColor: shared.uSelColor,
        uPointSize: { value: POINT_SIZE },
        uOpacity: { value: style.opacity ?? 1 },
      },
      vertexShader: POINT_VERT,
      fragmentShader: SELECTED_FRAG,
      transparent: (style.opacity ?? 1) < 0.999,
      depthWrite: (style.opacity ?? 1) >= 0.999,
    });
  } else if (kind === 'solid') {
    mat = new THREE.PointsMaterial({
      size: POINT_SIZE,
      sizeAttenuation: false,
      color: new THREE.Color(style.colorA),
      transparent: (style.opacity ?? 1) < 0.999,
      opacity: style.opacity ?? 1,
      depthWrite: (style.opacity ?? 1) >= 0.999,
    });
  } else {
    mat = new THREE.PointsMaterial({
      size: POINT_SIZE,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: (style.opacity ?? 1) < 0.999,
      opacity: style.opacity ?? 1,
      depthWrite: (style.opacity ?? 1) >= 0.999,
    });
  }
  (mat.userData as { pcOwned?: boolean }).pcOwned = true;
  return mat;
}

/**
 * 把点云对象的材质同步到当前样式。
 *
 * kind 没变就只改不透明度 / 单色色值，不重建材质；变了才换，旧的自己销毁。
 * 每次 setStyle 都会走到这里，代价是一次属性比较。
 */
export function applyPointCloudStyle(
  points: THREE.Points,
  style: S3MStyle,
  shared: StyleUniforms,
  selected = false
): void {
  const ud = points.userData as { pcKind?: PointCloudKind; pcTransparent?: boolean };
  const want: PointCloudKind = selected ? 'selected' : pointCloudKindOf(style.mode);

  if (ud.pcKind !== want) {
    const prev = points.material as THREE.Material | undefined;
    points.material = createPointCloudMaterial(want, style, shared);
    // 只销毁自己创建的；GeometryBuilder 的共享单例没有 pcOwned 标记，不能碰
    if (prev && (prev.userData as { pcOwned?: boolean } | undefined)?.pcOwned) prev.dispose();
    ud.pcKind = want;
    ud.pcTransparent = undefined;
  } else if (want === 'solid') {
    (points.material as THREE.PointsMaterial).color?.set(style.colorA);
  }

  const o = Math.min(1, Math.max(0.05, style.opacity ?? 1));
  const transparent = o < 0.999;
  const keepDepth = style.depthWrite !== false;
  const mat = points.material as THREE.Material & { uniforms?: Record<string, { value: unknown }> };
  mat.transparent = transparent;
  mat.opacity = o;
  mat.depthWrite = transparent ? keepDepth : true;
  // ShaderMaterial 的 .opacity 不参与渲染，透明度走自己的 uniform
  if (mat.uniforms?.uOpacity) mat.uniforms.uOpacity.value = o;
  // 只有混合开关真变了才标记重编译，避免每次 setStyle 都重编一遍
  if (ud.pcTransparent !== transparent) {
    ud.pcTransparent = transparent;
    mat.needsUpdate = true;
  }
}

/** 点云对象是否由本模块持有材质（卸载时用来决定要不要 dispose） */
export function isOwnedPointCloudMaterial(mat: THREE.Material | THREE.Material[] | undefined): boolean {
  const m = Array.isArray(mat) ? mat[0] : mat;
  return !!m && (m.userData as { pcOwned?: boolean } | undefined)?.pcOwned === true;
}
