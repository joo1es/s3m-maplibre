/**
 * 驻留预算与淘汰：三条软上限（瓦片数 / 三角形数 / 显存字节）与 make-before-break 裁剪。
 *
 * 从 `S3MTileset.ts` 搬出来（issue #27 的 P3 阶段），行为逐字未变。
 *
 * 为什么单独成模块：这套逻辑的全部输入是「节点表 + 纹理缓存 + 三条上限 + 可见性」，
 * 输出只有「删哪块」。它不产生几何、不发请求、不改 LOD，却占了主类近四分之一的分支，
 * 是读 `update()` 时最容易被带偏的地方。
 *
 * 两条口径必须记住（搬的时候原样保留，不是新加的）：
 *   ① **只在 make-before-break 之后裁**——新瓦片已落地、已决定由谁显示，才删没人依赖的；
 *   ② 允许 `allowUncovered` 只是内存兜底，不能当常规路径，否则「删 → 开洞 → 回补 → 再删」= 闪。
 */
import type { Texture } from 'three';
import type { Stats } from '../core/types.js';
import type { TileNode } from './types.js';

/** `TileBudget` 需要的宿主状态。全是活引用或取值函数，没有控制流回调 */
export interface TileBudgetHost {
  /** 已落地的瓦片 */
  readonly nodes: Map<string, TileNode>;
  /** 在途瓦片（只数个数，参与「预期驻留数」） */
  readonly pending: Set<string>;
  /** 共享纹理缓存 */
  readonly textureCache: Map<string, Texture>;
  /** 瓦片侧统计（淘汰时要准确扣减） */
  readonly stats: Stats;
  /** 子瓦 URL → 父瓦 URL */
  readonly parentOf: Map<string, string>;
  /** 淘汰回调：调用方负责把场景对象与拾取表清掉 */
  onTileRemoved(node: TileNode): void;
  /** 瓦片数软上限（`S3MTileset.maxTiles`，公开可改） */
  maxTiles(): number;
  /** 三角形总数软上限（`Infinity` = 不限制） */
  maxTriangles(): number;
  /** 显存字节软上限（`Infinity` = 不限制） */
  maxMemory(): number;
  /** 请求量硬上限（`maxTiles` + 余量） */
  hardCap(): number;
  /** LOD 过渡策略，影响「正在显示的瓦片算不算不可踢」 */
  lodTransition(): 'binary' | 'incremental';
}

/** 估算单个纹理占用的显存字节数 */
export function estimateTextureBytes(tex: any): number {
  if (!tex) return 0;
  if (Array.isArray(tex.mipmaps) && tex.mipmaps.length > 0) {
    let bytes = 0;
    for (const m of tex.mipmaps) {
      if (m?.data?.byteLength) bytes += m.data.byteLength;
    }
    if (bytes > 0) return bytes;
  }
  const img = tex.image;
  if (!img) return 0;
  if (img.data && typeof img.data.byteLength === 'number') {
    return img.data.byteLength;
  }
  const w = img.width ?? 0;
  const h = img.height ?? 0;
  if (w > 0 && h > 0) {
    const factor = tex.generateMipmaps ? 1.3333333333333333 : 1;
    return Math.round(w * h * 4 * factor);
  }
  return 0;
}

/** 估算三维对象树中包含的几何缓冲字节数 */
export function estimateObjectGeometryBytes(obj: any): number {
  let bytes = 0;
  if (!obj) return 0;
  obj.traverse?.((child: any) => {
    const geo = child.geometry;
    if (geo) {
      if (geo.attributes) {
        for (const attr of Object.values(geo.attributes) as any[]) {
          if (attr?.array?.byteLength) bytes += attr.array.byteLength;
        }
      }
      if (geo.index?.array?.byteLength) {
        bytes += geo.index.array.byteLength;
      }
    }
    if (child.isInstancedMesh) {
      if (child.instanceMatrix?.array?.byteLength) bytes += child.instanceMatrix.array.byteLength;
      if (child.instanceColor?.array?.byteLength) bytes += child.instanceColor.array.byteLength;
    }
  });
  return bytes;
}

