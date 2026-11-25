/**
 * 真实 S3MBLOCK 图集的「镂空」不变量（Bridge@CBD 子瓦，CRN_DXT5）。
 *
 * 曾经的故障：CRN 转码回来没翻行，图集每行精灵落到镜像行，几何绑到的是空白槽。
 * 按顶点加权实测 47.7% 的绑定面积 alpha=0 —— 配上 alphaTest 就是远景桥面成片消失。
 * 修好之后同一口径是 11.1%（每个 rect 都有的固定透明边条，属正常）。
 *
 * 这条测试钉的就是这个数：**几何绑定到的精灵，绝大多数像素必须是不透明的**。
 * 它与渲染后端无关（只看解码后的像素 + 文件里的绑定关系），所以能挡住任何
 * 「翻行 / 行序 / rect 换算」类的回归——包括着色器翻行、分带上传之后。
 *
 * 最后一条用例是它的「阴性对照」：故意把行序翻错，同一口径必须掉到 30% 以上。
 * 没有这条，前面的阈值只是空转 —— 测不出问题的测试等于没写。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseS3MBlock } from '../../packages/s3m-three/src/core/S3MBlockParser';
import { decodeTextureData } from '../../packages/s3m-three/src/core/TextureDecode';
import type { S3MTexture } from '../../packages/s3m-three/src/core/types';

/** 判定「像素不透明」的阈值，与 alphaTest 的 0.01（≈2.55/255）同口径 */
const ALPHA_OPAQUE = 3;

interface Metric {
  /** 按顶点加权的透明像素占比 */
  ratio: number;
  /** 被几何引用、但整块 100% 透明的精灵所占的顶点数 */
  fullyTransparent: number;
  /** 参与统计的精灵数 */
  sprites: number;
}

/**
 * 只统计**被几何绑定**的精灵（`bindings` 里 texUnitIndex 0 的顶点数做权重），
 * 且只看 mip0 内容区（rect 左 2/3）。右 1/3 是内联 mip 列，本来就是缩略图。
 */
function transparentRatio(
  pixels: Uint8Array,
  width: number,
  height: number,
  tile: { geoPackage?: Record<string, any> },
  tp: Record<string, any>
): Metric {
  let weightedZero = 0;
  let weightedAll = 0;
  let fullyTransparent = 0;
  let sprites = 0;

  for (const [id, src] of Object.entries(tp)) {
    if (!src?.subTexInfos?.length) continue;
    const rs = src.rectScale ?? 1;
    for (const sub of src.subTexInfos as any[]) {
      const verts = (sub.bindings ?? []).reduce((n: number, b: any) => {
        const geo = tile.geoPackage?.[b.geoName];
        return n + (b.texUnitIndex === 0 ? (geo?.vertexPackage?.verticesCount ?? 0) : 0);
      }, 0);
      if (!verts) continue;

      const w = Math.round(sub.width * rs);
      const h = Math.round(sub.height * rs);
      const baseW = Math.round((w * 2) / 3);
      let zero = 0;
      let all = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < baseW; x++) {
          const px = Math.round(sub.offsetX * rs) + x;
          const py = Math.round(sub.offsetY * rs) + y;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const a = pixels[(py * width + px) * 4 + 3];
          all++;
          if (a < ALPHA_OPAQUE) zero++;
        }
      }
      if (!all) continue;
      weightedZero += (zero / all) * verts;
      weightedAll += verts;
      if (zero === all) fullyTransparent += verts;
      sprites++;
      void id;
    }
  }

  return {
    ratio: weightedZero / Math.max(weightedAll, 1),
    fullyTransparent,
    sprites,
  };
}

async function loadFixture(): Promise<{
  tile: Awaited<ReturnType<typeof parseS3MBlock>>;
  tp: Record<string, any>;
}> {
  const buf = readFileSync(join(import.meta.dir, '../fixtures/s3mblock/bridge-child.s3mblock'));
  const tile = await parseS3MBlock(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const tp = (tile as unknown as { texturePackage?: Record<string, any> }).texturePackage ?? {};
  return { tile, tp };
}

/** 把每张图集解成 RGBA（按 flipY 决定行序），拼成「每个精灵一项」的加权统计 */
async function measure(
  tile: Awaited<ReturnType<typeof parseS3MBlock>>,
  tp: Record<string, any>,
  /** 覆盖 tex.flipY（不传 = 用文件里的值）；false = 故意不翻行，复现整行错位 */
  flipYOverride?: boolean
): Promise<Metric> {
  let wZero = 0;
  let wAll = 0;
  let fully = 0;
  let sprites = 0;
  for (const [id, tex] of Object.entries(tile.textures)) {
    const src = tp[id];
    if (!src?.subTexInfos?.length) continue;
    const t = flipYOverride === undefined ? tex : ({ ...(tex as S3MTexture), flipY: flipYOverride } as S3MTexture);
    const decoded = await decodeTextureData(t, { compressed: false });
    if (!decoded.rgba) continue;
    const m = transparentRatio(decoded.rgba, decoded.width, decoded.height, tile as any, { [id]: src });
    // 用顶点数还原加权（transparentRatio 返回的是比值，这里按精灵重新加权）
    const verts = (src.subTexInfos as any[]).reduce(
      (n, sub) =>
        n +
        (sub.bindings ?? []).reduce((k: number, b: any) => {
          const geo = (tile.geoPackage as any)?.[b.geoName];
          return k + (b.texUnitIndex === 0 ? (geo?.vertexPackage?.verticesCount ?? 0) : 0);
        }, 0),
      0
    );
    if (!verts) continue;
    wZero += m.ratio * verts;
    wAll += verts;
    fully += m.fullyTransparent;
    sprites += m.sprites;
  }
  return { ratio: wZero / Math.max(wAll, 1), fullyTransparent: fully, sprites };
}

describe('真实图集：几何绑定的精灵不能整块透明', () => {
  test('bridge-child.s3mblock：加权透明率必须远低于「整行错位」时的 47.7%', async () => {
    const { tile, tp } = await loadFixture();
    const m = await measure(tile, tp);
    expect(m.sprites).toBeGreaterThan(0);
    // 这张子瓦正常是 0%（根瓦片当年是 11.1%，那些固定边条只在大 rect 上出现）；
    // 行序错位时是 23.4%（根瓦片 47.7%）。取 10% 留出余量。
    expect(m.ratio).toBeLessThan(0.1);
    // 被几何引用的精灵里不能有整块透明的（那正是「桥面成片消失」的形态）
    expect(m.fullyTransparent).toBe(0);
  });

  test('阴性对照：行序翻错时，同一口径必须明显变差（>15%）', async () => {
    const { tile, tp } = await loadFixture();
    // 文件里的纹理本来就是 flipY: true（已翻行）。这里关掉它 = 回到修复前的行序。
    const bad = await measure(tile, tp, false);
    expect(bad.ratio).toBeGreaterThan(0.15);
  });
});
