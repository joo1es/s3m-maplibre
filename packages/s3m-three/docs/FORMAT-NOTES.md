# S3M 格式逆向档案

这份文档记录的是：**哪些字段是确定知道的、凭什么确定、上游一变怎么第一时间发现。**

S3M 没有一份能直接照着实现的完整公开规范。`Specification/S3MB/S3MBBinary.md` 覆盖了 v1/v2 的骨架，但 v3 起（MeshOpt、Draco、S3MBLOCK、CRN、高斯泼溅）大量布局只能从真实瓦片逐字节标定，再拿官方 SDK 的混淆产物交叉对账。这类知识原本散落在七个解析器的头部注释里，改一次代码就得翻七个文件——集中在这里，是为了让下一个人（或者半年后的自己）能在半小时内接手。

**最后核对**：0.4.18 / 2026-10-28。读到与代码不一致时，以代码为准并回来改这份文档。

---

## 一、置信度分级

每个结论都标了级别。**没有标记的一律视为 A 级**。

| 级别 | 含义 | 变了会怎样 |
|:---|:---|:---|
| **A** | 官方源码 + 规范文档 + 实测三方一致 | 基本不会变；变了说明大版本换代 |
| **B** | 实测标定 + 内部不变量闭合（长度链严丝合缝、OBB 与包围球同心、`bytesRead === bytesTotal`） | 有测试兜着，改坏必红 |
| **C** | 实测标定，但样本少（1~2 块），且没有独立的内部闭合可验 | **最危险**，换个数据集就可能不成立 |
| **D** | 字段位置已知、语义未知（能跳过，不能用） | 不影响加载，但对应能力做不出来 |

C 级的处置原则：**只在新样本进来时提高级别，不靠推理提高**。D 级的处置原则：**保留原始字节，不猜语义**。

---

## 二、先判断是哪一种数据

同一个 URL 样式底下可能是三种完全不同的容器。**看两处就够**：`…/rest/realspace/datas.json` 列出的数据源名，和 `…/datas/<数据源>/config` 返回的是 JSON 还是 XML。

| 形态 | config | 瓦片 | 解析器 |
|:---|:---|:---|:---|
| S3M 瓦片缓存（主流） | JSON（`rootTiles` / `position.point3D` / `geoBounds`） | `.s3mb` v2 / v3 / v3.01，或 `.s3mblock` | `S3MBParser` / `S3MBlockParser` |
| SuperMapCache / S3M 1.x | **XML**（`<SuperMapCache>`，`sml:FileType = OSGBFile`） | `.s3m`（整棵 LOD 树同一种容器） | `S3M1Parser` |
| 高斯泼溅 | JSON，`dataType = "3DGaussianSplatting"` | `.s3mb` v3.01 + MeshOpt，**无索引包** | `S3MBParser` + `MeshOpt` |

**S3M 1.x 必须靠魔数分流，不能靠配置。** 头 4 字节 `73 33 6D 00`（`"s3m\0"`）紧接 `78 da` 的 zlib。不分流的话，头 4 字节会被 float32 读成 1e-38 的「版本号」，再把 zlib 头当长度，报出来的是 `RangeError: Invalid typed array length` —— 一个彻底误导人的错。

---

## 三、S3MB v2 / v3 / v3.01

实现依据：`SuperMap/s3m-spec` 的 `S3M_SDK/S3M_JS/S3M_module/S3MParser/S3ModelParser.js`（Apache-2.0）+ `Specification/S3MB/S3MBBinary.md`。 —— **A 级**

与官方实现的三处已知分歧：

1. **官方 v3 非压缩分支把整个 ArrayBuffer（含文件头）当数据流** —— 官方 bug，这里按偏移读。
2. **`position` 的键名在 v3.01 换过**：老数据是 `position.x/y/z` + `units`，v3.01 是 `position.point3D` + `unit`。两个键名都得认，否则**投影单位是米的数据会被当成度**，模型甩到几千公里外。（B 级，实测）
3. **`geoBounds` 与 `position` 偶尔不一致**（生产时的占位值）。`_resolveAnchor` 的处置：偏移超过 0.5° 时改用 `geoBounds` 中心并告警。但反向不成立 —— 全 0 的退化 `geoBounds` 不能反过来否定一个正常的 `position`，那等于把模型甩到 (0,0)。（C 级）

