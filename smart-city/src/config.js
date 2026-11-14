/**
 * 演出用的静态配置：数据、配色、镜头关键帧、章节元数据。
 *
 * 这里不放任何运行时状态，改数值就能改演出节奏，不用翻逻辑代码。
 */

/** SuperMap Online 公有服务：北京 CBD，7 个图层叠起来才是完整城市 */
export const SERVICE = 'https://www.supermapol.com/realspace/services/3D-CBD-2/rest/realspace/datas';

export const DATASETS = [
  { id: 'Building@CBD', label: '建筑', accent: '#4ad8ff' },
  { id: 'Xiaopin@CBD', label: '城市小品', accent: '#ffc86b' },
  { id: 'Ground2@CBD', label: '铺装', accent: '#5ce6b0' },
  { id: 'Tree@CBD', label: '植被', accent: '#7ee787' },
  { id: 'Lake@CBD', label: '水系', accent: '#5aa9ff' },
  { id: 'Bridge@CBD', label: '桥梁', accent: '#ff79c6' },
  { id: 'Ground@CBD', label: '地面', accent: '#8fa6bf' },
];

export const configUrlOf = (name) => `${SERVICE}/${name}/config`;

/** 数据集配置里的锚点与范围（Building@CBD 的 position / geoBounds） */
export const CITY = {
  center: [116.4581104772965, 39.912298501230481],
  bounds: [
    [116.4444634480989, 39.902884646464152],
    [116.4717575064941, 39.921712355996803],
  ],
  /** 建筑高度上限的经验值，用于「限高生长」扫描；CBD 最高约 230m，留足余量 */
  maxHeight: 420,
};

export const THEME = {
  cyan: '#4ad8ff',
  cyanSoft: '#8fe8ff',
  blue: '#0d4f86',
  deepBlue: '#0a2c52',
  white: '#e6f6ff',
  gold: '#ffc86b',
  magenta: '#ff79c6',
  green: '#5ce6b0',
};

/** 每一幕的落点。duration 用毫秒，镜头过渡占整幕，特效在幕内按进度推进 */
export const CAMERA = {
  start: { center: CITY.center, zoom: 12.4, pitch: 0, bearing: 0 },
  awaken: { center: CITY.center, zoom: 15.35, pitch: 48, bearing: -14 },
  grow: { center: CITY.center, zoom: 15.95, pitch: 62, bearing: -28 },
  skeleton: { center: CITY.center, zoom: 15.8, pitch: 56, bearing: 22 },
  pulse: { center: [116.4606, 39.9142], zoom: 16.85, pitch: 68, bearing: 38 },
  panorama: { center: CITY.center, zoom: 15.45, pitch: 55, bearing: -25 },
};

/** 引擎能力清单：演出到哪一幕，就点亮哪几项 —— 让「肌肉」是看得见的 */
export const CAPABILITIES = [
  { id: 'tiles', label: 'S3MB 原生解析 · 7 数据集叠加', acts: ['awaken'] },
  { id: 'lod', label: 'LOD 调度 / 瓦片淡入', acts: ['awaken', 'grow'] },
  { id: 'style', label: 'Uniform 级动态着色 · 9 种模式', acts: ['grow', 'skeleton'] },
  { id: 'filter', label: '单体过滤 · 限高生长扫描', acts: ['grow'] },
  { id: 'edges', label: 'GPU 棱线 / 屏幕空间等宽线', acts: ['skeleton', 'panorama'] },
  { id: 'overlay', label: '三维覆盖物 · 发光边界 / 光池', acts: ['skeleton', 'pulse'] },
  { id: 'flow', label: '流光飞线 / 数据链路', acts: ['pulse'] },
  { id: 'post', label: '接管上屏 · 辉光后处理', acts: ['pulse'] },
  { id: 'water', label: '水面特效解析 · 菲涅尔 / 流动噪声', acts: ['awaken', 'grow', 'skeleton', 'pulse', 'panorama'] },
  { id: 'pick', label: 'GPU 拾取 · 单体属性', acts: ['pulse', 'panorama'] },
];

