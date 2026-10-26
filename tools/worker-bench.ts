/**
 * Worker 解析基准：同一批样例，主线程 parseS3MB vs S3MWorkerClient。
 * 只量解析本身（fetch / 几何组装两边都不含），对比 CPU 消耗去了哪。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { parseS3MB } from '../packages/s3m-three/src/core/S3MBParser';
import { S3MWorkerClient } from '../packages/s3m-three/src/worker/S3MWorkerClient';
import { toArrayBuffer } from '../tests/helpers/sample';

const files =
  process.argv[2] === '--big'
    ? [
        'demo/data/CBD/Tile_-14624_42667_0000/Tile_-14624_42667_0000_-0001_0002.s3mb',
        'demo/data/CBD/Tile_-14624_42667_0000/Tile_-14624_42667_0000_0001_0000.s3mb',
      ]
    : [
        'tests/fixtures/draco/pointcloud.s3mb',
        'tests/fixtures/draco/pointcloud-multi.s3mb',
        'tests/fixtures/gaussian-splatting/Tile_0019_262145_524289_0000.s3mb',
        'tests/fixtures/gaussian-splatting/Tile_0020_262145_524289_0003.s3mb',
      ];
const ROUNDS = 10;

async function bench(name: string, run: (buf: ArrayBuffer) => Promise<unknown>) {
  const times: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    for (const f of files) {
      const buf = toArrayBuffer(readFileSync(f));
      const t0 = performance.now();
      await run(buf);
      times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0);
  const per = total / times.length;
  console.log(
    `${name}: 平均 ${per.toFixed(2)} ms/块 | 单块最大 ${times[times.length - 1].toFixed(2)} ms | ${ROUNDS} 轮 × ${files.length} 块共 ${total.toFixed(0)} ms`
  );
  return per;
}

console.log(`环境: bun ${Bun.version}, ${files.length} 个样例 × ${ROUNDS} 轮`);
const main = await bench('主线程 parseS3MB', (buf) => parseS3MB(buf, { inflate: inflateSync }));

const client = S3MWorkerClient.create();
if (!client) {
  console.log('Worker 不可用，只跑了主线程基准');
} else {
  // 预热一轮（wasm 编译 / 首次消息通道建立）
  for (const f of files) await client.parseTile(toArrayBuffer(readFileSync(f)));
  const worker = await bench('Worker 解析      ', (buf) => client.parseTile(buf));
  client.dispose();
  console.log(`\n解析耗时比: Worker ${(worker / main * 100).toFixed(0)}% of 主线程（主线程侧收益还要加上「事件循环不再被阻塞」）`);
}
