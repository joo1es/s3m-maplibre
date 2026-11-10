/**
 * Draco 压缩的 3DGS：GS_Scale / GS_Rotation 自定义流必须透传到泼溅渲染路径
 *
 * 寿宁阁那份 3DGS 走 MeshOpt，泼溅参数是 u8 log 量化（见 core/GaussianSplat.ts）。
 * 官方 `Latest(行标)/sampledata/gaussianSplatting/sculpture.scp` 走 **Draco**，
 * `customVertexAttribute` 里写的是 `{"GS_Rotation":1,"GS_Scale":0}`，解码出来是
 * **已经还原好的 float32 真实值**：
 *   GS_Scale    3 分量，米制半轴（0.0088 / 0.0024 / 0.0002 …）
 *   GS_Rotation 4 分量，单位四元数，官方内部顺序 (w, x, y, z)
 *
 * 旧实现 Draco.ts 只挑 PointCloudClassCode，把这两条流丢了，于是解析结果里
 * 只有 position/color，S3MBParser 打上 gaussian-splatting-points 降级标记，
 * 3DGS 数据被画成一堆点。这里钉住「按 dtype 走无损 f32 路径」这条链路。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { decodeScaleF32, decodeRotationF32 } from '../../packages/s3m-three/src/core/GaussianSplat';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';

const SCULPTURE = join(import.meta.dir, '../../demo/data/sculpture/1.s3mb');
const DRACO_FIXTURES = join(import.meta.dir, '../fixtures/draco');

const parse = async (path: string) => {
  const b = readFileSync(path);
  // Buffer 可能是从共享内存池切出来的，直接取 .buffer 会把邻居的字节也带上
  return parseS3MB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, {
    inflate: (x) => inflateSync(x),
  });
};

const firstSkeleton = (tile: Awaited<ReturnType<typeof parse>>) => Object.values(tile.geoPackage)[0]!;

describe('真实 sculpture 瓦片（Draco 3DGS）', () => {
  test('声明是 3DGS，且不再打 gaussian-splatting-points 降级标记', async () => {
    const tile = await parse(SCULPTURE);
    expect(tile.version).toBe(3.01);
    expect((tile.extensions as { GaussianSplatting?: { isGaussianSplatting?: boolean } }).GaussianSplatting)
      ?.toMatchObject({ isGaussianSplatting: true });
    expect(tile.degradations ?? []).not.toContain('gaussian-splatting-points');
  });

  test('GS_Scale / GS_Rotation 归一成 gsScale / gsRotation，且保持 f32 无损', async () => {
    const vp = firstSkeleton(await parse(SCULPTURE)).vertexPackage;
    const scale = vp.vertexAttributes.find((a) => a.semantic === 'gsScale');
    const rot = vp.vertexAttributes.find((a) => a.semantic === 'gsRotation');

    expect(scale).toBeTruthy();
    expect(rot).toBeTruthy();
    expect(scale!.dtype).toBe('f32');
    expect(rot!.dtype).toBe('f32');
    expect(scale!.components).toBe(3);
    expect(rot!.components).toBe(4);
    expect(scale!.stride).toBe(12);
    expect(rot!.stride).toBe(16);
    expect(scale!.data.length).toBe(vp.verticesCount * 12);
    expect(rot!.data.length).toBe(vp.verticesCount * 16);
    // 原本的 position / color 不能被动过
    expect(vp.vertexAttributes.map((a) => a.semantic)).toContain('position');
    expect(vp.vertexAttributes.map((a) => a.semantic)).toContain('color');
  });

  test('f32 解码：尺度是米，四元数重排成 three 的 (x,y,z,w) 且单位化', async () => {
    const vp = firstSkeleton(await parse(SCULPTURE)).vertexPackage;
    const scale = vp.vertexAttributes.find((a) => a.semantic === 'gsScale')!;
    const rot = vp.vertexAttributes.find((a) => a.semantic === 'gsRotation')!;

    const scales = decodeScaleF32(scale.data, scale.stride, scale.offsetInBytes, 2);
    expect(scales[0]).toBeCloseTo(0.00885503, 7);
    expect(scales[1]).toBeCloseTo(0.00236107, 7);
    expect(scales[2]).toBeCloseTo(0.00019977, 8);
    expect(scales[3]).toBeCloseTo(0.01522621, 7);

    const quats = decodeRotationF32(rot.data, rot.stride, rot.offsetInBytes, 1);
    // 官方原始是 (w,x,y,z) = (0.98608, -0.05197, 0.10928, -0.11403)
    expect(quats[0]).toBeCloseTo(-0.0519734, 6);
    expect(quats[1]).toBeCloseTo(0.1092826, 6);
    expect(quats[2]).toBeCloseTo(-0.1140350, 6);
    expect(quats[3]).toBeCloseTo(0.9860798, 6);
    expect(Math.hypot(quats[0]!, quats[1]!, quats[2]!, quats[3]!)).toBeCloseTo(1, 5);
  });
});

describe('默认不生效：普通 Draco 点云不凭空造泼溅流', () => {
  test('单骨架 / 多骨架点云都只有常规属性', async () => {
    for (const name of ['pointcloud.s3mb', 'pointcloud-multi.s3mb']) {
      const tile = await parse(join(DRACO_FIXTURES, name));
      for (const s of Object.values(tile.geoPackage)) {
        const semantics = s.vertexPackage.vertexAttributes.map((a) => a.semantic);
        expect(semantics).not.toContain('gsScale');
        expect(semantics).not.toContain('gsRotation');
      }
      expect(tile.degradations ?? []).not.toContain('gaussian-splatting-points');
    }
  });
});

describe('decodeScaleF32 / decodeRotationF32 边界', () => {
  /** 造一条带 padding + offset 的交织流：每点 [f32×n, 4 字节填充] */
  const interleaved = (perPoint: number[][], padBytes = 4, leadBytes = 4) => {
    const comps = perPoint[0]!.length;
    const stride = comps * 4 + padBytes;
    const bytes = new Uint8Array(leadBytes + perPoint.length * stride);
    const view = new DataView(bytes.buffer);
    perPoint.forEach((vals, i) => {
      vals.forEach((v, c) => view.setFloat32(leadBytes + i * stride + c * 4, v, true));
    });
    return { bytes, stride, offset: leadBytes };
  };

  test('带 padding 与 offset 也能按 stride 正确取值', () => {
    const s = interleaved([[1, 2, 3], [4, 5, 6]]);
    expect(Array.from(decodeScaleF32(s.bytes, s.stride, s.offset, 2))).toEqual([1, 2, 3, 4, 5, 6]);

    const r = interleaved([[0.1, 0.2, 0.3, 0.4], [0.5, 0.6, 0.7, 0.8]]);
    const q = decodeRotationF32(r.bytes, r.stride, r.offset, 2);
    const expected = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    for (let i = 0; i < expected.length; i++) expect(q[i]).toBeCloseTo(expected[i]!, 6);
  });

  test('count 截断与 0 / 越界都不产生 NaN 之外的脏值', () => {
    const s = interleaved([[1, 2, 3], [4, 5, 6]]);
    expect(Array.from(decodeScaleF32(s.bytes, s.stride, s.offset, 1))).toEqual([1, 2, 3]);
    expect(decodeScaleF32(s.bytes, s.stride, s.offset, 0).length).toBe(0);
    expect(decodeRotationF32(s.bytes, s.stride, s.offset, 0).length).toBe(0);
  });
});

