/**
 * 单元测试：等宽线几何的顶点布局
 *
 * 这个布局是**对外契约**，不是实现细节：飞线之类的用法要在建好几何后补一个
 * 逐顶点的 `aAlong`（沿弧长参数），而补法完全取决于「每段 4 枚顶点、顺序是
 * A-、A+、B+、B-」。库这边一改顺序，示例的拖尾就会错位，但画面照样渲染 ——
 * 属于最难查的那类静默失效，所以钉死。
 */
import { describe, expect, test } from 'bun:test';
import { buildThickLineGeometry } from '../../packages/s3m-three/src/render/EdgeLines';

describe('等宽线几何 / 顶点布局', () => {
  test('单段 4 枚顶点，顺序是 A-、A+、B+、B-', () => {
    const geo = buildThickLineGeometry([0, 0, 0, 10, 0, 0]);
    const pos = geo.getAttribute('position');
    const other = geo.getAttribute('aOther');
    const side = geo.getAttribute('aSide');

    expect(pos.count).toBe(4);
    // 前两枚在 A 端，后两枚在 B 端
    expect([pos.getX(0), pos.getX(1)]).toEqual([0, 0]);
    expect([pos.getX(2), pos.getX(3)]).toEqual([10, 10]);
    // aOther 指向线段另一端
    expect([other.getX(0), other.getX(1)]).toEqual([10, 10]);
    expect([other.getX(2), other.getX(3)]).toEqual([0, 0]);
    // 侧向符号：A 端 -1 / +1，B 端 +1 / -1（反向，才能拼成一条带）
    expect([side.getX(0), side.getX(1), side.getX(2), side.getX(3)]).toEqual([-1, 1, 1, -1]);
  });

  test('索引是两个三角形，共用 A- 与 B+', () => {
    const geo = buildThickLineGeometry([0, 0, 0, 10, 0, 0]);
    const index = geo.getIndex();
    expect(index).not.toBeNull();
    expect(Array.from(index!.array)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  test('多段时顶点按段连续排布，段 i 的起点是 4i', () => {
    const geo = buildThickLineGeometry([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0]);
    const pos = geo.getAttribute('position');
    expect(pos.count).toBe(8);
    // 第 2 段（索引 4..7）的 A 端在 x=1，B 端在 x=2
    expect([pos.getX(4), pos.getX(5)]).toEqual([1, 1]);
    expect([pos.getX(6), pos.getX(7)]).toEqual([2, 2]);
    // 索引也是按段偏移 4
    const idx = Array.from(geo.getIndex()!.array);
    expect(idx.slice(6, 12)).toEqual([4, 5, 6, 4, 6, 7]);
  });

  test('不传 batchIds 时 aBatchId 全为 -1（着色器跳过采样）', () => {
    const geo = buildThickLineGeometry([0, 0, 0, 1, 0, 0]);
    const batch = geo.getAttribute('aBatchId');
    expect([batch.getX(0), batch.getX(1), batch.getX(2), batch.getX(3)]).toEqual([-1, -1, -1, -1]);
  });
});