/**
 * 淘汰一块瓦片后，驻留统计里应该扣掉的量。
 * 三个字段的口径分别对应 residentTriangles / residentGeometryBytes / residentTextureBytes，
 * 增量维护必须和实算逐字一致：扣多了会少裁（仍超额），扣少了会多裁（画面缺块）。
 */
export interface TileFootprint {
  triangles: number;
  geometryBytes: number;
  textureBytes: number;
}

export class TileBudget {
  /** 纹理 key → 引用计数 */
  private readonly _textureRefs = new Map<string, number>();
  /** 瓦片 URL → 它引用的纹理 key 清单 */
  private readonly _tileTextureKeys = new Map<string, string[]>();

  constructor(private readonly host: TileBudgetHost) {}

  /** 记录瓦片引用的纹理 key，并递增其引用计数 */
  registerTileTextures(url: string, textureKeys: string[]): void {
    this._tileTextureKeys.set(url, textureKeys);
    const node = this.host.nodes.get(url);
    if (node) {
      node.textureKeys = textureKeys;
    }
    for (const key of textureKeys) {
      this._textureRefs.set(key, (this._textureRefs.get(key) ?? 0) + 1);
    }
  }

  /** 淘汰单块瓦片节点并释放专属纹理；返回这一块的占用量，供 trimBudget 增量扣减 */
  evictTileNode(victim: TileNode): TileFootprint {
    // 摘节点之前按 resident* 的同一套口径算好：stats.memory 优先，没有才遍历对象树
    const triangles = victim.stats?.triangles ?? 0;
    const geometryBytes =
      victim.stats && typeof victim.stats.memory === 'number'
        ? victim.stats.memory
        : estimateObjectGeometryBytes(victim.group);
    let textureBytes = 0;

    this.host.nodes.delete(victim.url);
    victim.group?.parent?.remove(victim.group);
    this.host.onTileRemoved(victim);
    this.host.parentOf.delete(victim.url);

    this.host.stats.tiles = Math.max(0, this.host.stats.tiles - 1);
    if (victim.stats) {
      this.host.stats.meshes = Math.max(0, this.host.stats.meshes - (victim.stats.meshes ?? 0));
      this.host.stats.vertices = Math.max(0, this.host.stats.vertices - (victim.stats.vertices ?? 0));
      this.host.stats.triangles = Math.max(0, this.host.stats.triangles - (victim.stats.triangles ?? 0));
    }

    // 释放此瓦片引用的纹理计数；引用归零时从 GPU / 缓存彻底 dispose
    const keys = victim.textureKeys ?? this._tileTextureKeys.get(victim.url) ?? (victim.group?.userData?.textureKeys as string[] | undefined);
    this._tileTextureKeys.delete(victim.url);
    if (keys?.length) {
      for (const key of keys) {
        const ref = (this._textureRefs.get(key) ?? 1) - 1;
        if (ref <= 0) {
          this._textureRefs.delete(key);
          const tex = this.host.textureCache.get(key);
          if (tex) {
            // 只有引用归零、真被 dispose 的那张才算释放；共享纹理还被别的瓦片引用时不扣
            textureBytes += estimateTextureBytes(tex);
            tex.dispose?.();
            this.host.textureCache.delete(key);
          }
        } else {
          this._textureRefs.set(key, ref);
        }
      }
    }
    return { triangles, geometryBytes, textureBytes };
  }

