# 统一动画调度系统设计

> 目标：让 `setStyle` / `setEdges` / `setFeatureStyle` / 专题图切换都「有过渡」，同时保证帧预算可控。
> 结论先行：**不要给每个 setter 单独加 tween**。要做的是一次「状态分层 + 单一写者 + 预算调度」的改造。

---

## 0. 一句话判据

> **能不能在不碰 material / program / geometry 的前提下，用一个 float 把这一帧画出来？**

- 能 → 这条属性可以逐帧插值，成本 O(1)，随便动。
- 不能 → 它属于结构变更，只能编排「淡出 → 换 → 淡入」，不能插值。

这个判据决定了所有属性的归属，也是整个系统「不卡」的根源：**卡的从来不是插值计算，而是插值过程中被顺带触发的重编译 / 重建 / 全量重烘。**

---

## 1. 现状体检

按现有实现逐条核对（`S3MViewer.setStyle` / `setEdges` / `FeatureStyleManager.applyOverridesToMesh`）：

| 公开 API | 当前实现 | 单次成本 | 能否直接 60fps |
|---|---|---|---|
| `setStyle({ colorA/B/C, selectColor, texMix, dimFactor, selectOpacity, selectEmissive, selectElevation, floorHeight })` | 共享 uniform 赋值 | O(1) | ✅ 直接动 |
| `setStyle({ edgeColor, edgeWidth, edgeOpacity })` | `edgeMaterial` uniform | O(1) | ✅ 直接动 |
| `setStyle({ opacity })` | `_applyOpacity()` 遍历全部 pickables 改 `material.opacity` + `material.transparent` | **O(meshes)**，且跨 0.999 会换 program | ❌ 必须改 uniform |
| `setStyle({ mode })` | `uMode` int | O(1) 但不可插值 | ⚠️ step |
| `setStyle({ shading })` | `flatShading` → 重编译 | 重编译 | ❌ step |
| `setStyle({ edges })` | `setEdges`：`EdgesGeometry` 8ms 切片建 / dispose | 几十 ~ 几百 ms | ❌ 只能编排 |
| `setFeatureStyle({ color/elevation/translation/opacity })` | `markOverridesDirty` → 微任务 → `flushOverrides` 全量重烘 `uBatchTex` | **O(meshes × batches)** | ⚠️ 需增量 |
| `colorByField` / `filterByField`（全城几万） | 同上，一次改全部 | O(全部) | ❌ 需双纹理交叉 |

三个真会卡的根因，逐个说清楚：

**① `setOpacity` 是 O(meshes)，而且改 `transparent` 会换 program。**
`_applyOpacity()` 里 `m.transparent = o < 0.999`。three r169 的 `WebGLPrograms.getParameters()` 里有 `opaque: material.transparent === false && ...`，而 `opaque` 被写进了 `_programLayers.mask`，也就是**参与 program 缓存键**。所以「1 → 0.5」的第一帧必定触发一次 program 切换与编译。整个场景共用同一个 program，所以只编译一次，但那一次是几十毫秒级的卡顿——正好落在动画起始帧，用户感知最明显。

**② `flushOverrides` 不区分「改了谁」。**
`_dirtyAll` 分支会遍历全部 mesh，每个 mesh 又把 `pickInfo` 里所有 smid 走一遍（`applyOverridesToMesh` 里还有 `new THREE.Color()` 分配）。单体数上千时，一次 flush 就是几万次迭代。逐帧跑必卡。

**③ `renderFrame` 的 `needsNextFrame` 只认 `DYNAMIC` / loading。**
动画期间没人驱动下一帧，或者反过来永远返回 true 空转把电池烧了。这是接入层必须补的一环，也是很多「加了 tween 但不动」的现场原因。

---

## 2. 架构

三层，职责严格分离：

```
公开 API（setStyle / setEdges / setFeatureStyle / colorByField）
   │  只写「目标值」+ 声明过渡参数，不做任何渲染动作
   ▼
SceneState（target） ──── Animator.tick(now) ────▶ SceneState（current）
                                                      │
                                              Reconciler
                                    ┌─────────────────┼─────────────────┐
                              uniform 通道        texel 通道        结构通道
                              （O(1) 直写）    （O(受影响单体) 增量烘）  （编排 / 分片）
                                    └─────────────────┼─────────────────┘
                                                      ▼
                                                     GPU
```

- **L0 值域层 —— 通道表**：每个可动画属性在这里登记一次：属于哪条通道、怎么读当前值、怎么写一帧、什么优先级。这张表就是「统一」的落点，新增属性只需要加一行。
- **L1 调度层 —— Animator**：单时钟、`Map<channelKey, Track>`（天然合并同类）、预算 deadline、可中断 job、时间线。
- **L2 应用层 —— Reconciler**：现有 `_applyStyleUniforms()` 已经是 uniform 通道的雏形；`applyOverridesToMesh()` 是 texel 通道，需要从「全量重烘」改成「按脏 mesh 增量烘」。

