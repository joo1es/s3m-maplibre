/**
 * #29 拾取粗筛：判断「这块几何的包围球投影有没有可能盖住点击像素」。
 *
 * GPU picking 是把 pickId 渲到 1×1 的离屏目标上读一个像素，片元开销已经压到最小，
 * 但 `renderer.render(scene, camera)` 仍然要提交场景里所有 mesh 的 draw call
 * （瓦片网格一律 `frustumCulled = false`）。这里做的就是把确定不可能在这个像素上
 * 产生片元的网格摘掉。
 *
 * ## 为什么用「外接立方体 8 角点投影的 AABB」
 *
 * 球在透视投影下的轮廓是椭圆，直接拿球心 + 半径估屏幕半径会切掉边缘。
 * 改成把球的轴对齐外接立方体 8 个角点全部投到 NDC 再取 AABB：射影变换在 w>0
 * 的区域保持凸性与包含关系，外接立方体包含球，所以这个 AABB 一定包住球的投影。
 * 宁可多算一点范围，也不能漏拾取。
 *
 * ## 相机矩阵的特殊口径
 *
 * `S3MViewer.renderFrame` 把 `camera.projectionMatrix` 整个换成了宿主的
 * world→clip（MVP×ENU），`matrixWorldInverse` 只是相机平移的逆。**不能**用
 * three 的 `project()` / `unproject()`，那会再乘一次视图矩阵。这里只认传进来的
 * `worldToClip`，调用方直接传 `camera.projectionMatrix`。
 *
 * 纯函数，不碰 WebGL，可单测。
 */
import type * as THREE from 'three';

/**
 * @returns true = 可能覆盖（这一趟必须画）；false = 确定盖不到（可以跳过）
 */
export function sphereMayCoverNdcPoint(
  center: THREE.Vector3,
  radius: number,
  worldToClip: THREE.Matrix4,
  ndcX: number,
  ndcY: number,
  margin = 0
): boolean {
  // 数据不可信时一律保守：宁可多画几个 draw call，也不能点不中
  if (!Number.isFinite(radius) || radius < 0) return true;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) return true;
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return true;
  if (!Number.isFinite(margin)) return true; // Infinity / NaN = 不设边界，全部保留
  const pad = margin > 0 ? margin : 0;

  const e = worldToClip.elements;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < 8; i++) {
    const x = center.x + ((i & 1) ? radius : -radius);
    const y = center.y + ((i & 2) ? radius : -radius);
    const z = center.z + ((i & 4) ? radius : -radius);
    // Vector4(x,y,z,1) 乘列主序矩阵的 x / y / w 三行
    const cx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
    const cy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
    const cw = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
    // 角点跨到相机背后 / 近裁剪面上时，射影变换不再保持包含关系，整块保留
    if (!Number.isFinite(cw) || cw <= 0) return true;
    const nx = cx / cw;
    const ny = cy / cw;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return true;
    if (nx < minX) minX = nx;
    if (nx > maxX) maxX = nx;
    if (ny < minY) minY = ny;
    if (ny > maxY) maxY = ny;
  }

  return ndcX >= minX - pad && ndcX <= maxX + pad && ndcY >= minY - pad && ndcY <= maxY + pad;
}

type MaybeUniform = { value?: unknown } | undefined;

function numOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 主材质有没有「顶点在 shader 里被改写」的可能。
 *
 * 有位移时 CPU 侧的 `geometry.boundingSphere` 就不代表实际画面位置，粗筛必须整块跳过：
 * 单体状态纹理（平移 / 旋转 / 抬高 / 隐藏）、GPU 路径动画、交叉淡化的第二张纹理、
 * 选中拔高，都会让顶点跑出原始包围球。判据只认「是否启用」，不猜位移量级。
 *
 * 与 `Picker` 抄 uniform 的口径一致：材质数组只看第一个。
 */
export function hasPickDisplacement(
  material: THREE.Material | THREE.Material[] | null | undefined
): boolean {
  if (!material) return true;
  const first = Array.isArray(material) ? material[0] : material;
  if (!first) return true;
  const m = first as THREE.Material & {
    userData?: Record<string, MaybeUniform>;
    uniforms?: Record<string, MaybeUniform>;
  };
  // 绝大多数材质把共享 IUniform 挂在 userData 上（StyleMaterial.createStyledMaterial），
  // ShaderMaterial 自身也有 uniforms；两处都看，任一非 0 就算有位移。
  const active = (key: string): number =>
    numOf(m.userData?.[key]?.value) || numOf(m.uniforms?.[key]?.value);
  if (active('uBatchTexActive') > 0) return true;
  if (active('uPathTexActive') > 0) return true;
  if (active('uBatchMix') > 0) return true;
  if (active('uSelElevation') !== 0) return true;
  return false;
}
