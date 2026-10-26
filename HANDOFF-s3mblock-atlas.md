# S3MBLOCK 图集渲染对齐官方 —— 交接文档

> 生成时间：2026-10-25（Asia/Shanghai）
> 任务：`s3m-maplibre` 的 S3MBLOCK（TextureSharing）贴图渲染对齐 SuperMap iClient3D 官方效果
> 目标验收基准：OlympicGreen Building 图层 SMID 205，与官方同机位并排一致

---

## ★ 第十三轮（2026-10-26）：读官方代码，第十二轮的前提整条是错的

第十二轮我假设「`childTexNames` 指向同一张图集的高清版」，还为此造了一个验证门禁。
**官方包里 `childTexNames` 一次都没出现**（`grep -c childTexNames SuperMap3D.js` = 0）。
它是我们解析器给「派生图集链」起的名字，官方叫 `_ancestorTexture` / `ancestorMap`。

### 官方原文（`SuperMap3D.js`，`lM.prototype.createTexture`）

```js
var E = o._textureLod;                      // layer 级开关
this.isRoot = n && E;
if (!n || !E) {                             // 非根 或 没开 textureLod
  this._subRequestNames = [];
  for (var D = 0; D < h.requestNames.length; D++) {
    var G = h.requestNames[D], q = yke(G);  // yke = 取 '.' 之前的部分
    if (q.split('_')[0] === 'Tex') {        // ★ Tex_x.texblock#<三位数字串> → 展开成多个名字
      var ie = G.split('#'), re = yke(ie[0]);
      if (ie.length > 1) for (var le = ie[1], he = 0; he < le.length; he += 3) {
        this._subRequestNames.push(re + '_' + le.substring(he, he + 3));
      }
    } else this._subRequestNames.push(q);
  }
}
return this.isLeaf = (!n || !E) && !(h.requestNames.length === 1 && h.requestNames[0] === a);
```

`requestSubTextures` 里两条分支：

```js
if (S >= 0) { var W = h[S]; R = W.offsetX; T = W.offsetY; }   // S = 图像名在 _subTextureNames 里的下标
this.isLeaf
  ? s.enqueue({ texture: E, subTextureInfo: { xOffset: R, yOffset: T, width: D, height: J, arrayBufferView: ... } })
  : E.arrayBufferView = C.arrayBufferView;                     // 整张替换
```

结论：

1. **像素只从 `requestNames` 来**。`childTexNames` 是**下一级 LOD 的图集指针**，
   官方只用它继承 batchTable 的 rect，从不拿它换像素。
2. `requestNames === [自身 id]` → `isLeaf = false` → **整张替换**（同一张图集，rect 照旧）。
3. 否则是 leaf → 拉回来的是**一堆小精灵**，按 `subTexInfos[i].offset` 逐个贴进图集。
4. `Tex_x.texblock#000009015016...` 不是文件名，是「`Tex_x.texblock` 里按名字取这些图」的清单。

### 数据完全对得上

`subName` 的后缀就是 LOD 级别，父级 `childTexNames` 指向的正是子级那张图集：

| 文件 | 图集 id | 精灵 | 尺寸 |
|---|---|---|---|
| `6.s3mblock` | `427494225` | `1460_**3**` | 96×64 |
| `6_00.s3mblock` | `-704919438` | `1460_**2**` | 192×128 |
| `6_0000.s3mblock` | `-682963945` | `1460_**1**` | 192×128 |
| `6_000000.s3mblock` | `-1710530621` | `1460_**0**` | 768×512 |

`427494225` 的 `childTexNames = ['-704919438.texblock']` —— 就是 `6_00` 里那张。
**它们是同一精灵在不同 LOD 的不同排布**，所以整张替换必然错位。这也解释了第十二轮那张
「长宽比偏差 5.6%~200%、色差 43~86」的表：我一直在拿**不同 LOD 的图集**互相比。

### 本轮改动

1. `_fillExternalAtlases` **只认 `requestNames`**，`childTexNames` 彻底退出像素路径。
2. `Tex_*#...` 这类多精灵容器名**不再当 URL 请求**（以前会把 `#` 后面的当片段，
   请求到别的文件/404 → 整块白膜），先记进 `atlasUpgradeSkipped`。
3. 没有缩略图可比时（`data = null` 的子瓦片）也要过一道**长宽比**检查，挡住「根本不是同一张」。
4. 新增回归测试：`childTexNames` 只挂不用时，**一个请求都不该发、图集一个字节都不该变**。

### 还没做的（这就是下一轮的正题）

**leaf 模式没实现**。最细一级（`6_000000`）的图集是 `data = null` +
`requestNames = ['Tex_0.texblock#...', 'Tile_6_000000.texblock']`，官方会把 `#` 展开成
`Tex_0_000` / `Tex_0_009` / … 再逐个贴进 1548×1536 的画布。
要做这一步得先解决两件事：

1. `Tex_0.texblock` 是**多图容器**（实测 275 张），容器布局与单图版不同
   （没有 name 字符串，`count` 后直接是尺寸表）。我们现在的
   `parseS3MBlockTextureFile` 只认单图版。
2. 每张图要能按**名字**取（`Tex_0_000`），而我们的解析器没有读内层记录的名字。

在那之前，最细 LOD 的图集会走 `Tile_6_000000.texblock`（单图版，能解析）——
如果它也是整张图集，那条路应该能通；否则那一级仍然无贴图。

---

## ★ 第十二轮（2026-10-26）：高清 `.texblock` 接入 —— 但「换图不换 rect」这个前提是错的

### 先证伪，再动手

原计划是把 `childTexNames` 指向的高清 `.texblock` 直接顶替块内嵌缩略图。动手前先用数据验了
那句注释里的前提（"同一套排布、只是分辨率更高"），结果**只有 2/8 张图集成立**：

| 缩略图 | 高清 | 长宽比偏差 | 下采样后色差 | 结论 |
|---|---|---|---|---|
| 96×64 | 192×128 | 0.0% | **8.5** | 真·高清版（2 倍整数等比） |
| 96×64 | 192×128 | 0.0% | **11.2** | 同上 |
| 108×192 | 204×384 | −5.6% | 43.3 | 重新排版过的另一张图 |
| 120×184 | 300×304 | +51.3% | 83.3 | 同上 |
| 84×128 | 180×240 | +14.3% | 60.2 | 同上 |
| 132×192 | 120×144 | +21.2% | 86.4 | 同上 |
| 96×96 | 192×248 | −22.6% | 83.4 | 同上 |
| 96×192 | 192×128 | +200% | 63.4 | 根本不是同一张 |

补充证据：
- `subTexInfos` 的 `offset+size` 覆盖范围**正好等于缩略图尺寸**（108×192 / 120×184 / 96×64 / 84×128），
  说明这些 offset 是**缩略图坐标系**，不是高清坐标系。
- `.texblock` 解压后**没有**尾部排布表（`剩余=0`），里面只有一条图像记录。
- 试过第三假设「高清 = 缩略图按整数 s 倍放大后被裁剪」，误差仍是 37~58，不成立。

所以**无条件换图会整张错位，比不换更糟**。这也解释了为什么 `_fillExternalAtlases` 当初会写
`if (packed) continue` —— 那是绕开问题，不是解决。

### 本轮改动

1. **新增 `core/AtlasUpgrade.ts`** —— 可判定的替换门禁：
   - 长宽比偏差 ≤ 2%（`DEFAULT_MAX_ASPECT_DELTA`）
   - 两轴必须是**同一个整数倍**（`scale === scaleY && Number.isInteger(scale)`）——
     否则 `subTexInfos` 的像素 offset 没法精确换算
   - 把高清图面积平均缩到缩略图尺寸后，不透明区域 RGB 平均绝对误差 ≤ 24（`DEFAULT_MAX_MEAN_ERROR`）
   - 缩略图全透明 / 解不出来 → 一律不换（宁可不换，不能换错）
2. **`core/S3MBlockParser.ts`** 拆出三个可复用步骤，并支持「换图后重拼」：
   - `packTexturePackage` / `buildTextureTable` / `buildAtlasRects(…, packed)` 三段分离
   - `unpackBlockTextures(tile)` —— 退回原始图集；**同时清空** `textures` / `atlasRects`
     （它们描述拼图坐标系，此刻已不自洽。忘了重拼要立刻表现为无贴图，而不是画面错位）
   - `rebuildBlockTextureState(tile)` —— 拼图 + 重算 rect + 重建纹理表，三者必须一起
   - `origin.data` 现在会保留原始像素（没有它就退不回去）
3. **新增 `S3MBlockTexture.rectScale`** —— `subTexInfos` 的像素坐标相对当前像素的倍数。
   换 2 倍高清图后置 2，`buildAtlasRects` 里乘上去，**归一化 rect 保持不变**。
   （rect 是归一化的所以天然不变，但 offset/width 是像素，不换算会落在一半的位置上，
   平铺时逐格漂移。）
4. **`tileset/S3MTileset.ts`**：
   - `_fillExternalAtlases` 改为「先 `unpack` → 逐张 fetch + 验证 → 采用/保留 → `rebuild`」
   - `data === null` 的子瓦片（`requestNames` 那条路）没有基准可比，仍无条件采用
   - 新增 `atlasUpgraded` / `atlasUpgradeSkipped`（带原因）便于排查「这块为什么还是糊的」
   - `_upgradeAtlasLod` 标为 `@deprecated` 并清空实现：它「像素数更大就换」的判据正是被证伪的那条

### 单元测试（都做过变异验证）

`tests/unit/atlas-upgrade.test.ts`（10 条）：
- `boxDownsample` 必须是**面积平均**（2×2 黑白棋盘 → 中灰 127，不能取某一边）
- 等比 2 倍 → 通过且误差 < 2
- 长宽比不一致 → `aspect`
- 长宽比一致但内容错位 → `content`（**注意**：基准图不能用棋盘格，它是周期的，
  平移偶数像素会「看起来一样」，第一版测试就栽在这）
- 高清并不更大 / 全透明 / 噪声 / 解不出来的格式 → 全部拒绝且不崩
- 透明区域不参与比较

