/**
 * 开场首屏预热。
 *
 * addDataset() 只 await 每个数据集的**首棵根瓦片**，其余 root + 全部子瓦片走后台
 * 队列；瓦片调度又只在 MapLibre 的 renderFrame 里按「当前相机」推进。所以遮罩还在
 * 时，把一个覆盖全城的中等高度机位连渲几帧，让 LOD 把首屏需要的瓦片发出去，
 * 落地数达标就撤遮罩开演 —— 而不是等整条 LOD 链细化到叶子（那永远不会静默）。
 *
 * 剩下精细瓦片由演出中的渐进细化补齐：镜头是 8.2s 才俯冲到 15.35 级、26s 后才
 * 到 16.85 级特写，配合 incremental 过渡（父瓦片垫底）不会有整块跳变。这也是
 * 官方 demo「瞬间出来」的同一套策略。
 *
 * 判定读内核的 stats.loading（在途 _load）+ 每个 tileset 的 pending / _queue（排队
 * 中），加上累计瓦片数是否还在涨。tiles / meshes 在内核里是单调累计量（淘汰不减）。
 * 尾部零星请求不算忙，否则计时会被反复重置、白等到硬上限。
 */
import { CAMERA, WARMUP } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 后台标签页里 rAF 会被冻结，给每帧一个超时兜底，别把预加载卡死 */
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 90);
  });
}

/** 汇总当前瓦片流水线状态。内部字段读取全部带兜底，内核改版也不会抛错 */
function readState(layer) {
  const s = layer.stats ?? {};
  let queued = 0;
  let pending = 0;
  try {
    const ds = layer.viewer?.datasets ?? layer.datasets;
    if (ds && typeof ds.values === 'function') {
      for (const entry of ds.values()) {
        const t = entry?.tileset;
        if (!t) continue;
        queued += t._queue?.length ?? 0;
        pending += t.pending?.size ?? 0;
      }
    }
  } catch {
    // 读不到队列就退回公开的 stats.loading，判定会保守一些但仍可用
  }
  return {
    tiles: s.tiles ?? 0,
    meshes: s.meshes ?? 0,
    triangles: s.triangles ?? 0,
    textures: s.textures ?? 0,
    programs: s.programs ?? 0,
    loading: s.loading ?? 0,
    queued,
    pending,
    inFlight: (s.loading ?? 0) + queued + pending,
  };
}

/** jumpTo 之后必须真的渲染几帧：瓦片请求是在 renderFrame 里发的，不是 jumpTo 里 */
async function settleCamera(map, cam) {
  map.jumpTo(cam);
  for (let i = 0; i < 3; i++) {
    map.triggerRepaint?.();
    await nextFrame();
  }
}

/**
 * 等首屏「够看」——不是等流水线静默。
 *
 * 旧版把 inFlight > 0 算作忙并重置计时，但 LOD 会一路细化到叶子，在途请求在
 * 整场演出里都不会归零（实测撤遮罩时仍有 30 个）。结果每个机位都撞硬上限，
 * 进度条必然「百分百到上限时间」。现在主判据是累计落地瓦片数达标，增长停滞
 * 只作为网络快时的提前退出；在途数只用于文案展示。
 *
 * @returns {{ reason: 'covered'|'quiet'|'timeout'|'skipped', state: object, ms: number }}
 */
