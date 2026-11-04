/**
 * S3MBLOCK 的图集补齐：`.texblock` 子请求、LRU 缓存、整图替换的一致性验证。
 *
 * 从 `S3MTileset.ts` 搬出来（issue #27 的 P2 阶段），行为逐字未变。
 *
 * 单独成模块的理由：这三百行只关心「像素从哪来、能不能换」，不碰节点表、不碰预算、
 * 不碰 LOD。它需要的全部状态是三个缓存 Map、两个判定结果集合，加两个只读开关
 * （`maxImageCache` / `atlasLod`），通过 `BlockAtlasHost` 注入。
 *
 * 缓存的**实例**仍由 `S3MTileset` 持有并公开（`leafRequestCache` / `externalAtlasCache`
 * 是对外可见字段，单测会直接读写），这里只操作同一份引用。
 */
import {
  composeLeafAtlas,
  expandTexblockRequestNames,
  parseTexblockSegments,
  rebuildBlockTextureState,
  unpackBlockTextures,
} from '../core/S3MBlockParser.js';
import type {
  LeafSprite,
  S3MBlockAtlasImage,
  S3MBlockTile,
  S3MBlockTexture,
  TexblockRequestPlan,
} from '../core/S3MBlockParser.js';
import { evaluateAtlasUpgrade } from '../core/AtlasUpgrade.js';
import type { AtlasPixels } from '../core/AtlasUpgrade.js';
import { authFetch } from '../core/AuthFetch.js';
import type { AuthenticateFn } from '../core/AuthFetch.js';
import type { ParsedTile } from '../core/types.js';
import { dirOf, resolveUrl } from './url.js';

/**
 * `BlockAtlas` 向宿主索取的最小面。
 *
 * 全是「读同一个对象引用 + 两个运行时可变的上限」，没有回调进宿主的方法 ——
 * 这一层是纯搬运，不需要宿主参与控制流。
 */
export interface BlockAtlasHost {
  /** 原始图像 / leaf 记录缓存容量上限（`S3MTileset.maxImageCache`，运行时可调） */
  imageCacheLimit(): number;
  /** 鉴权适配函数（`S3MTileset.authenticate`） */
  readonly authenticate: AuthenticateFn | undefined;
  /** 块 URL → 该文件里的全部 LOD 组 */
  readonly externalAtlasCache: Map<string, S3MBlockAtlasImage | null>;
  /** 子请求名 → 响应记录（null = 已判定不可用） */
  readonly leafRequestCache: Map<string, S3MBlockAtlasImage[] | null>;
  /** 真正被高清版顶替掉的图集 id */
  readonly atlasUpgraded: Set<string>;
  /** 拿到高清版但判定不通过 → 原因 */
  readonly atlasUpgradeSkipped: Map<string, string>;
}

export class BlockAtlas {
  /** 进行中的 leaf 请求（stem → Promise），跨瓦片并发时同名只发一次 */
  private readonly _leafPending = new Map<string, Promise<void>>();

  constructor(private readonly host: BlockAtlasHost) {}

  /** 存入外部图集（带 LRU 容量上限） */
  putExternalAtlas(id: string, img: S3MBlockAtlasImage | null): void {
    if (this.host.externalAtlasCache.size >= this.host.imageCacheLimit() && !this.host.externalAtlasCache.has(id)) {
      const oldestKey = this.host.externalAtlasCache.keys().next().value;
      if (oldestKey !== undefined) this.host.externalAtlasCache.delete(oldestKey);
    }
    Map.prototype.set.call(this.host.externalAtlasCache, id, img);
  }

  /** 读取外部图集 */
  getExternalAtlas(id: string): S3MBlockAtlasImage | null | undefined {
    return this.host.externalAtlasCache.get(id);
  }

  /** 存入 leaf 记录段（带 LRU 容量上限） */
  putLeafRecords(name: string, recs: S3MBlockAtlasImage[] | null): void {
    if (this.host.leafRequestCache.size >= this.host.imageCacheLimit() && !this.host.leafRequestCache.has(name)) {
      const oldestKey = this.host.leafRequestCache.keys().next().value;
      if (oldestKey !== undefined) this.host.leafRequestCache.delete(oldestKey);
    }
    Map.prototype.set.call(this.host.leafRequestCache, name, recs);
  }

  /** 读取 leaf 记录段 */
  getLeafRecords(name: string): S3MBlockAtlasImage[] | null | undefined {
    return this.host.leafRequestCache.get(name);
  }

