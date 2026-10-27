/**
 * 折线路径（弧长参数化）
 *
 * 为什么不能直接对顶点做插值：顶点疏密不均时，`lerp(p[i], p[i+1], t)` 的速度
 * 取决于顶点间距——顶点密的地方走得慢、疏的地方一下窜过去。所以先把折线展开成
 * **累计弧长表**，运动时按「已走距离 s」反解位置，缓动作用在距离上而不是顶点索引上。
 *
 * 纯数学，不依赖 three，可以单独测。
 */
export class Path {
  /** 扁平坐标 xyz */
  private readonly _pts: Float32Array;
  /** 每个顶点处的累计弧长，长度与顶点数相同 */
  private readonly _cum: Float32Array;
  /** 总弧长（米） */
  readonly length: number;

  constructor(points: ArrayLike<number> | Array<[number, number, number]>, opts: { closed?: boolean } = {}) {
    const flat = Path._flatten(points);
    const closed = opts.closed === true && flat.length >= 9;
    const count = flat.length / 3;
    const n = closed ? count + 1 : count;

    this._pts = new Float32Array(n * 3);
    this._pts.set(flat);
    if (closed) {
      // 闭合路径：末尾补回起点，走完一圈刚好回到原处
      this._pts[n * 3 - 3] = flat[0];
      this._pts[n * 3 - 2] = flat[1];
      this._pts[n * 3 - 1] = flat[2];
    }

    this._cum = new Float32Array(Math.max(n, 1));
    let total = 0;
    for (let i = 1; i < n; i++) {
      const a = (i - 1) * 3;
      const b = i * 3;
      total += Math.hypot(
        this._pts[b] - this._pts[a],
        this._pts[b + 1] - this._pts[a + 1],
        this._pts[b + 2] - this._pts[a + 2]
      );
      this._cum[i] = total;
    }
    this.length = total;
  }

  /**
   * 取弧长 s 处的位置。
   * @param s 已走距离（米），会被夹到 [0, length]
   * @param out 结果写入这里（长度 ≥ 3 的数组）
   */
  sample(s: number, out: Float32Array | number[]): void {
    const n = this._pts.length / 3;
    if (n === 0) {
      out[0] = out[1] = out[2] = 0;
      return;
    }
    if (n === 1 || this.length <= 0) {
      out[0] = this._pts[0];
      out[1] = this._pts[1];
      out[2] = this._pts[2];
      return;
    }

    const d = Math.min(this.length, Math.max(0, s));
    // 二分查段：cum[i] <= d <= cum[i+1]
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this._cum[mid] <= d) lo = mid;
      else hi = mid;
    }

    const segLen = this._cum[hi] - this._cum[lo];
    const k = segLen > 0 ? (d - this._cum[lo]) / segLen : 0;
    const a = lo * 3;
    const b = hi * 3;
    out[0] = this._pts[a] + (this._pts[b] - this._pts[a]) * k;
    out[1] = this._pts[a + 1] + (this._pts[b + 1] - this._pts[a + 1]) * k;
    out[2] = this._pts[a + 2] + (this._pts[b + 2] - this._pts[a + 2]) * k;
  }

  /** 按归一化进度取位置（0 → 起点，1 → 终点） */
  sampleAt(t: number, out: Float32Array | number[]): void {
    this.sample(Math.min(1, Math.max(0, t)) * this.length, out);
  }

  private static _flatten(points: ArrayLike<number> | Array<[number, number, number]>): Float32Array {
    if (points.length === 0) return new Float32Array(0);
    // 扁平数组：[x,y,z, x,y,z, ...]
    if (typeof (points as ArrayLike<number>)[0] === 'number') {
      const arr = points as ArrayLike<number>;
      if (arr.length % 3 !== 0) throw new Error('[s3m] 路径点数组长度必须是 3 的倍数');
      return Float32Array.from(arr as ArrayLike<number>);
    }
    const tuples = points as Array<[number, number, number]>;
    const out = new Float32Array(tuples.length * 3);
    for (let i = 0; i < tuples.length; i++) {
      out[i * 3] = tuples[i][0];
      out[i * 3 + 1] = tuples[i][1];
      out[i * 3 + 2] = tuples[i][2];
    }
    return out;
  }
}
