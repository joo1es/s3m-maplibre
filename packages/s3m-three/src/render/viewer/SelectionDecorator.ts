/**
 * 选中态：高亮写入、轮廓 / 棱线装饰、跨瓦片重放。
 *
 * 从 `S3MViewer` 搬出来的第三块。它持有 `selection` 与 `selectedMeshes` 两份状态，
 * 其余（uniform、样式、轮廓材质、逐网格棱线材质）都从宿主取。
 *
 * ## 为什么需要「重放」
 *
 * 选中高亮是直接写在各 mesh 材质的 `uSelBatch` / `uSelWhole` 上的，而 LOD 细化、
 * 瓦片重载、淘汰回补都会换掉 mesh —— 不重放的话，用户点中的那栋楼一细化就失去高亮
 * （状态还在 `selection.smid` 里，只是没人往新 mesh 上刷）。
 *
 * ## 没有单体化信息时的退路
 *
 * 倾斜摄影 / 白模整块没有 smid，`uSelBatch` 给 -1 会让「点中了但什么都没亮」。
 * 这时改置 `uSelWhole = 1` 整块高亮，至少让用户看见自己点到了什么。
 */
import * as THREE from 'three';
import type { OutlineMaterial, S3MStyle, StyledMaterial } from '../StyleMaterial.js';
import type { ThickLineMaterial } from '../EdgeLines.js';
import type { FeatureStyleManager } from '../FeatureStyleManager.js';
import type { GeoPackageEntry, StyleUniforms, PickSegment } from '../../core/types.js';
import { pickEntryId, resolveFeature } from '../../core/FeatureInfo.js';
import { buildFeatureEdgeSegments, buildThickLineGeometry } from '../EdgeLines.js';
import type { PickResult } from '../S3MViewer.js';

/** 取网格上的 styled 材质（与 S3MViewer 里那份逐字一致） */
function styledMaterialOf(mesh: THREE.Mesh): StyledMaterial | null {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return (m as StyledMaterial | undefined)?.userData?.isStyled ? (m as StyledMaterial) : null;
}

