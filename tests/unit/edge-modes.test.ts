/**
 * 单元测试：棱线画法扩展（外扩轮廓 / 折边线外推 / 强制 CPU）
 *
 * 原来 `style.edges` 只有 boolean 一种口径：true = CPU 折边线，false = 关。
 * 这里把它扩成 `boolean | EdgeStyle | EdgeStyle[]`，并新增两条画法：
 *   - 'hull'   ：背面外扩轮廓（选中侧 outlineStyle:'hull' 那套，改成整场景）
 *   - 'offset' ：CPU 折边线 + 沿边法线往外推（避免线被面吃掉）
 * 另外 `forceCpuEdges` 让「数据自带棱线包」的数据也能吃上 edgeWidth / 外扩 / 单体跟随。
 *
 * 钉住的契约：
 *   1. 归一化：boolean / 单值 / 数组 → 四个开关，未知值一律当关
 *   2. 默认口径逐字不变：不传 edges 时既没有折边线也没有外扩壳
 *   3. hull 是背面外扩（BackSide + uSelWhole=1），且不建 CPU 折边线
 *   4. offset 的棱线几何必须带单位边法线，否则外推方向是垃圾
 *   5. forceCpuEdges 时 native 棱线包隐藏，改由 CPU 现算
 *   6. 换画法要拆掉旧装饰再重建（不能 hull 和 line 同时留着）
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { resolveEdgeModes } from '../../packages/s3m-three/src/render/StyleMaterial';
import { GpuEdgePass } from '../../packages/s3m-three/src/render/GpuEdgePass';
import { buildFeatureEdgeSegments } from '../../packages/s3m-three/src/render/EdgeLines';

const OFF = { enabled: false, line: false, offset: false, hull: false, gpu: false };

function makeBoxMesh(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(10, 10, 10);
  geo.computeBoundingBox();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
}

function registerBox(viewer: S3MViewer): THREE.Mesh {
  const group = new THREE.Group();
  const mesh = makeBoxMesh();
  group.add(mesh);
  (viewer as any)._registerTile({ group, tile: null }, { id: 'd', root: new THREE.Group() });
  return mesh;
}

/** 造一块「数据自带棱线包」的瓦片：group 上打 hasNativeEdges，外加一条 isEdgeLines */
function registerNativeTile(viewer: S3MViewer): { mesh: THREE.Mesh; lines: THREE.LineSegments } {
  const group = new THREE.Group();
  group.userData.hasNativeEdges = true;
  const mesh = makeBoxMesh();
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3)
    ),
    new THREE.LineBasicMaterial()
  );
  lines.userData.isEdgeLines = true;
  group.add(mesh, lines);
  (viewer as any)._registerTile({ group, tile: null }, { id: 'd', root: new THREE.Group() });
  return { mesh, lines };
}

const edgesOf = (mesh: THREE.Mesh): THREE.Mesh | null =>
  ((mesh.userData as any).edges as THREE.Mesh | null) ?? null;
const hullOf = (mesh: THREE.Mesh): THREE.Mesh | null =>
  ((mesh.userData as any).edgeHull as THREE.Mesh | null) ?? null;

describe('1. resolveEdgeModes：boolean / 单值 / 数组都归一成四个开关', () => {
  test('关：undefined / false / 空数组', () => {
    expect(resolveEdgeModes(undefined)).toEqual(OFF);
    expect(resolveEdgeModes(false)).toEqual(OFF);
    expect(resolveEdgeModes([])).toEqual(OFF);
  });

  test('旧口径 true 等价于 line，不额外带外扩', () => {
    expect(resolveEdgeModes(true)).toEqual({ enabled: true, line: true, offset: false, hull: false, gpu: false });
    expect(resolveEdgeModes('line')).toEqual({ enabled: true, line: true, offset: false, hull: false, gpu: false });
  });

  test("'offset' 隐含折边线（外推是折边线的修饰，不是替代）", () => {
    expect(resolveEdgeModes('offset')).toEqual({ enabled: true, line: true, offset: true, hull: false, gpu: false });
  });

  test("'hull' 只出外扩轮廓，不建 CPU 折边线", () => {
    expect(resolveEdgeModes('hull')).toEqual({ enabled: true, line: false, offset: false, hull: true, gpu: false });
  });

  test('数组可叠加；顺序无关；重复值无副作用', () => {
    expect(resolveEdgeModes(['line', 'hull'])).toEqual({ enabled: true, line: true, offset: false, hull: true, gpu: false });
    expect(resolveEdgeModes(['hull', 'line', 'hull'])).toEqual({
      enabled: true,
      line: true,
      offset: false,
      hull: true,
      gpu: false,
    });
    expect(resolveEdgeModes(['hull', 'offset'])).toEqual({
      enabled: true,
      line: true,
      offset: true,
      hull: true,
      gpu: false,
    });
  });

  test('运行时混进未知值当关处理（不抛错、不误开）', () => {
    expect(resolveEdgeModes('nope' as any)).toEqual(OFF);
    expect(resolveEdgeModes(['nope' as any])).toEqual(OFF);
  });
});

