import { signal, computed, batch, effect } from '@preact/signals';
import { startView, endView, type ViewContext } from './reading.ts';
import { entryShare, type ShareData } from './share/data.ts';
import type { CardStyle } from './share/ShareCard.tsx';
import { cardPng, copyPng } from './share/render.ts';
import { api, type Reaction, type JobsState, type AppState, type EntryDetail, type ListItem, type RecMeta, type Scope, type Feed, type MarkGroup, type Layout } from './api.ts';
import { resolveLayout, inheritedLayout, layoutTarget, resolveScrollRead, scrollReadKey, displayOrder, effectiveLayout, OPEN_BESIDE_LAYOUTS, type Tab } from './layout.ts';
import { keepReadTrail, noteRead, isForeignText } from './util.ts';
import type { PaletteKey } from './themes.ts';

export type Selection =
  | { kind: 'all' } | { kind: 'starred' } | { kind: 'marks' } | { kind: 'reports' } | { kind: 'books' } | { kind: 'hot' } | { kind: 'tocs' } | { kind: 'notices' } | { kind: 'social' }
  | { kind: 'feed'; id: number } | { kind: 'category'; id: number } | { kind: 'tag'; name: string };

const PAGE = 40;
const PREFS_KEY = 'lumen.prefs';

interface Prefs {
  unreadOnly: boolean; serif: boolean; theme: 'system' | 'light' | 'dark'; fontSize: number; collapsed: number[];
  catsOpen: boolean;                 // the sidebar's categories open by default (settings: 分类)
  catFlip: number[];                 // the ones the reader opened or closed against that default
  layouts: Record<string, Layout>;   // for lists that are not one feed or category (所有文章, a tag, 收藏)
  scrollRead: Record<string, boolean>;
  trView: TrView;                    // how a translated entry is shown
  sortModes: Record<string, SortMode>;   // per list, see sortKey()
  searchOrder: SearchOrder;
  markKind: MarkKind;                // which of 书·影·音·其他 the 书影音标记 page shows
  marksTr: TrView;                   // how 书影音标记 shows a foreign title or comment
  trDefault?: number;                // see loadPrefs
  marksUnreadOnly: boolean;          // 书影音标记's own 未读 / 近 30 天, apart from the lists' 未读 / 全部
  reprintsAll?: boolean;             // 人大复印: every 复印 journal, not only the humanities' (settings: 人大复印)
  palette?: PaletteKey;              // 配色 (settings: 外观); none is the default, 纸墨
}
export type MarkKind = 'all' | 'book' | 'movie' | 'music' | 'other';
export type SearchOrder = 'relevance' | 'latest' | 'semantic';
export type SortMode = 'latest' | 'rec';
export type TrView = 'translation' | 'bilingual' | 'original';
const DEFAULT_PREFS: Prefs = { unreadOnly: true, serif: false, theme: 'system', fontSize: 17, collapsed: [], catsOpen: false, catFlip: [], layouts: {}, scrollRead: {}, trView: 'bilingual', sortModes: {}, searchOrder: 'relevance', markKind: 'book', marksUnreadOnly: true, marksTr: 'bilingual', trDefault: 2 };

// trDefault: 2 once 对照 became the default for translations (2026-10-24); a choice kept from before is
// moved to it once, a choice made after is kept.
function loadPrefs(): Prefs {
  try {
    const kept = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    // 未读 is where every view starts: a switch to 全部 / 近 30 天 lasts the visit, not the next one.
    return { ...DEFAULT_PREFS, ...kept, ...(kept.trDefault !== 2 && { trView: 'bilingual', trDefault: 2 }), unreadOnly: true, marksUnreadOnly: true };
  } catch { return DEFAULT_PREFS; }
}

export const prefs = signal<Prefs>(loadPrefs());
// Whether a sidebar category is open: the default, unless the reader turned that one the other way.
export const catOpen = (id: number): boolean => prefs.value.catsOpen !== prefs.value.catFlip.includes(id);
export function toggleCat(id: number): void {
  const flip = prefs.value.catFlip;
  setPrefs({ catFlip: flip.includes(id) ? flip.filter((x) => x !== id) : [...flip, id] });
}
export function setPrefs(patch: Partial<Prefs>): void {
  prefs.value = { ...prefs.value, ...patch };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value)); } catch { /* private mode */ }
}