function clampOpacity(v: number | null | undefined): number {
  const n = v ?? 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function isPointCloud(o: THREE.Object3D): boolean {
  return (o as THREE.Points).isPoints === true;
}

interface MeshUserData {
  datasetId?: string;
  skeletonName?: string;
  geoRef?: GeoPackageEntry;
  [key: string]: unknown;
}

export interface SelectionHost {
  readonly uniforms: StyleUniforms;
  readonly style: S3MStyle;
  readonly outlineMaterial: OutlineMaterial;
  /** 选中棱线的全局材质（外观 uniform 的持有者） */
  readonly selectionEdgeMaterial: ThickLineMaterial;
  /** 单体样式 / 过滤状态（判断被隐藏的单体不该被高亮） */
  readonly featureStyleManager: FeatureStyleManager;
  /** SMID → 包含它的网格 */
  readonly smidMeshes: Map<number, Set<THREE.Mesh>>;
  readonly pointClouds: Set<THREE.Points>;
  applyPointCloudStyle(pc: THREE.Points, selected?: boolean): void;
  onPick(result: PickResult | null): void;
  requestRepaint(): void;
  /** 选中棱线的逐网格材质（由 EdgeDecorator 提供） */
  createSelectionEdgeMaterial(mesh: THREE.Mesh): ThickLineMaterial;
}

export class SelectionDecorator {
  /** 当前选中（null = 没选中） */
  selection: PickResult | null = null;
  /** 被高亮的网格（点云也在这份列表里） */
  selectedMeshes: THREE.Object3D[] = [];

  private _outlineMeshes: THREE.Mesh[] = [];
  private _selectionEdgeMeshes: THREE.Mesh[] = [];

  constructor(private readonly host: SelectionHost) {}

  /** @internal 测试用：选中棱线的网格列表 */
  get selectionEdgeMeshes(): THREE.Mesh[] {
    return this._selectionEdgeMeshes;
  }

  /** 场景清空 / 卸载时调用：丢掉所有装饰引用，不做逐对象清理 */
  reset(): void {
    this.selection = null;
    this.selectedMeshes = [];
    this._outlineMeshes = [];
    this._selectionEdgeMeshes = [];
  }

  select(result: PickResult | null, { silent = false }: { silent?: boolean } = {}): void {
    // 清掉上一次
    if (this.selection) {
      for (const obj of this.selectedMeshes) {
        // 点云：恢复成当前着色模式（去掉选中混色）
        if (isPointCloud(obj)) {
          this.host.applyPointCloudStyle(obj as unknown as THREE.Points, false);
          continue;
        }
        const mat = styledMaterialOf(obj as THREE.Mesh);
        if (mat) {
          mat.userData.uSelBatch.value = -1;
          mat.userData.uSelWhole.value = 0;
        }
      }
      this.selectedMeshes = [];
      this.clearDecoration();
      this.selection = null;
    }

    if (!result) {
      this.host.uniforms.uSelMix.value = 0;
      this.host.uniforms.uDim.value = 0;
      this.host.outlineMaterial.uniforms.uSelBatch.value = -1;
      this.host.outlineMaterial.uniforms.uSelWhole.value = 0;
      this.host.outlineMaterial.uniforms.uElevation.value = 0;
      this.host.requestRepaint();
      if (!silent) this.host.onPick(null);
      return;
    }

    this.selection = result;
    const targetMeshes = new Set<THREE.Mesh>();
    if (result.smid != null) {
      const smidSet = this.host.smidMeshes.get(result.smid);
      if (smidSet) {
        for (const m of smidSet) targetMeshes.add(m);
      }
    }
    targetMeshes.add(result.mesh);

    for (const mesh of targetMeshes) {
      const mat = styledMaterialOf(mesh);
      if (!mat) continue;
      let batchId = result.batchId;
      if (result.instanceIndex != null && mesh === result.mesh) {
        batchId = result.batchId;
      } else if (result.smid != null) {
        const ud = mesh.userData as MeshUserData;
        const pickInfo = ud.geoRef?.pickInfo;
        const entry = (pickInfo as Record<string | number, unknown> | undefined)?.[result.smid] ??
          (pickInfo as Record<string | number, unknown> | undefined)?.[String(result.smid)];
        const bId = entry ? pickEntryId(entry as any) : -1;
        batchId = bId >= 0 ? bId : (mesh === result.mesh ? result.batchId : -1);
      }
      mat.userData.uSelBatch.value = batchId;
      // 没有单体化信息时整块高亮，否则会出现「点中了但什么都没亮、其他全暗了」
      mat.userData.uSelWhole.value = batchId < 0 ? 1 : 0;
      this.selectedMeshes.push(mesh);
    }
    // 点云没有单体粒度：整块混成 selectColor，让选中至少看得见
    for (const mesh of this.selectedMeshes) {
      if (isPointCloud(mesh)) this.host.applyPointCloudStyle(mesh as unknown as THREE.Points, true);
    }
    this.host.uniforms.uSelMix.value = 1;
    this.host.uniforms.uDim.value = this.host.style.dimOthers ? 1 : 0;

    if (this.host.style.outline) {
      // 棱线 / 外扩轮廓都是按「面」设计的，点云画不出来也不该画
      const decoMeshes = [...targetMeshes].filter((m) => !isPointCloud(m));
      if (decoMeshes.length) {
        if ((this.host.style.outlineStyle ?? 'edges') === 'edges') {
          this.addSelectionEdges(result, decoMeshes);
        } else {
          this.addSelectionHull(result, decoMeshes);
        }
      }
    }
    this.host.requestRepaint();
  }

  /**
   * 选中单体的棱线：只挑这个单体自己的三角面算折边，再画成屏幕空间等宽线。
   * 抽出来的线段数很少（一栋楼通常几百到几千条），所以选中开销可以忽略。
   */
  addSelectionEdges(result: PickResult, meshes: Iterable<THREE.Mesh>): void {
    this.syncStyle();
    for (const mesh of meshes) {
      const ud = mesh.userData as MeshUserData;
      const geoRef = ud.geoRef;
      let segments: PickSegment[] = [];
      // 这块网格上的棱线全部属于选中的那个单体，整批填同一个 batchId，
      // 顶点着色器才能从状态纹理里取到平移 / 拔高——选中跟随移动靠它。
      let batchId = -1;
      if (mesh === result.mesh && result.instanceIndex != null) {
        // 实例化几何没有逐单体的顶点区间，整个 base mesh 就是这一栋的外形
        segments = [{ vertexOffset: 0, vertexCount: mesh.geometry.getAttribute('position')?.count ?? 0 }];
        const pickInfo = geoRef?.pickInfo;
        const entry = (pickInfo as Record<string | number, unknown> | undefined)?.[result.smid ?? ''] ??
          (pickInfo as Record<string | number, unknown> | undefined)?.[String(result.smid)];
        batchId = entry ? pickEntryId(entry as any) : -1;
      } else if (result.smid != null) {
        const pickInfo = geoRef?.pickInfo;
        const entry = (pickInfo as Record<string | number, unknown> | undefined)?.[result.smid] ??
          (pickInfo as Record<string | number, unknown> | undefined)?.[String(result.smid)];
        const bId = entry ? pickEntryId(entry as any) : -1;
        batchId = bId;
        segments = (entry as any)?.segments ?? (bId >= 0 ? resolveFeature(geoRef, bId).segments : []);
      } else if (mesh === result.mesh) {
        const localGeo = (ud.geoByBatchId as Map<number, GeoPackageEntry> | undefined)?.get(result.batchId) ?? geoRef;
        segments = resolveFeature(localGeo, result.batchId).segments;
        batchId = result.batchId;
      }

      const pairs = buildFeatureEdgeSegments(mesh.geometry, segments);
      if (pairs && pairs.length > 0) {
        const batchIds = batchId >= 0 ? new Float32Array(pairs.length / 6).fill(batchId) : undefined;
        const lines = new THREE.Mesh(
          buildThickLineGeometry(pairs, batchIds),
          this.host.createSelectionEdgeMaterial(mesh)
        );
        lines.renderOrder = 4;
        // 屏幕空间外扩后可能超出原包围球，关掉剔除更稳
        lines.frustumCulled = false;
        lines.raycast = () => {};
        (lines.userData as MeshUserData).isSelectionEdge = true;
        if (mesh === result.mesh && result.instanceIndex != null) {
          this.applyInstanceTransform(lines, result);
        }
        mesh.add(lines); // 作为子节点，直接继承世界变换
        this._selectionEdgeMeshes.push(lines);
      }
    }

    if (this._selectionEdgeMeshes.length === 0) {
      // 抽不出折边（退化几何 / 没有任何夹角）时退回外扩轮廓，至少保证选中可见
      this.addSelectionHull(result, meshes);
      return;
    }
  }

  /** 实例化几何：把某个实例的矩阵套到一个普通 Mesh/子节点上（子节点不参与父级的 instanceMatrix） */
  applyInstanceTransform(obj: THREE.Object3D, result: PickResult): void {
    const im = result.mesh as THREE.InstancedMesh;
    if (result.instanceIndex == null || !im.isInstancedMesh) return;
    const m = new THREE.Matrix4();
    im.getMatrixAt(result.instanceIndex, m);
    m.decompose(obj.position, obj.quaternion, obj.scale);
  }

  /** 旧的描边画法：背面外扩法，整块几何一起上，靠 uSelBatch 只显示选中那栋 */
  addSelectionHull(result: PickResult, meshes: Iterable<THREE.Mesh>): void {
    const instanced = result.instanceIndex != null;
    // 实例化：轮廓是这个实例的单独一份副本（普通 Mesh），所以整份都画；
    // 顶点区间型：整块几何一起画，靠 uSelBatch 只显示选中那栋。
    this.host.outlineMaterial.uniforms.uSelBatch.value = instanced ? -1 : result.batchId;
    this.host.outlineMaterial.uniforms.uSelWhole.value = instanced || result.batchId < 0 ? 1 : 0;
    this.host.outlineMaterial.uniforms.uElevation.value = instanced
      ? this.selectionElevation(result)
      : this.host.style.selectElevation ?? 0;

    for (const mesh of meshes) {
      const mat = styledMaterialOf(mesh);
      if (mat?.userData?.uBatchTex) {
        this.host.outlineMaterial.uniforms.uBatchTex.value = mat.userData.uBatchTex.value as THREE.Texture;
        this.host.outlineMaterial.uniforms.uBatchTexWidth.value = mat.userData.uBatchTexWidth.value as number;
        this.host.outlineMaterial.uniforms.uBatchTexActive.value = mat.userData.uBatchTexActive.value as number;
      }
      const outline = new THREE.Mesh(mesh.geometry, this.host.outlineMaterial);
      outline.renderOrder = 3;
      outline.frustumCulled = false;
      outline.raycast = () => {};
      if (mesh === result.mesh && result.instanceIndex != null) {
        this.applyInstanceTransform(outline, result);
      }
      mesh.add(outline); // 作为子节点，直接继承世界变换
      this._outlineMeshes.push(outline);
    }
  }

  /** 只改 uniform：颜色 / 粗细 / 拔高，拖着滑块实时生效，不重建几何 */
  syncStyle(): void {
    const s = this.host.style;
    const u = this.host.selectionEdgeMaterial.uniforms;
    u.uColor.value.set(s.outlineColor ?? s.selectColor);
    u.uWidth.value = Math.max(0.1, s.outlineWidthPx ?? 3);
    u.uOpacity.value = clampOpacity(s.opacity);
    // 只加全局 selectElevation：单体自己的拔高已经写在状态纹理第 2 行 z 里，
    // 顶点着色器采样时带出来了，这里再加一次就会双重拔高
    if (u.uElevation) u.uElevation.value = s.selectElevation ?? 0;

    // 外扩描边是另一个材质实例，单体状态纹理的开关是建的时候抄过去的。
    // 先选中、再抬高（或反过来）时模板会停留在旧值，这里补一次同步。
    for (const outline of this._outlineMeshes) {
      const parent = outline.parent as THREE.Mesh | null;
      const ud = parent ? styledMaterialOf(parent)?.userData : null;
      if (ud?.uBatchTex) {
        this.host.outlineMaterial.uniforms.uBatchTex.value = ud.uBatchTex.value;
        this.host.outlineMaterial.uniforms.uBatchTexWidth.value = ud.uBatchTexWidth.value;
        this.host.outlineMaterial.uniforms.uBatchTexActive.value = ud.uBatchTexActive.value;
      }
    }
  }

  /** 选中单体的实际拔高 = 全局选中拔高 + 该单体的独立拔高（与着色器口径一致） */
  selectionElevation(result: PickResult): number {
    let elev = this.host.style.selectElevation ?? 0;
    if (result.smid != null) {
      const off = this.host.featureStyleManager.getFeatureEffectiveOffset(result.smid);
      if (off.elevation) elev += off.elevation;
    }
    return elev;
  }

  clearDecoration(): void {
    for (const outline of this._outlineMeshes) {
      outline.parent?.remove(outline);
    }
    this._outlineMeshes = [];

    for (const edges of this._selectionEdgeMeshes) {
      edges.parent?.remove(edges);
      edges.geometry.dispose();
    }
    this._selectionEdgeMeshes = [];
  }

  /**
   * 把「当前选中」重放到一块新登记的 mesh 上。
   *
   * 为什么需要：选中高亮是直接写在各 mesh 材质的 uSelBatch / uSelWhole 上的，
   * 而 LOD 细化、瓦片重载、淘汰回补都会换掉 mesh —— 不重放的话，用户点中的那栋楼
   * 一细化就失去高亮（状态还在 selection.smid 里，只是没人往新 mesh 上刷）。
   */
  /**
   * 判断一块无 SMID 单体化信息的网格（如倾斜摄影或白模整块）是否空间覆盖当前选中命中点
   */
  isMeshCoveringSelection(mesh: THREE.Mesh, sel: PickResult): boolean {
    if (!sel.point) return false;
    const geom = mesh.geometry;
    if (!geom) return false;
    if (!geom.boundingBox) geom.computeBoundingBox();
    if (!geom.boundingBox) return false;

    // 将选中的三维场景点转入网格局部坐标系进行包围盒检测
    const pt = new THREE.Vector3(sel.point[0], sel.point[1], sel.point[2]);
    mesh.updateWorldMatrix(true, false);
    const inv = mesh.matrixWorld.clone().invert();
    const localPt = pt.applyMatrix4(inv);

    // 留出 0.5 米容差，避免刚好处于三角网格边缘缝隙时漏判
    const box = geom.boundingBox.clone().expandByScalar(0.5);
    return box.containsPoint(localPt);
  }

  replayOnto(mesh: THREE.Mesh): void {
    const sel = this.selection;
    if (!sel) return;
    const mat = styledMaterialOf(mesh);
    if (!mat) return;

    const ud = mesh.userData as MeshUserData;
    let batchId = -1;
    if (sel.smid != null) {
      const pickInfo = ud.geoRef?.pickInfo as Record<string | number, unknown> | undefined;
      const entry = pickInfo?.[sel.smid] ?? pickInfo?.[String(sel.smid)];
      batchId = entry ? pickEntryId(entry as any) : -1;
    }
    // 拾取命中的那块 mesh 用原始 batchId；同一 smid 散在别的几何里时按各自的区间算
    if (mesh === sel.mesh) batchId = sel.batchId;
    // 这块几何里根本没有这个单体 → 不动它（否则会把无关瓦片一起点亮）
    if (batchId < 0 && mesh !== sel.mesh) {
      if (sel.smid == null && ud.datasetId === sel.datasetId && this.isMeshCoveringSelection(mesh, sel)) {
        batchId = -1;
      } else {
        return;
      }
    }

    mat.userData.uSelBatch.value = batchId;
    mat.userData.uSelWhole.value = batchId < 0 ? 1 : 0;
    if (!this.selectedMeshes.includes(mesh)) this.selectedMeshes.push(mesh);
    if (isPointCloud(mesh)) this.host.applyPointCloudStyle(mesh as unknown as THREE.Points, true);
    this.host.uniforms.uSelMix.value = 1;
    this.host.uniforms.uDim.value = this.host.style.dimOthers ? 1 : 0;
  }
}
