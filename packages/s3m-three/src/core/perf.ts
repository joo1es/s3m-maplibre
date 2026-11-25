/**
 * 渲染热路径计数器（常开，开销只有几次加法）。
 *
 * 目的是**先量再改**：哪一段占主线程时间，用数字说话，不靠猜。
 * 读法（浏览器控制台，smart-city 里已经挂到 window 上）：
 *
 *   __s3mPerf()        // 打印快照
 *   __s3mPerfReset()   // 清零，然后推一遍镜头再看
 *
 * 各项含义：
 *   uploadBytes/uploadMs  图集分带上传搬了多少字节 / 花了多少毫秒（只统计我们自己搬的）
 *   decodeMainMs          主线程纹理解码耗时（Worker 可用时大部分应落在 decodeWorkerMs）
 *   composeMs             leaf 图集合成（逐行拼画布）—— 注释里实测整场 2.7s 的那一段
 *   packMs                拼图（packTexturePackage）+ 重建 rect/纹理表
 *   commitMs              瓦片进场景（纹理上传 + 首次编译 + 棱线）的总耗时
 *   programCompiles       program 首次编译次数（每次都会掉帧）
 *   frameMsAvg/Max        渲染帧间隔（仅 renderFrame 之间）
 */

export interface PerfSnapshot {
  frames: number;
  frameMsAvg: number;
  frameMsMax: number;
  uploadBytes: number;
  uploadMs: number;
  uploadBands: number;
  decodeMainMs: number;
  decodeMainCount: number;
  decodeWorkerMs: number;
  decodeWorkerCount: number;
  composeMs: number;
  composeCount: number;
  packMs: number;
  packCount: number;
  commitMs: number;
  commitCount: number;
  programCompiles: number;
}

interface MutablePerf extends PerfSnapshot {
  frameMsSum: number;
}

const p: MutablePerf = {
  frames: 0,
  frameMsAvg: 0,
  frameMsMax: 0,
  frameMsSum: 0,
  uploadBytes: 0,
  uploadMs: 0,
  uploadBands: 0,
  decodeMainMs: 0,
  decodeMainCount: 0,
  decodeWorkerMs: 0,
  decodeWorkerCount: 0,
  composeMs: 0,
  composeCount: 0,
  packMs: 0,
  packCount: 0,
  commitMs: 0,
  commitCount: 0,
  programCompiles: 0,
};

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export const perf = {
  noteUpload(bytes: number, ms: number, bands: number): void {
    p.uploadBytes += bytes;
    p.uploadMs += ms;
    p.uploadBands += bands;
  },
  noteDecode(ms: number, viaWorker: boolean): void {
    if (viaWorker) {
      p.decodeWorkerMs += ms;
      p.decodeWorkerCount++;
    } else {
      p.decodeMainMs += ms;
      p.decodeMainCount++;
    }
  },
  noteCompose(ms: number): void {
    p.composeMs += ms;
    p.composeCount++;
  },
  notePack(ms: number): void {
    p.packMs += ms;
    p.packCount++;
  },
  noteCommit(ms: number): void {
    p.commitMs += ms;
    p.commitCount++;
  },
  noteProgramCompiles(n: number): void {
    if (n > 0) p.programCompiles += n;
  },
  noteFrame(ms: number): void {
    if (!(ms > 0) || ms > 10_000) return; // 标签页切后台会给出巨大间隔，丢掉
    p.frames++;
    p.frameMsSum += ms;
    if (ms > p.frameMsMax) p.frameMsMax = ms;
  },
  t0: now,
};

export function perfSnapshot(): PerfSnapshot {
  return {
    ...p,
    frameMsAvg: p.frames ? p.frameMsSum / p.frames : 0,
  };
}

export function resetPerf(): void {
  for (const k of Object.keys(p) as (keyof MutablePerf)[]) {
    (p as unknown as Record<string, number>)[k] = 0;
  }
}
