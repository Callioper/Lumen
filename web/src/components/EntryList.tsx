import { useEffect, useRef, useState } from 'preact/hooks';
import { items, hasMore, loading, selectedId, open, loadMore, feedsById, selection, tab, app, prefs, setPrefs,
  reloadList, markAllRead, newCount, query, toggleStar, isMarks, isReports, isBooks, isHot, isTocs, isNotices, layout, defaultLayout, setLayout, markItemsRead,
  scrollRead, setScrollRead, markIdsRead, scope, notify, recAvailable, sortMode, setSortMode, recMeta, setSearchOrder, searchSince, searchKept, type SearchSince } from '../store.ts';
import { LAYOUTS, WIDE_LAYOUTS, groupByDay, groupDigest, layoutLabel, type DigestBlock } from '../layout.ts';
import { MarksList } from './Marks.tsx';
import { ReportsView } from './Reports.tsx';
import { BooksView } from './Books.tsx';
import { HotView } from './Hot.tsx';
import { TocsView, NoticesView } from './Journals.tsx';
import { api, type ListItem, type Layout } from '../api.ts';
import { Icon, FeedIcon } from './Icon.tsx';
import { ago, proxiedCover, cx, safeLink } from '../util.ts';

// A translated title's original, under the Chinese, when translations show 对照 (prefs.trView).
function OrigTitle({ it }: { it: ListItem }) {
  if (prefs.value.trView !== 'bilingual' || !it.title_zh || it.title_zh === it.title) return null;
  return <span class="title-orig-sm"><Marked text={it.title} /></span>;
}

function heading(): string {
  const s = selection.value, a = app.value;
  if (s.kind === 'starred') return '收藏';
  if (s.kind === 'feed') return feedsById.value.get(s.id)?.title ?? '';
  if (s.kind === 'category') return a?.categories.find((c) => c.id === s.id)?.name ?? '';
  if (s.kind === 'tag') return s.name.replace(/^AI:/, '');
  if (s.kind === 'social') return '动态';
  return tab.value === 'all' ? '所有文章' : layoutLabel(tab.value);
}

// A 破茧 pick in the 推荐 order says so; why the others are where they are shows under the article.
function RecTag({ it }: { it: ListItem }) {
  return it.rec?.explore ? <span class="rec-tag" title={it.rec.reasons.join('；')}>破茧</span> : null;
}

// The terms of the search box, as the server reads them: words split on spaces, quotes keep a phrase.
const searchTerms = (q: string): string[] =>
  [...new Set([...q.matchAll(/"([^"]+)"|“([^”]+)”|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim().toLowerCase()).filter(Boolean))];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text with the searched terms marked; plain text when nothing is searched.
function Marked({ text }: { text: string }) {
  const terms = query.value ? searchTerms(query.value) : [];
  if (!terms.length || !text) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i} class="hit">{part}</mark> : part))}</>;
}

function SearchOrderToggle() {
  const o = prefs.value.searchOrder;
  return (
    <div class="seg" role="group" aria-label="搜索结果排序">
      <button class={cx(o === 'relevance' && 'on')} onClick={() => setSearchOrder('relevance')} title="标题里命中的在前，其次作者和摘要，再次正文">相关</button>
      <button class={cx(o === 'latest' && 'on')} onClick={() => setSearchOrder('latest')} title="按发布时间">最新</button>
      <button class={cx(o === 'semantic' && 'on')} onClick={() => setSearchOrder('semantic')} title="按意思找，词不必出现在文中；只找得到算过向量的文章，每次搜索调用一次向量服务">意思相近</button>
    </div>
  );
}

const SINCE_LABELS: [SearchSince, string][] = [['any', '不限时间'], ['week', '近一周'], ['month', '近一月'], ['year', '近一年']];
const KEPT_LABELS: ['' | 'starred' | 'archived', string][] = [['', '全部'], ['starred', '收藏'], ['archived', '已存档']];

