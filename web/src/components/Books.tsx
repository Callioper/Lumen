// 书单 books: the card in the reader above a 书单 post, and 新书, every such post's books as a waterfall.
import { signal } from '@preact/signals';
import { Fragment } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, type BookFrom, type BookReprint, type NewBook, type ListedBook, type Count, type MonthCount } from '../api.ts';
import { app, open, notify, detail, prefs as appPrefs } from '../store.ts';
import { wishNote } from './BookPage.tsx';
import { FeedIcon } from './Icon.tsx';
import { EditionList } from './Editions.tsx';
import { cx, proxied } from '../util.ts';
import { DeskHas, isWished, noteWished } from '../wishes.ts';
import { useDesk } from '../extras.ts';

const BOOKS_FOLDED = 6;

// 想读 marked (or being marked) in this session, by the book's key; the server's `wished` covers the rest.
const wishing = signal<Record<string, 'busy' | 'done'>>({});
const keyOf = (b: ListedBook): string => b.subject || b.isbn || b.title;

export const doubanLink = (b: ListedBook): string =>
  b.subject ? `https://book.douban.com/subject/${b.subject}/`
    : b.isbn ? `https://book.douban.com/isbn/${b.isbn}/`
      : `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(b.title)}`;

async function wish(b: ListedBook): Promise<void> {
  const k = keyOf(b);
  wishing.value = { ...wishing.value, [k]: 'busy' };
  try {
    const r = await api.wish(b);
    wishing.value = { ...wishing.value, [k]: 'done' };
    noteWished(r.subject);
    notify(wishNote('想读', r.synced, b.title));
  } catch (e) {
    const { [k]: _, ...rest } = wishing.value;
    wishing.value = rest;
    notify((e as Error).message, true);
  }
}

// Marked already: from Lumen (here or on another page, by subject), on the reader's own 豆瓣, or on the 想读台.
export function WishButton({ b }: { b: ListedBook }) {
  const onDesk = useContext(DeskHas);
  if (b.mine) return <span class="book-wished" title="你在豆瓣上的标记">我{b.mine}</span>;
  const state = b.wished || isWished(b.subject) || (!!b.subject && onDesk(b.subject)) ? 'done' : wishing.value[keyOf(b)];
  if (state === 'done') return <span class="book-wished">已想读</span>;
  return (
    <button class="book-wish" disabled={state === 'busy'} onClick={(e) => { e.stopPropagation(); void wish(b); }} title={app.value?.doubanSync ? '在豆瓣标记想读（公开，不发广播）' : '记为想读（记在 Lumen 里）'}>
      {state === 'busy' ? '标记中…' : '想读'}
    </button>
  );
}

// Who wrote it, who translated it, who published it and when: each on a line of its own, so a
// missing one shows as missing instead of a gap in one grey run.
const TRANSLATOR_ROLE = /(?:译|翻译|译注|审校|校)$/;
function BookFacts({ b }: { b: ListedBook }) {
  const translators = b.translators && !TRANSLATOR_ROLE.test(b.translators) ? `${b.translators} 译` : b.translators;
  if (!b.authors && !translators && !b.publisher && !b.date) return null;
  return (
    <div class="book-facts">
      {b.authors && <p class="book-author">{b.authors}</p>}
      {translators && <p class="book-translator">{translators}</p>}
      {(b.publisher || b.date) && (
        <p class="book-pub">{b.publisher && <span>{b.publisher}</span>}{b.date && <time>{b.date}</time>}</p>
      )}
    </div>
  );
}

function BookRow({ b: listed }: { b: ListedBook }) {
  const [b, ref] = useDoubanDetails(listed);
  return (
    <li class={cx('book', b.inZotero && 'owned')} ref={ref}>
      {b.cover ? <img src={proxied(b.cover)} alt="" loading="lazy" /> : <span class="book-nocover" />}
      <div>
        <div class="book-head">
          <a class="book-title" href={doubanLink(b)} target="_blank" rel="noopener noreferrer">{b.title}</a>
          {b.inZotero && <span class="book-owned">已在库</span>}
          <WishButton b={b} />
        </div>
        <BookFacts b={b} />
        {b.blurb && <p class="book-blurb">{b.blurb}</p>}
      </div>
    </li>
  );
}

