/**
 * LOD 可见性与细化判定：`update()` 的入口、两套可见性递归、增量细化的深度推移。
 *
 * 从 `S3MTileset.ts` 搬出来（issue #27 的 P4 阶段），行为逐字未变。
 *
 * 这块是瓦片集的**唯一编排点**：它读节点表算距离与像素尺寸、决定谁该细化、把子瓦排进队列，
 * 再递归分配「这块地由谁显示」，最后才让宿主裁预算（make-before-break）。
 * 之所以能搬出来，是因为它自己只持有一个帧号，其余全是宿主的活引用。
 *
 * 三条容易改错的口径（搬的时候原样保留）：
 *   ① **像素尺寸用的是写死 45° 视场**（`tan(PI/8)`），不取渲染器实际 fov，末尾还有个 `*2`
 *      按直径量——少这个 `*2` 会让细化永远差一级（贴着看也停在最粗的根图集）。
 *   ② **没有包围球的瓦片也必须记 `lastSeen`**。算不出距离不等于可以不管：`lastSeen` 恒为
 *      undefined 会让它在淘汰候选里永远排最前，硬上限一触发就踢掉正在显示的那块。
 *   ③ **可见性图不是严格的树**。同一个子瓦可能被多个父瓦引用，递归必须有 `visited` 守卫，
 *      否则指数展开甚至成环（RangeError）。
 */
import { splatLodDecision } from '../core/SplatLod.js';
import type { TileNode, TileVisibilityTest } from './types.js';

const EMPTY_CHILD_URLS: readonly string[] = [];

/**
 * 稳定获取瓦片的子瓦片 URL 列表。
 *
 * 若节点未显式挂载 childUrls（如单测构造的 mock 节点），则按 `node.childUrls ?? (node.childUrl ? [node.childUrl] : [])`
 * 的原有口径归一化后就地缓存到 node.childUrls 上，避免每帧每个节点判定时重复构造短命数组（Issue #31）。
 */
export function getNodeChildUrls(node: TileNode): readonly string[] {
  if (node.childUrls !== undefined) return node.childUrls;
  const list = node.childUrl ? [node.childUrl] : (EMPTY_CHILD_URLS as string[]);
  node.childUrls = list;
  return list;
}

/** `TileVisibility` 需要的宿主状态 */
export interface TileVisibilityHost {
  /** 已落地的瓦片 */
  readonly nodes: Map<string, TileNode>;
  /** 判定过永久失败的瓦片（不再入队、不再等） */
  readonly failed: Set<string>;
  /** 在途瓦片 */
  readonly pending: Set<string>;
  /** 配置里的入口瓦片 */
  readonly rootUrls: readonly string[];
  /** 子瓦 URL → 父瓦 URL */
  readonly parentOf: Map<string, string>;
  /** 当前由谁负责显示（binary 模式下写；incremental 模式下由递归维护） */
  readonly primaryNodes: Set<string>;
  /** 增量细化模式下兜底填充的父级瓦片 */
  readonly fallbackNodes: Set<string>;
  /** fallback 兜底瓦片的材质深度偏移系数 */
  readonly fallbackOffset: { factor: number; units: number };
  /** LOD 切换范围缩放系数（> 1 更倾向保留粗模） */
  lodRangeScale(): number;
  /** LOD 过渡策略 */
  lodTransition(): 'binary' | 'incremental';
  /** 进一帧，返回新的帧号（对应原来的 `this._frame++`） */
  beginFrame(): number;
  /** 当前帧号 */
  frame(): number;
  /** 把子瓦排进加载队列（带上父瓦 URL，供淘汰后补洞） */
  enqueue(url: string | null, parentUrl?: string): void;
  /** 显示职责已分配完毕，此刻才允许裁预算 */
  trimBudget(): boolean;
}

/** `update()` 的可选行为开关 */
export interface TileVisibilityOptions {
  /**
   * 用 `isVisible` 限制「要不要为视野外瓦片请求子瓦片」。默认等于 `isVisible` 是否传入，
   * 保持旧口径（传了回调就参与细化判定）。对应公开的 `cullRefine`。
   */
  refineCull?: boolean;
  /**
   * 用 `isVisible` 决定 `group.visible`。默认 `false`——不传时行为与改动前逐字一致。
   *
   * 为什么必须独立于 `refineCull`：`cullRefine` 省的是下载与解码，画不画是另一回事。
   * three 自己的视锥是错的（`projectionMatrix` 被换成完整 MVP、`matrixWorldInverse`
   * 只是相机平移的逆，两者相乘把视锥整体平移了「相机到锚点」的距离，见 #36），
   * 所以瓦片的绘制可见性必须由这里按宿主 MVP 判定。
   */
  visibleCull?: boolean;
}