**单一写者原则**：一帧内同一通道只允许被写一次，且只由 `Animator.tick()` 写。公开 API 永远只写目标值。这条不立住，后面所有「值漂移 / 打架 / 抖动」的问题都会冒出来。

---

## 3. 值语义：target 与 current 分离

```ts
target  // 用户想要的。getStyle() 返回它，序列化 / 持久化也读它
current // 正在显示的。只有「正在动画的通道」才存在这个值
```

三条规则：

1. **新动画从 `current` 起步**，不是从 `target`，也不是从上一个 `from`。否则连续调用会跳回起点。
2. **动画结束删掉 `current`**，`target` 无缝接管。这样永远不会累积误差（不要用「每帧 += delta」的写法）。
3. **`current` 必须回写进 `featureStyles` 等 Map**。因为新瓦片插入时走的是 `applyOverridesToMesh` → 只读 Map。如果 Map 里存的是终值，动画进行中加载进来的瓦片会直接跳到终值——这是最容易漏、也最容易被用户发现的一个 bug。

---

## 4. 打断策略（手感的关键）

动画系统的难点从来不是插值，是打断。

- **同 key 覆盖，不排队**。`Map<channelKey, Track>` 天然做到。队列只在显式的时间线里用。
- **retarget 保速**：新目标到来时 `from = current`，新时长按剩余距离等比缩放：

```ts
retarget(to: number, now: number, base: number) {
  const total  = Math.abs(this.to - this.from) || 1;
  const remain = Math.abs(to - this.cur);
  this.from     = this.cur;          // 从当前显示值接着走
  this.to       = to;
  this.start    = now;
  this.duration = clamp(base * (remain / total), base * 0.15, base);
}
```

固定时长会让「只差 1%」的修正也走完整 600ms，手感发黏；等比缩放在滑块连续拖动时表现为恒速跟随，最自然。

- **连续输入自动退化**：同一通道 100ms 内被写 ≥3 次 → 判定为滑块拖动，`duration` 直接压到 0 跟手。用户拖滑块时想要的是即时反馈，不是过渡。

---

## 5. 三条通道

### 5.1 uniform 通道（主战场，先做这条）

一次赋值，全场景生效，零分配。需要补两个 uniform：

| 新增 | 作用 | 为什么必须新增 |
|---|---|---|
| `uOpacity` | 图层整体透明度，在 `FRAG_COLOR` 里 `diffuseColor.a *= uOpacity` | 替掉 O(meshes) 的 `_applyOpacity`，让 opacity 动画变成 O(1) |
| `uEdgeFade` | 棱线淡入淡出乘子，`uOpacity = edgeOpacity × globalOpacity × uEdgeFade` | 新插入的瓦片共享同一个 `edgeMaterial`，**自动继承**淡入进度，不会「半路出现一条满亮度的线」 |

关于 `transparent` 的 program 切换：把开关收敛到「动画起止边界」而不是逐帧判断。即动画开始时置 `transparent = true` 并保持到回到 1 之后再延迟一帧关闭，全程最多一次 program 切换，而不是每帧在阈值上抖。

### 5.2 texel 通道（单体状态纹理）

`uBatchTex` 已经是最合适的载体：颜色 / 抬高 / 平移 / 透明度全在一张 2 行浮点纹理里，改它不需要重建任何几何。

**实测结论：单个单体的增量路径其实已经通了。** `setFeatureStyle(smid, ...)` 会把 `_meshesOf([smid])` 传给 `markOverridesDirty(subset)`，flush 时只重烘那几块网格；同一帧内多次调用会被 `queueMicrotask` 合并成一次。所以单体动画天然是 O(含该单体的网格)，不需要额外改造。

真正会退化成全量的是 `_dirtyAll` 分支——`setThematicColors` / `setFilter` / `elevateByField` 这些**批量**操作不传 meshes，一次就是全场景重烘。它们本来就是一次性操作、不逐帧跑，所以对动画没有影响；但如果哪天要给「全城换色」加过渡，就得走 §11 第 6 步的双纹理交叉淡化，而不是逐帧调它们。

```ts
// 通道 write 里的实际写法（已实现）
const meshes = this._meshesOf([smid]);          // smid → Set<mesh>，只取相关网格
const cur = manager.getFeatureStyle(smid) ?? {};
manager.setFeatureStyle(smid, { ...cur, elevation: v[0] }, meshes);
```

三个细节：

