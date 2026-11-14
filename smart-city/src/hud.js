/**
 * HUD：把演出状态与真实渲染统计投到大屏上。
 *
 * 这里只读 DOM、不碰三维对象；所有交互回调由 main.js 注入。
 * 数字滚动、FPS 曲线、能力清单高亮都属于「演示层」，和渲染内核完全解耦。
 */
import { ACTS, CAPABILITIES, KPIS, BARS, DATASETS, TOTAL_DURATION } from './config.js';

const $ = (id) => document.getElementById(id);
const num = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : Math.round(n ?? 0).toLocaleString('zh-CN'));

const METRICS = [
  ['fps', '帧率', 'FPS'],
  ['tiles', '可见瓦片', ''],
  ['tris', '三角面', ''],
  ['draws', 'Draw Call', ''],
  ['programs', '着色程序', ''],
  ['textures', '纹理', ''],
  ['meshes', '网格', ''],
  ['datasets', '数据集', ''],
];

const ICON_PAUSE = '<path d="M4 3 L7 3 L7 13 L4 13 Z M9 3 L12 3 L12 13 L9 13 Z" fill="currentColor" />';
const ICON_PLAY = '<path d="M5 3 L12 8 L5 13 Z" fill="currentColor" />';

export class Hud {
  constructor(handlers) {
    this.h = handlers;
    this.fpsHistory = new Array(64).fill(0);
    this.statsCache = {};
    this._build();
    this._bind();
    this._startClock();
    this._numbersPlayed = false;
  }

  /* ------------------------------------------------------------ 构建静态结构 */

  _build() {
    $('acts').innerHTML = ACTS.map(
      (a, i) => `<button class="act" data-i="${i}" type="button">
        <span class="act-no">${a.no}</span>
        <span class="act-name">${a.name}</span>
        <span class="act-dur">${(a.duration / 1000).toFixed(0)}s</span>
        <span class="act-bar" style="width:0"></span>
      </button>`
    ).join('');

    $('tlNodes').innerHTML = ACTS.map(
      (a, i) => `<span class="tl-node" data-i="${i}" title="${a.name}">${a.no} ${a.name}</span>`
    ).join('');

    $('renderMetrics').innerHTML = METRICS.map(
      ([k, label, unit]) => `<div class="metric"><label>${label}</label><b id="m-${k}">—</b>${unit ? `<small>${unit}</small>` : ''}</div>`
    ).join('');

    $('kpis').innerHTML = KPIS.map(
      (k) => `<div class="kpi"><label>${k.label}</label><b id="k-${k.id}">0</b><small>${k.unit}</small></div>`
    ).join('');

    $('bars').innerHTML = BARS.map(
      (b) => `<div class="bar-row"><span>${b.label}</span><div class="bar-track"><div class="bar-fill" id="b-${b.id}"></div></div><span id="bv-${b.id}">0%</span></div>`
    ).join('');

    $('caps').innerHTML = CAPABILITIES.map(
      (c) => `<li class="cap" data-id="${c.id}"><i></i>${c.label}</li>`
    ).join('');
  }

