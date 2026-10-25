// 首页: what not to miss first — calls closing soon and talks or conferences about to start, read out
// of the posts (学术动态) — then what is waiting to be read. The Lumen name and the house button open it.
import { useEffect, useState } from 'preact/hooks';
import { api, type ListItem, type Notice } from '../api.ts';
import { app, select, notify } from '../store.ts';
import { NoticeRow, usePoll } from './Journals.tsx';
import { dueSoon, DEADLINE_DAYS, EVENT_DAYS } from '../due.ts';
import { TopFeeds, AiTags, RecList, topFeeds, topAiTags } from './Overview.tsx';
import { Icon } from './Icon.tsx';

const SHOWN = 8;
const RECS = 5;
const WEEKDAY = '日一二三四五六';

function DueList({ title, hint, items, empty }: { title: string; hint: string; items: Notice[]; empty: string }) {
  return (
    <section class="home-due">
      <h3>{title}<small>{hint}</small>{items.length > 0 && <span class="home-count">{items.length}</span>}</h3>
      {items.length === 0 ? <p class="muted home-empty">{empty}</p>
        : <ol class="notices">{items.slice(0, SHOWN).map((n) => <NoticeRow key={`${n.post.id}:${n.name}`} n={n} />)}</ol>}
      {items.length > SHOWN && <button class="home-more" onClick={() => void select({ kind: 'notices' })}>还有 {items.length - SHOWN} 项，在学术动态里看 →</button>}
    </section>
  );
}

const PAGES = [
  { kind: 'reports', label: '日报', icon: 'doc' },
  { kind: 'notices', label: '学术动态', icon: 'calendar' },
  { kind: 'tocs', label: '期刊目录', icon: 'contents' },
  { kind: 'books', label: '新书', icon: 'masonry' },
] as const;

export function HomeView() {
  const a = app.value;
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [reading, setReading] = useState(false);
  const [recs, setRecs] = useState<ListItem[]>([]);
  const load = (): void => {
    api.notices({ kind: '', past: false, online: false })
      .then((r) => { setNotices(r.items); setReading(!!r.reading); })
      .catch((e: Error) => notify(e.message, true));
  };
  useEffect(() => {
    load();
    api.recommended({ filter: 'unread' }, 0, RECS).then((r) => setRecs(r.items)).catch(() => {});
  }, []);
  usePoll(reading, load);
  if (!a) return null;
  const { closing, starting } = dueSoon(notices ?? []);
  const unread = a.feeds.reduce((n, f) => n + f.unread, 0);
  const now = new Date();
  return (
    <section class="list home-page">
      <div class="list-scroll home-scroll">
        <header class="home-head">
          <p class="home-date">{now.getMonth() + 1}月{now.getDate()}日 · 星期{WEEKDAY[now.getDay()]}</p>
          <h2>别错过</h2>
          <nav class="home-pages" aria-label="常用页面">
            {PAGES.map((p) => (
              <button key={p.kind} class="chip" onClick={() => void select({ kind: p.kind })}><Icon name={p.icon} size={14} />{p.label}</button>
            ))}
          </nav>
        </header>
        <div class="home-grid">
          <div class="home-main">
            {notices === null ? <p class="muted home-empty">正在读取学术动态…</p> : (
              <>
                <DueList title="快截止" hint={`${DEADLINE_DAYS} 天内截止的征稿、申报、招聘`} items={closing}
                  empty={reading ? '正在从推文里找会议、征稿和讲座…' : `${DEADLINE_DAYS} 天内没有要截止的。`} />
                <DueList title="快开始" hint={`${EVENT_DAYS} 天内举办或正在进行的会议、讲座、活动`} items={starting}
                  empty={reading ? '正在从推文里找会议、征稿和讲座…' : `${EVENT_DAYS} 天内没有要开始的。`} />
              </>
            )}
          </div>
          <aside class="home-side scope-ov">
            <header class="scope-ov-head">
              <p class="scope-ov-kicker">还没读</p>
              <h1><b>{unread}</b> 篇<small>来自 {a.feeds.filter((f) => f.unread > 0).length} 个源</small></h1>
            </header>
            <RecList items={recs} />
            <TopFeeds feeds={topFeeds(a.feeds, 6)} />
            <AiTags tags={topAiTags(a.tags, 12)} />
          </aside>
        </div>
      </div>
    </section>
  );
}
