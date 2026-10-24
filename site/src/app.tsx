import { createSignal, onCleanup, onMount } from 'solid-js';
import type { PageData } from './lib/types';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Toc from './components/Toc';

// SSG 阶段不注册任何浏览器侧监听，避免 solid 服务端构建对 onMount 抛错
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

export default function DocApp(props: { page: PageData }) {
  const [activeId, setActiveId] = createSignal('');
  const [query, setQuery] = createSignal('');

  // onMount 在 Solid 服务端构建里会抛错，SSG 阶段整块跳过，只留纯静态结构
  if (isBrowser) {
    // 滚动高亮：右侧大纲与左侧导航共用同一个 active 状态
    onMount(() => {
      const headings = Array.from(document.querySelectorAll<HTMLElement>('[data-heading]'));
      if (headings.length === 0) return;

      const sync = () => {
        const line = window.scrollY + 100;
        let current = headings[0].id;
        for (const h of headings) {
          if (h.getBoundingClientRect().top + window.scrollY <= line) current = h.id;
        }
        // 滚到底时强制选中最后一节，避免短章节永远选不中
        if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
          current = headings[headings.length - 1].id;
        }
        setActiveId(current);
      };

      window.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync);
      sync();
      onCleanup(() => {
        window.removeEventListener('scroll', sync);
        window.removeEventListener('resize', sync);
      });
    });

    // 代码块复制 + 「/」聚焦搜索
    onMount(() => {
      const onDocClick = async (e: MouseEvent) => {
        const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.copy-btn');
        if (!btn) return;
        const code = btn.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
        try {
          await navigator.clipboard.writeText(code);
          const label = btn.querySelector('.copy-label') ?? btn;
          const original = label.textContent ?? '';
          label.textContent = '已复制';
          btn.classList.add('copied');
          setTimeout(() => {
            label.textContent = original;
            btn.classList.remove('copied');
          }, 1600);
        } catch {
          /* 剪贴板不可用（非 https 或未授权）时保持静默 */
        }
      };

      const onKeydown = (e: KeyboardEvent) => {
        if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
        const input = document.getElementById('doc-search') as HTMLInputElement | null;
        if (!input || document.activeElement === input) return;
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        input.focus();
      };

      document.addEventListener('click', onDocClick);
      window.addEventListener('keydown', onKeydown);
      onCleanup(() => {
        document.removeEventListener('click', onDocClick);
        window.removeEventListener('keydown', onKeydown);
      });
    });
  }

  return (
    <>
      <Header page={props.page} query={query()} onQuery={setQuery} />
      <div class="layout">
        <Sidebar items={props.page.toc} query={query()} activeId={activeId()} />
        <div class="content-col">
          <main class="doc-body" innerHTML={props.page.contentHtml} />
          <footer class="doc-footer">
            <p>© 2026 s3m 项目组 · Apache-2.0 开源协议</p>
            <p class="doc-footer-links">
              <a href={props.page.repo} target="_blank" rel="noreferrer">GitHub</a>
              <span>·</span>
              <a href={props.page.demoHref}>在线交互演示</a>
            </p>
          </footer>
        </div>
        <Toc items={props.page.toc} activeId={activeId()} />
      </div>
    </>
  );
}
