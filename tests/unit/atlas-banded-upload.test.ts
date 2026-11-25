/**
 * 图集分带上传：行推进、预算、完成判定。
 *
 * 用假 renderer / 假 GL 驱动真实逻辑（不碰 WebGL），钉住三件事：
 *   1. 一次 pump 只传预算内的行，下一条记录顺延到下一帧；
 *   2. 传满的高度 = 图高，且每次 texSubImage2D 的 y / 高度严丝合缝（不留缝、不重叠）；
 *   3. flush 必须在一次调用里把剩下的全传完（瓦片进场景前的兜底）。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import * as THREE from 'three';
import {
  DEFAULT_BAND_BUDGET,
  MIN_BANDED_BYTES,
  bandedUploadStats,
  flushBandedUploads,
  hasPendingBandedUploads,
  pumpBandedUploads,
  queueBandedUpload,
  shouldBandTexture,
} from '../../packages/s3m-three/src/render/AtlasUpload';

interface Call {
  y: number;
  h: number;
  bytes: number;
}

/** 最小的 renderer / GL 替身：只实现 AtlasUpload 用到的那几个口子 */
function fakeRenderer() {
  const calls: Call[] = [];
  /** 记录 GL 调用顺序，用来验证「每条行带上传前都重设了 unpack 状态」 */
  const ops: string[] = [];
  const created: object[] = [];
  const props = new Map<object, Record<string, unknown>>();
  const textures: object[] = [];
  const gl = {
    TEXTURE_2D: 3553,
    TEXTURE0: 33984,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    LINEAR: 9729,
    NEAREST: 9728,
    NEAREST_MIPMAP_NEAREST: 9984,
    CLAMP_TO_EDGE: 33071,
    REPEAT: 10497,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    UNPACK_FLIP_Y_WEBGL: 37440,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441,
    UNPACK_ALIGNMENT: 3317,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443,
    NONE: 0,
    RGBA8: 32856,
    SRGB8_ALPHA8: 35907,
    createTexture: () => {
      const t = { id: created.length };
      created.push(t);
      return t;
    },
    deleteTexture: () => {},
    pixelStorei: (pname: number, value: number) => {
      ops.push('store:' + pname + '=' + value);
    },
    texParameteri: () => {},
    texImage2D: () => {},
    texSubImage2D: (_t: number, _l: number, _x: number, y: number, _w: number, h: number) => {
      ops.push('sub:' + y);
      calls.push({ y, h, bytes: h * 8 * 4 });
    },
  };
  const renderer = {
    getContext: () => gl,
    capabilities: { maxTextures: 16 },
    properties: {
      get: (o: object) => {
        let p = props.get(o);
        if (!p) props.set(o, (p = {}));
        return p;
      },
    },
    state: {
      activeTexture: () => {},
      bindTexture: (target: number, t: object | null) => {
        if (t) textures.push(t);
      },
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls, created, ops };
}

function atlas(width: number, height: number): THREE.DataTexture {
  const data = new Uint8Array(width * height * 4);
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true; // version > 0，与 TextureFactory 里的创建路径一致
  return tex;
}

describe('图集分带上传', () => {
  beforeEach(() => {
    // 每个用例前把上一轮残留的队列清空（模块级队列，跨用例共享）
    const { renderer } = fakeRenderer();
    flushBandedUploads(renderer);
  });

  test('shouldBandTexture：只接 RGBA8 DataTexture，且体积达阈值', () => {
    const big = atlas(512, 512); // 1 MB
    expect(shouldBandTexture(big, 512 * 512 * 4)).toBe(true);
    const small = atlas(64, 64);
    expect(shouldBandTexture(small, 64 * 64 * 4)).toBe(false);
    expect(shouldBandTexture(big, MIN_BANDED_BYTES - 1)).toBe(false);

    const t = new THREE.Texture();
    expect(shouldBandTexture(t, 10 * 1024 * 1024)).toBe(false);
  });

  test('按预算分帧推进：y 连续、不重叠、总和等于图高', () => {
    const tex = atlas(512, 512); // 每行 2048 字节
    queueBandedUpload(tex);
    expect(hasPendingBandedUploads()).toBe(true);

    const { renderer, calls } = fakeRenderer();
    // 预算 = 100 行
    const budget = 100 * 512 * 4;
    let frames = 0;
    while (hasPendingBandedUploads() && frames < 50) {
      pumpBandedUploads(renderer, budget);
      frames++;
    }
    expect(frames).toBe(6); // ceil(512/100)
    const total = calls.reduce((n, c) => n + c.h, 0);
    expect(total).toBe(512);
    let y = 0;
    for (const c of calls) {
      expect(c.y).toBe(y);
      expect(c.h).toBeLessThanOrEqual(100);
      y += c.h;
    }
    expect(bandedUploadStats()).toEqual({ textures: 0, remainingRows: 0 });
  });

  test('flush：一次调用把剩余行全部传完（瓦片进场景前的兜底）', () => {
    const tex = atlas(256, 256);
    queueBandedUpload(tex);
    const { renderer, calls } = fakeRenderer();
    // 先只传一点点
    pumpBandedUploads(renderer, 10 * 256 * 4);
    expect(calls.length).toBeGreaterThan(0);
    const before = calls.reduce((n, c) => n + c.h, 0);
    expect(before).toBeLessThan(256);

    flushBandedUploads(renderer);
    const after = calls.reduce((n, c) => n + c.h, 0);
    expect(after).toBe(256);
    expect(hasPendingBandedUploads()).toBe(false);
  });

  test('重复排队同一张纹理只算一次', () => {
    const tex = atlas(256, 256);
    queueBandedUpload(tex);
    queueBandedUpload(tex);
    expect(bandedUploadStats().textures).toBe(1);
    const { renderer, calls } = fakeRenderer();
    flushBandedUploads(renderer);
    expect(calls.reduce((n, c) => n + c.h, 0)).toBe(256);
  });

  test('每条行带上传前都重设 unpack 状态（否则中间夹别的上传会把行带竖翻）', () => {
    const tex = atlas(256, 256);
    queueBandedUpload(tex);
    const { renderer, ops } = fakeRenderer();
    // 用 pump + 小预算切出多条行带（flush 会一条带传完，测不到「每条带之前都重设」）
    while (hasPendingBandedUploads()) pumpBandedUploads(renderer, 24 * 256 * 4);

    // 37440 = UNPACK_FLIP_Y_WEBGL。每两条 sub 之间必须出现一次 =false 的重设
    const subs = ops.filter((o) => o.startsWith('sub:'));
    expect(subs.length).toBeGreaterThan(5);
    let resetsSinceSub = 0;
    let checked = 0;
    for (const o of ops) {
      if (o === 'store:37440=0' || o === 'store:37440=false') resetsSinceSub++;
      else if (o.startsWith('sub:')) {
        expect(resetsSinceSub).toBeGreaterThan(0);
        resetsSinceSub = 0;
        checked++;
      }
    }
    expect(checked).toBe(subs.length);
  });

  test('默认预算是 8 MB（一帧不会把几十 MB 全灌进去）', () => {
    expect(DEFAULT_BAND_BUDGET).toBe(8 * 1024 * 1024);
  });
});
