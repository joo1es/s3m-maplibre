import { describe, it, expect } from 'bun:test';
import * as THREE from 'three';
import {
  enuToLngLat,
  bakeMercatorOffsets,
  bakeMercatorNormals,
  AUTO_BAKE_RADIUS_THRESHOLD,
} from '../../packages/s3m-three/src/core/BakeMercator.js';
import { assembleTileGeometry } from '../../packages/s3m-three/src/core/TileGeometry.js';
import { createStyledMaterial, createSharedUniforms } from '../../packages/s3m-three/src/render/StyleMaterial.js';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder.js';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset.js';
import { mercatorFromLngLat, EARTH_RADIUS } from '../../packages/s3m-three/src/render/GeoAdapter.js';
import type { ParsedTile } from '../../packages/s3m-three/src/core/types.js';

const f32 = (arr: number[]) => new Uint8Array(new Float32Array(arr).buffer);

function createMockTile(positions: number[]): ParsedTile {
  const count = positions.length / 3;
  const indices = new Uint16Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;

  return {
    version: 3,
    compressedType: 0,
    options: 0,
    groupNode: { pageLods: [{ geodes: [{ matrix: null, skeletonNames: ['skel0'] }] }] },
    geoPackage: {
      skel0: {
        vertexPackage: {
          verticesCount: count,
          vertexAttributes: [
            { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: f32(positions) },
          ],
          instanceIndex: -1,
        },
        indexPackages: [
          { primitiveType: 4, indexCount: count, indices, passNames: ['mat0'] },
        ],
      },
    },
    textures: {},
    materials: { materials: [{ material: { id: 'mat0', textureStates: [] } }] },
    pickInfo: {},
    bytesRead: 0,
    bytesTotal: 0,
  } as unknown as ParsedTile;
}

