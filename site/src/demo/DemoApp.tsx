import { onCleanup, onMount } from 'solid-js';
import ControlPanel from './panel/ControlPanel';
import './demo.css';

// SSG 阶段不能碰 DOM，也不能 import maplibre（它在模块顶层读 window）
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

export default function DemoApp() {
  let host!: HTMLDivElement;

  if (isBrowser) {
    onMount(() => {
      let dispose: (() => void) | undefined;
      let disposed = false;

      // 动态加载：地图内核（maplibre + s3m 图层）不参与首屏，也不进 SSR 图
      import('./main.js').then(({ initDemo }) => {
        if (disposed) return;
        dispose = initDemo(host);
      });

      onCleanup(() => {
        disposed = true;
        dispose?.();
      });
    });
  }

  return (
    <>
      <div id="map" ref={host} />
      <ControlPanel />
      <div id="feature" class="card" />
      <div id="hint">左键旋转 · 右键平移 · 滚轮缩放 · 点击建筑查看属性</div>
    </>
  );
}
