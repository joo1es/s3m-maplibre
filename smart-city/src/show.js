/**
 * 演出编排：一条时间轴驱动五幕，镜头、着色、过滤与特效在幕边界切换。
 *
 * 两条规矩：
 * 1. 相机只走 MapLibre 的 easeTo / flyTo。绝不去 tween viewer.camera —— 宿主每帧会
 *    用矩阵覆盖它，抖起来很难查（API.md「相机动画」）。
 * 2. 连续量（限高、辉光强度）走节流调用，离散量（换幕、开棱线、加特效）只在
 *    enter / exit 里调一次。setStyle / setFilter 内部会触发重绘，不必另开帧循环。
 *
 * 这条 rAF 只管「演出时钟」，不负责渲染：地图的重绘由内核 animator 与各 setter 自己喊。
 */
import { STYLE } from 's3m-maplibre';
import { ACTS, CAMERA, CITY, THEME, TOTAL_DURATION } from './config.js';

/** 幕切换时统一用的颜色过渡，避免硬切 */
const COLOR_TWEEN = { duration: 620, easing: 'easeInOutCubic' };

export class Show {
  constructor({ map, layer, effects, hud }) {
    this.map = map;
    this.layer = layer;
    this.fx = effects;
    this.hud = hud;

    this.playing = false;
    this.loop = true;
    this.free = false;
    this.elapsed = 0;
    this.actIndex = 0;
    this._last = 0;
    this._lastFilter = 0;
    this._lastGlow = 0;
    this._entered = -1;
    this._running = false;
    this._frame = this._frame.bind(this);

    // 用户真的拖了地图就交出镜头控制权；程序发起的 easeTo 不带 originalEvent
    map.on('movestart', (e) => {
      if (e.originalEvent && this.playing && !this.free) {
        this.setFree(true);
        this.hud.toast('已切到自由视角 · 点「退出自由视角」继续巡游');
      }
    });
  }

  /* ------------------------------------------------------------ 播放控制 */

  /**
   * 全局只允许一条 rAF 链。
   * _frame 每帧都会自己续一帧，start/play/replay/seek 若各自再 request 一次，
   * 重播几轮就会叠出好几条链，elapsed 每帧被累加多次，演出越放越快。
   */
  _ensureLoop() {
    if (this._running) return;
    this._running = true;
    requestAnimationFrame(this._frame);
  }

  start() {
    this._resetVisuals();
    this.elapsed = 0;
    this.actIndex = 0;
    this._entered = -1;
    this._enterAct(0, 0);
    this.playing = true;
    this._last = performance.now();
    this.hud.setPlaying(true);
    this._ensureLoop();
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._last = performance.now();
    // 暂停时 map.stop() 掐掉了镜头补间，续播时按剩余时长重新发一次
    const remain = ACTS[this.actIndex].duration - this._actElapsed();
    this._cameraTo(ACTS[this.actIndex].id, remain);
    this.hud.setPlaying(true);
    this._ensureLoop();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.map.stop();
    this.hud.setPlaying(false);
  }

  togglePlay() { this.playing ? this.pause() : this.play(); }

  setLoop(on) { this.loop = on; this.hud.setLoop(on); }

  setFree(on) {
    this.free = on;
    this.hud.setFree(on);
    if (on) this.pause();
    else this.play();
  }

  next() { this.seek(Math.min(ACTS.length - 1, this.actIndex + 1)); }
  prev() { this.seek(Math.max(0, this.actIndex - 1)); }

  replay() {
    this.map.stop();
    this._resetVisuals();
    this.elapsed = 0;
    this.actIndex = 0;
    this._entered = -1;
    this._enterAct(0, 0);
    this.playing = true;
    this._last = performance.now();
    this.hud.setPlaying(true);
    this._ensureLoop();
    this.hud.toast('演出重新开始');
  }

  /** 跳幕：先把持久状态复位，再补齐目标幕应有的前置效果 */
  seek(index) {
    if (index < 0 || index >= ACTS.length) return;
    this.map.stop();
    this._resetVisuals();
    this.elapsed = ACTS.slice(0, index).reduce((s, a) => s + a.duration, 0);
    this.actIndex = index;
    this._entered = -1;
    this._enterAct(index, 0);
    this.hud.setAct(index);
    this.hud.setProgress(this.elapsed / TOTAL_DURATION, index, 0);
    if (!this.playing) {
      this.playing = true;
      this._last = performance.now();
      this.hud.setPlaying(true);
      this._ensureLoop();
    }
  }