function SearchFilters() {
  const pick = (f: () => void): void => { f(); void reloadList(); };
  // In 收藏 everything is starred already; only 已存档 narrows it.
  const kept = selection.value.kind === 'starred' ? KEPT_LABELS.filter(([k]) => k !== 'starred') : KEPT_LABELS;
  return (
    <div class="search-filters">
      <div class="seg" role="group" aria-label="时间范围">
        {SINCE_LABELS.map(([k, label]) => <button key={k} class={cx(searchSince.value === k && 'on')} onClick={() => pick(() => { searchSince.value = k; })}>{label}</button>)}
      </div>
      <div class="seg" role="group" aria-label="只看">
        {kept.map(([k, label]) => <button key={k} class={cx(searchKept.value === k && 'on')} onClick={() => pick(() => { searchKept.value = k; })}
          title={k === 'archived' ? '存进 Obsidian 的' : undefined}>{label}</button>)}
      </div>
    </div>
  );
}

function SortToggle() {
  const m = sortMode.value;
  return (
    <div class="seg" role="group" aria-label="排序">
      <button class={cx(m === 'latest' && 'on')} onClick={() => setSortMode('latest')} title="按发布时间">最新</button>
      <button class={cx(m === 'rec' && 'on')} onClick={() => setSortMode('rec')} title="按你的阅读偏好排，兼顾新鲜度与多样性">推荐</button>
    </div>
  );
}

// Unread entries carry their ids for 滚过即读; read ones are left alone.
const readIds = (list: readonly ListItem[]): string | undefined => {
  const ids = list.filter((i) => !i.is_read).map((i) => i.id);
  return ids.length ? ids.join(',') : undefined;
};

// Under 「全部读完了」: the last twenty read here, dimmed, so the page goes on from where reading stopped.
const RECENT_READ = 20;
function RecentRead({ social }: { social: boolean }) {
  const [rows, setRows] = useState<ListItem[]>([]);
  useEffect(() => {
    let live = true;
    api.entries({ ...scope(), filter: 'all' }, undefined, RECENT_READ)
      .then((r) => { if (live) setRows(r.items.filter((i) => i.is_read)); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [selection.value, tab.value]);
  if (!rows.length) return null;
  return (
    <section class="recent-read">
      <h3 class="recent-read-head">最近读过</h3>
      {rows.map((it) => (social ? <Post key={it.id} it={it} /> : <Row key={it.id} it={it} />))}
    </section>
  );
}

function Row({ it }: { it: ListItem }) {
  const f = feedsById.value.get(it.feed_id);
  return (
    <article class={cx('row', it.id === selectedId.value && 'selected', it.is_read ? 'read' : 'unread')}
      onClick={() => void open(it)} data-id={it.id} data-read-ids={readIds([it])}>
      <div class="row-meta">
        {f && <FeedIcon id={f.id} title={f.title} size={14} />}
        <span class="row-feed">{f?.title}</span>
        <span class="row-time">{ago(it.published)}</span>
        <RecTag it={it} />
        {it.is_starred ? <Icon name="star" size={12} fill class="star-on" /> : null}
      </div>
      <div class="row-body">
        <div class="row-text">
          <h3 class="row-title"><Marked text={it.title_zh || it.title} /><OrigTitle it={it} /></h3>
          <p class="row-snippet">
            {it.has_summary && !it.hit ? <Icon name="sparkles" size={12} class="ai-mark" /> : null}
            <Marked text={it.snippet} />
          </p>
        </div>
        {it.thumbnail && <img class="row-thumb" src={proxiedCover(it.thumbnail, 160)} alt="" loading="lazy" width={72} height={72}
          onError={(e) => { (e.currentTarget as HTMLImageElement).remove(); }} />}
      </div>
    </article>
  );
}

// Tiles and cards: a plain click opens the reader; Ctrl/⌘+click or a middle click opens the
// original page in a new tab, and counts as reading it.
function openOriginal(it: ListItem): void {
  const url = safeLink(it.link);
  if (!url) { void open(it); return; }
  window.open(url, '_blank', 'noopener,noreferrer');
  if (!it.is_read) void markIdsRead([it.id]);
}

const itemHandlers = (it: ListItem) => ({
  onClick: (e: MouseEvent) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); openOriginal(it); } else void open(it); },
  // Without this a middle press starts the browser's autoscroll instead.
  onMouseDown: (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); },
  onAuxClick: (e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); openOriginal(it); } },
});

