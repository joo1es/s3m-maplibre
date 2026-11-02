/**
 * 深度模式单测（depthMode: 'scene' | 'clear' | 'auto'）
 *
 * 对应 issue #13：
 *   - 离散对象（建筑、管线、BIM）：'scene'，保留场景深度，被宿主地形正确遮挡（默认，行为逐字一致）
 *   - 地面类（贴地倾斜摄影、大范围 DEM 化模型）：'clear'，先清深度再画，消除与宿主 DEM 的 z-fighting
 *   - 'auto'：按数据特征推断（有 ground 覆盖 / OSGB 倾斜摄影 / 地面类数据集 → 'clear'，否则 'scene'）
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer, type DepthMode, normalizeDepthMode } from '../../packages/s3m-three/src/render/S3MViewer';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';

interface GlCall {
  method: string;
  args: unknown[];
}

function makeMockViewer(opts: Record<string, unknown> = {}) {
  const v = new S3MViewer(opts as ConstructorParameters<typeof S3MViewer>[0]);
  v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };

  const calls: GlCall[] = [];
  const DEPTH_BUFFER_BIT = 0x00000100;
  const COLOR_BUFFER_BIT = 0x00004000;

  const mockGl = {
    DEPTH_BUFFER_BIT,
    COLOR_BUFFER_BIT,
    isContextLost: () => false,
    clear: (mask: number) => {
      calls.push({ method: 'gl.clear', args: [mask] });
    },
    viewport: (x: number, y: number, w: number, h: number) => {
      calls.push({ method: 'gl.viewport', args: [x, y, w, h] });
    },
    depthMask: (flag: boolean) => {
      calls.push({ method: 'gl.depthMask', args: [flag] });
    },
  };

  (v as unknown as { canvas: unknown }).canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
  };
  (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();

  let resetStateCalls = 0;
  (v as unknown as { renderer: unknown }).renderer = {
    getContext: () => mockGl,
    capabilities: { isWebGL2: true },
    setViewport: (x: number, y: number, w: number, h: number) => {
      calls.push({ method: 'renderer.setViewport', args: [x, y, w, h] });
    },
    resetState: () => {
      resetStateCalls++;
      calls.push({ method: 'renderer.resetState', args: [] });
    },
    render: (_scene: unknown, _camera: unknown) => {
      calls.push({ method: 'renderer.render', args: [] });
    },
  };

  return { v, mockGl, calls, getResetStateCalls: () => resetStateCalls };
}

const DUMMY_FRAME = {
  mvp: new Float64Array(16),
  cameraEnu: [0, 0, 100] as [number, number, number],
  fovRad: 0.8,
  canvasHeight: 600,
};

describe('深度策略 depthMode (issue #13)', () => {
  test('1. 默认行为不变（不变式 ①）：不传参时 depthMode 为 scene，GL 调用序列中绝无 gl.clear', () => {
    const { v, calls } = makeMockViewer();
    expect(v.depthMode).toBe('scene');
    expect(v.resolveDepthMode()).toBe('scene');

    v.renderFrame(DUMMY_FRAME);

    // 校验 GL 调用中没有 gl.clear
    const clearCalls = calls.filter((c) => c.method === 'gl.clear');
    expect(clearCalls).toHaveLength(0);

    // 校验 setViewport 紧跟 resetState
    const viewportIdx = calls.findIndex((c) => c.method === 'renderer.setViewport');
    const resetIdx = calls.findIndex((c) => c.method === 'renderer.resetState');
    expect(viewportIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBe(viewportIdx + 1);
  });

  test('2. 显式 depthMode: clear 会在渲染前调用 gl.clear(gl.DEPTH_BUFFER_BIT)，且 resetState 必须在其后', () => {
    const { v, calls, mockGl } = makeMockViewer({ depthMode: 'clear' });
    expect(v.depthMode).toBe('clear');
    expect(v.resolveDepthMode()).toBe('clear');

    v.renderFrame(DUMMY_FRAME);

    const clearCalls = calls.filter((c) => c.method === 'gl.clear');
    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0].args[0]).toBe(mockGl.DEPTH_BUFFER_BIT); // 只清深度，不清颜色缓冲

    // 校验顺序：setViewport -> gl.clear -> resetState -> render
    const viewportIdx = calls.findIndex((c) => c.method === 'renderer.setViewport');
    const clearIdx = calls.findIndex((c) => c.method === 'gl.clear');
    const resetIdx = calls.findIndex((c) => c.method === 'renderer.resetState');
    const renderIdx = calls.findIndex((c) => c.method === 'renderer.render');

    expect(clearIdx).toBeGreaterThan(viewportIdx);
    expect(resetIdx).toBeGreaterThan(clearIdx); // resetState 必须放在 clear 之后
    expect(renderIdx).toBeGreaterThan(resetIdx);
  });

  test('2b. clear 前必须先打开 depthMask：上一帧以 depthWrite=false 材质收尾时 gl.clear 会静默失效', () => {
    const { v, calls, mockGl } = makeMockViewer({ depthMode: 'clear' });
    // 模拟上一帧末尾：某个 depthWrite=false 的材质（棱线 / 半透明地表覆盖 / 半透明点云）
    // 把 GL 的 depthMask 留在 false。three 在帧末不会恢复它，而 resetState 又排在 clear 之后，
    // 所以清深度这一步必须自己把 mask 打开 —— 否则 gl.clear(DEPTH) 是空操作，
    // 表现就是「开了 clear 但 z-fighting 原样还在」，且没有任何报错。
    mockGl.depthMask(false);
    calls.length = 0;

    v.renderFrame(DUMMY_FRAME);

    const maskOnIdx = calls.findIndex((c) => c.method === 'gl.depthMask' && c.args[0] === true);
    const clearIdx = calls.findIndex((c) => c.method === 'gl.clear');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(maskOnIdx).toBeGreaterThanOrEqual(0);
    expect(maskOnIdx).toBeLessThan(clearIdx);
  });

  test('3. normalizeDepthMode 稳健归一化', () => {
    expect(normalizeDepthMode('clear')).toBe('clear');
    expect(normalizeDepthMode('auto')).toBe('auto');
    expect(normalizeDepthMode('scene')).toBe('scene');
    expect(normalizeDepthMode(undefined)).toBe('scene');
    expect(normalizeDepthMode(null)).toBe('scene');
    expect(normalizeDepthMode('invalid' as never)).toBe('scene');
  });

  test('4. 运行时 setDepthMode 触发 triggerRepaint 并更新属性', () => {
    let repainted = 0;
    const v = new S3MViewer();
    v.triggerRepaint = () => { repainted++; };
    expect(v.depthMode).toBe('scene');

    v.setDepthMode('clear');
    expect(v.depthMode).toBe('clear');
    expect(repainted).toBe(1);

    // 传相同值不重复触发重绘
    v.setDepthMode('clear');
    expect(repainted).toBe(1);

    v.setDepthMode('auto');
    expect(v.depthMode).toBe('auto');
    expect(repainted).toBe(2);
  });

  test('5. depthMode: auto 的推断逻辑', () => {
    // 5.1 没有任何配置或数据集时，auto 默认退回 scene
    const v1 = new S3MViewer({ depthMode: 'auto' });
    expect(v1.resolveDepthMode()).toBe('scene');

    // 5.2 有 ground 覆盖（translucent / excavate）时，auto 推断为 clear
    const vGround = new S3MViewer({ depthMode: 'auto', ground: { mode: 'translucent' } });
    expect(vGround.resolveDepthMode()).toBe('clear');

    const vExcavate = new S3MViewer({ depthMode: 'auto', ground: { mode: 'excavate' } });
    expect(vExcavate.resolveDepthMode()).toBe('clear');

    // 5.3 数据集标注为 OSGB / 倾斜摄影时，auto 推断为 clear
    const vOsgb = new S3MViewer({ depthMode: 'auto' });
    const dm = (vOsgb as unknown as { _datasetManager: { datasets: Map<string, unknown> } })._datasetManager;
    dm.datasets.set('ds-osgb', {
      visible: true,
      options: {},
      tileset: { isS3MV1: true, config: { fileType: 'OSGBFile' } },
    });
    expect(vOsgb.resolveDepthMode()).toBe('clear');

    // 5.4 数据集 config 标注 dataType=DEM / Terrain / TIN 时，auto 推断为 clear
    const vDem = new S3MViewer({ depthMode: 'auto' });
    const dmDem = (vDem as unknown as { _datasetManager: { datasets: Map<string, unknown> } })._datasetManager;
    dmDem.datasets.set('ds-dem', {
      visible: true,
      options: {},
      tileset: { isS3MV1: false, config: { dataType: 'DEM' } },
    });
    expect(vDem.resolveDepthMode()).toBe('clear');

    // 5.5 数据集选项显式给定 depthMode: 'clear' 时，auto 推断为 clear
    const vExplicit = new S3MViewer({ depthMode: 'auto' });
    const dmExplicit = (vExplicit as unknown as { _datasetManager: { datasets: Map<string, unknown> } })._datasetManager;
    dmExplicit.datasets.set('ds-exp', {
      visible: true,
      options: { depthMode: 'clear' },
      tileset: null,
    });
    expect(vExplicit.resolveDepthMode()).toBe('clear');

    // 5.6 不可见数据集 (visible: false) 不影响 auto 推断
    const vInvis = new S3MViewer({ depthMode: 'auto' });
    const dmInvis = (vInvis as unknown as { _datasetManager: { datasets: Map<string, unknown> } })._datasetManager;
    dmInvis.datasets.set('ds-invis', {
      visible: false,
      options: { depthMode: 'clear' },
      tileset: { isS3MV1: true },
    });
    expect(vInvis.resolveDepthMode()).toBe('scene');

    // 5.7 普通建筑模型数据集，auto 保持 scene
    const vBldg = new S3MViewer({ depthMode: 'auto' });
    const dmBldg = (vBldg as unknown as { _datasetManager: { datasets: Map<string, unknown> } })._datasetManager;
    dmBldg.datasets.set('ds-bldg', {
      visible: true,
      options: {},
      tileset: { isS3MV1: false, config: { fileType: 'Model' } },
    });
    expect(vBldg.resolveDepthMode()).toBe('scene');
  });

  test('6. 多图层互不干扰：同一帧内一个 clear、另一个 scene 各走各的深度策略', () => {
    const { v: vClear, calls: callsClear } = makeMockViewer({ depthMode: 'clear' });
    const { v: vScene, calls: callsScene } = makeMockViewer({ depthMode: 'scene' });

    // 同一帧先画 clear 图层，再画 scene 图层
    vClear.renderFrame(DUMMY_FRAME);
    vScene.renderFrame(DUMMY_FRAME);

    // vClear 清了深度
    expect(callsClear.some((c) => c.method === 'gl.clear')).toBe(true);

    // vScene 绝不清深度，保留前层（或宿主）深度
    expect(callsScene.some((c) => c.method === 'gl.clear')).toBe(false);
  });

  test('7. GpuEdgePass 在 clear 模式下跳过渲染，避免穿透地形的边缘伪影', () => {
    const { v } = makeMockViewer({
      depthMode: 'clear',
      style: { edges: 'gpu' },
    });

    let gpuEdgeRenderCalls = 0;
    const edges = (v as unknown as { _edges: { _gpuEdge: unknown } })._edges;
    (edges as unknown as { _modes: { gpu: boolean } })._modes = { gpu: true };
    (edges as unknown as { _gpuEdge: unknown })._gpuEdge = {
      supported: () => true,
      render: () => {
        gpuEdgeRenderCalls++;
      },
    };

    v.renderFrame(DUMMY_FRAME);
    // clear 模式下跳过 GPU 描边
    expect(gpuEdgeRenderCalls).toBe(0);

    // 切回 scene 模式后，GPU 描边正常执行
    v.setDepthMode('scene');
    v.renderFrame(DUMMY_FRAME);
    expect(gpuEdgeRenderCalls).toBe(1);
  });

  test('8. 完全透明 (opacity = 0) 时即使配置 clear 也不清深度（不破坏宿主底图）', () => {
    const { v, calls } = makeMockViewer({
      depthMode: 'clear',
      style: { opacity: 0 },
    });

    v.renderFrame(DUMMY_FRAME);
    expect(calls.filter((c) => c.method === 'gl.clear')).toHaveLength(0);
  });

  test('9. S3MLayer 透传 depthMode 与 setDepthMode', () => {
    const layer = new S3MLayer({ depthMode: 'clear' });
    expect(layer.depthMode).toBe('clear');
    expect(layer.viewer.depthMode).toBe('clear');

    layer.setDepthMode('auto');
    expect(layer.depthMode).toBe('auto');
    expect(layer.viewer.depthMode).toBe('auto');

    layer.setDepthMode('scene');
    expect(layer.depthMode).toBe('scene');
    expect(layer.viewer.depthMode).toBe('scene');
  });
});
