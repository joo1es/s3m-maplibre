/**
 * `S3MViewer` 的公共 API 表面快照 —— 拆分重构的安全网。
 *
 * 背景：`S3MViewer` 要按模块拆（render/viewer/*），但 `S3MLayer` 用了它 **110 个成员**，
 * demo 也在用。拆分的硬约束是「公共面一个字都不改」，靠人眼 review diff 保证不了，
 * 只能靠这份快照。
 *
 * 这里钉三件事：
 *   1. `prototype` 上的公共方法（含 getter/setter）名单；
 *   2. 实例上的公共字段名单；
 *   3. 那些**下划线但被外部依赖**的成员（`S3MLayer` 与既有单测直接用）。
 *
 * 注意第 3 条是白名单而不是全量快照：私有方法本来就该在拆分中搬家，
 * 全量快照会逼着每个私有成员都留在主类上，反而把 facade 撑大。
 *
 * 拆分过程中如果这个测试红了，说明公共面真的变了 —— 不要改快照，改代码。
 */
import { describe, expect, test } from 'bun:test';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

/** 拆分前（0.4.19）的公共方法表，顺序无关 */
const PUBLIC_METHODS = [
  'addDataset', 'animateFeature', 'animateFeatures', 'anisotropyCap', 'auditBatches',
  'bindGPUPath', 'clearCreases', 'clearDatasets', 'clearFeatureStyles', 'clearFieldFilter',
  'clearFilter', 'clearThematic', 'clearThematicElevation', 'colorByField', 'colorPipeline',
  'computeAlignOffset',
  'crossFadeStyles', 'datasets', 'dispose', 'drillPick', 'elevateByField',
  'filterByField', 'flushOverrides', 'followPath', 'fps', 'getAllMeshes',
  'getBounds', 'getDatasetHeight', 'getElevationField', 'getFeatureBounds', 'getFeatureStyle',
  'getFeatureStyles', 'getFilter', 'getFilterField', 'getGPUPathManager', 'getGPUPathTime',
  'getLight', 'getLoadedSmids', 'getRayAt', 'getStyle', 'getThematicField',
  'getToneMapping', 'loadCreases', 'lodPixelRatioCap', 'lodRangeScale', 'materialQuality',
  'maxImageCache', 'maxMemory', 'maxTextureSize', 'maxTriangles', 'mount', 'moveFeature',
  'moveFeatureBy', 'pick', 'pickPosition', 'prewarmShading', 'recomputeAnchors',
  'registerGPUPath', 'removeDataset', 'removeFeatureStyle', 'renderFrame', 'restoreContext',
  'rotateFeature', 'rotateFeatureBy', 'sceneAnchor', 'select',   'setAnisotropyCap', 'setAttributeSource', 'setColorPipeline', 'setDatasetAlign', 'setDatasetHeight', 'setDatasetVisible', 'setEdges',
  'setEnvironment', 'setExcavationBounds', 'setFeatureStyle', 'setFeaturesStyle', 'setFilter',
  'setGPUPathProgress', 'setGPUPathTime', 'setGroundMode', 'setGroundOcclude', 'setGroundOpacity',
  'setLight', 'setLightingPreset', 'setLodPixelRatioCap', 'setLodRangeScale', 'setMaterialQuality',
  'setMaxImageCache', 'setMaxMemory', 'setMaxTextureSize', 'setMaxTriangles', 'setMode', 'setOpacity',
  'setStyle', 'setThematicColors', 'setThematicElevation', 'setToneMapping', 'stats',
  'stopPath', 'triggerRepaint', 'unbindGPUPath', 'unmount', 'unregisterGPUPath',
].sort();

/** 公共实例字段（构造后即可读的那些） */
const PUBLIC_FIELDS = [
  'animator', 'attributeQuery', 'camera', 'canvas', 'edgeMaterial', 'geo', 'gpuPathManager',
  'groundManager', 'lineShared', 'onError', 'onPick', 'onReady', 'onStats', 'options',
  'outlineMaterial', 'pickable', 'picker', 'renderer', 'scene', 'selectionEdgeMaterial',
  'style', 'uniforms',
].sort();

/**
 * 下划线成员的白名单：`S3MLayer` 或既有单测直接摸的那些。
 * 拆分时它们可以搬到子模块，但主类必须留一个同名转发（值或方法），否则外部立刻炸。
 */
const INTERNAL_USED = [
  // S3MLayer 直接用
  '_applyOverridesToMesh', '_datasetManager', '_getBearing',
  // 既有单测直接用（edge / lighting / vram / context-restore）
  '_ambientLight', '_fillLight', '_keyLight', '_updateLights',
  '_lodScreenHeight', '_registerTile', '_unregisterTile',
  '_selection', '_selectedMeshes',
];

describe('S3MViewer 公共 API 表面', () => {
  test('公共方法表与拆分前一致', () => {
    const actual = Object.getOwnPropertyNames(S3MViewer.prototype)
      .filter((n) => n !== 'constructor' && !n.startsWith('_'))
      .sort();
    expect(actual).toEqual(PUBLIC_METHODS);
  });

  test('公共实例字段与拆分前一致', () => {
    const actual = Object.getOwnPropertyNames(new S3MViewer())
      .filter((n) => !n.startsWith('_'))
      .sort();
    expect(actual).toEqual(PUBLIC_FIELDS);
  });

  test('被外部依赖的内部成员仍然可达', () => {
    const v = new S3MViewer();
    const protoNames = new Set(Object.getOwnPropertyNames(S3MViewer.prototype));
    const missing = INTERNAL_USED.filter((name) => !protoNames.has(name) && !(name in v));
    expect(missing).toEqual([]);
  });
});
