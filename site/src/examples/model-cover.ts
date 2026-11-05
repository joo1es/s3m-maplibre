/**
 * 示例：给整个模型套一个半透明罩子。
 *
 * 这个文件**不是库的一部分**，它演示 `layer.overlay` 用在一个很常见的诉求上：
 * 把当前加载的模型整体罩起来（隔离舱 / 玻璃罩 / 管控范围）。
 *
 * 四件事值得注意：
 *
 * 1. **包围盒直接从 `layer.getBounds()` 拿**，再换算成 ENU 米制宽度与深度。
 *    不用遍历网格算 `Box3`：那样得到的是「已加载瓦片」的包围盒，LOD 一变尺寸就跟着
 *    变；geoBounds 是数据集配置里的范围，稳定。
 *
 * 2. **方罩不用旋转**。`BoxGeometry(w, d, h)` 的三个参数就是 x/y/z，而场景是 Z-up
 *    （x 东、y 北、z 高），天然对齐。圆柱才需要绕 X 转 90°，因为它的主轴是 y。
 *
 * 3. **高度用 `scale.z` 而不是重建几何**：几何按单位高度建一次，滑块拖动时只改
 *    scale 与位置，不产生新的 BufferGeometry。
 *
 * 4. **两层 group**：外层 `base` 承接数据集的垂直偏移，内层 `body` 承接「抬到 h/2」。
 *    分成两层是因为 `content` 的 transform 底座不碰，留给使用者自己用；把两件事写在
 *    同一个对象上，拖高度滑块时就会把数据集偏移覆盖掉。
 */
import * as THREE from 'three';
import type { OverlayHandle, S3MLayer } from 's3m-maplibre';

export interface ModelCoverOptions {
  /** 罩子高度（米），默认 200 */
  height?: number;
  /** 填充不透明度 0~1，默认 0.16 */
  opacity?: number;
  color?: string;
  /** 相对包围盒外扩的比例，默认 0.08（贴着模型会 z-fighting） */
  padding?: number;
}

export interface ModelCover {
  handle: OverlayHandle;
  /** 罩子的水平尺寸（米），UI 上可以显示出来 */
  size: { width: number; depth: number };
  setHeight(height: number): void;
  setOpacity(opacity: number): void;
  /** 跟着数据集垂直偏移走。拖动高程滑块时调它，不要重建整条覆盖物 */
  setBaseHeight(z: number): void;
}

/**
 * 数据集当前的**最终**垂直偏移（对齐基准 + 用户手动偏移）。
 *
 * 不能用 `layer.getDatasetHeight()`：它只返回 `userOffset`，切到 top / bottom / center
 * 之后模型会动，而罩子会留在原地。这里取 `heightOffset`，它是两者之和。
 */
export function datasetBaseHeight(layer: S3MLayer): number {
  const firstId = layer.datasets.keys().next().value as string | undefined;
  const total = firstId ? layer.datasets.get(firstId)?.heightOffset : 0;
  return Number.isFinite(total) ? (total as number) : 0;
}

/**
 * 给当前所有已加载数据集的并集套一个罩子。
 *
 * 没有数据集时返回 null —— 调用方要处理这个分支，别假设一定能建出来。
 */
export function addModelCover(layer: S3MLayer, opts: ModelCoverOptions = {}): ModelCover | null {
  const bounds = layer.getBounds();
  if (!bounds) return null;

  const padding = opts.padding ?? 0.08;
  const height = Math.max(1, opts.height ?? 200);
  const opacity = opts.opacity ?? 0.16;
  const color = new THREE.Color(opts.color ?? '#38bdf8');

  // geoBounds → 两个对角的 ENU 坐标，取绝对差就是模型的实际宽深
  const [[westLng, southLat], [eastLng, northLat]] = bounds;
  const sw = layer.lngLatToPoint({ lng: westLng, lat: southLat, altitude: 0 });
  const ne = layer.lngLatToPoint({ lng: eastLng, lat: northLat, altitude: 0 });
  const width = Math.abs(ne[0] - sw[0]) * (1 + padding);
  const depth = Math.abs(ne[1] - sw[1]) * (1 + padding);

  const fill = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    // 半透明体不写深度：否则前后两面互相遮挡，会看到一圈黑边
    depthWrite: false,
  });
  const line = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: Math.min(1, opacity * 3),
  });

  // 单位高度建一次，高度靠 scale.z 伸缩
  const box = new THREE.BoxGeometry(width, depth, 1);
  const edges = new THREE.EdgesGeometry(box);

  // 外层：数据集垂直偏移。内层：抬到 h/2 并纵向伸缩
  const base = new THREE.Group();
  const body = new THREE.Group();
  body.add(new THREE.Mesh(box, fill));
  body.add(new THREE.LineSegments(edges, line));
  base.add(body);
  base.position.z = datasetBaseHeight(layer);

  const applyHeight = (h: number): void => {
    body.scale.z = h;
    // 几何中心在原点，抬到 h/2 才让底面落在模型底部
    body.position.z = h / 2;
  };
  applyHeight(height);

  const handle = layer.overlay.add({
    anchor: { lng: (westLng + eastLng) / 2, lat: (southLat + northLat) / 2, altitude: 0 },
    object: base,
    // 罩子该被楼挡住；'always' 会让它盖在所有东西前面，像一块贴纸
    depth: 'occluded',
    onRemove: () => {
      box.dispose();
      edges.dispose();
      fill.dispose();
      line.dispose();
    },
  });

  return {
    handle,
    size: { width, depth },
    // 三个 setter 结尾都要 requestRepaint：罩子是静态覆盖物（没给 update），不参与
    // 帧循环，地图空闲时不产生新帧 —— 只改 scale / opacity 而不请求重绘，拖滑块
    // 会「看着没反应」，实际上值已经写进去了
    setHeight: (h) => {
      applyHeight(Math.max(1, h));
      handle.requestRepaint();
    },
    setOpacity: (o) => {
      fill.opacity = o;
      line.opacity = Math.min(1, o * 3);
      handle.requestRepaint();
    },
    setBaseHeight: (z) => {
      base.position.z = z;
      handle.requestRepaint();
    },
  };
}