  evictOne(allowUncovered = false, onEvicted?: (fp: TileFootprint) => void): boolean {

    // 只挑安全候选：叶子 → 已被子瓦接手的父瓦。allowUncovered 仅在超出硬上限时开启（内存兜底）
    const victim = this.pickVictim(true, allowUncovered) ?? this.pickVictim(false, allowUncovered);
    if (!victim) return false;

    const parentUrl = victim.parentUrl ?? this.host.parentOf.get(victim.url);
    const childUrls = victim.childUrls ?? (victim.childUrl ? [victim.childUrl] : []);
    const isLeaf = !childUrls.some((u) => u !== victim.url && this.host.nodes.has(u));

    const fp = this.evictTileNode(victim);
    onEvicted?.(fp);

    // 淘汰的是中间层时，把已加载的子孙改挂到它的父级上：
    // 不然它们瞬间"无父"，父级那边还留着指向 victim 的 childUrls，
    // 于是 allChildrenReady 永远为假 —— 既显示不对，也白占预算。
    const kids = childUrls.filter((u) => u !== victim.url && this.host.nodes.has(u));
    if (kids.length) {
      for (const k of kids) {
        const kn = this.host.nodes.get(k);
        if (!kn) continue;
        kn.parentUrl = parentUrl ?? undefined;
        if (parentUrl) this.host.parentOf.set(k, parentUrl);
        else this.host.parentOf.delete(k);
      }
      if (parentUrl) {
        const pn = this.host.nodes.get(parentUrl);
        if (pn) {
          const merged = new Set<string>(pn.childUrls ?? []);
          if (pn.childUrl) merged.add(pn.childUrl);
          merged.delete(victim.url);
          for (const k of kids) merged.add(k);
          pn.childUrls = [...merged];
          pn.childUrl = pn.childUrls[0] ?? null;
        }
      }
    }

    // 删的是最细一级、而上一级又不在内存里 → 把上一级排回去，别让那块地空着
    if (false as boolean && isLeaf && parentUrl && !this.host.nodes.has(parentUrl) && !this.host.pending.has(parentUrl)) {
      // 淘汰阶段不再重新入队父瓦，防止预算满载时引发父子死循环震荡（thrashing loop）
    }
    return true;
  }

  /** 当前驻留瓦片的三角形总数（只算已落地的；在途瓦片还没构建，统计不到） */
  residentTriangles(): number {
    let total = 0;
    for (const node of this.host.nodes.values()) total += node.stats?.triangles ?? 0;
    return total;
  }

  /**
   * 当前数据集驻留的显存与内存总字节数（几何缓冲精确大小 + 纹理显存估计）
   */
  residentMemory(): number {
    return this.residentGeometryBytes() + this.residentTextureBytes();
  }

  residentGeometryBytes(): number {
    let total = 0;
    for (const node of this.host.nodes.values()) {
      if (node.stats && typeof node.stats.memory === 'number') {
        total += node.stats.memory;
      } else if (node.group) {
        total += estimateObjectGeometryBytes(node.group);
      }
    }
    return total;
  }

  residentTextureBytes(): number {
    let total = 0;
    for (const tex of this.host.textureCache.values()) {
      total += estimateTextureBytes(tex);
    }
    return total;
  }