  /**
   * 补齐「图集像素不在块文件里」的那一半 —— 官方 `requestSubTextures` 的等价物。
   *
   * 根瓦片（如 6.s3mblock）的图集是内嵌的（isSaveData=1）；但**子瓦片**（6_00 / 6_01）
   * 的图集段只有元信息：`data = null` + `requestNames`，像素在同目录的 `.texblock` 里。
   * 不补这一步的后果不是「糊一点」，而是子瓦片整块无贴图：`tile.textures` 里根本没有
   * 这条纹理，材质拿不到 map，建筑变成纯白几何——精细 LOD 一旦真的加载进来就会显露。
   *
   * ★ 只认 requestNames。`childTexNames` 是**下一级 LOD 的图集指针**（官方 `_ancestorTexture`
   *   用它继承 batchTable 的 rect），它有自己的 subTexInfos：同一个精灵在父级叫 `1460_3`
   *   96x64、子级叫 `1460_2` 192x128，排布也不一样。拿父级的 rect 去套子级像素必然错位 ——
   *   上一版就是这么把画面搞坏的。官方从不拿它换像素，那个 LOD 的瓦片自己会加载。
   *
   * requestNames 展开（见 `expandTexblockRequestNames`，逐字对应官方 `_subRequestNames`）：
   *
   * 1. **整图**（`['-704919438.texblock']`，单条记录 = 整张图集）→ 用 `evaluateAtlasUpgrade`
   *    验证后整体替换；根块自带缩略图必须验证过才能换，子瓦片（无基准）至少要求长宽比一致。
   * 2. **leaf 多精灵**（`['Tex_0.texblock#000009…', 'Tile_6_000000.texblock']`，官方 isLeaf）→
   *    图集本身没有像素，只有 `subTexInfos` 里每块一个精灵 rect。按 subName 把精灵贴回
   *    各 rect（`composeLeafAtlas`），组合出整张自上而下 RGBA 画布（compressType=0 /
   *    pixelFormat=28 / flipY=false）。精灵自带「左 2/3 base + 右 1/3 内联 mip 金字塔」，
   *    与 StyleMaterial 的 `s3mAtlasLod` 2/3 采样公式直接配套，rect 一个像素都不用改。
   *
   * 请求方式：pack 组按官方 `Uci` 合并成
   * `GET Tex_0_<code>.texblock?extratiles=Tex_0_000;Tex_0_009;…`（extratiles **去扩展名**、
   * 段序 = 请求序，kMi 取第 i 段）；`Tile_*` 是普通多记录容器，整文件解析后按记录名分发。
   *
   * 不补/补失败时保持缩略图（或无贴图），由上层照常渲染几何，绝不清空已有纹理表。
   */
  async fillExternalAtlases(tile: ParsedTile, url: string): Promise<void> {
    const blockTile = tile as ParsedTile & { texturePackage?: Record<string, S3MBlockTexture> };
    const tp = blockTile.texturePackage;
    if (!tp) return;

    // 拼图块：先退回原始图集。拼图是把多张图集重排进一张大图，
    // 换高清图必须在拼图**之前**做，否则 rect 和像素两套排布对不上。
    const wasPacked = unpackBlockTextures(blockTile as S3MBlockTile);
    /** 只要像素被动过，纹理表 / rect 就必须重算 —— 否则子瓦片会整块白膜 */
    let changed = false;

    // ① 展开 requestNames，跨图集汇总本块还缺哪些子请求（同名只拉一次）
    const plans = new Map<string, { tex: S3MBlockTexture; plan: TexblockRequestPlan }>();
    const packMiss = new Map<string, string[]>();
    const plainMiss: string[] = [];
    for (const [id, tex] of Object.entries(tp)) {
      const plan = expandTexblockRequestNames(tex.requestNames);
      if (!plan.names.length) continue; // 只挂了 childTexNames（根瓦片形态）→ 一个请求都不发
      plans.set(id, { tex, plan });
      for (const [base, group] of plan.packGroups) {
        const miss = group.filter((n) => !this.host.leafRequestCache.has(n));
        if (!miss.length) continue;
        const acc = packMiss.get(base) ?? [];
        for (const n of miss) if (!acc.includes(n)) acc.push(n);
        packMiss.set(base, acc);
      }
      for (const n of plan.plain) {
        if (!this.host.leafRequestCache.has(n) && !plainMiss.includes(n)) plainMiss.push(n);
      }
    }

    // ② 拉取（先全部 await，再动图集状态；跨瓦片并发时同名请求共享同一个 Promise）
    const pending: Promise<void>[] = [];
    for (const [base, names] of packMiss) {
      let groupFetch: Promise<void> | null = null;
      const start = () => (groupFetch ??= this.fetchLeafPack(url, base, names));
      for (const n of names) pending.push(this.ensureLeafFetch(n, start));
    }
    for (const n of plainMiss) pending.push(this.ensureLeafFetch(n, () => this.fetchLeafFile(url, n)));
    if (pending.length) await Promise.all(pending);

    // ③ 逐图集：leaf 组合优先；没匹配上任何精灵就退回「整图替换 + 验证」
    for (const [id, { tex, plan }] of plans) {
      const sprites = new Map<string, LeafSprite>();
      for (const n of plan.names) {
        const recs = this.host.leafRequestCache.get(n);
        if (!recs) continue;
        for (const r of recs) sprites.set(r.id, { source: n, image: r });
      }

      const composed = composeLeafAtlas(tex, sprites);
      if (composed) {
        const t = tex as S3MBlockTexture & { composed?: boolean; leafSig?: string };
        t.composed = true;
        t.leafSig = composed.sig;
        t.flipY = false; // 画布自上而下（语义见 S3MBlockTexture.flipY 注释）
        tex.data = composed.data;
        tex.compressType = 0;
        tex.pixelFormat = 28; // RGBA
        tex.width = composed.width;
        tex.height = composed.height;
        tex.rectScale = 1; // 画布与 subTexInfos 同一像素空间，rect 原样、不缩放
        this.host.atlasUpgraded.add(id);
        changed = true;
        if (composed.missing.length || composed.mismatched.length) {
          // 官方对缺失精灵同样跳过（留透明）；尺寸不一致照样贴。都只告警，不整块拒收。
          console.warn('[s3m] leaf 图集部分精灵异常：', id, {
            missing: composed.missing,
            mismatched: composed.mismatched,
          });
        }
        continue;
      }

      // —— 整图替换回退（官方 isLeaf=false 的路径）——
      // 子瓦片的图集段只有元信息（data = null），没有可比的基准，只能直接采用；
      // 根块自带缩略图，必须验证过才能换。
      const hasBaseline = !!tex.data;
      const accept = (img: S3MBlockAtlasImage): boolean => {
        if (!hasBaseline) {
          // 没有缩略图可比，但至少要挡住「根本不是同一张图集」的情况：
          // 长宽比必须一致，否则 subTexInfos 的 rect 一贴就错位。
          const loAsp = tex.width / tex.height;
          const hiAsp = img.width / img.height;
          if (!(Math.abs(hiAsp / loAsp - 1) <= 0.02)) {
            this.host.atlasUpgradeSkipped.set(id, `aspect(no-baseline) ${tex.width}x${tex.height} vs ${img.width}x${img.height}`);
            return false;
          }
          return true;
        }
        const v = evaluateAtlasUpgrade(tex as unknown as AtlasPixels, img);
        if (v.ok) return true;
        this.host.atlasUpgradeSkipped.set(
          id,
          `${v.reason} aspectΔ=${(v.aspectDelta * 100).toFixed(1)}% scale=${v.scale} err=${Number.isNaN(v.meanAbsError) ? 'n/a' : v.meanAbsError.toFixed(1)}`
        );
        return false;
      };

      // ★ 不能无条件换图。实测 3D-OlympicGreen/Building 两块共 8 张图集里，
      //   只有 2 张的 child 是「同一套排布的等比放大」（长宽比 0.0%、下采样色差 8.5/11.2），
      //   其余是**重新排版**过的另一张图（长宽比偏差 5.6%~200%，色差 43~86）。
      //   直接套用 subTexInfos 会整张错位，比不换更糟 —— 所以换之前先验一遍。
      const apply = (img: S3MBlockAtlasImage) => {
        const t = tex as S3MBlockTexture & { composed?: boolean; leafSig?: string };
        // 整图是 DXT 原图（底朝上），清掉 leaf 组合状态
        t.composed = false;
        t.leafSig = undefined;
        t.flipY = true;
        // 覆盖解析阶段按内嵌缩略图填好的那份；判定不通过时不会走到这里，原样保留
        tex.data = img.data;
        tex.compressType = img.compressType;
        tex.pixelFormat = img.pixelFormat;
        // rect 是归一化的，但 subTexInfos 的 offset/width 是像素，必须按倍数换算
        tex.rectScale = tex.width > 0 ? img.width / tex.width : 1;
        tex.width = img.width || tex.width;
        tex.height = img.height || tex.height;
        this.host.atlasUpgraded.add(id);
        changed = true;
      };

      // 候选只可能是普通请求名的第一条记录；Tex pack 段是子精灵，不是整图（与旧实现一致）。
      let candidate = this.host.externalAtlasCache.get(id);
      if (candidate === null) continue; // 已判定不可用
      if (candidate === undefined) {
        candidate = null;
        for (const n of plan.plain) {
          const recs = this.host.leafRequestCache.get(n);
          if (recs?.length) {
            candidate = recs[0]!;
            break;
          }
        }
        this.putExternalAtlas(id, candidate);
      }
      if (candidate) {
        if (accept(candidate)) apply(candidate);
      } else if (!this.host.atlasUpgradeSkipped.has(id)) {
        this.host.atlasUpgradeSkipped.set(id, 'no usable external image（请求失败或只拿到子精灵）');
      }
    }

    // 像素定下来了，重新拼图并重算 rect / 纹理表（两者必须一起重算）。
    //
    // ★ 这里必须用 `wasPacked || changed`，不能只看 wasPacked：
    //   **子瓦片**的图集是 `data = null` + `requestNames`，根本没参与拼图（wasPacked=false），
    //   像素是刚从 .texblock 拉回来的。只看 wasPacked 的后果是 `tile.textures` 永远是空的
    //   → 近看整片白膜；同时 atlasRects 也没按 rectScale 重算 → 远处马赛克噪点。
    if (wasPacked || changed) rebuildBlockTextureState(blockTile as S3MBlockTile);
  }

