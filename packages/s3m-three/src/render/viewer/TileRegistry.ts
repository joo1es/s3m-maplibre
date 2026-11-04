/**
 * 瓦片注册 / 注销：把一块已解析的瓦片挂进场景，或从场景里彻底摘掉。
 *
 * 从 `S3MViewer.ts` 搬出来（issue #27 第二轮 P11 阶段），行为逐字未变。
 *
 * 这是全工程最拥挤的一段代码：一块瓦片落地要同时写七个地方 ——
 *   ① `userData`（pickId / datasetId / 棱线标记）
 *   ② 拾取表 `picks.pickables`
 *   ③ SMID 索引 `smidMeshes`
 *   ④ 高度索引 `heights`
 *   ⑤ 点云集合与泼溅重排标记
 *   ⑥ 棱线装饰 `edges`
 *   ⑦ 新瓦片的样式继承（不透明度 / 扁平着色 / 单体 overrides / 选中重放）
 * 注销时这七处要按相反顺序清干净，漏一处就是显存泄漏或「点中的楼淡出后还在拾取」。
 *
 * 之所以能搬：这七处**都是宿主持有的容器**，本模块只操作它们的引用，
 * 自己没有状态（除了一个自增的淡入通道序号）。所以没有把控制流变成回调 ——
 * 注册顺序仍然一眼看完，只是从主类换到这个文件。
 */
import type * as THREE from 'three';
import type { Animator } from '../../anim/Animator.js';
import type { TileNode } from '../../tileset/types.js';
import type { S3MDatasetEntry } from '../DatasetManager.js';
import type { EdgeDecorator } from './EdgeDecorator.js';
import type { HeightIndex } from './HeightIndex.js';
import type { PickService } from './PickService.js';
import type { SelectionDecorator } from './SelectionDecorator.js';
import type { SplatLayer } from './SplatLayer.js';
import type { TilePlacement } from './TilePlacement.js';
import type { FeatureStyleManager } from '../FeatureStyleManager.js';
import { restoreBaseBlendState } from '../StyleMaterial.js';
import type { StyledMaterial, S3MStyle } from '../StyleMaterial.js';
import { isOwnedPointCloudMaterial } from '../PointCloudMaterial.js';
import type { MeshUserData, PickResult } from './types.js';
import { clampOpacity, isPointCloudObject, styledMaterialOf } from './materialHelpers.js';

/** 场景锚点的只读视图（与 `TilePlacement` 用同一份形状） */
interface SceneAnchorLike {
  x: number;
  y: number;
  z: number;
  meterInMercator: number;
  meterInMercatorEast?: number;
  meterInMercatorNorth?: number;
  meterInMercatorUp?: number;
  altitude?: number;
}

/** `TileRegistry` 需要的宿主入口。全是活引用，只有一处自增序号需要回调 */
export interface TileRegistryHost {
  readonly animator: Animator;
  readonly picks: PickService;
  readonly edges: EdgeDecorator;
  readonly sel: SelectionDecorator;
  readonly heights: HeightIndex;
  readonly splats: SplatLayer;
  readonly placement: TilePlacement;
  readonly featureStyles: FeatureStyleManager;
  /** 泼溅 / 点云网格集合（注册时往里加，注销时摘） */
  readonly pointClouds: Set<THREE.Points>;
  /** smid → 引用它的网格（注销时给「同 smid 的其它网格」兜底查找） */
  readonly smidMeshes: Map<number, Set<THREE.Mesh>>;
  /** 图层当前样式（注册时新瓦片要继承不透明度 / 扁平着色 / 淡入时长） */
  readonly style: S3MStyle;
  /** 图层是否处于「整体半透明」（淡入结束后要恢复到这个基础状态） */
  opacityTransparent(): boolean;
  /** 是否开启瓦片级放置 */
  perTilePlacement(): boolean;
  /** 当前场景锚点（旧口径下算线宽 uniform 用） */
  sceneAnchor(): SceneAnchorLike | null;
  select(result: PickResult | null): void;
  applyPointCloudStyle(points: THREE.Points, selected?: boolean): void;
  indexMeshSmids(mesh: THREE.Mesh): void;
  unindexMeshSmids(mesh: THREE.Mesh): void;
  allocPickId(): number;
  releasePickId(id: number): void;
  requestRepaint(): void;
  /** 淡入通道序号：用自增序号而不是 pickId，因为 pickId 会被回收复用 */
  nextTileFadeSeq(): number;
}

export class TileRegistry {
  constructor(private readonly host: TileRegistryHost) {}

  /* ---------------------------------------------------------------- 瓦片注册 */

