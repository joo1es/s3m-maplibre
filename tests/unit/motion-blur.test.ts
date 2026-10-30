/**
 * 单元测试：可选的运动模糊后处理（issue #4，默认关闭）
 *
 * 锁定的不变式（对应 AGENTS.md 不变式①②）：
 *
 * 1. **默认不生效** —— 不传 `motionBlur` 时走原来的直渲路径：
 *    每帧恰好一次 `renderer.render(scene, camera)`，全程不碰 render target。
 * 2. **边界归一化** —— mode 非法回退 afterimage；damp 钳 [0, 0.98]；
 *    NaN 当 'auto'；'auto' 按实时 FPS 收敛且单调、封顶 0.92。
 * 3. **结构不变量** ——
 *    - afterimage：场景 → RT，累积混合 → RT（ping-pong，不能读写同张纹理），合成 → 宿主 framebuffer；
 *    - velocity：场景 → RT，方向模糊直接 → 宿主 framebuffer；prevMvp 必须是「上一帧」的矩阵；
 *    - 合成永远落在宿主 framebuffer（target=null）上，且在 GPU 棱线 quad 之前 ——
 *      不破坏 EdgeDecorator / SelectionDecorator 的渲染顺序；
 *    - WebGL1 上静默回退直渲（gl_FragDepth / DepthTexture 是 WebGL2 核心特性）。
 * 4. **运行时开关** —— setMotionBlur(null) 恢复直渲并释放 RT；开启时走公共
 *    triggerRepaint() 请求重绘（单测的观测点）。
 *
 * 全部不依赖真实 WebGL：渲染器用桩替身，只验证「渲染到哪 / 渲染几次 / uniform 值」。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import {
  normalizeMotionBlur,
  autoMotionBlurDamp,
} from '../../packages/s3m-three/src/render/MotionBlurPass';

/* ------------------------------------------------------------------ 工具 */

function makeViewer(opts: Record<string, unknown> = {}): S3MViewer {
  const v = new S3MViewer(opts as ConstructorParameters<typeof S3MViewer>[0]);
  v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };
  return v;
}

interface FrameEvent {
  type: 'rt' | 'render';
  target: unknown; // render target（null = 宿主 framebuffer）
  ortho: boolean; // 这一次 render 是不是全屏 quad（正交相机）
}

/**
 * 桩渲染管线：记录 setRenderTarget 与 render 的交错顺序。
 * isWebGL2 可控 —— motion blur 依赖 gl_FragDepth / DepthTexture，WebGL1 必须能降级。
 */
