/**
 * 回归测试：S3M 1.x 管线与线/点几何瓦片解析（3D-pipe / 生活水管线）
 *
 * 触发场景（用户上报）：
 *   https://www.supermapol.com/realspace/services/3D-pipe/rest/realspace/datas/
 *   Error: [s3m] S3M 1.x 属性段无法定位索引头：网格 3531930689（偏移 456/2156）
 *
 * 根因：
 *   1. S3M 1.x 索引头的第 3 个 dword 是按字节打包的：
 *      [indexType: u8, useIndex: u8, primitiveType: u8, reserved: u8]。
 *      原实现写死了 INDEX_HEADER_MARK = 0x00040100（即 primitiveType 恒为 4 三角面），
 *      且断言 count % 3 === 0。对于管线数据（primitiveType = 2 线段，mark = 0x00020100）
 *      和点数据（primitiveType = 1 点，mark = 0x00010100），findIndexHeader 返回 -1 导致报错。
 *   2. 组装层若把 primitiveType = 2 / 3 混同为修饰性棱线（primitiveType 13），
 *      会使实体管线默认隐藏（visible = false）且丢失材质真实颜色。
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { parseS3M1 } from '../../packages/s3m-three/src/core/S3M1Parser';
import { parseS3MB } from '../../packages/s3m-three/src/core/S3MBParser';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';

const FIX = (n: string) => join(import.meta.dir, '../fixtures/osgb', n);
const ab = (n: string) => {
  const b = readFileSync(FIX(n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const inflate = (x: Uint8Array) => inflateSync(x);

test('S3M 1.x 管线数据（3D-pipe）：索引头识别 primitiveType=2 线段，不再报无法定位索引头', async () => {
  const tile = await parseS3M1(ab('s3m1-pipe.s3m'), { inflate });

  expect(tile.version).toBe(1);
  const geos = Object.values(tile.geoPackage);
  expect(geos.length).toBe(1);

  const g = geos[0]!;
  expect(g.name).toBe('SuperMapCache#3531930689');
  expect(g.vertexPackage.verticesCount).toBe(36);

  const pack = g.indexPackages[0]!;
  expect(pack).toBeTruthy();
  expect(pack.indexCount).toBe(36);
  expect(pack.primitiveType).toBe(2); // LINES
  expect(pack.passNames).toEqual(['1022862293']);

  // 验证顶点坐标在合理范围内
  const posAttr = g.vertexPackage.vertexAttributes.find((a) => a.semantic === 'position')!;
  expect(posAttr).toBeTruthy();
  const pos = new Float32Array(posAttr.data.buffer, posAttr.data.byteOffset, 36 * 3);
  expect(Number.isFinite(pos[0])).toBe(true);

  // 材质信息被正确提取
  expect(tile.materials.length).toBeGreaterThan(0);
});

test('S3M 1.x 管线数据：经 parseS3MB 入口也能正确分流并解析', async () => {
  const tile = await parseS3MB(ab('s3m1-pipe.s3m'), { inflate });
  expect(tile.version).toBe(1);
  const geos = Object.values(tile.geoPackage);
  expect(geos.length).toBe(1);
  expect(geos[0]!.indexPackages[0]!.primitiveType).toBe(2);
});

test('S3M 1.x 管线几何组装：实体线段默认可见，且保留材质颜色而非修饰性棱线', async () => {
  const tile = await parseS3M1(ab('s3m1-pipe.s3m'), { inflate });
  const { group, objects } = await buildTileObjects(tile);

  expect(objects.length).toBe(1);
  const lineObj = objects[0] as THREE.LineSegments;
  expect(lineObj.isLineSegments).toBe(true);

  // 实体线段默认可见（options.edges 默认 false 时不能被隐藏）
  expect(lineObj.visible).toBe(true);
  expect(lineObj.userData.isEdgeLines).not.toBe(true);
  expect(lineObj.userData.primitiveType).toBe(2);

  // 材质颜色为管道自身材质色（XML 中为 cyan: R=0, G=1, B=1）
  const mat = lineObj.material as THREE.LineBasicMaterial;
  expect(mat.isLineBasicMaterial).toBe(true);
  expect(mat.color.r).toBeCloseTo(0, 2);
  expect(mat.color.g).toBeCloseTo(1, 2);
  expect(mat.color.b).toBeCloseTo(1, 2);
});

import { pixelFormatOfBpp } from '../../packages/s3m-three/src/core/S3M1Parser';

test('pixelFormatOfBpp：压缩纹理密度判定含 mipmap 链与边界值', () => {
  // DXT1: 单张 0.5 B/px，含完整 mip 链 ~0.667~0.669 B/px (3D-srsb 等)
  expect(pixelFormatOfBpp(0.5, 14)).toBe(17);
  expect(pixelFormatOfBpp(0.667, 14)).toBe(17);
  expect(pixelFormatOfBpp(0.669, 14)).toBe(17);

  // DXT5: 单张 1.0 B/px，含完整 mip 链 ~1.333~1.44 B/px
  expect(pixelFormatOfBpp(1.0, 14)).toBe(21);
  expect(pixelFormatOfBpp(368 / 256, 14)).toBe(21); // 16x16 带 mip 链 368 字节

  // BGRA (4 B/px) & RGB (3 B/px)
  expect(pixelFormatOfBpp(4.0, 14)).toBe(14);
  expect(pixelFormatOfBpp(3.0, 14)).toBe(10);

  // 边界值兜底
  expect(pixelFormatOfBpp(0, 14)).toBe(14);
  expect(pixelFormatOfBpp(-1, 14)).toBe(14);
  expect(pixelFormatOfBpp(NaN, 14)).toBe(14);
  expect(pixelFormatOfBpp(Infinity, 14)).toBe(14);
  // 未知档位回退 rawFormat
  expect(pixelFormatOfBpp(2.5, 99)).toBe(99);
});