  registerTile(node: TileNode, entry: S3MDatasetEntry): void {
    // 必须在 add / updateMatrixWorld 之前设置：后者会拿当前 matrix 算 matrixWorld 并缓存
    //
    // ★ 触发条件**不能**是「有没有包围球」。S3M 1.x 的叶子瓦片 XML 是
    //   `<PageLods><Geode>`（外面没有 `<PagedLOD>` 包装），`parseXmlLods` 解析出来
    //   pageLods 为空 → sphere 为 null。而 `entry.root` 上挂着 align 算出来的整体偏移
    //   （索菲亚教堂是 heightRange.min = 119.84），那个偏移是靠 placement 里的
    //   `- datasetOffset` 抵消的。少摆一块，这块就带着偏移显示 —— 实测 L23 整层
    //   因此沉到地下 120 m，且 `localZ - worldZ` 恒等于偏移量。
    //   缺球时用几何包围盒中心兜底；连几何都没有就退回旧口径。
    const center = node.sphere?.center ?? this.host.placement.localCenterOf(node.group);
    if (this.host.perTilePlacement() && center) {
      this.host.placement.apply(node.group, center, entry);
    }
    // 上面没摆成（关掉本功能 / 缺锚点 / 几何为空）时 matrixAutoUpdate 仍是 true，走旧口径
    if (node.group.matrixAutoUpdate) {
      const sceneAnchor = this.host.sceneAnchor();
      if (sceneAnchor) {
        const sEast = sceneAnchor.meterInMercatorEast ?? sceneAnchor.meterInMercator;
        const sNorth = sceneAnchor.meterInMercatorNorth ?? sceneAnchor.meterInMercator;
        const sUp = sceneAnchor.meterInMercatorUp ?? sEast;
        const c = node.sphere
          ? ([node.sphere.center.x, node.sphere.center.y, node.sphere.center.z] as const)
          : ([0, 0, 0] as const);
        this.host.placement.updateUniforms(node.group, c, [1.0 / sEast, 1.0 / sNorth, 1.0 / sUp]);
      }
    }
    entry.root.add(node.group);
    node.group.updateMatrixWorld(true);

    const hasNativeEdges = node.group.userData.hasNativeEdges === true;
    // forceCpuEdges：无视数据自带的棱线包，改由 CPU 现算。native 是 1px 的
    // LineBasicMaterial，edgeWidth / 外扩 / 单体跟随全都吃不上。
    // gpu 画法由 shader 自己描边，native 线段包同样不能留
    const useNativeEdges = this.host.edges.useNativeEdges(hasNativeEdges);

    for (const child of node.group.children) {
      // 数据自带的棱线包：只跟着 edges 开关显示，不参与拾取、不参与着色
      if ((child as THREE.LineSegments).isLineSegments && (child.userData as MeshUserData).isEdgeLines) {
        // 一律登记：forceCpuEdges 之后又关掉时还要能把它们放出来
        this.host.edges.registerNativeLine(child as THREE.LineSegments, useNativeEdges && this.host.edges.enabled);
        continue;
      }

      // 点云是 THREE.Points 不是 Mesh，但同样要进拾取表、吃不透明度、跟着着色模式走
      const isPoints = isPointCloudObject(child);
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh && !isPoints) continue;
      if (isPoints) this.host.pointClouds.add(child as THREE.Points);
      // 新瓦片里的泼溅实例还没按当前视角排过，下一帧要重排
      if (isPoints) this.host.splats.markDirty();
      const ud = mesh.userData as MeshUserData;
      ud.pickId = this.host.allocPickId();
      ud.datasetId = entry.id;
      ud.nativeEdges = useNativeEdges;
      ud.nativeEdgesRaw = hasNativeEdges;
      this.host.picks.pickables.set(ud.pickId, {
        datasetId: entry.id,
        mesh,
        tile: node.tile,
        skeletonName: ud.skeletonName ?? '',
      });
      this.host.indexMeshSmids(mesh);
      this.host.heights.add(mesh);
      // 点云没有「棱」：给一堆孤立点建 EdgesGeometry 又慢又没意义
      // 点云没有「棱」：给一堆孤立点建 EdgesGeometry 又慢又没意义。
      // 自动描边受三道开关控制：全局 style.edges / 数据集 enableEdges / 地形绿地等关键字跳过。
      this.host.edges.autoDecorate(mesh, entry, useNativeEdges);

      // 新瓦片要继承当前的不透明度与着色方式
      if (isPoints) {
        this.host.applyPointCloudStyle(child as THREE.Points);
      } else {
        const mat = styledMaterialOf(mesh);
        if (mat) {
          const o = clampOpacity(this.host.style.opacity);
          // 不写 mat.opacity：全局透明度走共享 uOpacity，材质自身 opacity 保留模型自带 alpha
          // 混合开关不能写成 `o < 0.999` 一刀切：材质自身可能是 blend / 顶点 alpha
          // 透明（s3mOpts.transparent，如 SMID 4421），注册时就被这句踩掉，
          // 表现为「刚进去没透明度，切换材质质感重建后才恢复」。
          const keepDepth = this.host.style.depthWrite !== false;
          restoreBaseBlendState(mat, o < 0.999, keepDepth);
          // shading 走共享 uniform（uFlatShading），不写 mat.flatShading / needsUpdate——
          // transparent / depthWrite 也不是 program 决定项，整套样式继承零重编译
          if (mat.userData.uFlatShading) {
            mat.userData.uFlatShading.value = this.host.style.shading !== 'smooth' ? 1 : 0;
          }
          this.host.featureStyles.applyOverridesToMesh(mesh);
          this.startTileFade(mesh, mat);
        }
      }

      // 选中状态也要跟着继承：LOD 细化 / 瓦片重载会换掉 mesh，
      // 不重放就出现「点中的那栋楼一拉近就没高亮了」
      this.host.sel.replayOnto(mesh);
    }
  }

  /**
   * 新瓦片淡入。
   *
   * 每块网格有自己的材质实例，所以给一个逐材质的 `uTileFade` 就够，不需要动共享
   * uniform、也不需要重建任何东西。淡入期间该网格进透明队列（混合 + 排序），
   * 淡完立刻把 `transparent` 还给图层状态，避免长期留在透明通道里。
   *
   * 通道 key 用自增序号而不是 pickId：pickId 会被回收复用，用它会串到新瓦片上。
   */
  startTileFade(mesh: THREE.Mesh, mat: StyledMaterial): void {
    const duration = this.host.style.fadeIn ?? 0;
    if (duration <= 0) return;
    const uFade = mat.userData.uTileFade;
    if (!uFade) return;

    uFade.value = 0;
    mat.transparent = true;
    // 淡入期间保持深度写入：否则能透过正在淡入的楼看到后面的东西，像在「漏」
    mat.depthWrite = true;

    const key = `tile.${this.host.nextTileFadeSeq()}.fade`;
    (mesh.userData as MeshUserData).tileFadeKey = key;
    this.host.animator.register(key, {
      dim: 1,
      read: (out) => {
        out[0] = uFade.value;
      },
      write: (v) => {
        uFade.value = v[0];
      },
    });
    this.host.animator.to(key, 1, {
      duration,
      easing: 'easeOutQuad',
      onComplete: () => {
        uFade.value = 1;
        (mesh.userData as MeshUserData).tileFadeKey = undefined;
        this.host.animator.unregister(key);
        // 淡入期间强制开了 transparent + depthWrite，结束时不能自己拍板关掉——
        // 先恢复「材质自身语义 || 图层透明度」的基础状态（材质可能是 blend /
        // 顶点 alpha 透明，如 SMID 4421），再让单体淡化流程有需要时重新打开。
        restoreBaseBlendState(mat, this.host.opacityTransparent(), this.host.style.depthWrite !== false);
        this.host.featureStyles.applyOverridesToMesh(mesh);
        this.host.requestRepaint();
      },
    });
  }

  /** 瓦片被淘汰：从拾取表和场景里摘掉，并深度彻底释放所有几何体与材质显存 */
  unregisterTile(node: TileNode, entry: S3MDatasetEntry): void {
    node.group.traverse((child) => {
      const obj = child as any;
      if ((child as THREE.LineSegments).isLineSegments && obj.userData?.isEdgeLines) {
        this.host.edges.unregisterNativeLine(child as THREE.LineSegments);
      }
      if (isPointCloudObject(child)) this.host.pointClouds.delete(child);
      // 淡入还没结束就被淘汰：把通道收掉，否则会对着已释放的材质继续写
      if (obj.userData?.tileFadeKey) {
        this.host.animator.unregister(obj.userData.tileFadeKey);
        obj.userData.tileFadeKey = undefined;
      }
      if (obj.userData?.pickId != null) {
        this.host.picks.pickables.delete(obj.userData.pickId);
        this.host.releasePickId(obj.userData.pickId);
        obj.userData.pickId = undefined;
      }
      if (obj.isMesh) {
        const wasSelected = this.host.sel.selectedMeshes.includes(obj);
        if (wasSelected) {
          this.host.sel.selectedMeshes = this.host.sel.selectedMeshes.filter((m) => m !== obj);
        }
        const currentSel = this.host.sel.selection;
        if (currentSel && currentSel.mesh === obj) {
          const smid = currentSel.smid;
          const carrier = (
            smid != null
              ? [...(this.host.smidMeshes.get(smid) ?? [])].find((m) => m !== obj && m.parent)
              : this.host.sel.selectedMeshes.find((m) => m !== obj && m.parent && (m.parent as any).visible) ??
                this.host.sel.selectedMeshes.find((m) => m !== obj && m.parent)
          ) as THREE.Mesh | undefined;
          if (carrier) {
            // 选中身份交给承载同一 smid 的另一块 mesh（通常是接替显示的子瓦）
            this.host.sel.selection = { ...currentSel, mesh: carrier };
            this.host.sel.replayOnto(carrier);
          } else {
            this.host.select(null);
          }
        }
        this.host.unindexMeshSmids(obj);
        this.host.heights.remove(obj);
        this.host.featureStyles.disposeMesh(obj);
        const styled = styledMaterialOf(obj);
        styled?.dispose?.();
      }
      // 深度释放材质（点云、普通材质、材质数组）
      if (isOwnedPointCloudMaterial(obj.material)) {
        (obj.material as THREE.Material).dispose();
      } else if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m: any) => m?.dispose?.());
        } else {
          obj.material.dispose?.();
        }
      }
      // 释放几何体显存缓冲
      obj.geometry?.dispose?.();
    });
    entry.root.remove(node.group);
  }
}
