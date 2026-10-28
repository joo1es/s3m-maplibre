/**
 * uv 第三分量（custom0 / 官方 `aTextureCoordMatrix`）的**采样数学**单测。
 *
 * 这是纯数学题，不依赖渲染器。官方 iClient3D `S3M_module` 的实现分两段：
 *
 *   S3MTilesVS.js  getTextureMatrixFromZValue( floor(z), xTran, yTran, scale )
 *   S3MTilesFS.js  calculateMipLevel( vTexCoord.xy, scale*texWidth, log2(texWidth*scale) )
 *                  calculateTexCoord( uv, scale, xTran, yTran, scale*texWidth, mip )
 *
 * 数据侧事实（`3D-BIMbuilding-2` 全部 7 个根瓦片实测）：
 *   z ∈ { -99999, 0, 65536, 65537, 65792, 65793, 262144, 327680 }
 *   uv 是米制世界坐标（1 单位 ≈ 1 m），纹理是 2^n × 2^n 的材质图集，
 *   z 的 bit[0:7] = yTran、bit[8:15] = xTran、bit[16:19] = 层级（scale = 1/2^level）。
 *
 * 这里钉住的**核心不变量**：
 *   任意 z > 0 的顶点，其采样坐标必须严格落在自己那一格的
 *   `[T*scale, (T+1)*scale]` 内。越界 = 采到邻近材质，
 *   画面上就会出现「一格一格不同材质」的棋盘，也就是用户看到的现象。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  decodeTexMatrix,
  texMipLevel,
  sampleTexCoord,
  texMaxMip,
} from '../../packages/s3m-three/src/core/TexCoordZ';
import { createStyledMaterial } from '../../packages/s3m-three/src/render/StyleMaterial';

/** 数据里实际出现的全部 z */
const REAL_Z = [-99999, 0, 65536, 65537, 65792, 65793, 262144, 327680];

describe('decodeTexMatrix（官方 getTextureMatrixFromZValue）', () => {
  test('-99999：命中哨兵，不采样', () => {
    const m = decodeTexMatrix(-99999);
    expect(m.disabled).toBe(true);
  });

  test('0：单位变换 —— 整张纹理按 uv 平铺（没有矩阵的普通数据）', () => {
    const m = decodeTexMatrix(0);
    expect(m.disabled).toBe(false);
    expect(m.scale).toBe(1);
    expect([m.xTran, m.yTran]).toEqual([0, 0]);
  });

  test('65536 + n：level=1 → scale 0.5，n 就是 2×2 图集里的格子下标 (x, y)', () => {
    expect(decodeTexMatrix(65536)).toMatchObject({ scale: 0.5, xTran: 0, yTran: 0 });
    expect(decodeTexMatrix(65537)).toMatchObject({ scale: 0.5, xTran: 0, yTran: 1 });
    expect(decodeTexMatrix(65792)).toMatchObject({ scale: 0.5, xTran: 1, yTran: 0 });
    expect(decodeTexMatrix(65793)).toMatchObject({ scale: 0.5, xTran: 1, yTran: 1 });
  });

  test('更高的层级：262144 = 4<<16 → 4×4 图集，327680 = 5<<16 → 8×8', () => {
    expect(decodeTexMatrix(262144)).toMatchObject({ scale: 1 / 16, xTran: 0, yTran: 0 });
    expect(decodeTexMatrix(327680)).toMatchObject({ scale: 1 / 32, xTran: 0, yTran: 0 });
  });

  test('0 < z < 65536：level=0 → scale 1，只有平移（真实数据里暂未见，公式必须支持）', () => {
    expect(decodeTexMatrix(1)).toMatchObject({ scale: 1, xTran: 0, yTran: 1 });
    expect(decodeTexMatrix(256)).toMatchObject({ scale: 1, xTran: 1, yTran: 0 });
  });

  test('负数但不是哨兵（如 -1）：官方 getTextureMatrixFromZValue 直接返回，等于单位变换', () => {
    expect(decodeTexMatrix(-1)).toMatchObject({ disabled: false, scale: 1, xTran: 0, yTran: 0 });
  });
});

