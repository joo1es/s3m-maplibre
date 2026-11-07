/**
 * 客户端坐标 → canvas 布局坐标（拾取用）。
 *
 * 为什么不能只减 `getBoundingClientRect()`：`viewer.pick(x, y)` 的分母是
 * `canvas.clientWidth/Height`，那是**布局像素**；而 rect 给的是**变换之后**的盒子。
 * 两者只在「父级没有任何 transform」时一致。
 *
 * 三种情况按代价从低到高处理：
 *
 *   1. 祖先链上没有 transform          → 直接 (clientX - rect.left, …)，与历史行为逐字一致
 *   2. 只有 scale / translate          → 标量比值足够（但走第 3 步会更准，这里只是兜底）
 *   3. 有 rotate / skew / perspective  → 标量彻底失效：rect.width 是**包围盒**宽，
 *      被旋转混进了高度，用它当比例尺等于把两轴搅在一起。实测 rotate(30deg) 偏
 *      (19.9, 22.1)px，perspective + rotateX(22deg) 偏 (−119.3, −58.4)px。
 *
 * 第 3 步的做法：在 canvas 的容器里临时插 4 个 0×0 的探针，让**浏览器自己**把
 * 「布局四角」画到屏幕上，再用四点单应求逆。这样不用复刻 CSS 变换的合成规则
 * （transform-origin、父子嵌套、透视原点），也不依赖 `getBoxQuads`（Chrome 至今
 * 没实现）。透视下这不是仿射变换，必须用 8 自由度的单应；用仿射拟合会「四角对上、
 * 中间偏掉」。
 *
 * 探针会做自校验：四个角点的包围盒必须与 canvas 的 rect 重合（两者本来就是同一个
 * 盒子），否则说明探针挂到了别的包含块上（容器不是定位元素、canvas 有偏移等），
 * 此时退回标量换算 —— 宁可保留旧行为，也不要把坐标换错。
 */

export interface Point2 {
  x: number;
  y: number;
}

/** 布局矩形四角在屏幕上的位置，顺序：左上 (0,0)、右上 (w,0)、右下 (w,h)、左下 (0,h) */
export type Quad = readonly [Point2, Point2, Point2, Point2];

/**
 * 四点单应反解：给出布局 (0,0)/(w,0)/(w,h)/(0,h) 对应的屏幕四点，
 * 返回「屏幕点 → 布局点」的映射；四边形退化时返回 null。
 *
 * 用的是 Heckbert《Fundamentals of Texture Mapping》里的单位正方形 → 四边形构造，
 * 再左乘 (x/w, y/h) 的缩放把布局坐标归一化。
 */
export function quadInverse(w: number, h: number, quad: Quad): ((x: number, y: number) => Point2) | null {
  if (!(w > 0) || !(h > 0)) return null;
  const [p0, p1, p2, p3] = quad;
  if (!p0 || !p1 || !p2 || !p3) return null;

  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  let a: number;
  let b: number;
  let c: number;
  let d: number;
  let e: number;
  let f: number;
  let g: number;
  let hh: number;

  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // 平行四边形 = 仿射，透视项恒为 0
    a = p1.x - p0.x;
    b = p3.x - p0.x;
    c = p0.x;
    d = p1.y - p0.y;
    e = p3.y - p0.y;
    f = p0.y;
    g = 0;
    hh = 0;
  } else {
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const det = dx1 * dy2 - dx2 * dy1;
    if (!det || !Number.isFinite(det)) return null;
    g = (sx * dy2 - dx2 * sy) / det;
    hh = (dx1 * sy - sx * dy1) / det;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + hh * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + hh * p3.y;
    f = p0.y;
  }

  // 合成：(x, y) → (x/w, y/h) → 屏幕
  const A = a / w;
  const B = b / h;
  const C = c;
  const D = d / w;
  const E = e / h;
  const F = f;
  const G = g / w;
  const H = hh / h;

  // 3×3 求逆（伴随矩阵 / 行列式）
  const det = A * (E - F * H) - B * (D - F * G) + C * (D * H - E * G);
  if (!det || !Number.isFinite(det)) return null;
  const m0 = (E - F * H) / det;
  const m1 = (C * H - B) / det;
  const m2 = (B * F - C * E) / det;
  const m3 = (F * G - D) / det;
  const m4 = (A - C * G) / det;
  const m5 = (C * D - A * F) / det;
  const m6 = (D * H - E * G) / det;
  const m7 = (B * G - A * H) / det;
  const m8 = (A * E - B * D) / det;

  return (x: number, y: number): Point2 => {
    const u = m0 * x + m1 * y + m2;
    const v = m3 * x + m4 * y + m5;
    const ww = m6 * x + m7 * y + m8;
    // 投影平面上的无穷远点（ww→0）没有布局坐标可言，原样返回 NaN 让调用方丢弃
    return { x: u / ww, y: v / ww };
  };
}