### 3.1 骨架条目边界（B 级，重要）

v3.01 的多骨架瓦片里，**每块骨架自带的 `skeletonStreamSize` 是权威边界**；OBB 一律按「条目末尾 96 字节」定位，读完对齐到条目末尾。

**不要用「读出来像不像包围盒」做启发式。** 实测踩过的坑：子瓦第 3 块骨架在几何段与末尾 OBB 之间比别块多 4 字节填充，按启发式读出来的框是 `center(0,0,0) + extent 2.0/4.0` —— 有限、量级正常，于是放行，整条流从此偏 4 字节，下一块的 `skeletonStreamSize` 读成 1072419456、名字长度读成 13360，最后抛「未知骨架标记 0」。整套高斯数据加载失败，而报错位置离真正的错位点差了几万字节。

`readV3BoundingBox` 的启发式现在只挡「非有限 / 超地球量级」的垃圾值，边界判定交给长度链。测试用「OBB 中心 == pageLOD 里 geode 的包围球中心」来证明是**读对位置**而不是蒙对了一个有限值。

---

## 四、S3M 1.x（SuperMapCache，`.s3m`）

四块真实瓦片（root / L16 / L17 / L18）交叉标定，长度链在链尾精确闭合。 —— **B 级**

```
byte[4] 's3m\0' + zlib
  解压后：
  uint32 xmlSize; byte[] XML; <补齐 4 字节>
  uint32 geoSize;  几何流
  uint32 4;        uint32 0        // 固定小段，实测恒 0
  uint32 texSize;  纹理流

几何流：uint32 meshCount，然后每块网格
  uint32 geoName; uint32 7; uint32 772; uint32 V; uint32 0
  V × 16B   顶点 (x, y, z, w)，实测 w ≡ z
  uint32[6] 数组头 [0, 0, 0, kind=1, count=V, flag=2]
  V × 8B    UV (u, v)
  uint32[3] 索引头 [1, indexCount, 0x00040100]
  indexCount × uint16                 // 恒为 3 的倍数，最大 V-1
  u32 1, u32 materialId               // 与 XML 材质号一致
```

三条互相印证的不变量：`indexCount` 恒被 3 整除、最大索引恰为 `V-1`、逐 LOD 几何都落在 XML 的包围球内。

三个必须记住的坑：

1. **没有法线数组**（全段扫 `|v|≈1` 最长游程只有 4~10 个）→ 必须 `computeVertexNormals()`。
2. **头里的 `format=14` 不是 `S3MPixelFormat`**（那个枚举里 14 = BGRA = 4 B/px）。照搬就把 0.5 B/px 的 DXT1 当 4 字节读 → 满屏彩噪。按 `size / (w·h)` 反推。
3. **UV 的 `v=0` 对应文件首行**，与 DXT 解码内部那次 GL 方向的 Y 翻转方向相反 → 不抵消就正好采到图集空的那半张（区域均值亮度 5.6 vs 76.1），模型一片黑块。所以置 `flipY`。

另外两件事：

- **XML 里 `RangeDataList` 写的 `.osgb` 不参与寻址**。那只是切片时的原始文件名，服务实际发布的是**同名换 `.s3m` 后缀**，路径 `datas/<数据源>/data/path/<瓦片目录>/<名>.s3m`（L16/L17/L18 实测全部 200，`?sceneName=` 不参与）。所以整棵树是同一种容器，不需要 OSG Binary 解码器。
- **XML 后面那几个 `0x30` 是对齐填充**（2~3 个，取决于 XML 长度），不是固定标记。早期文档把它当成了 `byte[3] "000"`。

---

## 五、S3MBLOCK / texblock（纹理分包）

从 `3D-CBD/Xiaopin@CBD` 逐字节标定，并与官方 `@supermapgis/s3m-content-loader` 的 `S3MBlockBufferLoader` 交叉验证。 —— **B 级**

容器：

```
float32 blockVersion              // 2.1
uint32 groupCount                 // RO 组数，实测 1
  每组重复：
  String  name                    // "0.s3mblock"
  if blockVersion <= 3.0: uint32 pageLodCount，每组 {float32 rangeValue; uint16 rangeMode; f64 sphere}
  ...（组内是 zlib 压缩的 v2 瓦片体 + 内嵌纹理图集）
```

