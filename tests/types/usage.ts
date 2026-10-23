/**
 * 类型用例：这个文件不参与运行，只用来让 tsc 校验「源码即类型」的准确性。
 * 任何一处类型对不上，`npm run typecheck` 就会失败。
 */
import type { BufferGeometry } from 'three';
import {
  S3MLayer,
  S3MTileset,
  STYLE,
  STYLE_LABELS,
  parseS3MB,
  resolveFeature,
  measureSegments,
  buildAttributes,
  type PickResult,
  type S3MStyle,
  type Stats,
  type S3MDatasetEntry,
  type MapLike,
  type MapMouseEventLike,
} from '../../src/index.js';

/* ---------------- 宿主适配：MapLibre / Mapbox 的结构化断言 ---------------- */

/** 模拟 maplibre-gl / mapbox-gl 的 Map 上我们用到的那部分 */
interface HostMap {
  getCanvas(): HTMLCanvasElement;
  triggerRepaint(): void;
  on(type: string, listener: (e: MapMouseEventLike) => void): unknown;
  off(type: string, listener: (e: MapMouseEventLike) => void): unknown;
  getBearing(): number;
  getFreeCameraOptions(): { position?: { x: number; y: number; z: number } | null } | null;
  transform: { fov: number };
}

/** 模拟两家的 CustomLayerInterface 交集（v4 的 array 矩阵 / v5 的 options 对象 / Mapbox 的 mat4） */
interface HostCustomLayer {
  id: string;
  type: 'custom';
  renderingMode?: '2d' | '3d';
  onAdd(map: HostMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void;
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: number[]): void;
  onRemove(map: HostMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void;
}

declare const map: HostMap;
declare const gl: WebGL2RenderingContext;

/* ---------------- 构造 ---------------- */

const layer = new S3MLayer({
  id: 's3m',
  datasets: [
    { id: 'jingmo', name: '精模', configUrl: 'https://host/jingmo.scp' },
    { id: 'zhoubian', configUrl: 'https://host/zhoubian.scp', visible: false, maxTiles: 24 },
  ],
  maxTiles: 48,
  maxConcurrent: 3,
  style: { mode: STYLE.WHITE, opacity: 0.9, shading: 'flat', floorHeight: 3.3 },
  onStats: (s: Stats) => s.triangles.toFixed(0),
  onReady: (e: S3MDatasetEntry) => e.offset[0],
  onPick: (f: PickResult | null) => {
    if (f) {
      // 单体属性字段都应该是可选的
      const h: number | undefined = f.height;
      const c: [number, number] | null = f.centerLngLat;
      const smid: number | null = f.smid;
      return [h, c, smid];
    }
    return null;
  },
  onError: (e: unknown) => console.error(e),
});

/* ---------------- 宿主兼容：可当 CustomLayerInterface 用 ---------------- */

const asHostLayer: HostCustomLayer = layer;
const asMapLike: MapLike = map;
void asHostLayer;
void asMapLike;

/* ---------------- 生命周期 ---------------- */

layer.onAdd(map, gl);
layer.render(gl, new Float32Array(16));
layer.render(gl, { defaultProjectionData: { mainMatrix: new Float64Array(16) } });
layer.onRemove();

/* ---------------- 数据集 ---------------- */

void layer.addDataset({ id: 'cheng', configUrl: 'https://host/cheng.scp' }).then((e) => e.tileset?.stats.tiles);
layer.setDatasetVisible('cheng', false);
layer.removeDataset('cheng');
layer.datasets.get('jingmo')?.root.visible;

/* ---------------- 样式 ---------------- */

const patch: Partial<S3MStyle> = { mode: STYLE.HEIGHT, colorA: '#fff', colorB: '#0369a1' };
layer.setStyle(patch);
const label: string = layer.getStyle().modeLabel;
const modeLabel: string = STYLE_LABELS[STYLE.BATCH];
layer.setEdges(true);

/* ---------------- 拾取 ---------------- */

const hit: PickResult | null = layer.pick(120, 300);
if (hit) {
  hit.batchId.toFixed(0);
  hit.mesh.visible = false;
  layer.select(hit);
}
layer.select(null, { silent: true });

const bounds: [[number, number], [number, number]] | null = layer.getBounds();
const fps: number = layer.fps;
const stats: Stats = layer.stats;

/* ---------------- 瓦片集 ---------------- */

const tileset = new S3MTileset({
  configUrl: 'https://host/x.scp',
  onTile: (node) => node.childUrl?.length,
});
void tileset.init().then((ts) => ts.anchor.lon);
tileset.update([0, 0, 400], 0.64, 900);
tileset.dispose();

/* ---------------- 解析层 ---------------- */

declare const buffer: ArrayBuffer;
declare const geometry: BufferGeometry;
void parseS3MB(buffer).then((tile) => {
  const name = Object.keys(tile.geoPackage)[0];
  const geo = tile.geoPackage[name];
  const { smid, segments } = resolveFeature(geo, 3);
  const box = measureSegments(geometry, segments);
  return buildAttributes({ smid, box, triangles: 12, floorHeight: 3.2 }).height;
});

export { label, modeLabel, bounds, fps, stats };
