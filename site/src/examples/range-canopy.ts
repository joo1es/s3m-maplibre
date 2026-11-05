/**
 * 示例：给一个位置套范围罩子（半透明圆柱 / 方柱 + 地面圈）
 *
 * 这个文件**不是库的一部分**，只为说明 `layer.overlay` 怎么用。
 * 罩子就是普通的 three 几何，底座完全不需要知道它是罩子。
 *
 * 关键在坐标系：场景是 **Z-up**（z = 高度），而 three 的 CylinderGeometry /
 * BoxGeometry 主轴是 Y。不转 90° 的话罩子是躺在地上的 —— 这是自己造几何时
 * 最容易忽略的一步。
 *
 * 想套在某个 S3M 单体上，把 `center` 换成
 * `layer.getFeatureBounds(smid)` 算出的经纬度中心即可；高度它不给，自己传。
 */
import * as THREE from 'three';
import type { LngLatAlt, OverlayHandle, S3MLayer } from 's3m-maplibre';

export interface CanopyOptions {
  /** 半径（米），圆柱的外径 / 方柱的半边长 */
  radius: number;
  /** 高度（米） */
  height: number;
  /** 'cylinder' 圆罩 | 'box' 方罩 */
  shape?: 'cylinder' | 'box';
  color?: string;
  opacity?: number;
}

export function addRangeCanopy(
  layer: S3MLayer,
  center: [number, number, number] | LngLatAlt,
  opts: CanopyOptions
): OverlayHandle {
  const { radius, height, shape = 'cylinder', color = '#38bdf8', opacity = 0.16 } = opts;

  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    // 半透明罩子不写深度，否则顶盖、侧面、地面圈会互相遮挡出黑边
    depthWrite: false,
  });

  // 侧面（openEnded：不要顶底盖，否则看进去是一堵实心墙）
  const shell =
    shape === 'box'
      ? new THREE.BoxGeometry(radius * 2, height, radius * 2, 1, 1, 1)
      : new THREE.CylinderGeometry(radius, radius, height, 64, 1, true);

  const side = new THREE.Mesh(shell, material);
  // three 的 Y 轴 → 场景的 Z 轴（Z-up）
  side.rotation.x = Math.PI / 2;

  const group = new THREE.Group();
  group.add(side);

  // 地面圈：RingGeometry 本来就在 XY 平面，法线是 +Z，Z-up 下正好水平
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.94, radius, 64),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: Math.min(1, opacity * 4),
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  // 抬 0.3 米避开与地表的 z-fighting（贴地面绘制都得这么干）
  ring.position.z = -height / 2 + 0.3;
  group.add(ring);

  return layer.overlay.add({
    anchor: center,
    object: group,
    // 几何以中心为原点，抬到 h/2 让底面贴地
    offset: [0, 0, height / 2],
    // 罩子该被楼挡住，用默认的 occluded；'always' 会穿模
    depth: 'occluded',
    onRemove: () => {
      shell.dispose();
      ring.geometry.dispose();
      material.dispose();
      (ring.material as THREE.Material).dispose();
    },
  });
}
