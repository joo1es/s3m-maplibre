/**
 * `S3MViewer` 与 `viewer/TileRegistry.ts` 共用的材质 / 对象判定小工具。
 *
 * 这四样原本是 `S3MViewer.ts` 的顶层私有函数，瓦片注册搬出去之后两边都要用，
 * 所以抬成共享模块（issue #27 第二轮）。都是纯函数，没有状态。
 */
import type * as THREE from 'three';
import type { StyledMaterial } from '../StyleMaterial.js';

export function styledMaterialOf(mesh: THREE.Mesh): StyledMaterial | null {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const styled = m as StyledMaterial | undefined;
  return styled?.userData?.isStyled ? styled : null;
}

/** 点云是 THREE.Points 不是 Mesh，样式 / 拾取 / 卸载链路都靠这个判定放行 */
export function isPointCloudObject(o: THREE.Object3D): o is THREE.Points {
  return (o as unknown as THREE.Points).isPoints === true;
}

/**
 * 全局透明度钳到 [0, 1]，**允许到 0**。
 *
 * 以前这里有个 0.05 下限，本意是「别让整层彻底看不见、又还在挡东西」。但那个问题
 * 真正的来源不是透明度，而是「透明物体仍然写深度」：全透明还写深度就会在底图上挖洞。
 * 现在到 0 时 `renderFrame()` 直接跳过绘制（不写颜色也不写深度），语义就干净了。
 */
export function clampOpacity(v: number | null | undefined): number {
  const n = v ?? 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 低于这个透明度就当作完全不可见：跳过绘制，避免全透明物体写深度 */
export const OPACITY_EPS = 1e-3;

