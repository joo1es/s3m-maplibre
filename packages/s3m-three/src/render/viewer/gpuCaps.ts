/**
 * 渲染后端能力探测（WebGL / WebGPU 共用一条口径）。
 *
 * 为什么不直接判 `renderer.capabilities.isWebGL2`：
 *
 * 1. **three ≥ r163** 把它写死成 `true`（`WebGLCapabilities.js`，注释
 *    「keeping this for backwards compatibility」），闸门恒真、实际上什么也没拦；
 * 2. **three r155–r162**（`peerDependencies` 允许的最低版本）上它是真实值，
 *    WebGL1 上下文下为 `false` —— 这段语义必须留着，否则旧版本 + WebGL1 宿主会崩在
 *    three 自己的 `WebGL 1 is not supported` 上；
 * 3. 真正决定 HalfFloat RT 能不能用的是扩展 `EXT_color_buffer_float`：three 在
 *    `WebGLTextures.js` 里**只对这一个**做 `extensions.get()`，拿不到就 warn、RT 不完整
 *    —— 缺它的设备上，拖影 / presenter 会静默黑屏，而 `isWebGL2` 照样是 `true`。
 *
 * 所以 WebGL 路径要两个条件叠加；WebGPU 路径没有扩展概念，直接按后端类型给答。
 */

type AnyRenderer = unknown;

interface RendererProbe {
  isWebGPURenderer?: boolean;
  backend?: { isWebGPUBackend?: boolean };
  capabilities?: { isWebGL2?: boolean };
  extensions?: { has?: (name: string) => boolean } | null;
}

/** WebGPU 后端没有 `capabilities` / `extensions`，只有自己的身份标记 */
function isWebGPUBackend(r: RendererProbe): boolean {
  return r.isWebGPURenderer === true || r.backend?.isWebGPUBackend === true;
}

/**
 * 能不能写 `gl_FragDepth`（WebGPU 下是 `frag_depth`）。
 *
 * WebGL：只有 WebGL2 核心带这个能力；WebGL1 要 `EXT_frag_depth`，我们不押注。
 * WebGPU：核心能力，恒真。
 */
export function supportsFragDepth(renderer: AnyRenderer): boolean {
  const r = (renderer ?? {}) as RendererProbe;
  if (isWebGPUBackend(r)) return true;
  return r.capabilities?.isWebGL2 === true;
}

/**
 * 能不能建 HalfFloat（`RGBAFormat + HalfFloatType`）颜色附件的 RT。
 *
 * 拖影与 presenter 的 RT 都是半精度：线性空间的高光 > 1 不能被 clamp 到 [0,1]。
 * - WebGL2 需要 `EXT_color_buffer_float`；只拿到 `EXT_color_buffer_half_float` 不算，
 *   因为 three 只查前者，跟着 three 走才不会出现「闸门放行但 RT 不完整」。
 * - WebGL1 上 three 走的是 `OES_texture_half_float` 另一条路径，我们不押注，直接 false。
 * - WebGPU 的 `rgba16float` 是核心可渲染格式，恒真。
 *
 * `extensions` 缺失时按不支持处理：宁可回退直渲，也不要放行后黑屏。
 */
export function supportsHalfFloatTargets(renderer: AnyRenderer): boolean {
  const r = (renderer ?? {}) as RendererProbe;
  if (isWebGPUBackend(r)) return true;
  if (!supportsFragDepth(r)) return false;
  return r.extensions?.has?.('EXT_color_buffer_float') === true;
}
