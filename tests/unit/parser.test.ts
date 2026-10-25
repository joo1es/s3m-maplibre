/**
 * 解析层单测：用官方样例逐项断言，而不是「跑通不崩」。
 *
 * 覆盖：字节消费完整性、顶点属性布局与跨距、索引类型与越界、
 * 三角形索引数、法线归一化、DXT 纹理块对齐、单体化 batchId 合法性、截断输入报错。
 *
 * 样例仓库是可选依赖：没有就整组跳过（CI 里默认跳过），可用 S3M_SAMPLE_DIR 指定。
 * 每个样例文件是一个独立用例 —— 某个数据集坏了不会掩盖其他数据集的结果。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { SAMPLE_ROOT, toArrayBuffer, walkS3mb } from '../helpers/sample';

const ROOT = SAMPLE_ROOT;
const files = existsSync(ROOT) ? walkS3mb(ROOT).sort() : [];

/** DXT 系列：像素格式 → 每 4×4 块的字节数 */
const DXT_BLOCK: Record<number, number> = { 17: 8, 19: 16, 20: 16, 21: 16 };

if (files.length === 0) {
  test.skip(`跳过解析单测：没有找到 ${ROOT}（克隆 SuperMap/s3m-spec 到同级目录，或用 S3M_SAMPLE_DIR 指定）`, () => {});
} else {
  describe(`解析官方样例（${files.length} 个 .s3mb）`, () => {
    for (const file of files) {
      const label = file.slice(ROOT.length).replace(/\\/g, '/');

      test(label, async () => {
        const tile = await parseS3MB(toArrayBuffer(readFileSync(file)), { inflate: inflateSync });

        // 1. 字节消费完整性：多读少读都说明某段偏移算错了
        expect(tile.bytesRead).toBe(tile.bytesTotal);
        expect(tile.bytesRead).toBeGreaterThan(0);
        expect(tile.version).toBeGreaterThan(0);

        // 2. 几何
        const geoNames = Object.keys(tile.geoPackage);
        expect(geoNames.length).toBeGreaterThan(0);

        for (const [name, geo] of Object.entries(tile.geoPackage) as [string, any][]) {
          const vp = geo.vertexPackage;
          const n = vp.verticesCount;
          expect(n).toBeGreaterThan(0);

          const pos = vp.vertexAttributes.find((a: any) => a.semantic === 'position');
          expect(pos).toBeTruthy();
          const comps = pos.components ?? 3;
          // 跨距可能是 16（vec4 补齐），必须按跨距读，不能假设紧凑排列
          const stride = pos.stride ?? comps * 4;
          expect(comps).toBeGreaterThanOrEqual(3);
          expect(stride).toBeGreaterThanOrEqual(comps * 4);
          expect(pos.data.byteLength).toBe(n * stride);

          const f32 = new Float32Array(pos.data.buffer, pos.data.byteOffset, (n * stride) >> 2);
          const perVertex = stride >> 2;
          let bad = 0;
          for (let i = 0; i < n; i++) {
            for (let c = 0; c < 3; c++) if (!Number.isFinite(f32[i * perVertex + c])) bad++;
          }
          expect(bad).toBe(0); // position 里有非有限值

          // 法线要归一化：MeshOpt 反量化算错的话这里立刻会炸
          const nrm = vp.vertexAttributes.find((a: any) => a.semantic === 'normal');
          if (nrm) {
            const nStride = nrm.stride ?? (nrm.components ?? 3) * 4;
            const nf32 = new Float32Array(nrm.data.buffer, nrm.data.byteOffset, (n * nStride) >> 2);
            const nPer = nStride >> 2;
            let worst = 0;
            for (let i = 0; i < n; i++) {
              const len = Math.hypot(nf32[i * nPer], nf32[i * nPer + 1], nf32[i * nPer + 2]);
              worst = Math.max(worst, Math.abs(len - 1));
            }
            expect(worst).toBeLessThan(1e-3);
          }

          for (const ip of geo.indexPackages) {
            const itemBytes = ip.indexType === 0 ? 2 : 4;
            expect(ip.indices.byteLength).toBe(ip.indexCount * itemBytes);

            if (ip.primitiveType === 4) expect(ip.indexCount % 3).toBe(0); // 三角形索引数不是 3 的倍数

            const idx =
              ip.indexType === 0
                ? new Uint16Array(ip.indices.buffer, ip.indices.byteOffset, ip.indexCount)
                : new Uint32Array(ip.indices.buffer, ip.indices.byteOffset, ip.indexCount);
            let maxIdx = 0;
            for (const v of idx) if (v > maxIdx) maxIdx = v;
            expect(maxIdx).toBeLessThan(n); // 索引越界
          }
        }

        // 3. 纹理：块压缩格式的字节数必须整块对齐，且至少容纳第 0 层
        for (const [code, tex] of Object.entries(tile.textures) as [string, any][]) {
          expect(tex.width).toBeGreaterThan(0);
          expect(tex.height).toBeGreaterThan(0);

          const blockSize = DXT_BLOCK[tex.pixelFormat];
          if (blockSize) {
            const level0 = Math.max(1, Math.ceil(tex.width / 4)) * Math.max(1, Math.ceil(tex.height / 4)) * blockSize;
            expect(tex.data.length).toBeGreaterThanOrEqual(level0);
            expect(tex.data.length % blockSize).toBe(0);
          }
        }

        // 4. 单体化：batchId 非负整数，且顶点区间必须落在所属几何的顶点范围内
        //    pickInfo 形状：{ geode: { [smid]: { batchId, segments: [{ vertexOffset, vertexCount }] } } }
        if (tile.pickInfo && typeof tile.pickInfo === 'object') {
          for (const [geode, bySmid] of Object.entries(tile.pickInfo) as [string, any][]) {
            if (!bySmid || typeof bySmid !== 'object') continue;
            const n = tile.geoPackage[geode]?.vertexPackage?.verticesCount ?? 0;

            for (const [smid, entry] of Object.entries(bySmid) as [string, any][]) {
              // 单体化有两种表达：按 batch 切（精模）或用实例 id（白模实例化）
              if (entry?.batchId != null) {
                expect(Number.isInteger(entry.batchId) && entry.batchId >= 0).toBe(true);
                for (const seg of entry.segments ?? []) {
                  expect(seg.vertexCount).toBeGreaterThan(0);
                  expect(seg.vertexOffset).toBeGreaterThanOrEqual(0);
                  expect(seg.vertexOffset + seg.vertexCount).toBeLessThanOrEqual(n); // 顶点区间越界
                }
              } else if (entry?.instanceIds) {
                expect(Array.isArray(entry.instanceIds) && entry.instanceIds.length > 0).toBe(true);
                for (const id of entry.instanceIds) expect(Number.isInteger(id) && id >= 0).toBe(true);
              } else {
                throw new Error(`单体 ${geode}/${smid} 既没有 batchId 也没有 instanceIds`);
              }
            }
          }
        }
      });
    }

    // 5. 截断输入必须报错，而不是静默返回半截数据
    test('截断的瓦片会抛错，不会静默返回半截数据', async () => {
      const buf = readFileSync(files[0]);
      const half = toArrayBuffer(buf).slice(0, Math.floor(buf.byteLength / 2));
      await expect(parseS3MB(half, { inflate: inflateSync })).rejects.toThrow();
    });
  });
}
