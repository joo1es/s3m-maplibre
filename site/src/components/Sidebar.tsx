import { For, Show, createMemo } from 'solid-js';
import type { TocItem } from '../lib/types';

/** 左侧文档导航：只列 h2 / h3，带搜索过滤，滚动时高亮当前节 */
export default function Sidebar(props: {
  items: TocItem[];
  query: string;
  activeId: string;
}) {
  const filtered = createMemo(() => {
    const q = props.query.trim().toLowerCase();
    if (!q) return props.items;
    return props.items.filter((it) => it.text.toLowerCase().includes(q));
  });

  return (
    <aside class="sidebar-col">
      <div class="col-title">文档导航</div>
      <nav class="sidebar-nav">
        <For each={filtered()}>
          {(item) => (
            <a
              href={`#${item.id}`}
              class="sidebar-link"
              classList={{ 'depth-3': item.depth === 3, active: props.activeId === item.id }}
            >
              {item.text}
            </a>
          )}
        </For>
        <Show when={filtered().length === 0}>
          <p class="sidebar-empty">没有匹配的章节</p>
        </Show>
      </nav>
    </aside>
  );
}
