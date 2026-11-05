/**
 * `main.js` 是纯 JS（地图内核不参与 SSR 图，所以没走 TS），这里补一份最小声明。
 *
 * 没有它 `import('./main.js')` 会报 TS7016，而且 `initDemo` 的返回值是 any，
 * `dispose?.()` 这类调用就完全失去检查。
 */
export function initDemo(host: HTMLElement): () => void;