- **一帧只烘一次**。`markOverridesDirty` 走 `queueMicrotask`，同一帧里多条通道写同一个单体也会合并成一次 flush。
- **跳帧无害**。`applyOverridesToMesh` 是幂等的全量烘（按 Map 重算整张纹理），推迟一帧不会花、不会丢。
- **描边自动跟随**。`OUTLINE_VERT` 也采样同一张 `uBatchTex` 的第 2 行，所以单体抬高的动画会把选中描边一起带走，不需要额外同步——这也是为什么 texel 通道比「直接改 mesh.position」更正确。

three r169 没有 `texture.updateRanges`（局部上传是 r170+ 才有），所以别指望 `addUpdateRange`。成本控制靠两点：**只烘变化的 mesh** + 纹理本来就小（width = maxBatch+1，两个像素高）。一张 300 batch 的纹理只有 9.6KB，单次 `texSubImage2D` 可以忽略。

单体平移（移动动画）走的就是这一行的 `(tx, ty, tz)`。主材质、拾取、选中描边、棱线全部采样同一张纹理，所以动起来会整体跟着走；唯一要额外处理的是视锥剔除（§6.1②）。

### 5.3 结构通道（不可插值，只能编排）

**棱线 —— 不做几何 tween，只做外观淡入。** 这是本题的典型样本：

```ts
setEdges(true, { duration = 400 }) {
  this._edgesEnabled = true;                 // 新瓦片进来就会带棱线
  this._buildEdgesChunked();                 // 复用现有 8ms 切片，边建边出
  animator.to('style.edgeFade', 1, { duration });
}

setEdges(false, { duration = 400 }) {
  this._edgesEnabled = false;                // 新瓦片不再建
  animator.to('style.edgeFade', 0, {
    duration,
    onComplete: () => this._disposeEdges(),  // 淡完才真正释放几何
  });
}
```

建线本来就按 8ms 切片，建好一块亮一块；再叠一个全局 `uEdgeFade` 从 0 起，视觉上就是「棱线逐渐浮现」，而不是「啪一下全出来」。**零额外成本**，因为分片逻辑已经存在，只是把「瞬间可见」换成「渐显」。

**着色模式 —— step + fade-through。** `uMode` 是 int，插不了值。想要过渡就编排（已实现为 `setMode`）：

```ts
setMode(mode, { duration = 300, dim = 0.35 }) {
  return new Promise((resolve) => {
    animator.to('style.fade', dim, { duration, onComplete: () => {
      this.setStyle({ mode });                                  // 回调里切，同一帧生效
      animator.to('style.fade', 1, { duration, onComplete: resolve });
    }});
  });
}
```

`style.fade` 就是一个乘在 `diffuseColor.rgb` 上的 uniform，而且必须乘在 `FRAG_COLOR` **最末**——mode 分支会整体覆写 `diffuseColor.rgb`，放在前面会被覆盖掉。另外别复用 `uDim` / `uDimFactor`：那两个被「选中时压暗其他建筑」占着，会打架。

编排用 `onComplete` 回调而不是 `await` 串起来，换模式就发生在同一帧的回调里，不会多出一帧空白。重复调用靠代次号作废旧编排。

**`shading`** 也是 step，且首次切换会编译 program，必须在挂载后预热一次，不能留到用户点按钮时才编译。

---

## 6. 移动动画

先把「移动」拆开，四种东西的成本模型完全不同：

| 类型 | 动的是谁 | 载体 | 每帧成本 |
|---|---|---|---|
| 单体位移 | 建筑 / 设备从 A 到 B | texel 第 2 行 `(tx, ty, tz)` | O(受动单体) |
| 单体姿态 | 旋转 / 缩放（车头朝向、楼体生长） | 需要第 3 行 `(angle, scale, pivot)` | O(受动单体) + 一次性 pivot |
| 路径运动 | 车辆 / 人流沿折线跑 | 弧长参数化 → texel | O(N)，或 GPU 侧 O(1) |
| 相机 | 视角飞行 | 宿主的 `easeTo / flyTo` | 不要自己 tween |

### 6.1 单体位移：机制已经够用，缺的是三处配套

texel 第 2 行就是平移，顶点着色器里 `transformed += s3mCustomOffset`；拾取着色器读的是同一份数据（`PICK_VERT` 里那段注释写得很清楚），所以**移动后仍然点得中**——这块不用改。

但另外三处没跟上，只要开始移动单体就会暴露：

**① 棱线跟随（已实现）。** 以前等宽线材质只有 `uTranslation` / `uElevation` 两个 uniform（那是给选中单体用的），完全不采样 `uBatchTex`，单体一动棱线留在原地、隐藏了棱线还在。

解决它有两个障碍，都绕不开：

- **状态纹理是每块网格一张，棱线材质却是全局一份**。一个共享材质绑不了 N 张纹理。
- **`EdgesGeometry` 只输出坐标不输出顶点号**，想知道每段棱线属于哪个单体，只能拿端点坐标回查。

