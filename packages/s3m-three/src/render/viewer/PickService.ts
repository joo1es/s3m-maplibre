/**
 * 拾取：屏幕坐标 → 射线 → 命中单体 / 位置 / 包围盒。
 *
 * 从 `S3MViewer` 整体搬出来的第二大块。它持有**拾取表**（`pickables`）与
 * 2 字节 pickId 池 —— 这两样本来就是一件事：瓦片注册时分配 id 并登记，
 * 淘汰时回收，拾取时按 id 反查。
 *
 * ## pickId 为什么要回收
 *
 * 拾取结果编码在 RG 两个通道里，只有 65535 个槽。倾斜摄影一块瓦片可能几十个网格，
 * 一个数据集上千块瓦片就是几万个 —— 不回收的话瓦片进出几轮就溢出了。
 *
 * ## 泼溅是独立分支
 *
 * 泼溅既没有 `instanceMatrix`，也没有 `geoRef.pickInfo` 里的单体表。走通用路径会在
 * `_instanceFeature()` 拿到 null 直接返回 —— 表现是「点得中但拿不到结果」。
 */
import * as THREE from 'three';
import type { FeatureStyleManager } from '../FeatureStyleManager.js';
import type { Picker } from '../Picker.js';
import {
  buildAttributes,
  buildInstanceLookup,
  measureSegments,
  pickEntryId,
  resolveFeature,
} from '../../core/FeatureInfo.js';
import type { InstanceFeature } from '../../core/FeatureInfo.js';
import { resolveRotationMatrix } from '../FeatureStyleManager.js';
import { splatCenterBounds } from '../SplatMaterial.js';
import type { GeoPackageEntry, SegmentBox } from '../../core/types.js';
import type { PickResult, PickableRef } from '../S3MViewer.js';

interface MeshUserData {
  pickId?: number;
  datasetId?: string;
  skeletonName?: string;
  isGaussianSplat?: boolean;
  geoRef?: GeoPackageEntry;
  [key: string]: unknown;
}

/** 拾取 ID 只有 2 个字节（RG 两个通道），65534 是安全上限 */
const MAX_PICK_ID = 65534;

export interface PickHost {
  readonly picker: Picker | null;
  readonly camera: THREE.Camera | null;
  readonly scene: THREE.Scene | null;
  readonly canvas: HTMLCanvasElement | null;
  readonly style: { floorHeight: number };
  readonly sceneAnchor: { x: number; y: number; z: number; meterInMercator: number; altitude?: number } | null;
  readonly datasets: Map<string, { name: string }>;
  readonly featureStyleManager: FeatureStyleManager;
  readonly smidMeshes: Map<number, Set<THREE.Mesh>>;
  lngLatFromWorld(x: number, y: number): [number, number];
  gpuPathPoseAt(smid: number): { pos: [number, number, number]; yaw: number } | null;
  isFeatureHidden(smid: number | null, batchId: number): boolean;
}

export class PickService {
  /** 拾取表：pickId → 网格 */
  readonly pickables = new Map<number, PickableRef>();
  private _pickSeq = 0;
  private readonly _freePickIds: number[] = [];

  constructor(private readonly host: PickHost) {}

  /** 分配一个 pickId（优先复用回收的） */
  allocPickId(): number {
    const reused = this._freePickIds.pop();
    if (reused !== undefined) return reused;
    if (this._pickSeq > MAX_PICK_ID) {
      for (let id = 0; id <= MAX_PICK_ID; id++) if (!this.pickables.has(id)) return id;
      throw new Error(`[s3m] 可拾取网格超过 ${MAX_PICK_ID + 1} 个，2 字节 ID 编码不够用`);
    }
    return this._pickSeq++;
  }

  releasePickId(id: number): void {
    this._freePickIds.push(id);
  }

  /** 全部网格（拾取表的另一种视角，供样式 / 统计遍历） */
  meshes(): THREE.Mesh[] {
    const list: THREE.Mesh[] = [];
    for (const p of this.pickables.values()) list.push(p.mesh);
    return list;
  }