  /** 同名子请求去重：命中缓存立即返回；否则共享进行中的 Promise（跨瓦片并发只发一次） */
  ensureLeafFetch(stem: string, start: () => Promise<void>): Promise<void> {
    if (this.host.leafRequestCache.has(stem)) return Promise.resolve();
    const inflight = this._leafPending.get(stem);
    if (inflight) return inflight;
    const p = start().finally(() => this._leafPending.delete(stem));
    this._leafPending.set(stem, p);
    return p;
  }

  /**
   * pack 组请求 —— 官方 `Uci`：URL = 组内第一个请求的 URL，追加
   * `extratiles=<全组 quadKey，去扩展名，';' 连接>`；响应是 kMi pack，段序 = extratiles 序。
   *
   * 实测服务端两种写法都 200，但带 `.texblock` 的 extratiles 会解出 recs=4 的错内容，
   * 所以必须用**去扩展名**的 quadKey。
   */
  async fetchLeafPack(baseUrl: string, base: string, names: string[]): Promise<void> {
    const u = resolveUrl(dirOf(baseUrl), `${names[0]}.texblock?extratiles=${names.join(';')}`);
    try {
      if (!u) throw new Error('无法拼出 URL');
      const res = await authFetch(u, this.host.authenticate, 'texblock');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const segments = await parseTexblockSegments(await res.arrayBuffer());
      if (segments.length !== names.length) {
        throw new Error(`pack 段数 ${segments.length} ≠ 请求名 ${names.length}`);
      }
      names.forEach((n, i) => this.putLeafRecords(n, segments[i]!));
    } catch (e) {
      console.warn('[s3m] leaf pack 请求失败：', u, e);
      for (const n of names) if (!this.host.leafRequestCache.has(n)) this.putLeafRecords(n, null);
    }
  }

