import { createSignal, onMount } from 'solid-js';

const STORAGE_KEY = 's3m_doc_theme';

// 用运行时判断而不是 solid 的 isServer：SSG 阶段根本不该碰 window
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

/**
 * 主题切换。真正决定颜色的 class 由 <head> 里的内联脚本先打上（防闪白），
 * 这里只负责按钮状态与点击；SSR 期不知道用户存了什么，先按浅色输出。
 */
export default function ThemeToggle() {
  const [dark, setDark] = createSignal(false);

  // onMount 在 Solid 的服务端构建里会直接抛错，SSG 阶段必须整块跳过
  if (isBrowser) {
    onMount(() => {
      setDark(document.documentElement.classList.contains('dark'));

      // 用户没手动选过时，跟随系统主题变化
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', (e) => {
        if (localStorage.getItem(STORAGE_KEY)) return;
        document.documentElement.classList.toggle('dark', e.matches);
        setDark(e.matches);
      });
    });
  }

  const toggle = () => {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
    setDark(next);
  };

  return (
    <button class="icon-btn" type="button" onClick={toggle} title="切换深色 / 浅色主题" aria-label="切换主题">
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style={{ display: dark() ? 'none' : 'block' }}
      >
        <path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
      </svg>
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style={{ display: dark() ? 'block' : 'none' }}
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4 12H2m20 0h-2M5.6 5.6L4.2 4.2m15.6 15.6l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4" />
      </svg>
    </button>
  );
}