// In the reader, above the text of a 书单 post (or of a 关注书单 broadcast, whose 豆列 is fetched now).
export function BookList({ id }: { id: number }) {
  const [state, setState] = useState<{ books: ListedBook[]; error?: string; loading: boolean }>({ books: [], loading: true });
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    setState({ books: [], loading: true }); setAll(false);
    api.books(id).then((r) => { if (live) setState({ books: r.books, error: r.error, loading: false }); },
      () => { if (live) setState({ books: [], loading: false }); });
    return () => { live = false; };
  }, [id]);
  const { books, error } = state;
  // Before the returns below: a hook is called on every render.
  const desk = useDesk(books.flatMap((b) => (b.subject ? [b.subject] : [])));
  if (error) return <p class="books-error">书单没取到：{error}</p>;
  if (!books.length) return null;
  const have = books.filter((b) => b.inZotero).length;
  const shown = all ? books : books.slice(0, BOOKS_FOLDED);
  return (
    <DeskHas.Provider value={desk.has}>
    <section class="books" aria-label="书单">
      <h3>书单 · {books.length} 本{books[0].inZotero === null ? <span class="muted"> · Zotero 库读不了，未查库</span> : have > 0 && <span> · 库中已有 {have}</span>}</h3>
      <ol>{shown.map((b) => <BookRow key={keyOf(b)} b={b} />)}</ol>
      {books.length > BOOKS_FOLDED && <button class="linkish" onClick={() => setAll(!all)}>{all ? '收起' : `展开全部 ${books.length} 本`}</button>}
    </section>
    </DeskHas.Provider>
  );
}

// A book its post leaves the cover, date, author or publisher out of asks 豆瓣 when it comes into
// view: one ask at a time, a little apart, and none more once 豆瓣 has refused one. The server keeps
// what it finds, so the next look costs nothing.
const DOUBAN_GAP_MS = 1200;
let detailsQueue: Promise<unknown> = Promise.resolve();
let doubanRefused = false;

const lacksDetails = (b: ListedBook): boolean => !b.cover || !b.date || !b.authors || !b.publisher;

// A tile scrolled past while waiting its turn gives the turn up, and queues again when it comes back.
const NEAR_VIEW_PX = 300;
const nearView = (el: HTMLElement): boolean => {
  const r = el.getBoundingClientRect();
  return r.bottom > -NEAR_VIEW_PX && r.top < innerHeight + NEAR_VIEW_PX;
};

function useDoubanDetails(listed: ListedBook): [ListedBook, (el: HTMLElement | null) => void] {
  const [b, setB] = useState<ListedBook>(listed);
  const [asked, setAsked] = useState(false);
  const [rearm, setRearm] = useState(0);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setB(listed); setAsked(false); }, [listed]);
  useEffect(() => {
    if (asked || !lacksDetails(b) || !el || doubanRefused) return;
    let live = true;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      detailsQueue = detailsQueue.then(async () => {
        if (!live || doubanRefused) return;
        if (!nearView(el)) { setRearm((n) => n + 1); return; }
        const r = await api.bookDetails(b).catch(() => null);
        if (r?.error) doubanRefused = true;
        if (live) {
          setAsked(true);
          if (r && !r.error) setB((old) => ({ ...old, cover: old.cover ?? r.cover ?? null, date: old.date || r.date || '',
            authors: old.authors || r.authors || '', publisher: old.publisher || r.publisher || '', subject: old.subject ?? r.subject ?? null }));
        }
        if (r?.fetched) await new Promise((ok) => setTimeout(ok, DOUBAN_GAP_MS));
      });
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [el, asked, b, rearm]);
  return [b, setEl];
}

