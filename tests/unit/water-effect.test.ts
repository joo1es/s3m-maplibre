/**
 * 数据集级水面特效（`*.water`）的解析与接线。
 *
 * 背景：`103.water` 只是 S3M 块里的**纹理单元 id**，它只说「这块几何是水」，
 * 块里没有像素（实测 1081 字节、textures = 0），所以渲染层只能拍一个常量色。
 * 真正的「水长什么样」写在数据集 config 的 `extensions.attachFiles` 指向的
 * `*.water` 里 —— 那是 Ogre3D 的 `SCPDescriptor` 序列化文本（XML），
 * 内容是 `WaterEffect` 的两段 `GpuProgramParameters`：全是 uniform 常量，
 * 没有 shader 源码、没有纹理文件名。
 *
 * 实测样本：`supermapol 3D-CBD-2 / datas/Lake@CBD` → `955833.water`（4281 B）。
 * 该样本已存进 `tests/fixtures/water/`，参数断言全部基于它，不靠臆测。
 *
 * 三条要点（对应 AGENTS.md 的不变式）：
 *   1. **默认不发新请求**。不传 `waterEffect` 时请求列表与改动前逐字一致；
 *   2. 解析是纯函数，无依赖（不引 XML 库），可被 Worker / Node 复用；
 *   3. 未知 / 残缺配置一律回落官方默认，绝不把 NaN 送进材质。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWaterAttachFile } from '../../packages/s3m-three/src/tileset/config';
import { S3MTileset } from '../../packages/s3m-three/src/tileset/S3MTileset';
import { DEFAULT_WATER_EFFECT, parseWaterEffect } from '../../packages/s3m-three/src/tileset/water';

const FIXTURES = join(import.meta.dir, '../fixtures');
const SAMPLE_WATER = readFileSync(join(FIXTURES, 'water/955833.water'), 'utf8');

/* ------------------------------------------------------------------ 解析 */

describe('parseWaterEffect：真实样本', () => {
  const w = parseWaterEffect(SAMPLE_WATER);

  test('识得出 WaterEffect，并把 AverageHeight 读成水面高程', () => {
    expect(w).not.toBeNull();
    // config 的 rootTiles boundingbox center.z = 3.6977，与这个值同源
    expect(w!.averageHeight).toBeCloseTo(3.700006, 6);
  });

  test('水体基色 / 色偏 / 亮度', () => {
    expect(w!.waterColour).toEqual([0, 0.627451, 0.913725, 1]);
    expect(w!.tintColour).toEqual([0, 0.05, 0.05, 1]);
    expect(w!.waterBrightness).toBeCloseTo(0.7, 6);
  });

  test('菲涅尔与噪声参数', () => {
    expect(w!.fresnelPower).toBeCloseTo(0.1, 6);
    expect(w!.minFresnel).toBeCloseTo(0, 6);
    expect(w!.maxFresnel).toBeCloseTo(1, 6);
    expect(w!.noiseScale).toBeCloseTo(0.03, 6);
    expect(w!.scale).toBeCloseTo(100, 6);
    expect(w!.scroll).toBeCloseTo(1, 6);
    expect(w!.noise).toBeCloseTo(1, 6);
  });

  test('bumpSpeed 的 -0.000000 归一成 +0：负零会让快照比较出现幽灵差异', () => {
    expect(w!.bumpSpeed).toEqual([0, 0]);
    expect(Object.is(w!.bumpSpeed[0], -0)).toBe(false);
    expect(Object.is(w!.bumpSpeed[1], -0)).toBe(false);
  });

  test('采样器槽位按名字收集：这份配置要 noise / reflect / refract 三张图', () => {
    // ConstType 23 = GCT_SAMPLER2D，只有名字没有 ArrayFloat。
    // 记下来是为了让上层能判断「复刻到什么程度」——reflect/refract 是运行时渲染目标，
    // 不是静态贴图，缺它们就只能近似。
    expect(w!.samplers).toEqual(['noiseMap', 'reflectMap', 'refractMap']);
  });
});

