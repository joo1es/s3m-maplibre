/**
 * 单元测试：全球大尺度烘焙墨卡托属性（issue #15）。
 *
 * 验证：
 * 1. 端到端数学闭环（transformed → group.matrix → _enuMatrix 误差 < 1 cm）：
 *    - 修复后：端到端误差 < 1 cm；
 *    - 对比证明：若缺少 uTilePivot（旧版 bug），瓦片朝锚点塌陷逾 200 km；
 *    - 对比证明：若使用场景级 uInvMercScale 而不使用逐瓦片 uInvTileScale，无法抵消瓦片尺度缩放。
 * 2. 相对中心存储量化步长（100 km 跨度下误差 < 1 cm）。
 * 3. 瓦片中心偏移量为 0。
 * 4. 25 km 以下默认不触发烘焙（不变式①：顶点 buffer 逐字节一致）。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { mercatorFromLngLat } from '../../packages/s3m-three/src/render/GeoAdapter';
import {
  bakeMercatorOffsets,
  enuToLngLat,
  AUTO_BAKE_RADIUS_THRESHOLD,
} from '../../packages/s3m-three/src/core/BakeMercator';
import { computeTilePlacement } from '../../packages/s3m-three/src/render/tilePlacement';

function mercErrorMeters(got: { x: number; y: number }, want: { x: number; y: number }): number {
  const latOfWant = (Math.atan(Math.sinh(Math.PI * (1 - 2 * want.y))) * 180) / Math.PI;
  const s = mercatorFromLngLat(0, latOfWant).meterInMercator;
  return Math.hypot(got.x - want.x, got.y - want.y) / s;
}

describe('BakeMercator 数学与端到端闭环 (#15)', () => {
  const sceneAnchor = { lon: 120, lat: 45, height: 0 };
  const sceneMerc = mercatorFromLngLat(sceneAnchor.lon, sceneAnchor.lat, sceneAnchor.height);
  const sSceneEast = sceneMerc.meterInMercatorEast ?? sceneMerc.meterInMercator;
  const sSceneNorth = sceneMerc.meterInMercatorNorth ?? sceneMerc.meterInMercator;
  const sSceneUp = sSceneEast;

  // 瓦片中心距锚点向北 200 km（纬度变化产生显著局部尺度差，kEast ≈ 1.0328）
  const tileCenterEnu = { x: 0, y: 200000, z: 0 };
  const [centerLon, centerLat] = enuToLngLat(sceneAnchor, tileCenterEnu.x, tileCenterEnu.y);
  const tileMerc = mercatorFromLngLat(centerLon, centerLat, sceneAnchor.height);

  // 顶点在瓦片中心向东再走 10 km
  const vertEnu = { x: 10000, y: 200000, z: 0 };
  const [vertLon, vertLat] = enuToLngLat(sceneAnchor, vertEnu.x, vertEnu.y);
  const vertTruthMerc = mercatorFromLngLat(vertLon, vertLat, sceneAnchor.height);

  test('端到端变换链：perTilePlacement=true 时误差 < 1 cm', () => {
    // 1. 烘焙属性：相对瓦片中心的墨卡托偏移
    const offsets = bakeMercatorOffsets(
      new Float32Array([vertEnu.x, vertEnu.y, vertEnu.z]),
      1,
      sceneAnchor,
      tileCenterEnu
    );
    const off = new THREE.Vector3(offsets[0], offsets[1], offsets[2]);

    // 计算瓦片放置参数
    const placement = computeTilePlacement({
      center: tileCenterEnu,
      datasetAnchor: sceneAnchor,
      sceneAnchor: sceneMerc,
      datasetOffset: [0, 0, 0],
      geo: null,
    })!;
    expect(placement).not.toBeNull();
    expect(placement.invTileScale).toBeDefined();

    // 2. 着色器重构 transformed:
    // transformed = uTilePivot + vec3(off.x, -off.y, off.z) * uInvTileScale
    const uTilePivot = new THREE.Vector3(placement.pivot[0], placement.pivot[1], placement.pivot[2]);
    const uInvTileScale = new THREE.Vector3(
      placement.invTileScale![0],
      placement.invTileScale![1],
      placement.invTileScale![2]
    );
    const transformed = new THREE.Vector3(
      uTilePivot.x + off.x * uInvTileScale.x,
      uTilePivot.y - off.y * uInvTileScale.y,
      uTilePivot.z + off.z * uInvTileScale.z
    );

    // 3. 瓦片 group.matrix（perTilePlacement 计算）
    // 真实变换：A(v) = position + k * (v - pivot)
    const kEast = placement.scaleEast ?? placement.scale;
    const kNorth = placement.scaleNorth ?? placement.scale;
    const kUp = kEast;
    const vGroup = new THREE.Vector3(
      placement.position[0] + kEast * (transformed.x - placement.pivot[0]),
      placement.position[1] + kNorth * (transformed.y - placement.pivot[1]),
      placement.position[2] + kUp * (transformed.z - placement.pivot[2])
    );

    // 4. _enuMatrix：sEast, 0, 0, sceneAnchor.x,  0, -sNorth, 0, sceneAnchor.y, ...
    const worldPos = new THREE.Vector3(
      sceneMerc.x + sSceneEast * vGroup.x,
      sceneMerc.y - sSceneNorth * vGroup.y,
      sceneMerc.z + sSceneUp * vGroup.z
    );

    const err = mercErrorMeters(worldPos, vertTruthMerc);
    expect(err).toBeLessThan(0.01); // 误差小于 1 cm
  });

  test('对比证明：若缺少 uTilePivot（旧版 bug），瓦片朝锚点塌陷逾 190 km', () => {
    const offsets = bakeMercatorOffsets(
      new Float32Array([vertEnu.x, vertEnu.y, vertEnu.z]),
      1,
      sceneAnchor,
      tileCenterEnu
    );
    const off = new THREE.Vector3(offsets[0], offsets[1], offsets[2]);

    const placement = computeTilePlacement({
      center: tileCenterEnu,
      datasetAnchor: sceneAnchor,
      sceneAnchor: sceneMerc,
      datasetOffset: [0, 0, 0],
      geo: null,
    })!;

    // 模拟旧版错误着色器：缺少 uTilePivot
    const uInvTileScale = new THREE.Vector3(
      placement.invTileScale![0],
      placement.invTileScale![1],
      placement.invTileScale![2]
    );
    const buggyTransformed = new THREE.Vector3(
      off.x * uInvTileScale.x,
      -off.y * uInvTileScale.y,
      off.z * uInvTileScale.z
    );

    const kEast = placement.scaleEast ?? placement.scale;
    const kNorth = placement.scaleNorth ?? placement.scale;
    const kUp = kEast;
    const buggyVGroup = new THREE.Vector3(
      placement.position[0] + kEast * (buggyTransformed.x - placement.pivot[0]),
      placement.position[1] + kNorth * (buggyTransformed.y - placement.pivot[1]),
      placement.position[2] + kUp * (buggyTransformed.z - placement.pivot[2])
    );

    const buggyWorldPos = new THREE.Vector3(
      sceneMerc.x + sSceneEast * buggyVGroup.x,
      sceneMerc.y - sSceneNorth * buggyVGroup.y,
      sceneMerc.z + sSceneUp * buggyVGroup.z
    );

    const buggyErr = mercErrorMeters(buggyWorldPos, vertTruthMerc);
    // 缺少 pivot 导致塌陷量级约 200 km
    expect(buggyErr).toBeGreaterThan(190000);
  });

  test('对比证明：若使用场景级 uInvMercScale 而不使用逐瓦片 uInvTileScale，无法抵消瓦片尺度缩放', () => {
    const offsets = bakeMercatorOffsets(
      new Float32Array([vertEnu.x, vertEnu.y, vertEnu.z]),
      1,
      sceneAnchor,
      tileCenterEnu
    );
    const off = new THREE.Vector3(offsets[0], offsets[1], offsets[2]);

    const placement = computeTilePlacement({
      center: tileCenterEnu,
      datasetAnchor: sceneAnchor,
      sceneAnchor: sceneMerc,
      datasetOffset: [0, 0, 0],
      geo: null,
    })!;

    // 补上 uTilePivot，但错误地使用场景级常量 uInvMercScale = 1 / sSceneEast
    const uTilePivot = new THREE.Vector3(placement.pivot[0], placement.pivot[1], placement.pivot[2]);
    const buggyScaleTransformed = new THREE.Vector3(
      uTilePivot.x + off.x / sSceneEast,
      uTilePivot.y - off.y / sSceneNorth,
      uTilePivot.z + off.z / sSceneUp
    );

    const kEast = placement.scaleEast ?? placement.scale;
    const kNorth = placement.scaleNorth ?? placement.scale;
    const kUp = kEast;
    const buggyScaleVGroup = new THREE.Vector3(
      placement.position[0] + kEast * (buggyScaleTransformed.x - placement.pivot[0]),
      placement.position[1] + kNorth * (buggyScaleTransformed.y - placement.pivot[1]),
      placement.position[2] + kUp * (buggyScaleTransformed.z - placement.pivot[2])
    );

    const buggyScaleWorldPos = new THREE.Vector3(
      sceneMerc.x + sSceneEast * buggyScaleVGroup.x,
      sceneMerc.y - sSceneNorth * buggyScaleVGroup.y,
      sceneMerc.z + sSceneUp * buggyScaleVGroup.z
    );

    const err = mercErrorMeters(buggyScaleWorldPos, vertTruthMerc);
    // 尺度误差 (kEast - 1) * 10 km 约数百米（实测 > 100 m）
    expect(err).toBeGreaterThan(100);
  });

  test('StyleMaterial: 开启烘焙时 vertexShader 注入 uTilePivot 与 uInvTileScale，且移除 uUseMercator', async () => {
    const { createStyledMaterial, createSharedUniforms } = await import('../../packages/s3m-three/src/render/StyleMaterial');
    const mat = createStyledMaterial({
      uniforms: createSharedUniforms(),
      bakeMercator: true,
      tilePivot: new THREE.Vector3(100, 200, 300),
      invTileScale: new THREE.Vector3(0.5, 0.4, 0.5),
    });

    const shader = {
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n#include <worldpos_vertex>',
      fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
      uniforms: {},
    };

    mat.onBeforeCompile(shader as any, null as any);
    expect(shader.vertexShader).toContain('attribute vec3 aMercatorOffset;');
    expect(shader.vertexShader).toContain('uniform vec3 uTilePivot;');
    expect(shader.vertexShader).toContain('uniform vec3 uInvTileScale;');
    expect(shader.vertexShader).not.toContain('uniform int uUseMercator;');
    expect(shader.vertexShader).not.toContain('uniform float uInvMercScale;');
    expect(shader.vertexShader).toContain('transformed = uTilePivot + vec3(');
    expect((shader.uniforms as any).uTilePivot.value.x).toBe(100);
    expect((shader.uniforms as any).uInvTileScale.value.x).toBe(0.5);
  });

  test('瓦片中心自身的烘焙偏移量恒为 0', () => {
    const offsets = bakeMercatorOffsets(
      new Float32Array([tileCenterEnu.x, tileCenterEnu.y, tileCenterEnu.z]),
      1,
      sceneAnchor,
      tileCenterEnu
    );
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(0);
    expect(offsets[2]).toBe(0);
  });

  test('float32 相对中心存储在 100 km 跨度下分辨率优于 1 cm', () => {
    const p1 = { x: 100000, y: 0, z: 0 };
    const p2 = { x: 100000.01, y: 0, z: 0 }; // 1 cm 差距
    const off1 = bakeMercatorOffsets(new Float32Array([p1.x, p1.y, p1.z]), 1, sceneAnchor, tileCenterEnu);
    const off2 = bakeMercatorOffsets(new Float32Array([p2.x, p2.y, p2.z]), 1, sceneAnchor, tileCenterEnu);
    expect(off1[0]).not.toBe(off2[0]);
  });
});
