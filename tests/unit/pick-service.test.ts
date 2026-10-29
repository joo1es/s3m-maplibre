import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import { PickService, type PickHost } from '../../packages/s3m-three/src/render/viewer/PickService.js';

function createMockHost(overrides: Partial<PickHost> = {}): PickHost {
  return {
    picker: null,
    camera: null,
    scene: null,
    canvas: null,
    style: { floorHeight: 3.2 },
    sceneAnchor: null,
    datasets: new Map(),
    featureStyleManager: {} as any,
    smidMeshes: new Map(),
    lngLatFromWorld: (x, y) => [x, y],
    gpuPathPoseAt: () => null,
    isFeatureHidden: () => false,
    ...overrides,
  };
}

describe('PickService', () => {
  describe('allocPickId / releasePickId', () => {
    it('按序号连续分配并在 release 后优先 LIFO 复用', () => {
      const service = new PickService(createMockHost());

      const id0 = service.allocPickId();
      const id1 = service.allocPickId();
      const id2 = service.allocPickId();
      expect(id0).toBe(0);
      expect(id1).toBe(1);
      expect(id2).toBe(2);

      service.releasePickId(id1);
      service.releasePickId(id0);

      // 后放回的 id0 先出
      expect(service.allocPickId()).toBe(id0);
      expect(service.allocPickId()).toBe(id1);
      // 复用完之后继续自增
      expect(service.allocPickId()).toBe(3);
    });

    it('超界时扫描空缺槽位，全部用尽时报错', () => {
      const service = new PickService(createMockHost());
      // 模拟序号已触顶
      (service as any)._pickSeq = 65535;

      // 槽位 0 未在 pickables 登记 -> 可以被回收扫描利用
      const freeId = service.allocPickId();
      expect(freeId).toBe(0);

      // 模拟所有槽位都登记在 pickables 中
      for (let i = 0; i <= 65534; i++) {
        service.pickables.set(i, { mesh: {} as THREE.Mesh, datasetId: 'd', batchId: 0 });
      }
      expect(() => service.allocPickId()).toThrow('可拾取网格超过 65535 个');
    });

    it('clear 重置所有 ID 池与 pickables', () => {
      const service = new PickService(createMockHost());
      service.allocPickId();
      service.allocPickId();
      service.releasePickId(0);
      service.pickables.set(1, { mesh: {} as THREE.Mesh, datasetId: 'd', batchId: 0 });

      service.clear();
      expect(service.pickables.size).toBe(0);
      expect(service.allocPickId()).toBe(0);
    });

    it('meshes 返回所有已注册网格列表', () => {
      const service = new PickService(createMockHost());
      const m1 = new THREE.Mesh();
      const m2 = new THREE.Mesh();
      service.pickables.set(0, { mesh: m1, datasetId: 'd1', batchId: 0 });
      service.pickables.set(1, { mesh: m2, datasetId: 'd2', batchId: 1 });

      const list = service.meshes();
      expect(list.length).toBe(2);
      expect(list).toContain(m1);
      expect(list).toContain(m2);
    });
  });

  describe('getRayAt', () => {
    it('缺少 camera 或 canvas 时返回 null', () => {
      const service = new PickService(createMockHost());
      expect(service.getRayAt(100, 100)).toBeNull();

      const camera = new THREE.PerspectiveCamera();
      const sCameraOnly = new PickService(createMockHost({ camera }));
      expect(sCameraOnly.getRayAt(100, 100)).toBeNull();
    });

    it('canvas 宽高为 0 时返回 null', () => {
      const camera = new THREE.PerspectiveCamera();
      const canvas = { clientWidth: 0, clientHeight: 0, width: 0, height: 0 } as HTMLCanvasElement;
      const service = new PickService(createMockHost({ camera, canvas }));
      expect(service.getRayAt(100, 100)).toBeNull();
    });

    it('根据屏幕像素计算出射线', () => {
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      camera.position.set(0, 0, 10);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      const canvas = { clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement;
      const service = new PickService(createMockHost({ camera, canvas }));

      // 屏幕中心 (400, 300) 对应 NDC (0, 0)，射线方向应朝 -Z
      const ray = service.getRayAt(400, 300);
      expect(ray).not.toBeNull();
      expect(Math.abs(ray!.direction.x)).toBeLessThan(1e-5);
      expect(Math.abs(ray!.direction.y)).toBeLessThan(1e-5);
      expect(ray!.direction.z).toBeCloseTo(-1, 4);
    });
  });

  describe('intersectMeshAtRay', () => {
    it('普通 mesh 射线命中与未命中', () => {
      const service = new PickService(createMockHost());
      const geom = new THREE.PlaneGeometry(10, 10);
      const mesh = new THREE.Mesh(geom);
      mesh.updateMatrixWorld();

      // 朝向平面的射线：从 (0, 0, 5) 射向 (0, 0, -1)
      const hitRay = new THREE.Ray(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
      const hit = service.intersectMeshAtRay(mesh, hitRay);
      expect(hit).not.toBeNull();
      expect(hit!.x).toBeCloseTo(0);
      expect(hit!.y).toBeCloseTo(0);
      expect(hit!.z).toBeCloseTo(0);

      // 偏移偏离平面的射线
      const missRay = new THREE.Ray(new THREE.Vector3(100, 100, 5), new THREE.Vector3(0, 0, -1));
      expect(service.intersectMeshAtRay(mesh, missRay)).toBeNull();
    });

    it('指定 instanceIndex 时只返回匹配该实例的结果', () => {
      const service = new PickService(createMockHost());
      const geom = new THREE.BoxGeometry(2, 2, 2);
      const im = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial(), 2);

      // instance 0 放在 (0, 0, 0)
      const m0 = new THREE.Matrix4().makeTranslation(0, 0, 0);
      im.setMatrixAt(0, m0);
      // instance 1 放在 (10, 0, 0)
      const m1 = new THREE.Matrix4().makeTranslation(10, 0, 0);
      im.setMatrixAt(1, m1);
      im.instanceMatrix.needsUpdate = true;
      im.updateMatrixWorld();

      const rayTo0 = new THREE.Ray(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));

      // 查询 instance 0 -> 匹配成功，返回 (0, 0, 1)（盒子的顶面 z=1）
      const hit0 = service.intersectMeshAtRay(im, rayTo0, 0);
      expect(hit0).not.toBeNull();
      expect(hit0!.x).toBeCloseTo(0);
      expect(hit0!.y).toBeCloseTo(0);
      expect(hit0!.z).toBeCloseTo(1);

      // 查询未匹配的 instanceId 时退回最近的 hit[0].point 兜底
      const hit1 = service.intersectMeshAtRay(im, rayTo0, 99);
      expect(hit1).not.toBeNull();
      expect(hit1!.x).toBeCloseTo(0);
    });
  });
});
