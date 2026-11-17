/**
 * demo 宿主切换（MapLibre / Mapbox 任意版本）的纯逻辑测试。
 *
 * 这三块是全靠字符串与普通对象算出来的东西，正好可以完全不碰 WebGL：
 *   1. `resolveHost` —— URL 参数 → 加载计划（默认必须与改造前逐字一致）
 *   2. `applyHostChoice` —— 面板切换 → 新 URL（不能丢掉用户正在看的数据集 / 底图参数）
 *   3. `applyHostCompat` —— Mapbox 缺 `getLayersOrder()` 的垫片
 */
import { describe, expect, it } from 'bun:test';
import {
  HOST_ENGINES,
  HOST_PRESETS,
  applyHostChoice,
  applyHostCompat,
  cdnFallbackOrder,
  cdnScriptUrl,
  cdnStyleUrl,
  describeHost,
  hostFormat,
  layerOrderOf,
  resolveHost,
  siblingFormatUrl,
} from '../../site/src/demo/host.js';

describe('resolveHost: 默认配置与改造前一致', () => {
  it('不带任何参数 → 内置 maplibre、不注入外部资源、无 warning', () => {
    const plan = resolveHost('');
    expect(plan.engine).toBe('maplibre');
    expect(plan.source).toBe('bundled');
    expect(plan.version).toBeNull();
    expect(plan.scriptUrl).toBe('');
    expect(plan.styleUrl).toBe('');
    expect(plan.warnings).toEqual([]);
  });

  it('显式 ?gl=maplibre 与不带参数等价', () => {
    expect(resolveHost('?gl=maplibre')).toEqual(resolveHost(''));
  });

  it('?gl 允许带前导问号之外的裸 query', () => {
    expect(resolveHost('gl=maplibre').engine).toBe('maplibre');
  });
});

describe('resolveHost: 引擎别名与未知值', () => {
  it.each([
    ['mb', 'mapbox'],
    ['MB', 'mapbox'],
    ['mapbox-gl', 'mapbox'],
    ['maplibre-gl', 'maplibre'],
    ['ml', 'maplibre'],
  ])('?gl=%s 解析为 %s', (raw, expected) => {
    expect(resolveHost(`?gl=${raw}`).engine).toBe(expected as 'maplibre' | 'mapbox');
  });

  it('未知引擎退回内置 maplibre 并留一条 warning，而不是抛错', () => {
    const plan = resolveHost('?gl=leaflet');
    expect(plan.engine).toBe('maplibre');
    expect(plan.source).toBe('bundled');
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('leaflet');
  });
});

describe('resolveHost: 走 CDN 的三种触发条件', () => {
  it('?gl=mapbox 没有内置副本 → CDN，并钉住默认版本', () => {
    const plan = resolveHost('?gl=mapbox');
    expect(plan.source).toBe('cdn');
    expect(plan.version).toBe(HOST_ENGINES.mapbox.defaultCdnVersion);
    expect(plan.scriptUrl).toBe(
      `https://cdn.jsdelivr.net/npm/mapbox-gl@${HOST_ENGINES.mapbox.defaultCdnVersion}/dist/mapbox-gl.js`,
    );
    expect(plan.styleUrl.endsWith('/dist/mapbox-gl.css')).toBe(true);
  });

  it('?glv 给了版本就换 CDN，即使引擎是内置的 maplibre', () => {
    const plan = resolveHost('?gl=maplibre&glv=6.18.0');
    expect(plan.source).toBe('cdn');
    expect(plan.version).toBe('6.18.0');
    // MapLibre v6 起 dist 里没有 maplibre-gl.js，只有 .mjs
    expect(plan.format).toBe('esm');
    expect(plan.scriptUrl).toBe('https://cdn.jsdelivr.net/npm/maplibre-gl@6.18.0/dist/maplibre-gl.mjs');
    expect(plan.styleUrl).toBe('https://cdn.jsdelivr.net/npm/maplibre-gl@6.18.0/dist/maplibre-gl.css');
  });

  it('只给 ?glv（不给 gl）时按 maplibre 的指定版本走 CDN', () => {
    const plan = resolveHost('?glv=6.18.0');
    expect(plan.engine).toBe('maplibre');
    expect(plan.source).toBe('cdn');
  });

  it('?glsrc 视为 CDN（自托管脚本）', () => {
    const plan = resolveHost('?gl=mapbox&glsrc=https://example.com/mapbox-gl.js');
    expect(plan.source).toBe('cdn');
    expect(plan.scriptUrl).toBe('https://example.com/mapbox-gl.js');
  });

  it('?glcss 覆盖样式地址', () => {
    const plan = resolveHost(
      '?gl=mapbox&glv=3.35.0&glsrc=https://example.com/mapbox-gl.js&glcss=https://example.com/mapbox-gl.css',
    );
    expect(plan.styleUrl).toBe('https://example.com/mapbox-gl.css');
  });

  it('只给 ?glcdn（不给版本）不会把内置包挤到 CDN', () => {
    const plan = resolveHost('?glcdn=unpkg');
    expect(plan.source).toBe('bundled');
  });
});