export const app = signal<AppState | null>(null);
// The sidebar tab: 全部 or one display mode (only the feeds shown that way).
export const tab = signal<Tab>('all');
export const selection = signal<Selection>({ kind: 'all' });
export const query = signal('');
// A search's own filters, kept while searching and dropped with the query.
export type SearchSince = 'any' | 'week' | 'month' | 'year';
export const SINCE_DAYS: Record<Exclude<SearchSince, 'any'>, number> = { week: 7, month: 30, year: 365 };
export const searchSince = signal<SearchSince>('any');
export const searchKept = signal<'' | 'starred' | 'archived'>('');
effect(() => { if (!query.value) batch(() => { searchSince.value = 'any'; searchKept.value = ''; }); });
export const items = signal<ListItem[]>([]);
export const hasMore = signal(true);
export const loading = signal(false);
export const selectedId = signal<number | null>(null);
export const detail = signal<EntryDetail | null>(null);
export const newCount = signal(0);
export interface ToastAction { label: string; run: () => void }
export const toast = signal<{ text: string; error?: boolean; action?: ToastAction } | null>(null);
export const settingsOpen = signal<null | 'feeds' | 'add' | 'ai' | 'clip' | 'fetch' | 'data' | 'look' | 'profile'>(null);
export const editFeedId = signal<number | null>(null);
// The sidebar as a drawer on a phone, where it has no room of its own; it closes once a page is picked.
export const navOpen = signal(false);
effect(() => { void selection.value; void settingsOpen.value; navOpen.value = false; });

// Douban 想读/看过 marks grouped by subject (selection kind 'marks').
export const markGroups = signal<MarkGroup[]>([]);
// The Chinese of 书影音标记's foreign texts, by the text; filled from each answer and, as the server
// translates more, from /api/snippets.
export const snipTr = signal<Record<string, string>>({});
let snipAt = 0;
export function addTr(r: { tr?: Record<string, string>; trAt?: number }): void {
  if (r.trAt) snipAt = Math.max(snipAt, r.trAt);
  if (r.tr && Object.keys(r.tr).length) snipTr.value = { ...snipTr.value, ...r.tr };
}
async function fetchNewTr(): Promise<void> {
  try { addTr(await api.snippets(Math.max(0, snipAt - 5))); } catch { /* the next event tries again */ }
}
export const selectedMark = signal<string | null>(null);
// 喜欢读的人也喜欢: the books opened from a card's page, one over another; the last is shown.
export const subjectTrail = signal<{ kind: 'book' | 'movie'; subject: string }[]>([]);
// The 豆瓣 link of the card unfolded on the 书影音 board (MarksOverview): Space opens it while no card is open.
export const boardOpen = signal<{ key: string; sec: string; url: string | null } | null>(null);
// Esc / Backspace / ← 返回: out of a book opened from another's page, else out of the card to the board,
// else the card unfolded on the board folds.
export function marksBack(): boolean {
  if (subjectTrail.value.length) { subjectTrail.value = subjectTrail.value.slice(0, -1); return true; }
  if (selectedMark.value) { selectedMark.value = null; return true; }
  if (boardOpen.value) { boardOpen.value = null; return true; }
  return false;
}
// Straight back to the board (书影音标记's home, the overview on the right), from however deep (h).
export function marksHome(): void {
  batch(() => { subjectTrail.value = []; selectedMark.value = null; boardOpen.value = null; });
}
// Games and marks whose subject could not be told apart go together under 其他.
export const markKindOf = (g: Pick<MarkGroup, 'kind'>): MarkKind => (g.kind === 'game' ? 'other' : g.kind);
export const visibleMarks = computed<MarkGroup[]>(() => {
  const k = prefs.value.markKind;
  return k === 'all' ? markGroups.value : markGroups.value.filter((g) => markKindOf(g) === k);
});
export const isMarks = computed(() => selection.value.kind === 'marks');
// 报告 (selection kind 'reports'): the page keeps its own state in reports.ts and registers how j/k step.
export const isReports = computed(() => selection.value.kind === 'reports');
let reportStep: ((delta: 1 | -1) => void) | null = null;
export const setReportStep = (fn: ((delta: 1 | -1) => void) | null): void => { reportStep = fn; };
// 新书 (selection kind 'books'): the books of every 书单 post, kept in books.ts.
export const isBooks = computed(() => selection.value.kind === 'books');
// 热点 (selection kind 'hot'): a page of its own like 新书, not a list of entries.
export const isHot = computed(() => selection.value.kind === 'hot');
// 期刊目录 and 学术动态 (kinds 'tocs', 'notices'): pages of their own too.
export const isTocs = computed(() => selection.value.kind === 'tocs');
export const isNotices = computed(() => selection.value.kind === 'notices');
// A page that is not a list of entries: nothing to step through, mark read or check for new.
export const isPage = computed(() => isBooks.value || isHot.value || isTocs.value || isNotices.value);

export const feedsById = computed(() => new Map((app.value?.feeds ?? []).map((f) => [f.id, f])));

export function notify(text: string, error = false, action?: ToastAction): void {
  toast.value = { text, error, action };
  setTimeout(() => { if (toast.value?.text === text) toast.value = null; }, error ? 6000 : action ? 5000 : 2500);
}

export function scope(): Scope {
  const s = selection.value;
  // A search looks through everything read or not: what was read is what one goes back for.
  const sc: Scope = { filter: s.kind === 'starred' ? 'starred' : prefs.value.unreadOnly && !query.value ? 'unread' : 'all', q: query.value || undefined };
  if (tab.value !== 'all' && s.kind !== 'feed') sc.layout = tab.value;
  if (s.kind === 'feed') sc.feed = s.id;
  if (s.kind === 'category') sc.category = s.id;
  if (s.kind === 'tag') sc.tag = s.name;
  // 动态 is the person-centred sources (豆瓣、微博…) whatever layout they are read in (2026-10-22).
  if (s.kind === 'social') sc.view = 'social';
  if (layout.value === 'social') sc.snippet = 'long';
  // From local midnight, so paging through the results does not move the window.
  if (query.value && searchSince.value !== 'any') sc.since = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000) - SINCE_DAYS[searchSince.value] * 86400;
  if (query.value && searchKept.value) sc.kept = searchKept.value;
  return sc;
}