describe('2. 默认口径不变：不传 edges 时没有任何棱线装饰', () => {
  test('new S3MViewer() 四个开关全关，注册的 mesh 上既无折边线也无外扩壳', () => {
    const v = new S3MViewer();
    expect((v as any)._edgeModes).toEqual(OFF);
    expect(v.style.edges).toBe(false);

    const mesh = registerBox(v);
    expect(edgesOf(mesh)).toBeNull();
    expect(hullOf(mesh)).toBeNull();
  });

  test('edges: true 仍然只建折边线（与改动前逐字一致）', () => {
    const v = new S3MViewer({ style: { edges: true } });
    const mesh = registerBox(v);
    expect(edgesOf(mesh)).toBeTruthy();
    expect(hullOf(mesh)).toBeNull();
  });
});

describe('3. hull：背面外扩轮廓', () => {
  test('edges: "hull" 只挂外扩壳，不建 CPU 折边线', () => {
    const v = new S3MViewer({ style: { edges: 'hull' } });
    const mesh = registerBox(v);

    const hull = hullOf(mesh);
    expect(hull).toBeTruthy();
    expect(edgesOf(mesh)).toBeNull();
    // 壳必须是背面渲染，否则会把建筑本体糊掉
    expect((hull!.material as THREE.Material).side).toBe(THREE.BackSide);
    // 整块几何都要外扩（选中侧是靠 uSelBatch 只扩一栋，全局必须置 whole）
    const u = (hull!.material as any).uniforms;
    expect(u.uSelWhole.value).toBe(1);
    expect(u.uSelBatch.value).toBe(-1);
    // 壳是 mesh 的子节点，才能继承世界变换
    expect(hull!.parent).toBe(mesh);
  });

  test('外扩壳吃 edgeColor / edgeOpacity / edgeHullWidth', () => {
    const v = new S3MViewer({ style: { edges: 'hull', edgeColor: '#112233', edgeOpacity: 0.5, edgeHullWidth: 1.4 } });
    const mesh = registerBox(v);
    const u = (hullOf(mesh)!.material as any).uniforms;

    expect(u.uColor.value.getHexString()).toBe('112233');
    expect(u.uWidth.value).toBeCloseTo(1.4, 5);
    expect(u.uOpacity.value).toBeCloseTo(0.5, 5);

    // 改样式只改 uniform，不重建几何
    const geo = hullOf(mesh)!.geometry;
    v.setStyle({ edgeColor: '#ff0000', edgeHullWidth: 2.2, edgeOpacity: 0.25 });
    expect(u.uColor.value.getHexString()).toBe('ff0000');
    expect(u.uWidth.value).toBeCloseTo(2.2, 5);
    expect(u.uOpacity.value).toBeCloseTo(0.25, 5);
    expect(hullOf(mesh)!.geometry).toBe(geo);
  });

  test('默认 edgeHullWidth 是 0.9（与选中侧 outlineWidth 同一口径）', () => {
    const v = new S3MViewer({ style: { edges: 'hull' } });
    const mesh = registerBox(v);
    expect((hullOf(mesh)!.material as any).uniforms.uWidth.value).toBeCloseTo(0.9, 5);
  });
});

