/**
 * 单元测试：colorPipeline / 纹理解码 / 各向异性 / 纹理尺寸上限 从模块级全局改为图层级，
 * 以及 colorPipeline 的 fade-through 过渡、金属度/粗糙度动画起点。
 *
 * 动机：`lightingPreset` 一次会同时改三样模块级全局（管线 + sRGB 解码 + 各向异性），
 * 同页两个图层用不同预设时不仅颜色管线打架，**纹理解码方式也会被污染** ——
 * 比 materialQuality 那次更严重。
 *
 * 目标语义（默认行为逐字不变）：
 *   1. 每层持自己的渲染 profile（colorPipeline / srgbDecode / anisotropyCap / maxTextureSize），
 *      构造图层不写模块级全局；不传则继续跟随模块级默认；
 *   2. profile 沿 viewer → DatasetManager → S3MTileset → buildTileObjects → createTexture /
 *      createStyledMaterial 一路透传；
 *   3. `setColorPipeline(q, { duration })` 走 fade-through：压暗 → 换管线（重建材质 +
 *      已缓存纹理翻 colorSpace 重传）→ 亮回来，全程不重新下载瓦片；
 *   4. 各向异性可以**即时应用**到已上传纹理（不用重载瓦片），图集纹理保持 anisotropy = 1；
 *   5. 金属度 / 粗糙度的动画起点取「数据侧默认值」（roughness≈0.95 / metalness=0），
 *      不再从 0 起跳。
 *
 * 不依赖 WebGL。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';
import { buildTileObjects } from '../../packages/s3m-three/src/render/GeometryBuilder';
import { createStyledMaterial, getColorPipeline, setColorPipeline } from '../../packages/s3m-three/src/render/StyleMaterial';
import {
  applyAnisotropyCap,
  createTexture,
  setMaxAnisotropy,
  setSrgbTextureDecode,
} from '../../packages/s3m-three/src/render/TextureFactory';
import type { ParsedTile, S3MTexture } from '../../packages/s3m-three/src/core/types';

afterEach(() => {
  // 模块级默认是进程级状态，用例之间必须还原
  setColorPipeline('linear');
  setSrgbTextureDecode(true);
  setMaxAnisotropy(16, Infinity);
});

/* ------------------------------------------------------------ 纹理工厂 */

/** 一张 4×4 的 raw RGBA 纹理 */
function fakeTex(size = 4): S3MTexture {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255;
    pixels[i + 3] = 255;
  }
  return {
    code: 'T',
    level: 0,
    width: size,
    height: size,
    compressType: 0,
    pixelFormat: 28, // RGBA，raw 路径
    data: pixels,
  } as unknown as S3MTexture;
}

