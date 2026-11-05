/**
 * 演示页的公共切换栏。
 *
 * 为什么不用 Solid 组件：三个演示页的技术形态不一样 ——
 *   · demo/index.html      Solid + SSR 的完整应用
 *   · demo/analysis.html   纯 TS，只加载 maplibre 和一个脚本
 *   · demo/three.html      手写静态页，连构建入口都没有
 * 共享成 Solid 组件等于给后两页各拖进一整套框架运行时。这里用原生 DOM，
 * 谁都能调一次 `mountDemoTabs('analysis')`。
 *
 * 加新演示时改这里一处就够了（three.html 那份是手写的，见文件底部说明）。
 */

export type DemoPageId = 'demo' | 'three' | 'analysis';

interface DemoTab {
  id: DemoPageId;
  label: string;
  /** 产物里的文件名，三页同级 */
  file: string;
}

const TABS: DemoTab[] = [
  { id: 'demo', label: '数据集演示', file: 'index.html' },
  { id: 'three', label: 'three.js', file: 'three.html' },
  { id: 'analysis', label: '空间分析', file: 'analysis.html' },
];

const DOCS_LABEL = '文档';

/**
 * 三个演示在产物里都在 demo/ 下，文档在 demo/ 的同级 docs/。
 *
 * dev 也照这个结构提供服务（见 vite.config 的 DEV_REDIRECTS），所以这里
 * 不需要判断「现在是 dev 还是产物」—— 那套判断以前要靠 import.meta.env.DEV，
 * 而这在静态页里取不到，判错就跳到一个 200 的文档站模板上，报「不是由 SSG 生成」。
 */
const DEMO_BASE = './';
const DOCS_HREF = '../docs/index.html';

const CSS = `
.demo-tabs {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.82);
  border: 1px solid rgba(148, 163, 184, 0.28);
  backdrop-filter: blur(8px);
  font: 12px/1 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  white-space: nowrap;
}
.demo-tabs a {
  padding: 6px 12px;
  border-radius: 999px;
  color: #cbd5e1;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.demo-tabs a:hover {
  color: #fff;
  background: rgba(56, 189, 248, 0.16);
}
.demo-tabs a.on {
  background: #0ea5e9;
  color: #04121f;
  font-weight: 600;
}
/* 文档不是演示，用分隔线和弱一档的样式区分 */
.demo-tabs a.docs {
  margin-left: 3px;
  border-left: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 0 999px 999px 0;
  padding-left: 14px;
  color: #94a3b8;
}
`;

/**
 * 在页面顶部挂一条切换栏。重复调用无副作用。
 *
 * 三页原本都没有横向入口：demo 页只有地图和面板，analysis 页连返回都没有，
 * three 页更是一进来就出不去。这条栏解决的就是「用户不知道还有别的演示」。
 */
export function mountDemoTabs(current: DemoPageId): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('.demo-tabs')) return;

  if (!document.getElementById('demo-tabs-style')) {
    const style = document.createElement('style');
    style.id = 'demo-tabs-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const nav = document.createElement('nav');
  nav.className = 'demo-tabs';
  nav.setAttribute('aria-label', '演示切换');
  nav.innerHTML = [
    ...TABS.map((tab) => {
      const on = tab.id === current;
      return `<a href="${DEMO_BASE}${tab.file}"${on ? ' class="on" aria-current="page"' : ''}>${tab.label}</a>`;
    }),
    `<a class="docs" href="${DOCS_HREF}">${DOCS_LABEL}</a>`,
  ].join('');
  document.body.appendChild(nav);
}