  clear(): void {
    this.pickables.clear();
    this._freePickIds.length = 0;
    this._pickSeq = 0;
  }

  /** 获取指定屏幕像素对应的场景射线（用于高精度求交与穿透拾取） */
  getRayAt(x: number, y: number): THREE.Ray | null {
    if (!this.host.camera || !this.host.canvas) return null;
    const canvas = this.host.canvas;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (!w || !h) return null;

    const ndcX = (x / w) * 2 - 1;
    const ndcY = -(y / h) * 2 + 1;

    const near = new THREE.Vector3(ndcX, ndcY, -1).unproject(this.host.camera);
    const far = new THREE.Vector3(ndcX, ndcY, 1).unproject(this.host.camera);
    const dir = far.clone().sub(near).normalize();
    return new THREE.Ray(near, dir);
  }

  intersectMeshAtRay(mesh: THREE.Mesh, ray: THREE.Ray, instanceIndex?: number): THREE.Vector3 | null {
    const raycaster = new THREE.Raycaster();
    raycaster.ray.copy(ray);
    const hits = raycaster.intersectObject(mesh, false);
    if (!hits.length) return null;
    if (instanceIndex != null) {
      const match = hits.find((h) => h.instanceId === instanceIndex);
      return match ? match.point : hits[0].point;
    }
    return hits[0].point;
  }

