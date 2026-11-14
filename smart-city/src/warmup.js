/**
 * 开场瓦片预加载。
 *
 * 问题：addDataset() 只 await 每个数据集的**首棵根瓦片**（S3MTileset.init 里
 * `await this._load(this.rootUrls[0])`，其余 root + 全部子瓦片走后台队列）。
 * 而且瓦片调度只在 MapLibre 的 renderFrame 里按「当前相机」推进：开场镜头停在
 * zoom 12.4 的高空，LOD 只需要最粗一级；演出一俯冲到 16.85，成百上千块精细
 * 瓦片才被请求，下载 / 解交错 / 建几何 / 传纹理全撞在开头几秒 → 卡顿。
 *
 * 做法：遮罩还没撤时，把演出会经过的机位依次 jumpTo 一遍。每个机位连渲几帧让
 * LOD 把该要的瓦片发出去，然后等「在途请求归零 + 瓦片数不再增长」持续一段时间
 * 才换下一个机位。切机位不带动画、不触发 movestart 的 originalEvent，所以不会
 * 惊动 Show 的自由视角判断（此时 show 也没 start）。
 *
 * 判定不靠固定 sleep，也不靠「有几块瓦片」：直接读内核的 stats.loading（在途
 * _load）+ 每个 tileset 的 pending / _queue（排队中），加上累计瓦片数是否还在涨。
 * tiles / meshes 在内核里是单调累计量（淘汰不减），正好当收敛信号。
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
 * 等一个机位的瓦片流水线静默。
 * @returns {{ reason: 'quiet'|'timeout'|'skipped', state: object, ms: number }}
 */
async function waitQuiet({ layer, timeoutMs, isSkipped, onTick }) {
  const t0 = performance.now();
  let last = readState(layer);
  let quietSince = t0;

  while (true) {
    await sleep(WARMUP.pollMs);
    if (isSkipped()) return { reason: 'skipped', state: last, ms: performance.now() - t0 };

    const now = performance.now();
    const st = readState(layer);
    const busy = st.inFlight > 0;
    const grew = st.tiles > last.tiles || st.meshes > last.meshes;
    if (busy || grew) quietSince = now;
    last = st;

    const quiet = now - quietSince;
    onTick?.(st, { elapsed: now - t0, quiet, busy, grew });

    if (!busy && !grew && quiet >= WARMUP.quietMs && now - t0 >= WARMUP.minViewMs) {
      return { reason: 'quiet', state: st, ms: now - t0 };
    }
    if (now - t0 >= timeoutMs) return { reason: 'timeout', state: st, ms: now - t0 };
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
      onTick: (st, info) => {
        // 旧版把进度平均摊给每个机位，还让 quiet 一遇到新瓦片就归零：
        // 结果最贵的第一机位（瓦片最多）权重只有 1/5，进度条长时间卡住甚至倒退。
        // 现在主信号是「累计落地瓦片数」——它单调递增，瓦片一到就推进；
        // 机位完成度只作收尾补偿。最后再 clamp 一次，全程绝不倒退。
        const gained = Math.max(0, st.tiles - baseTiles);
        const loaded = 1 - Math.exp(-gained / WARMUP.tileScale);
        const viewDone = (i + (st.inFlight === 0
          ? Math.min(1, info.quiet / WARMUP.quietMs) : 0)) / views.length;
        const raw = WARMUP.startPct
          + (WARMUP.endPct - WARMUP.startPct) * Math.max(loaded, 0.9 * viewDone);
        lastPct = Math.max(lastPct, Math.min(99, raw));

        hud.setLoading(
          `预加载 ${i + 1}/${views.length} · ${v.label} · 瓦片 ${st.tiles.toLocaleString('zh-CN')} · 在途 ${st.inFlight} · ${Math.round(lastPct)}%${skipHint}`,
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
