// 热点: what friends are marking now, beside 豆瓣's own public lists. Friends' side is computed
// from the marks already stored; the public side is a handful of RSSHub lists, fetched at most
// every few hours and kept in hot_list, so opening the page costs no request most of the time.
import type { DB } from '../db.ts';
import { listMarks, MARKS_WINDOW_DAYS, type MarkGroup } from '../api/marks.ts';
import { wishedSubjects } from '../content/douban.ts';

export type HotKind = 'book' | 'movie';

export interface HotMark { who: string; action: string; published: number }
export interface HotItem {
  kind: HotKind; subject: string; title: string; cover: string | null; info: string; rating: number | null;
  people: number;            // friends who marked it in the window, 0 for a public-only item
  score: number;
  marks: HotMark[];
  since: number | null;      // when the second friend marked it: the day it reached the list
  isNew: boolean;            // reached the list this week
  intro?: string;            // the 豆瓣 page's blurb, cut short, when Lumen keeps the page (routes.ts withIntros)
  lists: string[];           // the public lists it is on
  mine: string | null;       // the reader's own 想读 / 读过 … from their interests feed
  wished: boolean;           // marked 想读 / 想看 from Lumen
}
export interface HotPage { book: { friends: HotItem[]; lists: HotItem[] }; movie: { friends: HotItem[]; lists: HotItem[] }; fetched: number | null }

const HALF_LIFE_DAYS = 7;
const MIN_PEOPLE = 2;
const NEW_DAYS = 7;
const FRIENDS_SHOWN = 30;
const LISTS_SHOWN = 30;
const LIST_FRESH_S = 6 * 3600;

// A friend counts once, by their weightiest mark: a 读过 with a comment says most, a 收藏到 least.
export function markWeight(action: string, comment: string): number {
  if ((action === '读过' || action === '看过') && comment.trim()) return 1.5;
  if (action === '收藏到') return 0.8;
  return 1;
}

// A film mark's title runs on with the original title and year: 「风暴 Storm (2026)」, with an
// invisible direction mark before the year. An original title without Latin letters stays.
export const filmTitle = (t: string): string =>
  t.replace(/\p{Cf}/gu, '').replace(/\s+[A-Za-z].*\(\d{4}\)\s*$/, '').replace(/\s*\(\d{4}\)\s*$/, '').trim();

const kindOfGroup = (g: MarkGroup): HotKind | null => (g.kind === 'book' ? 'book' : g.kind === 'movie' ? 'movie' : null);