describe('parseWaterEffect：拒绝与兜底', () => {
  test('不是 XML 就返回 null，不抛错', () => {
    expect(parseWaterEffect('{"asset":"SuperMap"}')).toBeNull();
    expect(parseWaterEffect('')).toBeNull();
    expect(parseWaterEffect('   ')).toBeNull();
  });

  test('是 XML 但不是 WaterEffect（例如 .scp / 地形缓存）返回 null', () => {
    const scp = `<?xml version="1.0" encoding="UTF-8"?>
<SuperMapCache><FileType>OSGBCacheFile</FileType><X>116.4</X><Y>39.9</Y></SuperMapCache>`;
    expect(parseWaterEffect(scp)).toBeNull();

    const terrain = `<?xml version="1.0" encoding="UTF-8"?>
<SuperMapCache><FileType>OSGBCacheFile</FileType><FileExtentName>Terrainz</FileExtentName></SuperMapCache>`;
    expect(parseWaterEffect(terrain)).toBeNull();
  });

  test('只有 FileType 标记时，所有参数回落官方默认（Ogre 材质 default_params）', () => {
    const w = parseWaterEffect(`<SCPDescriptor><FileType>WaterEffect</FileType><WaterEffect/></SCPDescriptor>`);
    expect(w).not.toBeNull();
    expect(w!.averageHeight).toBeNull(); // 没有默认值，交给几何判断
    expect(w!.waterColour).toEqual(DEFAULT_WATER_EFFECT.waterColour);
    expect(w!.fresnelPower).toBeCloseTo(1.8, 6);
    expect(w!.minFresnel).toBeCloseTo(0.3, 6);
    expect(w!.maxFresnel).toBeCloseTo(0.7, 6);
    expect(w!.scale).toBeCloseTo(80, 6);
    expect(w!.bumpSpeed).toEqual([3, -3]);
    expect(w!.samplers).toEqual([]);
  });

  test('空 <Float> 或非数字不产出 NaN，回落默认', () => {
    const w = parseWaterEffect(`<SCPDescriptor><FileType>WaterEffect</FileType><WaterEffect>
<GpuConstants>
  <GpuConstantDefinition>
    <ConstType>4</ConstType><Name>waterBrightness</Name><ArraySize>1</ArraySize>
    <ArrayFloat><Float></Float></ArrayFloat>
  </GpuConstantDefinition>
  <GpuConstantDefinition>
    <ConstType>4</ConstType><Name>fresnelPower</Name><ArraySize>1</ArraySize>
    <ArrayFloat><Float>abc</Float></ArrayFloat>
  </GpuConstantDefinition>
  <GpuConstantDefinition>
    <ConstType>4</ConstType><Name>waterColour</Name><ArraySize>3</ArraySize>
    <ArrayFloat><Float>0.1</Float></ArrayFloat>
  </GpuConstantDefinition>
</GpuConstants></WaterEffect></SCPDescriptor>`);
    expect(w).not.toBeNull();
    expect(w!.waterBrightness).toBeCloseTo(DEFAULT_WATER_EFFECT.waterBrightness, 6);
    expect(w!.fresnelPower).toBeCloseTo(DEFAULT_WATER_EFFECT.fresnelPower, 6);
    // 分量不足的向量整体回落：半个颜色比默认色更不靠谱
    expect(w!.waterColour).toEqual(DEFAULT_WATER_EFFECT.waterColour);
  });
});

/* ------------------------------------------------------- config 里的附件引用 */

