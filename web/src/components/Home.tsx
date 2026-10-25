// 首页: what not to miss first — what falls on today, calls closing soon and talks or conferences about
// to start, read out of the posts (学术动态) — then new books and what is waiting to be read. With room
// beside the lists, a click shows the notice on the right instead of opening it in place.
// The Lumen name and the house button open it.
import { useEffect, useState } from 'preact/hooks';
import { api, type ListItem, type NewBook, type Notice } from '../api.ts';
import { app, select, notify, open, detail, feedsById, settingsOpen } from '../store.ts';
import { DEMO_SITE, TOUR, INSTALL, RELEASE_NOTES } from '../links.ts';
import { NoticeRow, usePoll, md, shownName } from './Journals.tsx';
import { NoticePreview, ownCover } from './NoticePreview.tsx';
import { dueSoon, DEADLINE_DAYS, EVENT_DAYS } from '../due.ts';
import { TopFeeds, AiTags, topFeeds, topAiTags } from './Overview.tsx';
import { Icon } from './Icon.tsx';
import { cx, proxiedCover, toneOf } from '../util.ts';
import '../home.css';

const SHOWN = 8;
const RECS = 6;
const TODAY_CARDS = 4;
const SHELF = 14;
const WEEKDAY = '日一二三四五六';
// The preview column needs the list beside it to stay readable: below this the rows open in place.
const WIDE = '(min-width: 1180px)';

const PAGES = [
  { kind: 'reports', label: '日报', icon: 'doc' },
  { kind: 'notices', label: '学术动态', icon: 'calendar' },
  { kind: 'tocs', label: '期刊目录', icon: 'contents' },
  { kind: 'books', label: '新书', icon: 'masonry' },
] as const;

function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const m = matchMedia(WIDE);
    const on = (): void => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

interface Pick { picked: Notice | null; onPick?: (n: Notice) => void }

function DueList({ title, hint, items, empty, pick }: { title: string; hint: string; items: Notice[]; empty: string; pick: Pick }) {
  return (
    <section class="home-due">
      <h3>{title}<small>{hint}</small>{items.length > 0 && <span class="home-count">{items.length}</span>}</h3>
      {items.length === 0 ? <p class="muted home-empty">{empty}</p>
        : <ol class="notices">{items.slice(0, SHOWN).map((n) => <NoticeRow key={`${n.post.id}:${n.name}`} n={n} picked={pick.picked === n} onPick={pick.onPick} />)}</ol>}
      {items.length > SHOWN && <button class="home-more" onClick={() => void select({ kind: 'notices' })}>还有 {items.length - SHOWN} 项，在学术动态里看 →</button>}
    </section>
  );
}

// Today's calls and events as cards with the post's cover: the first thing on the page.
function TodayCards({ items, pick }: { items: Notice[]; pick: Pick }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const label = (n: Notice): string => (n.next!.what === '进行中' ? `进行中 · ${md(n.next!.date)}结束` : n.next!.what === '截止' ? '今天截止' : '今天举办');
  return (
    <section class="home-today">
      <h3>今天<small>今天截止、今天举办和正在进行的</small><span class="home-count">{items.length}</span></h3>
      <div class="today-cards">
        {(all ? items : items.slice(0, TODAY_CARDS)).map((n) => (
          <button key={`${n.post.id}:${n.name}`} class={cx('today-card', pick.picked === n && 'picked', n.next!.what === '截止' && 'closing')}
            onClick={() => (pick.onPick ? pick.onPick(n) : void select({ kind: 'notices' }))}>
            <span class="today-cover">
              {ownCover(n) ? <img src={proxiedCover(ownCover(n)!, 480)} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLElement).remove(); }} />
                : <Icon name="calendar" size={22} />}
              <span class="today-when">{label(n)}</span>
            </span>
            <span class="today-text">
              <span class={`notice-kind ${toneOf(n.kind)}`}>{n.kind}</span>
              <b>{shownName(n.name)}</b>
              {(n.place || n.organizer) && <small>{n.place || n.organizer}</small>}
            </span>
          </button>
        ))}
      </div>
      {items.length > TODAY_CARDS && <button class="home-more" onClick={() => setAll(!all)}>{all ? '收起' : `今天还有 ${items.length - TODAY_CARDS} 项，展开`}</button>}
    </section>
  );
}