export function friendsHot(groups: readonly MarkGroup[], now: number): HotItem[] {
  const since = now - MARKS_WINDOW_DAYS * 86400;
  const out: HotItem[] = [];
  for (const g of groups) {
    const kind = kindOfGroup(g);
    if (!kind || !g.subject) continue;
    // Up to now only: a past week's report, rebuilt later, must not count what came after it.
    const marks = g.marks.filter((m) => m.published > since && m.published <= now);
    const best = new Map<string, { w: number; at: number }>();
    for (const m of marks) {
      const w = markWeight(m.action, m.comment);
      const cur = best.get(m.who);
      if (!cur || w > cur.w || (w === cur.w && m.published > cur.at)) best.set(m.who, { w, at: m.published });
    }
    if (best.size < MIN_PEOPLE) continue;
    const score = [...best.values()].reduce((s, b) => s + b.w * 0.5 ** ((now - b.at) / 86400 / HALF_LIFE_DAYS), 0);
    // The second distinct friend's first mark is when it crossed the threshold.
    const first = new Map<string, number>();
    for (const m of marks) first.set(m.who, Math.min(first.get(m.who) ?? Infinity, m.published));
    const firsts = [...first.values()].sort((a, b) => a - b);
    const reached = firsts[MIN_PEOPLE - 1] ?? null;
    out.push({
      kind, subject: g.subject, title: kind === 'movie' ? filmTitle(g.title) : g.title, cover: g.cover, info: g.info, rating: null, people: best.size, score,
      marks: marks.map((m) => ({ who: m.who, action: m.action, published: m.published })),
      since: reached, isNew: reached !== null && reached > now - NEW_DAYS * 86400, lists: [], mine: null, wished: g.wished,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── public lists ────────────────────────────────────────────────────────────────────────────────
// Tried against the local RSSHub on 2026-10-23: the rexxar book collections (book_fiction_hot_weekly …)
// answer 404 and /douban/book/rank stopped in 2021, so books come from Lumen's own chart route.
export const PUBLIC_LISTS: { key: string; label: string; kind: HotKind; path: string }[] = [
  { key: 'book_chart', label: '月度热门图书', kind: 'book', path: 'lumen/douban/book/chart' },
  { key: 'book_latest', label: '新书速递', kind: 'book', path: 'douban/book/latest/all' },
  { key: 'movie_real_time_hotest', label: '实时热门电影', kind: 'movie', path: 'douban/list/movie_real_time_hotest' },
  { key: 'tv_real_time_hotest', label: '实时热门剧集', kind: 'movie', path: 'douban/list/tv_real_time_hotest' },
  { key: 'movie_weekly_best', label: '一周口碑电影', kind: 'movie', path: 'douban/list/movie_weekly_best' },
  { key: 'tv_chinese_best_weekly', label: '华语口碑剧集', kind: 'movie', path: 'douban/list/tv_chinese_best_weekly' },
  { key: 'tv_global_best_weekly', label: '全球口碑剧集', kind: 'movie', path: 'douban/list/tv_global_best_weekly' },
];

export interface ListedItem { subject: string; title: string; cover: string | null; info: string; rating: number | null }

const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// A JSON Feed item from RSSHub: the subject from either link form, the poster, and the
// <p> lines (title, original title, rating, 「年份 / 地区 / 类型 / 导演 / 主演」).
export function parseListItem(it: { url?: string; id?: string; title?: string; content_html?: string }): ListedItem | null {
  const link = it.url ?? it.id ?? '';
  const subject = /douban\.com\/(?:subject|doubanapp\/dispatch\/(?:movie|book))\/(\d+)/.exec(link)?.[1];
  if (!subject || !it.title) return null;
  const html = it.content_html ?? '';
  const lines = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1])).filter(Boolean);
  const ratingLine = lines.find((l) => /^\d\.\d$/.test(l));
  const scored = /([\d.]+)\s*分/.exec(text(html))?.[1];
  const title = it.title.trim();
  const info = lines.filter((l) => l !== title && l !== ratingLine && !/^[\d.]+\s*分/.test(l)).slice(-1)[0] ?? '';
  return {
    subject, title, cover: /<img[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null, info: info.slice(0, 120),
    rating: ratingLine ? Number(ratingLine) : scored ? Number(scored) : null,
  };
}

interface CachedList { key: string; fetched: number; items: string }

async function fetchList(base: string, path: string): Promise<ListedItem[]> {
  const r = await fetch(`${base.replace(/\/$/, '')}/${path}`, { signal: AbortSignal.timeout(40_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const feed = await r.json() as { items?: unknown[] };
  return (feed.items ?? []).map((x) => parseListItem(x as Parameters<typeof parseListItem>[0])).filter((x): x is ListedItem => !!x);
}

let refreshing: Promise<void> | null = null;

// Stale lists are refreshed in the background; the page shows what it has meanwhile. A list that
// fails keeps its last good items.
export function refreshLists(db: DB, rsshubBase: string, now = Math.floor(Date.now() / 1000), force = false): Promise<void> {
  // 重新拉取 pressed during a background refresh runs again once that one is done.
  if (refreshing) return force ? refreshing.then(() => refreshLists(db, rsshubBase, now, true)) : refreshing;
  const cached = new Map((db.prepare('SELECT key, fetched, items FROM hot_list').all() as unknown as CachedList[]).map((r) => [r.key, r]));
  const due = PUBLIC_LISTS.filter((l) => force || !cached.has(l.key) || now - cached.get(l.key)!.fetched > LIST_FRESH_S);
  if (!due.length) return Promise.resolve();
  refreshing = (async () => {
    for (const l of due) {
      try {
        const items = await fetchList(rsshubBase, l.path);
        if (items.length) db.prepare('INSERT INTO hot_list (key, fetched, items) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fetched = excluded.fetched, items = excluded.items')
          .run(l.key, now, JSON.stringify(items));
      } catch { /* keep the last good copy; the next refresh tries again */ }
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// The reader's own 想读 / 读过 …, from their interests feed (its titles read 「想读夺回时间」).
function ownMarks(db: DB): Map<string, string> {
  const rows = db.prepare(`SELECT e.title, e.link FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE f.url LIKE 'https://www.douban.com/feed/people/%/interests' ORDER BY e.published`).all() as { title: string; link: string | null }[];
  const out = new Map<string, string>();
  for (const r of rows) {
    const id = /douban\.com\/subject\/(\d+)/.exec(r.link ?? '')?.[1];
    const act = /^(想读|在读|读过|想看|在看|看过|想听|在听|听过)/.exec(r.title)?.[1];
    if (id && act) out.set(id, act);
  }
  return out;
}

// The weekly report's 「本周友邻热点」: the top few of each kind as the week ended.
export interface HotPick { subject: string; title: string; people: number; who: string; isNew: boolean }
const WEEKLY_PICKS = 5;
export function weeklyHot(db: DB, until: number): { book: HotPick[]; movie: HotPick[] } {
  const hot = friendsHot(listMarks(db, { unreadOnly: false, now: until }), until);
  const pick = (kind: HotKind): HotPick[] => hot.filter((h) => h.kind === kind).slice(0, WEEKLY_PICKS).map((h) => ({
    subject: h.subject, title: h.title, people: h.people,
    who: [...new Set(h.marks.map((m) => m.who))].slice(0, 3).join('、'), isNew: h.isNew,
  }));
  return { book: pick('book'), movie: pick('movie') };
}

export function hotPage(db: DB, now = Math.floor(Date.now() / 1000)): HotPage {
  const friends = friendsHot(listMarks(db, { unreadOnly: false, now }), now);
  const cached = db.prepare('SELECT key, fetched, items FROM hot_list').all() as unknown as CachedList[];
  const byKey = new Map(cached.map((r) => [r.key, r]));
  const mine = ownMarks(db);
  const page: HotPage = { book: { friends: [], lists: [] }, movie: { friends: [], lists: [] }, fetched: cached.length ? Math.max(...cached.map((r) => r.fetched)) : null };
  for (const kind of ['book', 'movie'] as const) {
    const fr = friends.filter((f) => f.kind === kind);
    const frBy = new Map(fr.map((f) => [f.subject, f]));
    const listed = new Map<string, HotItem>();
    for (const l of PUBLIC_LISTS.filter((x) => x.kind === kind)) {
      const items = JSON.parse(byKey.get(l.key)?.items ?? '[]') as ListedItem[];
      for (const it of items) {
        const f = frBy.get(it.subject);
        // A list's title is the clean one; a mark's runs on with the original title and year.
        if (f) { f.lists = [...new Set([...f.lists, l.label])]; f.rating ??= it.rating; f.cover ??= it.cover; f.title = it.title; f.info = f.info || it.info; }
        const cur = listed.get(it.subject);
        if (cur) { if (!cur.lists.includes(l.label)) cur.lists = [...cur.lists, l.label]; continue; }
        listed.set(it.subject, {
          kind, subject: it.subject, title: it.title, cover: it.cover, info: it.info, rating: it.rating,
          people: f?.people ?? 0, score: 0, marks: f?.marks ?? [], since: null, isNew: false, lists: [l.label], mine: null, wished: false,
        });
      }
    }
    const wished = wishedSubjects(db, [...fr.map((f) => f.subject), ...listed.keys()]);
    const finish = (x: HotItem): HotItem => ({ ...x, mine: mine.get(x.subject) ?? null, wished: x.wished || wished.has(x.subject) });
    page[kind].friends = fr.slice(0, FRIENDS_SHOWN).map(finish);
    // On more lists first, then with friends on it, then as the lists ordered them.
    page[kind].lists = [...listed.values()].map((x, i) => ({ x, i }))
      .sort((a, b) => b.x.lists.length - a.x.lists.length || b.x.people - a.x.people || a.i - b.i)
      .slice(0, LISTS_SHOWN).map(({ x }) => finish(x));
  }
  return page;
}
