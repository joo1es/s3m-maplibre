/**
 * 给 MapLibre 换正交投影（**实验性选配**，默认不启用）
 *
 * 背景：MapLibre v5 只提供 mercator / globe / vertical-perspective 三种投影，
 * `_setProjectionInternal` 是写死的 switch，官方明确不支持自定义 transform。
 * 所以这里不去替换 transform 类，而是在运行时**接管它的矩阵计算**：
 *
 *   Transform.calcMatrices()            ← 基类壳，只算像素相关常量
 *     └─ this._callbacks.calcMatrices() ← 固定为 `() => this._calcMatrices()`
 *          └─ MercatorTransform._calcMatrices()   ← 真正的投影矩阵链
 *
 * `_callbacks` 调的是 `this._calcMatrices()`（动态查表），所以覆盖实例上的
 * `_calcMatrices` 就能在原始计算之后把整条矩阵链按正交重算一遍。原始实现仍然
 * 照常执行——`_helper._nearZ / _farZ / _pixelPerMeter / cameraToCenterDistance`
 * 这些由它算好的中间量我们直接复用，不必自己复刻。
 *
 * ## 只改一件事：透视矩阵 → 正交矩阵
 *
 * 原链里 `n = perspective(fov, aspect, near, far)`，之后 view 变换（翻 y、后退
 * cameraToCenterDistance、roll/pitch/bearing 旋转、平移到中心）与派生矩阵都是
 * 在这一个 n 上做乘法。因此**只需要换掉 n 的构造**，其余逐字复刻即可。
 *
 * 正交矩阵取「中心平面等比」：让 z = -cameraToCenterDistance 那个平面上的点
 * 投影结果与透视完全一致。因为
 *   cameraToCenterDistance = 0.5 / tan(fov/2) * height
 * 所以这一平面上的正交缩放正好是 2/width、2/height——**中心平面上的像素就是
 * 世界单位**，瓦片边界天然落在整数像素上（这也是 deck.gl 的 OrthographicViewport
 * 的做法：`ortho(-w/2, w/2, -h/2, h/2)` + `scale = 2^zoom`）。
 *
 * ## 已知代价（选配的原因）
 *
 * - 标签避让 / 地形高程 / fog 仍按透视语义推导，正交下会有偏差；
 *   `pixelMatrix` 已一起重算，`queryRenderedFeatures` 拾取基本可用。
 * - 与 maplibre-gl 内部实现强耦合（当前验证版本 5.24.0）。升级大版本必须重跑。
 * - `setProjection()` 会重建 transform 实例，patch 会丢失，需要在
 *   `projectiontransition` 之后重新安装（见 `enableMapLibreOrtho` 返回值）。
 */
import { Matrix4 } from 'three';

/** 只依赖运行时能读到的字段，避免和 maplibre 的类型定义死磕 */
type AnyTransform = Record<string, any> & {
  center?: { lng: number; lat: number };
  worldSize?: number;
  clipSpaceToPixelsMatrix?: ArrayLike<number>;
};

export interface MapLibreOrthoOptions {
  /** 是否立即生效，默认 true */
  enabled?: boolean;
  /** 首次接管时打印一行诊断（字段是否齐全、是否生效），默认 false */
  debug?: boolean;
}

const MERCATOR_MAX_LAT = 85.051129;