const POST_GRID_MAX = 9;

// 动态: a post by a person. Who and when first, then the whole text and its pictures, the way a
// timeline shows it; the title is left out because for these feeds it repeats the text.
function Post({ it }: { it: ListItem }) {
  const f = feedsById.value.get(it.feed_id);
  const images = (it.images?.length ? it.images : it.thumbnail ? [it.thumbnail] : []).slice(0, POST_GRID_MAX);
  return (
    <article class={cx('post', it.id === selectedId.value && 'selected', it.is_read ? 'read' : 'unread')}
      onClick={() => void open(it)} data-id={it.id} data-read-ids={readIds([it])}>
      {f ? <FeedIcon id={f.id} title={f.title} size={34} /> : <span class="post-avatar" />}
      <div class="post-main">
        <header class="post-head">
          <span class="post-who">{f?.title ?? it.author}</span>
          {it.is_starred ? <Icon name="star" size={12} fill class="star-on" /> : null}
          <span class="post-time">{ago(it.published)}</span>
        </header>
        <p class="post-text"><Marked text={it.snippet || it.title_zh || it.title} /></p>
        {images.length > 0 && (
          <div class={cx('post-images', `n${Math.min(images.length, 3)}`, images.length === 4 && 'four')}>
            {images.map((src) => <img key={src} src={proxiedCover(src, 480)} alt="" loading="lazy" decoding="async"
              onError={(e) => { (e.currentTarget as HTMLImageElement).remove(); }} />)}
          </div>
        )}
      </div>
    </article>
  );
}

function Tile({ it }: { it: ListItem }) {
  const f = feedsById.value.get(it.feed_id);
  return (
    <figure class={cx('tile', it.id === selectedId.value && 'selected', it.is_read && 'read')} {...itemHandlers(it)} data-id={it.id} data-read-ids={readIds([it])}>
      <div class="tile-media">
        {it.thumbnail ? <img src={proxiedCover(it.thumbnail, 520)} alt="" loading="lazy" decoding="async" /> : <div class="tile-empty"><Icon name="picture" size={28} /></div>}
        <button class={cx('tile-star', it.is_starred && 'on')} onClick={(e) => { e.stopPropagation(); void toggleStar(it); }} aria-label="收藏">
          <Icon name="star" size={14} fill={!!it.is_starred} />
        </button>
      </div>
      <figcaption>
        <span class="tile-title"><Marked text={it.title_zh || it.title} /><OrigTitle it={it} /></span>
        <span class="tile-meta">{f?.title} · {ago(it.published)} <RecTag it={it} /></span>
      </figcaption>
    </figure>
  );
}

// 大卡片: a wide cover beside the title and a longer excerpt.
function Card({ it }: { it: ListItem }) {
  const f = feedsById.value.get(it.feed_id);
  return (
    <article class={cx('card', it.id === selectedId.value && 'selected', it.is_read ? 'read' : 'unread')} {...itemHandlers(it)} data-id={it.id} data-read-ids={readIds([it])}>
      {it.thumbnail
        ? <img class="card-cover" src={proxiedCover(it.thumbnail, 480)} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).remove(); }} />
        : null}
      <div class="card-text">
        <div class="row-meta">
          {f && <FeedIcon id={f.id} title={f.title} size={14} />}
          <span class="row-feed">{f?.title}</span>
          <span class="row-time">{ago(it.published)}</span>
          <RecTag it={it} />
          <button class={cx('card-star', it.is_starred && 'on')} onClick={(e) => { e.stopPropagation(); void toggleStar(it); }} aria-label="收藏">
            <Icon name="star" size={13} fill={!!it.is_starred} />
          </button>
        </div>
        <h3 class="card-title"><Marked text={it.title_zh || it.title} /><OrigTitle it={it} /></h3>
        <p class="card-snippet">{it.has_summary && !it.hit ? <Icon name="sparkles" size={12} class="ai-mark" /> : null}<Marked text={it.snippet} /></p>
      </div>
    </article>
  );
}