`tests/unit/s3mblock.test.ts` 新增 4 条：
- 拼图块：`textures[id]` 必须就是 `texturePackage[id]` 那张（第十一轮事故的核心不变量）
- 解拼图后 `textures` / `atlasRects` 必须被清空
- 解拼图 → 重拼必须**逐位还原**（rect / 纹理表 / packKey 都不漂）
- 换成整数倍高清图后归一化 rect 完全不变（并反证：忽略 `rectScale` 会缩到一半）

变异验证：unpack 不清状态 / 门禁恒通过 / 忽略 `rectScale` → 三条各自对应的测试都会红。

### 端到端离线验证

`render.mts` 加了 `HIRES=1`，走**和 App 完全相同**的路径（解拼图 → 验证 → 采用 → 重拼）：

```bash
HIRES=1 HI_DIR=_tmp/algo/hr   bun run _tmp/algo/render.mts _tmp/algo/6.s3mblock out.png 900 35 18
HIRES=1 HI_DIR=_tmp/algo/hr41 bun run _tmp/algo/render.mts _tmp/algo/b41.s3mblock out.png 620 40 18
```

结果：6.s3mblock 拼图从 408×192 变 504×192（1 张被采用），画面 1.48% 像素变化、无破坏；
b41 从 408×192 变 516×192（1 张被采用），但那张绑在 `texUnitIndex=1`（烘焙图），
离线渲染器只画 base，所以像素差 0 —— **不是 bug**。

### 诚实的结论

这轮把「高清图」这条路**做对了，但没有把画面变清晰多少**：这块数据里 8 张图集只有 2 张的
child 是真正的等比高清版，其余是重新排版的另一张图，硬换必错。
真正能让画面更清晰的是**换数据集/换服务端 LOD**，不是继续在图集上做文章。

### 本轮踩的坑（一定要记住）

改完第一版就出事了：**远看马赛克噪点、近看白膜**。

原因是我把 `apply()` 里「顺手写 `tile.textures[id]`」那句删了，改成「只有拼图块（`wasPacked`）
才 `rebuildBlockTextureState`」。但**子瓦片的图集是 `data = null` + `requestNames`，压根没参与拼图**
（`wasPacked = false`），像素是刚拉回来的 —— 于是：

- `tile.textures` 永远是空的 → 材质拿不到 map → **近看整片白膜**
- `atlasRects` 也没按 `rectScale` 重算 → 远处**马赛克噪点**

修法只有一行，但条件是关键：

```ts
if (wasPacked || changed) rebuildBlockTextureState(tile);   // changed = 任何一次 apply
```

`tests/unit/atlas-fill.test.ts` 专门锁这条（3 条，直接构造 `.texblock` 字节流 + stub `fetch`
跑真实的 `_fillExternalAtlases`，不是测一个复制的条件）。把 `|| changed` 去掉，前两条立刻红。

教训：**「像素变了」和「拼图变了」是两件事，但都要求重算纹理表 + rect**。
只认拼图状态会漏掉所有 `data = null` 的子瓦片，而它们正是近距离看到的那些。

### 还没做的

1. 实机复验（仍然没有浏览器截图）。这轮改动全部有单测 + 离线端到端，但「与官方同机位并排一致」
   仍未确认。
2. 高清版的**烘焙图**（`texUnitIndex=1`）路径：`render.mts` 只画 base，离线验证覆盖不到。
   实机若发现烘焙图变花，先看 `atlasUpgradeSkipped` 里有没有对应 id。
3. `groupDim`（`darr`）用的是未缩放的 `sub.width/height`；目前着色器不读它，留着仅作排查。

---

## ★ 第十一轮（2026-10-26）：第十轮算法是对的，但**喂给它的纹理不是同一张**

**先读这一节。** 第十轮把 UV 算法对齐了官方，实机却是满屏彩色雪花 —— 不是算法错，
是 `aAtlasRect` 和 `map` 来自两个不同的坐标系。

### 真凶：`textures` 在拼图**之前**就建好了

`parseS3MBlockGroups` 里原来的顺序是：

```ts
const textures = {...};                 // ← 从 texturePackage 抄一份
const atlasRects = buildAtlasRects(...); // ← 拼图发生在这里面（packAtlases）
```

`buildAtlasRects` 会把一个块里的多张图集用 `packAtlases` 拼成一张大图，并把
`texturePackage` 的 `width/height/data` **原地改写成拼图结果**。而 `textures` 是抄在
拼图之前的，于是：

| | 尺寸 | 内容 | 坐标系 |
|---|---|---|---|
| `atlasRects`（喂 `aAtlasRect`） | 408×192 | — | 拼图坐标系 |
| `textures`（喂 `map` / `uAtlasDim`） | 108×192 | 块内嵌缩略图 DXT5 | 单张图集坐标系 |

渲染侧 `uAtlasDim` 取的是 `map.image.width`，所以 `texSize = rect.zw × 108 × 2/3`
只有真实值的 1/4：

- `maxMip = log2(min(w·2/3, h))` 从 `log2(64)=6` 掉到 `log2(16.9)=4`
- `dFdx(uv · texSize)` 同比变小 → `mip` 几乎恒为 0 → 内联金字塔**根本没被用上**
- 每像素落到随机纹素 → 彩色雪花；越远越糟（正是「不同视距观感不一致」）

同时 `translate = rect.xy` 是拼图坐标，采的却是单张图集 —— 连贴图内容都是错的
（离线复现：整面墙变成橙红黄的别的楼）。这解释了为什么第十轮「算法改对了、画面没变」。

### 复现方式（不需要浏览器）

`render.mts` 加了 `MODE=app`：用 `tile.textures[id]` 走 `decodeDXT + flipRows + flipY=false`
那条路（即 App 真实拿到的纹理），`atlasDim` 用它自己的尺寸。跑出来就是实机那个样子。

```bash
MODE=app bun run _tmp/algo/render.mts _tmp/algo/6.s3mblock out.png 900 35 18   # 修复前
       bun run _tmp/algo/render.mts _tmp/algo/6.s3mblock out.png 900 35 18   # 修复后
```

### 本轮改动

1. `core/S3MBlockParser.ts`
   - `buildAtlasRects` 调到建 `textures` **之前**，`textures` 抄的是拼图后的结果。
   - 拼图块写 `packed: true` / `flipY: false`（拼图自上而下，v=0 就是首行，不能再翻）。
   - 给每张拼图打 `packKey = "408x192#id1,id2,…"`（见下）。
2. `core/types.ts` — `S3MTexture` 增加 `packed?` / `packKey?`。
3. `render/TextureFactory.ts` — 新增 `isAtlas = packed || flipY`，统一走
   `configureAtlas`（`generateMipmaps=false` + `LinearFilter` + `ClampToEdge`）。
   以前这个判断只看 `flipY`，拼图纹理（flipY=false）会被当成普通纹理开 GPU mip。
4. `render/GeometryBuilder.ts` — 纹理缓存 key 从 `atlasId` 改成 `atlasId#packKey`。
   拼图是**逐块**做的，同一个 atlas id 在 LOD 兄弟块里落位可能不同；
   `options.textureCache` 是跨瓦片共享的，只按 id 复用会把别块的排布拿过来 → 整块贴错图。
5. `tests/unit/s3mblock.test.ts` — 新增两条不变量（已做变异验证：把顺序改回去必须红）：
   - 拼图块：`textures[id]` 的尺寸/像素必须就是 `texturePackage[id]` 那张，且 `packed=true`、`flipY=false`
   - 未拼图的块仍走「原始 DXT 图集 + 翻行」

### 关于「不同视距观感要一致」

修完之后剩下的差距分两层，别混在一起：

- **已消除**：`texSize` 差 4 倍导致的 mip 恒 0。这一层是**距离越远越糟**的元凶。
- **仍存在（可接受）**：精灵本身很小（12×8），`maxMip - 1.62` 的官方钳位让它最多只能
  缩小 2.6 倍；一像素跨十几格 uv 时仍会有轻微噪点。这是官方公式的固有上限
  （内联金字塔最深层只有 `w/3 × h/8`，压不到 1×1），**不是 bug，不要为此改钳位**。
  离线扫过 900/540/360/240 px：540 以上（≈ 你的截图那个比例）干净，240 才开始有噪点。

### 已知未做（下一步优先级从高到低）

1. **高清 `.texblock` 仍然没进拼图块**。`_fillExternalAtlases` 第一行就是
   `if (packed) continue`，所以拼图块一直用块内嵌缩略图（108×192），
   官方用的是 `childTexNames` 指向的清晰版（300×304 量级）。
   要做对必须**先拉高清、再拼图**：把 `packAtlas` 从 `buildAtlasRects` 里拆出来，
   在 `_fillExternalAtlases` 之后重跑一遍（`origin` 里要留 raw data 才能重拼）。
   **风险**：高清版与缩略图的长宽比不一致（120×184 vs 300×304），
   「换图不换归一化 rect」这个假设没验过，动之前先用 `sheet.mts` 对一遍 alpha 轮廓。
2. 实机复验。本轮改动全部有离线对照与单测，但「与官方同机位并排一致」仍未截图确认。

---

## ★ 第十轮（2026-10-26）：找到真凶 —— 子区域右 1/3 是内联 mip 金字塔，§4 的撤回是错的

**先读这一节，它推翻了 §4 里的一条关键结论。**

### 证据（全部离线，不需要浏览器）

把官方 `SuperMap3D.js` 里的 768 段内嵌着色器解密（`_sd()` 是 base64 + XOR "S3M"）后，
`getTextureParameter` 里那句 `width *= 2.0/3.0` 和 `czm_getTexColorForS3M` 的 mip 平移量
合起来**精确对应一种图集布局**：

```
mip0 只占左 2/3（宽 = rect.w × 2/3，高 = rect.h）
右 1/3 是从上往下堆的内联 mip 金字塔：
  mip1 在 (x + 2w/3, y)         尺寸 w/3   × h/2
  mip2 在 (x + 2w/3, y + h/2)   尺寸 w/6   × h/4
  mip3 在 (x + 2w/3, y + 3h/4)  尺寸 w/12  × h/8 …
  整列总高恰好 = h
```
`translate.y = y + scale.y·(2^(m-1)-1)/2^(m-1)` 的 m=1/2/3 分别落在 `y / y+h/2 / y+3h/4`，
与上面完全吻合。

数值实证（14 个块、691 条子纹理）：