关键语义：

- 纹理**不跟瓦片走**，作为「图集」内嵌在块里，材质通过图集 id（如 `-667946976.texblock`）引用，几何顶点的 UV 绑定到图集的子区域 → 解析时要把 UV 重映射进图集空间，多图集走货架式装箱（`AtlasPack`）。
- **根块（`6.s3mblock`）的图集是内嵌的**（`isSaveData=1`）；但**子瓦（`6_00` / `6_01`）的图集段只有元信息**：`data = null` + `requestNames`，像素在同目录的 `.texblock` 里。不补这一步的后果不是「糊一点」，而是**子瓦整块无贴图**——`tile.textures` 里根本没有这条纹理，建筑变成纯白几何。
- **只认 `requestNames`。`childTexNames` 是下一级 LOD 的图集指针**，它有自己的 `subTexInfos`：同一个精灵在父级叫 `1460_3`（96×64）、子级叫 `1460_2`（192×128），排布也不一样。拿父级的 rect 去套子级像素必然错位 —— 上一版就是这么把画面搞坏的。官方从不拿它换像素，那个 LOD 的瓦片自己会加载。
- leaf 多精灵的图集没有整图像素，只有 `subTexInfos` 里每块一个 rect，按 `subName` 把精灵贴回各 rect 组合成整张自上而下 RGBA 画布（`composeLeafAtlas`）。精灵自带「左 2/3 base + 右 1/3 内联 mip 金字塔」，与 `StyleMaterial` 的 `s3mAtlasLod` 2/3 采样公式配套，rect 一个像素都不用改。

---

## 六、MeshOpt 分支（v3.01 几何压缩）

规范里的 `CompressedDataPackage` 描述**已经落后于 v3.01 的实际数据**，布局从真实瓦片逐字节标定。 —— **B 级**

与官方 `S3M_JS` SDK 的两处分歧：

1. **官方 `parseMeshOptSkeleton` 在描述字符串后多推进 4 字节**，导致后续索引包全部错位（实测 v3.01 数据必然崩在 `parseMeshOpIndexPackage`）。按数据实际布局读。
2. **官方把「源字节长度」当 meshopt 的 filter 参数传进去**，等于不滤波。这里 normals 走八面体解码，UV / 位置按各自量化常量还原。

量化公式（用 OBB 反推验证过，误差 0）：

```
position = minVerticesValue + uint16 * vertCompressConstant
texcoord = minTexCoordValue[i] + uint16 * texCoordCompressConstant[i]
normal   = octDecode(int16 / 32767)
```

**顶点语义是位标记，不是枚举序号。** 自定义流（`CUSTOM0` / `CUSTOM1` / `GS_SCALE` / `GS_ROTATION`）原样保留解码结果，语义由数据自带的 `vertexAttributeDescript`（名字 → 槽位）给出。

---

## 七、Draco 分支（v3.01 点云压缩）

**规范里的 Draco 分支描述和实际数据对不上**，字段顺序是从真实瓦片逐字节标定（两个瓦片、5 个骨架完全一致，并用 `payloadSize` / `dracoSize` / `"DRACO"` magic / `skeletonStreamSize` 四重自校验）。 —— **C 级：样本只有两块瓦片。**

官方 `parseDracoSkeleton` 解析不了同一个服务：多了 `materialCount`，且 `version === 3` 的判定对 v3.01 不成立。

```
u32  payloadSize          // 覆盖 [本字段之后 .. 条目末尾 OBB 之前]
u32  unknown = 32         // 实测恒 32，语义未知（D 级）
i32  posUniqueId          // POSITION；-1 = 无
i32  normalUniqueId
i32  colorUniqueId
i32  secondColorUniqueId
u32  texCoordCount                    // 自定义属性个数，实测 3
i32  texCoordUniqueIds[texCoordCount]
u32  vertexAttrCount                  // 实测恒 0
u32  dracoSize
byte draco[dracoSize]                 // 标准 draco 比特流，前 5 字节 "DRACO"
pad4
String descript           // {"PointCloudClassCode":2,"PointCloudIntensity":1,"VertexWeight":0}
pad4
f64  obb[12]              // 由 parseSkeletonEntries 按条目末尾统一读
```