// 人大复印 took up an article about this book, or one by its author: which, on hover.
function ReprintBadge({ r, class: cls }: { r: BookReprint; class: string }) {
  const tip = [r.review && `书评／研究：${r.review.title}\n${r.review.label}全文转载`,
    r.author && `作者 ${r.author.name} 的文章《${r.author.title}》\n${r.author.label}全文转载（按姓名对上，同名者也会对上）`].filter(Boolean).join('\n\n');
  return <span class={cls} title={tip}>{r.review ? '人大复印·书评' : '人大复印·作者'}</span>;
}

function BookTile({ b: listed, from, posts, reprint }: { b: ListedBook; from: BookFrom; posts: number; reprint?: BookReprint }) {
  const [b, ref] = useDoubanDetails(listed);
  const [editions, setEditions] = useState(false);
  return (
    <article class={cx('book-tile', b.inZotero && 'owned', !b.cover && 'bare')} ref={ref}>
      {b.cover && (
        <a class="book-tile-cover" href={doubanLink(b)} target="_blank" rel="noopener noreferrer" tabIndex={-1}>
          <img src={proxied(b.cover)} alt="" loading="lazy" />
        </a>
      )}
      <div class="book-tile-body">
        <a class="book-title" href={doubanLink(b)} target="_blank" rel="noopener noreferrer">{b.title}</a>
        <BookFacts b={b} />
        {b.blurb && <p class="book-blurb">{b.blurb}</p>}
        <div class="book-tile-foot">
          {b.inZotero && <span class="book-owned">已在库</span>}
          {reprint && <ReprintBadge r={reprint} class="book-reprint" />}
          {b.subject && <button class={cx('book-editions-toggle', editions && 'on')} onClick={() => setEditions(!editions)}>其他版本</button>}
          <WishButton b={b} />
        </div>
        {editions && b.subject && <EditionList subject={b.subject} titled={false} />}
        <button class={cx('book-from', detail.value?.id === from.id && 'on')} onClick={() => void openPost(from)} title={`${from.feed} · ${from.title}`}>
          <FeedIcon id={from.feedId} title={from.feed} size={12} /><span>{from.title}</span>
          {posts > 1 && <em class="book-posts" title="这本书在几份书单里都出现过，只列一次，链接到最新的那份">{posts} 份书单都推荐</em>}
        </button>
      </div>
    </article>
  );
}

// The cover wall's book: the cover, the title and the author; the rest on hover (and on 豆瓣).
function BookCover({ b: listed, from, posts, reprint }: { b: ListedBook; from: BookFrom; posts: number; reprint?: BookReprint }) {
  const [b, ref] = useDoubanDetails(listed);
  const hover = [b.title, b.authors, [b.publisher, b.date].filter(Boolean).join(' · '), b.blurb,
    `书单：${from.title}${posts > 1 ? `（${posts} 份书单都推荐）` : ''}`].filter(Boolean).join('\n');
  return (
    <article class={cx('book-cover', b.inZotero && 'owned')} ref={ref}>
      <a class="book-cover-img" href={doubanLink(b)} target="_blank" rel="noopener noreferrer" title={hover}>
        {b.cover ? <img src={proxied(b.cover)} alt="" loading="lazy" /> : <span class="book-cover-blank">{b.title}</span>}
        {b.inZotero && <span class="book-owned">已在库</span>}
        {posts > 1 && <span class="book-cover-posts">{posts} 份书单</span>}
        {reprint && <ReprintBadge r={reprint} class="book-reprint on-cover" />}
      </a>
      <div class="book-cover-wish"><WishButton b={b} /></div>
      <a class="book-cover-title" href={doubanLink(b)} target="_blank" rel="noopener noreferrer" title={hover}>{b.title}</a>
      {b.authors && <p class="book-cover-author">{b.authors}</p>}
    </article>
  );
}