落地方案是「逐网格材质 + 三组 uniform 分层共享」：

1. **棱线材质逐网格一份**（每块网格专属，绑定它自己的状态纹理）。着色器相同，program 只编译一次。
2. **外观 uniform（颜色 / 粗细 / 透明度）共享同一批 `{ value }` 对象**——`_syncEdgeStyle()` 改一次，所有棱线生效，棱线淡入淡出保持 O(1)。
3. **单体状态 uniform（`uBatchTex` / `uBatchTexWidth` / `uBatchTexActive`）直接复用主材质 `userData` 里那几个对象**——主材质换纹理、开关 active，棱线零成本跟着走。

回填 batchId 的办法：`buildPositionBatchMap(geometry, tolerance)` 从原始几何建「量化位置 → batchId」表（量化网格必须与 `mergeVerticesByPosition` 完全一致，否则焊过的顶点对不上），`EdgesGeometry` 输出的每段棱线拿首端点坐标查表。成本 O(顶点数)，与 weld + EdgesGeometry 本身同量级。

顶点着色器里用与主着色器完全相同的口径采样：`bOffset.xyz` 加到两端点，`bOffset.z == 0` 时回退 `bState.a` 当拔高；`bState.a < -0.5`（单体被隐藏）时把顶点扔出裁剪空间——**隐藏的单体连棱线一起消失**，这是以前做不到的。

选中棱线同修：它只覆盖选中单体自己，整批填同一个 batchId 即可，不用查表。顺带修了一个双重拔高：`uElevation` 原来取「全局 selectElevation + 单体拔高」，而单体拔高已经在状态纹理 z 里被带出来，现在 `uElevation` 只放全局值。

**② 视锥剔除按原始包围盒。** 主 mesh 的 `frustumCulled` 是默认的 `true`，包围球来自原始几何。把单体平移出包围球范围后，一旦原始包围盒离开视锥，整块 mesh 就被剔掉——屏幕上那个「本该还在」的建筑凭空消失。修法：任一 batch 出现非零平移就把该 mesh 的 `frustumCulled = false`；或者按最大位移量膨胀 `boundingSphere.radius`（省 GPU，按瓦片内单体数取舍）。

**③ 拾取与包围盒其实已经覆盖了平移**（实现时核对过）：`PICK_VERT` 采样同一份状态纹理，
`getFeatureBounds` 也通过 `getFeatureEffectiveOffset` 叠加了 `translation` 与 `elevation`，
所以移动后的单体点得中、`flyToFeature()` 也飞得对。剩下唯一没跟上的读取方是
`filter.predicate` 里的 `measureSegments`——它读原始几何，属性过滤按原位置判断，
这个前提知道就行，不用改。

### 6.2 单体姿态：需要第 3 行纹理

现在的第 2 行是纯平移，没有旋转。要转就必须知道**绕哪个点转**：绕原点转会把楼甩到天边，必须绕单体包围盒中心转。

方案是状态纹理加第 3 行 `[angleZ, scale, pivotX, pivotY]`，pivot 在第一次需要旋转时按 smid 从几何里算一次、缓存进 `userData`（一次性成本，不逐帧）：

```glsl
vec4 bPose = texture2D( uBatchTex, vec2( ( s3mBatch + 0.5 ) / uBatchTexWidth, 1.25 / 3.0 ) );
if ( abs( bPose.x ) > 1e-5 || abs( bPose.y - 1.0 ) > 1e-5 ) {
  vec2 p = transformed.xy - bPose.zw;
  float c = cos( bPose.x ), s = sin( bPose.x );
  p = vec2( p.x * c - p.y * s, p.x * s + p.y * c ) * bPose.y;
  transformed.xy = p + bPose.zw;
}
```

纹理从 2 行变 3 行，采样索引从 `0.25 / 0.75` 变成 `1/6、3/6、5/6`——**这是一次全局改动，`PICK_VERT`、`OUTLINE_VERT`、`EdgeLines` 必须同时改，漏一处就是「拾取点不中」或「描边飞走」**。建议放在第 2 步之后单独做。

如果只是「楼体生长」这类垂直缩放，其实不用第 3 行：抬高 + 位移就能做出大部分效果，可以先不做。

### 6.3 路径运动：先按弧长参数化，再上缓动

这里最容易做错。直接对折线顶点做 `lerp` 会得到**速度突变**：顶点密的地方走得慢，顶点疏的地方一下窜过去。

正确做法是**弧长参数化**：预先把折线展开成累计弧长表 `[0, s1, s2, …, L]`，运动时按 `s = ease(t) × L` 查表反解位置。这样 `ease` 作用在**距离**上而不是**顶点索引**上，恒速段才是真的恒速。

