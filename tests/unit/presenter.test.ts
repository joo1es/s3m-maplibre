/**
 * 使用者接管上屏（`setPresenter`）的单测。
 *
 * 这条路径的设计目标是「开个口子」而不是「造一套后处理框架」：
 * 设了 presenter 就把场景渲进 RT、把颜色与深度交出去，之后怎么上屏完全由使用者决定。
 *
 * 以下几个断言都是不可退让的契约：
 *   - 不设 presenter 时，渲染路径与改动前逐字一致（一次 render、零 RT）
 *   - 设了之后场景必须先进 RT，且库自己不再画第二遍
 *   - 清屏色必须还原（宿主还有别的图层要接着画）
 *   - 与 motionBlur 互斥，且 presenter 优先（它是使用者自己的代码，不能悄悄丢掉）
 *   - WebGL1 / 尺寸非法时回退直渲，不能黑屏
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import type { PresenterContext } from '../../packages/s3m-three/src/render/PresenterTarget';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';

interface Call {
  method: string;
  args: unknown[];
}

function makeMock(opts: Record<string, unknown> = {}, webgl2 = true) {
  const v = new S3MViewer(opts as ConstructorParameters<typeof S3MViewer>[0]);
  v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };

  const calls: Call[] = [];
  // 用一个刁钻的初值：默认黑 0 透明度会和「设成黑」撞在一起，测不出有没有还原
  let clearColor = new THREE.Color(0x123456);
  let clearAlpha = 0.5;

  const mockGl = {
    DEPTH_BUFFER_BIT: 0x00000100,
    COLOR_BUFFER_BIT: 0x00004000,
    isContextLost: () => false,
    clear: () => calls.push({ method: 'gl.clear', args: [] }),
    viewport: () => {},
    depthMask: () => {},
  };

  (v as unknown as { canvas: unknown }).canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
  };
  (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();

  let repaints = 0;
  v.triggerRepaint = () => {
    repaints++;
  };

  (v as unknown as { renderer: unknown }).renderer = {
    getContext: () => mockGl,
    capabilities: { isWebGL2: webgl2 },
    setViewport: (...a: number[]) => calls.push({ method: 'setViewport', args: a }),
    resetState: () => calls.push({ method: 'resetState', args: [] }),
    setRenderTarget: (rt: unknown) => calls.push({ method: 'setRenderTarget', args: [rt] }),
    setClearColor: (c: THREE.ColorRepresentation, a?: number) => {
      clearColor = new THREE.Color(c);
      if (typeof a === 'number') clearAlpha = a;
      calls.push({ method: 'setClearColor', args: [c, a] });
    },
    getClearColor: (t: THREE.Color) => t.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    clear: () => calls.push({ method: 'clear', args: [] }),
    render: (s: unknown, c: unknown) => calls.push({ method: 'render', args: [s, c] }),
  };

  return {
    v,
    calls,
    get repaints() {
      return repaints;
    },
    get clear() {
      return { hex: clearColor.getHex(), alpha: clearAlpha };
    },
    setCanvas(w: number, h: number) {
      (v as unknown as { canvas: { width: number; height: number } }).canvas.width = w;
      (v as unknown as { canvas: { width: number; height: number } }).canvas.height = h;
    },
  };
}

const FRAME = {
  mvp: new Float64Array(16),
  cameraEnu: [0, 0, 100] as [number, number, number],
  fovRad: 0.8,
  canvasHeight: 600,
};

function captureWarn(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return out;
}

describe('setPresenter / 使用者接管上屏', () => {
  test('不设 presenter 时渲染路径不变：一次直渲、不建 RT、不碰 renderTarget', () => {
    const m = makeMock();
    expect(m.v.presenter).toBeNull();

    m.v.renderFrame(FRAME);

    expect(m.calls.filter((c) => c.method === 'render')).toHaveLength(1);
    expect(m.calls.some((c) => c.method === 'setRenderTarget')).toBe(false);
    expect((m.v as unknown as { _presenterTarget: { target: unknown } })._presenterTarget.target).toBeNull();
  });

  test('设了 presenter：场景先进 RT，再把颜色与深度交出去', () => {
    const m = makeMock();
    const seen: PresenterContext[] = [];
    m.v.setPresenter({ render: (ctx) => seen.push(ctx) });

    m.v.renderFrame(FRAME);

    // 先绑定非 null 的 RT，再渲场景
    const rtIdx = m.calls.findIndex((c) => c.method === 'setRenderTarget' && c.args[0] !== null);
    const renderIdx = m.calls.findIndex((c) => c.method === 'render');
    expect(rtIdx).toBeGreaterThanOrEqual(0);
    expect(renderIdx).toBeGreaterThan(rtIdx);

    const holder = (m.v as unknown as {
      _presenterTarget: { target: THREE.WebGLRenderTarget | null };
    })._presenterTarget;
    expect(holder.target).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].width).toBe(800);
    expect(seen[0].height).toBe(600);
    expect(seen[0].color).toBe(holder.target!.texture);
    expect(seen[0].depth).toBe(holder.target!.depthTexture as THREE.DepthTexture);
    expect(seen[0].scene).toBe(m.v.scene as THREE.Scene);
    expect(seen[0].camera).toBe(m.v.camera as THREE.Camera);
  });

  test('presenter 接管后库不再画第二遍：整帧只有进 RT 那一次 render', () => {
    const m = makeMock();
    m.v.setPresenter({ render: () => {} });

    m.v.renderFrame(FRAME);

    expect(m.calls.filter((c) => c.method === 'render')).toHaveLength(1);
  });

  test('清屏色必须还原给宿主：宿主还有别的图层接着画', () => {
    const m = makeMock();
    m.v.setPresenter({ render: () => {} });

    m.v.renderFrame(FRAME);

    expect(m.clear.hex).toBe(0x123456);
    expect(m.clear.alpha).toBe(0.5);
  });

  test('画布尺寸变化时重建 RT', () => {
    const m = makeMock();
    const seen: PresenterContext[] = [];
    m.v.setPresenter({ render: (ctx) => seen.push(ctx) });

    m.v.renderFrame(FRAME);
    m.setCanvas(1024, 768);
    m.v.renderFrame(FRAME);

    expect(seen).toHaveLength(2);
    expect(seen[1].width).toBe(1024);
    expect(seen[1].height).toBe(768);
    // 换了纹理：说明重建过，不是复用旧 RT 硬拉大
    expect(seen[1].color).not.toBe(seen[0].color);
  });

  test('setPresenter(null) 解除接管：回到直渲并释放 RT', () => {
    const m = makeMock();
    let calls = 0;
    m.v.setPresenter({ render: () => calls++ });
    m.v.renderFrame(FRAME);
    expect(calls).toBe(1);

    m.v.setPresenter(null);
    expect(m.v.presenter).toBeNull();
    const holder = (m.v as unknown as { _presenterTarget: { target: unknown } })._presenterTarget;
    expect(holder.target).toBeNull();

    m.calls.length = 0;
    m.v.renderFrame(FRAME);
    expect(calls).toBe(1);
    expect(m.calls.filter((c) => c.method === 'render')).toHaveLength(1);
    expect(m.calls.some((c) => c.method === 'setRenderTarget')).toBe(false);
  });

  test('WebGL1 回退直渲，且只 warn 一次', () => {
    const m = makeMock({}, false);
    let calls = 0;
    m.v.setPresenter({ render: () => calls++ });

    const warns = captureWarn(() => {
      m.v.renderFrame(FRAME);
      m.v.renderFrame(FRAME);
    });

    expect(calls).toBe(0);
    expect(m.calls.filter((c) => c.method === 'render')).toHaveLength(2);
    expect(warns.filter((w) => w.includes('WebGL2'))).toHaveLength(1);
  });

  test('尺寸为 0 时回退直渲，不能黑屏', () => {
    const m = makeMock();
    let calls = 0;
    m.v.setPresenter({ render: () => calls++ });
    m.setCanvas(0, 0);

    m.v.renderFrame(FRAME);

    expect(calls).toBe(0);
    expect(m.calls.filter((c) => c.method === 'render')).toHaveLength(1);
  });

  test('与 motionBlur 互斥：设 presenter 会关掉运动模糊并 warn', () => {
    const m = makeMock();
    m.v.setMotionBlur({ mode: 'afterimage', damp: 0.4 });
    expect(m.v.motionBlur).not.toBeNull();

    const warns = captureWarn(() => m.v.setPresenter({ render: () => {} }));

    expect(m.v.motionBlur).toBeNull();
    expect(warns.some((w) => w.includes('运动模糊'))).toBe(true);
  });

  test('presenter 一旦设上就一直赢：之后再开 motionBlur 不生效', () => {
    const m = makeMock();
    const p = { render: () => {} };
    m.v.setPresenter(p);

    const warns = captureWarn(() => m.v.setMotionBlur({ mode: 'velocity' }));

    expect(m.v.motionBlur).toBeNull();
    expect(m.v.presenter).toBe(p);
    expect(warns.some((w) => w.includes('presenter'))).toBe(true);
  });

  test('S3MLayer 透传 setPresenter / presenter', () => {
    const layer = new S3MLayer();
    const p = { render: () => {} };

    layer.setPresenter(p);
    expect(layer.presenter).toBe(p);
    expect(layer.viewer.presenter).toBe(p);

    layer.setPresenter(null);
    expect(layer.presenter).toBeNull();
  });
});