describe('resolveHost: 版本号白名单', () => {
  it('接受 semver、主次版本、latest（大小写/前导 v 归一）', () => {
    expect(resolveHost('?glv=v6.18.0').version).toBe('6.18.0');
    expect(resolveHost('?glv=6').version).toBe('6');
    expect(resolveHost('?glv=6.18').version).toBe('6.18');
    expect(resolveHost('?glv=latest').version).toBe('latest');
  });

  it.each(['../../evil', '6.18.0/../x', '1.0.0;rm', 'six'])(
    '非法版本 %s 被丢掉并留 warning',
    (bad) => {
      const plan = resolveHost(`?glv=${encodeURIComponent(bad)}`);
      expect(plan.version).toBeNull();
      expect(plan.source).toBe('bundled');
      expect(plan.warnings).toHaveLength(1);
    },
  );
});

describe('CDN 地址推导', () => {
  it('jsdelivr / unpkg 走 /<pkg>@<ver>/dist/<pkg>.<ext>', () => {
    expect(cdnScriptUrl('mapbox', '2.15.0', 'jsdelivr')).toBe(
      'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/dist/mapbox-gl.js',
    );
    expect(cdnScriptUrl('maplibre', null, 'unpkg')).toBe(
      'https://unpkg.com/maplibre-gl/dist/maplibre-gl.mjs',
    );
  });

  it('npmmirror 走 /<pkg>/<ver>/files 形态，且是国内镜像唯一能拿到原始文件的路径', () => {
    expect(cdnScriptUrl('mapbox', '3.35.0', 'npmmirror')).toBe(
      'https://registry.npmmirror.com/mapbox-gl/3.35.0/files/dist/mapbox-gl.js',
    );
  });

  it('css 地址不受产物格式影响，永远是 dist/<pkg>.css', () => {
    expect(cdnStyleUrl('maplibre', '6.18.0', 'jsdelivr')).toBe(
      'https://cdn.jsdelivr.net/npm/maplibre-gl@6.18.0/dist/maplibre-gl.css',
    );
    expect(cdnStyleUrl('mapbox', '3.35.0', 'jsdelivr')).toBe(
      'https://cdn.jsdelivr.net/npm/mapbox-gl@3.35.0/dist/mapbox-gl.css',
    );
  });

  it('?glcdn=npmmirror/taobao 都能用', () => {
    expect(resolveHost('?gl=mapbox&glcdn=npmmirror').cdn).toBe('npmmirror');
    expect(resolveHost('?gl=mapbox&glcdn=taobao').cdn).toBe('npmmirror');
    expect(resolveHost('?gl=mapbox&glcdn=cdnjs').cdn).toBe('jsdelivr');
  });
});

describe('cdnFallbackOrder: 主 CDN 取不到时的兜底顺序', () => {
  it('用户选的那个永远排第一，其余按固定顺序补齐（不重复）', () => {
    expect(cdnFallbackOrder('jsdelivr')).toEqual(['jsdelivr', 'unpkg', 'npmmirror']);
    expect(cdnFallbackOrder('unpkg')).toEqual(['unpkg', 'jsdelivr', 'npmmirror']);
    expect(cdnFallbackOrder('npmmirror')).toEqual(['npmmirror', 'jsdelivr', 'unpkg']);
  });

  it('返回的是新数组：调用方改它不会污染下一次解析', () => {
    const first = cdnFallbackOrder('jsdelivr');
    first.pop();
    expect(cdnFallbackOrder('jsdelivr')).toHaveLength(3);
  });
});