describe('4. offset：折边线沿边法线外推', () => {
  test('棱线几何带单位边法线（每段 4 个顶点同一法线）', () => {
    const v = new S3MViewer({ style: { edges: 'offset' } });
    const mesh = registerBox(v);
    const geo = edgesOf(mesh)!.geometry;
    const nrm = geo.getAttribute('aNormal') as THREE.BufferAttribute;

    expect(nrm).toBeTruthy();
    expect(nrm.count).toBe(geo.getAttribute('position').count);
    for (let i = 0; i < nrm.count; i++) {
      const len = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      expect(len).toBeCloseTo(1, 3);
    }
  });

  test('外推距离走 uniform：默认 0.15 米，改样式立即生效且不重建几何', () => {
    const v = new S3MViewer({ style: { edges: 'offset' } });
    const mesh = registerBox(v);
    const u = (v.edgeMaterial as any).uniforms;
    expect(u.uOffset.value).toBeCloseTo(0.15, 5);

    const geo = edgesOf(mesh)!.geometry;
    v.setStyle({ edgeOffset: 0.6 });
    expect(u.uOffset.value).toBeCloseTo(0.6, 5);
    expect(edgesOf(mesh)!.geometry).toBe(geo);
  });

  test('普通折边线（edges: true）不写法线，外推 uniform 保持 0 —— 不能平白多推', () => {
    const v = new S3MViewer({ style: { edges: true } });
    const mesh = registerBox(v);
    expect((v.edgeMaterial as any).uniforms.uOffset.value).toBe(0);

    const nrm = edgesOf(mesh)!.geometry.getAttribute('aNormal') as THREE.BufferAttribute;
    for (let i = 0; i < nrm.count; i++) {
      expect(nrm.getX(i)).toBe(0);
      expect(nrm.getY(i)).toBe(0);
      expect(nrm.getZ(i)).toBe(0);
    }
  });

  test('buildFeatureEdgeSegments 能吐出边法线：长度与线段数对得上', () => {
    const geo = new THREE.BoxGeometry(2, 2, 2);
    const normals: number[] = [];
    const segs = buildFeatureEdgeSegments(geo, null, 55, normals);
    expect(segs).toBeTruthy();
    expect(normals.length).toBe((segs!.length / 6) * 6);
    for (let i = 0; i < normals.length; i += 3) {
      expect(Math.hypot(normals[i], normals[i + 1], normals[i + 2])).toBeCloseTo(1, 3);
    }
  });
});

describe('5. forceCpuEdges：忽略数据自带棱线包', () => {
  test('默认保留 native 棱线，不额外建 CPU 折边线', () => {
    const v = new S3MViewer({ style: { edges: true } });
    const { mesh, lines } = registerNativeTile(v);
    expect(lines.visible).toBe(true);
    expect(edgesOf(mesh)).toBeNull();
  });

  test('forceCpuEdges 时 native 隐藏，改由 CPU 现算（这样 edgeWidth 才有效）', () => {
    const v = new S3MViewer({ style: { edges: true, forceCpuEdges: true } });
    const { mesh, lines } = registerNativeTile(v);
    expect(lines.visible).toBe(false);
    expect(edgesOf(mesh)).toBeTruthy();
  });

  test('forceCpuEdges 下 setEdges 也不能把 native 棱线放出来', () => {
    const v = new S3MViewer({ style: { edges: false, forceCpuEdges: true } });
    const { lines } = registerNativeTile(v);
    v.setEdges(true);
    expect(lines.visible).toBe(false);
  });

  test('运行中打开 forceCpuEdges 会重建：native 收起、CPU 棱线长出来', () => {
    const v = new S3MViewer({ style: { edges: true } });
    const { mesh, lines } = registerNativeTile(v);
    expect(edgesOf(mesh)).toBeNull();

    v.setStyle({ forceCpuEdges: true });
    expect(lines.visible).toBe(false);
    expect(edgesOf(mesh)).toBeTruthy();
  });
});

