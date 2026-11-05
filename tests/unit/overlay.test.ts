/**
 * 单元测试：覆盖物底座（render/overlay）
 *
 * 锁定的不变式：
 *   1. 不 add 时底座什么都不做 —— 不进场景、不请求重绘、hasAnimated 为 false；
 *   2. 只有带 `update` 的对象才算动态；静态对象不参与帧循环（否则地图永远不空闲）；
 *   3. 锚点重锚时两种语义各自正确：实例平移补偿后世界位置不变，工厂被重新调用；
 *   4. 生命周期：remove / clear / 重复 remove / 未 mount（scene 为 null）都不崩；
 *   5. 深度策略 `'always'` 真的改了材质的 depthTest，不是只存了个字段。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  OverlayLayer,
  type OverlayAnchorLike,
  type OverlayHost,
} from '../../packages/s3m-three/src/render/overlay/OverlayLayer';

interface FakeHost {
  host: OverlayHost;
  scene: THREE.Scene;
  anchor: OverlayAnchorLike;
  repaints: () => number;
}

/** 米/墨卡托单位比取 1，让 ENU 与世界坐标一一对应，断言好写 */
function makeHost(withScene = true): FakeHost {
  const scene = new THREE.Scene();
  const anchor: OverlayAnchorLike = {
    x: 0,
    y: 0,
    z: 0,
    altitude: 0,
    meterInMercator: 1,
  };
  let repaint = 0;
  const host: OverlayHost = {
    get scene() {
      return withScene ? scene : null;
    },
    getAnchor: () => anchor,
    // 忠实模拟宿主的语义：ENU 相对锚点，且 y 取负（世界墨卡托 y 朝南）
    lngLatToPoint: (p) => [
      (p.lng * 1000 - anchor.x) / (anchor.meterInMercatorEast ?? anchor.meterInMercator),
      -((p.lat * 1000 - anchor.y) / (anchor.meterInMercatorNorth ?? anchor.meterInMercator)),
      (p.altitude ?? 0) - (anchor.altitude ?? 0),
    ],
    requestRepaint: () => {
      repaint++;
    },
  };
  return { host, scene, anchor, repaints: () => repaint };
}

function mesh(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
}

describe('覆盖物底座 / 默认不生效', () => {
  test('不 add 时场景干净、不请求重绘、hasAnimated 为 false', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    expect(f.scene.children).toHaveLength(0);
    expect(layer.hasAnimated).toBe(false);
    layer.tick(16);
    expect(f.repaints()).toBe(0);
  });

  test('add 静态对象只请求一次重绘，之后不再驱动帧循环', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const h = layer.add({ object: mesh(), anchor: [120, 30, 0] });
    expect(f.scene.children).toHaveLength(1);
    expect(h.object.visible).toBe(true);
    expect(layer.hasAnimated).toBe(false);
    // add 自己触发一次，否则新加的东西要等下次相机移动才看得见
    expect(f.repaints()).toBe(1);
    layer.tick(16);
    layer.tick(32);
    expect(f.repaints()).toBe(1);
  });

  test('带 update 的对象把 hasAnimated 打开', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    layer.add({ object: mesh(), anchor: [120, 30, 0], update: () => {} });
    expect(layer.hasAnimated).toBe(true);
  });

  test('remove 掉唯一的动态对象后 hasAnimated 回到 false', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const h = layer.add({ object: mesh(), anchor: [120, 30, 0], update: () => {} });
    h.remove();
    expect(layer.hasAnimated).toBe(false);
  });
});

