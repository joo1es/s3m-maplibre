/**
 * 父级 CSS transform 的拾取换算：四边形单应反解。
 *
 * 夹具全部来自 headless Chrome（1262×704 画布、RTX 4070 Ti、真实鼠标事件）实测：
 * 探针 div 放在 canvas 容器里、left/top 设成布局坐标，读出它在屏幕上的位置，
 * 就是「布局点 → 视觉点」的真值。点击点取的是「布局 (629,307) 这栋楼」在屏幕上的
 * 视觉位置，所以反解回去必须落回 (629,307)。
 *
 * 为什么不能用标量补偿（rect.width / offsetWidth）：那个比值对旋转来说是
 * **包围盒**的比，不是坐标轴上的比。实测 rotate(30deg) 偏 (19.9, 22.1) px，
 * perspective + rotateX(22deg) 偏 (−119.3, −58.4) px —— 都还在同一栋楼里，
 * 所以「点上去还能选中」骗过了肉眼，实际点的是另一面墙。
 */
import { describe, expect, test } from 'bun:test';
import { canvasPointFromClient, quadInverse, type Quad } from '../../packages/s3m-maplibre/src/pickPoint';

/** 夹具里为了好读写成 [x, y]，转成实现要求的对象形态 */
const q = (pts: number[][]): Quad => pts.map(([x, y]) => ({ x, y })) as unknown as Quad;

const W = 1262;
const H = 704;

/** 布局 (629, 307) 作为真值；case 里给的是该点在屏幕上的视觉位置 */
const TRUTH = { x: 629, y: 307 };

const cases: Array<{ name: string; quad: number[][]; at: { x: number; y: number }; why: string }> = [
  {
    name: '无 transform',
    quad: [[0, 0], [1262, 0], [1262, 704], [0, 704]],
    at: { x: 629, y: 307 },
    why: '恒等映射，改动前后必须逐像素一致',
  },
  {
    name: 'rotate(30deg)',
    quad: [[0, 0], [1092.9, 631], [740.9, 1240.7], [-352, 609.7]],
    at: { x: 391, y: 580 },
    why: '包围盒比值 1262/1444.9 = 0.873，标量补偿偏 (19.9, 22.1)',
  },
  {
    name: 'skewX(20deg)',
    quad: [[0, 0], [1262, 0], [1518.2, 704], [256.2, 704]],
    at: { x: 741, y: 307 },
    why: '剪切只改 x 分量、且沿 y 线性增长，标量补偿偏 (−13.1, 0)',
  },
  {
    name: 'skew(12deg, 8deg)',
    quad: [[0, 0], [1262, 177.4], [1411.6, 881.4], [149.6, 704]],
    at: { x: 694, y: 395 },
    why: '双向剪切，两轴的值互相污染',
  },
  {
    name: 'perspective(900) rotateY(28deg)',
    quad: [[0, 0], [671.9, 0], [671.9, 424.5], [0, 704]],
    at: { x: 418, y: 231 },
    why: '透视：右侧收窄，标量补偿偏 (156.1, −76)',
  },
  {
    name: 'perspective(900) rotateX(22deg)',
    quad: [[0, 0], [1262, 0], [1785.1, 923.3], [0, 923.3]],
    at: { x: 721, y: 326 },
    why: '透视：下沿放大，标量补偿偏 (−119.3, −58.4)',
  },
  {
    name: 'perspective(800) rotate3d(1,1,0,26deg)',
    quad: [[0, 0], [804.7, 42.9], [1014.4, 602.1], [49, 919.1]],
    at: { x: 545, y: 287 },
    why: '两个方向都带透视，四角都不共线',
  },
  {
    name: 'scale(0.7) rotate(15deg)',
    quad: [[0, 0], [853.3, 228.6], [725.8, 704.6], [-127.5, 476]],
    at: { x: 370, y: 322 },
    why: '缩放叠旋转：缩放先被旋转搅进包围盒，单独还原缩放不够',
  },
];

