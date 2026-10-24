import ThemeToggle from './ThemeToggle';
import type { PageData } from '../lib/types';

export default function Header(props: {
  page: PageData;
  query: string;
  onQuery: (value: string) => void;
}) {
  return (
    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="./index.html">
          <span class="brand-mark">S3M</span>
          <span class="brand-name">{props.page.brand}</span>
          <span class="brand-version">v{props.page.version}</span>
        </a>

        <a class="doc-switch" href={props.page.switch.href}>
          <span class="doc-switch-icon">{props.page.switch.icon}</span>
          <span>{props.page.switch.label}</span>
        </a>

        <div class="header-tools">
          <input
            id="doc-search"
            class="search"
            type="search"
            placeholder="搜索章节  /"
            value={props.query}
            onInput={(e) => props.onQuery(e.currentTarget.value)}
          />
          <ThemeToggle />
          <a class="icon-btn" href={props.page.demoHref} title="在线演示">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 4h6v6M20 4l-8.5 8.5" />
              <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
            </svg>
          </a>
          <a class="icon-btn" href={props.page.repo} target="_blank" rel="noreferrer" title="GitHub 仓库">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12.02c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0 1 12 6.84c.85 0 1.71.11 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.85 0 1.34-.01 2.42-.01 2.75 0 .27.18.58.69.48A10.02 10.02 0 0 0 22 12.02C22 6.48 17.52 2 12 2z" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  );
}
