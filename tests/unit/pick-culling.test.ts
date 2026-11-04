/**
 * #29 拾取粗筛：ID pass 只送「包围球投影可能覆盖点击像素」的网格。
 *
 * 这里是正确性优先的场景：宁可多画几个 mesh，也不能因为剔除点不中。
 * 所以除了纯数学判据，还专门测了各种「包围球不可信」的退化情况必须原样保留。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  hasPickDisplacement,
  sphereMayCoverNdcPoint,
} from '../../packages/s3m-three/src/render/PickCulling';
import { Picker } from '../../packages/s3m-three/src/render/Picker';

/** x/y 直接映射成 NDC、w 恒为 1 的正交矩阵，方便按像素推演 */
const ortho = () => new THREE.Matrix4().makeOrthographic(-1, 1, 1, -1, 0.1, 100);

describe('#29 拾取粗筛 · 屏幕空间包围球（纯数学）', () => {
  test('球覆盖点击点 → 保留；远离 → 可以跳过', () => {
    const m = ortho();
    const c = new THREE.Vector3(0, 0, -10);
    expect(sphereMayCoverNdcPoint(c, 0.2, m, 0, 0)).toBe(true);
    expect(sphereMayCoverNdcPoint(c, 0.2, m, 0.9, 0)).toBe(false);
    expect(sphereMayCoverNdcPoint(c, 0.2, m, 0, -0.9)).toBe(false);
  });

  test('边界：恰好擦过算覆盖；margin 只放大保留范围，不缩小', () => {
    const m = ortho();
    const c = new THREE.Vector3(0.5, 0, -10);
    expect(sphereMayCoverNdcPoint(c, 0.5, m, 1, 0)).toBe(true);
    expect(sphereMayCoverNdcPoint(c, 0.1, m, 1, 0)).toBe(false);
    expect(sphereMayCoverNdcPoint(c, 0.1, m, 1, 0, 0.5)).toBe(true);
    // 负 margin 归一成 0，不能变成「更激进地剔除」
    expect(sphereMayCoverNdcPoint(c, 0.1, m, 1, 0, -1)).toBe(false);
  });

  test('退化 / 非法输入一律保守保留（宁可多画，不能漏拾取）', () => {
    const m = ortho();
    const far = new THREE.Vector3(100, 100, -10);
    expect(sphereMayCoverNdcPoint(far, 0, m, 0, 0)).toBe(false); // radius=0 是合法的点，照样能判
    expect(sphereMayCoverNdcPoint(far, -1, m, 0, 0)).toBe(true);
    expect(sphereMayCoverNdcPoint(far, Infinity, m, 0, 0)).toBe(true);
    expect(sphereMayCoverNdcPoint(far, NaN, m, 0, 0)).toBe(true);
    expect(sphereMayCoverNdcPoint(new THREE.Vector3(NaN, 0, -10), 0.1, m, 0, 0)).toBe(true);
    expect(sphereMayCoverNdcPoint(far, 0.1, m, NaN, 0)).toBe(true);
    expect(sphereMayCoverNdcPoint(far, 0.1, m, 0, 0, Infinity)).toBe(true);
  });

  test('球跨到相机背后（w<=0）一律保留，不做任何剔除', () => {
    const perspective = new THREE.Matrix4().makePerspective(-1, 1, 1, -1, 1, 100);
    expect(sphereMayCoverNdcPoint(new THREE.Vector3(0, 0, 5), 0.1, perspective, 0, 0)).toBe(true);
    // 前方的球仍按屏幕位置判定
    expect(sphereMayCoverNdcPoint(new THREE.Vector3(0, 0, -10), 0.1, perspective, 0, 0)).toBe(true);
  });

  test('结构不变量：球内采样点投影落在点击点上时，判据必须返回 true', () => {
    const m = ortho();
    let checked = 0;
    for (let i = 0; i < 120; i++) {
      const cx = (i % 11) / 10 - 0.5;
      const cy = (i % 7) / 6 - 0.5;
      const r = 0.05 + (i % 5) * 0.05;
      const center = new THREE.Vector3(cx, cy, -10);
      // 取球心本身当点击点：无论半径多大都必须判为覆盖
      expect(sphereMayCoverNdcPoint(center, r, m, cx, cy)).toBe(true);
      checked++;
      // 球外接立方体的 8 角点投影，AABB 必须包住球内采样点
      const px = cx + r * 0.5;
      const py = cy - r * 0.5;
      expect(sphereMayCoverNdcPoint(center, r, m, px, py)).toBe(true);
      checked++;
    }
    expect(checked).toBe(240);
  });

  test('透视矩阵下也按投影后的 NDC 判定，不是拿世界坐标直接比', () => {
    const m = new THREE.Matrix4().makePerspective(-1, 1, 1, -1, 1, 100);
    // z=-10 时 NDC 只有世界坐标的 1/10 左右，远处一个单位宽的球不该占满屏幕
    const c = new THREE.Vector3(0.9, 0, -10);
    expect(sphereMayCoverNdcPoint(c, 0.05, m, 0, 0)).toBe(false);
    expect(sphereMayCoverNdcPoint(c, 0.05, m, 0.09, 0)).toBe(true);
  });
});