const layoutContext = () => ({ feeds: feedsById.value, categories: app.value?.categories ?? [], local: prefs.value.layouts,
  localScrollRead: prefs.value.scrollRead });
export const scrollRead = computed<boolean>(() => resolveScrollRead(selection.value, tab.value, layoutContext()));
export const layout = computed<Layout>(() => resolveLayout(selection.value, tab.value, layoutContext()));
// What clearing the current list's own choice would fall back to, shown as 「默认」 in the picker.
export const defaultLayout = computed<Layout>(() => inheritedLayout(selection.value, tab.value, layoutContext()));
// 'grid' layouts take the full width and open the reader over the list.
export const viewMode = computed<'list' | 'grid'>(() => (OPEN_BESIDE_LAYOUTS.has(layout.value) ? 'grid' : 'list'));

// Saves the layout for what is on screen: on the feed or category itself, otherwise in this browser.
// null clears the choice. Inside a mode tab the feed or category then moves to another tab, and
// the sidebar follows it there.
export async function setLayout(next: Layout | null): Promise<void> {
  const t = layoutTarget(selection.value, tab.value);
  const a = app.value;
  if (t.kind === 'tab') return;
  // 动态 asks the server for whole posts and their pictures; other layouts for short snippets.
  const wasPosts = layout.value === 'social';
  const refetchIfPostsChanged = (): void => { if ((layout.value === 'social') !== wasPosts) void reloadList(); };
  if (t.kind === 'local') {
    const { [t.key]: _, ...rest } = prefs.value.layouts;
    setPrefs({ layouts: next ? { ...rest, [t.key]: next } : rest });
    refetchIfPostsChanged();
    return;
  }
  if (!a) return;
  const before = a;
  app.value = t.kind === 'feed'
    ? { ...a, feeds: a.feeds.map((f) => (f.id === t.id ? { ...f, layout: next } : f)) }
    : { ...a, categories: a.categories.map((c) => (c.id === t.id ? { ...c, layout: next } : c)) };
  try {
    await (t.kind === 'feed' ? api.updateFeed(t.id, { layout: next }) : api.updateCategory(t.id, { layout: next }));
  } catch (e) {
    app.value = before;
    notify((e as Error).message, true);
    return;
  }
  if (tab.value !== 'all' && layout.value !== tab.value) { tab.value = layout.value; void reloadList(); }
  else refetchIfPostsChanged();
}

export async function refreshState(): Promise<void> {
  try { app.value = await api.state(); } catch (e) { notify((e as Error).message, true); }
}

// 推荐 is offered for lists of articles, not for 动态 (a timeline), 标题流 and 每日简报 (grouped
// by day), 收藏 (already chosen) or a search (ordered by the query).
const REC_LAYOUTS: ReadonlySet<Layout> = new Set(['list', 'cards', 'masonry']);
const sortKey = (): string => listScopeKey().replace(/[?]q$/, '');
export const recAvailable = computed(() => !isMarks.value && !isReports.value && !isPage.value && selection.value.kind !== 'starred' && !query.value && REC_LAYOUTS.has(layout.value));
export const sortMode = computed<SortMode>(() => (recAvailable.value && prefs.value.sortModes[sortKey()] === 'rec' ? 'rec' : 'latest'));
export const recMeta = signal<RecMeta | null>(null);

export function setSortMode(m: SortMode): void {
  const { [sortKey()]: _, ...rest } = prefs.value.sortModes;
  setPrefs({ sortModes: m === 'rec' ? { ...rest, [sortKey()]: 'rec' } : rest });
  void reloadList();
}

const fetchPage = async (offset: number, after?: ListItem): Promise<ListItem[]> => {
  if (sortMode.value === 'rec') {
    const r = await api.recommended(scope(), offset, PAGE);
    recMeta.value = r.meta;
    return r.items;
  }
  if (query.value && prefs.value.searchOrder === 'relevance') return (await api.searched(scope(), offset, PAGE)).items;
  if (query.value && prefs.value.searchOrder === 'semantic') return (await api.semantic(scope(), offset, PAGE)).items;
  return (await api.entries(scope(), after ? `${after.published}:${after.id}` : undefined, PAGE)).items;
};

export function setSearchOrder(o: SearchOrder): void {
  setPrefs({ searchOrder: o });
  void reloadList();
}

let listToken = 0;
// What was read in this list since it loaded, oldest first (util.ts keepReadTrail).
let readOrder: number[] = [];
let markReadOrder: string[] = [];