function stubPipeline(v: S3MViewer, isWebGL2 = true): { events: FrameEvent[]; renders: number } {
  const events: FrameEvent[] = [];
  (v as unknown as { canvas: unknown }).canvas = {
    width: 200,
    height: 100,
    clientWidth: 200,
    clientHeight: 100,
  };
  (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();
  (v as unknown as { renderer: unknown }).renderer = {
    getContext: () => ({ isContextLost: () => false }),
    capabilities: { isWebGL2 },
    setViewport: () => {},
    resetState: () => {},
    setRenderTarget: (t: unknown) => {
      events.push({ type: 'rt', target: t, ortho: false });
    },
    getClearColor: (c: THREE.Color) => c,
    setClearColor: () => {},
    getClearAlpha: () => 1,
    setClearAlpha: () => {},
    clear: () => {},
    render: (scene: unknown, camera: THREE.Camera) => {
      events.push({
        type: 'render',
        target: null,
        ortho: (camera as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera === true,
      });
    },
    dispose: () => {},
  };
  return {
    events,
    renders: 0,
  };
}

/** events 里 setRenderTarget 的顺序（不含 render） */
function rtTargets(events: FrameEvent[]): unknown[] {
  return events.filter((e) => e.type === 'rt').map((e) => e.target);
}

/** events 里 render 的次数 */
function renderCount(events: FrameEvent[]): number {
  return events.filter((e) => e.type === 'render').length;
}

const IDENT_MVP = new THREE.Matrix4().identity();

function frame(v: S3MViewer, mvp: THREE.Matrix4 = IDENT_MVP): boolean {
  return v.renderFrame({
    mvp: mvp.toArray(),
    cameraEnu: [0, 0, 1000],
    fovRad: 0.6,
    canvasHeight: 100,
  });
}

/* ------------------------------------------------------------------ 1. 选项归一化（纯函数） */

describe('motionBlur 选项归一化（normalizeMotionBlur）', () => {
  test('不传 / null / 非对象 = 关闭', () => {
    expect(normalizeMotionBlur(undefined)).toBeNull();
    expect(normalizeMotionBlur(null)).toBeNull();
    expect(normalizeMotionBlur('afterimage' as never)).toBeNull();
    expect(normalizeMotionBlur(5 as never)).toBeNull();
  });

  test('传了对象 = 开启：mode 缺省 / 非法回退 afterimage，damp 缺省 auto，maxOffset 缺省 0.05', () => {
    expect(normalizeMotionBlur({})).toEqual({ mode: 'afterimage', damp: 'auto', maxOffset: 0.05 });
    expect(normalizeMotionBlur({ mode: 'bogus' as never })).toEqual({ mode: 'afterimage', damp: 'auto', maxOffset: 0.05 });
    expect(normalizeMotionBlur({ mode: 'velocity' })).toEqual({ mode: 'velocity', damp: 'auto', maxOffset: 0.05 });
  });

  test('damp 数值钳到 [0, 0.98]，NaN 当 auto', () => {
    expect(normalizeMotionBlur({ damp: 0.5 })).toEqual({ mode: 'afterimage', damp: 0.5, maxOffset: 0.05 });
    expect(normalizeMotionBlur({ damp: 1.7 })).toEqual({ mode: 'afterimage', damp: 0.98, maxOffset: 0.05 });
    expect(normalizeMotionBlur({ damp: -2 })).toEqual({ mode: 'afterimage', damp: 0, maxOffset: 0.05 });
    expect(normalizeMotionBlur({ damp: Number.NaN })).toEqual({ mode: 'afterimage', damp: 'auto', maxOffset: 0.05 });
    expect(normalizeMotionBlur({ damp: 'auto' })).toEqual({ mode: 'afterimage', damp: 'auto', maxOffset: 0.05 });
  });

  test('maxOffset（velocity 拖影上限，屏宽百分比）钳到 [0, 1]，NaN / 非法回默认 0.05', () => {
    expect(normalizeMotionBlur({ mode: 'velocity', maxOffset: 0.2 }).maxOffset).toBe(0.2);
    expect(normalizeMotionBlur({ maxOffset: -1 }).maxOffset).toBe(0);
    expect(normalizeMotionBlur({ maxOffset: 5 }).maxOffset).toBe(1);
    expect(normalizeMotionBlur({ maxOffset: Number.NaN }).maxOffset).toBe(0.05);
    expect(normalizeMotionBlur({ maxOffset: 'big' as never }).maxOffset).toBe(0.05);
  });
});

/* ------------------------------------------------------------------ 2. FPS 自适应 damp（纯函数） */

describe('autoMotionBlurDamp（FPS 自适应拖尾）', () => {
  test('帧率越低拖影越长（单调），未知帧率按 60fps 保守取值', () => {
    const d120 = autoMotionBlurDamp(120);
    const d60 = autoMotionBlurDamp(60);
    const d30 = autoMotionBlurDamp(30);
    const d15 = autoMotionBlurDamp(15);
    expect(d120).toBeLessThan(d60);
    expect(d60).toBeLessThan(d30);
    expect(d30).toBeLessThan(d15);
    // 60fps 下拖尾克制（≈0.55），30fps 明显拉长，15fps 更长
    expect(d60).toBeCloseTo(0.55, 5);
    expect(d30).toBeCloseTo(Math.sqrt(0.55), 5);
    // 未知帧率（0 / NaN）不糊脸：按 60fps 取
    expect(autoMotionBlurDamp(0)).toBe(d60);
    expect(autoMotionBlurDamp(Number.NaN)).toBe(d60);
  });

  test('极低帧率封顶 0.92，不会糊成一片', () => {
    expect(autoMotionBlurDamp(5)).toBeLessThanOrEqual(0.92);
    expect(autoMotionBlurDamp(1)).toBeLessThanOrEqual(0.92);
  });
});

/* ------------------------------------------------------------------ 2.5 PR #6 审查修复 */

describe('PR #6 审查修复：RT 类型与 maxOffset', () => {
  test('三张 RT 均为 HalfFloatType —— 线性高光不在 tone map 之前被 clamp 到 [0,1]', () => {
    const v = makeViewer({ motionBlur: {} });
    stubPipeline(v);
    frame(v);
    const pass = (v as unknown as {
      _motionBlur: {
        rtScene: THREE.WebGLRenderTarget | null;
        rtPrevRead: THREE.WebGLRenderTarget | null;
        rtPrevWrite: THREE.WebGLRenderTarget | null;
      };
    })._motionBlur;
    // UnsignedByteType 存线性值会把 >1 的高光 / 自发光截断，合成 tone map 后与直渲有可感知色差
    expect(pass.rtScene!.texture.type).toBe(THREE.HalfFloatType);
    expect(pass.rtPrevRead!.texture.type).toBe(THREE.HalfFloatType);
    expect(pass.rtPrevWrite!.texture.type).toBe(THREE.HalfFloatType);
    v.dispose();
  });

  test('velocity 的 uMaxOffset 从配置读取（拖影上限可配），默认 0.05 与旧行为一致', () => {
    const v = makeViewer({ motionBlur: { mode: 'velocity', maxOffset: 0.12 } });
    stubPipeline(v);
    frame(v);
    const pass = (v as unknown as { _motionBlur: { velocityMat: { uniforms: Record<string, { value: unknown }> } } })._motionBlur;
    expect(pass.velocityMat.uniforms.uMaxOffset.value).toBe(0.12);
    v.dispose();

    const v2 = makeViewer({ motionBlur: { mode: 'velocity' } });
    stubPipeline(v2);
    frame(v2);
    const pass2 = (v2 as unknown as { _motionBlur: { velocityMat: { uniforms: Record<string, { value: unknown }> } } })._motionBlur;
    expect(pass2.velocityMat.uniforms.uMaxOffset.value).toBe(0.05);
    v2.dispose();
  });

  test('maxOffset 归一化结果经 getter 透出（运行时可改）', () => {
    const v = makeViewer();
    v.setMotionBlur({ mode: 'velocity', maxOffset: 0.3 });
    expect(v.motionBlur).toEqual({ mode: 'velocity', damp: 'auto', maxOffset: 0.3 });
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 3. 默认行为不变（不变式①） */

describe('默认不传 motionBlur 时行为不变', () => {
  test('配置为 null，渲染路径与旧版一致：每帧一次直渲、零 render target 切换', () => {
    const v = makeViewer();
    expect(v.motionBlur).toBeNull();
    const { events } = stubPipeline(v);
    frame(v);
    frame(v);
    expect(renderCount(events)).toBe(2); // 每帧恰好一次 renderer.render(scene, camera)
    expect(rtTargets(events)).toHaveLength(0); // 全程不碰 RT（逐字一致的老路径）
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 4. afterimage 帧序列 */

describe('afterimage 模式帧序列', () => {
  test('稳态帧：场景→RT、混合→ping-pong RT、合成→宿主 framebuffer，共 3 次渲染', () => {
    const v = makeViewer({ motionBlur: { mode: 'afterimage' } });
    expect(v.motionBlur).toEqual({ mode: 'afterimage', damp: 'auto', maxOffset: 0.05 });
    const { events } = stubPipeline(v);
    frame(v); // 首帧：累积链起步
    events.length = 0;
    frame(v); // 稳态帧才是要锁定的序列

    expect(renderCount(events)).toBe(3);
    const targets = rtTargets(events);
    expect(targets).toHaveLength(3);
    // 前 two 步进 RT（场景 / 累积），第三步必须回宿主 framebuffer
    expect(targets[0]).not.toBeNull();
    expect(targets[1]).not.toBeNull();
    expect(targets[1]).not.toBe(targets[0]); // 读写不能是同一张纹理（ping-pong）
    expect(targets[2]).toBeNull();
    // 三次渲染发生在三次 target 切换之后（rt, render, rt, render, null, render）
    expect(events.map((e) => e.type)).toEqual(['rt', 'render', 'rt', 'render', 'rt', 'render']);
    v.dispose();
  });

  test('首帧 damp 强制为 0（旧残影不该从零初始化纹理 / 别的模式里冒出来）', () => {
    const v = makeViewer({ motionBlur: { damp: 0.9 } });
    const { events } = stubPipeline(v);
    frame(v);
    const pass = (v as unknown as { _motionBlur: { blendMat: { uniforms: Record<string, { value: unknown }> } } })._motionBlur;
    expect(pass.blendMat.uniforms.uDamp.value).toBe(0);
    frame(v);
    expect(pass.blendMat.uniforms.uDamp.value).toBe(0.9); // 第二帧起用真实 damp
    v.dispose();
  });

  test('auto damp 按当前 FPS 解析进 uniform（未知 FPS 按 60fps）', () => {
    const v = makeViewer({ motionBlur: {} });
    const { events } = stubPipeline(v);
    frame(v);
    frame(v);
    expect(renderCount(events)).toBe(6);
    const pass = (v as unknown as { _motionBlur: { blendMat: { uniforms: Record<string, { value: unknown }> } } })._motionBlur;
    expect(pass.blendMat.uniforms.uDamp.value).toBeCloseTo(autoMotionBlurDamp(0), 5);
    v.dispose();
  });

  test('固定 damp 原样透传（第二帧起）', () => {
    const v = makeViewer({ motionBlur: { damp: 0.4 } });
    const { events } = stubPipeline(v);
    frame(v);
    frame(v);
    const pass = (v as unknown as { _motionBlur: { blendMat: { uniforms: Record<string, { value: unknown }> } } })._motionBlur;
    expect(pass.blendMat.uniforms.uDamp.value).toBe(0.4);
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 5. velocity 帧序列 */

describe('velocity 模式帧序列', () => {
  test('场景→RT、方向模糊直接→宿主 framebuffer，共 2 次渲染', () => {
    const v = makeViewer({ motionBlur: { mode: 'velocity' } });
    const { events } = stubPipeline(v);
    frame(v);
    expect(renderCount(events)).toBe(2);
    const targets = rtTargets(events);
    expect(targets).toHaveLength(2);
    expect(targets[0]).not.toBeNull();
    expect(targets[1]).toBeNull();
    v.dispose();
  });

  test('速度向量用「上一帧」的 MVP：首帧零模糊，第二帧才出现速度', () => {
    const v = makeViewer({ motionBlur: { mode: 'velocity' } });
    const { events } = stubPipeline(v);
    // 捕获每次 quad 渲染时 shader 里挂着的 prevMvp
    const captured: THREE.Matrix4[] = [];
    const renderer = (v as unknown as { renderer: Record<string, unknown> }).renderer as {
      render: (s: unknown, c: THREE.Camera) => void;
    };
    const origRender = renderer.render.bind(renderer);
    (renderer as unknown as { render: unknown }).render = (s: unknown, c: THREE.Camera) => {
      if ((c as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera) {
        const pass = (v as unknown as { _motionBlur: { velocityMat: { uniforms: Record<string, { value: unknown }> } } })._motionBlur;
        captured.push((pass.velocityMat.uniforms.uPrevMvp.value as THREE.Matrix4).clone());
      }
      origRender(s, c);
    };

    const mvp1 = new THREE.Matrix4().makeTranslation(0.1, 0, 0);
    const mvp2 = new THREE.Matrix4().makeTranslation(0.5, 0, 0);
    frame(v, mvp1);
    const pass = (v as unknown as { _motionBlur: { _prevMvp: THREE.Matrix4 } })._motionBlur;
    const frame1Effective = pass._prevMvp.clone(); // 帧1 末尾 = 帧1 的有效矩阵
    frame(v, mvp2);

    // viewer 的 _frameMvp 是「mvp × ENU 矩阵」，不逐字等于入参 —— 用关系断言：
    // 帧末 prev 滚动为该帧的有效矩阵；第二帧渲染时 prev 仍是第一帧的（速度 = 相对位移）
    expect(captured).toHaveLength(2);
    expect(captured[0].equals(frame1Effective)).toBe(true); // 首帧 prev = cur（零速度）
    expect(captured[1].equals(frame1Effective)).toBe(true); // 第二帧仍用第一帧的矩阵
    expect(pass._prevMvp.equals(frame1Effective)).toBe(false); // 帧2 末尾已滚动
    expect(captured[1].equals(mvp2)).toBe(false); // 也不是裸入参（隔着 ENU 矩阵）
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 6. WebGL1 降级 */

describe('WebGL1 上静默回退直渲', () => {
  test('配置仍在（getter 照常返回），但渲染路径走老路径', () => {
    const v = makeViewer({ motionBlur: { mode: 'velocity' } });
    expect(v.motionBlur).toEqual({ mode: 'velocity', damp: 'auto', maxOffset: 0.05 });
    const { events } = stubPipeline(v, false);
    frame(v);
    expect(renderCount(events)).toBe(1);
    expect(rtTargets(events)).toHaveLength(0);
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 7. 运行时开关 */

describe('setMotionBlur 运行时开关', () => {
  test('开启：走公共 triggerRepaint 请求重绘；关闭：恢复直渲并释放 RT', () => {
    const v = makeViewer();
    let repaints = 0;
    v.triggerRepaint = () => {
      repaints++;
    };
    const { events } = stubPipeline(v);

    frame(v);
    expect(renderCount(events)).toBe(1);

    v.setMotionBlur({ mode: 'velocity', damp: 0.5 });
    expect(repaints).toBe(1); // 子模块触发重绘一律走 triggerRepaint（观测点）
    expect(v.motionBlur).toEqual({ mode: 'velocity', damp: 0.5, maxOffset: 0.05 });
    frame(v);
    expect(renderCount(events)).toBe(3); // velocity 两步

    v.setMotionBlur(null);
    expect(repaints).toBe(2);
    expect(v.motionBlur).toBeNull();
    frame(v);
    expect(renderCount(events)).toBe(4); // 回到每帧一次直渲
    expect((v as unknown as { _motionBlur: unknown })._motionBlur).toBeNull();
    v.dispose();
  });

  test('setMotionBlur 非法入参 = 关闭', () => {
    const v = makeViewer();
    v.setMotionBlur({ mode: 'afterimage' });
    expect(v.motionBlur).not.toBeNull();
    v.setMotionBlur('bogus' as never);
    expect(v.motionBlur).toBeNull();
    v.dispose();
  });

  test('unmount 释放 pass（不抛错、可重复）', () => {
    const v = makeViewer({ motionBlur: {} });
    stubPipeline(v);
    frame(v);
    expect((v as unknown as { _motionBlur: unknown })._motionBlur).not.toBeNull();
    v.dispose(); // 内部走 unmount
    expect((v as unknown as { _motionBlur: unknown })._motionBlur).toBeNull();
  });
});

/* ------------------------------------------------------------------ 8. 渲染顺序：不破坏 GPU 棱线 */

describe('与 GPU 棱线的渲染顺序', () => {
  test('motion blur 合成到宿主 framebuffer 在 GPU 棱线之前（棱线仍压在最后）', () => {
    const v = makeViewer({ motionBlur: {} });
    v.setEdges('gpu');
    const { events } = stubPipeline(v);
    frame(v);

    // 顺序：mb 场景(RT) → mb 累积(RT) → mb 合成(null) → 棱线法线(RT) → 棱线 quad(null)
    expect(renderCount(events)).toBe(5);
    const targets = rtTargets(events);
    expect(targets).toHaveLength(5);
    expect(targets[0]).not.toBeNull(); // mb 场景
    expect(targets[1]).not.toBeNull(); // mb 累积
    expect(targets[2]).toBeNull(); // mb 合成：先落宿主 framebuffer
    expect(targets[3]).not.toBeNull(); // GPU 棱线的法线 RT
    expect(targets[4]).toBeNull(); // GPU 棱线 quad：压在 motion blur 之上
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 9. 透明度门控 */

describe('opacity = 0 时整层跳过（含 motion blur）', () => {
  test('motion blur 开着也不画：不渲染、不碰 RT', () => {
    const v = makeViewer({ motionBlur: {} });
    const { events } = stubPipeline(v);
    v.setOpacity(1);
    frame(v);
    const base = renderCount(events);
    expect(base).toBe(3);

    v.setOpacity(0);
    frame(v);
    expect(renderCount(events)).toBe(base); // 没有新增绘制
    v.dispose();
  });
});