const keyOfTile = (b: ListedBook): string => b.isbn || b.subject || b.title.replace(/\s+/g, '');

// 新书: the books of every 书单 post as one waterfall, newest post first; a book in several lists shows once.
async function openPost(p: BookFrom): Promise<void> {
  try {
    const it = await api.entry(p.id);
    await open(it, { listScope: 'books', sortMode: 'latest', position: 0 });
  } catch (e) {
    notify((e as Error).message, true);
  }
}

// How 新书 is ordered and narrowed, kept per browser; a storage that cannot be read gives the defaults.
// dense: the cover wall (covers, titles and authors, many to a row) rather than the cards with blurbs.
// kind: 虚构 / 非虚构 / 学术 / 童书 / 其他 (server bookkinds.ts), topic: the field within it; shelves:
// each month cut by 主题 into shelves of a handful of books (server bookshelves.ts).
interface BooksPrefs { byDate: boolean; recent: boolean; notOwned: boolean; topic: string; kind: string; dense: boolean; shelves: boolean }
// v2: by date became the default (2026-10-24); a choice kept under the old key is read but its order is not.
const PREFS_KEY = 'lumen.books.prefs.v2';
const OLD_PREFS_KEY = 'lumen.books.prefs';
const RECENT_MONTHS = 3;
const TOPIC_POLL_MS = 20_000;
function loadPrefs(): BooksPrefs {
  const fallback = { byDate: true, recent: false, notOwned: false, topic: '', kind: '', dense: true, shelves: true };
  try {
    const kept = localStorage.getItem(PREFS_KEY);
    if (kept) return { ...fallback, ...JSON.parse(kept) as Partial<BooksPrefs> };
    return { ...fallback, ...JSON.parse(localStorage.getItem(OLD_PREFS_KEY) ?? '{}') as Partial<BooksPrefs>, byDate: true };
  } catch { return fallback; }
}
function savePrefs(p: BooksPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* the choice just is not remembered */ }
}