export class TileVisibility {
  /** 内部 Set/Map 容器复用，避免每帧 update 产生大量短命对象引起 GC 抖动（Issue #31） */
  private readonly _visited = new Set<string>();
  private readonly _roots = new Set<string>();
  private readonly _nextPrimary = new Set<string>();
  private readonly _nextFallback = new Set<string>();
  private readonly _nodeDepths = new Map<string, number>();
  /** 记录上一帧各 fallback 节点的深度，深度不变且保持 fallback 时无需重复遍历 */
  private readonly _lastFallbackDepths = new Map<string, number>();

  constructor(private readonly host: TileVisibilityHost) {}

  /** 本帧的视锥判定回调（由 `update` 注入，只在本次 update 内有效） */
  private _visibleTest?: TileVisibilityTest;
  /** 本次 update 是否按视锥决定绘制 */
  private _visibleCull = false;

  /** 节点是否被视锥剔除；没有包围球时判不了，一律保留 */
  private _culled(node: TileNode): boolean {
    const test = this._visibleTest;
    if (!this._visibleCull || !test || !node.sphere) return false;
    return !test(node.sphere.center, node.sphere.radius, node);
  }

  /**
   * @param camEnu 相机在该数据集局部 ENU 坐标系中的位置（米）
   * @param fovRad 垂直视场角（弧度）
   * @param screenHeight 视口像素高度
   * @returns 瓦片加载队列或可见性是否发生变化
   */
  update(
    camEnu: [number, number, number],
    fovRad: number,
    screenHeight: number,
    isVisible?: TileVisibilityTest,
    options?: TileVisibilityOptions
  ): boolean {
    this.host.beginFrame();
    let hasChanges = false;
    const debugLod = Boolean((globalThis as { __S3M_LOD_DEBUG?: boolean }).__S3M_LOD_DEBUG);

    this._visibleTest = isVisible;
    this._visibleCull = options?.visibleCull === true;
    // 旧口径：传了回调就参与细化判定；显式给了 refineCull 才以它为准
    const refineCull = options?.refineCull ?? isVisible !== undefined;

    for (const node of this.host.nodes.values()) {
      if (!node.sphere) {
        // 没有包围球（S3M 1.x 叶子瓦片：XML 是 `<PageLods><Geode>`，没有 PagedLOD）时
        // 算不出距离，但**仍要记「最近用过」**：`lastSeen` 恒为 undefined 会让它在
        // `_pickVictim` 里永远排最前（`?? -1`），硬上限一触发 `allowUncovered`，
        // 第一块被踢掉的就是正在显示的那块 —— 画面立刻一个洞，下一帧又加载回来。
        node.lastSeen = this.host.frame();
        node.needRefine = false;
        continue;
      }

      const c = node.sphere.center;
      const dx = c.x - camEnu[0];
      const dy = c.y - camEnu[1];
      const dz = c.z - camEnu[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      node.distance = dist;

      let metric: number;
      // RangeMode 语义（规范只写了 0/1）：
      //   0 Distance_From_EyePoint —— rangeValue 是米，离得越近越该细化
      //   1 Pixel_Size_OnScreen     —— rangeValue 是屏幕像素，投影半径超过它就细化
      //   2 规范枚举里没有这一档（文档里记作 Geometric_Error）。实测高斯泼溅 / 点云服务用的是
      //     这一档，且 rangeValue ≈ 包围球半径的固定比例（根瓦片 0.664/10.455，子瓦片
      //     0.332/3.7，比例都约 0.064），像是「相对屏幕尺寸的几何误差」而非绝对像素。
      //     这里先按 1 处理：方向是对的（近处细化），只是阈值偏小会多下几层，靠 lodRangeScale 收着。
      const byDistance = node.rangeMode === 0;
      if (byDistance) {
        metric = dist; // Distance_From_EyePoint：距离越小越该细化
      } else {
        // 屏幕像素尺寸。照抄官方 PageLod.calcPixFromCam（SourceRelease/_3437c37f.js）：
        //   pix = (drawingBufferHeight/2) / tan(PI_OVER_FOUR * 0.5) * radius / distance * 2
        //       = drawingBufferHeight * 2.4142 * radius / distance
        // 两个要点：① 视场角是**写死的 45°**（tan(22.5°)），不取渲染器实际 fov；
        // ② 末尾那个 *2（即用直径量屏幕尺寸）。少这个 *2 会让 metric 只有官方的一半，
        //    needRefine 的门槛就永远差一级 —— 表现就是「贴着看也一直在渲染最粗的根图集，
        //    一张整楼雪碧被 uv 平铺几十遍」。实测瓦片 6_01：radius 293.4、rangeValue 586.8，
        //    distance ≈ 824 m、H = 854 → 官方算 734 > 586.8 该细化，我们旧公式只有 326。
        metric = ((screenHeight * 0.5) / Math.tan(Math.PI / 8)) * (node.sphere.radius / dist) * 2;
        void fovRad;
      }

      // 在有效范围内（留一倍余量）的算「正在用」，淘汰时按这个帧号排优先级
      const scale = this.host.lodRangeScale() > 0 ? this.host.lodRangeScale() : 1.0;
      const threshold = node.rangeValue * scale;
      const inRange = byDistance ? dist < threshold * 2 : metric > threshold * 0.5;
      if (inRange) node.lastSeen = this.host.frame();

      const childUrls = getNodeChildUrls(node);
      // 加入 8% 迟滞区间（Hysteresis Band），防止相机在 LOD 临界距离处发生父子瓦片逐帧来回横跳闪烁
      const hFactor = node.needRefine ? (byDistance ? 1.08 : 0.92) : 1.0;

      // 泼溅 / 点云瓦片走另一套判据：每层 σ 是同一个物理量、只有点数在涨，包围球
      // 像素误差对它没有含义 —— 按上面那套算，metric 在任何距离都远大于阈值，等于
      // 「永远细化到叶子」。
      // 判据换成**屏幕上的高斯尺寸**（3σ 超过 SPLAT_REFINE_PX 就细化），见 core/SplatLod.ts。
      // 别用覆盖率：主体那块根瓦片 32 万高斯、σ=13.5cm，覆盖率一上来就是 51，
      // 当场停止细化，最后只画了总量 2.3% 的高斯 —— 柱子就是这么被糊掉的。
      const splat =
        node.splatSigma && node.sphere
          ? splatLodDecision({
              splats: node.splatCount ?? node.stats?.vertices ?? 0,
              radius: node.sphere.radius,
              distance: dist,
              sigma: node.splatSigma,
              screenHeight,
              hasChild: childUrls.length > 0,
            })
          : null;

      let needRefine = splat
        ? splat.needRefine
        : childUrls.length > 0 &&
          (byDistance ? metric < threshold * hFactor : metric > threshold * hFactor);
      if (needRefine && refineCull && isVisible && !isVisible(c, node.sphere.radius, node)) {
        needRefine = false;
      }
      node.needRefine = needRefine;

      if (debugLod) {
        const dbgSeen = ((globalThis as { __S3M_LOD_SEEN?: Set<string> }).__S3M_LOD_SEEN ??= new Set<string>());
        if (!dbgSeen.has(node.url) && dbgSeen.size < 260) {
          dbgSeen.add(node.url);
          // eslint-disable-next-line no-console
          console.log('[LOD]', JSON.stringify({
            url: node.url.split('/').pop(), mode: node.rangeMode, rangeValue: node.rangeValue,
            radius: node.sphere.radius, dist: +dist.toFixed(1), metric: +metric.toFixed(1),
            threshold: +threshold.toFixed(1), needRefine, childUrls: childUrls.map((u) => u.split('/').pop()),
            parent: node.parentUrl ? node.parentUrl.split('/').pop() : null,
          }));
        }
      }

      if (needRefine) {
        for (let i = 0; i < childUrls.length; i++) {
          const childUrl = childUrls[i]!;
          if (!this.host.failed.has(childUrl) && !this.host.nodes.has(childUrl) && !this.host.pending.has(childUrl)) {
            this.host.enqueue(childUrl, node.url);
            hasChanges = true;
          }
        }
      }
    }

    // 树状递归更新所有瓦片的可见性（确保每个位置只渲染一层最适合的 LOD，避免父子瓦片重叠 Z-fighting）
    this._visited.clear();
    // 根集合 = 配置里的入口瓦片 + 所有「父瓦已不在档」的瓦片。
    // 后者必须有：淘汰掉一块中间层瓦片后，它下面的子孙会瞬间变成"无父"状态，
    // 如果只按 rootUrls 走，它们全部不可达，会被下面那条防御规则一起隐藏 ——
    // 症状就是「进去先渲染出来，然后整片消失，偶尔闪一下」。
    this._roots.clear();
    for (let i = 0; i < this.host.rootUrls.length; i++) {
      this._roots.add(this.host.rootUrls[i]!);
    }
    for (const [url, node] of this.host.nodes) {
      const p = node.parentUrl ?? this.host.parentOf.get(url);
      if (!p || !this.host.nodes.has(p)) this._roots.add(url);
    }

    if (this.host.lodTransition() === 'incremental') {
      if (this.updateIncremental(this._roots, this._visited)) {
        hasChanges = true;
      }
    } else {
      for (const rootUrl of this._roots) {
        if (this.updateVisibility(rootUrl, true, this._visited)) {
          hasChanges = true;
        }
      }
      this.host.primaryNodes.clear();
      for (const [url, node] of this.host.nodes) {
        if (node.group.visible) this.host.primaryNodes.add(url);
      }
      this.host.fallbackNodes.clear();
    }

    // 防御：若有任何未被 root 树访问到的游离瓦片，全部隐藏
    for (const [url, node] of this.host.nodes) {
      if (!this._visited.has(url)) {
        if (node.group.visible) {
          node.group.visible = false;
          hasChanges = true;
        }
        if (this.host.lodTransition() === 'incremental' && this.host.fallbackNodes.has(url)) {
          this.restorePolygonOffset(node);
        }
      }
    }

    // 显示职责已经分配完毕，现在才裁预算（make-before-break）：
    // 此时「谁在负责显示这块地」是确定的，只踢没人依赖的那块，不会开出洞来
    if (this.host.trimBudget()) hasChanges = true;

    // 兜底：绝不允许空场。
    // 可见性递归是按「先访问先决定」处理的，而 LOD 图不一定是严格的树 —— 同一个子瓦可能
    // 被多个父瓦引用（不同层级指向同一份数据），它可能先在某条"隐藏分支"里被访问掉，
    // 之后就再也拿不到显示机会，最终出现「一块都不显示」的整片消失。
    // 这里做最后一次校正：凡是位置没有被任何可见子瓦接手的瓦片，一律自己显示。
    let anyVisible = false;
    for (const node of this.host.nodes.values()) {
      if (node.group.visible) {
        anyVisible = true;
        break;
      }
    }
    // 视锥剔除生效时允许空场：镜头转开就是要什么都不画，此时点亮会被上面的剔除抵消。
    if (!anyVisible && this.host.nodes.size > 0 && !this._visibleCull) {
      for (const node of this.host.nodes.values()) {
        const childUrls = getNodeChildUrls(node);
        let covered = false;
        for (let i = 0; i < childUrls.length; i++) {
          const c = this.host.nodes.get(childUrls[i]!);
          if (c && c !== node && c.group.visible) {
            covered = true;
            break;
          }
        }
        if (!covered && !node.group.visible) {
          node.group.visible = true;
          hasChanges = true;
        }
      }
    }

    // 视锥回调只在本次 update 内有效：`updateVisibility` / `updateIncremental` 是公开方法，
    // 被单独调用时不该沿用上一帧的判定
    this._visibleTest = undefined;
    this._visibleCull = false;

    return hasChanges;
  }

  updateVisibility(url: string, parentInBranch: boolean, visited: Set<string> = this._visited): boolean {
    const node = this.host.nodes.get(url);
    if (!node) return false;
    // 必须挡住重复访问：可见性图不是严格的树 —— 同一个子瓦可能被多个父瓦引用（不同 LOD 源
    // 指向同一份数据）、淘汰后重挂父级也可能临时造出交叉引用。没有这道守卫，
    // 递归会指数级展开甚至成环，直接 RangeError: Maximum call stack size exceeded。
    if (visited.has(url)) return false;
    visited.add(url);

    let changed = false;
    const childUrls = getNodeChildUrls(node);

    if (!parentInBranch) {
      if (node.group.visible) {
        node.group.visible = false;
        changed = true;
      }
      for (let i = 0; i < childUrls.length; i++) {
        if (this.updateVisibility(childUrls[i]!, false, visited)) changed = true;
      }
      return changed;
    }

    // 视锥外：子瓦的包围球不会超出父瓦的包围球，父的包围球整个在视锥外时子树必然也不可见，
    // 整棵一起隐藏。这里只管「画不画」，要不要继续请求子瓦由 refineCull 单独控制。
    if (this._culled(node)) {
      if (node.group.visible) {
        node.group.visible = false;
        changed = true;
      }
      for (let i = 0; i < childUrls.length; i++) {
        if (this.updateVisibility(childUrls[i]!, false, visited)) changed = true;
      }
      return changed;
    }

    // 细化前提：需要细化、至少有一个子瓦片就绪、且没有还在下载途中的子瓦片
    // （不等「全部就绪」是因为个别 childTile 在服务器上就是 404，等它等于永远不细化）
    // 单步循环短路避免产生 filter / every 临时数组与闭包（Issue #31）
    let shouldRefine = false;
    if (node.needRefine && childUrls.length > 0) {
      let hasReady = false;
      let allResolved = true;
      for (let i = 0; i < childUrls.length; i++) {
        const cUrl = childUrls[i]!;
        if (this.host.nodes.has(cUrl)) {
          hasReady = true;
        } else if (!this.host.failed.has(cUrl)) {
          allResolved = false;
          break;
        }
      }
      shouldRefine = hasReady && allResolved;
    }

    if (shouldRefine) {
      // 子节点接替当前节点渲染，当前父节点隐藏
      if (node.group.visible) {
        node.group.visible = false;
        changed = true;
      }
      for (let i = 0; i < childUrls.length; i++) {
        if (this.updateVisibility(childUrls[i]!, true, visited)) changed = true;
      }
    } else {
      // 当前节点即为最终展示的 LOD：当前节点显示，下层所有已加载子代瓦片隐藏
      if (!node.group.visible) {
        node.group.visible = true;
        changed = true;
      }
      for (let i = 0; i < childUrls.length; i++) {
        if (this.updateVisibility(childUrls[i]!, false, visited)) changed = true;
      }
    }

    return changed;
  }

  applyFallbackPolygonOffset(node: TileNode, depth: number): boolean {
    const factor = this.host.fallbackOffset.factor;
    const units = Math.max(2, (10 - Math.min(depth, 8)) * this.host.fallbackOffset.units);
    const targetKey = `${factor}:${units}`;

    let changed = false;

    node.group.traverse((obj) => {
      const target = obj as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; material?: any };
      if ((target.isMesh || target.isPoints || target.isLine) && target.material) {
        const materials = Array.isArray(target.material) ? target.material : [target.material];
        for (const mat of materials) {
          if (!mat) continue;
          if (!mat.userData) mat.userData = {};
          if (!mat.userData._basePolygonOffset) {
            mat.userData._basePolygonOffset = {
              polygonOffset: mat.polygonOffset === true,
              factor: mat.polygonOffsetFactor ?? 0,
              units: mat.polygonOffsetUnits ?? 0,
            };
          }
          if (mat.userData._fallbackOffsetKey === targetKey) {
            continue;
          }
          const base = mat.userData._basePolygonOffset;
          const targetFactor = base.factor + factor;
          const targetUnits = base.units + units;
          if (
            mat.polygonOffset !== true ||
            mat.polygonOffsetFactor !== targetFactor ||
            mat.polygonOffsetUnits !== targetUnits
          ) {
            mat.polygonOffset = true;
            mat.polygonOffsetFactor = targetFactor;
            mat.polygonOffsetUnits = targetUnits;
            changed = true;
          }
          mat.userData._fallbackOffsetKey = targetKey;
        }
      }
    });
    return changed;
  }

