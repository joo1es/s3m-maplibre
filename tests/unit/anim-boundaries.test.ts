/**
 * 单元测试：动画 API 的两条「能力边界」被消掉之后的行为
 *
 *   1. 全局透明度可以真的到 0（不再钳在 0.05），到 0 时整层不画
 *   2. `shading` 由共享 uniform 驱动，切换零重编译；预热只把当前唯一 program 编一次
 *
 * 两条都不依赖 WebGL：渲染器用桩替身，只验证「有没有调用 / 调了什么」。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

/* ------------------------------------------------------------------ 工具 */

function makeViewer(opts: Record<string, unknown> = {}): S3MViewer {
  let t = 0;
  const v = new S3MViewer({ canvas: null as never, container: null as never, ...opts } as ConstructorParameters<typeof S3MViewer>[0]);
  v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };
  // 假时钟：动画按绝对时间推进，用真实 performance.now() 断言不了中间值
  (v.animator as unknown as { _now: () => number })._now = () => t;
  (v as unknown as { _testSetNow: (n: number) => void })._testSetNow = (n) => (t = n);
  return v;
}

function stepTo(v: S3MViewer, t: number): boolean {
  (v as unknown as { _testSetNow: (n: number) => void })._testSetNow(t);
  return v.animator.tick(t);
}

function registerMesh(viewer: S3MViewer, smid: number): THREE.Mesh {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(10, 10, 10);
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: viewer.uniforms }));
  mesh.userData = { geoRef: { pickInfo: { [smid]: { batchId: 0 } } } };
  group.add(mesh);
  (viewer as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
    { group, tile: null },
    { id: 'd', root: new THREE.Group() }
  );
  return mesh;
}

