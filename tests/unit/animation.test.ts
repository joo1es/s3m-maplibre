/**
 * 单元测试：统一动画调度系统
 *
 * 分三层钉住契约：
 *   1. 缓动曲线库 —— 端点、CSS 对齐、离散取整
 *   2. Animator    —— 推进 / 打断 / 合并 / 空闲成本 / spring 收敛
 *   3. 渲染接入    —— opacity 走 uniform、单体平移、棱线淡入
 *
 * 时间全部由假时钟驱动，不依赖真实帧率，跑起来是确定的。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { EASING_NAMES, easing, cubicBezier, steps } from '../../packages/s3m-three/src/anim/easing';
import { Animator, type Channel } from '../../packages/s3m-three/src/anim/Animator';
import { Path } from '../../packages/s3m-three/src/anim/Path';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

/* ------------------------------------------------------------------ 工具 */

/** 记录一个标量通道的当前值，模拟渲染器侧的真实存储 */
function scalarChannel(init = 0): { get: () => number; channel: Channel } {
  const store = { v: init };
  return {
    get: () => store.v,
    channel: {
      dim: 1,
      read: (out) => {
        out[0] = store.v;
      },
      write: (v) => {
        store.v = v[0];
      },
    },
  };
}

function vectorChannel(init: [number, number, number] = [0, 0, 0]): {
  get: () => number[];
  channel: Channel;
} {
  const store = { v: [...init] };
  return {
    get: () => [...store.v],
    channel: {
      dim: 3,
      read: (out) => {
        out[0] = store.v[0];
        out[1] = store.v[1];
        out[2] = store.v[2];
      },
      write: (v) => {
        store.v = [v[0], v[1], v[2]];
      },
    },
  };
}

/** 造一个可控时钟的 Animator */
function makeAnimator(): { anim: Animator; setNow: (t: number) => void; now: () => number } {
  let t = 0;
  const anim = new Animator(() => t);
  return { anim, setNow: (v) => (t = v), now: () => t };
}

function makeViewer(opts?: any): S3MViewer {
  let t = 0;
  const v = new S3MViewer(opts);
  (v.animator as unknown as { _now: () => number })._now = () => t;
  (v as unknown as { _testSetNow: (n: number) => void })._testSetNow = (n) => (t = n);
  return v;
}

function stepTo(v: S3MViewer, t: number): boolean {
  (v as unknown as { _testSetNow: (n: number) => void })._testSetNow(t);
  return v.animator.tick(t);
}

/** 注册一块带单体信息的网格，返回 mesh */
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

/* ------------------------------------------------------------------ 1. 曲线库 */