/** 视觉尺寸 → 布局尺寸的比值；没有变换时严格为 1（含小数像素带来的 ±1% 抖动） */
function layoutScaleOf(layoutPx: number, rectPx: number): number {
  if (!(layoutPx > 0) || !(rectPx > 0)) return 1;
  const k = layoutPx / rectPx;
  return Math.abs(k - 1) < 0.01 ? 1 : k;
}

/** canvas 自身或任一祖先是否带 transform / perspective —— 只看自己不够，变换在父级 */
function hasTransform(node: Element | null): boolean {
  const win = node?.ownerDocument?.defaultView;
  if (!win?.getComputedStyle) return false;
  let el: Element | null = node;
  // 深度设个上限，避免异常 DOM 上死循环
  for (let i = 0; el && i < 64; i++) {
    const cs = win.getComputedStyle(el);
    if (!cs) return false;
    if (cs.transform && cs.transform !== 'none') return true;
    if (cs.perspective && cs.perspective !== 'none') return true;
    // 独立的 rotate / scale / translate 属性（不写进 transform 也生效）
    if (cs.rotate && cs.rotate !== 'none') return true;
    if (cs.scale && cs.scale !== 'none') return true;
    if (cs.translate && cs.translate !== 'none') return true;
    el = el.parentElement;
  }
  return false;
}

/** 在 host 里摆 4 个 0×0 探针，读出它们被变换到屏幕上的位置 */
function probeQuad(host: Element, doc: Document, w: number, h: number, bx: number, by: number): Quad | null {
  const corners: Array<[number, number]> = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const probes: HTMLElement[] = [];
  try {
    for (const [x, y] of corners) {
      const d = doc.createElement('div');
      d.setAttribute('aria-hidden', 'true');
      d.style.cssText =
        'position:absolute;margin:0;padding:0;border:0;width:0;height:0;' +
        'pointer-events:none;visibility:hidden;' +
        `left:${bx + x}px;top:${by + y}px`;
      host.appendChild(d);
      probes.push(d);
    }
    return probes.map((d) => {
      const r = d.getBoundingClientRect();
      return { x: r.left, y: r.top };
    }) as unknown as Quad;
  } catch {
    return null;
  } finally {
    for (const p of probes) p.remove();
  }
}

/**
 * 四个角点的屏幕坐标。
 *
 * 先挂 canvas 的父节点（MapLibre 的 `.maplibregl-canvas-container`，通常就是 canvas 的盒子），
 * 包围盒对不上 rect 就说明绝对定位挂到了别的包含块上，换 `offsetParent` 并补上
 * `offsetLeft/offsetTop`（这两个偏移本来就是相对 offsetParent 量的）再试一次。
 * 两次都对不上就放弃，由调用方退回标量换算。
 */
function measureQuad(canvas: HTMLCanvasElement, w: number, h: number): Quad | null {
  const doc = canvas.ownerDocument as Document | undefined;
  const parent = canvas.parentElement;
  if (!doc?.createElement || !parent) return null;
  const rect = canvas.getBoundingClientRect();

  const first = probeQuad(parent, doc, w, h, 0, 0);
  if (first && quadMatchesRect(first, rect)) return first;

  const owner = canvas.offsetParent;
  if (owner && owner !== parent) {
    const second = probeQuad(owner, doc, w, h, canvas.offsetLeft, canvas.offsetTop);
    if (second && quadMatchesRect(second, rect)) return second;
  }
  return null;
}

/** 四边形包围盒与 rect 是否重合 —— 探针挂错包含块时立刻能看出来 */
function quadMatchesRect(quad: Quad, rect: { left: number; top: number; width: number; height: number }): boolean {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const tol = 1.5;
  return (
    Math.abs(minX - rect.left) <= tol &&
    Math.abs(minY - rect.top) <= tol &&
    Math.abs(maxX - (rect.left + rect.width)) <= tol &&
    Math.abs(maxY - (rect.top + rect.height)) <= tol
  );
}

/**
 * 客户端坐标 → canvas 布局坐标（即 `viewer.pick` / `layer.pick` 的入参口径）。
 *
 * 无 transform 时就是 `(clientX - rect.left, clientY - rect.top)`，与历史实现逐像素一致；
 * 有 transform 时用四点单应还原，任何一步不成立都退回标量换算（保留旧行为，不换错）。
 */
export function canvasPointFromClient(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number
): Point2 {
  const rect = canvas.getBoundingClientRect();
  const w = canvas.offsetWidth || canvas.clientWidth;
  const h = canvas.offsetHeight || canvas.clientHeight;

  if (hasTransform(canvas)) {
    const quad = measureQuad(canvas, w, h);
    if (quad && quadMatchesRect(quad, rect)) {
      const inv = quadInverse(w, h, quad);
      const p = inv?.(clientX, clientY);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    }
  }

  const kx = layoutScaleOf(w, rect.width);
  const ky = layoutScaleOf(h, rect.height);
  return { x: (clientX - rect.left) * kx, y: (clientY - rect.top) * ky };
}