describe('createTexture 的 per-call 选项', () => {
  test('不传选项时仍跟随模块级默认（sRGB 解码开）', async () => {
    const { texture } = await createTexture(fakeTex());
    expect(texture!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  test('srgbDecode: false 优先于模块级默认', async () => {
    const { texture } = await createTexture(fakeTex(), { srgbDecode: false });
    expect(texture!.colorSpace).toBe(THREE.NoColorSpace);
  });

  test('srgbDecode: true 优先于被改掉的模块级默认', async () => {
    setSrgbTextureDecode(false);
    const { texture } = await createTexture(fakeTex(), { srgbDecode: true });
    expect(texture!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  test('maxSize 生效：4×4 按 2× 盒式滤波降到 2×2', async () => {
    const { texture } = await createTexture(fakeTex(4), { maxSize: 2 });
    const img = texture!.image as { width: number; height: number };
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
  });

  test('anisotropyCap 生效：封到 4', async () => {
    setMaxAnisotropy(16, Infinity);
    const { texture } = await createTexture(fakeTex(), { anisotropyCap: 4 });
    expect(texture!.anisotropy).toBe(4);
  });

  test('anisotropyCap: Infinity 取 GPU 最大值', async () => {
    setMaxAnisotropy(16, Infinity);
    const { texture } = await createTexture(fakeTex(), { anisotropyCap: Infinity });
    expect(texture!.anisotropy).toBe(16);
  });
});

describe('applyAnisotropyCap 即时应用到已上传纹理', () => {
  test('普通纹理跟着改，不需要重新解码', async () => {
    const { texture } = await createTexture(fakeTex(), { anisotropyCap: 16 });
    expect(texture!.anisotropy).toBe(16);
    applyAnisotropyCap([texture!], 4);
    expect(texture!.anisotropy).toBe(4);
  });

  test('图集纹理保持 1（关 mip + 子区域重映射，开各向异性会串色）', async () => {
    const atlasTex = { ...fakeTex(), packed: true } as unknown as S3MTexture;
    const { texture } = await createTexture(atlasTex);
    expect(texture!.anisotropy).toBe(1);
    applyAnisotropyCap([texture!], 16);
    expect(texture!.anisotropy).toBe(1);
  });
});

/* ------------------------------------------------------------ 材质工厂 */

describe('createStyledMaterial 的显式 colorPipeline', () => {
  test('显式 direct：打上 S3M_DIRECT_COLOR 宏，program 缓存键隔离', () => {
    const m = createStyledMaterial({ colorPipeline: 'direct' }) as unknown as {
      defines: Record<string, string>;
      customProgramCacheKey: () => string;
    };
    expect(m.defines.S3M_DIRECT_COLOR).toBe('');
    expect(m.customProgramCacheKey()).toContain('-direct');
  });

  test('显式 linear 优先于被改掉的模块级默认', () => {
    setColorPipeline('direct');
    const m = createStyledMaterial({ colorPipeline: 'linear' }) as unknown as {
      defines: Record<string, string>;
    };
    expect(m.defines.S3M_DIRECT_COLOR).toBeUndefined();
  });

  test('不传时仍跟随模块级默认（旧行为不变）', () => {
    setColorPipeline('direct');
    const m = createStyledMaterial({}) as unknown as { defines: Record<string, string> };
    expect(m.defines.S3M_DIRECT_COLOR).toBe('');
  });
});

/* --------------------------------------------------------- 瓦片构建透传 */

function oneTriangleTile(): ParsedTile {
  const f32 = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);
  return {
    version: 3,
    compressedType: 0,
    options: 0,
    groupNode: { pageLods: [{ geodes: [{ matrix: null, skeletonNames: ['skel0'] }] }] },
    geoPackage: {
      skel0: {
        vertexPackage: {
          verticesCount: 3,
          vertexAttributes: [
            { semantic: 'position', byteOffset: 0, comp: 3, dtype: 'f32', data: f32([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
            { semantic: 'uv', byteOffset: 0, comp: 2, dtype: 'f32', data: f32([0, 0, 1, 0, 0, 1]) },
          ],
          instanceIndex: -1,
        },
        indexPackages: [{ primitiveType: 4, indexCount: 3, indices: new Uint16Array([0, 1, 2]), passNames: ['M'] }],
      },
    },
    textures: {},
    materials: { materials: [{ material: { id: 'M', textureStates: [] } }] },
    pickInfo: {},
    bytesRead: 0,
    bytesTotal: 0,
  } as unknown as ParsedTile;
}

describe('buildTileObjects 的渲染 profile 透传', () => {
  test('colorPipeline 一路传到材质宏', async () => {
    const { objects } = await buildTileObjects(oneTriangleTile(), { colorPipeline: 'direct' });
    let checked = 0;
    for (const o of objects) {
      if (!(o as { isMesh?: boolean }).isMesh) continue;
      const m = (o as { material: { defines?: Record<string, string> } }).material;
      expect(m.defines?.S3M_DIRECT_COLOR).toBe('');
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('不传时仍按模块级默认（无宏）', async () => {
    const { objects } = await buildTileObjects(oneTriangleTile());
    for (const o of objects) {
      if (!(o as { isMesh?: boolean }).isMesh) continue;
      const m = (o as { material: { defines?: Record<string, string> } }).material;
      expect(m.defines?.S3M_DIRECT_COLOR).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------ 图层隔离 */

function makeViewer(opts: Record<string, unknown> = {}): S3MViewer {
  return new S3MViewer({
    canvas: null as never,
    container: null as never,
    ...opts,
  } as ConstructorParameters<typeof S3MViewer>[0]);
}

function registerMesh(viewer: S3MViewer, smid: number): THREE.Mesh {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(10, 10, 10);
  geo.setAttribute('aBatchId', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const mesh = new THREE.Mesh(geo, createStyledMaterial({ uniforms: viewer.uniforms }));
  mesh.userData = { geoRef: { pickInfo: { [smid]: { batchId: 0 } } } };
  group.add(mesh);
  (viewer as unknown as { _registerTile: (n: unknown, e: unknown) => void })._registerTile(
    { group, tile: null },
    { id: 'd', root: new THREE.Group() }
  );
  return mesh;
}

describe('图层级 colorPipeline 隔离', () => {
  test('两个图层各持管线，后创建的不覆盖先创建的', () => {
    const a = makeViewer({ colorPipeline: 'direct' });
    const b = makeViewer();
    expect(a.colorPipeline).toBe('direct');
    expect(b.colorPipeline).toBe('linear');
    expect(a.colorPipeline).toBe('direct');
    a.dispose();
    b.dispose();
  });

  test('构造图层不写模块级全局', () => {
    setColorPipeline('linear');
    const a = makeViewer({ colorPipeline: 'direct' });
    expect(getColorPipeline()).toBe('linear');
    a.dispose();
  });

  test('S3MLayer 门面同样隔离', () => {
    const a = new S3MLayer({ id: 'a', colorPipeline: 'direct' });
    const b = new S3MLayer({ id: 'b' });
    expect(a.colorPipeline).toBe('direct');
    expect(b.colorPipeline).toBe('linear');
    a.dispose?.();
    b.dispose?.();
  });

  test('非法值归一为 linear', () => {
    const v = makeViewer({ colorPipeline: 'nope' as never });
    expect(v.colorPipeline).toBe('linear');
    v.dispose();
  });
});

/* ------------------------------------------------------- fade-through 过渡 */

/** 带假时钟的 viewer：动画按绝对时间推进，用真实 performance.now() 断言不了中间值 */
function makeViewerWithClock(opts: Record<string, unknown> = {}): {
  v: S3MViewer;
  step: (t: number) => void;
} {
  let t = 0;
  const v = makeViewer(opts);
  (v.animator as unknown as { _now: () => number })._now = () => t;
  return {
    v,
    step: (n: number) => {
      t = n;
      v.animator.tick(n);
    },
  };
}

describe('setColorPipeline 的 fade-through', () => {
  test('压暗 → 换管线（重建材质）→ 亮回，Promise 在收尾后 resolve', async () => {
    const { v, step } = makeViewerWithClock();
    const mesh = registerMesh(v, 930);
    const defines = () => (mesh.material as unknown as { defines?: Record<string, string> }).defines;
    expect(defines()?.S3M_DIRECT_COLOR).toBeUndefined();

    let done = false;
    const p = v.setColorPipeline('direct', { duration: 20 }).then(() => {
      done = true;
    });

    // 第一段：压暗中，管线还没换
    step(10);
    expect(done).toBe(false);
    expect(v.colorPipeline).toBe('linear');
    expect(v.uniforms.uFade.value as number).toBeLessThan(1);

    // 第一段结束 → 同一帧里换管线，并开始第二段
    step(20);
    expect(v.colorPipeline).toBe('direct');
    expect(defines()?.S3M_DIRECT_COLOR).toBe('');

    // 第二段结束 → 亮回来，Promise resolve
    step(40);
    await p;
    expect(done).toBe(true);
    expect(v.uniforms.uFade.value).toBe(1);
    v.dispose();
  });

  test('duration 为 0 时立即生效，不动 uFade', () => {
    const v = makeViewer();
    const mesh = registerMesh(v, 931);
    v.setColorPipeline('direct');
    expect(v.colorPipeline).toBe('direct');
    expect(v.uniforms.uFade.value).toBe(1);
    expect((mesh.material as unknown as { defines?: Record<string, string> }).defines?.S3M_DIRECT_COLOR).toBe('');
    v.dispose();
  });

  test('同管线重复调用直接返回，不重建材质', async () => {
    const v = makeViewer({ colorPipeline: 'linear' });
    const mesh = registerMesh(v, 932);
    const before = mesh.material;
    await v.setColorPipeline('linear', { duration: 20 });
    expect(mesh.material).toBe(before);
    v.dispose();
  });

  test('切管线会把已缓存纹理的 colorSpace 翻过来（不重新下载瓦片）', async () => {
    const v = makeViewer();
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    // 直接把纹理塞进一个数据集缓存：模拟瓦片已经加载过
    const dm = (v as unknown as { _datasetManager: { registerDataset: (o: unknown) => { tileset: unknown } } })
      ._datasetManager;
    const entry = dm.registerDataset({ id: 'a', configUrl: 'a.scp' }) as {
      tileset: { textureCache: Map<string, THREE.Texture>; setRenderProfile: () => void; dispose: () => void };
    };
    entry.tileset = {
      textureCache: new Map([['T', tex]]),
      setRenderProfile: () => {},
      dispose: () => {},
    };

    v.setColorPipeline('direct');
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);

    v.setColorPipeline('linear');
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    v.dispose();
  });
});

/* ----------------------------------------------- 金属度 / 粗糙度动画起点 */

describe('金属度 / 粗糙度过渡起点', () => {
  test('roughness 从数据侧默认值（≈0.95）起跳，不从 0 跳变', () => {
    const v = makeViewer();
    registerMesh(v, 940);
    v.setStyle({ roughness: 0.2 }, { duration: 200 });
    v.animator.tick();
    const r = v.uniforms.uRoughness.value as number;
    expect(r).toBeGreaterThan(0.9);
    expect(r).toBeLessThanOrEqual(0.96);
    v.dispose();
  });

  test('metalness 从 0 起跳（S3M 数据恒为 0）', () => {
    const v = makeViewer();
    registerMesh(v, 941);
    v.setStyle({ metalness: 0.6 }, { duration: 200 });
    v.animator.tick();
    expect(v.uniforms.uMetalness.value as number).toBeCloseTo(0, 2);
    v.dispose();
  });

  test('最终值仍然能到位', () => {
    const v = makeViewer();
    registerMesh(v, 942);
    v.setStyle({ roughness: 0.2 }, { duration: 0 });
    expect(v.uniforms.uRoughness.value as number).toBeCloseTo(0.2, 3);
    v.dispose();
  });
});
