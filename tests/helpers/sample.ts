/**
 * 官方样例仓库的定位与遍历工具（测试共用）
 *
 * s3m-spec 是可选依赖：没克隆到同级目录时相关用例自动跳过，
 * 用 S3M_SAMPLE_DIR 可以指到任意位置。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_ROOT =
  process.env.S3M_SAMPLE_DIR ?? fileURLToPath(new URL('../../../s3m-spec/S3M_SDK/S3M_JS/data/', import.meta.url));

export function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 递归收集目录下所有 .s3mb */
export function walkS3mb(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkS3mb(p, out);
    else if (name.endsWith('.s3mb')) out.push(p);
  }
  return out;
}