describe('hostFormat: v6 不再发 UMD', () => {
  it.each([
    ['maplibre', '5.24.1', 'umd'],
    ['maplibre', '4.7.1', 'umd'],
    ['maplibre', '6', 'esm'],
    ['maplibre', '6.18.0', 'esm'],
    ['maplibre', 'latest', 'esm'],
    ['maplibre', null, 'esm'],
    ['mapbox', '3.35.0', 'umd'],
    ['mapbox', '2.15.0', 'umd'],
  ] as const)('%s@%s → %s', (engine, version, expected) => {
    expect(hostFormat(engine, version)).toBe(expected as 'umd' | 'esm');
  });

  it('?glfmt 可以硬覆盖推断（自托管产物格式不明时用）', () => {
    expect(resolveHost('?glv=5.24.1&glfmt=umd').format).toBe('umd');
    expect(resolveHost('?glv=5.24.1&glfmt=esm').format).toBe('esm');
    expect(resolveHost('?glv=6.18.0&glfmt=amd').warnings.length).toBe(1);
  });

  it('显式 ?glfmt=umd + v6 → 纠正成 ESM，绝不生成那个必然 404 的 .js 地址', () => {
    const plan = resolveHost('?glv=6.18.0&glfmt=umd');
    expect(plan.format).toBe('esm');
    expect(plan.scriptUrl).toBe('https://cdn.jsdelivr.net/npm/maplibre-gl@6.18.0/dist/maplibre-gl.mjs');
    expect(plan.warnings.some((w) => w.includes('UMD'))).toBe(true);
  });

  it('?glv=latest 也是 ESM（latest 现在就是 6.x，猜不出大版本时按当前发布线算）', () => {
    const plan = resolveHost('?glv=latest&glfmt=umd');
    expect(plan.format).toBe('esm');
    expect(plan.scriptUrl.endsWith('.mjs')).toBe(true);
  });

  it('手写 glsrc 时 glfmt 仍然说了算（自托管产物格式不明，不能替用户改地址）', () => {
    const plan = resolveHost('?glv=6.18.0&glfmt=umd&glsrc=https://x/my-maplibre.js');
    expect(plan.format).toBe('umd');
    expect(plan.scriptUrl).toBe('https://x/my-maplibre.js');
    expect(plan.selfHosted).toBe(true);
  });

  it('v5 的 UMD 照旧可用（5.24.1 的 dist/maplibre-gl.js 确实存在）', () => {
    const plan = resolveHost('?glv=5.24.1&glfmt=umd');
    expect(plan.format).toBe('umd');
    expect(plan.scriptUrl).toBe('https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.1/dist/maplibre-gl.js');
  });

  it('?glsrc 以 .mjs 结尾时按 ESM 处理', () => {
    expect(resolveHost('?gl=maplibre&glsrc=https://x/maplibre-gl.mjs').format).toBe('esm');
  });

  it('siblingFormatUrl 能把用户写的 .js 纠到 .mjs', () => {
    expect(siblingFormatUrl('https://cdn.jsdelivr.net/npm/maplibre-gl@6.18.0/dist/maplibre-gl.js')).toBe(
      'https://cdn.jsdelivr.net/npm/maplibre-gl@6.18.0/dist/maplibre-gl.mjs',
    );
    expect(siblingFormatUrl('https://x/mapbox-gl.js')).toBeNull();
  });
});

describe('resolveHost: WebGL 版本闸门', () => {
  it('Mapbox 2.x 给出 WebGL1 警告（只提示，不拦加载）', () => {
    const plan = resolveHost('?gl=mapbox&glv=2.15.0');
    expect(plan.engine).toBe('mapbox');
    expect(plan.source).toBe('cdn');
    expect(plan.warnings.some((w) => w.includes('WebGL1'))).toBe(true);
  });

  it('Mapbox 3.x / MapLibre 任意版本都没有这条警告', () => {
    expect(resolveHost('?gl=mapbox&glv=3.35.0').warnings).toEqual([]);
    expect(resolveHost('?gl=maplibre&glv=5.24.1').warnings).toEqual([]);
  });

  it('预设里不再提供 Mapbox 2.x', () => {
    expect(HOST_PRESETS.every((p) => !(p.engine === 'mapbox' && p.version?.startsWith('2.')))).toBe(true);
  });
});