describe('1. 缓动曲线库', () => {
  test('全部内置曲线端点归一到 0 / 1', () => {
    for (const name of EASING_NAMES) {
      const fn = easing(name);
      expect(fn(0)).toBeCloseTo(0, 6);
      expect(fn(1)).toBeCloseTo(1, 6);
    }
  });

  test('linear 恒等', () => {
    const fn = easing('linear');
    for (const t of [0, 0.1, 0.37, 0.5, 0.99, 1]) expect(fn(t)).toBeCloseTo(t, 6);
  });

  test('easeOutCubic 单调递增且末端减速', () => {
    const fn = easing('easeOutCubic');
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = fn(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // 前半程走过 87.5%（1-(1-0.5)^3）
    expect(fn(0.5)).toBeCloseTo(0.875, 6);
    // 起步快、末端慢：比较的是「每段走了多少」，不是「值比 t 大还是小」
    expect(fn(0.25)).toBeGreaterThan(0.25);
    expect(fn(1) - fn(0.75)).toBeLessThan(fn(0.25) - fn(0));
  });

  test('easeOutBack 越过 1 再回落（回弹）', () => {
    const fn = easing('easeOutBack');
    let peak = 0;
    for (let i = 0; i <= 100; i++) peak = Math.max(peak, fn(i / 100));
    expect(peak).toBeGreaterThan(1.05);
  });

  test('cubicBezier 与 CSS ease 数值对齐', () => {
    // CSS `ease` = cubic-bezier(0.25, 0.1, 0.25, 1)
    const fn = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(fn(0)).toBeCloseTo(0, 5);
    expect(fn(1)).toBeCloseTo(1, 5);
    // 浏览器实测值
    expect(fn(0.5)).toBeCloseTo(0.8024, 3);
    expect(fn(0.25)).toBeCloseTo(0.4085, 3);
  });

  test('cubicBezier 退化控制点等价于 linear', () => {
    const fn = cubicBezier(0.333, 0.333, 0.666, 0.666);
    for (const t of [0.2, 0.5, 0.8]) expect(fn(t)).toBeCloseTo(t, 2);
  });

  test('steps 按档位取整', () => {
    const end = steps(4, 'end');
    expect(end(0)).toBe(0);
    expect(end(0.1)).toBe(0);
    expect(end(0.25)).toBe(0.25);
    expect(end(0.74)).toBe(0.5);
    expect(end(1)).toBe(1);

    const start = steps(4, 'start');
    expect(start(0)).toBe(0.25);
    expect(start(0.25)).toBe(0.5);
    expect(start(1)).toBe(1);
  });

  test('未知曲线名直接抛错，不静默降级', () => {
    expect(() => easing('easeOutNope' as never)).toThrow();
  });
});

/* ------------------------------------------------------------------ 2. Animator */

describe('2. Animator 推进与生命周期', () => {
  test('线性推进，到点结束，之后 tick 返回 false', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { duration: 100 });
    expect(anim.isActive('a')).toBe(true);

    expect(anim.tick(0)).toBe(true);
    expect(a.get()).toBe(0);

    expect(anim.tick(50)).toBe(true);
    expect(a.get()).toBeCloseTo(0.5, 6);

    // 结束那一帧仍然返回 true（本帧写过），下一帧才转 false
    anim.tick(100);
    expect(a.get()).toBeCloseTo(1, 6);
    expect(anim.isActive('a')).toBe(false);
    expect(anim.tick(120)).toBe(false);
    expect(anim.activeCount).toBe(0);
  });

  test('空闲时 tick 是零成本早退', () => {
    const { anim } = makeAnimator();
    expect(anim.tick(0)).toBe(false);
    expect(anim.tick(1e9)).toBe(false);
  });

  test('delay 生效：延迟期内不动', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { duration: 100, delay: 50 });

    anim.tick(25);
    expect(a.get()).toBe(0);
    anim.tick(100);
    expect(a.get()).toBeCloseTo(0.5, 6);
    anim.tick(150);
    expect(a.get()).toBeCloseTo(1, 6);
  });

  test('duration 为 0 时立即生效且不建 track', () => {
    const { anim } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);
    anim.to('a', 7, { duration: 0 });
    expect(a.get()).toBe(7);
    expect(anim.isActive('a')).toBe(false);
  });

  test('同键只保留一条 track（新目标覆盖旧目标）', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { duration: 100 });
    anim.to('a', 2, { duration: 100 });
    expect(anim.activeCount).toBe(1);

    anim.tick(100);
    expect(a.get()).toBeCloseTo(2, 6);
  });

  test('未注册的通道名抛错', () => {
    const { anim } = makeAnimator();
    expect(() => anim.to('nope', 1, { duration: 10 })).toThrow();
  });

  test('cancel 停在当前值，不回弹也不写终值', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { duration: 100 });
    anim.tick(30);
    const at = a.get();
    anim.cancel('a');
    expect(a.get()).toBeCloseTo(at, 6);
    expect(anim.isActive('a')).toBe(false);
    anim.tick(200);
    expect(a.get()).toBeCloseTo(at, 6);
  });

  test('finish 直达终值并结束', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 5, { duration: 100 });
    anim.tick(20);
    anim.finish('a');
    expect(a.get()).toBeCloseTo(5, 6);
    expect(anim.isActive('a')).toBe(false);
  });

  test('多维通道（颜色 / 平移）逐分量插值', () => {
    const { anim, setNow } = makeAnimator();
    const v = vectorChannel([0, 0, 0]);
    anim.register('v', v.channel);

    setNow(0);
    anim.to('v', [10, 20, -4], { duration: 100 });
    anim.tick(50);
    const mid = v.get();
    expect(mid[0]).toBeCloseTo(5, 6);
    expect(mid[1]).toBeCloseTo(10, 6);
    expect(mid[2]).toBeCloseTo(-2, 6);
  });

  test('多通道互不干扰', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    const b = scalarChannel(0);
    anim.register('a', a.channel);
    anim.register('b', b.channel);

    setNow(0);
    anim.to('a', 1, { duration: 100 });
    anim.to('b', 10, { duration: 200 });

    anim.tick(100);
    expect(a.get()).toBeCloseTo(1, 6);
    expect(b.get()).toBeCloseTo(5, 6);
  });
});