`descript` 的 value 是**自定义属性在 `texCoordUniqueIds` 里的下标**，不是分量数：`VertexWeight → uid2`(float 高度)、`PointCloudIntensity → uid3`、`PointCloudClassCode → uid4`。**uid1 没被 descript 引用**（实测是 0~29 的 uint32，用途不明，D 级）。

回归测试：`tests/unit/draco.test.ts`，fixture 是 `pointcloud.s3mb`（单骨架 6149 点）和 `pointcloud-multi.s3mb`（4 骨架 —— 多骨架才是藏 bug 的地方）。断言 `bytesRead === bytesTotal`、属性清单、自定义映射。**改字段顺序这几条必红。**

---

## 八、纹理

### 8.1 「是不是 CRN」只能看 `compressType`

纹理头里两个字段特别容易搞混 —— **A 级，实测三组组合**：

| 版本 | `compressType` | `pixelFormat` | 实际 |
|:---|:---|:---|:---|
| v3.00 | 26 | 13（ABGR，无意义） | CRN，数据以 `Hx` 开头 |
| v3.00 | 14 | 21 | DXT5 裸块 |
| v3.01 | 50000 | 32856（GL_RGBA8，也不是 DXT） | CRN，数据以 `Hx` 开头 |

- v3.00 的 `compressType` **直接借用了 PixelFormat 的数值**（26/27 = CRN）。
- v3.01 改成了 GL 压缩枚举：33776 DXT1、33779 DXT5、38000 WEBP、38001 CRN、38002 KTX2，外加自定义的 50000（CRN_DXT5）。

**按 `pixelFormat` 26/27 判断 CRN 的话，真实服务里的 CRN 纹理会被当成未知格式整包丢掉，模型变成无贴图灰模。** 这个坑踩过一次。

### 8.2 CRN

`pixelFormat` 26/27 是 crunch 的熵编码容器，不是裸 DXT 块。必须先转码回 DXT 才能上传 —— 用内联的 `crunch_decoder` wasm，只取第 0 层（其余交给 three 生成），然后交回现有 DXT 链路。

iServer 在「纹理压缩 = CRN_DXT5」时会把整包纹理都压成这个格式，**不是边角情况**。实测跑过：`3D-BianDianZhan3`（512², v3.00）、`3D-BIMTreeModel` / `3D-local3DCache-SubwayStationCombined`（32²/64², v3.01）、`3D-scyx`（1024²）。

### 8.3 DXT 与 flipY

DXT 块走 `CompressedTexture` 直传，GPU 硬件解压（需要 `WEBGL_compressed_texture_s3tc` 与 `s3tc_srgb` **两个**扩展；缺 srgb 变体会让 SRGBColorSpace 的贴图发白）。移动端大多没有 s3tc，回退 Worker 解成 RGBA。

压缩纹理不能 `generateMipmaps`，得用数据自带的 mip 或用 2/3 采样公式。S3M 1.x 的 UV 需要注意 8.3 之外的那次 Y 翻转（见第四节）。

### 8.4 KTX2 / Basis —— 不是「不支持」，是基本不会出现

官方 `S3MPixelFormat` 枚举里没有 KTX2 / Basis 条目，iServer 也不会发。真要支持得引入 `basis_transcoder.wasm`，但没有数据样本可测。

---

## 九、3DGS 泼溅参数（已标定，A 级）

**曾经是本文档最大的未解项，现在解了。** 结论不是靠统计猜的，是从官方 worker
`SuperMap3D/Workers/GaussianSplating.js`（3.9 KB）里逐字读出来的：

```js
function j(t){                                     // scale
  a[n*3+0] = Math.exp(t[n*4+0]/16 - 10)
  a[n*3+1] = Math.exp(t[n*4+1]/16 - 10)
  a[n*3+2] = Math.exp(t[n*4+2]/16 - 10)
}
function D(t){                                     // rotation
  c = t[n]/127.5 - 1; f = t[n+1]/127.5 - 1; x = t[n+2]/127.5 - 1
  s = Math.sqrt(Math.max(0, 1 - (c*c + f*f + x*x)))
  a[n] = s; a[n+1] = c; a[n+2] = f; a[n+3] = x      // (w, x, y, z)
}
```