```
「右侧 1/3 ≈ 左 2/3 的 1/2 下采样」成立 668 条（96.7%）
平均误差：down2(base) vs 右侧1/3 = 6.8 ；base vs 右侧1/3 = 27.3
```

`92_3`（24×16）放大 12 倍可以直接看到：左边 4 个蓝窗格，右边 1/3 是同样 4 个窗格的缩小版。
按 mip 0/1/2/3 各采一遍，得到的是同一幅窗格的 1/1、1/2、1/4、1/8 —— 逐级变糊，不会串到邻格。

### §4 那条撤回为什么错了

§4 写「图集子区域自带内联 mip 链（base 占 2/3 宽）」→ **无依据**，理由是
「(48,0,24,16) 右边紧挨的是另一张子纹理 1130_3」。

真相：**缩略图本身就是同一幅图案的缩小版，肉眼看就是「图案的延续」**。
把它和「左 2/3 做 1/2 下采样」做数值比对就能分开（误差 6.8 vs 27.3），肉眼分不开。

去掉 2/3 的后果：每个平铺周期采到的是「立面 + 它自己的缩略版 + 一条透明边」，
重复几十遍就是 §7 一直描述的「整栋微缩楼照片重复」——**confetti 的机制就是这个**。

### 顺带解掉三个悬案

1. **第三套 texcoord 不是 UV，是 `aTextureBatchId`**。GLSL 里
   `#ifdef MULTI_TEX attribute vec2 aTextureBatchId;`，`getTextureBatchId0=att.x`（base 批号）、
   `getTextureBatchId1=att.y`（bake 批号）。观测到的 `(0,1)(0,1)…` + `range[0,25]` 完全对得上：
   该图集 26 条子纹理，而 `v0+123` 正好绑给列表第 0 条。
   → **第三轮「set2 是引擎生成的逐面 UV」是幻影，不用生成，我们本来就有。**
2. **「uv 周期 1.65 m」算错了**：那是拿全局 uv 跨度 279 除以瓦片 460 m。逐 binding 实测
   跨度从 `1.0×1.0` 到 `279×55` 都有，没有单一周期。uv0 是建模工具留下的逐岛坐标。
3. **AtlasPack 行序 bug**（新发现）：拼图时原样拷解码器输出（上下颠倒），而 rect 的 y 按源图
   自上而下算。同一块里各图集高度不同（192/184/64/128），颠倒量随图集而异 ——
   于是「哪些精灵对」取决于它属于哪张图集。修前实测同一块里覆盖率 0% / 50% / 100% 混着，
   修后全部 ~100%。这条很可能是「同一面墙一半正常一半贴到别处」的真因。

### 本轮改动

| 文件 | 改动 |
|---|---|
| `core/AtlasPack.ts` | 逐行**倒序**拷贝，拼图行 0 = 源图顶行 |
| `core/S3MBlockParser.ts` | 删掉 rect 的 alpha 裁切（裁了会破坏 2/3 比例与 mip 列偏移）；rect 原样保留 |
| `render/GeometryBuilder.ts` | **删掉** `buildScaledUVs` / `buildGroupUVs` / `buildFaceUVs` 与 `atlasUv` 选项，UV 一律用原始 uv0 |
| `render/StyleMaterial.ts` | `s3mAtlasUnit` 换成官方 `czm_getTexColorForS3M`：`texSize = rect.zw × (2/3, 1)`、`dFdx` 算 mip、ceil/floor 两档平均；删掉 `S3M_ATLAS_UV_NORM` |
| `tests/unit/atlas-pack.test.ts` | 新增：合成 DXT5 三段色带，钉住拼图行序（注入 bug 会红） |
| `tests/unit/s3mblock.test.ts` | 新增：rect 宽度必须等于子区域原宽（含 mip 列） |

`bun run typecheck` 0 错误；`bun test ./tests/unit` 123 pass / 0 fail。
`bun run build:three && bun run build:maplibre` 已重跑（`build:demo` 最后一步被环境
safe-delete 拦住，与本任务无关）。

### 离线验证器（本轮最大资产，替掉「截图—猜—再截图」）

`_tmp/algo/` 下：

- `atlas.mts` —— 独立抽 `.s3mblock` 的原始图集（跳过 groupNode/skeleton 段）
- `agg.mts` —— 全量统计「右侧 1/3 是不是 1/2 下采样」
- `tile.mts` —— 按 rect 平铺对比（整宽 vs 左 2/3）
- `mipdemo.mts` —— 同一精灵 mip 0/1/2/3 阶梯图
- `verify.mts` —— **按片元着色器公式把 binding 摊成图**，三列并排：
  `A 旧逐面 / B 整宽rect / C 修复后`

跑法：`bun run _tmp/algo/verify.mts _tmp/algo/6.s3mblock 400 out.png "92"`
（`6.s3mblock` 用 `curl` 从
`https://www.supermapol.com/realspace/services/3D-OlympicGreen-2/rest/realspace/datas/Building@OlympicGreen/6.s3mblock` 拉）。

结论：C 列是干净均匀的窗格网格，B 列每格带一条缩略副本与透明边，A 列是整张精灵被拉满墙。

### 整瓦片软件光栅化（本轮补完，离「截图」最近的东西）

`verify.mts` 只能证明「一个 binding 的 uv 空间映射」，证明不了「整栋楼看起来对不对」。
所以又补了两个工具，都不需要浏览器：

- `wall.mts` —— 把**一个 binding 的真实三角形**按法线主轴摊平成一面墙，逐像素 fract 后取样。
  出三列：`A 逐面归一化 / B 整宽 rect / C 修复后`。
- `render.mts` —— **整瓦片软件渲染**：正交相机 + z-buffer + alphaTest + 逐片元 fract，
  同一相机同一几何出三列。这才是真正能替代截图的东西。
- `sheet.mts` —— 精灵体检表：同一子纹理「整宽 rect」与「左 2/3」各平铺 3×2 放大并排。
- `dbg.mts` —— 打印某块的 atlasRects / texturePackage / bindings 全貌（PICK 不中时先跑它）。
- `audit.mts` —— 审计 rect 在三角形内是否恒定、有没有零矩形、顶点被几个 binding 覆盖。
- `uvdim.mts` —— 量 uv0 的量纲与「一个 uv 周期跨几个屏幕像素」。
- `lods.mts` —— 打印块的 groupNode / pageLOD / 包围球 / 原始 textures 表。

跑法：

```bash
bun run _tmp/algo/render.mts _tmp/algo/6.s3mblock _tmp/algo/render_6.png 900 35 18
bun run _tmp/algo/wall.mts   _tmp/algo/b41.s3mblock "1008,1706" 8 _tmp/algo/wall_b41.png
bun run _tmp/algo/sheet.mts  _tmp/algo/b41.s3mblock "1008,1706" 8
```

结果（两个块互证，`6.s3mblock` 单图集 / `b41.s3mblock` 4 图集 74 条子纹理）：

| 列 | 整瓦片渲染表现 |
|---|---|
| A 逐面归一化 | 一面墙 = 一整张精灵，窗格被拉成大色块，全糊 |
| B 整宽 rect | 每格右边带一块半透明**缩微立面**，远处看就是满屏雪花 / 破洞 |
| C 左 2/3 + 内联 mip | 均匀窗格，无缩略副本、无透明边 |

`sheet.mts` 是机理最直观的一张图：整宽 rect 平铺时，每个周期右侧那块棋盘格里
能直接看见**缩小版的同一栋楼**——那就是 mip1 缩略图，不是「图案的延续」。

**两个坐标系的坑（写工具必踩）**：

1. `subTexInfos` 里的 `offsetX/offsetY/width/height` 是**像素**，不是归一化值。
   解析器才把它们归一化（`buildAtlasRects`）。
2. 运行时用的 rect 在**拼图坐标系**里 = `packed.offsets.get(atlasKey)` + 局部 offset。
   只拿 `sub.offsetX` 去取样会整体偏移（b41 上偏 96px），采到隔壁精灵，
   表现为「明明是灰墙却渲染出红砖」。**取样一律用 `tile.atlasRects[geoName].uv` 里的值。**

### 还没做的

1. **没在浏览器里跑过**。改动全部经离线烘焙与单测验证，但「与官方同机位并排一致」这个验收
   基准仍未复验 —— 需要 `?all=1` 那个 URL 的实机截图。
2. alphaTest 现在直接作用在原 rect 上（不再靠裁切 rect 规避天空）。若实机仍有镂空，
   该调的是 `alphaTest` 阈值 / `alphaMode`，**不要再回去裁 rect**。
3. `fract(uv)` + GPU mipmap 的接缝问题：本轮 mip 完全走内联金字塔（图集关 GPU mip，
   `TextureFactory.configureAtlas` 已确认 `generateMipmaps=false` + `LinearFilter` +
   `ClampToEdge`），所以不存在接缝；若将来改成「裁出 mip0 + 开 GPU mip」，必须用
   `textureGrad` 传未 fract 的导数，否则每块砖边缘一条暗线。
4. 极小化（一像素跨多格 uv）时 `mip` 会顶到 `maxMip - 1.62`，`guard` 把 `o` 夹成常数，
   出彩色条带。这是官方公式本身的行为（同样会夹），不是本次改动的缺陷，不要当 bug 修。

---

## 〇、第二轮结论（2026-10-25 晚，重要，先读这里）

在 §7 卡住的地方，用**官方侧实测**把「纹理解码 / rect 约定 / UV 解析 / 着色器公式」这四个假设
全部证伪了（都是对的），真正的问题在 **LOD 链**。本轮已修 3 个真 bug：

1. **LOD 细化从未触发**（`S3MTileset._load`）。`childUrls` 被 `_blockTileIndex`（= rootTiles 清单）
   过滤，而 S3MBLOCK 的 config 只列**根**瓦片，子瓦片 6_00 / 6_01 都在清单外 → `childUrls` 恒空
   → `update()` 永不细化 → 任何机位都只渲染最粗一级。修好后瓦片数 79 → 1800+。
2. **子瓦片的图集像素根本没取**（新 `_fillExternalAtlases`）。子瓦片（6_00/6_01…）的图集段
   `data = null` + `requestNames = ['-704919438.texblock']`，像素在同目录独立 `.texblock` 里。
   不补这一步子瓦片是**纯白无贴图**（精细 LOD 一loading 进来就露馅）。