describe('applyHostChoice: 切换时不丢掉现场', () => {
  it('切到内置 maplibre 时清掉全部切换参数，其余参数原样保留', () => {
    const next = applyHostChoice('?gl=mapbox&glv=3.35.0&url=cbd&basemap=esri&ortho=local', {
      engine: 'maplibre',
      version: null,
    });
    expect(next).toBe('?url=cbd&basemap=esri&ortho=local');
  });

  it('全部参数都清掉时返回空串（不留一个孤零零的 ?）', () => {
    expect(applyHostChoice('', { engine: 'maplibre', version: null })).toBe('');
    expect(applyHostChoice('?gl=mapbox', { engine: 'maplibre', version: null })).toBe('');
  });

  it('切到 mapbox 指定版本 → gl + glv', () => {
    expect(applyHostChoice('?url=cbd', { engine: 'mapbox', version: '3.35.0' })).toBe(
      '?url=cbd&gl=mapbox&glv=3.35.0',
    );
  });

  it('切到 mapbox 不带版本 → 只写 gl（版本由 defaultCdnVersion 决定）', () => {
    expect(applyHostChoice('', { engine: 'mapbox', version: '' })).toBe('?gl=mapbox');
  });

  it('带 cdn 时写 glcdn，不带时清掉旧的', () => {
    expect(applyHostChoice('?glcdn=unpkg', { engine: 'maplibre', version: '6.18.0' })).toBe(
      '?gl=maplibre&glv=6.18.0',
    );
    expect(
      applyHostChoice('', { engine: 'maplibre', version: '6.18.0', cdn: 'npmmirror' }),
    ).toBe('?gl=maplibre&glv=6.18.0&glcdn=npmmirror');
  });

  it('手工指定的 glsrc / glcss 会被切走', () => {
    const next = applyHostChoice('?gl=mapbox&glsrc=https://x/a.js&glcss=https://x/a.css&url=cbd', {
      engine: 'mapbox',
      version: '3.35.0',
    });
    expect(next).toBe('?url=cbd&gl=mapbox&glv=3.35.0');
  });

  it('机位参数必须原样带过去：换引擎后两次截图要能逐像素对比', () => {
    const next = applyHostChoice('?zoom=17.72&pitch=50&bearing=-25&lng=116.4581&lat=39.9123', {
      engine: 'mapbox',
      version: '3.35.0',
    });
    expect(next).toBe(
      '?zoom=17.72&pitch=50&bearing=-25&lng=116.4581&lat=39.9123&gl=mapbox&glv=3.35.0',
    );
  });

  it('生成的 query 能被 resolveHost 读回来（闭环）', () => {
    const search = applyHostChoice('?url=cbd&basemap=osm', {
      engine: 'maplibre',
      version: '6.18.0',
      cdn: 'npmmirror',
    });
    const plan = resolveHost(search);
    expect(plan.engine).toBe('maplibre');
    expect(plan.version).toBe('6.18.0');
    expect(plan.cdn).toBe('npmmirror');
    expect(plan.source).toBe('cdn');
  });
});

describe('applyHostCompat: Mapbox 缺 getLayersOrder 的垫片', () => {
  it('Mapbox 形态（有 style._order、没有 getLayersOrder）→ 补上并包含 custom 层', () => {
    // 照 Mapbox 的真实形态造：custom 层在 _order 里，但 getStyle().layers 里没有
    const map: Record<string, any> = {
      style: { _order: ['bg', 'osm', 's3m'], _layers: { bg: {}, osm: {}, s3m: {} } },
      getStyle: () => ({ layers: [{ id: 'bg' }, { id: 'osm' }] }),
    };
    expect(applyHostCompat(map)).toEqual({ layersOrder: 'shim' });
    expect(map.getLayersOrder()).toEqual(['bg', 'osm', 's3m']);
    expect(map.getLayersOrder()).toContain('s3m');
  });

  it('MapLibre 形态（自带 getLayersOrder）→ 保留原生实现，不覆盖', () => {
    const native = () => ['native'];
    const map = { getLayersOrder: native };
    expect(applyHostCompat(map)).toEqual({ layersOrder: 'native' });
    expect(map.getLayersOrder).toBe(native);
    expect(map.getLayersOrder()).toEqual(['native']);
  });

  it('不是对象 / 空值 → none，且不抛错', () => {
    expect(applyHostCompat(null)).toEqual({ layersOrder: 'none' });
    expect(applyHostCompat(undefined)).toEqual({ layersOrder: 'none' });
    expect(applyHostCompat(42 as unknown)).toEqual({ layersOrder: 'none' });
  });

  it('样式还没建好时返回空数组，而不是抛错', () => {
    const map: Record<string, any> = {};
    applyHostCompat(map);
    expect(map.getLayersOrder()).toEqual([]);
  });
});

describe('layerOrderOf: 三档退让', () => {
  it('优先 _order（含 custom 层）', () => {
    expect(layerOrderOf({ style: { _order: ['a', 'b'] } })).toEqual(['a', 'b']);
  });

  it('没有 _order 时退回 _layers 的键', () => {
    expect(layerOrderOf({ style: { _layers: { a: {}, b: {} } } })).toEqual(['a', 'b']);
  });

  it('内部字段都没有时退回 getStyle().layers（不含 custom 层，仅兜底）', () => {
    expect(layerOrderOf({ getStyle: () => ({ layers: [{ id: 'a' }] }) })).toEqual(['a']);
  });

  it('什么也没有 → 空数组', () => {
    expect(layerOrderOf(null)).toEqual([]);
    expect(layerOrderOf({})).toEqual([]);
  });

  it('_order 里混进非字符串时过滤掉，调用方不必再防御', () => {
    expect(layerOrderOf({ style: { _order: ['a', undefined, 3, 'b'] } })).toEqual(['a', 'b']);
  });
});

describe('describeHost: 面板文案', () => {
  it('内置包', () => {
    expect(describeHost(resolveHost(''))).toBe('MapLibre GL · 内置包');
  });

  it('CDN 指定版本', () => {
    expect(describeHost(resolveHost('?gl=mapbox&glv=2.15.0'))).toBe('Mapbox GL 2.15.0 · CDN jsdelivr');
  });
});