// The waterfall deals its books out row by row, so it reads left to right in the order given; CSS
// columns would fill the first column top to bottom before the next.
const TILE_MIN_PX = 210;
const TILE_GAP_PX = 14;
function useColumnCount(): [number, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [count, setCount] = useState(4);
  useLayoutEffect(() => {
    if (!el) return;
    const fit = (): void => setCount(Math.max(1, Math.floor((el.clientWidth + TILE_GAP_PX) / (TILE_MIN_PX + TILE_GAP_PX))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [count, setEl];
}

// 「2026年10月」 → 「10月」 this year, 「25年3月」 before; 更早出版, 出版时间待查 and the 推送 months as they are.
const THIS_YEAR = new Date().getFullYear();
function shortMonth(label: string): string {
  const m = /^(\d{4})年(\d{1,2})月$/.exec(label);
  if (!m) return label.replace(/推送$/, '');
  return Number(m[1]) === THIS_YEAR ? `${m[2]}月` : `${m[1].slice(2)}年${m[2]}月`;
}

// 新书: every listed book once, as a cover wall or a waterfall; the server orders, narrows and pages it.
export function BooksView() {
  const [prefs, setPrefs] = useState<BooksPrefs>(loadPrefs);
  const [items, setItems] = useState<NewBook[]>([]);
  const [total, setTotal] = useState<{ books: number; posts: number } | null>(null);
  const [months, setMonths] = useState<MonthCount[]>([]);
  const [jump, setJump] = useState<string | null>(null);   // a month asked for, scrolled to once it is on the page
  const [here, setHere] = useState<string | null>(null);   // the month at the top of the view
  const [topics, setTopics] = useState<{ list: Count[]; kinds: Count[]; classifying: number }>({ list: [], kinds: [], classifying: 0 });
  const [dating, setDating] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const asked = useRef(0);               // the newest request: an answer to an older one is dropped
  const ask = (offset: number, limit?: number) => ({ offset, limit, byDate: prefs.byDate, recentMonths: prefs.recent ? RECENT_MONTHS : 0, notOwned: prefs.notOwned, topic: prefs.topic, kind: prefs.kind, shelves: prefs.shelves, reprintsAll: appPrefs.value.reprintsAll });
  const loadMore = async (offset: number, limit?: number): Promise<void> => {
    const n = ++asked.current;
    setLoadingMore(true);
    try {
      const r = await api.newBooks(ask(offset, limit));
      if (n !== asked.current) return;
      setItems((old) => [...old.slice(0, offset), ...r.books]);
      setTotal({ books: r.total, posts: r.posts });
      setMonths(r.months ?? []);
      setTopics({ list: r.topics, kinds: r.kinds, classifying: r.sorting });
      setDating(r.dating);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      if (n === asked.current) setLoadingMore(false);
    }
  };
  useEffect(() => {
    savePrefs(prefs);
    setItems([]); setTotal(null); setJump(null);
    scroller.current?.scrollTo({ top: 0 });
    void loadMore(0);
  }, [prefs.byDate, prefs.recent, prefs.notOwned, prefs.topic, prefs.kind, prefs.shelves]);
  // While books are being classified, the chips are refreshed; the loaded list is left alone.
  useEffect(() => {
    if (!topics.classifying) return;
    const t = setTimeout(() => {
      api.newBooks(ask(0))
        .then((r) => setTopics({ list: r.topics, kinds: r.kinds, classifying: r.sorting })).catch(() => setTopics((x) => ({ ...x, classifying: 0 })));
    }, TOPIC_POLL_MS);
    return () => clearTimeout(t);
  }, [topics]);
  // While dates are being looked up, the count is asked again now and then; the list moves only when the reader says so.
  useEffect(() => {
    if (!dating) return;
    const t = setTimeout(() => {
      api.newBooks(ask(0))
        .then((r) => setDating(r.dating)).catch(() => setDating(0));
    }, TOPIC_POLL_MS);
    return () => clearTimeout(t);
  }, [dating]);
  const [datedAt, setDatedAt] = useState(0);
  useEffect(() => { if (dating) setDatedAt(dating); }, [dating]);
  const reload = (): void => { setItems([]); setTotal(null); setDatedAt(0); scroller.current?.scrollTo({ top: 0 }); void loadMore(0); };
  useEffect(() => {
    if (!sentinel.current) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !loadingMore && total !== null && items.length < total.books) void loadMore(items.length);
    }, { rootMargin: '800px' });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [items.length, total, loadingMore]);
  // To a month: the books up to its end are loaded first if they are not yet (the months come in
  // order with their counts, so where it starts is known).
  const jumpTo = (label: string): void => {
    const at = months.findIndex((m) => m.label === label);
    if (at < 0) return;
    const end = months.slice(0, at + 1).reduce((n, m) => n + m.n, 0);
    if (items.length < end - months[at].n + 1 && !loadingMore) void loadMore(items.length, end - items.length);
    setJump(label);
  };
  useEffect(() => {
    if (!jump) return;
    const el = scroller.current?.querySelector(`[data-month="${CSS.escape(jump)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    setJump(null);
  }, [jump, items]);
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const look = (): void => {
      const top = box.getBoundingClientRect().top + 48;   // a heading just scrolled to counts as here
      let cur: string | null = null;
      for (const el of box.querySelectorAll<HTMLElement>('[data-month]')) { if (el.getBoundingClientRect().top <= top) cur = el.dataset.month ?? null; else break; }
      setHere(cur ?? months[0]?.label ?? null);
    };
    look();
    box.addEventListener('scroll', look, { passive: true });
    return () => box.removeEventListener('scroll', look);
  }, [items.length, months]);
  const toggle = (k: keyof BooksPrefs): void => setPrefs((p) => ({ ...p, [k]: !p[k] }));
  const desk = useDesk([...new Set(items.flatMap((it) => (it.book.subject ? [it.book.subject] : [])))]);
  const [columns, tilesRef] = useColumnCount();
  // One section per month (the books' month by date, the 书单's by post), each dealt into the columns on its own.
  const sections: { label: string | null; items: NewBook[] }[] = [];
  for (const it of items) {
    const label = it.month ?? null;
    const last = sections.at(-1);
    if (last && last.label === label) last.items.push(it); else sections.push({ label, items: [it] });
  }
  const deal = (list: NewBook[]): NewBook[][] => Array.from({ length: columns }, (_, c) => list.filter((_, i) => i % columns === c));
  const books = (list: NewBook[]) => (prefs.dense
    ? <div class="book-wall">{list.map(({ book, from, posts, reprint }) => <BookCover key={`${from.id}:${keyOfTile(book)}`} b={book} from={from} posts={posts} reprint={reprint} />)}</div>
    : <div class="book-tiles" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {deal(list).map((column, c) => (
        <div class="book-column" key={c}>{column.map(({ book, from, posts, reprint }) => <BookTile key={`${from.id}:${keyOfTile(book)}`} b={book} from={from} posts={posts} reprint={reprint} />)}</div>
      ))}
    </div>);
  // A month's books shelf by shelf, as the server put them; a month not cut is one run.
  const shelvesIn = (list: NewBook[]): { label: string; items: NewBook[] }[] => {
    const out: { label: string; items: NewBook[] }[] = [];
    for (const it of list) { const last = out.at(-1); if (last && last.label === (it.shelf ?? '')) last.items.push(it); else out.push({ label: it.shelf ?? '', items: [it] }); }
    return out;
  };

  return (
    <DeskHas.Provider value={desk.has}>
    <section class="list books-page">
      <header class="list-head">
        <div class="list-title"><h2>新书</h2>{total !== null && <span class="muted">{total.books} 本 · 来自 {total.posts} 份书单</span>}
          {prefs.byDate && (dating > 0
            ? <span class="muted book-dating" title="书单没写出版时间的书，按 ISBN 在豆瓣查，每隔几秒查一本">还有 {dating} 本在查出版时间</span>
            : datedAt > 0 && <button class="linkish book-dating" onClick={reload}>出版时间查好了，重新排列</button>)}
        </div>
        <div class="list-tools">
          <div class="seg" role="group" aria-label="排序">
            <button class={cx(!prefs.byDate && 'on')} aria-pressed={!prefs.byDate} onClick={() => prefs.byDate && toggle('byDate')} title="最新推送的书单在前">按书单</button>
            <button class={cx(prefs.byDate && 'on')} aria-pressed={prefs.byDate} onClick={() => !prefs.byDate && toggle('byDate')} title="出版时间最近的在前，不知道时间的排最后">按出版时间</button>
          </div>
          <div class="seg" role="group" aria-label="版式">
            <button class={cx(prefs.dense && 'on')} aria-pressed={prefs.dense} onClick={() => !prefs.dense && setPrefs((p) => ({ ...p, dense: true }))} title="一行十来本，只看封面、书名和作者；鼠标停在封面上看简介">封面墙</button>
            <button class={cx(!prefs.dense && 'on')} aria-pressed={!prefs.dense} onClick={() => prefs.dense && setPrefs((p) => ({ ...p, dense: false }))} title="大卡片，带简介、其他版本和来自哪份书单">卡片</button>
          </div>
          <button class={cx('btn small', prefs.recent && 'primary')} aria-pressed={prefs.recent} onClick={() => toggle('recent')}
            title={`只看近 ${RECENT_MONTHS} 个月出版的；还不知道出版时间的照样显示`}>近三个月</button>
          <button class={cx('btn small', prefs.shelves && 'primary')} aria-pressed={prefs.shelves} onClick={() => toggle('shelves')}
            title="每个月里再按主题分组；书少的主题并进大类（文学、社会科学……），再少的归「其余」">按主题分组</button>
          {app.value?.hasZotero !== false && <button class={cx('btn small', prefs.notOwned && 'primary')} aria-pressed={prefs.notOwned} onClick={() => toggle('notOwned')} title="隐藏 Zotero 里已有的书">只看未在库</button>}
        </div>
      </header>
      {topics.kinds.length > 0 && (
        <nav class="book-kinds" aria-label="按类型">
          <span class="book-kinds-label">类型</span>
          <div class="seg">
            <button class={cx(!prefs.kind && 'on')} aria-pressed={!prefs.kind} onClick={() => setPrefs((p) => ({ ...p, kind: '', topic: '' }))}>全部</button>
            {topics.kinds.map((k) => (
              <button key={k.label} class={cx(prefs.kind === k.label && 'on')} aria-pressed={prefs.kind === k.label}
                onClick={() => setPrefs((p) => ({ ...p, kind: p.kind === k.label ? '' : k.label, topic: '' }))}>{k.label}<small>{k.n}</small></button>
            ))}
          </div>
        </nav>
      )}
      {(topics.list.length > 0 || topics.classifying > 0) && (
        <nav class="book-topics" aria-label="按主题">
          <span class="book-kinds-label">主题</span>
          <button class={cx('chip', !prefs.topic && 'active')} aria-pressed={!prefs.topic} onClick={() => setPrefs((p) => ({ ...p, topic: '' }))}>全部</button>
          {topics.list.map((t) => (
            <button key={t.label} class={cx('chip', prefs.topic === t.label && 'active')} aria-pressed={prefs.topic === t.label}
              onClick={() => setPrefs((p) => ({ ...p, topic: p.topic === t.label ? '' : t.label }))}>{t.label}<small>{t.n}</small></button>
          ))}
          {topics.classifying > 0 && <span class="muted book-topics-note" title="类型和主题都由 AI 读书名、作者、出版社和简介，按豆瓣读书的分法归类">还有 {topics.classifying} 本在归类</span>}
        </nav>
      )}
      {months.length > 1 && (
        <nav class="book-month-nav" aria-label="按月份跳转">
          {months.map((m) => (
            <button key={m.label} class={cx('chip', here === m.label && 'active')} aria-current={here === m.label || undefined} onClick={() => jumpTo(m.label)}>
              {shortMonth(m.label)}<small>{m.n}</small>
            </button>
          ))}
        </nav>
      )}
      <div class="list-scroll books-scroll" ref={scroller}>
        {total?.books === 0 && <p class="muted empty">{prefs.recent || prefs.notOwned || prefs.topic || prefs.kind ? '没有符合条件的书。' : '还没有书单推送。'}</p>}
        <div ref={tilesRef}>
          {sections.map((sec, si) => (
            <section class="book-section" key={sec.label ?? si}>
              {sec.label && <h3 class="book-month" data-month={sec.label}>{sec.label}<small>{months.find((m) => m.label === sec.label)?.n ?? sec.items.length} 本</small></h3>}
              {shelvesIn(sec.items).map((sh) => {
                if (!sh.label) return <Fragment key="">{books(sh.items)}</Fragment>;
                const s = months.find((m) => m.label === sec.label)?.shelves?.find((x) => x.label === sh.label);
                // The 主题 on it, unless its name already says them all.
                const more = s && s.topics.join('·') !== s.label ? s.topics.join('、') : '';
                return (
                  <div class="book-shelf" key={sh.label}>
                    <h4 class="book-shelf-head">{sh.label}<small>{s?.n ?? sh.items.length} 本</small>{more && <span class="book-shelf-topics">{more}</span>}</h4>
                    {books(sh.items)}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <div ref={sentinel} class="books-sentinel">{loadingMore && <span class="spinner sm" />}</div>
      </div>
    </section>
    </DeskHas.Provider>
  );
}
