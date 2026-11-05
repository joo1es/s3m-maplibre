/**
 * `markdown.mjs` 的最小类型面。
 *
 * 它是 .mjs、且用 markdown-it 做渲染，手写类型不划算；但 vite.config 直接
 * import 它，没有声明就是 TS7016 + 一串隐式 any。这里只钉住配置层用到的部分。
 */

export interface DocPage {
  entry: string;
  md: string;
  pkg: string;
  brand: string;
  title: string;
  description: string;
  switch: { href: string; icon: string; label: string };
}

/** `buildPageData` 的返回值，会被序列化进页面的 `s3m-page-data` */
export interface BuiltPage {
  brand: string;
  version: string;
  title: string;
  description: string;
  contentHtml: string;
  toc: { id: string; text: string; depth: number }[];
  switch: { href: string; icon: string; label: string };
  repo: string;
  demoHref: string;
  analysisHref: string;
}

export const PAGES: DocPage[];
export const REPO_URL: string;
export function createRenderer(): Promise<unknown>;
export function buildPageData(page: DocPage, renderer: unknown, root: string): Promise<BuiltPage>;