3. **`compressType = 14` 必须判 DXT5**（`TextureFormat.ts`）。独立 `.texblock` 里 `ct=14 / pf=13`，
   `pf=13` 会被判成 `raw`（按 4 B/px 读 1 B/px 的数据），整图碎掉。

官方侧实测证据（可用 `_tmp/og/official2.html` 的 `bufferData` 钩子复现）：

```
同一骨架 2257 顶点，官方上传到 GPU 的 texcoord 缓冲 head = [-6.608,-1.945,-6.256,1.5,…]
range = [-139.23, 140.23]  ← 与我们解析出来的 uv **逐字节一致**
第二套 head = [0.007,0.334,…] range [0,0.99] ← 就是我们的 uv2
还有第三套 head = [0,1,0,1,…] range [0,25]  ← 我们没解析（结论未定，见下）
官方 batch 表：textureDim=(11,1) step=(1/11,1)、xywh 前几条 (48,0,24,16)(48,16,24,8)(0,64,12,32)…
             = 与块文件 subTexInfos 逐字一致；bake 表 1 条 (0,0,96,64) = 整张 bake 图集一个 rect
```

结论：**数据层我们是对的**，§3.5 的「镜像 rect」、DXT 修复、片元 fract 都没白做，别再回头改它们。


### 第三轮（2026-10-25 深夜）：根因收敛到「base 的 UV 该是逐面生成的那套」

用官方引擎在**与 maplibre 等价的机位**（屏幕中心 116.37911,39.98772，俯角 52°，
相机高 280 m ≈ zoom 19.07）截图 `_tmp/og/O2-samecam.png`：官方是**一堵墙贴一张
完整立面照片**（操场合围那几栋楼，每面一套连续立面，不平铺）。我们同机位是同一张
整楼照片重复几十遍 —— 差距不在解码、不在 rect、不在着色器，而在 **UV 本身**。

决定性证据（官方 GPU 缓冲，`_tmp/og/official4.html` 的 bufferData 钩子）：

```
同一骨架 2257 顶点，官方传了 **三套** 2 分量 texcoord：
  set0  head [-6.608,-1.945,-6.256,1.5…]  range [-139.23, 140.23]   ← 我们叫 uv
  set1  head [0.007,0.334…]               range [0, 0.99]          ← 我们叫 uv2
  set2  head [0,1,0,1,0,1,0,1…]           range [0, 25]            ← ★ 我们没有
```
块文件里 `parseTexCoord` 只读到 **2 套**（`套数 = 2`，两个 geo 都是），所以 set2 是
**引擎自己生成的**：数值成对出现 0/1，上界 25 —— 典型的「逐面 UV」：每个墙面从
(0,0) 铺到 (重复次数,1)，重复次数取整数。

着色器里 `vTexCoord.xy = intermediates.uv0.xy`（base）用的就是 aTexCoord0，而
aTexCoord0 = 上面三套里的一套。官方画面「一面墙=一张立面、长墙才按整数份平铺」，
只有 set2 能产生这个结果；set0（±139 世界尺度）必然平铺上百次。

**下一步就是实现它**（改动集中在 `GeometryBuilder`，不碰解析层）：
1. 按几何生成逐面 UV：把顶点位置投影到所在墙面（法线主轴分组 → box projection），
   竖直方向归一化到 [0,1]，水平方向按「精灵宽高比」算出整数重复次数；
2. 精灵宽高比从 batch rect（`atlasRects` 的 w/h × 图集像素尺寸）拿；
3. 用这套 UV 替换 base 的 `aAtlasRect` 采样入参（rect 不变），bake 继续用 set1。

对照实验记录：把 base UV 直接换成 set1（0..1）后，平铺彻底消失、一面墙只剩一张
被拉伸的照片（`_tmp/og/R13-uvswap.png`）——说明「不平铺」这一步是对的，缺的就是
水平方向那几份整数重复。

### 第四轮：官方 spec 仓库给了权威实现，两处关键修正

用户提示 https://github.com/supermap/s3m-spec 。仓库里没有 texblock / subName / offsetX
的文档（`Specification/S3MB/*.md` 只描述 2019 版 CAGIS 标准，共享纹理是未公开扩展），
**但 `S3M_SDK/S3M_JS/S3M_module/S3MTiles/Shaders/` 是官方着色器原文**，这才是权威。

官方 FS 的图集采样（`getTextureAtlasColor`）：

```glsl
// VS 里 getTexAtlasParameter：
float width = xywh.z;  float height = xywh.w;
width *= 2.0 / 3.0;                           // ★ 精灵右侧 1/3 是内联 mip 链
maxMipLevel = log2(min(width, height));
scale = (width, height) / textureDim;  translate = (xywh.x, xywh.y) / textureDim;

// FS：
mip = clamp(0.5*log2(d), 0.0, maxMip - 1.62);   // d 由 dFdx/dFdy(uv*texDim) 求得
translate += (scale.x, scale.y*(2^(m-1)-1)/2^(m-1));   // m>0 时平移到 mip 区
texcoord = fract(uv); clamp(texcoord, 2^m/texDim, 1-2^m/texDim);
texcoord = texcoord * scale/2^m + translate;
color = texture2D(tex, texcoord);              // 官方也是 texture2D(...,0.0)
```

我们此前已把这段公式照抄进 `StyleMaterial.s3mAtlasUnit` / `s3mBatchUV`，
逐行一致。**差异只在 `2/3` 这个系数**：

- 官方图集把每个精灵的 mip 链内联在它右侧 1/3（所以采样要按 2/3 收窄宽度）；
- 我们从 `.texblock` 解出来的图集**没有这条内联链**（放大单个槽位 24x32 看不到
  逐级缩小的副本，右侧 1/3 仍是图案本身的延续）。
- 于是按官方公式走 mip>0 时，采样点被平移到「本该放 mip」的位置 → 采到邻居槽位，
  整面墙碎成拼贴。这就是 confetti 的机制。

改成「rect 满宽 + mip 固定 0」后（`_tmp/og/X2-final.png`）：整楼照片重复消失，
墙面变成窗格级立面 —— 这是目前最接近官方的一版。

#### 与「刚支持 block 那个版本」（753fc9f）的对比

把 753fc9f 的源码临时切回来同机位截图（`_tmp/og/BASE-753fc9f-z192.png`）：

- 那一版在 CPU 上把 rect **烘进顶点 uv**（`remapAtlasUVs`），且每个顶点各自
  `fract()` —— 一个面的四个角被折到同一点，整面墙被抹成一条平滑色带 + alpha 黑边。
  用户记得的「只有黑边和 uv 对不上」就是这一版。
- 试过去掉那个 `fract()`（`_tmp/og/BASE-nofract.png`）：色带消失、出现立面条纹，
  但因为精灵仍是「整楼缩略图 + 天空 alpha」，大面积是天空蓝 + 镂空。
- 现行版本（rect 逐顶点 + 满宽 + mip0）比两版都更接近真实立面。

#### 仍未解决

1. 墙面仍有白/黑镂空 —— 部分条带的精灵是「整栋楼 + 天空」的缩略图，alpha 把天空
   抠掉了。也就是 LOD 太粗：可见瓦片几乎全是层级 1，图集只有 48x40 / 96x128。
2. 官方在同一机位也只到 `6_01`，所以「更细 LOD」这条解释不成立，问题更可能是
   我们**取错了图集**（父子瓦片各自的图集不同，根块图集是整楼缩略图）。

### 第五轮（2026-10-25 深夜）：三个真正的根因，其中两个是"工作量级"的

#### 根因 A：一个 `.s3mblock` 文件是一整棵 LOD 子树，不是一块瓦片 —— 我们只解析了第 0 组

`6_01.s3mblock`（549 KB）的容器头 `groupCount = 5`，五组各是一层 LOD，链成一条树：

```
组0 6_01.s3mblock        rv=586.8  r=293.4  child=6_0100.s3mblock
组1 6_0100.s3mblock      rv=1024.0 r=293.4  child=6_010000.s3mblock
组2 6_010000.s3mblock    rv=1024.0 r=338.2  child=6_01000000 / 6_01000001
组3 6_01000000.s3mblock  rv=1024.0 r=278.2
组4 6_01000001.s3mblock  rv=1024.0 r=278.2
```

`childTile` 指向的下一层**就在同一个文件里**（不是独立 URL）。旧实现 `parseS3MBlock` 读完第一组就
return，于是 **4/5 的几何和它们那份更细的图集全部丢失**，子瓦片请求还指向不存在的
`6_0100.s3mblock` 文件。

已改：新增 `parseS3MBlockGroups()` 解析全部组；`S3MTileset._load` 用 `url#N` 表示「同一文件的第
N 组」，组内 LOD 直接命中缓存，不发网络请求。日志实测已经能看到
`childUrls: ["41_00.s3mblock#1","#3","#5"]` 且 `needRefine=true`。

#### 根因 B（最坑的一个）：demo 读的是 `dist/`，不 build 等于没改代码

`site/src/demo/main.js` 里 `import ... from 's3m-maplibre'`，包入口是 `dist/index.js`。
本轮前面十几张截图**全是旧产物**，所有源码改动（rrect 翻转、UV 重算、多组解析）都没进画面 ——
这就是"改了半天画面一模一样"的原因。规矩：**改完源码先
`bun run build:three && bun run build:maplibre`，再截图**，并用
`grep 新符号 packages/s3m-three/dist/**` 断言产物已更新。

#### 根因 C：rect 的归一化 y 必须从图集另一端量

纹理上传时 `flipY = true`，`offsetY / height` 会让 rect 落到图集的空白/天空区 ——
实测 `(96,0,24,16)` 这块在图集里**全透明**，整面墙因此被 alphaTest 抠成窟窿。
改成 `y = 1 - (offsetY + height) / height`，`tests/unit/s3mblock.test.ts` 的期望值同步更新。

#### 图集 UV 的三条路都试过（有截图对照）

| 做法 | 结果 | 图 |
|---|---|---|
| 原始世界 uv，片元 `fract(uv)` | 一个周期 1.65 m，整段立面被压进两米重复几百遍 | 历史 X2-final |
| `fract(uv / 精灵像素尺寸)` | 平铺密度变正常，但仍是一格格"整楼照片" | `_tmp/og/X4-atlaslod.png` |
| 按 binding 分组、逐面 0..1（现默认） | 得到**连续的真实立面照片**（KOHLER 广告牌、窗、门面一次成型），不再重复小楼 | `_tmp/og/X6-groups.png` / `X8-wide.png` |