  restorePolygonOffset(node: TileNode): boolean {
    let changed = false;
    node.group.traverse((obj) => {
      const target = obj as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; material?: any };
      if ((target.isMesh || target.isPoints || target.isLine) && target.material) {
        const materials = Array.isArray(target.material) ? target.material : [target.material];
        for (const mat of materials) {
          if (mat?.userData?._basePolygonOffset) {
            if (mat.userData._fallbackOffsetKey === undefined) {
              continue;
            }
            const base = mat.userData._basePolygonOffset;
            if (
              mat.polygonOffset !== base.polygonOffset ||
              mat.polygonOffsetFactor !== base.factor ||
              mat.polygonOffsetUnits !== base.units
            ) {
              mat.polygonOffset = base.polygonOffset;
              mat.polygonOffsetFactor = base.factor;
              mat.polygonOffsetUnits = base.units;
              changed = true;
            }
            delete mat.userData._fallbackOffsetKey;
          }
        }
      }
    });
    return changed;
  }

  updateIncremental(roots: Iterable<string> = this._roots, visited: Set<string> = this._visited): boolean {
    this._nextPrimary.clear();
    this._nextFallback.clear();
    this._nodeDepths.clear();

    const traverse = (url: string, depth: number) => {
      if (visited.has(url)) return;
      visited.add(url);
      this._nodeDepths.set(url, depth);

      const node = this.host.nodes.get(url);
      if (!node) return;

      const childUrls = getNodeChildUrls(node);

      // 视锥外：不进 primary/fallback，收尾循环会把整棵子树隐藏（子包围球在父之内）
      if (this._culled(node)) {
        for (let i = 0; i < childUrls.length; i++) traverse(childUrls[i]!, depth + 1);
        return;
      }

      if (!node.needRefine || childUrls.length === 0) {
        this._nextPrimary.add(url);
        return;
      }

      // 避免 filter 产生临时数组与闭包
      let hasReady = false;
      let hasMissing = false;
      for (let i = 0; i < childUrls.length; i++) {
        const cUrl = childUrls[i]!;
        if (this.host.nodes.has(cUrl)) {
          hasReady = true;
        } else if (!this.host.failed.has(cUrl)) {
          hasMissing = true;
        }
      }

      if (hasReady) {
        if (hasMissing) {
          this._nextFallback.add(url);
        }
        for (let i = 0; i < childUrls.length; i++) {
          const cUrl = childUrls[i]!;
          if (this.host.nodes.has(cUrl)) {
            traverse(cUrl, depth + 1);
          }
        }
      } else {
        this._nextPrimary.add(url);
      }
    };

    for (const rootUrl of roots) {
      traverse(rootUrl, 0);
    }

    let changed = false;

    for (const [url, node] of this.host.nodes) {
      if (!visited.has(url)) continue;

      if (this._nextPrimary.has(url)) {
        if (!node.group.visible) {
          node.group.visible = true;
          changed = true;
        }
        const depth = this._nodeDepths.get(url) ?? 0;
        const targetOrder = 100 + depth;
        if (node.group.renderOrder !== targetOrder) {
          node.group.renderOrder = targetOrder;
          changed = true;
        }
        // 仅在上一帧是 fallback 时，恢复为 primary 才需要 traverse 还原材质偏移
        if (this.host.fallbackNodes.has(url)) {
          if (this.restorePolygonOffset(node)) changed = true;
        }
      } else if (this._nextFallback.has(url)) {
        if (!node.group.visible) {
          node.group.visible = true;
          changed = true;
        }
        const depth = this._nodeDepths.get(url) ?? 0;
        const targetOrder = depth;
        if (node.group.renderOrder !== targetOrder) {
          node.group.renderOrder = targetOrder;
          changed = true;
        }
        // 若上一帧不是 fallback，或者深度发生了推移变化，才需要 traverse 应用
        const prevDepth = this._lastFallbackDepths.get(url);
        if (!this.host.fallbackNodes.has(url) || prevDepth !== depth) {
          if (this.applyFallbackPolygonOffset(node, depth)) changed = true;
        }
      } else {
        if (node.group.visible) {
          node.group.visible = false;
          changed = true;
        }
        if (this.host.fallbackNodes.has(url)) {
          if (this.restorePolygonOffset(node)) changed = true;
        }
      }
    }

    this.host.primaryNodes.clear();
    for (const u of this._nextPrimary) this.host.primaryNodes.add(u);
    this.host.fallbackNodes.clear();
    for (const u of this._nextFallback) this.host.fallbackNodes.add(u);
    this._lastFallbackDepths.clear();
    for (const [u, d] of this._nodeDepths) {
      if (this._nextFallback.has(u)) {
        this._lastFallbackDepths.set(u, d);
      }
    }

    return changed;
  }

  /**
   * 把所有瓦片的 fallback 深度偏移恢复原状，并清空 fallback 列表。
   *
   * 切回 `binary` 模式时用；遍历所有瓦片还原材质状态，杜绝任何残留。
   */
  restoreAllPolygonOffsets(): void {
    for (const node of this.host.nodes.values()) {
      this.restorePolygonOffset(node);
    }
    this.host.fallbackNodes.clear();
    this._lastFallbackDepths.clear();
  }
}
