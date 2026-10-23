/**
 * 编译 docs/API.md 生成精美独立的现代文档网页 docs/index.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 读取 package.json 获取版本号
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version || '0.2.9';

// 读取 docs/API.md
const apiMdPath = path.join(rootDir, 'docs', 'API.md');
const mdContent = fs.readFileSync(apiMdPath, 'utf8');

// 自定义标题与锚点提取
const headings = [];
const renderer = new marked.Renderer();

// 标题渲染器：自动生成 ID、提取目录
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  // 提取纯文本作为 ID
  const plainText = text.replace(/<[^>]+>/g, '').trim();
  const id = plainText
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '');

  if (depth <= 3) {
    headings.push({ id, text: plainText, depth });
  }

  return `
    <h${depth} id="${id}" class="doc-heading group">
      <span class="heading-anchor-link">#</span>
      <a href="#${id}" class="heading-text">${text}</a>
    </h${depth}>
  `;
};

// 代码块渲染器：增加头部语言标识与一键复制按钮
renderer.code = function ({ text, lang }) {
  const displayLang = (lang || 'code').toUpperCase();
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  return `
    <div class="code-wrapper my-5 rounded-xl border border-white/10 bg-[#121826] overflow-hidden shadow-2xl">
      <div class="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-[#0e1420] text-xs font-mono text-slate-400 select-none">
        <span class="font-semibold text-cyan-400 tracking-wider">${displayLang}</span>
        <button class="copy-btn flex items-center gap-1.5 px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-all text-xs" data-code="${encodeURIComponent(text)}">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
          <span class="copy-status">复制</span>
        </button>
      </div>
      <pre class="p-4 overflow-x-auto text-sm leading-relaxed font-mono text-slate-200"><code>${escaped}</code></pre>
    </div>
  `;
};

// 表格渲染器：外层包裹响应式容器
renderer.table = function ({ header, rows }) {
  return `
    <div class="table-responsive my-6 overflow-x-auto rounded-xl border border-white/10 bg-[#121826]/70 shadow-lg">
      <table class="w-full text-left text-sm text-slate-300">
        <thead class="bg-white/5 text-slate-200 font-semibold border-b border-white/10">
          ${header}
        </thead>
        <tbody class="divide-y divide-white/5">
          ${rows}
        </tbody>
      </table>
    </div>
  `;
};

// 引用块提醒渲染器
renderer.blockquote = function ({ tokens }) {
  const body = this.parser.parse(tokens);
  return `
    <div class="callout my-5 rounded-xl border-l-4 border-cyan-400 bg-cyan-950/20 px-5 py-3 text-slate-300 shadow-sm">
      <div class="text-sm leading-relaxed">${body}</div>
    </div>
  `;
};

// 编译 Markdown 为 HTML
marked.use({ renderer });
const mainHtml = marked.parse(mdContent);

// 生成左侧主要目录（H2 为大类，H3 为子类）
let sidebarHtml = '';
for (const h of headings) {
  if (h.depth === 2) {
    sidebarHtml += `<a href="#${h.id}" class="sidebar-link depth-2">${h.text}</a>\n`;
  } else if (h.depth === 3) {
    sidebarHtml += `<a href="#${h.id}" class="sidebar-link depth-3 pl-3 text-slate-400 hover:text-cyan-300 text-xs">${h.text}</a>\n`;
  }
}

// 生成右侧大纲（页面快速导航）
let tocHtml = '';
for (const h of headings) {
  if (h.depth === 2 || h.depth === 3) {
    const indent = h.depth === 3 ? 'ml-3 text-xs' : 'font-medium text-xs';
    tocHtml += `<li><a href="#${h.id}" class="toc-link block py-1 text-slate-400 hover:text-cyan-400 transition-colors ${indent}">${h.text}</a></li>\n`;
  }
}

// 组装精美的完整 HTML 模板
const htmlTemplate = `<!doctype html>
<html lang="zh-CN" class="dark scroll-smooth">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>S3M for MapLibre - 完整开发指南与 API 参考</title>
    <meta name="description" content="SuperMap S3M/S3MB 三维瓦片格式原生 MapLibre / Mapbox 图层核心架构、API 文档与使用手册" />
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏢</text></svg>" />
    <!-- Tailwind CSS CDN -->
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        darkMode: 'class',
        theme: {
          extend: {
            colors: {
              brand: {
                50: '#f0f9ff',
                400: '#38bdf8',
                500: '#0ea5e9',
                600: '#0284c7',
              }
            }
          }
        }
      }
    </script>
    <style>
      /* 滚动条美化 */
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); }

      /* 排版细节 */
      body {
        background-color: #0b101b;
        color: #cbd5e1;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }
      .doc-content h1 {
        font-size: 2.25rem;
        font-weight: 800;
        letter-spacing: -0.025em;
        color: #f8fafc;
        margin-top: 1.5rem;
        margin-bottom: 1.25rem;
        padding-bottom: 0.75rem;
        border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      .doc-content h2 {
        font-size: 1.6rem;
        font-weight: 700;
        color: #f1f5f9;
        margin-top: 2.75rem;
        margin-bottom: 1rem;
        padding-bottom: 0.4rem;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .doc-content h3 {
        font-size: 1.25rem;
        font-weight: 600;
        color: #e2e8f0;
        margin-top: 2rem;
        margin-bottom: 0.75rem;
      }
      .doc-content h4 {
        font-size: 1.05rem;
        font-weight: 600;
        color: #cbd5e1;
        margin-top: 1.5rem;
        margin-bottom: 0.5rem;
      }
      .doc-content p {
        margin-top: 0.85rem;
        margin-bottom: 0.85rem;
        line-height: 1.78;
        color: #94a3b8;
      }
      .doc-content ul {
        list-style-type: disc;
        padding-left: 1.5rem;
        margin-top: 0.75rem;
        margin-bottom: 0.75rem;
        color: #94a3b8;
        line-height: 1.7;
      }
      .doc-content ol {
        list-style-type: decimal;
        padding-left: 1.5rem;
        margin-top: 0.75rem;
        margin-bottom: 0.75rem;
        color: #94a3b8;
        line-height: 1.7;
      }
      .doc-content li { margin-bottom: 0.35rem; }
      .doc-content a {
        color: #38bdf8;
        text-decoration: underline;
        text-underline-offset: 3px;
        transition: color 0.15s;
      }
      .doc-content a:hover { color: #7dd3fc; }
      .doc-content code:not(pre code) {
        background: rgba(255,255,255,0.08);
        color: #e2e8f0;
        padding: 0.18rem 0.38rem;
        border-radius: 0.375rem;
        font-size: 0.86em;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        border: 1px solid rgba(255,255,255,0.06);
      }
      .doc-content hr {
        margin: 3rem 0;
        border-color: rgba(255,255,255,0.08);
      }
      .doc-content strong { color: #f8fafc; font-weight: 600; }

      /* 锚点小图标 */
      .doc-heading { position: relative; }
      .heading-anchor-link {
        position: absolute;
        left: -1.25rem;
        top: 50%;
        transform: translateY(-50%);
        color: #38bdf8;
        opacity: 0;
        font-weight: 400;
        transition: opacity 0.15s;
      }
      .doc-heading:hover .heading-anchor-link { opacity: 1; }
      .doc-heading a.heading-text { text-decoration: none; color: inherit; }

      /* 侧边栏链接高亮 */
      .sidebar-link {
        display: block;
        padding: 0.35rem 0.75rem;
        margin-bottom: 0.15rem;
        border-radius: 0.375rem;
        color: #94a3b8;
        font-size: 0.875rem;
        text-decoration: none !important;
        transition: all 0.15s;
      }
      .sidebar-link:hover {
        background: rgba(255,255,255,0.05);
        color: #f1f5f9;
      }
      .sidebar-link.active {
        background: rgba(56,189,248,0.12);
        color: #38bdf8;
        font-weight: 600;
      }
      .toc-link.active {
        color: #38bdf8;
        font-weight: 600;
        border-left: 2px solid #38bdf8;
        padding-left: 0.5rem;
      }

      /* 表格内单元格内边距 */
      .table-responsive th, .table-responsive td {
        padding: 0.75rem 1rem;
        vertical-align: top;
      }
    </style>
  </head>
  <body class="min-h-screen flex flex-col">

    <!-- 顶部导航 Header -->
    <header class="sticky top-0 z-40 w-full border-b border-white/10 bg-[#0b101b]/90 backdrop-blur-md">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        <!-- Logo -->
        <div class="flex items-center gap-3">
          <a href="../demo/index.html" class="flex items-center gap-2.5 text-white font-bold text-lg tracking-tight hover:opacity-90 transition">
            <span class="w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
              🏢
            </span>
            <span>s3m-maplibre</span>
          </a>
          <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            v${version}
          </span>
        </div>

        <!-- 搜索与快捷跳转 -->
        <div class="flex items-center gap-4">
          <!-- 实时过滤搜索框 -->
          <div class="relative hidden sm:block w-64 lg:w-80">
            <input 
              id="searchInput" 
              type="text" 
              placeholder="搜索文档 (如: pick, lod, 投影...)" 
              class="w-full bg-[#131b2e] border border-white/10 rounded-lg px-3.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-400 transition"
            />
            <span class="absolute right-2.5 top-2 text-[10px] font-mono text-slate-500 border border-white/10 rounded px-1">/</span>
          </div>

          <a href="../demo/index.html" target="_blank" class="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-cyan-500 text-slate-950 font-semibold hover:bg-cyan-400 transition shadow-md shadow-cyan-500/10">
            <span>在线三维 Demo</span>
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
          </a>

          <a href="https://github.com/joo1es/s3m-maplibre" target="_blank" class="p-2 text-slate-400 hover:text-white transition" title="GitHub 仓库">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path></svg>
          </a>
        </div>
      </div>
    </header>

    <!-- 主体容器：左中右三栏布局 -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full flex-1 flex gap-8">
      
      <!-- 左侧吸顶目录 (Sidebar) -->
      <aside id="sidebar" class="hidden md:block w-64 shrink-0 py-8 border-r border-white/5 pr-4 h-[calc(100vh-4rem)] sticky top-16 overflow-y-auto">
        <div class="text-xs font-semibold text-slate-400 tracking-wider uppercase mb-3 px-2 select-none">
          文档导航
        </div>
        <nav class="space-y-0.5" id="navLinks">
          ${sidebarHtml}
        </nav>
      </aside>

      <!-- 中间正文主体 (Content) -->
      <main class="flex-1 min-w-0 py-8 lg:py-10 max-w-4xl doc-content">
        ${mainHtml}
        
        <!-- 页脚 -->
        <footer class="mt-16 pt-8 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-4">
          <p>© 2026 s3m-maplibre 项目组 · Apache-2.0 开源协议</p>
          <div class="flex items-center gap-4">
            <a href="https://github.com/joo1es/s3m-maplibre" class="hover:text-slate-300">GitHub</a>
            <span>·</span>
            <a href="../demo/index.html" class="hover:text-slate-300">在线交互演示</a>
          </div>
        </footer>
      </main>

      <!-- 右侧大纲 (On this page) -->
      <aside class="hidden xl:block w-56 shrink-0 py-8 pl-4 h-[calc(100vh-4rem)] sticky top-16 overflow-y-auto">
        <div class="text-xs font-semibold text-slate-400 tracking-wider uppercase mb-3 select-none">
          本页大纲
        </div>
        <ul class="space-y-1 border-l border-white/5 pl-2" id="tocLinks">
          ${tocHtml}
        </ul>
      </aside>
    </div>

    <!-- 交互脚本：代码复制、滚动监听、搜索高亮 -->
    <script>
      // 1. 代码一键复制
      document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const raw = decodeURIComponent(btn.dataset.code || '');
          try {
            await navigator.clipboard.writeText(raw);
            const status = btn.querySelector('.copy-status');
            const orig = status.textContent;
            status.textContent = '已复制！';
            btn.classList.add('text-cyan-400');
            setTimeout(() => {
              status.textContent = orig;
              btn.classList.remove('text-cyan-400');
            }, 1800);
          } catch (err) {
            console.error('复制失败', err);
          }
        });
      });

      // 2. 标题滚动监听激活 (Scrollspy)
      const headings = Array.from(document.querySelectorAll('.doc-heading'));
      const tocLinks = Array.from(document.querySelectorAll('.toc-link'));
      const sidebarLinks = Array.from(document.querySelectorAll('.sidebar-link'));

      function onScroll() {
        const top = window.scrollY + 100;
        let currentId = '';
        for (let i = 0; i < headings.length; i++) {
          if (headings[i].offsetTop <= top) {
            currentId = headings[i].id;
          }
        }
        if (!currentId && headings.length > 0) currentId = headings[0].id;

        tocLinks.forEach(link => {
          const active = link.getAttribute('href') === '#' + currentId;
          link.classList.toggle('active', active);
        });

        sidebarLinks.forEach(link => {
          const active = link.getAttribute('href') === '#' + currentId;
          link.classList.toggle('active', active);
        });
      }
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();

      // 3. 快速过滤搜索
      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          const query = e.target.value.toLowerCase().trim();
          sidebarLinks.forEach(link => {
            const text = link.textContent.toLowerCase();
            link.style.display = (!query || text.includes(query)) ? '' : 'none';
          });
        });
        window.addEventListener('keydown', (e) => {
          if (e.key === '/' && document.activeElement !== searchInput) {
            e.preventDefault();
            searchInput.focus();
          }
        });
      }
    </script>
  </body>
</html>
`;

// 输出文件
const outputHtmlPath = path.join(rootDir, 'docs', 'index.html');
fs.writeFileSync(outputHtmlPath, htmlTemplate, 'utf8');

console.log(`\n🎉 精美文档编译完成！`);
console.log(`输出路径: ${outputHtmlPath}`);
console.log(`提取标题: ${headings.length} 个节节点`);
console.log(`页面特性: Tailwind 暗夜高科技主题 / 3栏自适应 / 代码一键复制 / 实时大纲追踪 / 快速过滤搜索`);