按 binding 分组的依据是数据本身：`subTexInfos` 的每条 binding 都写明
「geoName + vertexOffset + vertexCount → 这张子纹理」，与官方 batch 表同义。
新增 `S3MAtlasRects.group`（逐顶点组 id）+ `buildGroupUVs()`；着色器加
`S3M_ATLAS_UV_NORM` 宏区分「已是归一化 UV」和「需要按精灵像素尺寸换算」。

#### 现在的差距（诚实记录）

`X6-groups.png` 已经把"一栋楼贴一栋楼的立面照"做出来了，但：

1. **长墙的重复次数偏少**：现在用 `round(墙宽/墙高)`，一栋 100 m 板楼只重复 2~3 次，
   而官方是十几到几十次（窗格级）。需要按「该 binding 的原始 uv 跨度 / 精灵像素尺寸」
   算重复数 —— 这个信息是齐的（原始 uv + rect.zw × 图集尺寸），只是还没接上。
2. **精灵本身含天空**：图集里每个精灵是"立面 + 上方天空（alpha=0）"，alphaTest 一丢就是洞。
   官方材质 `alphaMode` 全是 `opaque`，说明官方根本不用 alpha —— 但那就得让精灵本身
   不含天空，也就是 **rect 必须只框住立面本体**，这块还没对上。
3. 远景（`X8-wide.png`）仍能看到"楼贴了别处的立面"，说明有些 binding 覆盖的顶点区间
   不止一面墙，需要按「uv 空间连续性」再切一刀。

### 第六轮（2026-10-25 23:00）：对比基准一直是错的 —— 官方场景是 6 个图层

这是本轮最重要的发现，之前所有"我们的画面跟官方差很远"的判断都建立在一个错误前提上。

官方对照页 `scene.open('.../rest/realspace')` 打开的是**整个场景**，而场景配置
（`rest/realspace/scenes/OlympicGreen.json`）里有 6 个图层：

```
BirdNest@OlympicGreen   Waters@OlympicGreen   Tree@OlympicGreen
Road@OlympicGreen       Ground@OlympicGreen   Building@OlympicGreen
```

我们 demo 一直只加载 `datas/Building@OlympicGreen/config` —— **只有建筑，没有地面、操场、
树、水、路、鸟巢**。官方截图里那些"干净的连续窗格立面"，有相当一部分观感来自完整环境
（地面/阴影/树）衬托；而我们的画面是悬空的一堆楼贴图，怎么看都"不对"。

已修：`site/src/demo/main.js` 支持 `?all=1`，把服务下列出的数据集全部勾选。

```
http://localhost:5174/demo/?all=1&url=https%3A%2F%2Fwww.supermapol.com%2Frealspace%2Fservices%2F3D-OlympicGreen-2%2Frest%2Frealspace
```

加载后 `stats.datasets = 6`、顶点 445,455，画面里草地、树、道路、水面、建筑都出来了
（`_tmp/og/Z1-alllayers.png`）。**后续一切对比都必须用这个 URL。**

#### 另一处修正：rect 按图集 alpha 收缩到立面本体

图集里的每个精灵是「建筑立面 + 上方天空」一整个照片块，天空 alpha=0。
- 开 alphaTest → 墙被抠成空壳，能看见楼内壁；
- 关 alphaTest（实测 `_tmp/og/Z2-noalphatest.png`）→ 天空部分的 RGB 糊满整面墙，楼变纯灰白。

两条路都不对，说明 **rect 只该框立面本体**。官方材质 `alphaMode` 全是 `opaque` 也印证
这一点（它拿到的精灵根本没有天空）。

实现：新增 `core/AtlasAlpha.ts` —— 解析阶段用 DXT 解出图集的 alpha 掩码，把每条
subTexInfo 的 rect 收缩到其内部的不透明包围盒（内缩 0.5 px 避开边缘混色）。
见 `_tmp/og/Z3-opaque.png`：楼变实体、KOHLER 广告牌完整成型、不再有镂空网格。

#### 现在的画面还剩什么

`Z3-opaque.png` 与官方 `O6-exactcam.png` 相比：

1. **有一层半透明灰白雾罩在半空**，压在建筑和地面上 —— 疑似多图层叠加时某个图层
   （Ground / Waters）被渲染成了大面片，需要逐层开关定位。
2. 建筑贴图仍是"同一栋楼的立面照贴到多栋楼上"，说明 binding → 精灵的归属在**跨瓦片**
   层面还有偏差（同一图集被多个瓦片共用时，rect 与几何的配对没按瓦片隔离）。
3. 楼顶/楼板仍然缺（看到的还是"墙壳"），需要确认 Building 图层的屋顶是否在别的 geo 里
   被我们跳过了。

### 第七轮：贴错图的真凶 —— 一个块里有**多张图集**，单张 map 装不下

#### 证据链（全部可复现）

1. `41_00.s3mblock` 的 `texturePackage` 有 **6 张图集**：`120x144 / 192x128 / 216x288 /
   120x160 / 192x128 / 192x128`，每张的 `subTexInfos` 各自绑定**不同的 vertexOffset 区间**。
2. 点开其中任一 geo 看，一个网格（一个材质、一个 `map`）里同时出现来自不同图集的 binding。
3. 官方着色器用的是纹理**数组**：`atlas_batchTable_xywh(aTextureBatchId0, batchTextureAtlas, …)`
   + `uTexAtlasDim`（复数），每个 batch 自带图集序号 —— 它一次能取多张图集。
4. 我们只绑一张 `map`，于是「其它图集」那部分顶点拿着自己图集里的归一化坐标去采另一张图，
   采到的是完全无关的内容。**这就是墙上贴别处立面 / 满墙小楼缩略图的真正来源。**

#### 做法：解析阶段把图集拼成一张（`core/AtlasPack.ts`）

- 用 `DXTTextureDecode` 把块里每张图集解成 RGBA；
- 货架式装箱拼进一张大图（上限 1024 宽），记录每张图集的 `(x, y)` 偏移；
- 所有 `subTexInfo` 的 rect 全部换算到拼图坐标系（`(off + subOffset) / packedSize`）；
- 把 `texturePackage` 里的每个条目都指向这张拼图（`width/height/data` 覆盖，
  `compressType=0 / pixelFormat=28(RGBA) / flipY=false`），并标 `packed=true`；
  原始尺寸留在 `origin` 上，测试与排查都能查到；
- `S3MTileset` 对 `packed` 的块跳过 `.texblock` 高清替换（像素是我们重排过的，
  再拿单张高清图覆盖会整张错位）。

效果对照：`_tmp/og/I1-face-hd.png`（拼合前，墙上是别处的楼）→
`_tmp/og/K1-all.png`（拼合后，每面墙是连贯的一整套立面：窗、幕墙、KOHLER 广告牌）。

#### 顺带修掉的一个真 bug：纹理缓存把高清图集挡住了

`GeometryBuilder` 里纹理按 id 全局缓存，`if (textureByCode.has(code)) continue`。
同一个图集 id 会被很多瓦片共用，先到的那块只拿到内嵌缩略图（120x184），
后面的块换成高清版（240x304）却被这行直接跳过 —— 所以画面一直是马赛克。
现在尺寸变大就重解码覆盖。

#### uv 的两条路都量过了

| 做法 | 结果 | 图 |
|---|---|---|
| 原始 uv0 直接 `fract`（官方 calculateTexCoord 原样） | 窗格尺度对了，但地面/墙面变成「整片街区」重复铺 | `_tmp/og/L1-packed-raw.png` |
| 按 binding 分组、逐面 0..1（现默认） | 每面墙一张完整立面，连贯但偏糊 | `_tmp/og/K1-all.png` |

原始 uv 的世界周期实测 ≈ 11.4 m（`11.s3mblock`：几何 x 跨度 199.8 m / uv 跨度 17.5），
这说明作者就是按「一张精灵覆盖 11 m 左右立面」排的；它现在看着像「整片街区」重复，
是因为块内精灵本身是「立面 + 天空」的照片块，天空部分在平铺时被一起重复了。
下一步要做的只有一件：**平铺前把精灵按 alpha 裁到立面本体，并让 rect 的缩放跟着裁切同步**
（`core/AtlasAlpha.ts` 已有掩码，现在的用法是「裁切」而不是「缩放对齐」，需要改成后者）。

### 第八轮：裁切顺序 + 满宽采样 + **LOD 深度才是清晰度的开关**

#### 1. alpha 裁切必须在拼图之前

上一轮的拼图把 `texturePackage` 的 `width/height/data` 全换成了大图，`atlasAlphaMask()`
再读就是「大图的掩码 + 小图的坐标」，必然错。现在顺序改成：

```
每张图集各自算 mask → 在自己的像素坐标里把 sub 裁到不透明包围盒 → 再装箱拼合
```

#### 2. 去掉 2/3 宽度系数

官方 shader 的 `width *= 2/3` 是为了避开精灵右侧那条内联 mip 链。
我们的图集是自己在解析阶段重新装箱的，每格只有本体、没有内联链，
继续乘 2/3 等于把每个精灵裁掉三分之一。现在按 rect 满宽采样。

#### 3. `lodRangeScale` 1.0 → 3.0：这是本轮最大的视觉变化

| 指标 | 1.0 | 3.0 |
|---|---|---|
| 瓦片数 | 71 | **237** |
| 网格数 | 77 | **279** |
| 顶点 | 116,363 | **561,157** |
| 画面 | 24x16 像素的糊图 | 招牌 "KOHLER"、窗格可读 |

`_tmp/og/P1-deeplod.png`：同一机位下立面已经能看清窗格和招牌笔画，
说明**之前"糊"的主因不是 UV，而是压根没细化到有高清图集的那一层**。
根 LOD 的图集就是 24x16 的缩略图，再怎么调采样也是糊的。

#### 4. 白板不是 UV 问题（已排除）

深层 LOD 下逐顶点统计 `aAtlasRect`：**零退化矩形**
（Ground 180,261 / Tree 158,916 / Building 165,249 顶点全有有效 rect）。
画面里那些大面积灰白平面来自**没有贴图的图层**：Waters 的 6 个网格
`map === null`、material 是普通 `MeshStandardMaterial`（`_tmp/og/A3-planes.json`），
水面用的特殊材质我们没接，于是按 diffuse 白色渲染。

