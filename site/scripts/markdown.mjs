/**
 * Markdown → HTML，构建期在 Node 里跑（shiki / markdown-it 都不会进浏览器包）。
 *
 * 两个页面共用这套渲染，`build-docs.mjs`（生产构建）和 `vite dev` 的中间件
 * （本地预览）都从这里取数据，避免出现「dev 和线上渲染不一致」。
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';

// 双主题：shiki 给每个 token 同时打 --shiki-light / --shiki-dark，
// 切换主题纯 CSS 完成，不需要重新高亮
export const SHIKI_THEMES = { light: 'github-light', dark: 'vitesse-dark' };

const HIGHLIGHT_LANGS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'bash',
  'json',
  'html',
  'css',
  'diff',
  'yaml',
  'sql',
  'xml',
];

export const REPO_URL = 'https://github.com/joo1es/s3m-maplibre';

/** 站点有哪几页：入口 html / 产物名 / 文档源 / 版本来源 */
export const PAGES = [
  {
    entry: 'index.html',
    md: 'packages/s3m-maplibre/docs/API.md',
    pkg: 'packages/s3m-maplibre/package.json',
    brand: 's3m-maplibre',
    title: 's3m-maplibre - 完整开发指南与 API 参考',
    description:
      'SuperMap S3M/S3MB 三维瓦片格式原生 MapLibre / Mapbox 图层核心架构、API 文档与使用手册',
    switch: { href: './three.html', icon: '🧊', label: 's3m-three 内核文档' },
  },
  {
    entry: 'three.html',
    md: 'packages/s3m-three/docs/API.md',
    pkg: 'packages/s3m-three/package.json',
    brand: 's3m-three',
    title: 's3m-three - 渲染内核 API 参考',
    description:
      'SuperMap S3M/S3MB 三维瓦片格式的 three.js 渲染内核：宿主无关的解析、瓦片树与 S3MViewer API 参考',
    switch: { href: './index.html', icon: '🗺️', label: 's3m-maplibre 图层文档' },
  },
];

/** md 里写的是仓库相对路径，落成站点后要换成页面地址 */
const LINK_REWRITES = [
  [/href="\.\.\/s3m-three\/docs\/API\.md/g, 'href="./three.html"'],
  [/href="\.\.\/s3m-maplibre\/docs\/API\.md/g, 'href="./index.html"'],
];

/**
 * 与旧 build-docs.mjs 完全一致的 slug 规则：去标点、空格转连字符、转小写。
 * 必须保持一致，否则 md 里手写的「## 目录」锚点会全部失效。
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** 取标题的可见文本（丢掉反引号等标记，但保留文字） */
function plainTextOf(inline) {
  if (!inline) return '';
  if (!inline.children) return (inline.content ?? '').trim();
  let out = '';
  for (const child of inline.children) {
    if (child.type === 'text' || child.type === 'code_inline') out += child.content;
  }
  return out.trim();
}

export async function createRenderer() {
  const highlighter = await createHighlighter({
    themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark],
    langs: HIGHLIGHT_LANGS,
  });
  const loaded = new Set(highlighter.getLoadedLanguages());

  const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

  let headings = [];
  let seen = new Map();

  // 标题：生成锚点 id + 前置 # 链接 + 收集大纲
  md.core.ruler.push('s3m_anchors', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      if (open.type !== 'heading_open') continue;

      const depth = Number(open.tag.slice(1));
      const inline = tokens[i + 1];
      const text = plainTextOf(inline);
      const base = slugify(text) || `section-${i}`;
      const times = seen.get(base) ?? 0;
      seen.set(base, times + 1);
      const id = times === 0 ? base : `${base}-${times}`;

      open.attrSet('id', id);

      // data-heading 只标 toc 里存在的层级，否则滚动高亮会选到侧栏没有的 id
      if (depth === 2 || depth === 3) {
        open.attrSet('data-heading', '');
        headings.push({ id, text, depth });
      }

      if (inline?.children) {
        const link = new state.Token('link_open', 'a', 1);
        link.attrSet('class', 'anchor');
        link.attrSet('href', `#${id}`);
        link.attrSet('aria-hidden', 'true');
        link.attrSet('tabindex', '-1');
        const hash = new state.Token('text', '', 0);
        hash.content = '#';
        const close = new state.Token('link_close', 'a', -1);
        inline.children.unshift(link, hash, close);
      }
    }
  });

  // 代码块：shiki 高亮 + 复制按钮
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0];
    const code = token.content;

    const body =
      lang && loaded.has(lang)
        ? highlighter.codeToHtml(code, {
            lang,
            themes: SHIKI_THEMES,
            // 不在 pre 上写死颜色，交给 CSS 变量按主题切换
            defaultColor: false,
          })
        : `<pre class="shiki"><code>${md.utils.escapeHtml(code)}</code></pre>`;

    return (
      '<div class="code-block">' +
      '<button class="copy-btn" type="button" aria-label="复制代码"><span class="copy-label">复制</span></button>' +
      body +
      '</div>\n'
    );
  };

  // 表格外面套一层，窄屏可横向滚动且能吃到圆角
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  function render(source) {
    headings = [];
    seen = new Map();
    let html = md.render(source);
    for (const [pattern, replacement] of LINK_REWRITES) {
      html = html.replace(pattern, replacement);
    }
    return { html, toc: headings.slice() };
  }

  return { render, highlighter };
}

/** 读 md + 包版本，产出页面数据（序列化后客户端原样取回） */
export async function buildPageData(page, renderer, rootDir) {
  const [source, pkgRaw] = await Promise.all([
    readFile(path.resolve(rootDir, page.md), 'utf8'),
    readFile(path.resolve(rootDir, page.pkg), 'utf8'),
  ]);
  const { html, toc } = renderer.render(source);

  return {
    brand: page.brand,
    version: JSON.parse(pkgRaw).version,
    title: page.title,
    description: page.description,
    contentHtml: html,
    toc,
    switch: page.switch,
    repo: REPO_URL,
    demoHref: '../demo/index.html',
  };
}