| 流 | 编码 | 语义 |
|:---|:---|:---|
| `gsScale` (4 B) | 3 个 u8 | `exp(byte/16 - 10)` 米。值域 [4.5e-5, 380] 米 |
| `gsRotation` (4 B) | 3 个 u8 | `(b/127.5 - 1)` 得 x/y/z；w 由单位化补出 |
| 两条流的第 4 字节 | —— | **填充，官方完全不用** |

**为什么当初看它像乱码**：第 4 字节确实不参与解码，于是同一瓦片里它一会儿是 0、
一会儿是 207（填充残留）。把它当 32 位整数或第 4 个分量去套，怎么都对不上。
只取前 3 字节、w 由单位化补出，立刻就是干净的四元数。

两条判定分支，靠数据自己区分：

| 条件 | 分支 | 公式 |
|:---|:---|:---|
| `isSPZCompress && version === 1.1` | smallest-three | 10-10-10-2 打包，最大维由单位化补 |
| 其余（**当前线上数据都是这条**） | `D()` | 3 个 u8 直接归一化 |

**判据是四元数模长残差**：`D()` 分支下 `|q|²` 等于 1 到 float32 精度（实测 2.2e-16，
个别 8e-3 是 u8 量化本身的误差）；把同一份数据按 smallest-three 解，残差会到 1e-1 量级。
实现里两条都写了（`decodeRotation` / `decodeRotationSmallestThree`），测试用残差钉住选择。

落点：`core/GaussianSplat.ts`（解码 + 协方差）、`render/SplatMaterial.ts`（实例化四边形）、
`GeometryBuilder` 里「有 gsScale/gsRotation 就画泼溅，否则退回 Points」的分流。

> **降级只在数据不自洽时才报**：声明是 3DGS、骨架里却没有这两条流。参数完整的数据
> 走正常泼溅路径，不再产生 `gaussian-splatting-points`。机制本身（`stats.degradations`
> / `unsupported`）保留，见 `API.md#降级上报degradations`。

## 九之二、仍未标定的字段（D 级）

**保留原始字节，不猜语义。**

| 字段 | 现状 | 影响 |
|:---|:---|:---|
| Draco `uid1` | 实测 0~29 的 uint32，未被 `descript` 引用 | 未知，跳过不影响解码 |
| Draco `unknown = 32` | 实测恒 32 | 未知，跳过不影响解码 |

---

## 十、复验手册

### 10.1 上游一变，按这个顺序查

```bash
# 1. 单元测试：真实瓦片 fixture，不需要网络，最快
NODE_OPTIONS= bun test ./tests/unit/parser.test.ts ./tests/unit/draco.test.ts \
  ./tests/unit/gaussian-splatting.test.ts ./tests/unit/s3mblock.test.ts

# 2. 60 个真实瓦片的 MeshOpt 结构校验（需要网络，走 SuperMap Online 公有服务）
node tools/meshopt-check.mjs --preset shenyin

# 3. 官方解析器当 oracle 对账（同一份样例，逐段比较）
node tools/official-oracle.mjs

# 4. 逐字段追踪单个瓦片，定位第一个对不上的偏移
node tools/trace-one.mjs <tile.s3mb>
```

### 10.2 七条关键不变量

解析坏了，先看这几条哪条不成立——它们把「读错位」和「数据本身有问题」区分开：

1. **`bytesRead === bytesTotal`** —— 整块流不多不少吃完。字段顺序读错，这里第一个炸。
2. **索引数量恒被 3 整除，最大索引 = `V-1`** —— 几何段边界读对了吗。
3. **每块骨架的 OBB 中心 == `pageLOD` 里 geode 的包围球中心** —— 证明读对了位置，而不是蒙对了一个有限值。
4. **分块边界链**：`skeletonStreamSize` 逐块累加严丝合缝落到条目末尾（实测 `1660+4+25396=27060`、`27060+4+32204=59268`、`59268+4+76252=135524`）。
5. **量化还原后的顶点包围盒 == OBB extent**（`meshopt-check.mjs` 逐项校验）。
6. **S3M 1.x 的三段长度链落到解压末尾**，`0x30` 填充数 = `(4 - xmlSize % 4) % 4`。
7. **纹理尺寸 == 头里的 `w × h`**，且 `size / (w·h)` 推出的字节数 = 格式的 B/px。