  /** 普通 `.texblock`（整图或多记录容器）：文件里的全部记录都归这个子请求名 */
  async fetchLeafFile(baseUrl: string, stem: string): Promise<void> {
    const u = resolveUrl(dirOf(baseUrl), `${stem}.texblock`);
    try {
      if (!u) throw new Error('无法拼出 URL');
      const res = await authFetch(u, this.host.authenticate, 'texblock');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const records = (await parseTexblockSegments(await res.arrayBuffer())).flat();
      this.putLeafRecords(stem, records);
    } catch (e) {
      console.warn('[s3m] leaf texblock 请求失败：', u, e);
      if (!this.host.leafRequestCache.has(stem)) this.putLeafRecords(stem, null);
    }
  }

  /**
   * @deprecated 已由 `fillExternalAtlases` 覆盖，保留仅为兼容 `atlasLod` 选项。
   *
   * 旧实现「像素数更大就整体换图」，正是被证伪的那个前提：实测 8 张图集里只有 2 张的
   * child 是等比放大，其余是重新排版过的另一张图，硬换会整张错位。
   * 现在换图统一走 `fillExternalAtlases` + `evaluateAtlasUpgrade` 的验证流程。
   */
  async upgradeAtlasLod(_tile: ParsedTile, _url: string): Promise<void> {
    return;
  }
}
