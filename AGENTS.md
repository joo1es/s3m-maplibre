# AGENTS.md

给 AI 编码代理（以及新加入的人）的项目说明。**动手前先读第 2 节的三条不变式**，它们比任何代码风格都重要。

---

## 1. 这是什么

Monorepo，两个会发布到 npm 的包：

| 包 | 版本 | 职责 |
|---|---|---|
| `packages/s3m-three` | 0.4.x | 宿主无关的渲染内核：S3MB 二进制解析、瓦片调度、three.js 材质/拾取/动画。不依赖地图，纯 three.js 场景也能用 |
| `packages/s3m-maplibre` | 0.4.x | MapLibre / Mapbox 适配层：`S3MLayer`、投影换算、与宿主的逐帧协作。依赖 `s3m-three` |

两个包共用 x/y、只有 z 各自独立，改版本一律用 `bun run release`，见[版本规则](#53-版本规则x--y-共享z-独立)。

其余目录：

```
tests/unit/      单测（bun test），本项目的主战场
tests/e2e/       需要真实网络的端到端用例
tests/helpers/   样例数据定位（sample.ts）、meshopt 瓦片构造
site/            demo / docs 的源码（Solid + Vite），产物落到 demo/ 和 docs/
tools/           自检脚本与静态服务（serve.mjs，端口 8123）
demo/  docs/     构建产物，**已纳入 git**
```

---

## 2. 三条不变式

### ① 默认行为不变

新增能力一律**默认关闭**，只有显式传参才生效。参数默认值用 `Infinity` / `null` / 不传即保持原口径，并且要保证「不传参时代码路径与改动前逐字一致」。

这条不是洁癖：`s3m-maplibre` 已经有线上使用者，一次默认值变动就是一次线上事故。已有先例：

```ts
lodPixelRatioCap?: number;   // 默认 Infinity = 不截断
maxTriangles?: number;       // 默认 Infinity = 不限制
maxTextureSize?: number;     // 默认 Infinity = 不缩放
anisotropyCap?: number;      // 默认 Infinity = 取 GPU 最大值
maxImageCache?: number;      // 默认 128 = 原写死值
materialQuality?: 'pbr' | 'lambert';   // 默认 'pbr' = 原材质
nearPlaneScale?: number;     // 默认 1 = 不缩放
```

### ② 先写测试，再写实现

见第 3 节。

### ③ 不碰 `dist/`，不手动发布

- `dist/` 由 `bun run build` 生成，已在 `.gitignore` 里，**不要提交、不要手改**。
- npm 发布**只通过打 tag 触发 CI**（第 5 节）。本地 `npm publish` / `npm login` 这条路已经验证走不通（token 过期、CI 用 OIDC provenance），不要浪费时间重试。
- `packages/s3m-maplibre/package.json` 里的 `"s3m-three": "workspace:*"` 由 `prepublishOnly` 在发布时临时替换成 `^x.y.z`，**不要在仓库里手动改**。

---

## 3. 先写测试，再写功能

顺序固定：**写失败测试 → 跑一遍确认它确实失败 → 写实现 → 跑到全绿**。不要先写实现再补测试，补出来的测试只会复述实现，抓不到错。

### 落点

| 改动类型 | 测试文件 |
|---|---|
| 新增能力 / 开关 | `tests/unit/<主题>.test.ts`，新建 |
| 修 bug | 优先补进 `tests/unit/regressions.test.ts`，文件名就说明它是回归 |
| 纯数学（投影、矩阵、层级选择、预算） | 独立文件，只依赖纯函数，不碰 WebGL |
| 需要真实瓦片 / iServer | `tests/e2e/`，CI 里不跑 |

### 新测试至少要覆盖什么

1. **默认不生效** —— 不传参时构造出来的对象字段、行为、调用路径与旧版一致。
2. **边界** —— `0` / 负数 / `Infinity` / `NaN` 怎么归一；离屏 `canvas`、缺失字段怎么兜底。
3. **结构不变量** —— 比如淘汰瓦片时「不能在画面上开洞」、接了 `flipY` 的值就不会镜像。
4. 涉及 shader 注入的，**断言 three 的模板里确实存在被 `replace` 的那个 include 名**。`replace('#include <xxx>')` 在 three 改名后会静默 no-op，材质照样渲染，只是样式静默失效。

### 命令

```bash
NODE_OPTIONS= bun run typecheck          # 三个 tsc：two packages + 根 tsconfig
NODE_OPTIONS= bun test ./tests/unit      # 单测，本项目要求全绿
NODE_OPTIONS= bun test ./tests/unit/xxx.test.ts   # 单个文件，写测试时反复用这个
NODE_OPTIONS= bun test                   # 含 e2e，需要网络
```

**交付标准**：`typecheck` 通过 + `bun test ./tests/unit` 全绿（当前基线 363 pass / 0 fail）。有一条红就不算完成，也不要在报告里说「基本通过」。

样例数据是可选的：`tests/helpers/sample.ts` 会去 `../s3m-spec/S3M_SDK/S3M_JS/data/` 找官方 `.s3mb`，找不到就 skip 整组解析断言。CI 里设了 `S3M_REQUIRE_SAMPLES=1`，样例没拉下来直接判失败——因为静默 skip 比失败更危险。

---

## 4. 本地开发

```bash
NODE_OPTIONS= bun run dev      # site 源码热更新
NODE_OPTIONS= bun run build    # 全量：three → maplibre → docs → demo
NODE_OPTIONS= bun run serve    # 静态服务，http://localhost:8123/s3m-maplibre/...
```

常用 URL 参数（demo 里内置的调试开关）：

```
?ortho=local | ?ortho=global   正交：仅模型 / 全局接管
?vector=1&mvt=<TileJSON|模板>  叠加 MVT 矢量底图 + fill-extrusion 建筑
?nos3m=1                       只留底图，隔离问题
?orthoDebug=1                  校验接管后 viewProj 的 w 行是否为 (0,0,0,1)
?edges=gpu                    棱线画法：line | offset | hull | gpu，可叠加（gpu+line、line+hull）
```

### 本机环境坑（Windows）

- shell 里被注入了 `NODE_OPTIONS=--use-system-ca`，会让 `bun` / `pnpm` / `npx` **静默失败**。所有命令前面加 `NODE_OPTIONS=`。
- Bash 工具跑在 Job Object 里，命令结束会连带杀掉它启动的所有后代进程；要用 `explorer.exe '<绝对路径>'` 启动常驻 GUI。
- `taskkill //PID` 在 Git Bash 里参数会被转义坏，用 psutil 的 `terminate()`。
- 在沙箱里访问境外的 MVT / 瓦片源大概率超时，**不要**用「截图看不到东西」来判断代码错了；优先用无头浏览器读 DOM 里的诊断字段，或者直接写数学单测。

---

## 5. 部署

### 5.1 在线演示与文档 —— GitHub Pages（`.github/workflows/deploy.yml`）

触发条件：**push 到 `main`**、打 `v*` 标签、或手动 dispatch。

流程：`bun install --frozen-lockfile` → `bun run build` → 把 `demo/` `docs/` `packages/` 拷进 `_site` 并生成落地页 → 部署。

```
https://joo1es.github.io/s3m-maplibre/docs/index.html
https://joo1es.github.io/s3m-maplibre/demo/index.html
```

**注意**：Pages 用的是仓库里**已提交的** `demo/` 与 `docs/`（CI 虽然会重新 build，但落地页拷的是工作区里那份）。所以改完源码要：

```bash
NODE_OPTIONS= bun run build      # 重建 demo/ 与 docs/
git add demo docs                # 产物一起提交，否则线上还是旧页面
```

`demo/assets/` 在 `.gitignore` 里（hash 文件名，由构建生成），只提交 `demo/index.html` 等入口。

### 5.2 npm 发布 —— **打 tag 就是发布**（`.github/workflows/publish.yml`）

这是最容易搞错的一步：**不需要在本地跑 `npm publish`，push 一个 tag 上去，CI 就会发。**

```bash
# ① 改版本（两个包的 x/y 必须一致，用脚本改，别手改）
NODE_OPTIONS= bun run release patch        # 或 minor / major / --align
# ② 打 tag（脚本结尾会把这两行原样打出来）
git tag s3m-three@0.4.15
git tag s3m-maplibre@0.4.15
# ③ push tag（GitHub 走代理，见下）：两个连着推，不要等 npm 出现新版本
```

tag → 包的映射：

| tag | 发布对象 |
|---|---|
| `s3m-three@<version>` | `packages/s3m-three` |
| `s3m-maplibre@<version>` | `packages/s3m-maplibre` |
| `v<version>` | `s3m-maplibre`（0.2.x 时代的 legacy 别名，别再用） |

CI 里的硬性校验（触发失败会直接中止，不会发出半个包）：

1. **标签版本必须等于 `package.json` 的 version**，防止改完代码忘了改版本号。
2. 两个包的 x/y 必须同步（`node tools/release.mjs --check`）。
3. 构建 + typecheck + `bun test` 必须过。

**不再校验「依赖是否已在 npm 上」**：npm 元数据缓存约 10 分钟才刷新，那个 `npm view` 会稳定误判刚发出去的内核，逼人 Re-run 一次。两个 tag 连着推、各自独立发就行 —— `s3m-maplibre` 的依赖写成 `^x.y.z`，使用方安装时内核必然已经在 npm 上了。

**不要等 npm 出现新版本再推第二个 tag。** 两个 tag 连续推完就行：

- npm registry 的元数据缓存大约 **10 分钟**才刷新，这期间 `npm view` / `curl registry.npmjs.org/<pkg>/<ver>` 可能一直是 404。拿它当「发完了没有」的判断依据，只会白等十几分钟，还容易误判成没发出去。
- 判断发没发成功，只看 Actions 里 `Publish to npm` 的 job 状态，不要看 registry。

发布完成后自动创建 GitHub Release（`generate_release_notes`）。

**关键差异，务必记住**：

- `publish.yml` 现在会跑 `bun test`（和 `ci.yml` 一样会给 `S3M_REQUIRE_SAMPLES=1` 拉官方样例），所以测试挂了发不出去。但**本地仍然先跑一遍** —— tag 推上去之后 CI 才告诉你失败，这时 tag 已经推出去了，只能删 tag 重打。
- `publish.yml` 的认证走 `secrets.NPM_TOKEN` + OIDC provenance（`npm publish --access public --provenance`），**本地不需要、也不应该做 `npm login`**。
- `push main` 只触发 CI + Pages，**不发 npm**。发 npm 的唯一入口是 push tag。

push（本机必须走代理，否则 GitHub 超时；凭据要用系统 Git 自带的 GCM，PortableGit 的读不到 Windows 凭据管理器）：

```bash
"/c/Program Files/Git/cmd/git.exe" \
  -c 'credential.helper=!"C:/Program Files/Git/mingw64/bin/git-credential-manager.exe"' \
  -c http.proxy=http://127.0.0.1:10809 \
  -c https.proxy=http://127.0.0.1:10809 \
  push origin main

# tag 单独推
"/c/Program Files/Git/cmd/git.exe" \
  -c 'credential.helper=!"C:/Program Files/Git/mingw64/bin/git-credential-manager.exe"' \
  -c http.proxy=http://127.0.0.1:10809 \
  -c https.proxy=http://127.0.0.1:10809 \
  push origin s3m-three@0.4.15 s3m-maplibre@0.4.15
```

### 5.3 版本规则：x / y 共享，z 独立

`s3m-three` 与 `s3m-maplibre` 的版本号是 **`x.y.z`，其中 x（大版本）与 y（minor）两个包共享，只有 z（patch）各自独立**。

| 场景 | three | maplibre | 说明 |
|---|---|---|---|
| 只改图层 | `0.4.15` | `0.4.16` | 常态：图层侧改动远多于内核，内核不该为对齐空发版本 |
| 只改内核 | `0.4.16` | `0.4.16` | patch 各自走，撞在同一个号上纯属巧合 |
| 两包都改 | `0.4.15` | `0.4.16` | 各自 +1 |
| 世代升级 | `0.5.0` | `0.5.0` | x/y 是共享位，**必须一起**，不允许只动一个 |

为什么 x/y 必须共享：它们表达的是「API 世代」，使用方要一眼看出两个包配不配。而 z 独立是因为发布时 maplibre 的依赖会被写成 `^0.4.N` —— caret 在 0.x 上锁 minor，所以**改 `three` 的 minor 必须同时发 `maplibre`**，否则使用方会拿到装不上的组合；patch 就没有这个连带关系。

改版本只用脚本，不要手改两个 `package.json`（还要同步 `bun.lock`，漏了 CI 的 `--frozen-lockfile` 会失败）：

```bash
node tools/release.mjs                 # 体检：当前版本、是否同步、tag 占用、工作区状态
node tools/release.mjs --check         # 只校验同步关系，不一致退出码 1（CI 里跑这个）
node tools/release.mjs patch           # 两包各 +1
node tools/release.mjs patch --only maplibre    # 只动图层
node tools/release.mjs patch --align   # 先把历史漂移收拢，再递增（0.3.14/0.4.14 → 0.4.15/0.4.15）
node tools/release.mjs minor           # 两包一起 0.5.0
```

脚本做的事：改两个 `package.json` → `bun install` 同步 `bun.lock` → 检查目标 tag 没被占用 → 打印 tag 与 push 命令。**它不改文件之外的任何东西：不建 tag、不提交、不推送**（`--commit` 只提交，仍然不 push）。

规则实现是 `tools/release-plan.mjs` 里的纯函数，测试在 `tests/unit/release-version.test.ts`。`ci.yml` 与 `publish.yml` 都加了 `node tools/release.mjs --check`，所以 x/y 不同步的提交过不了 CI，也发不出去。

**一次性的历史代价**：`three` 曾停在 `0.3.x` 而 `maplibre` 已经 `0.4.x`，对齐时 `three` 做了 `0.3.14 → 0.4.15` 的 minor 跳跃 —— 对 `three` 的使用者是破坏性升级，只做这一次。之后两边同处 `0.4.x`，不会再出现。

---

## 6. 发版检查清单

动手前逐条对：

- [ ] 代码功能完成，`typecheck` 通过，`bun test ./tests/unit` 全绿
- [ ] 三处文档同步（见第 7 节）
- [ ] `bun run build` 重建，`demo/` + `docs/` 的产物改动已 `git add`
- [ ] `bun run release patch`（或 `minor` / `major`；脚本会同步 `bun.lock`）—— 不要手改版本
- [ ] `bun run release:check` 通过（x/y 已同步）
- [ ] commit + push `main`
- [ ] 打 tag：`s3m-three@x.y.z` 与 `s3m-maplibre@x.y.z` 两个连着推，**不要等 npm 出现新版本**
- [ ] 去 Actions 看 `Publish to npm` 两个 job 都绿

发布后再改代码 = 要么另发一个补丁版本，要么 `git tag -f` 重推（npm 一旦发出去就不能覆盖，`-f` 只对**还没发成功**的 tag 有意义）。所以 tag 尽量等代码稳定、文档补齐后再打。

---

## 7. 文档同步（改行为就要改三处）

| 位置 | 内容 |
|---|---|
| `README.md` | 「能力」表加行 / 在线文档链接 / 快速开始 |
| `packages/s3m-three/docs/API.md` | 内核选项表、setter 签名、性能调优 |
| `packages/s3m-maplibre/docs/API.md` | 图层选项表、setter 签名、专题小节（投影、近裁剪面等） |

源码里的 JSDoc 用中文写，重点写**为什么**（这条参数解决什么现象、不传会怎样、用错会出什么问题），不要复述签名。

---

## 8. 代码约定

- **注释解释决策，不复述代码。** 反例：`// 遍历网格`；正例：`// 只在位移/旋转动画时关视锥裁剪，静止必须恢复，否则包围盒会滞后`。
- **数学、单位、坐标系**是这块最容易出错的地方，涉及投影换算时把单位写进注释（像素 / mercator 0..1 / ENU 米）。
- 不知道宿主内部实现时，**去 `node_modules/maplibre-gl/dist/*.js` 里读实现**，不要凭印象下结论（比如 `nearZ = canvasHeight / 50` 是写死的）。
- 新增模块级全局状态（`TextureFactory` 的 anisotropy / textureSize、`StyleMaterial` 的 materialQuality）要接受：**同页多图层会互相覆盖，后创建的赢**。要 per-viewer 就得把状态挂到 viewer 上，那是另一个量级的改动，先别顺手改。
- 提交信息：`feat(scope): 中文描述` / `fix(scope): …` / `chore: release …`，按功能主题拆多个 commit。**没有明确指令不要 push。**

---

## 9. 常见坑

| 现象 | 原因 |
|---|---|
| 相机贴近模型整片消失 | MapLibre 的 `nearZ = canvasHeight / 50` 写死，zoom 16 时约 13 米。用 `nearPlaneScale` |
| 移动端比桌面慢好几倍 | LOD 判定用绘图缓冲物理像素高度，3x 屏比桌面还高，细化层数与瓦片数都翻倍。用 `lodPixelRatioCap` |
| 贴着看仍有粗模 / 画面开洞 | 瓦片数触到 `hardCap = maxTiles × 1.5`，淘汰选中了正在显示的瓦片 |
| `replace('#include <…>')` 静默失效 | three 改了 chunk 名，材质照样渲染但注入没生效 |
| 正交模式下底图与模型差一个楼高/相机距 | 只有 S3M 层正交，MapLibre 仍是透视；要全对齐得用 `enableMapLibreOrtho`（beta） |
| `bun` / `pnpm` 毫无输出地失败 | 本机 `NODE_OPTIONS` 注入，加 `NODE_OPTIONS=` 前缀 |
| push 超时 / 要用户名密码 | 没走 `127.0.0.1:10809` 代理，或用了 PortableGit 的 GCM |
| 发布 CI 报「标签与版本不一致」 | tag 版本 ≠ `package.json` version |
| CI 报「两个包的 x/y 不同步」 | 手改了版本或漏了 `bun install`：跑 `node tools/release.mjs --align` 或 `patch --align` |