describe('6. 换画法必须拆旧装饰再重建', () => {
  test('line → hull：折边线拆掉，只留外扩壳', () => {
    const v = new S3MViewer({ style: { edges: true } });
    const mesh = registerBox(v);
    expect(edgesOf(mesh)).toBeTruthy();

    v.setEdges('hull');
    expect(edgesOf(mesh)).toBeNull();
    expect(hullOf(mesh)).toBeTruthy();
  });

  test('hull → line：外扩壳拆掉，折边线回来', () => {
    const v = new S3MViewer({ style: { edges: 'hull' } });
    const mesh = registerBox(v);
    expect(hullOf(mesh)).toBeTruthy();

    v.setEdges(true);
    expect(hullOf(mesh)).toBeNull();
    expect(edgesOf(mesh)).toBeTruthy();
  });

  test('重复设置同一画法不重建几何（滑块逐帧调样式不能反复建线）', () => {
    const v = new S3MViewer({ style: { edges: true } });
    const mesh = registerBox(v);
    const geo = edgesOf(mesh)!.geometry;

    v.setEdges(true);
    v.setEdges('line');
    expect(edgesOf(mesh)!.geometry).toBe(geo);
  });

  test('关掉棱线要把两种装饰都清干净', () => {
    const v = new S3MViewer({ style: { edges: ['line', 'hull'] } });
    const mesh = registerBox(v);
    expect(edgesOf(mesh)).toBeTruthy();
    expect(hullOf(mesh)).toBeTruthy();

    v.setEdges(false);
    expect(edgesOf(mesh)).toBeNull();
    expect(hullOf(mesh)).toBeNull();
    expect(mesh.children.length).toBe(0);
  });
});

describe("7. gpu：深度+法线后处理（零几何、零 CPU 成本）", () => {
  test("resolveEdgeModes('gpu')：只开 gpu，不建折边线也不建外扩壳", () => {
    expect(resolveEdgeModes('gpu')).toEqual({ enabled: true, line: false, offset: false, hull: false, gpu: true });
  });

  test("edges:'gpu' 不产生任何装饰几何（描边完全在后处理里做）", () => {
    const v = new S3MViewer({ style: { edges: 'gpu' } });
    const mesh = registerBox(v);
    expect(edgesOf(mesh)).toBeNull();
    expect(hullOf(mesh)).toBeNull();
    expect((v as any)._edgeModes.gpu).toBe(true);
  });

  test('默认不开 gpu', () => {
    const v = new S3MViewer();
    expect((v as any)._edgeModes.gpu).toBe(false);
  });

  test('gpu 模式下数据自带棱线包必须收起，否则和后处理描边叠成双线', () => {
    const v = new S3MViewer({ style: { edges: 'gpu' } });
    const { lines } = registerNativeTile(v);
    expect(lines.visible).toBe(false);
  });

  test('gpu 与折边线可叠加（数组），互不干扰', () => {
    const v = new S3MViewer({ style: { edges: ['gpu', 'line'] } });
    const mesh = registerBox(v);
    expect(edgesOf(mesh)).toBeTruthy();
    expect((v as any)._edgeModes.gpu).toBe(true);
  });

  test('关掉 gpu 会把后处理资源还回去（整屏 RT 不白占显存）', () => {
    const v = new S3MViewer({ style: { edges: 'gpu' } });
    let disposed = 0;
    (v as any)._gpuEdge = { dispose: () => disposed++, supported: () => true };

    v.setEdges(false);
    expect(disposed).toBe(1);
    expect((v as any)._gpuEdge).toBeNull();
  });

  test('WebGL1 上不支持：supported() 必须返回 false，调用方静默跳过', () => {
    const pass = new GpuEdgePass();
    expect(pass.supported({ capabilities: { isWebGL2: false } } as any)).toBe(false);
    expect(pass.supported({ capabilities: { isWebGL2: true } } as any)).toBe(true);
    pass.dispose();
  });

  test('后处理着色器必须写 gl_FragDepth（否则描边不参与宿主深度测试）', () => {
    const pass = new GpuEdgePass();
    expect(pass.material.fragmentShader.includes('gl_FragDepth')).toBe(true);
    expect(pass.material.fragmentShader.includes('tDepth')).toBe(true);
    expect(pass.material.fragmentShader.includes('tNormal')).toBe(true);
    pass.dispose();
  });
});