function trimTrail(ids: readonly number[]): void {
  readOrder = noteRead(readOrder, ids);
  if (scope().filter !== 'unread') return;
  items.value = keepReadTrail(items.value, readOrder, (i) => i.id, (i) => !!i.is_read, selectedId.value);
}
export async function reloadList(): Promise<void> {
  const token = ++listToken;
  readOrder = []; markReadOrder = [];
  loading.value = true;
  try {
    if (isReports.value || isPage.value) {
      batch(() => { items.value = []; hasMore.value = false; newCount.value = 0; });
      return;
    }
    if (isMarks.value) {
      const r = await api.marks(prefs.value.marksUnreadOnly ? 'unread' : 'all');
      if (token !== listToken) return;
      batch(() => { markGroups.value = r.groups; items.value = []; hasMore.value = false; newCount.value = 0; addTr(r); });
      return;
    }
    const page = await fetchPage(0);
    if (token !== listToken) return;
    batch(() => { items.value = page; hasMore.value = page.length === PAGE; newCount.value = 0; });
  } catch (e) {
    notify((e as Error).message, true);
  } finally {
    if (token === listToken) loading.value = false;
  }
}

export async function loadMore(): Promise<void> {
  if (loading.value || !hasMore.value) return;
  const token = listToken;
  loading.value = true;
  try {
    const page = await fetchPage(items.value.length, items.value.at(-1));
    if (token !== listToken) return;
    // The 推荐 order is fixed while scrolling, but an entry can drop out of an 未读 list in between.
    const seen = new Set(items.value.map((i) => i.id));
    batch(() => { items.value = [...items.value, ...page.filter((i) => !seen.has(i.id))]; hasMore.value = page.length === PAGE; });
  } finally {
    loading.value = false;
  }
}

// Called on server change events: count what's new above the list without reshuffling it.
export async function checkNew(): Promise<void> {
  if (isMarks.value || isReports.value || isPage.value) return;
  const top = maxId(items.value);
  const r = await api.entries(scope(), undefined, PAGE);
  newCount.value = r.items.filter((i) => i.id > top).length;
  if (!items.value.length && r.items.length) await reloadList();
}

export function select(sel: Selection): Promise<void> {
  batch(() => { selection.value = sel; selectedId.value = null; detail.value = null; selectedMark.value = null; markGroups.value = []; });
  return reloadList();
}

export function setTab(v: Tab): void {
  batch(() => {
    tab.value = v;
    if (selection.value.kind !== 'all' && selection.value.kind !== 'starred' && selection.value.kind !== 'tag') selection.value = { kind: 'all' };
    selectedMark.value = null;
    selectedId.value = null; detail.value = null;
  });
  void reloadList();
}

function patchItem(id: number, patch: Partial<ListItem>): void {
  items.value = items.value.map((i) => (i.id === id ? { ...i, ...patch } : i));
  if (detail.value?.id === id) detail.value = { ...detail.value, ...patch };
  const cached = detailCache.get(id);
  if (cached) detailCache.set(id, { ...cached, ...patch });
}

// Douban marks are counted under 书影音标记, not under their feed (server/api/queries.ts).
function bumpUnread(it: Pick<ListItem, 'feed_id' | 'is_mark'>, delta: number): void {
  const a = app.value;
  if (!a) return;
  app.value = it.is_mark
    ? { ...a, marksUnread: Math.max(0, a.marksUnread + delta) }
    : {
      ...a,
      totals: { ...a.totals, unread: Math.max(0, a.totals.unread + delta) },
      feeds: a.feeds.map((f): Feed => (f.id === it.feed_id ? { ...f, unread: Math.max(0, f.unread + delta) } : f)),
    };
}

export async function setRead(it: ListItem, read: boolean): Promise<void> {
  if (!!it.is_read === read) return;
  patchItem(it.id, { is_read: read ? 1 : 0 });
  bumpUnread(it, read ? -1 : 1);
  try { await api.mark([it.id], { read }); } catch (e) { notify((e as Error).message, true); }
}

// Turns 滚过即读 on or off for what is on screen, stored like the layout.
export async function setScrollRead(on: boolean): Promise<void> {
  const t = layoutTarget(selection.value, tab.value);
  const a = app.value;
  if (t.kind !== 'feed' && t.kind !== 'category') {
    const key = scrollReadKey(selection.value, tab.value);
    const { [key]: _, ...rest } = prefs.value.scrollRead;
    setPrefs({ scrollRead: on ? { ...rest, [key]: true } : rest });
    return;
  }
  if (!a) return;
  const before = a;
  const v = on ? 1 : 0;
  app.value = t.kind === 'feed'
    ? { ...a, feeds: a.feeds.map((f) => (f.id === t.id ? { ...f, scroll_read: v } : f)) }
    : { ...a, categories: a.categories.map((c) => (c.id === t.id ? { ...c, scroll_read: v } : c)) };
  try {
    await (t.kind === 'feed' ? api.updateFeed(t.id, { scroll_read: v }) : api.updateCategory(t.id, { scroll_read: v }));
  } catch (e) {
    app.value = before;
    notify((e as Error).message, true);
  }
}

