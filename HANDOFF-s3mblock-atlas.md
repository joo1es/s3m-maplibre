# S3MBLOCK 图集渲染对齐官方 —— 交接文档

> 生成时间：2026-10-25（Asia/Shanghai）
> 任务：`s3m-maplibre` 的 S3MBLOCK（TextureSharing）贴图渲染对齐 SuperMap iClient3D 官方效果
> 目标验收基准：OlympicGreen Building 图层 SMID 205，与官方同机位并排一致

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
| "图集子区域自带内联 mip 链（base 占 2/3 宽）" | **无依据**。`(48,0,24,16)` 右边紧挨的是 `(48,16,24,8)`，subName 是另一张子纹理 `1130_3`，不是它的 mip。`width *= 2/3` 只是算 `maxMip` 的经验收缩系数 |
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