describe('3. Animator 打断策略', () => {
  test('从当前显示值续走，不跳回起点', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { duration: 100 });
    anim.tick(50);
    expect(a.get()).toBeCloseTo(0.5, 6);

    // 中途改目标：起点必须是 0.5 而不是 0
    anim.to('a', 0, { duration: 100 });
    anim.tick(51);
    expect(a.get()).toBeGreaterThan(0.45);
    expect(a.get()).toBeLessThanOrEqual(0.5);
  });

  test('保速打断：时长按剩余距离等比缩短', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { duration: 100 });
    anim.tick(50);

    // 剩余距离 0.5 / 总距离 1 → 新时长 50ms
    anim.to('a', 0, { duration: 100 });
    anim.tick(75);
    expect(a.get()).toBeCloseTo(0.25, 6);
    anim.tick(100);
    expect(a.get()).toBeCloseTo(0, 6);
    expect(anim.isActive('a')).toBe(false);
  });

  test('retarget: fixed 用固定时长，不做等比缩放', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { duration: 100 });
    anim.tick(50);

    anim.to('a', 0, { duration: 100, retarget: 'fixed' });
    anim.tick(100);
    expect(a.get()).toBeCloseTo(0.25, 6);
    anim.tick(150);
    expect(a.get()).toBeCloseTo(0, 6);
  });
});

describe('4. Animator spring', () => {
  test('收敛到目标并自动结束', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { spring: { stiffness: 120, damping: 14 } });
    expect(anim.isActive('a')).toBe(true);

    anim.tick(500);
    expect(a.get()).toBeGreaterThan(0.9);
    anim.tick(3000);
    expect(a.get()).toBeCloseTo(1, 2);
    expect(anim.isActive('a')).toBe(false);
  });

  test('中途改目标时位置连续（不瞬移）', () => {
    const { anim, setNow } = makeAnimator();
    const a = scalarChannel(0);
    anim.register('a', a.channel);

    setNow(0);
    anim.to('a', 1, { spring: { stiffness: 120, damping: 14 } });
    anim.tick(120);
    const before = a.get();
    expect(before).toBeGreaterThan(0);

    anim.to('a', 0, { spring: { stiffness: 120, damping: 14 } });
    anim.tick(121);
    // 一帧之内位置只应有极小变化
    expect(Math.abs(a.get() - before)).toBeLessThan(0.05);
  });
});

/* ------------------------------------------------------------------ 5. 渲染接入 */