export function markIdsRead(ids: Iterable<number>): Promise<boolean> {
  const want = new Set(ids);
  return markItemsRead(items.value.filter((i) => want.has(i.id)));
}

// Marks one block of the 标题流 layout read without touching the rest of the list.
// False when the server did not take it; the error has been shown.
export async function markItemsRead(list: readonly ListItem[]): Promise<boolean> {
  const unread = list.filter((i) => !i.is_read);
  if (!unread.length) return true;
  for (const i of unread) { patchItem(i.id, { is_read: 1 }); bumpUnread(i, -1); }
  trimTrail(unread.map((i) => i.id));
  try { await api.mark(unread.map((i) => i.id), { read: true }); return true; } catch (e) { notify((e as Error).message, true); void refreshState(); return false; }
}

const REACTION_NOTE: Record<Reaction, string> = { like: '已标为喜欢', less_topic: '已记下：少推这类', less_source: '已记下：少推这个源' };

// l / x in the reader. Pressing the same one again takes it back.
export async function toggleReaction(r: Reaction): Promise<void> {
  const d = detail.value;
  if (!d || d.loading) return;
  const prev = d.reaction ?? null;
  const next = prev === r ? null : r;
  const apply = (v: Reaction | null): void => {
    if (detail.value?.id === d.id) detail.value = { ...detail.value, reaction: v };
    const cached = detailCache.get(d.id);
    if (cached) detailCache.set(d.id, { ...cached, reaction: v });
  };
  apply(next);
  try {
    await api.reaction(d.id, next);
    notify(next ? REACTION_NOTE[next] : '已撤销');
  } catch (e) {
    apply(prev);
    notify((e as Error).message, true);
  }
}

export async function toggleStar(it: ListItem): Promise<void> {
  const starred = !it.is_starred;
  patchItem(it.id, { is_starred: starred ? 1 : 0 });
  try { await api.mark([it.id], { starred }); } catch (e) { notify((e as Error).message, true); }
}

// Recently fetched entries, so switching shows something at once even while the server is busy
// parsing a large feed. A fresh copy is always fetched and replaces the cached one.
const DETAIL_CACHE_MAX = 40;
const PREFETCH_AHEAD = 2;
const detailCache = new Map<number, EntryDetail>();

function remember(d: EntryDetail): void {
  detailCache.delete(d.id);
  detailCache.set(d.id, d);
  if (detailCache.size > DETAIL_CACHE_MAX) detailCache.delete(detailCache.keys().next().value!);
}

function placeholder(it: ListItem): EntryDetail {
  const feed = feedsById.value.get(it.feed_id);
  return {
    ...it, content: null, content_full: null, ai_summary: null, ai_state: 0,
    feed_title: feed?.title ?? '', feed_site: feed?.site_url ?? null, view: feed?.view ?? 'article', tags: [], loading: true,
  };
}

function prefetchAfter(id: number): void {
  const list = items.value;
  const at = list.findIndex((i) => i.id === id);
  for (const next of list.slice(at + 1, at + 1 + PREFETCH_AHEAD)) {
    if (!detailCache.has(next.id)) void api.entry(next.id).then(remember, () => { /* only a head start */ });
  }
}

// Where an article was opened from, kept with its reading signal.
function listScopeKey(): string {
  const s = selection.value;
  const base = s.kind === 'feed' || s.kind === 'category' ? `${s.kind}:${s.id}` : s.kind === 'tag' ? `tag:${s.name}` : s.kind;
  return `${base}${tab.value !== 'all' ? `@${tab.value}` : ''}${query.value ? '?q' : ''}`;
}

function viewContext(it: ListItem): ViewContext {
  const list = displayOrder(items.value, layout.value, selection.value.kind === 'feed');
  return { listScope: listScopeKey(), sortMode: sortMode.value === 'rec' ? 'recommend' : 'latest', position: Math.max(0, list.findIndex((i) => i.id === it.id)) };
}

// Closing the reader (Esc in wide layouts, switching lists) ends the reading of the open article.
effect(() => { if (!detail.value) endView(); });

