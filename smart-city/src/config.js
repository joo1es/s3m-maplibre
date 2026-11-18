/**
 * 演出用的静态配置：数据、配色、镜头关键帧、章节元数据。
 *
 * 这里不放任何运行时状态，改数值就能改演出节奏，不用翻逻辑代码。
 */

/** SuperMap Online 公有服务：北京 CBD，7 个图层叠起来才是完整城市 */
export const SERVICE = 'https://www.supermapol.com/realspace/services/3D-CBD-2/rest/realspace/datas';

/**
 * 七个图层一个都不能少 —— 少一层地面就是镂空，观众一眼能看出来。
 *
 * 但「都在」不等于「都按同一精度加载」。`lodRangeScale` 是每块瓦片的细化门槛：
 * 1 = 原口径，越大越倾向保留粗模（少下几级子瓦片）。地面 / 铺装 / 植被 / 水系
 * 这类大面积铺底的东西，本来就没人盯着看细节，却最吃瓦片数 —— 给它们一个偏大的
 * 值，画面完整度不变，加载量和三角面能砍掉一大半。
 *
 * `tiles` 是该数据集的常驻瓦片预算，同样只影响后面几级细化。
 */
export const DATASETS = [
  { id: 'Building@CBD', label: '建筑', accent: '#4ad8ff', lodRangeScale: 1.15, tiles: 280 },
  { id: 'Xiaopin@CBD', label: '城市小品', accent: '#ffc86b', lodRangeScale: 1.9, tiles: 96 },
  { id: 'Ground2@CBD', label: '铺装', accent: '#5ce6b0', lodRangeScale: 2.4, tiles: 80 },
  { id: 'Tree@CBD', label: '植被', accent: '#7ee787', lodRangeScale: 2.2, tiles: 96 },
  { id: 'Lake@CBD', label: '水系', accent: '#5aa9ff', lodRangeScale: 2.6, tiles: 40 },
  { id: 'Bridge@CBD', label: '桥梁', accent: '#ff79c6', lodRangeScale: 2.0, tiles: 56 },
  { id: 'Ground@CBD', label: '地面', accent: '#8fa6bf', lodRangeScale: 1.6, tiles: 160 },
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
 * 开场预加载：**把演出五个机位都过一遍**，让要用的瓦片在遮罩后面就下完。
 *
 * 演进过程：最早只预热 awaken 一个机位，理由是「官方 demo 也是边看边细化」。
 * 实际效果是演出自己推镜头时，每跨一个 LOD 档就有一批瓦片同时进场景 ——
 * 纹理上传 + program 首次编译全是同步的，正好卡在动画最显眼的时候
 * （实测每 2~3 秒一次 60~130ms，最长 880ms，且全部发生在镜头飞行中）。
 *
 * 既然这些瓦片**无论如何都要下**，不如在遮罩里多等一会儿：用户看到的是
 * 一条进度条，而不是演出一顿一顿。代价是首屏多等十几秒 ——
 * 遮罩随时可以点击 / Esc 跳过，`?warmMs=` 也能改上限。
 *
 * 每个机位单独计 `readyTiles`（不是全局累计），否则第一个机位达标之后
 * 后面的机位会瞬间「已覆盖」，等于没预热。
 */
export const WARMUP = {
  /**
   * 首屏累计落地这么多瓦片就撤遮罩（**每个机位各自计**）。
   * 110 块约覆盖 7 个数据集的粗/中层；再高的精度交给幕间停留时补，
   * 但演出中相机动起来时不再往场景里塞瓦片（见内核的提交闸门）。
   */
  readyTiles: 110,
  /** 增长停滞这么久也算首屏稳定（网络快时的提前退出） */
  quietMs: 320,
  pollMs: 100,
  /** 低于这个在途数视为空闲，只作诊断字段，不参与退出判定 */
  busyThreshold: 4,
  /** 单次轮询新增瓦片不超过这个数也算「停滞」 */
  growthTolerance: 1,
  /** 至少渲这么多毫秒，保证 LOD 请求真的发出去了 */
  minWarmMs: 800,
  minViewMs: 300,
  /**
   * 全场预加载硬上限。**不要无脑加大**：实测把遮罩拖到 50 秒、瓦片从 300 涨到 441 之后，
   * 演出期慢帧占比反而从 4.1% 升到 18.6% —— 场景越大，每次提交/上传的单帧成本越高，
   * 而演出机位是连续扫过的，LOD 只认当前视锥，提前加载别的机位补不到它的路径。
   * `?warmMs=` 可现场覆盖。
   */
  totalBudgetMs: 12000,
  /** 单个机位的最长等待；到点没达标就进下一个机位（五个机位 × 3s 正好吃满 12s 预算） */
  viewTimeoutMs: 3000,
  /** 配置解析占 0~64%，瓦片预热占 64~100% */
  startPct: 64,
  endPct: 100,
  /**
   * 依次预热的机位：演出五幕的落点，一个不落。
   *
   * 顺序按演出先后排，进度条也就跟着演出走 —— 提前撤遮罩时先看得到前几幕的精度。
   * 想只等首屏（比如调试）就用 `?warmMs=3000`，或者直接点遮罩跳过。
   */
  views: [
    { id: 'awaken', label: '城市唤醒' },
    { id: 'grow', label: '拔地而起' },
    { id: 'skeleton', label: '数字骨骼' },
    { id: 'pulse', label: '数据血脉' },
    { id: 'panorama', label: '全景收束' },
  ],
};