/** 纬度 → mercator y（0..1，北为小） */
function mercatorY(lat: number): number {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function toMat4(m: Matrix4): Float64Array {
  return Float64Array.from(m.elements);
}

/**
 * 把 transform 上已有的矩阵链按正交重算一遍。返回 false = 本帧条件不满足，
 * 保持原始（透视）结果。
 *
 * 结构完整复刻 `MercatorTransform._calcMatrices`，唯一区别是第一步的 n。
 */
export function applyOrthoMatrices(t: AnyTransform): boolean {
  const h = t._helper;
  const width: number = h?._width;
  const height: number = h?._height;
  const near: number = h?._nearZ;
  const far: number = h?._farZ;
  const camDist: number = h?.cameraToCenterDistance;
  const ppm: number = h?._pixelPerMeter;
  const clipToPixels = t.clipSpaceToPixelsMatrix;
  const center = t.center;
  const worldSize = t.worldSize as number;

  if (
    !h ||
    !(width > 0) ||
    !(height > 0) ||
    !(camDist > 0) ||
    !(far > near) ||
    !(ppm > 0) ||
    !center ||
    !(worldSize > 0) ||
    !clipToPixels
  ) {
    return false;
  }

  const offset = t.centerOffset ?? { x: 0, y: 0 };
  const elevation: number = t.elevation ?? 0;
  // 注意单位：`_viewProjMatrix` / `_pixelMatrix` 吃的是**像素空间**（mercator ×
  // worldSize），不是 0..1 的 mercator —— 证据是 `_mercatorMatrix = viewProj ×
  // scale(worldSize)`，那份才是给 0..1 输入用的。写成 0..1 时中心点仍然正确
  // （偏差被平移到中心抵消），所以容易漏，但所有偏移量都会错 worldSize 倍。
  const mx = ((center.lng + 180) / 360) * worldSize;
  const my = mercatorY(center.lat) * worldSize;

  // ---- 唯一改动处：正交而非透视 ----------------------------------------
  // 标准 ortho，x/y 缩放 2/w、2/h 保证中心平面与透视完全重合（见文件头）。
  // centerOffset 在正交下是平移（透视里是 n[8]/n[9] 的 z 项），这里落到 12/13 位。
  const n = new Matrix4().set(
    2 / width,
    0,
    0,
    (-2 * offset.x) / width,
    0,
    2 / height,
    0,
    (2 * offset.y) / height,
    0,
    0,
    -2 / (far - near),
    -(far + near) / (far - near),
    0,
    0,
    0,
    1
  );
  // `projectionMatrix` 只含投影本身（不含 view），后面 view 链另算
  const projection = n.clone();

  // ---- 以下逐字复刻 MapLibre 的 view 链（都是右乘 = three 的 multiply）----
  n.multiply(new Matrix4().makeScale(1, -1, 1));
  n.multiply(new Matrix4().makeTranslation(0, 0, -camDist));
  n.multiply(new Matrix4().makeRotationZ(-(t.rollInRadians ?? 0)));
  n.multiply(new Matrix4().makeRotationX(t.pitchInRadians ?? 0));
  n.multiply(new Matrix4().makeRotationZ(-(t.bearingInRadians ?? 0)));
  n.multiply(new Matrix4().makeTranslation(-mx, -my, 0));

  const mercatorMatrix = n.clone().multiply(new Matrix4().makeScale(worldSize, worldSize, worldSize));

  const pixelView = n.clone().multiply(new Matrix4().makeScale(1, 1, ppm));
  const pixelMatrix = new Matrix4().fromArray(clipToPixels as number[]).multiply(pixelView);

  // 像素矩阵之后还要沿相机 z 抬高 elevation，得到真正喂给渲染的 viewProj
  const viewProj = n.clone().multiply(new Matrix4().makeTranslation(0, 0, -elevation));
  const pixelMatrix3D = new Matrix4().fromArray(clipToPixels as number[]).multiply(viewProj);

  // 对齐版：抵消半像素偏移，避免符号层抖动
  const halfW = (width % 2) / 2;
  const halfH = (height % 2) / 2;
  const cosB = Math.cos(t.bearingInRadians ?? 0);
  const sinB = Math.sin(-(t.bearingInRadians ?? 0));
  const sx = mx - Math.round(mx) + cosB * halfW + sinB * halfH;
  const sy = my - Math.round(my) + cosB * halfH + sinB * halfW;
  const aligned = viewProj
    .clone()
    .multiply(new Matrix4().makeTranslation(sx > 0.5 ? sx - 1 : sx, sy > 0.5 ? sy - 1 : sy, 0));

  const invViewProj = viewProj.clone().invert();
  const pixelMatrixInverse = pixelMatrix.clone().invert();

  // ---- 写回（字段名与 maplibre-gl@5.24 一致）-----------------------------
  t._projectionMatrix = toMat4(projection);
  t._invProjMatrix = toMat4(projection.clone().invert());
  t._mercatorMatrix = toMat4(mercatorMatrix);
  t._pixelMatrix = toMat4(pixelMatrix);
  t._pixelMatrix3D = toMat4(pixelMatrix3D);
  t._viewProjMatrix = toMat4(viewProj);
  t._invViewProjMatrix = toMat4(invViewProj);
  t._alignedProjMatrix = toMat4(aligned);
  t._pixelMatrixInverse = toMat4(pixelMatrixInverse);
  t._cameraPosition = unprojectCamera(invViewProj);

  t._clearMatrixCaches?.();
  return true;
}

/** clip 空间 (0,0,-1,1) 经逆 viewProj 反投影得到相机世界坐标 */
function unprojectCamera(invViewProj: Matrix4): [number, number, number] {
  const e = invViewProj.elements;
  // (x, y, z, w) = (0, 0, -1, 1) → 每行只剩 e[8]、e[12] 两项
  const x = -e[8] + e[12];
  const y = -e[9] + e[13];
  const z = -e[10] + e[14];
  const w = -e[11] + e[15] || 1;
  return [x / w, y / w, z / w];
}

/**
 * 在指定地图上安装正交投影接管。返回一个「重新安装」函数：
 * `setProjection()` 会重建 transform，之后需要调用它补上 patch。
 */
export function enableMapLibreOrtho(
  map: { transform?: unknown },
  options: MapLibreOrthoOptions = {}
): { setEnabled: (on: boolean) => void; reinstall: () => void; dispose: () => void } {
  let enabled = options.enabled ?? true;

  const install = (): void => {
    const t = map.transform as AnyTransform | null;
    if (!t || typeof t._calcMatrices !== 'function') {
      console.warn('[s3m] 当前 maplibre 版本没有可接管的 _calcMatrices，正交不可用');
      return;
    }
    const state = (t as any).__s3mOrtho as { enabled: boolean; orig: () => void } | undefined;
    if (state) {
      state.enabled = enabled;
      return;
    }
    const orig = t._calcMatrices.bind(t);
    (t as any).__s3mOrtho = { enabled, orig };
    t._calcMatrices = function (this: AnyTransform) {
      orig();
      const on = (this as any).__s3mOrtho?.enabled;
      const ok = on ? applyOrthoMatrices(this) : false;
      const dbg = (this as any).__s3mOrtho;
      if (on && options.debug && !dbg.reported) {
        dbg.reported = true;
        // 只在首次生效/失败时打一行，方便确认接管是否真的装上
        console.info(
          `[s3m] MapLibre 正交接管 ${ok ? '已生效' : '未生效'} · helper=${!!this._helper} ` +
            `ws=${this.worldSize} size=${this._helper?._width}x${this._helper?._height} ` +
            `camDist=${this._helper?.cameraToCenterDistance} ppm=${this._helper?._pixelPerMeter} ` +
            `near=${this._helper?._nearZ} far=${this._helper?._farZ} clip=${!!this.clipSpaceToPixelsMatrix}`
        );
      }
    };
  };

  install();

  return {
    setEnabled: (on: boolean) => {
      enabled = on;
      const t = map.transform as AnyTransform | null;
      const state = t && (t as any).__s3mOrtho;
      if (state) state.enabled = on;
      else install();
      // 矩阵是惰性的：只有 transform 变化（pan/zoom/pitch）时才重算，开关切换本身
      // 不会触发。这里主动跑一次，否则「打开正交」要等用户拖一下地图才看得到效果。
      const tt = map.transform as AnyTransform | null;
      if (typeof tt?._calcMatrices === 'function') tt._calcMatrices();
      (map as any).triggerRepaint?.();
    },
    reinstall: () => install(),
    dispose: () => {
      const t = map.transform as AnyTransform | null;
      const state = t && (t as any).__s3mOrtho;
      if (t && state) {
        t._calcMatrices = state.orig;
        delete (t as any).__s3mOrtho;
        (map as any).triggerRepaint?.();
      }
    },
  };
}