### 10.3 加新格式的规矩

1. **先拿真实瓦片**，至少要两个（一个根、一个细化子瓦）。只有一个样本的结论是 C 级，不要往文档里写成 B。
2. **找内部不变量**。长度链闭合、几何与包围球一致、属性个数与 descript 对得上 —— 有闭合才算标定完成，否则只是「能跑」。
3. **和官方混淆产物对账**（`official-oracle.mjs`）。官方错的地方也记下来，那是下次快速识别的指纹。
4. **先写测试再写实现**（见 `AGENTS.md`）。测试要断言不变量，不要复述实现。
5. **不确定的字段进第九节**，标注 D 级，保留原始字节。

---

## 十一、样本清单

仓库内的 fixture（离线，单测用）：

| 路径 | 大小 | 覆盖 | 对应的坑 |
|:---|:---|:---|:---|
| `tests/fixtures/draco/pointcloud.s3mb` | — | 单骨架 6149 点 | Draco 容器字段顺序 |
| `tests/fixtures/draco/pointcloud-multi.s3mb` | 96K（两块合计） | 4 骨架 | 多骨架边界、自定义映射 |
| `tests/fixtures/gaussian-splatting/Tile_0019…` | 184K（两块合计） | 3DGS 根瓦片（单骨架 1888 点） | `rangeMode=2`、`childTile` 路径 |
| `tests/fixtures/gaussian-splatting/Tile_0020…` | ↑ | 3DGS 子瓦（4 骨架 9448 点） | **+4 字节填充错位**、无索引包按 Points 出图 |
| `tests/fixtures/s3mblock/` | 936K | S3MBLOCK + 内嵌图集 | 图集 UV 重映射 |
| `tests/fixtures/osgb/` | 68K | S3M 1.x (`.s3m`) | 无后法线、`format=14`、UV flipY |

外部样例（需要网络，CI 里 `S3M_REQUIRE_SAMPLES=1` 强制执行，不设就 skip —— 静默 skip 比失败更危险）：

- `../s3m-spec/S3M_SDK/S3M_JS/data/` —— 官方 9 个样例（v1 / v2 / v3）
- SuperMap Online 公有服务 `3D-ShouNingGe`（3DGS）、`3D-CBD/Xiaopin@CBD`（S3MBLOCK）、`3D-scyx` / `3D-BianDianZhan3`（CRN）

---

## 十二、和官方 SDK 的分歧清单

按「官方错、我们对」记录。下次遇到新数据先查这张表，很可能又是同一类问题。

| 位置 | 官方实现 | 实际数据 | 后果 |
|:---|:---|:---|:---|
| `parseMeshOptSkeleton` | 描述字符串后多推进 4 字节 | 不推进 | 后续索引包全错位 |
| MeshOpt filter 参数 | 传源字节长度 | 应按各自量化常量 | 等于不滤波，精度丢失 |
| `parseDracoSkeleton` | 多读 `materialCount`；`version === 3` 判定 | 无此字段；v3.01 不满足 | 官方解析不了自己的 v3.01 点云服务 |
| v3 非压缩分支 | 整个 ArrayBuffer 当数据流 | 要从文件头之后开始 | 官方 bug |
| S3M 1.x 几何头 `format` | 当 `S3MPixelFormat` 用 | 是另外一套编码 | 把 DXT1 当 BGRA 读，满屏彩噪 |
| `PageLod.calcPixFromCam` | —— | **这条是官方对的，我们照抄** | 见下 |

> `calcPixFromCam` 的公式里有两个容易漏的细节：视场角是**写死的 45°**（`tan(22.5°)`），不取渲染器实际 fov；末尾那个 `*2`（用直径量屏幕尺寸）不能少。少这个 `*2` 会让 metric 只有官方的一半，`needRefine` 门槛永远差一级——表现是「贴着看也一直在渲染最粗的根图集，一张整楼雪碧被 uv 平铺几十遍」。实测瓦片 `6_01`：radius 293.4、rangeValue 586.8、distance ≈ 824 m、H = 854 → 官方算 734 > 586.8 该细化，旧公式只有 326。