// Journals and many feeds give only a date, which arrives as local midnight: no time is shown for those.
const clock = (t: number): string => {
  const d = new Date(t * 1000);
  return d.getHours() || d.getMinutes() ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
};

// 标题流: one line per entry, grouped by day, each group can be read off in one go.
function Line({ it, oneFeed }: { it: ListItem; oneFeed: boolean }) {
  const f = feedsById.value.get(it.feed_id);
  return (
    <div data-id={it.id} data-read-ids={readIds([it])} onClick={() => void open(it)}
      class={cx('line', it.id === selectedId.value && 'selected', it.is_read ? 'read' : 'unread')}>
      <span class="line-title" title={it.title_zh && it.title_zh !== it.title ? it.title : undefined}><Marked text={it.title_zh || it.title} /></span>
      {!oneFeed && <span class="line-feed">{f?.title}</span>}
      {it.is_starred ? <Icon name="star" size={11} fill class="star-on" /> : null}
      <span class="line-time">{clock(it.published)}</span>
    </div>
  );
}

function CompactList({ list }: { list: ListItem[] }) {
  const oneFeed = selection.value.kind === 'feed';
  return (
    <>
      {groupByDay(list).map((g) => {
        const unread = g.items.filter((i) => !i.is_read).length;
        return (
          <section class="day" key={g.key}>
            <header class="day-head">
              <span class="day-label">{g.label}</span>
              <span class="day-count">{g.items.length} 条{unread ? ` · ${unread} 未读` : ''}</span>
              {unread > 0 && <button class="link day-read" onClick={() => void markItemsRead(g.items)}>本组已读</button>}
            </header>
            {g.items.map((it) => <Line key={it.id} it={it} oneFeed={oneFeed} />)}
          </section>
        );
      })}
    </>
  );
}

const DIGEST_PREVIEW = 3;
const DIGEST_AI_MAX = 120;   // the server's per-request limit
const DIGEST_AUTO_MIN = 3;    // fewer lines than this read faster than any summary
const DIGEST_AUTO_CONCURRENCY = 2;

// Summaries already fetched this session, by block ids; the server caches them too, this only
// saves the round trip when a block is shown again.
const digestSummaries = new Map<string, string>();
let digestRunning = 0;
const digestQueue: (() => void)[] = [];

// At most a couple of summaries at once, so scrolling a long 简报 does not fire dozens of AI calls.
async function queuedDigest(ids: number[]): Promise<string> {
  if (digestRunning >= DIGEST_AUTO_CONCURRENCY) await new Promise<void>((go) => digestQueue.push(go));
  digestRunning++;
  try { return (await api.digest(ids)).summary; } finally { digestRunning--; digestQueue.shift()?.(); }
}

