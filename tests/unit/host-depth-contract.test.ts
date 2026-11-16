/**
 * 宿主深度契约：Mapbox GL v3 在调用自定义图层之前会主动把深度测试关掉、且不清深度缓冲。
 *
 * 证据（mapbox-gl 3.35 dist，custom 图层的 translucent 分支）：
 *
 *   o.setDepthMode(e.a3.disabled),      // 调用实现之前：DepthMode.disabled
 *   o.setStencilMode(e.a4.disabled),
 *   o.setColorMode(t.colorModeForRenderPass()),
 *   t.setCustomLayerDefaults();
 *   i.call(n, o.gl, a, l)               // ← 我们的 render()
 *
 * 而 MapLibre 的自定义层走 painter 的 pass，深度由 painter 管理，`depthMode: 'scene'`
 * （不清深度、与已有深度混合）在那个契约下成立。
 *
 * 在 Mapbox 上沿用 'scene' 的后果：three 会把 DEPTH_TEST 打开，拿一个**本层从未初始化**的
 * 深度缓冲去比 LEQUAL —— 缓冲里是 1.0 就全可见，是残留值就斑驳、部分被遮挡、甚至整片被吃掉。
 *
 * **0.4.42 起不再自动切 `'clear'`**：自动切会连带清掉底图/地形深度、并让 GPU 描边整段跳过；
 * 而当初触发它的"模型消失"实测根因是渲染矩阵多乘了一次 `T(−camEnu)`（camEnu 非零的宿主
 * 上模型整体出画），与深度无关。现在只识别 + 只告警一次，选择权交回使用者。
 *
 * 四条不变式：
 *   1. MapLibre 路径完全不变（签名不含 renderParameters 时不碰 depthMode）；
 *   2. 判据不猜：`depthMode` 在任何签名下都不会被本方法改写；
 *   3. 用户显式设过 depthMode 就永远以用户为准（构造参数或 setDepthMode）；
 *   4. 只判定一次，之后每帧不再重复。
 */
import { describe, expect, test } from 'bun:test';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';

const asAny = (v: unknown) => v as any;

/** MapLibre v5 的 render 第 2 参：对象，含 modelViewProjectionMatrix */
const MAPLIBRE_ARG = {
  farZ: 1e7,
  nearZ: 10,
  fov: 0.6435,
  modelViewProjectionMatrix: new Float64Array(16),
  projectionMatrix: new Float64Array(16),
  defaultProjectionData: { mainMatrix: new Float64Array(16) },
};

/** Mapbox v3.32+ 的签名：第 2 参是裸矩阵，第 8 参（rest[5]）是 renderParameters */
const MAPBOX_MATRIX = new Float64Array(16);
const MAPBOX_REST = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  { projectionMatrix: new Float64Array(16), viewMatrix: new Float64Array(16) },
];

describe('Mapbox v3 的 render 签名 → 只识别 + 告警，不改 depthMode', () => {
  test('默认（scene）在 Mapbox 签名下保持 scene：不静默清深度', () => {
    const layer = new S3MLayer({ id: 's3m' });
    expect(layer.depthMode).toBe('scene');

    asAny(layer)._syncHostDepthContract(MAPBOX_MATRIX, MAPBOX_REST);

    expect(layer.depthMode).toBe('scene');
    expect(asAny(layer)._hostDepthSynced).toBe(true);
  });

  test('MapLibre 签名不动，也不进入已判定状态', () => {
    const layer = new S3MLayer({ id: 's3m' });
    asAny(layer)._syncHostDepthContract(MAPLIBRE_ARG, []);
    expect(layer.depthMode).toBe('scene');
    expect(asAny(layer)._hostDepthSynced).toBe(false);
  });

  test('用户显式设过 depthMode 时完全以用户为准', () => {
    const layer = new S3MLayer({ id: 's3m', depthMode: 'clear' });
    asAny(layer)._syncHostDepthContract(MAPBOX_MATRIX, MAPBOX_REST);
    expect(layer.depthMode).toBe('clear');

    const layer2 = new S3MLayer({ id: 's3m' });
    layer2.setDepthMode('auto');
    asAny(layer2)._syncHostDepthContract(MAPBOX_MATRIX, MAPBOX_REST);
    expect(layer2.depthMode).toBe('auto');
  });

  test('只判定一次：之后用户手动改，本方法不再介入', () => {
    const layer = new S3MLayer({ id: 's3m' });
    asAny(layer)._syncHostDepthContract(MAPBOX_MATRIX, MAPBOX_REST);
    layer.setDepthMode('clear');
    asAny(layer)._syncHostDepthContract(MAPBOX_MATRIX, MAPBOX_REST);
    expect(layer.depthMode).toBe('clear');
  });

  test('残缺签名（rest 不够长 / 没有 projectionMatrix）不改任何东西', () => {
    const layer = new S3MLayer({ id: 's3m' });
    asAny(layer)._syncHostDepthContract(MAPBOX_MATRIX, []);
    asAny(layer)._syncHostDepthContract(MAPBOX_MATRIX, [undefined, undefined, undefined, undefined, undefined, {}]);
    asAny(layer)._syncHostDepthContract(undefined, MAPBOX_REST);
    expect(layer.depthMode).toBe('scene');
  });
});