async function waitQuiet({ layer, timeoutMs, isSkipped, onTick, baseTiles = 0 }) {
  const t0 = performance.now();
  let last = readState(layer);
  let quietSince = t0;

  while (true) {
    await sleep(WARMUP.pollMs);
    if (isSkipped()) return { reason: 'skipped', state: last, ms: performance.now() - t0 };

    const now = performance.now();
    const st = readState(layer);
    const grew = st.tiles > last.tiles + WARMUP.growthTolerance
      || st.meshes > last.meshes + WARMUP.growthTolerance;
    if (grew) quietSince = now;
    last = st;

    const elapsed = now - t0;
    const quiet = now - quietSince;
    const gained = Math.max(0, st.tiles - baseTiles);
    onTick?.(st, {
      elapsed, quiet, gained,
      busy: st.inFlight > WARMUP.busyThreshold,
      grew,
    });

    const covered = gained >= WARMUP.readyTiles;
    const settled = !grew && quiet >= WARMUP.quietMs;
    if ((covered || settled)
      && elapsed >= WARMUP.minViewMs && elapsed >= WARMUP.minWarmMs) {
      return { reason: covered ? 'covered' : 'quiet', state: st, ms: elapsed };
    }
    if (elapsed >= timeoutMs) return { reason: 'timeout', state: st, ms: elapsed };
  }
}

/**
 * @param {{map: object, layer: object, hud: object, isSkipped?: () => boolean,
 *          budgetMs?: number, viewTimeoutMs?: number}} ctx
 * @returns 预加载报告，挂到 __city.warmup 上便于现场调参
 */
export async function warmupCity({
  map, layer, hud, isSkipped = () => false, budgetMs, viewTimeoutMs, initialPct,
}) {
  const t0 = performance.now();
  const totalBudgetMs = budgetMs ?? WARMUP.totalBudgetMs;
  const perViewMs = viewTimeoutMs ?? WARMUP.viewTimeoutMs;
  const report = { views: [], tiles: 0, ms: 0, skipped: false, timedOut: false };
  const views = WARMUP.views;
  const skipHint = ' · 点击遮罩 / Esc 跳过';
  // 进度只认真实工作量：预热开始时已落地的瓦片数当基线，
  // 之后的增量才代表「这次预加载到底下了多少东西」。
  const baseTiles = readState(layer).tiles;
  // 从入口当前的进度接上（着色编译已经推到 64%），别跨阶段往回跳
  let lastPct = initialPct ?? WARMUP.startPct;

  for (let i = 0; i < views.length; i++) {
    if (isSkipped()) { report.skipped = true; break; }

    const v = views[i];
    const remain = totalBudgetMs - (performance.now() - t0);
    if (remain <= 0) { report.timedOut = true; break; }

    await settleCamera(map, CAMERA[v.id]);
    const result = await waitQuiet({
      layer,
      timeoutMs: Math.min(perViewMs, remain),
      isSkipped,
      baseTiles,
      onTick: (st, info) => {
        // 进度 = 真实落地瓦片数 / 首屏目标数：线性、单调、有明确终点。
        // 旧版按机位序号摊派还让 quiet 归零，进度条会长时间卡住甚至倒退；
        // 饱和曲线也估不准（分母是拍脑袋的经验值）。现在分母就是退出条件本身。
        const raw = WARMUP.startPct
          + (WARMUP.endPct - WARMUP.startPct)
          * Math.min(1, info.gained / WARMUP.readyTiles);
        lastPct = Math.max(lastPct, Math.min(99, raw));

        hud.setLoading(
          `首屏预热 · ${v.label} · ${info.gained}/${WARMUP.readyTiles} 块瓦片 · ${Math.round(lastPct)}%${skipHint}`,
          lastPct,
        );
      },
    });

    report.views.push({
      id: v.id,
      label: v.label,
      reason: result.reason,
      ms: Math.round(result.ms),
      tiles: result.state.tiles,
    });
    if (result.reason === 'timeout') report.timedOut = true;
    if (result.reason === 'skipped') { report.skipped = true; break; }
  }

  // 不管正常结束、跳过还是超时，镜头都必须交回起点：
  // 否则演出第一帧会从最后一个预热的机位（全景）起跳，俯冲直接没了。
  map.jumpTo(CAMERA.start);
  for (let i = 0; i < 2; i++) {
    map.triggerRepaint?.();
    await nextFrame();
  }

  report.tiles = readState(layer).tiles;
  report.loadedTiles = report.tiles - baseTiles;
  report.ms = Math.round(performance.now() - t0);
  return report;
}