// 每日简报: one feed's day as a single block, titles folded. A block of a few lines or more is
// summed up by AI once it scrolls into view (when AI is on); the others on request. Opened on one
// feed (a podcast in the sidebar) every block shows in full; in a mixed list a block opens from its title.
function DigestCard({ b, oneFeed }: { b: DigestBlock<ListItem>; oneFeed: boolean }) {
  const [expanded, setExpanded] = useState(oneFeed);
  const [summary, setSummary] = useState<{ ids: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const f = b.feedId !== null ? feedsById.value.get(b.feedId) : undefined;
  const unread = b.items.filter((i) => !i.is_read).length;
  const ids = b.items.slice(0, DIGEST_AI_MAX).map((i) => i.id);
  const idsKey = ids.join(',');
  // A block opens by itself when j/k move onto one of its folded entries.
  const holdsSelected = b.items.slice(DIGEST_PREVIEW).some((i) => i.id === selectedId.value);
  const shown = expanded || holdsSelected ? b.items : b.items.slice(0, DIGEST_PREVIEW);
  const summarize = async (auto: boolean): Promise<void> => {
    setBusy(true);
    try {
      const text = digestSummaries.get(idsKey) ?? await queuedDigest(ids);
      digestSummaries.set(idsKey, text);
      setSummary({ ids: idsKey, text });
    } catch (e) {
      // An automatic run that fails leaves the button; only a click reports the error.
      if (!auto) notify((e as Error).message, true);
    }
    setBusy(false);
  };
  const auto = !!app.value?.settings.ai.enabled && !!app.value.hasAiKey && b.items.length >= DIGEST_AUTO_MIN;
  useEffect(() => {
    const el = ref.current;
    if (!auto || !el || summary?.ids === idsKey) return;
    const cached = digestSummaries.get(idsKey);
    if (cached) { setSummary({ ids: idsKey, text: cached }); return; }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); void summarize(true); }
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [auto, idsKey]);
  return (
    <section ref={ref} class={cx('digest', unread ? 'unread' : 'read')}>
      <header class="digest-head">
        {f && !oneFeed && <FeedIcon id={f.id} title={f.title} size={16} />}
        {oneFeed || !f
          ? <span class="digest-title">{b.day}</span>
          : <button class="digest-title link" title={expanded ? '收起这一块' : '展开这一块'} onClick={() => setExpanded(!expanded)}>{f.title}</button>}
        {!oneFeed && <span class="digest-day">{b.day}</span>}
        <span class="digest-count">{b.items.length} 条{unread ? ` · ${unread} 未读` : ''}</span>
        {/* Also up here: a long block's footer is a screen away. */}
        {unread > 0 && <button class="icon-btn digest-read-head" title="整块标为已读" onClick={() => void markItemsRead(b.items)}><Icon name="checks" size={15} /></button>}
      </header>
      {summary?.ids === idsKey
        ? <div class="digest-summary">{summary.text.split('\n').map((l, i) => <p key={i}>{l}</p>)}</div>
        : busy ? <div class="digest-summary pending">AI 归纳中…</div> : null}
      <div class="digest-lines">{shown.map((it) => <Line key={it.id} it={it} oneFeed />)}</div>
      <footer class="digest-foot">
        {b.items.length > DIGEST_PREVIEW && !(holdsSelected && !expanded) && (
          <button class="link" onClick={() => setExpanded(!expanded)}>{shown.length > DIGEST_PREVIEW ? '收起' : `展开其余 ${b.items.length - DIGEST_PREVIEW} 条`}</button>
        )}
        {summary?.ids !== idsKey && (
          <button class="link digest-ai" disabled={busy} onClick={() => void summarize(false)}>
            <Icon name="sparkles" size={12} /> {busy ? '归纳中…' : 'AI 归纳'}
          </button>
        )}
        {unread > 0 && <button class="link digest-read" onClick={() => void markItemsRead(b.items)}>整块已读</button>}
      </footer>
    </section>
  );
}

function DigestList({ list }: { list: ListItem[] }) {
  const oneFeed = selection.value.kind === 'feed';
  return <div class="digests">{groupDigest(list, oneFeed).map((b) => <DigestCard key={b.key} b={b} oneFeed={oneFeed} />)}</div>;
}

const SCROLL_READ_FLUSH_MS = 800;