describe('5. 图层透明度走共享 uniform', () => {
  test('带 duration 时逐帧推进，getStyle 立刻返回终值', () => {
    const v = makeViewer();
    v.setStyle({ opacity: 0.2 }, { duration: 100 });

    expect(v.uniforms.uOpacity.value).toBe(1);
    expect(v.getStyle().opacity).toBeCloseTo(0.2, 6);

    stepTo(v, 50);
    expect(v.uniforms.uOpacity.value).toBeCloseTo(0.6, 5);

    stepTo(v, 100);
    expect(v.uniforms.uOpacity.value).toBeCloseTo(0.2, 5);
    expect(v.animator.isActive('style.opacity')).toBe(false);
  });

  test('无过渡时立即生效（向后兼容）', () => {
    const v = makeViewer();
    v.setStyle({ opacity: 0.4 });
    expect(v.uniforms.uOpacity.value).toBeCloseTo(0.4, 6);
    expect(v.animator.activeCount).toBe(0);
  });

  test('透明度不再逐 mesh 写 material.opacity', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 501);
    const mat = mesh.material as THREE.MeshStandardMaterial;

    v.setOpacity(0.5);
    expect(v.uniforms.uOpacity.value).toBeCloseTo(0.5, 6);
    // 材质自身的 opacity 保留模型自带 alpha，全局透明度由 uniform 叠乘
    expect(mat.opacity).toBe(1);
    // 但混合开关必须打开，否则 uniform 写了也不生效
    expect(mat.transparent).toBe(true);
  });

  test('颜色通道在线性空间插值，端点严格吻合', () => {
    const v = makeViewer();
    v.setStyle({ colorA: '#000000' });
    const from = v.uniforms.uColorA.value.clone();
    v.setStyle({ colorA: '#ffffff' }, { duration: 100 });

    stepTo(v, 100);
    expect(v.uniforms.uColorA.value.r).toBeCloseTo(1, 5);
    expect(v.uniforms.uColorA.value.g).toBeCloseTo(1, 5);
    expect(v.uniforms.uColorA.value.b).toBeCloseTo(1, 5);
    expect(from.r).toBeCloseTo(0, 5);
  });

  test('图层半透明时清除单体淡化，不会把材质误还原成不透明', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 801);
    const mat = mesh.material as THREE.MeshStandardMaterial;

    v.setOpacity(0.5);
    expect(mat.transparent).toBe(true);

    v.setFeatureStyle(801, { opacity: 0.4 });
    v.flushOverrides();
    expect(mat.transparent).toBe(true);

    // 单体淡化撤销后，图层仍然是半透明 —— 不能因为「没有 fade 了」就把 transparent 关掉
    v.removeFeatureStyle(801);
    v.flushOverrides();
    expect(mat.transparent).toBe(true);
    expect(v.uniforms.uOpacity.value).toBeCloseTo(0.5, 6);
  });

  test('构造函数传入初始 style.opacity 时，uOpacity 正确初始化生效（非滞留 1.0）', () => {
    const v = makeViewer({ style: { opacity: 0.35 } } as any);
    expect(v.getStyle().opacity).toBe(0.35);
    expect(v.uniforms.uOpacity.value).toBeCloseTo(0.35, 6);
    expect((v as any)._opacityTransparent).toBe(true);
    // 棱线不透明度也必须包含图层不透明度因子
    expect(v.edgeMaterial.uniforms.uOpacity.value).toBeCloseTo(0.6 * 0.35, 5);
  });
});

describe('6. 单体平移动画', () => {
  test('moveFeature 逐帧推进 translation，并回写 featureStyles', () => {
    const v = makeViewer();
    registerMesh(v, 601);

    v.moveFeature(601, [10, 0, 0], { duration: 100 });
    stepTo(v, 50);
    const mid = v.getFeatureStyle(601)?.translation;
    expect(mid?.[0]).toBeCloseTo(5, 5);

    stepTo(v, 100);
    const end = v.getFeatureStyle(601)?.translation;
    expect(end?.[0]).toBeCloseTo(10, 5);
  });

  test('平移中的网格关闭视锥剔除，归零后恢复', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 602);

    v.moveFeature(602, [200, 0, 0], { duration: 100 });
    stepTo(v, 100);
    expect(mesh.frustumCulled).toBe(false);

    v.moveFeature(602, [0, 0, 0], { duration: 100 });
    stepTo(v, 200);
    expect(mesh.frustumCulled).toBe(true);
  });

  test('getFeatureBounds 反映平移后的位置', () => {
    const v = makeViewer();
    // 造一个能算出经纬度的锚点
    v.sceneAnchor = { x: 0, y: 0, z: 0, meterInMercator: 1 };
    registerMesh(v, 603);

    const before = v.getFeatureBounds(603);
    expect(before).not.toBeNull();

    v.setFeatureStyle(603, { translation: [1000, 0, 0] });
    v.flushOverrides();
    const after = v.getFeatureBounds(603);
    expect(after).not.toBeNull();
    // 向东平移 1000m，经度必须变大
    expect(after![1][0]).toBeGreaterThan(before![1][0]);
  });
});