describe('四边形单应反解（父级 transform 下的拾取换算）', () => {
  for (const c of cases) {
    test(`${c.name}：视觉点反解回布局坐标（${c.why}）`, () => {
      const inv = quadInverse(W, H, q(c.quad));
      expect(inv).not.toBeNull();
      const p = inv!(c.at.x, c.at.y);
      // 夹具角点记到 0.1px，留 1px 容差
      expect(Math.abs(p.x - TRUTH.x)).toBeLessThan(1);
      expect(Math.abs(p.y - TRUTH.y)).toBeLessThan(1);
    });
  }

  test('平行四边形的退化分支（纯缩放+平移）与标量换算同解', () => {
    // 上一版按 rect 缩放做的换算：布局 (500,250) 在 scale(0.5) 下画到 (260,145)
    const inv = quadInverse(1000, 500, q([[10, 20], [510, 20], [510, 270], [10, 270]]))!;
    const p = inv(260, 145);
    expect(p.x).toBeCloseTo(500, 6);
    expect(p.y).toBeCloseTo(250, 6);
  });

  test('四边形退化（四点重合）时返回 null，由调用方退回标量换算', () => {
    const inv = quadInverse(W, H, q([[5, 5], [5, 5], [5, 5], [5, 5]]));
    expect(inv).toBeNull();
  });

  test('宽高为 0 时不做除法', () => {
    expect(quadInverse(0, 0, q([[0, 0], [0, 0], [0, 0], [0, 0]]))).toBeNull();
  });
});

describe('canvasPointFromClient：探针路径真的被走通（不是又悄悄退回标量）', () => {
  /**
   * 用假 DOM 复刻 MapLibre 的层级：canvas → .maplibregl-canvas-container →
   * #map（transform 挂在这一层）。探针的 getBoundingClientRect 按 rotate(30deg) 算，
   * 所以只要实现里真的量了四个角并解了单应，结果就该落回 (629,307)；
   * 退回标量的话会得到 (648.9, 329.1)（实测值），测试立刻能发现。
   */
  const makeDom = () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const toScreen = (x: number, y: number) => ({ x: x * c - y * s, y: x * s + y * c });

    const mapEl: Record<string, unknown> = { parentElement: null, appendChild: () => undefined };
    const container: Record<string, unknown> = { parentElement: mapEl, appendChild: () => undefined };
    const W = 1262;
    const H = 704;

    const mkProbe = () => {
      let left = 0;
      let top = 0;
      const style: Record<string, string> = {};
      const el = {
        style: new Proxy(style, {
          set(t, k, v) {
            const m = /left:(-?[\d.]+)px;top:(-?[\d.]+)px/.exec(String(v));
            if (m) {
              left = +m[1];
              top = +m[2];
            }
            t[k as string] = String(v);
            return true;
          },
        }),
        setAttribute: () => undefined,
        remove: () => undefined,
        getBoundingClientRect: () => {
          const p = toScreen(left, top);
          return { left: p.x, top: p.y, width: 0, height: 0 };
        },
      };
      return el;
    };

    const canvas = {
      offsetWidth: W,
      offsetHeight: H,
      clientWidth: W,
      clientHeight: H,
      offsetParent: mapEl,
      parentElement: container,
      getBoundingClientRect: () => {
        const pts = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => toScreen(x, y));
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
      },
      ownerDocument: {
        createElement: mkProbe,
        defaultView: {
          getComputedStyle: (el: unknown) => ({ transform: el === mapEl ? 'matrix(0.866, 0.5, -0.5, 0.866, 0, 0)' : 'none' }),
        },
      },
    };
    return canvas;
  };

  test('rotate(30deg)：反解回 (629,307)，与浏览器实测一致', () => {
    const p = canvasPointFromClient(makeDom() as unknown as HTMLCanvasElement, 391, 580);
    expect(Math.abs(p.x - 629)).toBeLessThan(1);
    expect(Math.abs(p.y - 307)).toBeLessThan(1);
  });

  test('没有 DOM（单测 / SSR）时退回标量换算，不抛异常', () => {
    const canvas = {
      offsetWidth: 1000,
      offsetHeight: 500,
      clientWidth: 1000,
      clientHeight: 500,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 250 }),
    };
    const p = canvasPointFromClient(canvas as unknown as HTMLCanvasElement, 260, 145);
    expect(p).toEqual({ x: 500, y: 250 });
  });
});