#### 现在剩下的两件事

1. **同一张 KOHLER 立面被贴到所有楼上**：深层 LOD 下每块图集往往是「一整张立面」
   （192x128 覆盖整个图集），而逐面 UV 又给每面墙铺一次，于是同一块图集的照片
   被所有墙共用。需要按 binding 的子区域编号取精灵，而不是按块取整张图集。
2. **水面 / 无贴图材质**：`map === null` 时至少要按材质 diffuse 上色（水是蓝色），
   现在一律白板。

### 第九轮：白板已定性 —— 是 SuperMap 内置水面，不是贴图错

`Waters@OlympicGreen` 走的是普通 `.s3mb`（不是 block）。抓一块下来看：

```
Tile_-7284_21188.s3mb   1081 字节
textures = 0
material: alphaMode=opaque  diffuse={r:1,g:1,b:1,a:1}
textureunitstates = ["103.water"]
```

**块里根本没有像素**，材质引用的是 SuperMap 的保留 id `103.water`（官方引擎里的内置水面，
由引擎自己程序化生成）。我们以前拿它的白色 diffuse 当普通材质画，于是整片湖是白板。

已改（`GeometryBuilder`）：纹理单元 id 以 `.water` 结尾且没有贴图时，用内置水面外观渲染
——基色 `#1d4e63`、roughness 0.12、opacity 0.86。真正的波纹/反射需要单独实现水面着色器，
但至少不再是一块白板。

### 仍然没解决的那一件事

画面依旧是「一栋楼的照片被重复十几遍」。现在能定量解释了：

- 一个子纹理槽位（如 `91_2` = 24×32 px）里放的是**一整栋楼的立面照片**（雪碧图，见
  `_tmp_og_child_-1930065266.texblock.png`：整张 300×304 图集就是几十张建筑立面拼的雪碧图）。
- 而 `uv` 一个周期 ≈ 1.65 m（6_01 的 uv 跨度 279、瓦片实际约 460 m），所以一张「整楼照片」
  被压到 1.6 m 宽重复几十遍 → 就是 confetti。
- 官方同一个机位是清晰的，说明**官方拿到的是更细 LOD 的图集**：细 LOD 里槽位是窗格级小图，
  同样重复十几次正好是「一栋楼十几扇窗」。**所以这仍然是 LOD 深度问题，不是纹理绑定问题。**

已经定位到卡点：瓦片 6_01 的 `needRefine=false`，而它的 `radius=293.4` 比父瓦片
`6.s3mblock` 的 `radius=133.3` 还大，`rangeValue = 2×radius`，像素半径永远追不上阈值 →
细化链在第二级断掉。**8 成是子瓦片的 boundingSphere/rangeValue 取错了页**
（块 6 的容器里有两条 pageLOD：129.7→6_00、293.3→6_01，我们把两条都当成了子瓦片，
其实它们可能是同一棵树的不同 LOD 档）。下一步就从这里查：`_pickLod` / `parseBlockPageLod`
对「一个块含多条 pageLOD」的处理，以及子瓦片 sphere 是否该取容器声明的那份。

另外两个待查项：
- 第三套 texcoord（`[0,1,0,1,…]`，range 0..25）官方有、我们没解析，可能与 LOD/偏移有关。
- `atlasLod`（`.texblock` 清晰版链）仍默认关，等 rect 配对问题解决后再开。


---

## 一、当前状态一句话

数据解析层已经对齐（rect 约定、绑定划分、文件格式都有量化证据），**但画面仍与官方差很远**：OlympicGreen Building 在 SMID 205 机位下是"整栋微缩建筑照片被重复几十遍 + 透明洞"，官方是干净实体建筑。着色器改造已确认在浏览器里生效，**却没有产生任何视觉变化**，调查卡在下文 §7 的第一个测量上。

---

## 二、仓库状态

- 分支 `main`，HEAD = `753fc9f`（同事在本次会话中途提交，把我当时的临时调试代码 `__s3mAtlasMode` 一起带进去了；工作区已摘除该开关）。
- **未提交**的工作区改动（均为本任务）：

| 文件 | 改动 |
|---|---|
| `packages/s3m-three/src/core/DXTTextureDecode.ts` | 三处解码修复（块大小路由、DXT3 alpha、翻行 off-by-one） |
| `packages/s3m-three/src/core/TextureFormat.ts` | `dxtPixelFormatOf` 逐格式返回 17/19/20/21 |
| `packages/s3m-three/src/core/S3MBlockParser.ts` | 不再把 UV 烘进图集坐标，改输出 `atlasRects`；新增 `parseS3MBlockTextureFile` |
| `packages/s3m-three/src/core/types.ts` | `S3MAtlasRects`、`ParsedTile.atlasRects` |
| `packages/s3m-three/src/render/GeometryBuilder.ts` | `aAtlasRect` / `aAtlasRect1` / `aSecUv` 顶点属性 + 合批搬运 + `secMap` 传递 |
| `packages/s3m-three/src/render/StyleMaterial.ts` | `S3M_ATLAS` / `S3M_ATLAS_SEC` 宏 + 官方层级采样公式 |
| `packages/s3m-three/src/render/TextureFactory.ts` | `configureAtlas`（关 GPU mip）、`hasAlphaChannel` 驱动 alphaTest |
| `packages/s3m-three/src/tileset/S3MTileset.ts` | `.texblock` 子图集加载，**默认关**（`atlasLod` 选项） |
| `site/src/demo/main.js` | demo 镜头回弹修复（已验证有效） |
| `tests/unit/s3mblock.test.ts`、`tests/unit/texture-format.test.ts` | 断言改写 + 新增 6 条回归用例 |
| `tests/fixtures/s3mblock/911305599.texblock` | **故意保留**的子图集夹具（要提交） |
| `docs/*.html`、`demo/` | `bun run build` 重跑的产物 |

- 测试结果：
  - `bun test ./tests/unit/s3mblock.test.ts ./tests/unit/texture-format.test.ts` → **24 pass / 0 fail**
  - `bun run typecheck` → **0 错误**
  - 全量 `bun test ./tests/unit` 最后一次 **111 pass / 5 fail**，5 个失败全部在未跟踪的 `tests/unit/lod-budget.test.ts`、`tests/unit/lod-stability.test.ts`（LOD 预算，别人在写的用例），与本任务无关。

---

## 三、已确认修好（有测试或量化证据）

1. **DXT1 被按 16 字节块解**（用户指出）。`DXTTextureDecode.decode()` 判据是 `format > 11 || format === 5 ? kDxt5 : kDxt1|krgb565`，而 `S3MPixelFormat.DXT1 = 17` 也 > 11 → 17/19/20/21 全部落到 kDxt5。512×512 的 DXT1 实际只有 131,072 B（0.5 B/px），按 16 字节块要 262,144 B，正好差一倍，越界部分读成 `undefined` → 解出全 0。已改为按真实格式 switch；官方那句 `> 11` 成立的前提是"无 alpha 时纹理标成 RGB(10)/BGR(11)"。
2. **DXT3 被按 DXT5 解 alpha**。`dxtPixelFormatOf()` 除 `dxt1` 外一律返回 21 → DXT3 用 DXT5 的插值 alpha 解（块大小同为 16B 不越界，但 alpha 错）。已改为 17/19/20/21。旧测试 `块大小映射` 里 `dxt3 → 21` 这条断言把错误期望钉死了，一并修正。
3. **`DecompressImage` 翻行下标少减 1**：`4 * (width * (height - sy) + sx)` → `height - 1 - sy`。原写法 `sy = 0` 时写到 `row = height` 越界，而 TypedArray 越界写是**静默丢弃** → 缓冲区第 0 行永远是全 0（透明黑），其余行整体错位一行。**影响所有 DXT 纹理，经典 s3mb 路径同样中招。**
4. **逐顶点 `fract` 是错的**。官方是片元级 `vec2 outUV = fract(uv)`。实测 235,828 个绑定三角形里 **17.0%（4,545 个）跨整数 UV 边界**，部分子纹理 100% 跨（`292_3 / 851_3 / 852_3 / 853_3 / 262_3 / 864_3`），原始 UV 跨度大到 `[-18.18, 19.18] × [-11.93, 12.93]`。顶点上取 fract 会让这些三角形反向扫整个周期（裙房那片米色拉丝）。已改为逐顶点 `atlasRect` + 片元计算。
5. **rect 约定 = 镜像（解码后翻行 + offsetY 从图集另一端起算）**，两条独立证据：
   - 镜像 rect 的并集覆盖 **100%** 不透明像素、贴合度 89%；原值约定只有 60% / 53%（OlympicGreen block 6 的 4 张图集全部一致）。
   - 46,886 个绑定顶点按高度分箱统计采样到的 alpha：翻行方案底部 228 → 顶部 190 单调下降（屋顶以上是被抠掉的天空）；不翻行则 215~223 全程平坦（轮廓与几何对不上）。
6. **alphaTest 与 flipY 解耦**，改由像素格式决定（DXT3/4/5 + 四字节 RGBA 族）。注意：Building@CBD 与 OlympicGreen 的材质 `alphaMode` **全是 `opaque`**，所以 alphaTest 不能按 alphaMode 关——这个假设已被实测否掉。
7. **demo 镜头回弹**：根因是 `loadSource` 末尾的 `fitLayerBounds()` 要等所有数据集 await 完才执行（Building@CBD 实测 40s+ 才响），把用户手动取景拽回全局。加了 `userMovedCamera` 守卫（只有真实手势 `e.originalEvent` 置位，程序 fit 不算），切换数据源时重置。无头截图验证：拖拽后 `jumpTo` 到 zoom 18.1，等 12s 不再被拽回。

---

## 四、我明确撤回过的错误结论（别再走这些路）