/** 右侧「城市体征」：演示数据，界面上明确标了 DEMO DATA，不冒充真实统计 */
export const KPIS = [
  { id: 'pop', label: '区域常住人口', value: 28.6, digits: 1, unit: '万人', accent: 'cyan' },
  { id: 'bldg', label: '建筑单体', value: 1842, digits: 0, unit: '栋', accent: 'gold' },
  { id: 'road', label: '路网密度', value: 8.42, digits: 2, unit: 'km/km²', accent: 'magenta' },
  { id: 'iot', label: '在线感知设备', value: 12680, digits: 0, unit: '台', accent: 'green' },
];

export const BARS = [
  { id: 'energy', label: '能源负荷', value: 72 },
  { id: 'traffic', label: '路网通行', value: 86 },
  { id: 'env', label: '环境指数', value: 93 },
  { id: 'safety', label: '安防在线', value: 99 },
];

/** 章节元数据。enter/tick/exit 的实现在 show.js，按 id 对应 */
export const ACTS = [
  {
    id: 'awaken',
    no: '01',
    name: '城市唤醒',
    title: '从 12 万米到街巷',
    desc: '浏览器直连 iServer 拉取 S3MB 瓦片，LOD 逐层细化，七类城市要素在 2.3 km² 内同时浮现。',
    duration: 8200,
  },
  {
    id: 'grow',
    no: '02',
    name: '拔地而起',
    title: '一次限高扫描，长出一座城',
    desc: '着色器级 maxHeight 过滤自 0 米扫到 420 米；高度渐变只叠在真实贴图上，幕墙分格与窗框始终可见。',
    duration: 9000,
  },
  {
    id: 'skeleton',
    no: '03',
    name: '数字骨骼',
    title: '把结构本身画出来',
    desc: '动态扫描着色 + GPU 棱线 + 发光线框边界盒，四类覆盖物共享同一套时间轴与深度缓冲。',
    duration: 9200,
  },
  {
    id: 'pulse',
    no: '04',
    name: '数据血脉',
    title: '让城市开始流动',
    desc: '回到有贴图的真实城市上叠飞线、范围光柱与亮部辉光，镜头推进到核心区；点击任意建筑可读取单体属性。',
    duration: 10000,
  },
  {
    id: 'panorama',
    no: '05',
    name: '全景收束',
    title: '一镜收下整座数字孪生',
    desc: '顶/侧分色以半透明方式压回原色贴图，棱线与边界框持续呼吸；所有实时指标来自真实渲染统计。',
    duration: 9000,
  },
];

export const TOTAL_DURATION = ACTS.reduce((sum, a) => sum + a.duration, 0);

/**
 * 开场预加载：遮罩还在时，把演出会走到的机位依次「隐形」跑一遍，等每个机位的
 * 瓦片请求真正收敛再撤遮罩。不这么做的话，镜头从 12.4 级俯冲到 16.85 级时
 * 才触发成百上千块精细瓦片的下载 / 建几何 / 传纹理，全挤在演出开头 → 卡顿。
 *
 * 顺序刻意「先最贵」：pulse 是 zoom 16.85 的核心区特写，LOD 链最深、瓦片最多，
 * 先把它拉下来，后面几个机位只剩视锥差异带来的少量补充请求。
 */
export const WARMUP = {
  /** 无在途请求、无新瓦片持续这么久，才算这个机位「静默」 */
  quietMs: 620,
  pollMs: 110,
  /** 每个机位至少停留这么久，给 MapLibre 渲染帧把 LOD 请求发出来 */
  minViewMs: 420,
  viewTimeoutMs: 6000,
  /** 全场预加载硬上限，网络差时不至于永远卡在遮罩 */
  totalBudgetMs: 18000,
  /** 配置解析占 0~62%，瓦片预载占 62~100% */
  startPct: 62,
  endPct: 100,
  /**
   * 只保留三个机位：pulse 是 LOD 链最深的一档，等它收敛就把整条父链拉下来了；
   * panorama 补另一侧视锥；start 收尾。grow / skeleton / awaken 都是中间层级，
   * 父瓦片已在缓存里，跑一遍纯属多花时间。
   */
  views: [
    { id: 'pulse', label: '核心区特写' },
    { id: 'panorama', label: '全景机位' },
    { id: 'start', label: '回到起点' },
  ],
  /** 进度条按「实际落地瓦片数」走的饱和尺度（块），越大爬得越慢 */
  tileScale: 300,
};
