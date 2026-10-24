import { For } from 'solid-js';
import type { TocItem } from '../lib/types';

/** 右侧「本页大纲」，跟 Sidebar 共用同一份标题数据，只是更窄、只到 h3 */
export default function Toc(props: { items: TocItem[]; activeId: string }) {
  return (
    <aside class="toc-col">
      <div class="col-title">本页大纲</div>
      <ul class="toc-list">
        <For each={props.items}>
          {(item) => (
            <li>
              <a
                href={`#${item.id}`}
                class="toc-link"
                classList={{ 'depth-3': item.depth === 3, active: props.activeId === item.id }}
              >
                {item.text}
              </a>
            </li>
          )}
        </For>
      </ul>
    </aside>
  );
}