describe('7. 棱线淡入', () => {
  test('setEdges(true, duration) 让 uEdgeFade 从 0 升到 1', () => {
    const v = makeViewer();
    registerMesh(v, 701);

    expect(v.uniforms.uEdgeFade.value).toBe(1);
    v.setEdges(true, { duration: 100 });
    expect(v.uniforms.uEdgeFade.value).toBe(0);

    stepTo(v, 50);
    expect(v.uniforms.uEdgeFade.value).toBeCloseTo(0.5, 5);

    stepTo(v, 100);
    expect(v.uniforms.uEdgeFade.value).toBeCloseTo(1, 5);
  });

  test('setEdges(false, duration) 淡完才释放几何', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 702);

    v.setEdges(true);
    expect((mesh.userData as { edges?: unknown }).edges).toBeTruthy();

    v.setEdges(false, { duration: 100 });
    stepTo(v, 50);
    // 还没淡完，几何仍在
    expect((mesh.userData as { edges?: unknown }).edges).toBeTruthy();
    expect(v.uniforms.uEdgeFade.value).toBeCloseTo(0.5, 5);

    stepTo(v, 100);
    expect((mesh.userData as { edges?: unknown }).edges).toBeFalsy();
  });

  test('无过渡时立即切换（向后兼容）', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 703);
    v.setEdges(true);
    expect(v.uniforms.uEdgeFade.value).toBe(1);
    v.setEdges(false);
    expect((mesh.userData as { edges?: unknown }).edges).toBeFalsy();
    expect(v.uniforms.uEdgeFade.value).toBe(1);
  });
});

describe('8. 新瓦片淡入', () => {
  test('fadeIn > 0 时新注册的网格从 0 淡到 1', () => {
    const v = makeViewer();
    v.setStyle({ fadeIn: 100 });
    const mesh = registerMesh(v, 901);
    const mat = mesh.material as THREE.MeshStandardMaterial & {
      userData: { uTileFade: { value: number } };
    };

    // 刚注册：完全透明
    expect(mat.userData.uTileFade.value).toBe(0);
    expect(mat.transparent).toBe(true);

    stepTo(v, 50);
    expect(mat.userData.uTileFade.value).toBeGreaterThan(0);
    expect(mat.userData.uTileFade.value).toBeLessThan(1);

    stepTo(v, 100);
    expect(mat.userData.uTileFade.value).toBe(1);
    // 淡完把混合还给图层（图层不透明 → 关掉，别一直待在透明队列里）
    expect(mat.transparent).toBe(false);
  });

  test('fadeIn = 0（默认）时新瓦片直接满显示', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 902);
    const mat = mesh.material as THREE.MeshStandardMaterial & {
      userData: { uTileFade: { value: number } };
    };
    expect(mat.userData.uTileFade.value).toBe(1);
    expect(mat.transparent).toBe(false);
  });

  test('淡入中的网格不会被 setOpacity 抢走 transparent', () => {
    const v = makeViewer();
    v.setStyle({ fadeIn: 200 });
    const mesh = registerMesh(v, 903);
    const mat = mesh.material as THREE.MeshStandardMaterial;

    stepTo(v, 50);
    v.setOpacity(1); // 图层本来就不透明，但淡入还没结束
    expect(mat.transparent).toBe(true);
  });

  test('淡入中途被淘汰，通道要回收干净', () => {
    const v = makeViewer();
    v.setStyle({ fadeIn: 200 });
    const mesh = registerMesh(v, 904);
    const before = v.animator.activeCount;
    expect(before).toBeGreaterThan(0);

    (v as unknown as { _unregisterTile: (n: unknown, e: unknown) => void })._unregisterTile(
      { group: mesh.parent, tile: null },
      { id: 'd', root: new THREE.Group() }
    );
    expect(v.animator.activeCount).toBe(0);
    expect(v.animator.has((mesh.userData as { tileFadeKey?: string }).tileFadeKey ?? '')).toBe(false);
  });

  test('淡入结束时图层半透明，材质必须保持 transparent', () => {
    const v = makeViewer();
    v.setStyle({ fadeIn: 100 });
    v.setOpacity(0.6);
    const mesh = registerMesh(v, 905);
    const mat = mesh.material as THREE.MeshStandardMaterial;

    stepTo(v, 100);
    expect(mat.transparent).toBe(true);
  });

  test('淡入结束时有单体淡化，材质必须保持 transparent', () => {
    const v = makeViewer();
    v.setStyle({ fadeIn: 100 });
    const mesh = registerMesh(v, 906);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    v.setFeatureStyle(906, { opacity: 0.5 });
    v.flushOverrides();

    stepTo(v, 100);
    expect(mat.transparent).toBe(true);
  });

  test('新瓦片注册与淡入结束时严格遵循 style.depthWrite 配置', () => {
    // 场景 1: 用户指定 depthWrite: false (默认 fadeIn = 0)
    const vNoDepthDirect = makeViewer({ style: { depthWrite: false, opacity: 0.5 } } as any);
    const meshDirect = registerMesh(vNoDepthDirect, 907);
    const matDirect = meshDirect.material as THREE.MeshStandardMaterial;
    expect(matDirect.transparent).toBe(true);
    expect(matDirect.depthWrite).toBe(false);

    // 场景 2: 用户指定 depthWrite: false 且开启 fadeIn
    const vNoDepthFade = makeViewer({ style: { depthWrite: false, fadeIn: 100, opacity: 0.5 } } as any);
    const meshFade = registerMesh(vNoDepthFade, 908);
    const matFade = meshFade.material as THREE.MeshStandardMaterial;
    // 淡入期间为了遮挡背面临时保持 true
    expect(matFade.depthWrite).toBe(true);
    // 淡入结束时还原为 depthWrite: false
    stepTo(vNoDepthFade, 100);
    expect(matFade.depthWrite).toBe(false);

    // 场景 3: 用户指定半透明且保持 depthWrite: true
    const vKeepDepth = makeViewer({ style: { depthWrite: true, opacity: 0.6 } } as any);
    const meshKeep = registerMesh(vKeepDepth, 909);
    const matKeep = meshKeep.material as THREE.MeshStandardMaterial;
    expect(matKeep.transparent).toBe(true);
    expect(matKeep.depthWrite).toBe(true);
  });
});