已实现为 `anim/Path.ts`（纯数学，不依赖 three）：`sample(s, out)` 二分查段 + 段内线性，`sampleAt(t, out)` 按归一化进度取点。

**关键实现技巧：不需要新的 track 类型。** 把「进度 0→1」当成一条普通补间，通道的 `write` 把进度映射成弧长再查表得位置——打断、循环、缓动、预算全部复用现有调度器：

```ts
animator.register(`feature.${smid}.path`, {
  dim: 1,
  read: (out) => { out[0] = 0; },      // 每次都从起点开始，循环时正好重置
  write: (v) => {
    path.sampleAt(v[0], scratch);
    setFeatureStyle(smid, { ...cur, translation: [off[0] + scratch[0], ...] }, meshes);
  },
});
animator.to(key, 1, { duration, easing, onComplete: () => { if (loop) run(); } });
```

`read` 恒返回 0 是这里的巧劲：进度通道没有「当前值」的概念，而补间默认从当前值起步，恒返 0 就等于「每次运行都从头走」，循环只要在 `onComplete` 里再 `to` 一次即可。

两条路线，按规模选：

- **CPU 路线（N ≤ 几千，已实现）**：每帧对每个 mover 调一次 `sample()`，结果写进 texel。N 个 mover 分摊在 M 个 mesh 上，每帧 M 次纹理上传。1000 个 mover 分布在 50 个 mesh 是舒服的区间。
- **GPU 路线（N 上万，未做）**：路径采样表烘成一张 `RGBA32F` 纹理（`x, y, z, s`），单体参数（`pathId / phase / speed`）写进状态纹理第 4 行，顶点着色器自己算位置，CPU 每帧只写一个 `uTime`。代价是每顶点多两次纹理采样，且二分查表要改成「按归一化 s 直接索引采样表」，精度靠采样表密度换。

先做 CPU 路线，量到瓶颈再上 GPU。实际业务里路径运动通常只有几百个目标。

注意 `followPath` 和 `moveFeature` 都写 `translation`，**别同时驱动同一个单体**。

### 6.4 相机动画不要自己 tween

宿主是 MapLibre 时，相机矩阵每帧由 `render()` 的入参喂进来，viewer 只是被动接受。自己 tween `camera.position` 会被下一帧覆盖，表现为抖动。相机动画一律走宿主的 `map.easeTo / flyTo / fitBounds`，`S3MLayer.flyToFeature()` 已经是这个路子。

只有纯 three 宿主（直接 `new S3MViewer()`）才需要在 animator 里做相机轨道插值——那种情况下没人覆盖，tween 是安全的。

---

## 7. 动画曲线

### 7.1 曲线库

四类，够覆盖所有场景：

| 类 | 函数 | 适用 |
|---|---|---|
| 基础 | `linear` + easeIn/Out/InOut × {Quad, Cubic, Quart, Quint, Sine, Expo, Circ} | 90% 的样式过渡 |
| 回弹 | `easeOutBack` / `easeOutElastic` / `easeOutBounce` | 单体入场、强调 |
| 参数化 | `cubicBezier(x1, y1, x2, y2)`、`spring(stiffness, damping)` | 产品级手感调校 |
| 离散 | `steps(n, 'start' \| 'end')`、`custom(t => number)` | 逐帧动画、特殊节奏 |

`cubicBezier` 要和 CSS 对齐：x 轴用牛顿迭代解 `t`，退化时退二分，8 次迭代误差 < 1e-5，肉眼看不出。

`spring` 值得单独说：它没有「时长」概念，靠物理收敛，**天然支持打断**——中途改目标只改 `target`，位置和速度都连续，不会像缓动曲线那样在打断点出现速度突变。凡是「用户会连续操作」的通道（拖拽、跟随、镜头），spring 的手感比 cubic-bezier 好一个档次。代价是要定义收敛判据（位移 < 1e-3 且速度 < 1e-3 才判定结束），否则 track 永远不结束，`needsNextFrame` 永远 true，电池直接烧掉。

### 7.2 曲线作用在什么上——三个必须想清楚的点

**① 进度 vs 距离。** 样式过渡作用在进度 `t` 上没问题；路径运动必须作用在**弧长**上（见 §6.3），否则速度不匀。同一个 easing 在两种语义下的用法，API 上要分开：`easing` 给进度，`pathEasing` 给弧长。

**② 颜色在哪个空间插值。** `uColorA` 这些 uniform 是**线性空间**的（three 的色彩管理已经把 `#ef4444` 转成 linear）。直接 lerp 线性值，中间色会比 CSS 过渡更亮、更灰。要 CSS 那种观感就得转回 sRGB 插值再转回来。建议默认线性（和 shader 消费端一致，端点严格吻合），提供 `colorSpace: 'srgb'` 开关。这个差异用户一眼就能看出来，别含糊过去。