// 滚过即读: an unread entry is marked read once it has left the list through the top edge.
// Marks go out in batches; anything still pending is sent when the list changes or unmounts.
function useScrollRead(scroller: { current: HTMLDivElement | null }, enabled: boolean, deps: unknown[]): void {
  useEffect(() => {
    const root = scroller.current;
    if (!enabled || !root) return;
    const pending = new Set<number>();
    let timer = 0;
    const flush = (): void => { timer = 0; const ids = [...pending]; pending.clear(); if (ids.length) void markIdsRead(ids); };
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        if (e.isIntersecting || !e.rootBounds || e.boundingClientRect.bottom > e.rootBounds.top) continue;
        for (const id of (e.target as HTMLElement).dataset.readIds?.split(',') ?? []) pending.add(Number(id));
        io.unobserve(e.target);
      }
      if (pending.size && !timer) timer = window.setTimeout(flush, SCROLL_READ_FLUSH_MS);
    }, { root });
    root.querySelectorAll<HTMLElement>('[data-read-ids]').forEach((el) => io.observe(el));
    return () => { io.disconnect(); if (timer) { clearTimeout(timer); flush(); } };
  }, [enabled, ...deps]);
}

// Picks the layout for what is on screen; the choice is kept on the feed or category itself.
function LayoutPicker() {
  const [isOpen, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const close = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isOpen]);
  const current = layout.value;
  const fallback = defaultLayout.value;
  const sel = selection.value;
  const where = sel.kind === 'feed' ? '这个源' : sel.kind === 'category' ? '这个分类' : '这个列表';
  // The whole list of a mode tab is shown in that mode; feeds are moved one by one.
  const fixed = sel.kind !== 'feed' && sel.kind !== 'category' && tab.value !== 'all';
  const choose = (next: Layout | null): void => { setOpen(false); void setLayout(next); };
  const label = (k: Layout): string => LAYOUTS.find((l) => l.key === k)?.label ?? k;
  return (
    <div class="layout-pick" ref={ref}>
      <button class="icon-btn" title={`显示方式：${label(current)}`} aria-haspopup="menu" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <Icon name={LAYOUTS.find((l) => l.key === current)?.icon ?? 'list'} />
      </button>
      {isOpen && (
        <div class="menu" role="menu">
          <div class="menu-head">{fixed
            ? `「${layoutLabel(current)}」里的源都按${layoutLabel(current)}显示；要换方式，点开某个源或分类再改`
            : sel.kind === 'feed' || sel.kind === 'category' ? `${where}的显示方式，改了它会移到对应的标签下` : `${where}的显示方式`}</div>
          {!fixed && LAYOUTS.map((l) => (
            <button key={l.key} role="menuitemradio" aria-checked={current === l.key} class={cx('menu-item', current === l.key && 'on')} onClick={() => choose(l.key)}>
              <Icon name={l.icon} size={15} />
              <span class="menu-text"><b>{l.label}</b><small>{l.hint}</small></span>
              {current === l.key && <Icon name="check" size={14} />}
            </button>
          ))}
          <button class="menu-item toggle" role="menuitemcheckbox" aria-checked={scrollRead.value}
            onClick={() => { setOpen(false); void setScrollRead(!scrollRead.value); }}>
            <span class={cx('switch', scrollRead.value && 'on')} aria-hidden="true" />
            <span class="menu-text"><b>滚过即读</b><small>滚出列表顶端的条目自动标为已读</small></span>
          </button>
          {!fixed && (
            <button class="menu-item reset" onClick={() => choose(null)}>
              <span class="menu-text"><b>恢复默认</b><small>跟随{sel.kind === 'feed' ? '分类或类型' : '类型'}：{label(fallback)}</small></span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function EntryList() {
  return isReports.value ? <ReportsView /> : isBooks.value ? <BooksView /> : isHot.value ? <HotView /> : isTocs.value ? <TocsView /> : isNotices.value ? <NoticesView /> : isMarks.value ? <MarksList /> : <Entries />;
}

function Entries() {
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) void loadMore(); }, { root: scroller.current, rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Keep the keyboard-selected row in view.
  useEffect(() => {
    scroller.current?.querySelector(`[data-id="${selectedId.value}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId.value]);

  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [selection.value, tab.value, query.value]);

  const list = items.value;
  const mode = layout.value;
  const wide = WIDE_LAYOUTS.has(mode);
  useScrollRead(scroller, scrollRead.value, [items.value, mode]);
  const unreadOnly = prefs.value.unreadOnly;
  const isStarred = selection.value.kind === 'starred';

  return (
    <section class={cx('list', wide && 'grid-mode', `layout-${mode}`)}>
      <header class="list-head">
        <div class="list-title">
          <h2>{heading()}</h2>
          {query.value && <span class="search-tag">搜索「{query.value}」<button onClick={() => { query.value = ''; void reloadList(); }}><Icon name="x" size={12} /></button></span>}
        </div>
        <div class="list-tools">
          <form class="search" role="search" onSubmit={(e) => { e.preventDefault(); const v = (e.currentTarget.elements.namedItem('q') as HTMLInputElement).value.trim(); query.value = v; void reloadList(); }}>
            <Icon name="search" size={14} />
            <input name="q" id="search" placeholder="搜索 /" title="空格分开的词都要出现；引号括起的算一个词组" defaultValue={query.value} key={query.value} autoComplete="off" />
          </form>
          {query.value && <SearchOrderToggle />}
          {!isStarred && !query.value && (
            <div class="seg" role="group" aria-label="筛选">
              <button class={cx(unreadOnly && 'on')} onClick={() => { setPrefs({ unreadOnly: true }); void reloadList(); }}>未读</button>
              <button class={cx(!unreadOnly && 'on')} onClick={() => { setPrefs({ unreadOnly: false }); void reloadList(); }}>全部</button>
            </div>
          )}
          {recAvailable.value && <SortToggle />}
          <LayoutPicker />
          <button class="icon-btn" title="全部标为已读 (Shift+A)" onClick={() => void markAllRead()} disabled={!list.some((i) => !i.is_read)}>
            <Icon name="checks" />
          </button>
        </div>
        {query.value && <SearchFilters />}
      </header>

      {sortMode.value === 'rec' && recMeta.value?.coldStart && (
        <p class="rec-cold">推荐还在起步：已有 {recMeta.value.signals} 条偏好信号，攒够 {recMeta.value.needed} 条之前先按新鲜度排。喜欢 <kbd>l</kbd>、收藏、存档、读完都算。</p>
      )}

      {newCount.value > 0 && (
        <button class="new-pill" onClick={() => void reloadList()}>有 {newCount.value}{newCount.value >= 40 ? '+' : ''} 篇新内容 · 点击刷新</button>
      )}

      <div class="list-scroll" ref={scroller}>
        {mode === 'masonry' ? <div class="tiles">{list.map((it) => <Tile key={it.id} it={it} />)}</div>
          : mode === 'cards' ? <div class="cards">{list.map((it) => <Card key={it.id} it={it} />)}</div>
          : mode === 'compact' ? <CompactList list={list} />
          : mode === 'digest' ? <DigestList list={list} />
          : mode === 'social' ? list.map((it) => <Post key={it.id} it={it} />)
          : list.map((it) => <Row key={it.id} it={it} />)}
        {!loading.value && list.length === 0 && (
          <div class="empty">
            <Icon name="checks" size={28} />
            <p>{query.value ? '没有匹配的文章' : unreadOnly && !isStarred ? '全部读完了' : '这里还没有内容'}</p>
            {unreadOnly && !isStarred && !query.value && <button class="link" onClick={() => { setPrefs({ unreadOnly: false }); void reloadList(); }}>查看已读文章</button>}
          </div>
        )}
        {!loading.value && list.length === 0 && unreadOnly && !isStarred && !query.value && <RecentRead social={mode === 'social'} />}
        <div ref={sentinel} class="sentinel">{loading.value ? <span class="spinner" /> : !hasMore.value && list.length > 0 ? <span class="end">— 到底了 —</span> : null}</div>
      </div>
    </section>
  );
}
