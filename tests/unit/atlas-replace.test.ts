/**
 * 子瓦图集替换的准入判定
 *
 * 背景：S3MBLOCK 的**子瓦片**图集段只有元信息（`data = null` + `requestNames`），
 * 像素要另外拉 `.texblock`。拉回来之后拿什么标准判断「这张图能不能直接替换元信息
 * 里的那份」？
 *
 * 现在只比长宽比（误差 2%）。这不够：
 *
 *   `subTexInfos` 的 offset/width 是**像素**，替换后要按 `rectScale = img.width / tex.width`
 *   换算到新图空间。只有**同一个整数倍**时换算结果才落在整数像素上；1.37 倍这种会让
 *   rect 落在半个纹素上，双线性采样就会把邻格内容混进来 —— 视觉上正是「同一块花纹
 *   重复出现」和「规整的深色块」。官方 `AtlasUpgrade.ts` 的注释也写了这条：
 *   「两轴必须是同一个整数倍……非整数倍会让 rect 落到半个纹素上」。
 *
 * 有缩略图基准（根块）时走 `evaluateAtlasUpgrade`，那边已经带这一条；无基准的子瓦
 * 走的是另一条分支，**漏了这个判定**。这个文件就是那条分支的用例。
 */
import { describe, expect, test } from 'bun:test';
import { canAdoptAtlasWithoutBaseline, pickAtlasCandidate } from '../../packages/s3m-three/src/core/AtlasUpgrade';

describe('无基准的图集替换准入', () => {
  test('整数倍放大且长宽比一致 → 接受', () => {
    // 384x256 的元信息，换成 768x512（正好 2 倍）
    expect(canAdoptAtlasWithoutBaseline(384, 256, 768, 512)).toBe(true);
  });

  test('原尺寸换原尺寸（1 倍）→ 接受', () => {
    expect(canAdoptAtlasWithoutBaseline(384, 256, 384, 256)).toBe(true);
  });

  test('4 倍 → 接受', () => {
    expect(canAdoptAtlasWithoutBaseline(384, 256, 1536, 1024)).toBe(true);
  });

  test('长宽比一致但不是整数倍（1.37x）→ 拒绝：rect 会落到半纹素上', () => {
    // 526/384 ≈ 1.37，350/256 ≈ 1.367 —— 长宽比也在 2% 内，旧判据会放行
    expect(canAdoptAtlasWithoutBaseline(384, 256, 526, 350)).toBe(false);
  });

  test('两轴倍率不同（x 2 倍、y 3 倍）→ 拒绝：rect 换算只有一个 scale', () => {
    expect(canAdoptAtlasWithoutBaseline(384, 256, 768, 768)).toBe(false);
  });

  test('长宽比偏差超过容差 → 拒绝', () => {
    // 384x256 (1.5) vs 640x256 (2.5)
    expect(canAdoptAtlasWithoutBaseline(384, 256, 640, 256)).toBe(false);
  });

  test('尺寸非法（0 / 负数 / NaN）→ 拒绝，不能拿它去换算 rect', () => {
    expect(canAdoptAtlasWithoutBaseline(384, 256, 0, 0)).toBe(false);
    expect(canAdoptAtlasWithoutBaseline(0, 0, 384, 256)).toBe(false);
    expect(canAdoptAtlasWithoutBaseline(384, 256, -768, -512)).toBe(false);
    expect(canAdoptAtlasWithoutBaseline(Number.NaN, 256, 768, 512)).toBe(false);
  });
});

/**
 * 候选记录的选择
 *
 * 一个 `.texblock` 文件里可能有多条记录（`Tile_6_000000.texblock` 实测 16 条）。
 * 旧实现盲取 `recs[0]`，于是经常拿到**另一张图集**：元信息声明 1536x1024，实际选中的
 * 是 384x256 那张 —— `rectScale` 变成 0.25，整块瓦片的 rect 一起缩到角落里，贴图
 * 串位。这里要求按请求名匹配记录 id，匹配不上才退回第一条。
 */
describe('图集候选按名字匹配', () => {
  const rec = (id: string, width: number) => ({ id, width, height: 1 });

  test('多条记录里选中与请求名一致的那条，而不是第一条', () => {
    const recs = [rec('129_2.texblock', 96), rec('1411657809.texblock', 1536)];
    const got = pickAtlasCandidate(recs, '1411657809.texblock');
    expect(got?.id).toBe('1411657809.texblock');
    expect(got?.width).toBe(1536);
  });

  test('扩展名大小写 / 缺省时也能匹配', () => {
    const recs = [rec('a.texblock', 1), rec('B.TEXBLOCK', 2)];
    expect(pickAtlasCandidate(recs, 'B')?.width).toBe(2);
    expect(pickAtlasCandidate(recs, 'B.texblock')?.width).toBe(2);
  });

  test('没有匹配项时退回第一条（旧行为，不能直接返回 null）', () => {
    const recs = [rec('other.texblock', 7)];
    expect(pickAtlasCandidate(recs, 'missing.texblock')?.width).toBe(7);
  });

  test('空数组 / undefined → null', () => {
    expect(pickAtlasCandidate([], 'a.texblock')).toBeNull();
    expect(pickAtlasCandidate(undefined, 'a.texblock')).toBeNull();
  });
});