describe('#29 拾取粗筛 · 材质位移判据', () => {
  test('没有状态纹理 / 路径 / 拔高的普通材质允许粗筛', () => {
    expect(hasPickDisplacement(new THREE.MeshBasicMaterial())).toBe(false);
    const mat = new THREE.MeshBasicMaterial();
    mat.userData.uBatchTexActive = { value: 0 };
    mat.userData.uPathTexActive = { value: 0 };
    mat.userData.uSelElevation = { value: 0 };
    expect(hasPickDisplacement(mat)).toBe(false);
  });

  test('单体状态 / GPU 路径 / 交叉淡化 / 选中拔高任一启用都不许粗筛', () => {
    const withFlag = (key: string, value: number) => {
      const mat = new THREE.MeshBasicMaterial();
      mat.userData[key] = { value };
      return mat;
    };
    expect(hasPickDisplacement(withFlag('uBatchTexActive', 1))).toBe(true);
    expect(hasPickDisplacement(withFlag('uPathTexActive', 1))).toBe(true);
    expect(hasPickDisplacement(withFlag('uBatchMix', 0.5))).toBe(true);
    expect(hasPickDisplacement(withFlag('uSelElevation', 3))).toBe(true);
    // uniforms 上那份也要认（Picker 抄写时会回退到这里）
    const viaUniforms = new THREE.MeshBasicMaterial();
    (viaUniforms as unknown as { uniforms: Record<string, { value: number }> }).uniforms = {
      uSelElevation: { value: 2 },
    };
    expect(hasPickDisplacement(viaUniforms)).toBe(true);
    const viaPathUniform = new THREE.MeshBasicMaterial();
    (viaPathUniform as unknown as { uniforms: Record<string, { value: number }> }).uniforms = {
      uPathTexActive: { value: 1 },
    };
    expect(hasPickDisplacement(viaPathUniform)).toBe(true);
  });

  test('材质数组只认第一个；缺失材质保守保留', () => {
    const a = new THREE.MeshBasicMaterial();
    const b = new THREE.MeshBasicMaterial();
    b.userData.uBatchTexActive = { value: 1 };
    expect(hasPickDisplacement([a, b])).toBe(false);
    expect(hasPickDisplacement([b, a])).toBe(true);
    expect(hasPickDisplacement(null)).toBe(true);
    expect(hasPickDisplacement(undefined)).toBe(true);
    expect(hasPickDisplacement([])).toBe(true);
  });
});

/* ------------------------------------------------------------------ 集成 */

interface FakeRenderer {
  render: (scene: THREE.Scene, camera: THREE.Camera) => void;
  [key: string]: unknown;
}

function fakeRenderer(onRender?: (scene: THREE.Scene) => void): FakeRenderer {
  return {
    domElement: { width: 200, height: 100, clientWidth: 200, clientHeight: 100 },
    toneMapping: 1,
    outputColorSpace: 'srgb',
    autoClear: false,
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    getViewport: (v: THREE.Vector4) => v.set(0, 0, 200, 100),
    setViewport: () => {},
    getClearColor: (c: THREE.Color) => c,
    getClearAlpha: () => 1,
    setClearColor: () => {},
    resetState: () => {},
    clear: () => {},
    render: (scene: THREE.Scene) => {
      onRender?.(scene);
    },
    readRenderTargetPixels: (_t: unknown, _x: number, _y: number, _w: number, _h: number, buf: Uint8Array) => {
      buf[0] = 1; buf[1] = 0; buf[2] = 1; buf[3] = 0; // objectId 0 / batchId 0
    },
  };
}