describe('texMaxMip / texMipLevel（官方 calculateMipLevel）', () => {
  test('maxMip = log2(texWidth * scale)：512 纹理取 0.5 格 → 8', () => {
    expect(texMaxMip(512, 0.5)).toBeCloseTo(8, 10);
    expect(texMaxMip(1024, 0.5)).toBeCloseTo(9, 10);
    expect(texMaxMip(128, 1)).toBeCloseTo(7, 10);
  });

  test('屏幕上一个像素远小于一个纹素 → mip 取 0', () => {
    expect(texMipLevel(1e-9, 0, 0, 1e-9, 512, 8)).toBe(0);
  });

  test('屏幕上一个像素正好跨 4 个纹素 → mip = 2', () => {
    const k = 4 / 512; // uv 单位/像素，乘 fTile 后就是 4 个纹素
    expect(texMipLevel(k, 0, 0, k, 512, 8)).toBeCloseTo(2, 6);
  });

  test('各向同性：每像素跨 16 个纹素 → mip = 4', () => {
    const k = 16 / 512;
    expect(texMipLevel(k, 0, 0, k, 512, 8)).toBeCloseTo(4, 6);
  });

  test('各向异性：横竖差异越大，d 越偏向小的一侧（官方那步 off 混合）', () => {
    // dMax = 64², dMin = 2² → off ≈ 1 → d 掉到 dMin 附近，mip 远小于 log2(64)
    const mip = texMipLevel(64 / 512, 0, 0, 2 / 512, 512, 8);
    expect(mip).toBeLessThan(3);
    expect(mip).toBeGreaterThanOrEqual(0);
  });

  test('上限是 maxMip - 1.62（官方逐字），不是 maxMip', () => {
    expect(texMipLevel(1e3, 0, 0, 1e3, 512, 8)).toBeCloseTo(8 - 1.62, 5);
  });
});

describe('sampleTexCoord（官方 calculateTexCoord）', () => {
  const m0 = decodeTexMatrix(65536); // scale 0.5, T=(0,0)

  test('z=0：采样坐标就是 fract(uv)，整张图平铺', () => {
    const m = decodeTexMatrix(0);
    expect(sampleTexCoord(m, 0.37, 0.62, 512, 0)).toEqual({ u: 0.37, v: 0.62 });
    expect(sampleTexCoord(m, -1.25, 3.75, 512, 0)).toEqual({ u: 0.75, v: 0.75 });
  });

  test('z=65536：uv 先 fract，再乘 scale → 落在左上那一格', () => {
    const p = sampleTexCoord(m0, 0.37, 0.62, 512, 0);
    expect(p.u).toBeCloseTo(0.185, 10);
    expect(p.v).toBeCloseTo(0.31, 10);
  });

  test('z=65793：平移 (1,1) 后落在右下那一格', () => {
    const p = sampleTexCoord(decodeTexMatrix(65793), 0.37, 0.62, 512, 0);
    expect(p.u).toBeCloseTo(0.685, 10);
    expect(p.v).toBeCloseTo(0.81, 10);
  });

  test('★ 不变量：任何 z>0 的采样点都留在自己那一格里（不串材质）', () => {
    for (const z of REAL_Z.filter((v) => v > 0)) {
      const m = decodeTexMatrix(z);
      const fTile = Math.max(m.scale * 512, 1);
      const maxMip = texMaxMip(512, m.scale);
      const u0 = m.xTran * m.scale;
      const v0 = m.yTran * m.scale;
      // 着色器里 mip 一定先经 texMipLevel 裁到 maxMip-1.62，这里补同样的前提
      const mips = [0, Math.min(2, maxMip - 1.62), maxMip - 1.62];
      for (let u = 0; u < 1; u += 0.05) {
        for (let v = 0; v < 1; v += 0.05) {
          for (const mip of mips) {
            const p = sampleTexCoord(m, u, v, 512, mip);
            expect(p.u).toBeGreaterThanOrEqual(u0 - 1e-6);
            expect(p.u).toBeLessThanOrEqual(u0 + m.scale + 1e-6);
            expect(p.v).toBeGreaterThanOrEqual(v0 - 1e-6);
            expect(p.v).toBeLessThanOrEqual(v0 + m.scale + 1e-6);
          }
        }
      }
      expect(fTile).toBeGreaterThan(0);
    }
  });

  test('★ mip 内缩：mip 到顶时采样点被夹进格子中心的窄带（远处退化成纯色）', () => {
    const texWidth = 512;
    const maxMip = texMaxMip(texWidth, m0.scale);
    const mip = maxMip - 1.62;
    const inner = Math.pow(2, mip) / (m0.scale * texWidth); // 0.5^1.62 ≈ 0.325
    expect(inner).toBeCloseTo(0.325, 3);

    // uv=0.9 被夹到上界 → 采样点 = (1-inner)*scale，而不是格子正中心
    const hi = sampleTexCoord(m0, 0.9, 0.9, texWidth, mip);
    expect(hi.u).toBeCloseTo((1 - inner) * m0.scale, 10);
    // uv=0.1 被夹到下界
    const lo = sampleTexCoord(m0, 0.1, 0.1, texWidth, mip);
    expect(lo.u).toBeCloseTo(inner * m0.scale, 10);
    // 两者只差 0.175，即整格宽的 35% —— 一个高度模糊的平均色
    expect(hi.u - lo.u).toBeCloseTo((1 - 2 * inner) * m0.scale, 10);
  });
});