**③ 打断时曲线要连续。** 缓动曲线在 `t=0` 处速度不一定为 0——`easeOutCubic` 恰恰是起点速度最大。从 `current` 重新起一条 `easeOutCubic`，速度方向大概率突变。三个处理：

- 保速 retarget（§4）：至少保证位移速度连续，方向突变可接受；
- 打断时降级成 `linear` 或 `easeOutSine`（起点速度温和）；
- 该通道改用 `spring`。

### 7.3 三级覆盖

```ts
animator.setOptions({ easing: 'easeOutCubic', duration: 400 });          // 全局默认
layer.setStyle({ opacity: 0.2 }, {
  transition: { opacity: { duration: 800, easing: 'spring(180, 22)' } },  // 通道级
});
layer.setStyle({ colorA: '#000' }, { duration: 200, easing: 'linear' });  // 调用级
```

优先级：调用级 > 通道级 > 全局默认。曲线参数进 track 时**固化成函数引用**，不要在 tick 里按字符串查表——每帧几万次字符串查表也是浪费。

demo 里配一个曲线预览（拖两个控制点，实时看 0→1 的映射曲线）会明显提高调参效率，可选但很值。

---

## 8. 预算与降级（「不卡」的硬保证）

```ts
tick(now: number): boolean {
  if (this._tracks.size === 0 && this._jobs.length === 0) return false;  // 空闲成本 = 0
  const dt = Math.min(now - this._last, 100);   // 后台切回不跳变
  this._last = now;
  const deadline = now + this._budgetMs;        // 默认 2.5ms

  for (const t of this._tracks.values()) { t.advance(now); t.apply(); if (t.done) this._tracks.delete(t.key); }
  this._runJobs(deadline);                      // 可中断：一个 mesh / 一个分片 = 一个单元
  return this._tracks.size > 0 || this._jobs.length > 0;
}
```

- **单元划分**：uniform 写不可中断（本来就 O(1)）；单个 mesh 的烘是一次单元；建棱线是分片 job。每完成一个单元查一次 deadline。
- **超预算**：剩余单元推到下一帧，`tick` 返回 true 保持重绘。
- **连续超预算**（连续 3 帧）：自动降级——bulk 通道切到 GPU 交叉淡化，或该通道降到 30fps。
- **`needsNextFrame` 必须精确**：动画结束那一帧必须返回 false。返回 true 会导致 MapLibre 永远重绘，笔记本风扇起飞；这是接入层最常见的坑。

---

## 9. 帧驱动接入

```ts
renderFrame(opts) {
  const animating = this.animator.tick(performance.now());
  this.flushOverrides();                 // 顺序：tick → flush → render
  ...
  return animating || this.style.mode === STYLE.DYNAMIC || this.stats.loading > 0 || tilesetChanged;
}

// 构造时挂上：
this.animator.onActive = () => this._requestRepaint();
```

**`onActive` 是这套系统里最容易漏、也最致命的一环。** MapLibre 是按需驱动的：空闲时不渲染，只有 `triggerRepaint` 才画；而 `tick()` 只在渲染帧里被调用。如果启动动画时不去踢一下帧循环，第一帧永远等不来——现象就是「点了按钮没反应，直到别的什么碰巧触发了重绘（比如取消选中），建筑直接跳到终态」。

所以 `Animator.onActive` 会在每次**新建 track**（动画真正启动）和立即写值时触发，宿主用它请求一次重绘。retarget 不触发——动画已经在跑，帧循环本来就活着。

- 时钟用 `performance.now()`，**不要用帧数累加**。现在 `uTime += 0.016` 在低帧率下会变慢，动态扫描会跟着变慢，属于同一个病。
- `dt` 上限 100ms：标签页切回来时不会瞬间跳完。
- 页面不可见时 MapLibre 不渲染 → tick 自然停，不需要额外处理。
- `S3MLayer.render()` 里已经有 `if (needsNextFrame) map.triggerRepaint()`，不用改。

---

## 10. API 形态

对齐 Mapbox GL 的 `paint.*-transition` 心智，用户零学习成本：