// Reports written into Obsidian link to /#entry=<id>; that entry opens over whatever list is shown.
export async function openFromHash(): Promise<void> {
  const id = Number(/^#entry=(\d+)$/.exec(location.hash)?.[1]);
  if (!id) return;
  try {
    await open(await api.entry(id), { listScope: 'link', sortMode: 'latest', position: -1 });
  } catch (e) {
    notify((e as Error).message, true);
  }
}

let detailToken = 0;
// ctx is given when the article was not opened from the list (related reading under another one).
export async function open(it: ListItem, ctx?: ViewContext): Promise<void> {
  const token = ++detailToken;
  const cached = detailCache.get(it.id);
  startView(it.id, ctx ?? viewContext(it));
  batch(() => {
    selectedId.value = it.id;
    detail.value = { ...(cached ?? placeholder(it)), is_read: 1, is_starred: it.is_starred };
  });
  void setRead(it, true);
  trimTrail([it.id]);
  try {
    const d = await api.entry(it.id);
    remember(d);
    if (token === detailToken) detail.value = { ...d, is_read: 1 };
  } catch (e) {
    if (token === detailToken && !cached) detail.value = { ...placeholder(it), is_read: 1, loading: false };
    notify((e as Error).message, true);
  }
  if (token === detailToken) prefetchAfter(it.id);
}

export function step(delta: 1 | -1): void {
  if (isMarks.value) { stepMark(delta); return; }
  if (isReports.value) { reportStep?.(delta); return; }
  if (isPage.value) return;
  const list = displayOrder(items.value, layout.value, selection.value.kind === 'feed');
  const idx = list.findIndex((i) => i.id === selectedId.value);
  const next = list[idx < 0 ? 0 : idx + delta];
  if (next) void open(next);
  else if (delta === 1 && !hasMore.value && !loading.value) void stepPastEnd();
  if (delta === 1 && idx >= list.length - 5) void loadMore();
}

// j past the last entry goes on to the next category in the sidebar that has unread (wrapping
// round); when no other has any, back to the first unread at the top of this list (2026-10-23).
async function stepPastEnd(): Promise<void> {
  const a = app.value;
  const s = selection.value;
  // A search runs inside the current scope; jumping to another category would leave it behind.
  if (a && !query.value && (s.kind === 'category' || s.kind === 'feed')) {
    const cur = s.kind === 'category' ? s.id : a.feeds.find((f) => f.id === s.id)?.category_id ?? null;
    const t = tab.value;
    const unreadIn = (id: number): number => a.feeds
      .filter((f) => f.category_id === id && (t === 'all' || effectiveLayout(f, a.categories) === t))
      .reduce((n, f) => n + f.unread, 0);
    const ids = a.categories.map((c) => c.id);
    const at = cur === null ? -1 : ids.indexOf(cur);
    for (let k = 1; k <= ids.length; k++) {
      const id = ids[(at + k + ids.length) % ids.length];
      if (id === cur || !unreadIn(id)) continue;
      await select({ kind: 'category', id });
      const first = displayOrder(items.value, layout.value, false).find((i) => !i.is_read);
      if (first) void open(first);
      notify(`下一个分类：${a.categories.find((c) => c.id === id)?.name ?? ''}`);
      return;
    }
  }
  const first = displayOrder(items.value, layout.value, s.kind === 'feed').find((i) => !i.is_read && i.id !== selectedId.value);
  if (first) { void open(first); notify('回到开头的未读'); } else notify('全部读完了');
}

// Ids grow with arrival time, so "everything up to the newest loaded id" excludes
// articles that arrived after the list was fetched.
const maxId = (list: ListItem[]): number => list.reduce((m, i) => Math.max(m, i.id), 0);

export async function markAllRead(): Promise<void> {
  if (isReports.value || isPage.value) return;
  if (isMarks.value) {
    // One segment (书、影…) marks only what it shows; 全部 everything up to the newest loaded.
    let count: number;
    if (prefs.value.markKind === 'all') {
      const top = markGroups.value.reduce((m, g) => g.marks.reduce((n, x) => Math.max(n, x.id), m), 0);
      count = (await api.marksRead(top || undefined)).count;
    } else {
      const ids = visibleMarks.value.flatMap((g) => g.marks.filter((m) => !m.is_read).map((m) => m.id));
      if (ids.length) await api.mark(ids, { read: true });
      count = ids.length;
    }
    notify(`已标记 ${count} 条标记为已读`);
    await Promise.all([refreshState(), reloadList()]);
    return;
  }
  // A search ordered by relevance or meaning shows a ranked page, not everything up to an id: only what is shown is marked.
  if (query.value && prefs.value.searchOrder !== 'latest') {
    const ids = items.value.filter((i) => !i.is_read).map((i) => i.id);
    if (ids.length) await api.mark(ids, { read: true });
    notify(`已标记 ${ids.length} 篇为已读`);
    await Promise.all([refreshState(), reloadList()]);
    return;
  }
  const r = await api.markAll(scope(), maxId(items.value) || undefined);
  notify(`已标记 ${r.count} 篇为已读`);
  await Promise.all([refreshState(), reloadList()]);
}

// Shift+K: everything shown above the current entry (or card) is marked read, in the order on
// screen, so under 推荐 too it is what the eye has passed. Five seconds to take it back.
export async function markAboveRead(): Promise<void> {
  let ids: number[];
  // Undo puts the list back as it was rather than reloading it: a reloaded 未读 list would drop the
  // entry being read (it is read), and the selection with it.
  const itemsBefore = items.value, groupsBefore = markGroups.value;
  if (isMarks.value) {
    const list = visibleMarks.value;
    const at = list.findIndex((g) => g.key === selectedMark.value);
    if (at <= 0) { notify(at < 0 ? '先选中一张卡片' : '上面没有了'); return; }
    const above = list.slice(0, at);
    ids = above.flatMap((g) => g.marks.filter((m) => !m.is_read).map((m) => m.id));
    if (ids.length) {
      const keys = new Set(above.map((g) => g.key));
      markGroups.value = markGroups.value.map((g) => (keys.has(g.key) ? { ...g, unread: 0, marks: g.marks.map((m) => ({ ...m, is_read: 1 })) } : g));
      try { await api.mark(ids, { read: true }); } catch (e) { markGroups.value = groupsBefore; notify((e as Error).message, true); return; }
    }
  } else {
    if (isReports.value || isPage.value) return;
    const list = displayOrder(items.value, layout.value, selection.value.kind === 'feed');
    const at = list.findIndex((i) => i.id === selectedId.value);
    if (at <= 0) { notify(at < 0 ? '先选中一篇' : '上面没有了'); return; }
    const above = list.slice(0, at).filter((i) => !i.is_read);
    ids = above.map((i) => i.id);
    if (!(await markItemsRead(above))) return;
  }
  if (!ids.length) { notify('上面都读过了'); return; }
  void refreshState();
  notify(`已把上面 ${ids.length} ${isMarks.value ? '条标记' : '篇'}标为已读`, false, {
    label: '撤销',
    run: () => {
      const back = new Set(ids);
      if (groupsBefore.length) {
        const now = new Map(markGroups.value.map((g) => [g.key, g]));
        markGroups.value = groupsBefore.map((g) => (g.marks.some((m) => back.has(m.id)) ? g : now.get(g.key) ?? g));
      } else {
        const now = new Map(items.value.map((i) => [i.id, i]));
        items.value = itemsBefore.map((i) => (back.has(i.id) ? { ...i, is_read: 0 } : now.get(i.id) ?? i));
      }
      api.mark(ids, { read: false }).then(() => refreshState()).catch((e: Error) => notify(e.message, true));
    },
  });
}

// Opening a group reads all of its marks; in the unread view the last few read cards stay as a trail.
export async function openMark(key: string): Promise<void> {
  selectedMark.value = key;
  subjectTrail.value = [];
  const g = markGroups.value.find((x) => x.key === key);
  const ids = g?.marks.filter((m) => !m.is_read).map((m) => m.id) ?? [];
  if (!g || !ids.length) return;
  markGroups.value = markGroups.value.map((x) => (x.key === key ? { ...x, unread: 0, marks: x.marks.map((m) => ({ ...m, is_read: 1 })) } : x));
  markReadOrder = noteRead(markReadOrder, [key]);
  if (prefs.value.marksUnreadOnly) markGroups.value = keepReadTrail(markGroups.value, markReadOrder, (x) => x.key, (x) => !x.unread, key);
  try { await api.mark(ids, { read: true }); await refreshState(); } catch (e) { notify((e as Error).message, true); }
}

function stepMark(delta: 1 | -1): void {
  const list = visibleMarks.value;
  const idx = list.findIndex((g) => g.key === selectedMark.value);
  const next = list[idx < 0 ? 0 : idx + delta];
  if (next) void openMark(next.key);
}

// Whether the reader shows the fetched full text rather than the feed's excerpt.
export const showFull = signal(false);
// Entries with a translation under way: the reader may have moved on before one comes back.
const translatingIds = signal<ReadonlySet<number>>(new Set());
export const translating = computed(() => !!detail.value && translatingIds.value.has(detail.value.id));
const TR_ORDER: TrView[] = ['bilingual', 'translation', 'original'];

export const bodyOf = (d: EntryDetail): 'full' | 'feed' => (showFull.value && d.content_full ? 'full' : 'feed');
// A translation counts only for the body on screen: one of the excerpt says nothing about the full text.
export const hasTranslation = (d: EntryDetail): boolean => !!d.content_tr && d.tr_of === bodyOf(d);

export async function translateEntry(source?: 'full' | 'feed', quiet = false): Promise<void> {
  const d = detail.value;
  if (!d || d.loading || translatingIds.value.has(d.id)) return;
  // Said here rather than asked of the server, which would only answer 400 with the same words.
  if (!app.value?.hasAiKey) { if (!quiet) notify('未配置 AI 密钥：在 设置 → AI 里填上就能翻译', true); return; }
  translatingIds.value = new Set([...translatingIds.value, d.id]);
  try {
    const next = await api.translate(d.id, source ?? bodyOf(d));
    remember(next);
    if (detail.value?.id === d.id) detail.value = { ...next, is_read: detail.value.is_read, is_starred: detail.value.is_starred };
    patchItem(d.id, { title_zh: next.title_zh });
    if (!quiet && prefs.value.trView === 'original') setPrefs({ trView: 'bilingual' });
  } catch (e) {
    // Opened in passing: the reader says so on the entry, with a retry, rather than in a toast.
    if (quiet && detail.value?.id === d.id) detail.value = { ...detail.value, tr_state: 3, tr_note: (e as Error).message.replace(/^翻译失败：/, '') };
    else if (!quiet) notify((e as Error).message, true);
  } finally {
    translatingIds.value = new Set([...translatingIds.value].filter((x) => x !== d.id));
  }
}

// On opening a foreign entry with no translation of the body it opens on: translated there and
// then, unless the reader is set to show originals. One the background pass is busy with is
// waited for on the server, not translated twice.
export function translateOnOpen(): void {
  const d = detail.value;
  if (!d || d.loading || !app.value?.settings.translate.enabled || !app.value.hasAiKey) return;
  if (prefs.value.trView === 'original' || d.tr_state === 3) return;
  const body = d.content_full ? 'full' : 'feed';
  if (d.content_tr && d.tr_of === body) return;
  const html = (body === 'full' ? d.content_full : d.content) ?? '';
  if (!isForeignText(`${d.title} ${html.replace(/<[^>]+>/g, ' ')}`)) return;
  void translateEntry(body, true);
}

// t: translate when there is nothing yet, otherwise 双语 → 译文 → 原文.
export function cycleTranslation(): void {
  const d = detail.value;
  if (!d || d.loading) return;
  if (!hasTranslation(d)) { void translateEntry(); return; }
  setPrefs({ trView: TR_ORDER[(TR_ORDER.indexOf(prefs.value.trView) + 1) % TR_ORDER.length] });
}

export async function runAi(tasks: { summary?: boolean; title?: boolean; classify?: boolean; fulltext?: boolean }): Promise<void> {
  const d = detail.value;
  if (!d) return;
  try {
    const next = await api.ai(d.id, tasks);
    if (detail.value?.id === d.id) detail.value = next;
    patchItem(d.id, { title_zh: next.title_zh, has_summary: next.ai_summary ? 1 : 0 });
  } catch (e) {
    notify((e as Error).message, true);
  }
}

// Text selected inside the reader goes into the note's excerpt section.
function readerSelection(): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return '';
  const prose = document.querySelector('.prose');
  return prose && sel.anchorNode && prose.contains(sel.anchorNode) ? sel.toString() : '';
}