/* ------------------------------------------------------------ 着色器侧 */

/**
 * GLSL 与上面的 TS 数学是两份实现，必须钉住它们同步：
 *   - 解码只能在**顶点着色器**做（片元若是 mediump，65536 早就溢出成 inf）；
 *   - 片元必须用显式 LOD 采样，不能把 `(fract(uv)+T)*scale` 交给硬件求导。
 */
describe('注入后的 shader', () => {
  const build = () => {
    const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const mat = createStyledMaterial({ map, texCoordZ: true } as never);
    const shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string } = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    (mat as unknown as { onBeforeCompile: (s: unknown, r: unknown) => void }).onBeforeCompile(shader, null);
    return { shader, mat } as const;
  };

  test('顶点着色器里解 z：attribute + 8/16/20 位分段 + 写进 varying', () => {
    const { shader } = build();
    expect(shader.vertexShader).toContain('attribute float aTexCoordZ');
    expect(shader.vertexShader).toContain('varying vec4 vTexMatrix');
    expect(shader.vertexShader).toContain('vTexCoordTransform = aTexCoordZ');
    expect(shader.vertexShader).toContain('vTexMatrix.z = 1.0 / pow( 2.0, nDel16 - nDel20 * 16.0 )');
  });

  test('片元着色器不再自己解 z，只做 mip 收缩 + 显式 LOD 采样', () => {
    const { shader } = build();
    const fs = shader.fragmentShader;
    expect(fs).toContain('s3mTexCoordZUnit( vMapUv, vTexMatrix, map, uAtlasDim.x )');
    expect(fs).not.toContain('varying float vTexCoordZ');
    // 解码只该在 VS 出现一次（片元里没有 256.0 的位分段）
    expect(fs).not.toContain('nDel16');
    expect(fs).toContain('textureLod( tex, c, mip )');
  });

  test('三档哨兵：z<-99900 白、(-99900,-9000] 平铺、其余公式（SMID 3464 uv整图回归钉）', () => {
    const { shader } = build();
    const fs = shader.fragmentShader;
    const unit = fs.slice(fs.indexOf('vec4 s3mTexCoordZUnit'), fs.indexOf('#endif', fs.indexOf('vec4 s3mTexCoordZUnit')));
    // 1) 白色档：官方 getTextureColor `texCoordZ < -99900 → vec4(1.0)`，
    //    SMID 3464（z=-99999，米制 uv -85..85）靠它平涂顶点色；
    //    之前漏掉这档，3464 被当平铺处理 → 整张纹理平铺上百次 = 「uv 整图」
    expect(unit).toMatch(/if \( m\.z < -1\.5 \) \{\s*s3mResult = vec4\( 1\.0 \);/);
    // 2) 平铺档：官方 getUV `texCoordZ < -9000 → texCoord = uv` 原样采样
    expect(unit).toMatch(/else if \( m\.z < 0\.0 \) \{\s*s3mResult = texture2D\( tex, uv \);/);
    // 3) 公式档：显式 LOD
    expect(unit).toContain('textureLod( tex, c, mip )');
    // 顶点侧三档编码
    const vs = shader.vertexShader;
    expect(vs).toContain('if ( vTexCoordTransform < -99900.0 )');
    expect(vs).toContain('vTexMatrix.z = -2.0');
    expect(vs).toContain('vTexMatrix.z = -1.0');
  });

  test('材质宏与 program key 都带上了 uv-z 分支', () => {
    const { mat } = build();
    const m = mat as unknown as { defines: Record<string, string>; customProgramCacheKey: () => string };
    expect(m.defines.S3M_TEXCOORD_Z).toBe('');
    expect(m.customProgramCacheKey()).toContain('-texz');
  });
});
