import { renderToString, generateHydrationScript } from 'solid-js/web';
import DocApp from './app';
import type { PageData } from './lib/types';

/** SSG 入口：只渲染布局外壳，正文 HTML 由构建脚本算好后作为 props 传入 */
export function render(page: PageData): string {
  return renderToString(() => <DocApp page={page} />);
}

/**
 * 必须注入页面：它初始化 window._$HY（hydration registry）。
 * 缺了它浏览器端 hydrate 会在读取 _$HY.done 时直接抛 TypeError。
 */
export const hydrationScript = generateHydrationScript();