  /* ------------------------------------------------------------ 主循环 */

  _actStart(index) {
    let t = 0;
    for (let i = 0; i < index; i++) t += ACTS[i].duration;
    return t;
  }

  _actElapsed() { return this.elapsed - this._actStart(this.actIndex); }

  _frame(now) {
    requestAnimationFrame(this._frame);
    const dt = Math.min(120, now - this._last);
    this._last = now;
    if (!this.playing || this.free) return;

    this.elapsed += dt;

    // 跨幕（快进时会一次跨多幕）
    let guard = 0;
    while (this.elapsed >= this._actStart(this.actIndex) + ACTS[this.actIndex].duration && guard++ < 8) {
      if (this.actIndex === ACTS.length - 1) {
        if (this.loop) { this.replay(); return; }
        this.elapsed = TOTAL_DURATION;
        this.pause();
        this.hud.setProgress(1, ACTS.length - 1, 1);
        return;
      }
      this._exitAct(this.actIndex);
      this.elapsed = this._actStart(this.actIndex + 1);
      this.actIndex += 1;
      this._enterAct(this.actIndex, 0);
    }

    const local = Math.min(1, this._actElapsed() / ACTS[this.actIndex].duration);
    this._tickAct(this.actIndex, local, now);
    this.hud.setProgress(this.elapsed / TOTAL_DURATION, this.actIndex, local);
  }

  /* ------------------------------------------------------------ 视觉复位 */

  _resetVisuals() {
    this.fx.clearAll();
    this.layer.setEdges(false);
    this.layer.clearFilter();
    this.layer.setOpacity(1);
    // 一律回到原色：贴图、顶点色、玻璃幕墙都还在，科技配色只作为叠加层出现
    this.layer.setStyle({
      mode: STYLE.TEXTURE,
      texMix: 0,
      ambientGain: 0,
      edgeOpacity: 0,
      opacity: 1,
    });
    this.map.jumpTo(CAMERA.start);
  }

  /**
   * 跳幕时补前置状态。所有 add* 都是幂等的（Effects 里有 guard），
   * 所以自然推进和手动跳幕可以走同一条路径。
   */
  _applyPersistentState(index) {
    const id = ACTS[index].id;
    if (id === 'skeleton' || id === 'pulse' || id === 'panorama') {
      this.layer.setEdges('gpu');
      this.layer.setStyle({ edgeColor: THEME.cyanSoft, edgeWidth: 1.35, edgeOpacity: 0.42 });
      this.fx.addCube();
    }
    // 跳幕时补齐目标幕该有的底色；texMix > 0 时内核会把配色与原始贴图相乘，
    // 窗框 / 幕墙分格仍在（StyleMaterial.FRAG_COLOR 的 uTexMix 分支）
    if (id === 'grow') this.layer.setStyle({ mode: STYLE.HEIGHT, texMix: 0.7 });
    if (id === 'skeleton') this.layer.setStyle({ mode: STYLE.DYNAMIC, texMix: 0.55 });
    if (id === 'panorama') this.layer.setStyle({ mode: STYLE.CUSTOM, texMix: 0.7 });
    if (id === 'pulse') {
      this.layer.setStyle({ mode: STYLE.TEXTURE, texMix: 0, ambientGain: 0.1 });
      this.fx.enableBloom();
      this.fx.addFlows();
      this.fx.addBeacons();
    }
  }

  /* ------------------------------------------------------------ 镜头 */

  _cameraTo(id, duration) {
    const cam = CAMERA[id];
    if (!cam) return;
    const opts = { ...cam, duration: Math.max(800, duration), essential: true };
    // 推进到核心区用 flyTo，弧线俯冲比 easeTo 更有镜头感
    if (id === 'pulse') this.map.flyTo(opts);
    else this.map.easeTo(opts);
  }

  /* ------------------------------------------------------------ 五幕 */