describe('覆盖物底座 / 摆放', () => {
  test('锚点换算成 ENU 后写进世界位置，offset 叠加在上面', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const obj = mesh();
    layer.add({ object: obj, anchor: [120, 30, 5], offset: [1, 2, 3] });
    const world = obj.getWorldPosition(new THREE.Vector3());
    expect(world.x).toBeCloseTo(120 * 1000 + 1);
    // 纬度方向取负：脚本里 y 朝上，世界墨卡托 y 朝南
    expect(world.y).toBeCloseTo(-30 * 1000 + 2);
    expect(world.z).toBeCloseTo(5 + 3);
    // 使用者自己设在对象上的 position 不被覆盖
    expect(obj.position.toArray()).toEqual([0, 0, 0]);
  });

  test('rotation / scale 生效，单值缩放三轴等比', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const obj = mesh();
    layer.add({ object: obj, anchor: [0, 0], rotation: [0, 0, Math.PI / 2], scale: 2 });
    expect(obj.rotation.z).toBeCloseTo(Math.PI / 2);
    expect(obj.scale.toArray()).toEqual([2, 2, 2]);
  });

  test('anchor 传对象与传数组结果一致', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const a = mesh();
    const b = mesh();
    layer.add({ object: a, anchor: [120, 30, 7] });
    layer.add({ object: b, anchor: { lng: 120, lat: 30, altitude: 7 } });
    expect(a.position.toArray()).toEqual(b.position.toArray());
  });
});

describe('覆盖物底座 / 锚点重锚', () => {
  test('实例模式：锚点平移后按 ENU 差值补偿，经纬度原地不动', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const obj = mesh();
    obj.position.set(10, 20, 0);
    layer.add({ object: obj, anchor: [0, 0, 0], offset: [0, 0, 0] });
    const before = obj.getWorldPosition(new THREE.Vector3());

    f.anchor.x = 100;
    f.anchor.y = 50;
    layer.tick(16);

    // x/z 是「旧减新」，y 因为世界墨卡托 y 朝南而是「新减旧」
    const after = obj.getWorldPosition(new THREE.Vector3());
    expect(after.x).toBeCloseTo(before.x - 100);
    expect(after.y).toBeCloseTo(before.y + 50);
    expect(after.z).toBeCloseTo(before.z);
  });

  test('工厂模式：锚点变化时重建，旧对象走 onRemove', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const enuSeen: number[][] = [];
    const removed: THREE.Object3D[] = [];
    const h = layer.add({
      object: (enu) => {
        enuSeen.push([...enu]);
        return mesh();
      },
      anchor: [0, 0, 0],
      onRemove: (o) => removed.push(o),
    });
    expect(enuSeen).toHaveLength(1);

    f.anchor.x = 200;
    layer.tick(16);

    expect(enuSeen).toHaveLength(2);
    // 锚点 x 从 0 挪到 200，同一条经纬度在新锚点下的 ENU 就是 -200
    expect(enuSeen[1][0]).toBeCloseTo(-200);
    expect(removed).toHaveLength(1);
    expect(h.object).not.toBe(removed[0]);
  });

  test('锚点没变时不做任何重建', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    let built = 0;
    layer.add({ object: () => (built++, mesh()), anchor: [0, 0, 0] });
    layer.tick(16);
    layer.tick(32);
    expect(built).toBe(1);
  });

  test('update 的 anchorMoved 只在重锚那一帧为 true', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const seen: boolean[] = [];
    layer.add({ object: mesh(), anchor: [0, 0, 0], update: (fr) => seen.push(fr.anchorMoved) });
    layer.tick(0);
    f.anchor.x = 10;
    layer.tick(16);
    layer.tick(32);
    expect(seen).toEqual([false, true, false]);
  });

  test('无锚点（数据集未加载）时不崩，也不做补偿', () => {
    const f = makeHost();
    (f.host as { getAnchor: () => OverlayAnchorLike | null }).getAnchor = () => null;
    const layer = new OverlayLayer(f.host);
    const obj = mesh();
    layer.add({ object: obj, anchor: [0, 0, 0] });
    layer.tick(16);
    expect(obj.position.x).toBe(0);
  });
});