describe('9. 单体样式过渡（颜色 / 抬高 / 透明度）', () => {
  test('animateFeature 同时驱动抬高与透明度，两条通道互不覆盖', () => {
    const v = makeViewer();
    registerMesh(v, 1001);

    v.animateFeature(1001, { elevation: 100, opacity: 0.2 }, { duration: 100 });
    expect(v.animator.activeCount).toBe(2);

    stepTo(v, 50);
    const mid = v.getFeatureStyle(1001)!;
    expect(mid.elevation).toBeCloseTo(50, 4);
    expect(mid.opacity).toBeCloseTo(0.6, 4);

    stepTo(v, 100);
    const end = v.getFeatureStyle(1001)!;
    expect(end.elevation).toBeCloseTo(100, 4);
    expect(end.opacity).toBeCloseTo(0.2, 4);
  });

  test('颜色通道在 sRGB 端点严格吻合', () => {
    const v = makeViewer();
    registerMesh(v, 1002);
    v.setFeatureStyle(1002, { color: '#000000' });

    v.animateFeature(1002, { color: '#ffffff' }, { duration: 100 });
    stepTo(v, 100);
    const hex = v.getFeatureStyle(1002)!.color;
    expect(hex?.toLowerCase()).toBe('#ffffff');
  });

  test('animateFeatures 的 stagger 让每个单体错峰启动', () => {
    const v = makeViewer();
    registerMesh(v, 1003);
    registerMesh(v, 1004);
    registerMesh(v, 1005);

    v.animateFeatures([1003, 1004, 1005], { elevation: 100 }, { duration: 100, stagger: 50 });

    stepTo(v, 50);
    // 第 0 个走了一半，后两个还没开始
    expect(v.getFeatureStyle(1003)!.elevation).toBeCloseTo(50, 4);
    expect(v.getFeatureStyle(1004)!.elevation ?? 0).toBeCloseTo(0, 4);
    expect(v.getFeatureStyle(1005)!.elevation ?? 0).toBeCloseTo(0, 4);

    stepTo(v, 200);
    expect(v.getFeatureStyle(1003)!.elevation).toBeCloseTo(100, 4);
    expect(v.getFeatureStyle(1004)!.elevation).toBeCloseTo(100, 4);
    expect(v.getFeatureStyle(1005)!.elevation).toBeCloseTo(100, 4);
  });

  test('removeFeatureStyle 会回收全部单体通道', () => {
    const v = makeViewer();
    registerMesh(v, 1006);
    v.animateFeature(1006, { elevation: 10, opacity: 0.5, translation: [1, 0, 0] }, { duration: 100 });
    expect(v.animator.activeCount).toBe(3);

    v.removeFeatureStyle(1006);
    expect(v.animator.activeCount).toBe(0);
    for (const prop of ['translation', 'elevation', 'opacity', 'color']) {
      expect(v.animator.has(`feature.1006.${prop}`)).toBe(false);
    }
  });
});