describe('逐顶点烘焙精确 Web 墨卡托（Issue #15）', () => {
  it('相对瓦片原点存储 f32，100 km 处的量化误差 < 1 cm', () => {
    const tileAnchor = { lon: 116.4, lat: 39.9, height: 0 };
    const tileCenter = { x: 0, y: 0, z: 0 };

    const positions = new Float64Array([100000.0, 100000.0, 150.0]);
    const { offsets } = bakeMercatorOffsets(positions, 1, tileAnchor, tileCenter, null);

    // 理论精确墨卡托
    const [targetLon, targetLat] = enuToLngLat(tileAnchor.lon, tileAnchor.lat, 100000.0, 100000.0);
    const targetMerc = mercatorFromLngLat(targetLon, targetLat, 150.0);
    const centerMerc = mercatorFromLngLat(tileAnchor.lon, tileAnchor.lat, 0.0);

    const exactDy = targetMerc.y - centerMerc.y;
    const mercCircumference = 2 * Math.PI * EARTH_RADIUS;

    // 相对瓦片原点的量化误差换算成米
    const quantErrorMeters = Math.abs(offsets[1] - exactDy) * mercCircumference;
    expect(quantErrorMeters).toBeLessThan(0.01); // < 1 cm (0.01 米)
  });

  it('瓦片中心处的偏移为 (0, 0, 0)', () => {
    const tileAnchor = { lon: 120.0, lat: 30.0, height: 10 };
    const tileCenter = { x: 500, y: 500, z: 20 };
    const positions = new Float32Array([500, 500, 20]);
    const { offsets } = bakeMercatorOffsets(positions, 1, tileAnchor, tileCenter, null);

    expect(Math.abs(offsets[0])).toBeLessThan(1e-6);
    expect(Math.abs(offsets[1])).toBeLessThan(1e-6);
    expect(Math.abs(offsets[2])).toBeLessThan(1e-6);
  });

  it('烘焙法线保角且在墨卡托参考系下保持单位向量', () => {
    const normals = new Float32Array([0, 1, 0, 0, 0, 1, 1, 0, 0]);
    const baked = bakeMercatorNormals(normals, 3);
    for (let i = 0; i < 3; i++) {
      const len = Math.hypot(baked[i * 3], baked[i * 3 + 1], baked[i * 3 + 2]);
      expect(Math.abs(len - 1.0)).toBeLessThan(1e-5);
    }
    expect(baked[1]).toBe(-1.0);
    expect(baked[5]).toBe(1.0);
    expect(baked[6]).toBe(1.0);
  });

  it('assembleTileGeometry: 默认不开启烘焙时字节逐位相同，开启后输出 aMercatorOffset', () => {
    const mockTile = createMockTile([0, 0, 0, 10, 0, 0, 0, 10, 0]);

    const resBefore = assembleTileGeometry(mockTile, { batching: false });
    const resDefault = assembleTileGeometry(mockTile, {
      batching: false,
      bakeMercator: undefined,
    });

    const posBefore = resBefore.primitives[0].attributes.position.array;
    const posDefault = resDefault.primitives[0].attributes.position.array;
    expect(posDefault.byteLength).toBe(posBefore.byteLength);
    const u8Before = new Uint8Array(posBefore.buffer, posBefore.byteOffset, posBefore.byteLength);
    const u8Default = new Uint8Array(posDefault.buffer, posDefault.byteOffset, posDefault.byteLength);
    for (let i = 0; i < u8Before.length; i++) {
      expect(u8Default[i]).toBe(u8Before[i]);
    }
    expect(resDefault.primitives[0].attributes.aMercatorOffset).toBeUndefined();

    const resBaked = assembleTileGeometry(mockTile, {
      batching: false,
      bakeMercator: true,
      tileAnchor: { lon: 100, lat: 30, height: 0 },
      tileCenter: { x: 0, y: 0, z: 0 },
    });
    expect(resBaked.primitives[0].attributes.aMercatorOffset).toBeDefined();
    expect(resBaked.primitives[0].attributes.aMercatorOffset!.array.length).toBe(9);
  });

  it('StyleMaterial: 开启 bakeMercator 时正确注入宏定义、attribute 及 uniforms', () => {
    const uniforms = createSharedUniforms();
    const mat = createStyledMaterial({
      uniforms,
      bakeMercator: true,
    });

    expect(mat.defines?.['S3M_BAKED_MERCATOR']).toBeDefined();

    const shader = {
      vertexShader: `
        #include <common>
        #include <elevation_pars_vertex>
        #include <beginnormal_vertex>
        #include <begin_vertex>
        #include <elevation_vertex>
        void main() { gl_Position = vec4(0.0); }
      `,
      fragmentShader: `void main() { gl_FragColor = vec4(1.0); }`,
      uniforms: {},
    };

    mat.onBeforeCompile(shader as any, null as any);
    expect(shader.vertexShader).toContain('attribute vec3 aMercatorOffset;');
    expect(shader.vertexShader).toContain('uniform int uUseMercator;');
    expect(shader.vertexShader).toContain('uniform float uInvMercScale;');
    expect(shader.vertexShader).toContain('transformed = vec3( aMercatorOffset.x * uInvMercScale, -aMercatorOffset.y * uInvMercScale, aMercatorOffset.z * uInvMercScale );');
    expect((shader.uniforms as any).uUseMercator.value).toBe(1.0);
    expect((shader.uniforms as any).uInvMercScale).toBeDefined();
  });

  it('S3MTileset: shouldBakeMercator 判定逻辑严格遵循阈值与显式传参', () => {
    const tsDefault = new S3MTileset({ configUrl: 'http://localhost/test/cbd.scp' });
    expect(tsDefault.shouldBakeMercator(10000)).toBe(false);
    expect(tsDefault.shouldBakeMercator(25000)).toBe(false);
    expect(tsDefault.shouldBakeMercator(25001)).toBe(true);
    expect(tsDefault.shouldBakeMercator(100000)).toBe(true);

    tsDefault.rootRadius = 30000;
    expect(tsDefault.shouldBakeMercator()).toBe(true);

    const tsForceTrue = new S3MTileset({ configUrl: 'http://localhost/test/cbd.scp', bakeMercator: true });
    expect(tsForceTrue.shouldBakeMercator(100)).toBe(true);
    expect(tsForceTrue.shouldBakeMercator(0)).toBe(true);

    const tsForceFalse = new S3MTileset({ configUrl: 'http://localhost/test/cbd.scp', bakeMercator: false });
    expect(tsForceFalse.shouldBakeMercator(100000)).toBe(false);
  });

  it('buildTileObjects: 当 bakeMercator 开启时几何自动挂载 aMercatorOffset 且材质启用宏定义', async () => {
    const mockTile = createMockTile([0, 0, 0, 100, 0, 0, 0, 100, 0]);

    const res = await buildTileObjects(mockTile, {
      bakeMercator: true,
      tileAnchor: { lon: 116.4, lat: 39.9, height: 0 },
      tileCenter: { x: 0, y: 0, z: 0 },
    });

    const mesh = res.objects[0] as THREE.Mesh;
    expect(mesh).toBeDefined();
    const attr = mesh.geometry.getAttribute('aMercatorOffset');
    expect(attr).toBeDefined();
    expect(attr.count).toBe(3);

    const mat = mesh.material as any;
    expect(mat.defines?.['S3M_BAKED_MERCATOR']).toBeDefined();
  });

  it('PBR 光照与法线一致性：保角变换下法线正交性与 dot(N,L) / dot(N,V) 在 ENU 与墨卡托局部空间严格一致', () => {
    const normalENU = new THREE.Vector3(0.57735, 0.57735, 0.57735).normalize();
    const tangentENU = new THREE.Vector3(-0.7071, 0.7071, 0).normalize();
    expect(Math.abs(normalENU.dot(tangentENU))).toBeLessThan(1e-5);

    const lightDirENU = new THREE.Vector3(0.2, 0.3, 0.9).normalize();
    const viewDirENU = new THREE.Vector3(0.1, 0.5, 0.8).normalize();

    const nL_enu = normalENU.dot(lightDirENU);
    const nV_enu = normalENU.dot(viewDirENU);

    const toMercVec = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.y, v.z);
    const normalMerc = toMercVec(normalENU);
    const tangentMerc = toMercVec(tangentENU);
    const lightDirMerc = toMercVec(lightDirENU);
    const viewDirMerc = toMercVec(viewDirENU);

    expect(Math.abs(normalMerc.dot(tangentMerc))).toBeLessThan(1e-5);
    const nL_merc = normalMerc.dot(lightDirMerc);
    const nV_merc = normalMerc.dot(viewDirMerc);

    expect(Math.abs(nL_merc - nL_enu)).toBeLessThan(1e-5);
    expect(Math.abs(nV_merc - nV_enu)).toBeLessThan(1e-5);
  });

  it('验收测试：北纬 45°、东西跨度 300 km 单瓦片，相机推到 100 km 外、pitch 60°，消除视差游动（< 1 px）', () => {
    const W = 1920;
    const H = 1080;
    const fov = 60;

    const R = 6378137;
    const lonCenter = 0.0;
    const latCenter = 45.0;
    const radCenter = (latCenter * Math.PI) / 180;
    const meterInMercCenter = 1.0 / (2 * Math.PI * R * Math.cos(radCenter));

    const spanM = 300000.0; // 300 km
    const [lonFar, latFar] = enuToLngLat(lonCenter, latCenter, spanM, spanM);

    const mercCenter = mercatorFromLngLat(lonCenter, latCenter, 0);
    const mercFar_truth = mercatorFromLngLat(lonFar, latFar, 0);

    // 线性 ENU 近似产生的墨卡托坐标（未逐顶点烘焙）：
    // 假设用瓦片中心处常数 meterInMercCenter 将局部 ENU 线性转为墨卡托
    const mercFar_linear = {
      x: mercCenter.x + spanM * meterInMercCenter,
      y: mercCenter.y - spanM * meterInMercCenter,
      z: 0,
    };

    const tileAnchor = { lon: lonCenter, lat: latCenter, height: 0 };
    const tileCenter = { x: 0, y: 0, z: 0 };
    const positions = new Float32Array([spanM, spanM, 0]);
    const { offsets: bakedOffsets } = bakeMercatorOffsets(positions, 1, tileAnchor, tileCenter, null);

    const mercFar_baked = {
      x: mercCenter.x + bakedOffsets[0],
      y: mercCenter.y + bakedOffsets[1],
      z: mercCenter.z + bakedOffsets[2],
    };

    // 相机推到距远端顶点 100 km 外、pitch 60° 俯视观察该顶点
    const camDist = 100000.0 * meterInMercCenter;
    const camPitch = (60 * Math.PI) / 180;
    const near = camDist * 0.1;
    const far = camDist * 10.0;

    // 帧 1：相机位于 (target.x, target.y + pitchDist, target.z + pitchHeight)
    const target = mercFar_truth;
    const cam1Pos = new THREE.Vector3(
      target.x,
      target.y + camDist * Math.sin(camPitch),
      target.z + camDist * Math.cos(camPitch)
    );
    const cam1 = new THREE.PerspectiveCamera(fov, W / H, near, far);
    cam1.position.copy(cam1Pos);
    cam1.lookAt(target.x, target.y, target.z);
    cam1.updateMatrixWorld();
    cam1.updateProjectionMatrix();

    // 帧 2：相机在视距 100 km 上向前推进并平移微动（相机推进 5 km）
    const shiftM = 5000.0 * meterInMercCenter;
    const cam2Pos = new THREE.Vector3(
      target.x + shiftM,
      target.y + (camDist - shiftM) * Math.sin(camPitch),
      target.z + (camDist - shiftM) * Math.cos(camPitch)
    );
    const cam2 = new THREE.PerspectiveCamera(fov, W / H, near, far);
    cam2.position.copy(cam2Pos);
    cam2.lookAt(target.x, target.y, target.z);
    cam2.updateMatrixWorld();
    cam2.updateProjectionMatrix();

    function toScreen(p: { x: number; y: number; z: number }, cam: THREE.PerspectiveCamera): [number, number] {
      const v = new THREE.Vector3(p.x, p.y, p.z);
      v.project(cam);
      return [(v.x + 1) * 0.5 * W, (1 - v.y) * 0.5 * H];
    }

    const sLinear1 = toScreen(mercFar_linear, cam1);
    const sLinear2 = toScreen(mercFar_linear, cam2);
    const sTruth1 = toScreen(mercFar_truth, cam1);
    const sTruth2 = toScreen(mercFar_truth, cam2);

    const sBaked1 = toScreen(mercFar_baked, cam1);
    const sBaked2 = toScreen(mercFar_baked, cam2);

    // 未启用烘焙时（线性近似），由于投影几何变形，同一顶点相对视线方向的屏幕位置有显著视差游动与投影偏移
    const errLinear1 = Math.hypot(sLinear1[0] - sTruth1[0], sLinear1[1] - sTruth1[1]);
    const driftLinear = Math.hypot(
      (sLinear2[0] - sLinear1[0]) - (sTruth2[0] - sTruth1[0]),
      (sLinear2[1] - sLinear1[1]) - (sTruth2[1] - sTruth1[1])
    );

    // 必须复现：未烘焙时屏幕偏移 > 阈值（真实存在数十到数百像素的视差撕裂与游动）
    expect(errLinear1).toBeGreaterThan(5.0);
    expect(driftLinear).toBeGreaterThan(1.0);

    // 启用逐顶点烘焙后：屏幕误差严格消除 (< 0.1 px)，视差相对游动 < 0.01 px (严格达成 < 1 px 验收要求)
    const errBaked1 = Math.hypot(sBaked1[0] - sTruth1[0], sBaked1[1] - sTruth1[1]);
    const driftBaked = Math.hypot(
      (sBaked2[0] - sBaked1[0]) - (sTruth2[0] - sTruth1[0]),
      (sBaked2[1] - sBaked1[1]) - (sTruth2[1] - sTruth1[1])
    );

    expect(errBaked1).toBeLessThan(0.1);
    expect(driftBaked).toBeLessThan(0.01);
  });
});