/** 把 renderFrame 需要的宿主环境全部替换成桩，只统计 render() 调用次数 */
function stubRenderPipeline(v: S3MViewer): { renders: number[] } {
  const renders: number[] = [];
  (v as unknown as { canvas: unknown }).canvas = {
    width: 200,
    height: 100,
    clientWidth: 200,
    clientHeight: 100,
  };
  (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();
  (v as unknown as { renderer: unknown }).renderer = {
    getContext: () => ({ isContextLost: () => false }),
    setViewport: () => {},
    resetState: () => {},
    render: () => {
      renders.push(1);
    },
    dispose: () => {},
  };
  return { renders };
}

function frame(v: S3MViewer): boolean {
  return v.renderFrame({
    mvp: new THREE.Matrix4().identity().toArray(),
    cameraEnu: [0, 0, 1000],
    fovRad: 0.6,
    canvasHeight: 100,
  });
}

/* ------------------------------------------------------------------ 1. opacity 到 0 */

describe('1. 全局透明度允许到 0', () => {
  test('setOpacity(0) 真的写 0，不再钳到 0.05', () => {
    const v = makeViewer();
    v.setOpacity(0);
    expect(v.getStyle().opacity).toBe(0);
    expect(v.uniforms.uOpacity!.value).toBe(0);
    v.dispose();
  });

  test('越界值按 [0, 1] 钳制', () => {
    const v = makeViewer();
    v.setOpacity(1.8);
    expect(v.uniforms.uOpacity!.value).toBe(1);
    v.setOpacity(-3);
    expect(v.uniforms.uOpacity!.value).toBe(0);
    v.dispose();
  });

  test('带过渡时逐帧推进到 0（不是直接消失）', () => {
    const v = makeViewer();
    v.setOpacity(1);
    v.setOpacity(0, { duration: 100, easing: 'linear' });

    stepTo(v, 50);
    expect(v.uniforms.uOpacity!.value).toBeCloseTo(0.5, 2);
    stepTo(v, 100);
    expect(v.uniforms.uOpacity!.value).toBe(0);
    v.dispose();
  });

  test('opacity 为 0 时跳过本层绘制（不写深度，底图不会被打洞）', () => {
    const v = makeViewer();
    registerMesh(v, 801);
    const { renders } = stubRenderPipeline(v);

    v.setOpacity(1);
    frame(v);
    expect(renders.length).toBe(1);

    v.setOpacity(0);
    frame(v);
    expect(renders.length).toBe(1); // 没有新增绘制

    v.setOpacity(0.5);
    frame(v);
    expect(renders.length).toBe(2);
    v.dispose();
  });

  test('棱线 / 描边的透明度也跟着到 0，不会留下一条亮线', () => {
    const v = makeViewer();
    v.setStyle({ edgeOpacity: 0.8, outlineWidthPx: 3 });
    v.setOpacity(0);
    expect(v.edgeMaterial.uniforms.uOpacity.value).toBe(0);
    v.dispose();
  });
});

/* ------------------------------------------------------------------ 2. shading 预热 */

describe('2. shading 由 uniform 驱动（零重编译）', () => {
  test('默认平面着色：uFlatShading = 1，flatShading 恒为 false（program 稳定）', async () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 802);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.userData.uFlatShading.value).toBe(1); // 默认平面着色，语义不变
    expect(mat.flatShading).toBe(false); // 不再用 define，program 不随 shading 变

    let compiles = 0;
    (v as unknown as { renderer: unknown }).renderer = {
      compileAsync: async () => {
        compiles++;
      },
    };
    (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();

    await v.prewarmShading();
    expect(compiles).toBe(1); // 唯一 program 预热一次
    expect(mat.userData.uFlatShading.value).toBe(1); // 材质未被翻转
    expect((v as unknown as { _shadingPrewarmed: boolean })._shadingPrewarmed).toBe(true);
    v.dispose();
  });

  test('只预热一次；没有渲染器 / 没有材质时安全返回', async () => {
    const v = makeViewer();
    // 没有 renderer：直接返回，不抛错
    await v.prewarmShading();

    registerMesh(v, 803);
    let calls = 0;
    (v as unknown as { renderer: unknown }).renderer = {
      compileAsync: async () => {
        calls++;
      },
    };
    (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();

    await v.prewarmShading();
    await v.prewarmShading();
    expect(calls).toBe(1);
    v.dispose();
  });

  test('setStyle smooth 只翻 uniform，flatShading 与 program 不动', async () => {
    const v = makeViewer();
    v.setStyle({ shading: 'smooth' });
    const mesh = registerMesh(v, 804);
    const mat = mesh.material as THREE.MeshStandardMaterial;

    // smooth 已生效：uniform = 0；材质属性保持 false，program 不变
    expect(mat.userData.uFlatShading.value).toBe(0);
    expect(mat.flatShading).toBe(false);

    // 预热不翻转任何状态（新机制下没有「另一种变体」）
    let compiles = 0;
    (v as unknown as { renderer: unknown }).renderer = {
      compileAsync: async () => {
        compiles++;
      },
    };
    (v as unknown as { camera: THREE.Camera }).camera = new THREE.PerspectiveCamera();
    await v.prewarmShading();
    expect(compiles).toBe(1);
    expect(mat.userData.uFlatShading.value).toBe(0);
    v.dispose();
  });

  test('customProgramCacheKey 不随 shading 变化（flat/smooth 不再撞 key 也不再分叉）', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 807);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const before = mat.customProgramCacheKey?.();
    v.setStyle({ shading: 'smooth' });
    expect(mat.customProgramCacheKey?.()).toBe(before);
    v.dispose();
  });

  test('选项 prewarmShading: false 时不自动预热', () => {
    const v = makeViewer({ prewarmShading: false });
    registerMesh(v, 805);
    const { renders } = stubRenderPipeline(v);
    v.setOpacity(1);
    frame(v);
    expect(renders.length).toBe(1);
    expect((v as unknown as { _shadingPrewarmed: boolean })._shadingPrewarmed).toBe(false);
    v.dispose();
  });
});
