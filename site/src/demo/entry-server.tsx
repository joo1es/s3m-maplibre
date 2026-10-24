import { renderToString, generateHydrationScript } from 'solid-js/web';
import DemoApp from './DemoApp';

/** demo 页没有正文数据，SSG 只负责把面板骨架先吐出来，避免进页面先白屏 */
export function render(): string {
  return renderToString(() => <DemoApp />);
}

export const hydrationScript = generateHydrationScript();