describe('readWaterAttachFile', () => {
  test('从 extensions.attachFiles 里挑出 .water', () => {
    const cfg = { extensions: { attachFiles: [{ attachFile: '955833.water' }] } };
    expect(readWaterAttachFile(cfg)).toBe('955833.water');
  });

  test('多个附件时只认 .water，其他类型跳过', () => {
    const cfg = {
      extensions: {
        attachFiles: [{ attachFile: 'normal.png' }, { attachFile: 'lake.WATER' }, { attachFile: 'meta.xml' }],
      },
    };
    expect(readWaterAttachFile(cfg)).toBe('lake.WATER');
  });

  test('没有 extensions / attachFiles 时返回 null', () => {
    expect(readWaterAttachFile({})).toBeNull();
    expect(readWaterAttachFile({ extensions: {} })).toBeNull();
    expect(readWaterAttachFile({ extensions: { attachFiles: [] } })).toBeNull();
    expect(readWaterAttachFile(null)).toBeNull();
  });

  test('结构异常不抛错（元素是字符串 / 缺字段 / 非数组）', () => {
    expect(readWaterAttachFile({ extensions: { attachFiles: 'a.water' } })).toBeNull();
    expect(readWaterAttachFile({ extensions: { attachFiles: ['a.water'] } })).toBeNull();
    expect(readWaterAttachFile({ extensions: { attachFiles: [{}, { attachFile: '' }] } })).toBeNull();
    expect(readWaterAttachFile({ extensions: null })).toBeNull();
  });
});

/* ------------------------------------------------------------ S3MTileset 接线 */

const CONFIG_WITH_WATER = JSON.stringify({
  asset: 'SuperMap',
  dataType: 'BIM',
  crs: 'epsg:4326',
  position: { units: 'Degree', x: 116.4596689690658, y: 39.909644403098753, z: 0 },
  geoBounds: { left: 116.45716269588419, bottom: 39.908012520642203, right: 116.4621752422474, top: 39.911276285555289 },
  rootTiles: [{ url: './Tile_-29062_84803/Tile_-29062_84803.s3mb' }],
  extensions: { attachFiles: [{ attachFile: '955833.water' }] },
});

/** 拦下全局 fetch，记录请求列表，按后缀给假响应 */
function stubFetch(opts: { waterStatus?: number } = {}) {
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('.water')) {
      if (opts.waterStatus && opts.waterStatus !== 200) {
        return new Response('nope', { status: opts.waterStatus });
      }
      return new Response(SAMPLE_WATER, { status: 200, headers: { 'content-type': 'application/water' } });
    }
    if (url.endsWith('config') || url.endsWith('.scp')) {
      return new Response(CONFIG_WITH_WATER, { status: 200 });
    }
    // 根瓦片给 404：本文件只验证「请求了哪些 URL」，不验证瓦片解析
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    requested,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('S3MTileset：默认不请求 .water', () => {
  test('不传 waterEffect 时，请求列表与改动前逐字一致（不变式①）', async () => {
    const stub = stubFetch();
    try {
      const ts = new S3MTileset({
        configUrl: 'https://example.com/datas/Lake@CBD/config',
        maxRetries: 0,
        onError: () => {},
      });
      await ts.init();
      expect(stub.requested.some((u) => u.endsWith('.water'))).toBe(false);
      expect(ts.waterEffect).toBeNull();
    } finally {
      stub.restore();
    }
  });
});

describe('S3MTileset：显式开启后才读 .water', () => {
  test('waterEffect: true 时按 config 的 attachFiles 取回并解析', async () => {
    const stub = stubFetch();
    try {
      const ts = new S3MTileset({
        configUrl: 'https://example.com/datas/Lake@CBD/config',
        waterEffect: true,
        maxRetries: 0,
        onError: () => {},
      });
      await ts.init();
      expect(stub.requested.some((u) => u === 'https://example.com/datas/Lake@CBD/955833.water')).toBe(true);
      expect(ts.waterEffect).not.toBeNull();
      expect(ts.waterEffect!.averageHeight).toBeCloseTo(3.700006, 6);
      expect(ts.waterEffect!.waterColour).toEqual([0, 0.627451, 0.913725, 1]);
    } finally {
      stub.restore();
    }
  });

  test('.water 拉不到时降级为 null，不阻断 init', async () => {
    const stub = stubFetch({ waterStatus: 404 });
    try {
      const ts = new S3MTileset({
        configUrl: 'https://example.com/datas/Lake@CBD/config',
        waterEffect: true,
        maxRetries: 0,
        onError: () => {},
      });
      await ts.init();
      expect(ts.waterEffect).toBeNull();
      // 配置本身仍然可用：水面参数缺失不影响出图
      expect(ts.rootUrls.length).toBe(1);
    } finally {
      stub.restore();
    }
  });
});