```ts
// 全局默认过渡
layer.setStyle({ colorA: '#ef4444' }, { duration: 600, easing: 'easeOutCubic' });

// 逐通道策略
layer.setStyle({ opacity: 0.2, mode: STYLE.HEIGHT }, {
  transition: { opacity: { duration: 800 }, mode: { duration: 0 } },
});

// 单体
layer.setFeatureStyle(smid, { elevation: 120 }, { duration: 900, easing: 'easeOutBack' });
layer.setFeaturesStyle(smids, { opacity: 0 }, { duration: 500, stagger: 8 });  // 错峰

// 结构
layer.setEdges(true, { duration: 400 });

// 移动
layer.moveFeature(smid, [dx, dy, dz], { duration: 1200, easing: 'easeInOutCubic' });
layer.moveFeatureTo(smid, { lngLat: [116.39, 39.9] }, { duration: 1200 });   // 经纬度目标，内部换算
layer.moveFeaturesAlong(smids, path, { duration: 8000, loop: true, pathEasing: 'linear' });
layer.rotateFeature(smid, { angle: Math.PI / 2 }, { duration: 600 });        // 需第 3 行纹理

// 曲线
layer.setStyle({ colorA: '#000' }, { duration: 400, easing: 'spring(180, 22)' });
layer.setStyle({ opacity: 0.2 }, { duration: 400, easing: 'cubicBezier(.4,0,.2,1)' });

// 控制
layer.animation.setOptions({ budgetMs: 2.5, maxMeshesPerFrame: 32, easing: 'easeOutCubic' });
layer.animation.cancel('style.opacity');   // 停在当前值，不回弹
layer.animation.finish('style.opacity');   // 直接跳到终值
layer.animation.timeline([a, b, c]);       // 顺序 / 并行编排
```

`stagger` 是这类系统的高性价比选项：一万个单体错峰 8ms，总时长不变但每帧只动一小批，天然把峰值摊平。

---

## 11. 落地顺序

分六步，每步可独立发版、独立回滚。

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | `Animator` + 曲线库 + 通道表；uniform 通道；`setOpacity` 改 `uOpacity` | ✅ 已完成 |
| 2 | 单体通道补全（颜色 / 抬高 / 透明度 / 位移）+ `stagger` | ✅ 已完成 |
| 3 | 移动配套：视锥剔除 + 棱线跟随（含选中棱线） | ✅ 已完成 |
| 4 | 结构编排：`setEdges` 淡入淡出、`setMode` fade-through、`shading` 预热 | 部分（shading 预热未做） |
| 5 | 姿态：状态纹理扩到 3 行（旋转 / 缩放），四处着色器同步改 | 待做 |
| 6 | 路径运动（CPU 弧长 ✅）→ GPU 侧；双纹理交叉淡化 | 部分（GPU / 双纹理待做） |

### 已完成部分的实际 API

```ts
import { S3MLayer, easing, cubicBezier, steps, EASING_NAMES } from 's3m-maplibre';

// 样式过渡：能插值的走动画，不能插值的（mode / shading）仍即时生效
layer.setStyle({ colorA: '#ef4444' }, { duration: 600, easing: 'easeOutCubic' });
layer.setStyle({ opacity: 0.2 }, { spring: { stiffness: 180, damping: 22 } });
layer.setOpacity(0.5, { duration: 400, easing: cubicBezier(0.4, 0, 0.2, 1) });

// 棱线淡入淡出（几何照旧 8ms 分片建，只对透明度做过渡）
layer.setEdges(true, { duration: 400 });
layer.setEdges(false, { duration: 300 });

// 单体位移
layer.moveFeature(smid, [120, 0, 0], { duration: 1200, easing: 'easeInOutCubic' });
layer.moveFeatureBy(smid, [0, 0, 40], { duration: 600 });

// 单体样式过渡：颜色 / 抬高 / 透明度 / 平移可任意组合，各走一条通道互不覆盖
layer.animateFeature(smid, { elevation: 120, color: '#ef4444' }, { duration: 800 });
layer.animateFeatures(smids, { opacity: 0 }, { duration: 500, stagger: 8 });  // 错峰

// 沿折线运动（弧长参数化，缓动作用在距离上）
layer.followPath(smid, [[0, 0, 0], [80, 0, 0], [80, 60, 0]], {
  duration: 6000,
  loop: true,
  offset: [baseX, baseY, 0],
});
layer.stopPath(smid);

// 着色模式：压暗 → 换 → 亮回来（uMode 是 int，插不了值）
await layer.setMode(STYLE.HEIGHT, { duration: 300, dim: 0.4 });

// 新瓦片淡入（初次加载 / LOD 换瓦都生效）
layer.setStyle({ fadeIn: 500 });

// 调度器直连
layer.animation.cancel('style.opacity');  // 停在当前值
layer.animation.finish('style.opacity');  // 直达终值
layer.animation.budgetMs = 3;             // 单帧写入预算
```

已注册的动画通道（其余键一律即时生效）：