  _bind() {
    $('acts').addEventListener('click', (e) => {
      const btn = e.target.closest('.act');
      if (btn) this.h.onSeek(Number(btn.dataset.i));
    });
    $('tlNodes').addEventListener('click', (e) => {
      const el = e.target.closest('.tl-node');
      if (el) this.h.onSeek(Number(el.dataset.i));
    });

    $('btnPrev').addEventListener('click', () => this.h.onPrev());
    $('btnNext').addEventListener('click', () => this.h.onNext());
    $('btnPlay').addEventListener('click', () => this.h.onPlayToggle());
    $('btnReplay').addEventListener('click', () => this.h.onReplay());
    $('btnLoop').addEventListener('click', () => this.h.onLoopToggle());
    $('btnFree').addEventListener('click', () => this.h.onFreeToggle());

    $('featureCard').addEventListener('click', (e) => {
      if (e.target.dataset.close !== undefined) this.hideFeature();
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); this.h.onPlayToggle(); }
      else if (e.key === 'ArrowRight') this.h.onNext();
      else if (e.key === 'ArrowLeft') this.h.onPrev();
      else if (e.key.toLowerCase() === 'r') this.h.onReplay();
    });
  }

  /* ------------------------------------------------------------ 时钟 / 数字 */

  _startClock() {
    const tick = () => {
      const d = new Date();
      $('clock').textContent = d.toLocaleTimeString('zh-CN', { hour12: false });
      $('date').textContent = `${d.toLocaleDateString('zh-CN')}  ·  UTC+8`;
    };
    tick();
    setInterval(tick, 1000);
  }

  /** 城市体征数字从 0 滚到目标值。等开场遮罩撤了再跑，否则用户看不见 */
  _animateNumbers() {
    if (this._numbersPlayed) return;
    this._numbersPlayed = true;
    const t0 = performance.now();
    const dur = 1800;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      for (const k of KPIS) {
        const v = k.value * e;
        $('k-' + k.id).textContent = k.id === 'iot' || k.id === 'bldg'
          ? Math.round(v).toLocaleString('zh-CN')
          : v.toFixed(k.digits);
      }
      for (const b of BARS) {
        const v = b.value * e;
        $('b-' + b.id).style.width = `${v}%`;
        $('bv-' + b.id).textContent = `${Math.round(v)}%`;
      }
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------ 演出状态 */

  setAct(index) {
    const a = ACTS[index];
    $('actIdx').innerHTML = `${a.no}<span>/ 0${ACTS.length}</span>`;
    $('actTitle').textContent = a.title;
    $('actDesc').textContent = a.desc;
    const body = document.querySelector('.caption-body');
    body.classList.remove('fade');
    void body.offsetWidth; // 强制重排，重放淡入动画
    body.classList.add('fade');

    document.querySelectorAll('.act').forEach((el, i) => {
      el.classList.toggle('active', i === index);
      el.classList.toggle('done', i < index);
      if (i > index) el.querySelector('.act-bar').style.width = '0';
      if (i < index) el.querySelector('.act-bar').style.width = '100%';
    });
    document.querySelectorAll('.tl-node').forEach((el, i) => el.classList.toggle('active', i === index));

    document.querySelectorAll('.cap').forEach((el) => {
      const cap = CAPABILITIES.find((c) => c.id === el.dataset.id);
      el.classList.toggle('lit', !!cap?.acts.includes(a.id));
    });
  }

  /** @param {number} global 0..1 全场进度  @param {number} local 0..1 本幕进度 */
  setProgress(global, index, local) {
    const pct = `${(global * 100).toFixed(3)}%`;
    $('tlFill').style.width = pct;
    $('tlHead').style.left = pct;
    const bar = document.querySelectorAll('.act')[index]?.querySelector('.act-bar');
    if (bar) bar.style.width = `${(local * 100).toFixed(1)}%`;
  }

  setPlaying(on) {
    $('playIcon').innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    $('playText').textContent = on ? '暂停' : '播放';
  }

  setLoop(on) {
    $('btnLoop').textContent = on ? '循环 ON' : '循环 OFF';
    $('btnLoop').classList.toggle('on', on);
  }

  setFree(on) {
    $('btnFree').classList.toggle('on', on);
    $('btnFree').textContent = on ? '退出自由视角' : '自由视角';
  }

  /* ------------------------------------------------------------ 实时统计 */

  setStats(s) {
    const v = {
      fps: s.fps ?? 0,
      tiles: s.tiles ?? 0,
      tris: s.triangles ?? 0,
      draws: s.drawCalls ?? 0,
      programs: s.programs ?? 0,
      textures: s.textures ?? 0,
      meshes: s.meshes ?? 0,
      datasets: s.datasets ?? 0,
    };
    this.statsCache = v;
    $('m-fps').textContent = v.fps ? Math.round(v.fps) : '—';
    $('m-tiles').textContent = num(v.tiles);
    $('m-tris').textContent = num(v.tris);
    $('m-draws').textContent = num(v.draws);
    $('m-programs').textContent = num(v.programs);
    $('m-textures').textContent = num(v.textures);
    $('m-meshes').textContent = num(v.meshes);
    $('m-datasets').textContent = `${v.datasets}/${DATASETS.length}`;
    $('fpsNow').textContent = v.fps ? `${Math.round(v.fps)} FPS` : '—';
  }

  pushFps(fps) {
    this.fpsHistory.push(fps || 0);
    if (this.fpsHistory.length > 64) this.fpsHistory.shift();
    this._drawSpark();
  }

  _drawSpark() {
    const c = $('fpsSpark');
    const ctx = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(84,190,235,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const y = (h / 3) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const data = this.fpsHistory;
    const max = 70;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(74,216,255,0.42)');
    grad.addColorStop(1, 'rgba(74,216,255,0)');

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - Math.min(v, max) / max * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - Math.min(v, max) / max * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = '#4ad8ff'; ctx.lineWidth = 1.4; ctx.stroke();
  }

  setStatus(text, kind = '') {
    $('statusText').textContent = text;
    $('statusDot').className = `dot ${kind}`;
  }

  /* ------------------------------------------------------------ 属性卡 */

  showFeature(f) {
    const rows = [
      ['数据集', f.datasetName ?? '—'],
      ['SMID', f.smid ?? '—'],
      ['建筑高度', f.height != null ? `${f.height.toFixed(1)} m` : '—'],
      ['估算楼层', f.floors ?? '—'],
      ['基底高程', f.baseElevation != null ? `${f.baseElevation.toFixed(1)} m` : '—'],
      ['底面积', f.bboxArea != null ? `${Math.round(f.bboxArea).toLocaleString('zh-CN')} ㎡` : '—'],
      ['三角面', f.triangles != null ? num(f.triangles) : '—'],
    ];
    $('featureCard').innerHTML = `
      <div class="fc-hd"><span>BUILDING / ${f.smid ?? '—'}</span><span data-close="1">×</span></div>
      ${rows.map(([k, v]) => `<div class="fc-row"><span>${k}</span><b>${v}</b></div>`).join('')}
      <div class="fc-note">来自 S3M 单体化信息，由 GPU 拾取直接反解。</div>`;
    $('featureCard').classList.add('on');
  }

  hideFeature() {
    $('featureCard').classList.remove('on');
  }

  /* ------------------------------------------------------------ 开场 / 提示 */

  setLoading(step, pct, err = '') {
    $('loadStep').textContent = step;
    $('loadFill').style.width = `${Math.max(3, Math.min(100, pct))}%`;
    $('loadErr').textContent = err;
  }

  hideLoading() {
    $('loading').classList.add('off');
    // 遮罩淡出要 1s，稍等半拍再滚数字，正好接上镜头俯冲
    setTimeout(() => this._animateNumbers(), 420);
  }

  toast(msg, ms = 2200) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }

  get totalDuration() { return TOTAL_DURATION; }
}