  /**
   * 预算裁剪 —— 必须在可见性算完之后调用（make-before-break）：
   * 新瓦片已经落地、也已经决定由谁负责显示，这时候才把没人依赖的那块裁掉。
   * 只踢「当前不显示」或「位置已被可见子瓦接手」的瓦片；挑不出安全候选时允许
   * 暂时超出预算，等下一帧再裁 —— 宁可多占一会儿内存，也不在画面上开洞。
   *
   * 三条预算并行：瓦片数（`maxTiles`）、三角形总数（`maxTriangles`）与显存字节（`maxMemory`）。
   * `maxTriangles` / `maxMemory` 为 Infinity 时短路，行为与只有瓦片数预算时完全一致。
   * 有限上限下进循环前只统计一次驻留量，之后按淘汰的 footprint 增量扣（#30），
   * 不再每轮重扫全表。
   */
  trimBudget(): boolean {
    let removed = false;
    let guard = 0;
    // 在途的也算进"预期驻留数"：不然一批瓦片同时落地时会先把画面撑爆再疯狂裁
    const overTiles = () => this.host.nodes.size + this.host.pending.size > this.host.maxTiles();
    const overTriangles = () =>
      Number.isFinite(this.host.maxTriangles()) && this.residentTriangles() > this.host.maxTriangles();
    const overMemory = () =>
      Number.isFinite(this.host.maxMemory()) && this.residentMemory() > this.host.maxMemory();
    // 预算生效时可能要连踢多块，迭代上限跟着驻留规模走；不生效时根本进不了循环
    const iterationCap = this.host.nodes.size + this.host.maxTiles() + 16;

    const triangleCap = this.host.maxTriangles();
    const memoryCap = this.host.maxMemory();
    const checkTriangles = Number.isFinite(triangleCap);
    const checkMemory = Number.isFinite(memoryCap);

    // 两条可选上限都没开（默认状态）：沿原路径，一次全表统计都不做
    if (!checkTriangles && !checkMemory) {
      while ((overTiles() || overTriangles() || overMemory()) && guard++ <= iterationCap) {
        if (!this.evictOne(this.host.nodes.size + this.host.pending.size > this.host.hardCap())) break;
        removed = true;
      }
      return removed;
    }

    // 开了有限上限：进循环前各算一次，之后按淘汰的 footprint 增量扣（#30）。
    // 原来每轮 while 条件都重扫全表 —— 三角形 / 几何字节 / 纹理缓存各一趟，
    // 连踢 K 块就是 K 轮三四次 O(N)。上限是运行时函数，一次调用内取快照即可。
    let triangles = checkTriangles ? this.residentTriangles() : 0;
    let memory = checkMemory ? this.residentMemory() : 0;
    const onEvicted = (fp: TileFootprint): void => {
      triangles -= fp.triangles;
      memory -= fp.geometryBytes + fp.textureBytes;
    };

    while (
      (overTiles() ||
        (checkTriangles && triangles > triangleCap) ||
        (checkMemory && memory > memoryCap)) &&
      guard++ <= iterationCap
    ) {
      if (!this.evictOne(this.host.nodes.size + this.host.pending.size > this.host.hardCap(), onEvicted)) break;
      removed = true;
    }
    return removed;
  }

  /**
   * 挑淘汰候选。
   * @param allowRefined false = 只挑叶子；true = 也允许挑「子节点已全部加载」的父瓦片
   * @param allowUncovered true = 允许淘汰「正在显示、但位置还没被子瓦接手」的瓦片。
   *   默认 false：这种瓦片一踢，画面上立刻是一个洞，下一帧调度又会把它请回来补洞，
   *   于是「淘汰 → 开洞 → 回补 → 再淘汰」无限循环 = 屏幕不停闪烁。
   *   只有在实在挑不出安全候选时才允许（否则预算满死锁、相机移到哪都不出图）。
   */
  pickVictim(allowRefined: boolean, allowUncovered = false): TileNode | null {
    let victim: TileNode | null = null;
    for (const node of this.host.nodes.values()) {
      const childUrls = node.childUrls ?? (node.childUrl ? [node.childUrl] : []);
      const refined = childUrls.length > 0 && childUrls.some((u) => u !== node.url && this.host.nodes.has(u));
      if (refined !== allowRefined) continue;
      // 正在显示且没有可见子瓦接手 → 踢了就是洞
      if (!allowUncovered && node.group.visible) {
        if (this.host.lodTransition() === 'incremental') {
          continue;
        }
        const covered = childUrls.some((u) => {
          const c = this.host.nodes.get(u);
          return !!c && c.group.visible;
        });
        if (!covered) continue;
      }
      if (!victim) {
        victim = node;
        continue;
      }
      // 可见性优先于时间戳：没有包围球的瓦片算不出距离，`lastSeen` 天然比别的瓦片旧，
      // 只看时间戳会把「正在显示」的那块先踢掉（开洞 → 回补 → 再踢 = 闪）。
      // 只有不可见的候选分不出来时，才轮到 lastSeen / distance 决定。
      const nodeVisible = node.group.visible ? 1 : 0;
      const victimVisible = victim.group.visible ? 1 : 0;
      if (nodeVisible !== victimVisible) {
        if (nodeVisible < victimVisible) victim = node;
        continue;
      }
      const a = node.lastSeen ?? -1;
      const b = victim.lastSeen ?? -1;
      if (a < b || (a === b && (node.distance ?? 0) > (victim.distance ?? 0))) victim = node;
    }
    return victim;
  }
}