describe('覆盖物底座 / 生命周期', () => {
  test('clear 摘掉全部对象并触发 onRemove', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const removed: THREE.Object3D[] = [];
    layer.add({ object: mesh(), anchor: [0, 0, 0], onRemove: (o) => removed.push(o) });
    layer.add({ object: mesh(), anchor: [0, 0, 0], onRemove: (o) => removed.push(o) });
    layer.clear();
    expect(layer.group.children).toHaveLength(0);
    expect(removed).toHaveLength(2);
  });

  test('重复 remove 无副作用，onRemove 只调一次', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    let n = 0;
    const h = layer.add({ object: mesh(), anchor: [0, 0, 0], onRemove: () => n++ });
    h.remove();
    h.remove();
    expect(n).toBe(1);
  });

  test('setVisible 直接改对象可见性', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const h = layer.add({ object: mesh(), anchor: [0, 0, 0], visible: false });
    expect(h.object.visible).toBe(false);
    h.setVisible(true);
    expect(h.object.visible).toBe(true);
  });

  test('scene 为 null（未 mount）时 add 不抛，mount 后补挂', () => {
    let sceneRef: THREE.Scene | null = null;
    const host: OverlayHost = {
      get scene() {
        return sceneRef;
      },
      getAnchor: () => ({ x: 0, y: 0, z: 0, altitude: 0, meterInMercator: 1 }),
      lngLatToPoint: () => [0, 0, 0],
      requestRepaint: () => {},
    };
    const layer = new OverlayLayer(host);
    layer.add({ object: mesh(), anchor: [0, 0, 0] });
    expect(() => layer.tick(16)).not.toThrow();

    sceneRef = new THREE.Scene();
    layer.attachToScene();
    expect(sceneRef.children).toHaveLength(1);
  });
});

describe('覆盖物底座 / 深度策略', () => {
  test("depth: 'always' 真的关掉材质的 depthTest 并抬高 renderOrder", () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const obj = mesh();
    layer.add({ object: obj, anchor: [0, 0, 0], depth: 'always' });
    const mat = (obj as THREE.Mesh).material as THREE.Material;
    expect(mat.depthTest).toBe(false);
    expect(mat.depthWrite).toBe(false);
    expect(obj.renderOrder).toBeGreaterThan(0);
  });

  test("depth 默认 'occluded' 不动材质", () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const obj = mesh();
    layer.add({ object: obj, anchor: [0, 0, 0] });
    const mat = (obj as THREE.Mesh).material as THREE.Material;
    expect(mat.depthTest).toBe(true);
    expect(obj.renderOrder).toBe(0);
  });
});

describe('覆盖物底座 / 帧计时', () => {
  test('t 从第一次 tick 起算，dt 是相邻两帧差值', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const frames: { dt: number; t: number }[] = [];
    layer.add({
      object: mesh(),
      anchor: [0, 0, 0],
      update: (fr) => frames.push({ dt: fr.dt, t: fr.t }),
    });
    layer.tick(1000);
    layer.tick(1016);
    layer.tick(1032);
    expect(frames[0].dt).toBe(0);
    expect(frames[1].dt).toBeCloseTo(0.016);
    expect(frames[2].t).toBeCloseTo(0.032);
  });
});

describe('覆盖物底座 / 手工改动后的重绘请求', () => {
  test('静态覆盖物改完材质不会自动重绘，必须显式 requestRepaint', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const obj = mesh();
    const h = layer.add({ object: obj, anchor: [0, 0, 0] });
    expect(f.repaints()).toBe(1);

    // 这正是「拖滑块没反应」的根因：改材质 / 改缩放都没有任何副作用，
    // 静态对象不进帧循环，地图空闲时不会产生新帧
    const mat = obj.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.5;
    obj.scale.z = 3;
    expect(f.repaints()).toBe(1);

    h.requestRepaint();
    expect(f.repaints()).toBe(2);
  });

  test('remove() 之后 requestRepaint 不再打扰宿主', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const h = layer.add({ object: mesh(), anchor: [0, 0, 0] });
    h.remove();
    const before = f.repaints();
    h.requestRepaint();
    expect(f.repaints()).toBe(before);
  });

  test('requestRepaint 不改动位姿，和 refresh 不是同一件事', () => {
    const f = makeHost();
    const layer = new OverlayLayer(f.host);
    const obj = mesh();
    const h = layer.add({ object: obj, anchor: [120, 30, 5], offset: [1, 2, 3] });
    obj.position.set(9, 9, 9);
    obj.rotation.set(1, 1, 1);
    h.requestRepaint();
    // 使用者自己写进 content 的局部变换必须原样保留
    expect(obj.position.x).toBe(9);
    expect(obj.rotation.x).toBe(1);
  });
});