describe('渲染层：sculpture 真的画高斯片，不再退回 Points', () => {
  test('buildTileObjects 产出 InstancedBufferGeometry 且实例属性数值无损', async () => {
    const tile = await parse(SCULPTURE);
    const res = await buildTileObjects(tile);

    const splats: THREE.Mesh[] = [];
    const points: THREE.Points[] = [];
    res.group.traverse((o) => {
      if ((o as THREE.Mesh).userData?.isGaussianSplat) splats.push(o as THREE.Mesh);
      else if (o instanceof THREE.Points) points.push(o);
    });

    expect(points.length).toBe(0);
    expect(splats.length).toBeGreaterThan(0);

    const g = splats[0]!.geometry as THREE.InstancedBufferGeometry;
    expect(g.instanceCount).toBe(53195);
    expect(g.getAttribute('iCenter')).toBeTruthy();
    expect(g.getAttribute('iScale')).toBeTruthy();
    expect(g.getAttribute('iQuat')).toBeTruthy();

    // 直接读实例属性，钉住「f32 没被当成 u8 log 量化」这件事
    const scales = g.getAttribute('iScale') as THREE.InstancedBufferAttribute;
    expect(scales.getX(0)).toBeCloseTo(0.00885503, 7);
    expect(scales.getY(0)).toBeCloseTo(0.00236107, 7);
    const quats = g.getAttribute('iQuat') as THREE.InstancedBufferAttribute;
    expect(quats.getW(0)).toBeCloseTo(0.9860798, 6);
    expect(Math.hypot(quats.getX(0), quats.getY(0), quats.getZ(0), quats.getW(0))).toBeCloseTo(1, 5);
  });
});