| 通道 | 维度 | 说明 |
|---|---|---|
| `style.opacity` | 1 | 写共享 `uOpacity`，混合开关只在跨 0.999 时切一次 |
| `style.colorA/B/C`、`style.selectColor`、`style.edgeColor` | 3 | 线性空间插值 |
| `style.texMix`、`floorHeight`、`selectOpacity`、`selectEmissive`、`selectElevation`、`dimFactor`、`roofThreshold`、`edgeWidth`、`edgeOpacity`、`outlineWidth` | 1 | 直接写 uniform |
| `style.edgeFade` | 1 | 棱线淡入乘子，非 `S3MStyle` 字段 |
| `style.fade` | 1 | 整体压暗乘子，`setMode` 的 fade-through 用它 |
| `feature.<smid>.translation` | 3 | 位移 |
| `feature.<smid>.elevation` / `.opacity` | 1 | 抬高 / 透明度 |
| `feature.<smid>.color` | 3 | 单体配色（线性空间） |
| `feature.<smid>.path` | 1 | 路径进度 0→1，write 里查弧长表换算成位置 |

单体通道按需惰性注册，写回统一走 `setFeatureStyle`（它内部已按 `_meshesOf([smid])` 收敛脏网格），所以单个单体动画每帧只重烘「含这个单体」的一两块网格。`removeFeatureStyle` / `clearFeatureStyles` 会回收全部单体通道。

### 瓦片淡入（fadeIn）

`style.fadeIn` 是「新瓦片出现时的淡入时长」，初次加载和 LOD 换瓦都会走。

实现上没有用共享 uniform，而是给每个材质一份 `uTileFade`——因为每块网格本来就有自己的材质实例，逐材质写一个 float 不需要任何同步。淡入期间把该网格的 `transparent` 打开并保持 `depthWrite`（否则能透过正在淡入的楼看到后面），淡完立刻把混合状态还给图层，避免整片瓦片长期留在透明渲染队列里。

代价说清楚：**淡入期间这些瓦片要参与透明队列的混合与前后排序**。首次加载几百块瓦片同时淡入会有一小段额外开销，所以默认 `0`（关闭），需要时再开。LOD 细化时父瓦换子瓦也会淡入，视觉上比「啪」一下换掉柔和得多，这是它的主要价值。

通道 key 用自增序号而不是 `pickId`：`pickId` 会被回收复用，用它会让旧通道写到新瓦片上。瓦片中途被淘汰时按 `userData.tileFadeKey` 把通道收掉。

第 6 步里的双纹理交叉淡化展开一下：切换专题图时把目标状态烘到 B 纹理，只动一个 `uBatchMix` 从 0 到 1，片元里 `mix(A, B)`。CPU 每帧只写一个 float，几万个单体换色也不掉帧。代价是过渡期间每像素多两次纹理采样，以及收尾时的一次纹理交换。

第 5 步单独强调：**它是唯一需要同时改所有着色器的改动**（`StyleMaterial`、`PICK_VERT`、`OUTLINE_VERT`、`EdgeLines`），漏一处就是「点不中」或「描边飞走」。所以放在移动功能跑通之后再做，别和前面混在一次发版里。

---

## 12. 已知的坑

1. **`transparent` 阈值抖动**：动画起止各一次 program 切换，不要逐帧判断。
2. **绕过 animator 直写 uniform**：`viewer.uniforms.uColorA.value.set(...)` 会和动画打架。约定动画期间 animator 是唯一写者，公开 API 一律走 `setStyle`。
3. **瓦片淘汰时目标消失**：track 要容忍 smid 不存在，静默结束，不能抛错。
4. **新瓦片插入时机**：见 §3 第 3 条，`current` 必须回写 Map。
5. **相机也在动的时候**：一帧内既要 render 又要烘 32 个 mesh，预算要给渲染本身留余量，别把 2.5ms 全吃掉。
6. **`_dirtyAll` 全量分支**：动画期间禁止走到这条路径，否则一次就是全场景重烘。
7. **选中描边与本体分离**：`selectElevation` 在 `_applyStyleUniforms` 里同步给 `outlineMaterial.uElevation`，动画化这条通道时别忘了它；单体 `elevation` 走纹理则自动跟随。
8. **移动的配套**：视锥剔除与棱线跟随都已修（§6.1①②）。拾取与包围盒本来就跟着走，不用改。
9. **路径运动的恒速**：缓动必须作用在弧长上，不是顶点索引（§6.3）。否则顶点疏密直接变成速度疏密。
10. **spring 不收敛**：没有收敛判据的 spring 会让 `needsNextFrame` 永远为 true。判据要卡到位（位移与速度同时 < 1e-3）。
11. **纹理行数改动是全局的**：状态纹理从 2 行扩到 3 行时，`0.25 / 0.75` 这些采样常量散落在四个着色器里，必须一起改（§6.2）。
12. **启动动画必须踢帧循环**：MapLibre 按需驱动，`animator.to()` 不请求重绘的话动画永远等不到第一帧，表现为「点了没反应，取消选中才跳到终态」。见 §9 的 `onActive`。
13. **移动与 LOD 的关系**：位移不参与 LOD 判定，瓦片按原位置切；把单体移到很远的地方不会触发更细的瓦片。这是已知限制，不是 bug，别试图在 animator 里修。