| 曾经说过的 | 实测/源码结论 |
|---|---|
| "官方不翻行，所以我们也该不翻" | **等价**。官方 `_supportCompressType = 1` 走 `compressedTexImage2D`（不翻）；只有当 DXT 被 CPU 解码成 RGBA 时才 `flipY = true`（Cesium 那版对手动翻 arrayBufferView）。我们恒走 CPU 解码 + 翻行，两边下标都落在 `H-1-offsetY-f·h` |
| "官方采样用的是祖先图集的 rect" | **错**。运行时实测 `ancestor` / `ancestorBake` = `null`，batch 表存的就是本级 `_subTexInfos` 的像素 rect |
| "图集子区域自带内联 mip 链（base 占 2/3 宽）" | ~~**无依据**。`(48,0,24,16)` 右边紧挨的是 `(48,16,24,8)`，subName 是另一张子纹理 `1130_3`，不是它的 mip。`width *= 2/3` 只是算 `maxMip` 的经验收缩系数~~ → **这条撤回本身是错的，见 §十**：右侧 1/3 确实是 1/2 下采样的内联 mip 列（691 条子纹理 96.7% 成立），缩略图看起来像「图案的延续」只是因为图案自相似。 |
| "换子图集 + 保留归一化 rect 能提清晰度" | **实测更糟**（碎成满屏空洞）。三对样本比例不固定：`1.941×2.000`、`2.000×2.000`、`2.000×1.579` |
| "我的着色器改写让渲染变差了" | **错**。OlympicGreen 在改写前就已经是 confetti，我当时拿 Building@CBD 的观感当成了"已验证的好基准" |

---

## 五、官方对照环境（本次最大资产，可直接复用）

### 5.1 两个坑

1. 官方样例页 `https://www.supermapol.com/webgl/examples/webgl/editor.html#S3MTiles_jingmo` 在 headless 下**自身崩溃**：样例列表脚本抛 `TypeError: Cannot set properties of undefined (setting 'innerHTML')`，导致 `window.onload(SDK)` 从不执行、没有 canvas。**不要试图用它当基准页。**
2. 直接 `<script src="https://www.supermapol.com/webgl/Build/SuperMap3D/SuperMap3D.js">` 会被**跨域 Worker** 拦：`SecurityError: Failed to construct 'Worker'`。

### 5.2 解法

引擎 bundle 真实地址（`loadSDK.js` 里 `BuildBasePath: '../../Build'` 是相对**页面目录**，不是相对 js 目录）：

```
https://www.supermapol.com/webgl/Build/SuperMap3D/SuperMap3D.js      # 11,939,721 B
```

自己搭一页 + 本地同源反代：

```bash
# 1) 起反代：/sdk/** → 上面的 Build 目录，监听 :8099
bun run _tmp/og/serve.mts

# 2) 前台跑探针（结果直接打印，别重定向）
bun run _tmp/og/probe-official.mts \
  --url http://localhost:8099/_tmp/og/official.html \
  --wait 30000 \
  --js _tmp/og/js-pass.js \
  --port 9544 \
  --profile C:/server/s3m-maplibre/_tmp/og/chNN
```

### 5.3 关键实现细节

- `_tmp/og/official.html`：加载 `/sdk/SuperMap3D.js` → `new SuperMap3D.Viewer(..., {contextOptions:{contextType:2}})` → `scene.open('https://www.supermapol.com/realspace/services/3D-OlympicGreen-2/rest/realspace')`。
  - headless 下必须**手动把 canvas 撑到 1400×900** 并 `viewer.resize()`，否则只渲染左上角一小块、瓦片也不流式加载。
  - `scene.layers` 是 LayerCollection **不是数组**，不能 `for...of`，要用 `.length` + `.get(i)` / `.find(name)`。
  - `scene.open()` resolve 值是 `undefined`，图层是异步挂上去的，别依赖返回值。
  - 顶部挂了 **`gl.shaderSource` 钩子**截获全部着色器原文。踩过的坑：`ShaderProgram.fromCache` 那层钩子**拦不到 S3M 材质**（228 个 program 里 0 个含 `fract(`，最大的那个只是 FXAA）；只有 `gl.shaderSource` 能拿全（52 个里 11 个含 `fract(`、10 个含 batch 表）。
- 官方引擎版本：**iClient3D 12.1.1 / SVN 51714**，`contextType=2`(WebGL2)。
- 官方基准图：`_tmp/og/baseline-official.png`，机位
  `camera.setView({destination: fromDegrees(116.37911, 39.98772, 260), pitch: -38°, heading: 0})`
- 我们侧同机位：`center 116.37911,39.98772  zoom 19.2  pitch 52  bearing 0`
  （截图脚本 `_tmp/atlas/shot.mts`，`--post` 里轮询等到 `stats.loading === 0 && tiles >= 60` 再拍）。

---

## 六、官方实现的权威规格（已核实，非推断）

### 6.1 片元着色器

原文存 `_tmp/og/full.txt`。关键片段：

```glsl
// 层级由 dFdx/dFdy 自己算，钳到子区域自己的上限
void calculateMipLevel(in vec2 inTexCoord, in vec2 vecTile, in float fMaxMip, out float mipLevel) {
    vec2 dx = dFdx(inTexCoord * vecTile.x);
    vec2 dy = dFdy(inTexCoord * vecTile.y);
    float dotX = dot(dx,dx), dotY = dot(dy,dy);
    float dMax = max(dotX,dotY), dMin = min(dotX,dotY);
    float offset = clamp((dMax-dMin)/(dMax+dMin), 0.0, 1.0);
    float d = dMax*(1.0-offset) + dMin*offset;
    mipLevel = 0.5 * log2(d);
    mipLevel = clamp(mipLevel, 0.0, fMaxMip - 1.62);
}

vec2 getBatchUV(vec2 uv, vec2 translate, vec2 scale, vec2 dim, float mipLevel) {
    vec2 texTranslate = translate;
    if (mipLevel > 0.0) {
        texTranslate.x = translate.x + scale.x;
        float temp = pow(2.0, mipLevel - 1.0);
        texTranslate.y = translate.y + scale.y * (temp - 1.0) / temp;
    }
    float texScale = 1.0 / pow(2.0, mipLevel);
    vec2 outUV = fract(uv);
    float offsetX = pow(2.0, mipLevel) / dim.x;
    float offsetY = pow(2.0, mipLevel) / dim.y;
    outUV.x = clamp(outUV.x, offsetX, 1.0 - offsetX);
    outUV.y = clamp(outUV.y, offsetY, 1.0 - offsetY);
    outUV.x = outUV.x * texScale * scale.x + texTranslate.x;
    outUV.y = outUV.y * texScale * scale.y + texTranslate.y;
    return outUV;
}

vec4 sampleLod(vec2 uv, float mipLevel, bool bUseFirstTexture) {
    // ★ 永远传 LOD 0 —— 层级已经烘进 uv 里了，所以图集不能有 GPU mip 链
    color = textureLod(uTexture,   uv, 0.0);   // 或 uSecTexture
    return SRGBtoLINEAR4(color);
}

vec4 getBatchTextureColor(TextureParam p, bool bUseFirstTexture) {
    if (p.maxMipmapLevel < 0.0) return vec4(1.0);          // ★ batchId < 0 → 不参与
    float mipLevel = 0.0;
    calculateMipLevel(p.uv, p.dim, p.maxMipmapLevel, mipLevel);
    vec2 tc = getBatchUV(p.uv, p.translate, p.scale, p.dim, ceil (mipLevel));
    vec4 colorCeil  = sampleLod(tc, 0.0, bUseFirstTexture);
    tc = getBatchUV(p.uv, p.translate, p.scale, p.dim, floor(mipLevel));
    vec4 colorFloor = sampleLod(tc, 0.0, bUseFirstTexture);
    return colorCeil * 0.5 + colorFloor * 0.5;
}

vec4 getTextureColorForS3M(out vec4 outTexCoord) {
    textureParam.uv = vTexCoord.xy;   // base
    textureParam.dim = vTexSize.xy;  textureParam.translate = vTexTran.xy;
    textureParam.scale = vTexScale.xy; textureParam.maxMipmapLevel = vMaxMipLevel.x;
    firstColor = getBatchTextureColor(textureParam, true);
    textureParam.uv = vTexCoord.zw;   // bake
    textureParam.dim = vTexSize.zw;  textureParam.translate = vTexTran.zw;
    textureParam.scale = vTexScale.zw; textureParam.maxMipmapLevel = vMaxMipLevel.y;
    secColor = getBatchTextureColor(textureParam, false);
    return firstColor * secColor;                          // ★ RGBA 整体相乘
}
```

顶点侧 `getTextureParameter`：

```glsl
void getTextureParameter(in vec4 xywh, in vec2 textureDim,
                         inout vec2 translate, inout vec2 scale,
                         inout vec2 texSize, inout float maxMipLevel) {
    float width  = xywh.z;
    float height = xywh.w;
    width *= 2.0 / 3.0;                                   // 只是收缩系数，见 §4
    maxMipLevel = log2(min(width, height));
    scale.x = width  / textureDim.x;
    scale.y = height / textureDim.y;
    translate.x = xywh.x;  translate.y = xywh.y;
    translate /= textureDim;                              // → 归一化
    texSize.x = width;     texSize.y = height;            // → 像素
}
// batchId < 0 时置 maxMipLevel = -1
// base 用 uTextureDim.xy，bake 用 uTextureDim.zw；两套独立的 vTexTran/vTexScale/vTexSize/vMaxMipLevel
```

### 6.2 `uTextureDim` 的赋值式（源码，非猜测）

```js
_updateBatchTextureWidths() {
  const pass = this._materialPass;
  if (!defined(pass._batchTable)) return;
  let t0 = pass._textures[0];
  t0 = t0.renderable ? t0 : (defined(pass._ancestorTexture) ? pass._ancestorTexture : t0);
  uTextureDim.x = t0._width;  uTextureDim.y = t0._height;      // base 实际绑定那张
  let t1 = pass._textures[1];
  if (defined(t1)) {
    t1 = t1.renderable ? t1 : (defined(pass._ancestorTextureBake) ? pass._ancestorTextureBake : t1);
    uTextureDim.z = t1._width;  uTextureDim.w = t1._height;    // bake
  }
  ubo.updateFloat4('uTextureDim', x, y, z, w);
}
```

UBO 清单（`_initUBOStruct`）：`uTexMatrix(16) uDiffuseColor uAmbientColor uSpecularColor uTexUVOffset(4) uTextureDim(4) uTextureWidths(2) batchTextureStep_baseTex(4) batchTextureDimensions_baseTex(2) batchTextureStep_bakeTex(4) batchTextureDimensions_bakeTex(2) uBaseColorFactor uEmissiveFactor uEmissiveUVOffsetAndTiling uMetallicRoughnessIntensityScale uPBRTexWH uNormalTextureScale uAlphaMode uAlphaCutoff uPbrParTextureWidth uMaterial_Brightness/Contrast/Saturation`。

