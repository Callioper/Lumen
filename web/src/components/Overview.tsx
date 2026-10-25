// The pieces of an overview of what is waiting: the feeds with the most unread, the AI tags among
// them, and the top of 推荐. The reader shows them before an article is opened; 首页 shows them too.
import { open, select, feedsById } from '../store.ts';
import type { Feed, ListItem, TagCount } from '../api.ts';
import { FeedIcon } from './Icon.tsx';

export function TopFeeds({ feeds }: { feeds: Feed[] }) {
  if (!feeds.length) return null;
  return (
    <section>
      <h2 class="dossier-h">未读最多</h2>
      <ul class="scope-ov-feeds">
        {feeds.map((f) => (
          <li key={f.id}><button onClick={() => select({ kind: 'feed', id: f.id })}>
            <FeedIcon id={f.id} title={f.title} size={16} /><span class="ov-name">{f.title}</span>
            <span class="ov-bar" style={{ width: `${Math.max(6, (f.unread / feeds[0].unread) * 100)}%` }} /><small>{f.unread}</small>
          </button></li>
        ))}
      </ul>
    </section>
  );
}

export function AiTags({ tags }: { tags: TagCount[] }) {
  if (!tags.length) return null;
  return (
    <section>
      <h2 class="dossier-h">AI 标签</h2>
      <div class="tag-cloud">{tags.map((g) => (
        <button key={g.name} class="chip" onClick={() => select({ kind: 'tag', name: g.name })}>{g.name.replace(/^AI:/, '')}<small>{g.unread}</small></button>
      ))}</div>
    </section>
  );
}

export function RecList({ items }: { items: ListItem[] }) {
  if (!items.length) return null;
  return (
    <section>
      <h2 class="dossier-h">推荐先读</h2>
      <ol class="scope-ov-recs">{items.map((it) => (
        <li key={it.id}><button onClick={() => void open(it)}><span>{it.title_zh || it.title}</span><small>{feedsById.value.get(it.feed_id)?.title}</small></button></li>
      ))}</ol>
    </section>
  );
}

// The feeds with unread, most first; and the AI tags with unread, most first.
export const topFeeds = (feeds: readonly Feed[], n: number): Feed[] => feeds.filter((f) => f.unread > 0).sort((x, y) => y.unread - x.unread).slice(0, n);
export const topAiTags = (tags: readonly TagCount[], n: number): TagCount[] =>
  tags.filter((g) => (g.source === 'ai' || g.source === 'knn') && g.unread > 0).sort((x, y) => y.unread - x.unread).slice(0, n);