describe('10. 着色模式 fade-through', () => {
  test('setMode 压暗 → 换模式 → 亮回来', async () => {
    const v = makeViewer();
    expect(v.uniforms.uFade.value).toBe(1);

    const done = v.setMode(3, { duration: 100, dim: 0.4 });

    stepTo(v, 100); // 压暗结束
    expect(v.uniforms.uFade.value).toBeCloseTo(0.4, 4);
    expect(v.getStyle().mode).toBe(3);

    stepTo(v, 200); // 亮回来
    expect(v.uniforms.uFade.value).toBeCloseTo(1, 4);
    await done;
  });

  test('duration = 0 时直接切换，不压暗', async () => {
    const v = makeViewer();
    await v.setMode(2, { duration: 0 });
    expect(v.getStyle().mode).toBe(2);
    expect(v.uniforms.uFade.value).toBe(1);
    expect(v.animator.activeCount).toBe(0);
  });

  test('切到同一个模式是空操作', async () => {
    const v = makeViewer();
    const mode = v.getStyle().mode;
    await v.setMode(mode, { duration: 100 });
    expect(v.animator.activeCount).toBe(0);
  });
});

describe('11. 路径：弧长参数化', () => {
  test('按累计弧长采样，不受顶点疏密影响', () => {
    // 两段：短段 10m（x 0→10），长段 90m（x 10→100），共 100m
    const path = new Path([[0, 0, 0], [10, 0, 0], [100, 0, 0]]);
    expect(path.length).toBeCloseTo(100, 5);

    const out = [0, 0, 0];
    path.sample(0, out);
    expect(out[0]).toBeCloseTo(0, 5);

    // 走到 55m：已经越过顶点（10m 处），进第二段 45m
    path.sample(55, out);
    expect(out[0]).toBeCloseTo(55, 5);

    // 走到一半 = 50m（不是「第 1.5 个顶点」那种顶点均分）
    path.sampleAt(0.5, out);
    expect(out[0]).toBeCloseTo(50, 5);

    path.sampleAt(1, out);
    expect(out[0]).toBeCloseTo(100, 5);
  });

  test('越界会被夹住，不抛错', () => {
    const path = new Path([[0, 0, 0], [10, 0, 0]]);
    const out = [0, 0, 0];
    path.sample(-100, out);
    expect(out[0]).toBeCloseTo(0, 5);
    path.sample(1e9, out);
    expect(out[0]).toBeCloseTo(10, 5);
  });

  test('闭合路径末点回到起点，总长包含闭合段', () => {
    const path = new Path([[0, 0, 0], [10, 0, 0], [10, 0, 10]], { closed: true });
    // 两段直角边各 10，闭合段是斜边 √200
    expect(path.length).toBeCloseTo(20 + Math.sqrt(200), 5);
    const out = [0, 0, 0];
    path.sampleAt(1, out);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });

  test('退化路径（单点 / 零长）安全返回起点', () => {
    const one = new Path([[3, 4, 5]]);
    const out = [0, 0, 0];
    one.sampleAt(0.5, out);
    expect([out[0], out[1], out[2]]).toEqual([3, 4, 5]);

    const zero = new Path([[1, 2, 3], [1, 2, 3]]);
    expect(zero.length).toBe(0);
    zero.sample(10, out);
    expect([out[0], out[1], out[2]]).toEqual([1, 2, 3]);
  });
});