### 6.3 运行时实测值（SMID 205 区域的一个 pass）

```
layer: _textureLod = true, _supportCompressType = 1
       → 桌面端官方不做 CPU 解码，直接把 DXT 压给 GPU，flipY = false

pass (isRoot=true, isLeaf=false, alphaMode="opaque"):
  base 图集  1474203899.texblock  72×128   renderable=true ready=true
  bake 图集  1909969701.texblock  96×64    renderable=true ready=true
  ancestor / ancestorBake = null
  → uTextureDim = (72, 128, 96, 64)

  base batch 表 11 条，xywh 前 5 组（像素）：
    (48,0,24,16) (48,16,24,8) (0,64,12,32) (0,96,12,32) (48,24,12,8)
    与本级 _subTexInfos 逐字一致：1094_3(48,0,24x16) 1130_3(48,16,24x8) 1131_3(0,64,12x32) …
  bake batch 表 1 条：(0,0,96,64)      ← 整张 bake 图集当一个 rect，配 uv2 ∈ [0,1]
```

**要点**：base 与 bake 是**两张不同图集、两套独立 batch 表，条数还不相等**（11 vs 1 / 49 vs 3 / 41 vs 2）。

### 6.4 `.texblock` 子图集文件格式（字节严丝合缝，已进夹具+测试）

```
容器: u32 count=1 | u32 nameLen | String name | u32 unzipSize | u32 zipSize | zlib
内层单条: u32 compressType(14) | u32 width | u32 height | u32 13 | u32 size | DXT5 像素
          size = width*height（1 B/px），20 + size == 解压后总长，一条记录刚好闭合
例：911305599.texblock → 396×768，是根图集 -2022158854.texblock(204×384) 的清晰版
```

- 66 块 291 张根图集：`requestNames` **全空**，但每张都挂 1 个 `childTexNames`；`childTexNames` 里的名字**从不作为图集条目**出现在任何块里。
- 子文件里**没有 subTexInfos**，所以它的 rect 无法从文件直接得到。
- 官方 `requestSubTextures` 的另一条分支是"按子纹理名字逐个请求 `.texblock`"：`xOffset/yOffset` 取根图集的、`width/height` 取子纹理自己的，再 `enqueue({texture, subTextureInfo})` 贴回去；非叶子分支则整体换 `arrayBufferView`。**本数据集不走这条分支**（requestNames 全空）。

---

## 七、还没解决的问题（接手者从这里开始）

### 7.1 主症状

SMID 205 机位下 confetti：每格是一整栋微缩建筑照片，重复几十遍 + 透明洞。官方同机位是干净实体建筑。

### 7.2 已排除

- rect 约定（§3.5 双证据钉死）
- 绑定划分：2257 顶点上 unit0 31 条 / unit1 6 条绑定是**严格划分**，0 未覆盖、0 重叠
- UV 通道配对：`uv` 是世界尺度投影坐标（可 ±140、非 [0,1]），`uv2` 才是干净 [0,1]，与官方 base/bake 分工一致
- 材质矩阵：所有 `texmodmatrix` 都是单位阵，`addressmode = {u:0,v:0,w:0}`
- alphaMode 门控：全是 `opaque`，不能据此关 alphaTest

### 7.3 最后一条已知事实（关键）

浏览器里已确认新代码**是活的**：

```
defines = [STANDARD, S3M_ATLAS, S3M_ATLAS_SEC]
map.generateMipmaps = false,  minFilter = 1006 (LinearFilter),  wrapS = 1000 (ClampToEdge)
geometry.attributes: aAtlasRect ✓  aAtlasRect1 ✓  aSecUv ✓
customProgramCacheKey() = "s3m-styled-atlas-bake"
```

**但截图与改动前逐像素一致** → 说明 `mip` 实际算出 ≈ 0，整套层级模拟等于没参与（`mip=0` 时公式退化成 `fract(uv)*scale + translate`，与旧的简单版几乎相同）。

### 7.4 下一步该做的第一件事（我正要跑就被打断，无结果）

从活场景 dump 出镜头下那个网格的：`atlas 尺寸 / uv 范围 / 每顶点 base 矩形 / bake 矩形 / 退化矩形顶点数`，用数字判定 confetti 到底是

- (A) 层级恒为 0（公式输入有问题），还是
- (B) 喂进去的 rect / uv 本身就不对。

现成跑法（前台、结果直接打印）：

```bash
bun run _tmp/atlas/shot.mts \
  --url "http://localhost:5174/demo/?url=https%3A%2F%2Fwww.supermapol.com%2Frealspace%2Fservices%2F3D-OlympicGreen-2%2Frest%2Frealspace%2Fdatas%2FBuilding%40OlympicGreen%2Fconfig" \
  --out _tmp/og/T-dump.png --center 116.37911,39.98772 --zoom 19.2 --pitch 52 --bearing 0 \
  --wait 150000 --port 9550 --profile C:/server/s3m-maplibre/_tmp/atlas/chR \
  --post "<遍历 layer.scene，统计 aAtlasRect/aAtlasRect1/uv 范围与唯一矩形数>"
```

`--post` 里遍历 `layer.scene` 的表达式在会话里已写过一版（`o.geometry.attributes.aAtlasRect` + `material.map.image.width/height` + `material.defines` + `material.secMap`），照抄即可。注意 `secMap` 目前**不在 `material.map` 上**，取 bake 图集尺寸要另找入口。

### 7.5 其他未完成项

1. **脏 UV 未钳**：235,828 个三角形里 **5 个跨度 > 1e6**（`26.s3mblock` 的 `460_3`，顶点 291/292/293，跨度 1,338,232；该绑定 149 顶点里只有 8 个分量离群，中位数 0.50）。片元 fract 会让这几个三角形扫出上百万条纹。
   跨度分布（全数据集 1,438 条绑定）：`<2: 734 / 2-16: 446 / 16-64: 203 / 64-1e3: 52 / >1e3: 3`。
2. **`.texblock` 子图集链**：解析器 + 加载逻辑已写，**默认关**（`S3MTilesetOptions.atlasLod`）。要启用必须先解决"rect 与图集同级配对"——实测比例不固定（1.941×2.000 / 2.000×2.000 / 2.000×1.579），不能简单等比缩放；且官方 `_ancestorTexture` 实测为 null，所以"祖先 rect"这条路也还没证实。
3. **base/bake 两套表条数不同**（11 vs 1）：我们现在是按顶点区间各填一套矩形，结构上等价，但没验证"bake = 整张图集一个 rect"在我们的数据上是否成立。
4. **关掉 GPU mip 后远处会闪烁**（官方靠层级模拟补，而我们的层级模拟目前疑似恒 0）。
5. 尚未把结论沉淀进 `README.md` / `packages/s3m-three/docs/API.md`。

---

## 八、数据事实备查（SMID 205）

```
块：6.s3mblock（OlympicGreen Building，共 79 块 rootTiles，config 顶层键是 rootTiles 不是 tiles）
骨架：000000005A0DB3C0，2257 顶点，pickInfo 结构 = pickInfo[geoName][smid] = {batchId, segments}
包围盒：79 × 532.5 × 188.9 m
uv  ：[-139.228, 140.227] × [-27.439, 28.438]   跨度 279.45 × 55.88（世界尺度，约 3 m/单位，对称于 0.5）
uv2 ：[0.000, 0.992] × [0.000, 0.979]           跨度 0.99 × 0.98
base 图集：-642811019.texblock  120×184  ct=14 pf=21  26 个槽位（12×8 / 24×16 / 12×16）
bake 图集：-1824701334.texblock 108×192  ct=14 pf=21  4 个 96×64 槽位
槽位内容实测：12×16 那片是"蓝天板 + 白女儿墙"的屋顶碎片；96×64 那片是带 alpha 轮廓的结构块
数据集锚点：116.3803842902019, 39.99728846386792；6.s3mblock 中心(-108.68, -814.78) m
  → SMID 205 大致经纬度 116.37911, 39.989918（截图机位取 39.98772 以纳入本楼）
```

对照用的另一数据集：`Building@CBD`（`3D-CBD` 服务，67 块，已下到 `_tmp/atlas/b2/`），症状较轻，适合做翻行/层级公式的回归对照。

---

## 九、待清理产物（工作区别留垃圾）

| 路径 | 体积 | 说明 |
|---|---|---|
| `_tmp/ic/` | ~68 MB | `@supermapgis/iclient3d` 压缩包 + SourceRelease/Workers 解包。`host_safe_delete` 连续返回 `MCP_RUNTIME_UNAUTHORIZED`（运行时鉴权故障，非策略拦截），**需手动清** |
| `_tmp/og/` | ~50 MB | 79 个 OlympicGreen 块、`sdk.js`(11.9 MB)、官方对照页与探针脚本、各张截图 |
| `_tmp/atlas/` | 数 MB | 探针脚本、`b2/`（66 个 Building@CBD 块）、截图 |
| `tests/fixtures/s3mblock/911305599.texblock` | 65 KB | **不要删**，是回归夹具 |

进程：本地 `:8099` 反代（`bun run _tmp/og/serve.mts`，设了 5400 秒超时，可能仍在跑）；`:5174` 是我起的 vite dev；**`:5173` 那个不是我起的，别动**。

---

## 十、本环境操作教训（省时间）

1. **前台跑**，别放后台任务；结果把数字直接贴在对话里，不要只重定向到文件让人自己翻。
2. 长命令一律带 `timeout`；单次 CDP 截图约 2–4 分钟，能合并就合并。
3. 渲染类改动**没在出问题的确切视角做并排验证前，不得称 done**；结论先当假设，错了显式撤回（本文件 §4 就是撤回清单）。
4. 判格式/字节布局有分歧时，读 `@supermapgis/iclient3d` 解包源码，别只信规范和 README；GLSL 要从 `gl.shaderSource` 截运行时原文。
5. 单变量隔离：上一轮我把"关 GPU mip"和"层级公式改写"两个变量叠在一起改，结果无法归因，白跑一轮。