/** 造一块「可拾取」的普通 Mesh：包围球半径 0.1，摆在 (x, y, -10) */
function pickMesh(id: number, x: number, y: number): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geo.setAttribute('aBatchId', new THREE.Float32BufferAttribute([0, 0, 0], 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0.1);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  mesh.position.set(x, y, -10);
  mesh.userData.pickId = id;
  return mesh;
}

function visiblePickCount(scene: THREE.Scene): number {
  let n = 0;
  scene.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh && (o.userData as { pickId?: number }).pickId !== undefined) n++;
  });
  return n;
}

function setup(meshes: THREE.Mesh[], onRender?: (scene: THREE.Scene) => void) {
  const scene = new THREE.Scene();
  for (const m of meshes) scene.add(m);
  scene.updateMatrixWorld(true);
  const camera = new THREE.Camera();
  camera.projectionMatrix.copy(ortho());
  return { scene, camera, renderer: fakeRenderer(onRender) };
}

describe('#29 拾取粗筛 · Picker 集成', () => {
  test('屏幕外的网格不进 ID pass，命中结果不变，渲染后 visible 全部还原', () => {
    const near = pickMesh(1, 0, 0);
    const far = pickMesh(2, 0.9, 0.9);
    let duringRender = -1;
    const { scene, camera, renderer } = setup([near, far], (s) => {
      duringRender = visiblePickCount(s);
    });

    const picker = new Picker(renderer as never);
    const hit = picker.pick(scene, camera, 100, 50);

    expect(duringRender).toBe(1);
    expect(hit).toEqual({ objectId: 0, batchId: 0 });
    expect(near.visible).toBe(true);
    expect(far.visible).toBe(true);
    expect(far.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  test('包围球不可信的网格一律保留：frustumCulled=false / 无包围球 / 墨卡托偏移', () => {
    const noCull = pickMesh(2, 0.9, 0.9);
    noCull.frustumCulled = false;
    const noSphere = pickMesh(3, 0.9, 0.9);
    noSphere.geometry.boundingSphere = null;
    const mercator = pickMesh(4, 0.9, 0.9);
    mercator.geometry.setAttribute('aMercatorOffset', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));

    let duringRender = -1;
    const { scene, camera, renderer } = setup(
      [pickMesh(1, 0, 0), noCull, noSphere, mercator],
      (s) => { duringRender = visiblePickCount(s); }
    );
    new Picker(renderer as never).pick(scene, camera, 100, 50);
    expect(duringRender).toBe(4);
  });

  test('有 shader 位移 / 实例化 / 泼溅的网格一律保留', () => {
    const displaced = pickMesh(2, 0.9, 0.9);
    (displaced.material as THREE.MeshBasicMaterial).userData.uBatchTexActive = { value: 1 };
    const splat = pickMesh(3, 0.9, 0.9);
    splat.userData.isGaussianSplat = true;
    const instanced = new THREE.InstancedMesh(pickMesh(4, 0.9, 0.9).geometry, new THREE.MeshBasicMaterial(), 1);
    instanced.position.set(0.9, 0.9, -10);
    instanced.userData.pickId = 4;
    instanced.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0.1);

    let duringRender = -1;
    const { scene, camera, renderer } = setup(
      [pickMesh(1, 0, 0), displaced, splat, instanced],
      (s) => { duringRender = visiblePickCount(s); }
    );
    new Picker(renderer as never).pick(scene, camera, 100, 50);
    expect(duringRender).toBe(4);
  });

  test('默认场景（没有可用包围球）退化成原来的全量 ID pass', () => {
    const a = pickMesh(1, 0, 0);
    a.geometry.boundingSphere = null;
    const b = pickMesh(2, 0.9, 0.9);
    b.geometry.boundingSphere = null;
    let duringRender = -1;
    const { scene, camera, renderer } = setup([a, b], (s) => {
      duringRender = visiblePickCount(s);
    });
    const hit = new Picker(renderer as never).pick(scene, camera, 100, 50);
    expect(duringRender).toBe(2);
    expect(hit).toEqual({ objectId: 0, batchId: 0 });
  });

  test('render 抛异常时，临时隐藏与换过的材质照样还原', () => {
    const near = pickMesh(1, 0, 0);
    const far = pickMesh(2, 0.9, 0.9);
    const original = far.material;
    const { scene, camera, renderer } = setup([near, far]);
    renderer.render = () => { throw new Error('boom'); };
    const picker = new Picker(renderer as never);
    expect(() => picker.pick(scene, camera, 100, 50)).toThrow('boom');
    expect(far.visible).toBe(true);
    expect(far.material).toBe(original);
  });
});