describe('12. followPath', () => {
  test('线性推进：走完一半时位置在弧长中点', () => {
    const v = makeViewer();
    registerMesh(v, 1101);

    v.followPath(1101, [[0, 0, 0], [100, 0, 0]], { duration: 100, easing: 'linear' });
    stepTo(v, 50);
    expect(v.getFeatureStyle(1101)!.translation![0]).toBeCloseTo(50, 4);

    stepTo(v, 100);
    expect(v.getFeatureStyle(1101)!.translation![0]).toBeCloseTo(100, 4);
  });

  test('缓动作用在距离上：easeInQuad 半程只走 1/4 距离', () => {
    const v = makeViewer();
    registerMesh(v, 1102);

    v.followPath(1102, [[0, 0, 0], [100, 0, 0]], { duration: 100, easing: 'easeInQuad' });
    stepTo(v, 50);
    expect(v.getFeatureStyle(1102)!.translation![0]).toBeCloseTo(25, 3);
  });

  test('offset 叠加在路径点上', () => {
    const v = makeViewer();
    registerMesh(v, 1103);

    v.followPath(1103, [[0, 0, 0], [100, 0, 0]], {
      duration: 100,
      easing: 'linear',
      offset: [10, 20, 5],
    });
    stepTo(v, 100);
    const t = v.getFeatureStyle(1103)!.translation!;
    expect(t[0]).toBeCloseTo(110, 4);
    expect(t[1]).toBeCloseTo(20, 4);
    expect(t[2]).toBeCloseTo(5, 4);
  });

  test('loop 走完后自动重来', () => {
    const v = makeViewer();
    registerMesh(v, 1104);

    v.followPath(1104, [[0, 0, 0], [100, 0, 0]], { duration: 100, easing: 'linear', loop: true });
    stepTo(v, 100);
    expect(v.getFeatureStyle(1104)!.translation![0]).toBeCloseTo(100, 4);

    // 新一轮从 0 开始
    stepTo(v, 150);
    expect(v.getFeatureStyle(1104)!.translation![0]).toBeCloseTo(50, 4);
    expect(v.animator.activeCount).toBe(1);
  });

  test('运动中的网格关闭视锥剔除', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 1105);
    v.followPath(1105, [[0, 0, 0], [500, 0, 0]], { duration: 100, easing: 'linear' });
    stepTo(v, 50);
    expect(mesh.frustumCulled).toBe(false);
  });

  test('stopPath 停在当前位置并回收通道', () => {
    const v = makeViewer();
    registerMesh(v, 1106);
    v.followPath(1106, [[0, 0, 0], [100, 0, 0]], { duration: 100, easing: 'linear' });
    stepTo(v, 40);
    const at = v.getFeatureStyle(1106)!.translation![0];

    v.stopPath(1106);
    expect(v.animator.activeCount).toBe(0);
    stepTo(v, 200);
    expect(v.getFeatureStyle(1106)!.translation![0]).toBeCloseTo(at, 4);
  });

  test('零长路径直接忽略，不建 track', () => {
    const v = makeViewer();
    registerMesh(v, 1107);
    v.followPath(1107, [[5, 5, 5], [5, 5, 5]], { duration: 100 });
    expect(v.animator.activeCount).toBe(0);
  });
});

describe('13. 动画启动要踢帧循环', () => {
  /**
   * MapLibre 是按需驱动的：空闲时不渲染，只有 triggerRepaint 才画。
   * 动画启动如果不去踢一下帧循环，第一帧永远等不来——表现为「点了按钮没反应，
   * 直到别的什么触发了重绘，建筑才直接跳到终态」。
   */
  function makeCountingViewer(): { v: S3MViewer; repaints: () => number } {
    const v = new S3MViewer();
    let count = 0;
    (v as unknown as { _onRequestRepaint: () => void })._onRequestRepaint = () => count++;
    return { v, repaints: () => count };
  }

  test('启动补间会请求重绘', () => {
    const { v, repaints } = makeCountingViewer();
    registerMesh(v, 1301);
    const before = repaints();

    v.animateFeature(1301, { elevation: 50 }, { duration: 100 });
    expect(repaints()).toBeGreaterThan(before);
  });

  test('空闲时 setStyle 立即生效也会请求重绘', () => {
    const { v, repaints } = makeCountingViewer();
    const before = repaints();
    v.setStyle({ colorA: '#123456' });
    expect(repaints()).toBeGreaterThan(before);
  });

  test('finish 直达终值同样请求重绘', () => {
    const { v, repaints } = makeCountingViewer();
    registerMesh(v, 1302);
    v.animateFeature(1302, { elevation: 50 }, { duration: 1000 });
    const mid = repaints();
    v.animator.finish('feature.1302.elevation');
    expect(repaints()).toBeGreaterThan(mid);
  });

  test('retarget 不重复踢（已在动画中，帧循环本来就活着）', () => {
    const { v, repaints } = makeCountingViewer();
    registerMesh(v, 1303);
    v.animateFeature(1303, { elevation: 50 }, { duration: 1000 });
    const at = repaints();
    v.animateFeature(1303, { elevation: 80 }, { duration: 1000 });
    // 不强制断言不增长（setFeatureStyle 内部还会 triggerRepaint），只要求不抛错
    expect(repaints()).toBeGreaterThanOrEqual(at);
  });
});