// 分享图: the dialog is open while this is set.
export const share = signal<{ data: ShareData; style: CardStyle } | null>(null);

const prefersDark = (): boolean => prefs.value.theme === 'dark' ||
  (prefs.value.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

function currentShare(): { data: ShareData; style: CardStyle } | null {
  const d = detail.value;
  if (!d || d.loading) return null;
  const data = entryShare(d, readerSelection());
  return { data, style: { dark: prefersDark(), serif: prefs.value.serif, quote: !!data.quote } };
}

export function openShare(): void { share.value = currentShare(); }

// p in the reader: straight to the clipboard with the default card. Nothing is awaited before
// the clipboard write, so the key press still counts as the gesture that allows it.
export async function quickShare(): Promise<void> {
  const s = currentShare();
  if (!s) return;
  try {
    await copyPng(cardPng(s.data, s.style));
    notify(s.data.quote ? '已复制摘录分享图' : '已复制分享图');
  } catch (e) {
    notify(`复制分享图失败：${(e as Error).message}`, true);
  }
}

export const clipping = signal(false);

export async function clipToObsidian(): Promise<void> {
  const d = detail.value;
  if (!d || clipping.value) return;
  // The demo has no vault either; its clip is answered by the mock.
  if (!import.meta.env.VITE_DEMO && !app.value?.settings.clip.vaultPath) {
    notify('还没设置 Obsidian 库的位置：在 设置 → 存档 里填上就能存档', true);
    return;
  }
  clipping.value = true;
  try {
    const r = await api.clip(d.id, readerSelection());
    if (detail.value?.id === d.id && !d.tags.some((t) => t.source === 'clip')) {
      detail.value = { ...detail.value, tags: [...detail.value.tags, { name: '已存档', source: 'clip' }] };
    }
    const tail = r.analysis === 'queued' ? '，AI 分析生成中' : r.analysis === 'no-key' ? '（未配置 AI 密钥，跳过分析）' : '';
    notify(r.existed ? `已存档过：${r.relPath}` : `已存入 Obsidian：${r.relPath}${tail}`);
  } catch (e) {
    notify((e as Error).message, true);
  } finally {
    clipping.value = false;
  }
}

export const jobs = signal<JobsState>({ jobs: [], aiQueue: 0, fetching: 0 });
export const jobsOpen = signal(false);

export async function refreshJobs(): Promise<void> {
  try { jobs.value = await api.jobs(); } catch { /* the panel keeps the last known state */ }
}

export async function clearFinishedJobs(): Promise<void> {
  try { await api.clearJobs(); await refreshJobs(); } catch (e) { notify((e as Error).message, true); }
}

export function connectEvents(): void {
  const es = new EventSource('/api/events');
  void refreshJobs();
  es.addEventListener('changed', () => { void refreshState(); void checkNew(); void refreshJobs(); });
  es.addEventListener('jobs', () => { void refreshJobs(); });
  es.addEventListener('snippets', () => { void fetchNewTr(); });
  es.addEventListener('clip', (ev) => {
    const m = JSON.parse((ev as MessageEvent).data) as { ok: boolean; result?: string; error?: string };
    if (m.ok) notify('AI 分析已写入笔记');
    else if (m.result === 'not-empty') notify('笔记的 AI 一节已有内容，分析未写入', true);
    else notify(`AI 分析失败：${m.error ?? m.result ?? '未知原因'}`, true);
  });
}