// The newest books out of the 书单 posts, as a row of covers; a click goes to 新书.
function Shelf({ books }: { books: NewBook[] }) {
  const shown = books.filter((b) => b.book.cover);
  if (!shown.length) return null;
  return (
    <section class="home-shelf">
      <h3>新书<small>最近书单里拆出来的</small>
        <button class="home-link" onClick={() => void select({ kind: 'books' })}>全部 →</button></h3>
      <div class="shelf-row">
        {shown.map((b) => (
          <button key={`${b.book.isbn || b.book.title}`} class="shelf-book" title={`${b.book.title}${b.book.authors ? ` · ${b.book.authors}` : ''}`}
            onClick={() => void select({ kind: 'books' })}>
            <img src={proxiedCover(b.book.cover, 480)} alt="" loading="lazy" onError={(e) => { ((e.currentTarget as HTMLElement).parentElement as HTMLElement).remove(); }} />
            <span>{b.book.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// 推荐先读 with each post's picture, when something is waiting.
function Recs({ items }: { items: ListItem[] }) {
  if (!items.length) return null;
  return (
    <section class="home-recs">
      <h3>推荐先读<small>按你读过、喜欢、存档的排</small></h3>
      <ol>{items.map((it) => (
        <li key={it.id}><button onClick={() => void open(it)}>
          {it.thumbnail ? <img src={proxiedCover(it.thumbnail, 160)} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLElement).remove(); }} /> : <span class="rec-dot" />}
          <span class="rec-text"><b>{it.title_zh || it.title}</b><small>{feedsById.value.get(it.feed_id)?.title}</small></span>
        </button></li>
      ))}</ol>
    </section>
  );
}

// A newer version, found by the daily check (server/api/update.ts): until it is installed or this
// version is put aside here (kept in this browser only).
const IGNORED_KEY = 'lumen.update.ignored';
const ignoredVersion = (): string | null => { try { return localStorage.getItem(IGNORED_KEY); } catch { return null; } };

function UpdateNotice() {
  const u = app.value?.update;
  const [ignored, setIgnored] = useState(ignoredVersion);
  if (!u?.newer || !u.latest || ignored === u.latest) return null;
  const ignore = (): void => {
    try { localStorage.setItem(IGNORED_KEY, u.latest!); } catch { /* shown again next time */ }
    setIgnored(u.latest);
  };
  return (
    <div class="home-update" role="status">
      <span><b>有新版本 v{u.latest}</b>（现在是 v{u.current}）。下载新的安装包覆盖安装即可，订阅和文章不受影响。</span>
      <a href={RELEASE_NOTES} target="_blank" rel="noreferrer">看更新了什么</a>
      <a class="btn small" href={u.url} target="_blank" rel="noreferrer">下载</a>
      <button class="link" onClick={ignore}>忽略这个版本</button>
    </div>
  );
}

// The first time, before any feed: what to do first, in order, each a button to the place it is done.
const STEPS = [
  { tab: 'add', title: '添加订阅', note: '粘贴 RSS 地址，或者网站、公众号转 RSS 的首页，Lumen 会自己找订阅地址。', go: '去添加' },
  { tab: 'data', title: '从别的阅读器搬过来', note: '导出 OPML，在「数据与接口」里导入，分类一并带过来。', go: '导入 OPML' },
  { tab: 'ai', title: '配上 AI（可以以后再说）', note: '学术动态、期刊目录、日报和翻译靠它读推文；任何兼容 OpenAI 的接口都行。不配也能当普通阅读器用。', go: '去设置' },
] as const;

function Welcome() {
  return (
    <div class="home-welcome">
      <p class="home-welcome-lede">还没有订阅。按下面的顺序来，几分钟就能用上：</p>
      <ol class="home-steps">
        {STEPS.map((s) => (
          <li key={s.tab}>
            <div><b>{s.title}</b><p class="small muted">{s.note}</p></div>
            <button class="btn small" onClick={() => { settingsOpen.value = s.tab; }}>{s.go}</button>
          </li>
        ))}
      </ol>
      <p class="small muted">
        不知道订什么好，先到<a href={DEMO_SITE} target="_blank" rel="noreferrer">演示站</a>点一遍；每一页做什么，见<a href={TOUR} target="_blank" rel="noreferrer">设计导览</a>；
        RSSHub、Zotero、OCR 这些可选的部分怎么配，见<a href={INSTALL} target="_blank" rel="noreferrer">安装说明</a>。版本与更新在 设置 → 关于。
      </p>
    </div>
  );
}

export function HomeView() {
  const a = app.value;
  const wide = useWide();
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [reading, setReading] = useState(false);
  const [recs, setRecs] = useState<ListItem[]>([]);
  const [books, setBooks] = useState<NewBook[]>([]);
  const [picked, setPicked] = useState<Notice | null>(null);
  const load = (): void => {
    api.notices({ kind: '', past: false, online: false })
      .then((r) => { setNotices(r.items); setReading(!!r.reading); })
      .catch((e: Error) => notify(e.message, true));
  };
  useEffect(() => {
    load();
    api.recommended({ filter: 'unread' }, 0, RECS).then((r) => setRecs(r.items)).catch(() => {});
    api.newBooks({ offset: 0, limit: SHELF, byDate: true, recentMonths: 1, notOwned: false, topic: '', kind: '', shelves: false })
      .then((r) => setBooks(r.books)).catch(() => {});
  }, []);
  usePoll(reading, load);
  if (!a) return null;
  const due = dueSoon(notices ?? []);
  // The preview takes the right column only while no article is open beside the page.
  const previewing = wide && !detail.value && a.feeds.length > 0;
  const first = due.today[0] ?? due.closing[0] ?? due.starting[0] ?? null;
  // A reload of the lists brings new objects; keep the pick by what it is.
  const same = picked && (notices ?? []).find((n) => n.post.id === picked.post.id && n.name === picked.name);
  const shown = previewing ? (same ?? first) : null;
  const pick: Pick = { picked: shown, onPick: previewing ? setPicked : undefined };
  const unread = a.feeds.reduce((n, f) => n + f.unread, 0);
  const sources = a.feeds.filter((f) => f.unread > 0).length;
  const now = new Date();
  const waiting = reading ? '正在从推文里找会议、征稿和讲座…' : '';
  return (
    <section class={cx('list home-page', previewing && 'previewing')}>
      <div class="home-columns">
        <div class="list-scroll home-scroll">
          <UpdateNotice />
          <header class="home-head">
            <div class="home-title">
              <p class="home-date">{now.getMonth() + 1}月{now.getDate()}日 · 星期{WEEKDAY[now.getDay()]}</p>
              <h2>别错过</h2>
              {notices && a.feeds.length > 0 && <p class="home-lede">今天 {due.today.length} 项，{DEADLINE_DAYS} 天内截止 {due.closing.length} 项，两周内开始 {due.starting.length} 项。</p>}
            </div>
            <div class="home-aside">
              <button class="home-unread" onClick={() => void select({ kind: 'all' })} title="去所有文章">
                <small>还没读</small><b>{unread}</b><span>篇{sources > 0 && ` · ${sources} 个源`}</span>
              </button>
              <nav class="home-pages" aria-label="常用页面">
                {PAGES.map((p) => (
                  <button key={p.kind} class="chip" onClick={() => void select({ kind: p.kind })}><Icon name={p.icon} size={14} />{p.label}</button>
                ))}
              </nav>
            </div>
          </header>
          {a.feeds.length === 0 ? <div class="home-main"><Welcome /></div> : <div class="home-main">
            {notices === null ? <p class="muted home-empty">正在读取学术动态…</p> : (
              <>
                <TodayCards items={due.today} pick={pick} />
                <DueList title="快截止" hint={`${DEADLINE_DAYS} 天内截止的征稿、申报、招聘`} items={due.closing} pick={pick}
                  empty={waiting || `${DEADLINE_DAYS} 天内没有要截止的。`} />
                <DueList title="快开始" hint={`${EVENT_DAYS} 天内举办的会议、讲座、活动`} items={due.starting} pick={pick}
                  empty={waiting || `${EVENT_DAYS} 天内没有要开始的。`} />
              </>
            )}
            <Shelf books={books} />
            <Recs items={recs} />
            {unread > 0 && (
              <div class="home-waiting scope-ov">
                <TopFeeds feeds={topFeeds(a.feeds, 6)} />
                <AiTags tags={topAiTags(a.tags, 12)} />
              </div>
            )}
          </div>}
        </div>
        {previewing && <aside class="home-preview" aria-label="预览"><NoticePreview n={shown} /></aside>}
      </div>
    </section>
  );
}