  _enterAct(index, local) {
    if (this._entered === index) return;
    this._entered = index;
    const a = ACTS[index];
    this.hud.setAct(index);
    this._applyPersistentState(index);
    this._cameraTo(a.id, a.duration * 0.94);

    switch (a.id) {
      case 'awaken': {
        // 俯冲拖影：afterimage 几乎零成本，静止时残影会自己收敛，不会糊住画面
        this.layer.setMotionBlur({ mode: 'afterimage', damp: 'auto' });
        // 首屏要的是「真实城市」，不是白模：原色 + 轻微自发光，只让贴图通透一点
        this.layer.setStyle({
          mode: STYLE.TEXTURE,
          texMix: 0,
          ambientGain: 0.08,
          fadeIn: 900,
        }, COLOR_TWEEN);
        // 整层从全透明渐现，交给内核 animator 补间，不自己逐帧写 uniform
        this.layer.setOpacity(0);
        this.layer.setOpacity(1, { duration: 3000, easing: 'easeOutCubic' });
        break;
      }
      case 'grow': {
        // 按高度渐变「叠」在贴图上：颜色取亮一档，避免 texMix 的乘积压暗幕墙
        this.layer.setStyle({
          mode: STYLE.HEIGHT,
          colorA: '#69c8ff',
          colorB: '#ffd79a',
          colorC: THEME.cyanSoft,
          texMix: 0.7,
          ambientGain: 0.04,
        }, COLOR_TWEEN);
        this.layer.setFilter({ maxHeight: 0 });
        this.fx.addScanWave().setOpacity(1);
        break;
      }
      case 'skeleton': {
        // 这一幕才抽象化：动态扫描 + 棱线，但仍保留 55% 的贴图分格
        this.layer.setStyle({
          mode: STYLE.DYNAMIC,
          colorA: '#2a6ea8',
          colorB: '#7fe4ff',
          colorC: '#ffd79a',
          texMix: 0.55,
          ambientGain: 0.06,
        }, COLOR_TWEEN);
        this.layer.setEdges('gpu', { duration: 900 });
        break;
      }
      case 'pulse': {
        // 真实材质 + 辉光/飞线/光柱：让有纹理的城市自己发光，比白模更有说服力
        this.layer.setStyle({
          mode: STYLE.TEXTURE,
          texMix: 0,
          ambientGain: 0.14,
        }, COLOR_TWEEN);
        break;
      }
      case 'panorama': {
        this.layer.setStyle({
          mode: STYLE.CUSTOM,
          colorA: '#eaf7ff',
          colorB: '#4ba7e8',
          colorC: '#ffd79a',
          texMix: 0.7,
          ambientGain: 0.03,
          edgeOpacity: 0.42,
        }, COLOR_TWEEN);
        break;
      }
    }
  }

  _exitAct(index) {
    switch (ACTS[index].id) {
      case 'awaken':
        this.layer.setMotionBlur(null);
        break;
      case 'grow':
        this.layer.clearFilter();
        this.fx.removeScanWave();
        break;
      case 'pulse':
        this.fx.disableBloom();
        this.fx.removeFlows();
        this.fx.removeBeacons();
        break;
      case 'panorama':
        // 循环回第一幕之前把上一轮留下的覆盖物全收掉
        this.fx.clearAll();
        this.layer.setEdges(false, { duration: 400 });
        break;
    }
  }

  _tickAct(index, local, now) {
    const id = ACTS[index].id;
    if (id === 'grow') {
      // 限高扫描：setFilter 会 markOverridesDirty，逐帧调太浪费，按 ~25fps 节流
      if (now - this._lastFilter > 40) {
        this._lastFilter = now;
        this.layer.setFilter({ maxHeight: Math.max(0.5, CITY.maxHeight * local) });
      }
      this.fx.scan?.setProgress(local);
    } else if (id === 'skeleton' && now - this._lastGlow > 140) {
      // 边界盒自身有 update 驱动流光，这里只慢速呼吸一下整体强度
      this._lastGlow = now;
      this.fx.glowCube?.setGlow(0.52 + 0.16 * Math.sin(local * Math.PI * 3));
    } else if (id === 'pulse' && now - this._lastGlow > 180) {
      this._lastGlow = now;
      this.fx.bloom?.setStrength(1.25 + 0.35 * Math.sin(local * Math.PI));
    }
  }
}