  buildPickResult(
    hit: { objectId: number; batchId: number; instanceIndex?: number },
    ref: PickableRef,
    exactPoint?: THREE.Vector3,
    ray?: THREE.Ray
  ): PickResult | null {
    const ud = ref.mesh.userData as MeshUserData;
    // 泼溅走独立分支：它既没有 instanceMatrix，也没有 geoRef.pickInfo 里的单体表，
    // 走下面那段会在 `_instanceFeature()` 拿到 null 直接返回 —— 表现是「点得中但拿不到结果」。
    if (ud.isGaussianSplat) return this.buildSplatPickResult(hit, ref, exactPoint, ray);
    let smid: number | null = null;
    let batchId = hit.batchId;
    let instanceIndex = hit.instanceIndex;
    let geoRef = ud.geoRef;
    let segments: Array<{ vertexOffset: number; vertexCount: number }> = [];

    if (instanceIndex != null) {
      const feature = this.instanceFeature(ref.mesh, geoRef, instanceIndex);
      if (!feature) return null;
      smid = feature.smid;
      batchId = feature.batchId;
    } else {
      geoRef = (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(hit.batchId) ?? ud.geoRef;
      const resolved = resolveFeature(geoRef, hit.batchId);
      smid = resolved.smid;
      segments = resolved.segments;
    }

    if (this.host.isFeatureHidden(smid, batchId)) return null;

    let box: SegmentBox | null = null;
    let totalTriangles = 0;

    if (instanceIndex != null) {
      box = this.instanceBox(ref.mesh, instanceIndex);
      totalTriangles = ref.mesh.geometry.index ? Math.round(ref.mesh.geometry.index.count / 3) : 0;
    } else if (smid != null && this.host.smidMeshes.has(smid)) {
      const meshes = this.host.smidMeshes.get(smid)!;
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      let count = 0;
      for (const m of meshes) {
        const mUd = m.userData as MeshUserData;
        const mPick = mUd.geoRef?.pickInfo;
        const entry = (mPick as Record<string | number, unknown> | undefined)?.[smid] ??
          (mPick as Record<string | number, unknown> | undefined)?.[String(smid)];
        const bId = entry ? pickEntryId(entry as any) : -1;
        const mSegs = (entry as any)?.segments ?? (bId >= 0 ? resolveFeature(mUd.geoRef, bId).segments : []);
        const mBox = measureSegments(m.geometry, mSegs);
        if (mBox) {
          if (mBox.minX < minX) minX = mBox.minX;
          if (mBox.minY < minY) minY = mBox.minY;
          if (mBox.minZ < minZ) minZ = mBox.minZ;
          if (mBox.maxX > maxX) maxX = mBox.maxX;
          if (mBox.maxY > maxY) maxY = mBox.maxY;
          if (mBox.maxZ > maxZ) maxZ = mBox.maxZ;
          count += mBox.count;
          totalTriangles += mBox.triangles;
        }
      }
      if (count > 0) {
        box = { minX, minY, minZ, maxX, maxY, maxZ, count, triangles: totalTriangles };
      }
    }

    if (!box) {
      box = measureSegments(ref.mesh.geometry, segments);
      if (!box && ref.mesh.geometry) {
        if (!ref.mesh.geometry.boundingBox) ref.mesh.geometry.computeBoundingBox();
        const bb = ref.mesh.geometry.boundingBox;
        if (bb) {
          box = {
            minX: bb.min.x,
            maxX: bb.max.x,
            minY: bb.min.y,
            maxY: bb.max.y,
            minZ: bb.min.z,
            maxZ: bb.max.z,
            count: 0,
            triangles: 0,
          };
        }
      }
    }
    const geometry = ref.mesh.geometry;
    const triangles = totalTriangles > 0 ? totalTriangles : (geometry.index ? Math.round(geometry.index.count / 3) : 0);
    const attributes = buildAttributes({ smid, box, triangles, floorHeight: this.host.style.floorHeight });

    let centerLngLat: [number, number] | null = null;
    if (box && this.host.sceneAnchor) {
      const v = new THREE.Vector3((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2);
      v.applyMatrix4(ref.mesh.matrixWorld);
      const s = this.host.sceneAnchor.meterInMercator;
      centerLngLat = this.host.lngLatFromWorld(v.x * s + this.host.sceneAnchor.x, -v.y * s + this.host.sceneAnchor.y);
    }

    // 精确命中点求交计算
    let hitPoint: THREE.Vector3 | null = exactPoint ?? null;
    if (!hitPoint && ray) {
      hitPoint = this.intersectMeshAtRay(ref.mesh, ray, instanceIndex);
    }

    let point: [number, number, number] | null = null;
    let lngLat: [number, number] | null = null;
    let altitude: number | null = null;

    if (hitPoint && this.host.sceneAnchor) {
      const off = smid != null ? this.host.featureStyleManager.getFeatureEffectiveOffset(smid) : {};
      const trans = off.translation;
      const elev = off.elevation;
      const finalPos = hitPoint.clone();

      if (off.rotation) {
        const rotMat = resolveRotationMatrix(off.rotation);
        if (rotMat) {
          const m3 = new THREE.Matrix3().set(
            rotMat[0], rotMat[1], rotMat[2],
            rotMat[3], rotMat[4], rotMat[5],
            rotMat[6], rotMat[7], rotMat[8]
          );
          const piv = off.pivot ? new THREE.Vector3(off.pivot[0], off.pivot[1], off.pivot[2]) : new THREE.Vector3(0, 0, 0);
          finalPos.sub(piv).applyMatrix3(m3).add(piv);
        }
      }

      if (trans) finalPos.add(new THREE.Vector3(trans[0], trans[1], trans[2]));
      else if (elev) finalPos.z += elev;

      point = [finalPos.x, finalPos.y, finalPos.z];
      const s = this.host.sceneAnchor.meterInMercator;
      lngLat = this.host.lngLatFromWorld(finalPos.x * s + this.host.sceneAnchor.x, -finalPos.y * s + this.host.sceneAnchor.y);
      altitude = finalPos.z + (this.host.sceneAnchor.altitude ?? 0);
    } else if (centerLngLat && box && this.host.sceneAnchor) {
      lngLat = centerLngLat;
      altitude = (box.minZ + box.maxZ) / 2 + (this.host.sceneAnchor.altitude ?? 0);
    }

    return {
      datasetId: ref.datasetId,
      datasetName: this.host.datasets.get(ref.datasetId)?.name ?? ref.datasetId,
      objectId: hit.objectId,
      batchId,
      instanceIndex,
      skeletonName: ref.skeletonName,
      centerLngLat,
      point,
      lngLat,
      altitude,
      ...attributes,
      mesh: ref.mesh,
    };
  }

  /**
   * 泼溅的拾取结果。
   *
   * 整块泼溅瓦片当一个单体（没有单体级 smid 可报），命中点由 `splatRaycast` 给出 ——
   * 它按每个高斯的 3σ 球求交，比拾取那一趟为了命中率摊开的 4px 方块准得多。
   * 包围盒必须由 `iCenter` 算：geometry 的 position 只是 [-1,1]² 的四边形角点。
   */
  buildSplatPickResult(
    hit: { objectId: number; batchId: number; instanceIndex?: number },
    ref: PickableRef,
    exactPoint?: THREE.Vector3,
    ray?: THREE.Ray
  ): PickResult | null {
    const anchor = this.host.sceneAnchor;
    if (!anchor) return null;
    const mesh = ref.mesh;

    let hitPoint = exactPoint ?? null;
    if (!hitPoint && ray) hitPoint = this.intersectMeshAtRay(mesh, ray);

    const local = splatCenterBounds(mesh.geometry);
    const box: SegmentBox | null = local
      ? {
          minX: local.minX,
          minY: local.minY,
          minZ: local.minZ,
          maxX: local.maxX,
          maxY: local.maxY,
          maxZ: local.maxZ,
          count: local.count,
          triangles: 0,
        }
      : null;

    const attributes = buildAttributes({
      smid: null,
      box,
      triangles: 0,
      floorHeight: this.host.style.floorHeight,
    });

    const s = anchor.meterInMercator;
    let point: [number, number, number] | null = null;
    let lngLat: [number, number] | null = null;
    let altitude: number | null = null;
    let centerLngLat: [number, number] | null = null;

    if (hitPoint) {
      point = [hitPoint.x, hitPoint.y, hitPoint.z];
      lngLat = this.host.lngLatFromWorld(hitPoint.x * s + anchor.x, -hitPoint.y * s + anchor.y);
      altitude = hitPoint.z + (anchor.altitude ?? 0);
      // 泼溅命中的就是一个高斯，没有「单体中心」可言，用命中点当中心
      centerLngLat = lngLat;
    } else if (box) {
      const v = new THREE.Vector3(
        (box.minX + box.maxX) / 2,
        (box.minY + box.maxY) / 2,
        (box.minZ + box.maxZ) / 2
      ).applyMatrix4(mesh.matrixWorld);
      centerLngLat = this.host.lngLatFromWorld(v.x * s + anchor.x, -v.y * s + anchor.y);
      altitude = v.z + (anchor.altitude ?? 0);
    }

    return {
      datasetId: ref.datasetId,
      datasetName: this.host.datasets.get(ref.datasetId)?.name ?? ref.datasetId,
      objectId: hit.objectId,
      batchId: -1,
      instanceIndex: undefined,
      skeletonName: ref.skeletonName,
      centerLngLat,
      point,
      lngLat,
      altitude,
      ...attributes,
      mesh,
    };
  }

  /** 按 canvas 左上角的 CSS 像素坐标拾取。 */
  pick(x: number, y: number): PickResult | null {
    if (!this.host.picker || !this.host.scene || !this.host.camera || !this.host.sceneAnchor) return null;
    const hit = this.host.picker.pick(this.host.scene, this.host.camera, x, y);
    if (!hit) return null;

    const ref = this.pickables.get(hit.objectId);
    if (!ref) return null;

    const ray = this.getRayAt(x, y);
    return this.buildPickResult(hit, ref, undefined, ray ?? undefined);
  }

  /**
   * 拾取指定屏幕像素对应的世界坐标与场景位置。
   * 优先与命中的建筑网格精确求交；未命中建筑时若视线与地表相交则返回地面交点。
   */
  pickPosition(x: number, y: number): { lngLat: [number, number]; altitude: number; point: [number, number, number] } | null {
    if (!this.host.camera || !this.host.sceneAnchor) return null;

    const hit = this.pick(x, y);
    if (hit?.point && hit?.lngLat && hit.altitude != null) {
      return {
        lngLat: hit.lngLat,
        altitude: hit.altitude,
        point: hit.point,
      };
    }

    const ray = this.getRayAt(x, y);
    if (!ray) return null;

    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const target = new THREE.Vector3();
    const intersect = ray.intersectPlane(groundPlane, target);
    if (intersect) {
      const s = this.host.sceneAnchor.meterInMercator;
      const lngLat = this.host.lngLatFromWorld(intersect.x * s + this.host.sceneAnchor.x, -intersect.y * s + this.host.sceneAnchor.y);
      const altitude = intersect.z + (this.host.sceneAnchor.altitude ?? 0);
      return {
        lngLat,
        altitude,
        point: [intersect.x, intersect.y, intersect.z],
      };
    }
    return null;
  }

  /**
   * 沿给定射线求**最近**交点距离（通视分析用）。
   *
   * 与 `pick` 不同：不走 GPU、不认批次，只回答「这条线上最先撞到什么」，
   * 所以一次查询的代价是 O(已加载三角面)，几十万面的场景在几十毫秒量级，
   * 适合点击式查询；要逐帧连续更新得换深度图方案（见 `docs/API.md`）。
   *
   * @param origin 起点（场景 ENU 米）
   * @param dir 单位方向
   * @param maxDistance 只关心这个距离内的交点
   */
  raycastDistance(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
    maxDistance: number
  ): { distance: number; point: [number, number, number] } | null {
    if (!this.host.scene) return null;
    const meshes = [...this.pickables.values()]
      .map((p) => p.mesh)
      .filter((m) => {
        // 被隐藏的单体所在网格、以及整层隐藏的都要排除，否则会「撞到看不见的墙」
        let curr: THREE.Object3D | null = m;
        while (curr) {
          if (!curr.visible) return false;
          curr = curr.parent;
        }
        return true;
      });
    if (!meshes.length) return null;

    const raycaster = new THREE.Raycaster();
    raycaster.set(
      new THREE.Vector3(origin[0], origin[1], origin[2]),
      new THREE.Vector3(dir[0], dir[1], dir[2]).normalize()
    );
    raycaster.near = 0;
    raycaster.far = maxDistance;

    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      distance: h.distance,
      point: [h.point.x, h.point.y, h.point.z],
    };
  }

  /**
   * 沿视线方向穿透拾取多个单体，按由近至远排序返回。
   */
  drillPick(x: number, y: number, limit = 10): PickResult[] {
    if (!this.host.sceneAnchor || !this.host.camera) return [];
    const ray = this.getRayAt(x, y);
    if (!ray) return [];

    const raycaster = new THREE.Raycaster();
    raycaster.ray.copy(ray);

    const meshes = [...this.pickables.values()]
      .map((p) => p.mesh)
      .filter((m) => {
        let curr: THREE.Object3D | null = m;
        while (curr) {
          if (!curr.visible) return false;
          curr = curr.parent;
        }
        return true;
      });
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return [];

    const results: PickResult[] = [];
    const seenSmids = new Set<number>();
    const seenBatches = new Set<string>();

    for (const hit of hits) {
      if (results.length >= limit) break;
      const mesh = hit.object as THREE.Mesh;
      const ud = mesh.userData as MeshUserData & { pickId?: number };
      if (ud.pickId == null) continue;
      const ref = this.pickables.get(ud.pickId);
      if (!ref) continue;

      let smid: number | null = null;
      let batchId = -1;
      let instanceIndex = hit.instanceId;

      if (instanceIndex != null) {
        const feature = this.instanceFeature(mesh, ud.geoRef, instanceIndex);
        if (!feature) continue;
        smid = feature.smid;
        batchId = feature.batchId;
      } else if (hit.faceIndex != null) {
        const batchAttr = mesh.geometry.attributes.aBatchId;
        if (batchAttr) {
          const idx = mesh.geometry.index ? mesh.geometry.index.getX(hit.faceIndex * 3) : hit.faceIndex * 3;
          batchId = Math.round(batchAttr.getX(idx));
          const geoRef = (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(batchId) ?? ud.geoRef;
          const resolved = resolveFeature(geoRef, batchId);
          smid = resolved.smid;
        }
      }

      if (smid != null) {
        if (seenSmids.has(smid)) continue;
        seenSmids.add(smid);
      } else {
        const key = `${ud.pickId}:${batchId}:${instanceIndex ?? -1}`;
        if (seenBatches.has(key)) continue;
        seenBatches.add(key);
      }

      if (this.host.isFeatureHidden(smid, batchId)) continue;

      const pickHit = {
        objectId: ud.pickId,
        batchId,
        instanceIndex,
      };
      const res = this.buildPickResult(pickHit, ref, hit.point);
      if (res) results.push(res);
    }

    return results;
  }

  /**
   * 获取指定 SMID 单体的经纬度包围盒 [[minLng, minLat], [maxLng, maxLat]]。
   * 若模型尚未加载到场景中或无此单体则返回 null。
   */
  getFeatureBounds(smid: number): [[number, number], [number, number]] | null {
    if (!this.host.sceneAnchor) return null;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let found = false;

    for (const ref of this.pickables.values()) {
      const mesh = ref.mesh;
      const ud = mesh.userData as MeshUserData;
      const geoRef = ud.geoRef;
      const pickInfo = geoRef?.pickInfo;
      if (!pickInfo) continue;

      let box: SegmentBox | null = null;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        let lookup = ud.instanceLookup as Map<number, InstanceFeature> | undefined;
        if (!lookup) {
          lookup = buildInstanceLookup(pickInfo);
          ud.instanceLookup = lookup;
        }
        for (const [instIdx, feat] of lookup) {
          if (feat.smid === smid) {
            box = this.instanceBox(mesh, instIdx);
            break;
          }
        }
      } else {
        const infoMap = pickInfo as Record<string | number, unknown>;
        const entry = infoMap[smid] ?? infoMap[String(smid)];
        if (entry) {
          const bId = pickEntryId(entry);
          const resolved = resolveFeature(geoRef, bId);
          box = measureSegments(mesh.geometry, resolved.segments);
          if (!box && mesh.geometry) {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            const bb = mesh.geometry.boundingBox;
            if (bb) {
              box = {
                minX: bb.min.x,
                maxX: bb.max.x,
                minY: bb.min.y,
                maxY: bb.max.y,
                minZ: bb.min.z,
                maxZ: bb.max.z,
                count: 0,
                triangles: 0,
              };
            }
          }
        }
      }

      if (box) {
        found = true;
        const corners = [
          new THREE.Vector3(box.minX, box.minY, box.minZ),
          new THREE.Vector3(box.maxX, box.minY, box.minZ),
          new THREE.Vector3(box.minX, box.maxY, box.minZ),
          new THREE.Vector3(box.maxX, box.maxY, box.minZ),
          new THREE.Vector3(box.minX, box.minY, box.maxZ),
          new THREE.Vector3(box.maxX, box.minY, box.maxZ),
          new THREE.Vector3(box.minX, box.maxY, box.maxZ),
          new THREE.Vector3(box.maxX, box.maxY, box.maxZ),
        ];

        const off = smid != null ? this.host.featureStyleManager.getFeatureEffectiveOffset(smid) : {};
        const trans = off.translation;
        const elev = off.elevation;

        const rotMat = off.rotation ? resolveRotationMatrix(off.rotation) : null;
        let rotM3: THREE.Matrix3 | null = null;
        let rotPiv: THREE.Vector3 | null = null;
        if (rotMat) {
          rotM3 = new THREE.Matrix3().set(
            rotMat[0], rotMat[1], rotMat[2],
            rotMat[3], rotMat[4], rotMat[5],
            rotMat[6], rotMat[7], rotMat[8]
          );
          rotPiv = off.pivot ? new THREE.Vector3(off.pivot[0], off.pivot[1], off.pivot[2]) : new THREE.Vector3(0, 0, 0);
        }

        // GPU 路径：位移发生在顶点着色器里，包围盒要按同一套公式在 CPU 复算，
        // 否则「运动中的车」的包围盒会停在路径原点（相机 fitBounds / 属性过滤都会错）。
        const gpuPose = smid != null ? this.host.gpuPathPoseAt(smid) : null;
        let headM3: THREE.Matrix3 | null = null;
        if (gpuPose && gpuPose.yaw !== 0) {
          const c = Math.cos(gpuPose.yaw);
          const s = Math.sin(gpuPose.yaw);
          // 与着色器的 mat3( c, s, 0, -s, c, 0, 0, 0, 1 ) 等价：GLSL 是列优先，
          // three 的 Matrix3.set 是行优先，所以这里写成 (c, -s; s, c) 才是同一个矩阵。
          headM3 = new THREE.Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
        }

        for (const c of corners) {
          if (rotM3 && rotPiv) c.sub(rotPiv).applyMatrix3(rotM3).add(rotPiv);
          if (headM3) {
            const piv = rotPiv ?? new THREE.Vector3(0, 0, 0);
            c.sub(piv).applyMatrix3(headM3).add(piv);
          }
          if (trans) c.add(new THREE.Vector3(trans[0], trans[1], trans[2]));
          else if (elev) c.z += elev;
          if (gpuPose) c.add(new THREE.Vector3(gpuPose.pos[0], gpuPose.pos[1], gpuPose.pos[2]));

          c.applyMatrix4(mesh.matrixWorld);
          const s = this.host.sceneAnchor.meterInMercator;
          const [lng, lat] = this.host.lngLatFromWorld(c.x * s + this.host.sceneAnchor.x, -c.y * s + this.host.sceneAnchor.y);
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }

    if (!found) return null;
    return [
      [minLng, minLat],
      [maxLng, maxLat],
    ];
  }

  /** 实例序号 → 所属单体（按网格缓存反查表，实例多的数据不用每次重建） */
  instanceFeature(
    mesh: THREE.Mesh,
    geoRef: GeoPackageEntry | undefined,
    instanceIndex: number
  ): InstanceFeature | null {
    const ud = mesh.userData as MeshUserData & { instanceLookup?: Map<number, InstanceFeature> };
    if (!ud.instanceLookup) ud.instanceLookup = buildInstanceLookup(geoRef?.pickInfo);
    return ud.instanceLookup.get(instanceIndex) ?? null;
  }

  /** 实例化几何的单体包围盒：base mesh 的包围盒套上该实例的矩阵 */
  instanceBox(mesh: THREE.Mesh, instanceIndex: number): SegmentBox | null {
    const im = mesh as THREE.InstancedMesh;
    if (!im.isInstancedMesh) return null;
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (!bb) return null;
    const m = new THREE.Matrix4();
    im.getMatrixAt(instanceIndex, m);
    const box = bb.clone().applyMatrix4(m);
    return {
      minX: box.min.x,
      minY: box.min.y,
      minZ: box.min.z,
      maxX: box.max.x,
      maxY: box.max.y,
      maxZ: box.max.z,
      count: geometry.getAttribute('position')?.count ?? 0,
      triangles: geometry.index ? Math.round(geometry.index.count / 3) : 0,
    };
  }

  /** 选中/取消选中单体。`silent` 为 true 时不回调 onPick。 */
}
