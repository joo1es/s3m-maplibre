/** 构建期计算、序列化进页面、hydrate 时原样取回的数据结构 */

export interface TocItem {
  id: string;
  text: string;
  depth: number;
}

export interface PageData {
  /** 包名，用于顶栏标识 */
  brand: string;
  version: string;
  title: string;
  description: string;
  /** markdown 渲染后的正文 HTML（SSG 期生成，客户端只做 innerHTML 回填） */
  contentHtml: string;
  toc: TocItem[];
  /** 顶栏的「切换到另一份文档」入口 */
  switch: { href: string; icon: string; label: string };
  repo: string;
  /** 主演示（S3M 数据集 + 着色 + 拾取） */
  demoHref: string;
  /** 空间分析演示（量算 / 通视 / 裁剪 / 天际线 / 可视域 / 覆盖物） */
  analysisHref: string;
}
