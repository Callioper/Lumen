// The static demo (vite build --mode demo): answers /api/* in the page from fixture.json, which
// scripts/demo/snapshot.ts wrote from an invented library. Changes live until the page is reloaded.
import rawFixture from './fixture.json';
import art from './art.json';
import './demo.css';
import { notify } from '../store.ts';
import type { AppState, EntryDetail, ListItem, RecInfo, TocIssue, Notice, Count } from '../api.ts';
import { DOWNLOADS, HOME, REPO } from './links.ts';

interface Meta { view: string; category: number | null; layout: string; tags: string[]; archived: boolean; head: string; body: string; longSnippet?: string }
interface Fixture {
  at: number; state: AppState; items: ListItem[]; meta: Record<string, Meta>;
  rec: { order: { id: number; rec?: RecInfo }[]; meta: unknown };
  details: Record<string, EntryDetail>; related: Record<string, unknown>; books: Record<string, unknown>;
  friends: Record<string, unknown>; comments: Record<string, unknown>;
  newBooks: { post: Record<string, BooksPage>; date: Record<string, BooksPage> };
  reports: unknown[]; report: Record<string, unknown>; marks: { unread: unknown; all: unknown };
  profile: { clusters: { anchor: number; name: string | null; hidden: boolean }[] }; stats: unknown; embedding: unknown;
  hot: unknown; editions: Record<string, unknown>; movies: Record<string, unknown>;
  tocs: { issues: TocIssue[]; total: number; journals: Count[]; sources: Count[] }; notices: { items: Notice[]; kinds: Count[]; past: number };
}

// 新书 as the server gave it, by whether only books not in Zotero were asked for and whether by shelves.
interface BookRow { book: { date: string }; topic: string | null; kind: string | null; month?: string; shelf?: string }
interface BooksPage { books: BookRow[]; total: number; months?: { label: string; n: number; shelves?: unknown[] }[] }

// The library holds short stand-ins for its pictures (scripts/demo/seed.ts); the page puts the pictures back.
const pictures = art as Record<string, string>;
const raw = JSON.parse(JSON.stringify(rawFixture).replace(/data:lumen-art,(p\d+)/g, (m, k: string) => pictures[k] ?? m)) as typeof rawFixture;

// Times move with the clock, so 「今天」 and 「3 小时前」 still read right a month after the snapshot.
const TIME_KEYS = new Set(['published', 'from', 'to', 'created', 'at', 'time', 'latest', 'fetchedAt', 'last_ok_at', 'last_fetch_at', 'next_fetch_at', 'read_at', 'created_at', 'fetched', 'since']);
const SECONDS = (v: unknown): v is number => typeof v === 'number' && v > 1.5e9 && v < 2.2e9;
function shift<T>(v: T, by: number): T {
  if (Array.isArray(v)) return v.map((x) => shift(x, by)) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, TIME_KEYS.has(k) && SECONDS(x) ? x + by : shift(x, by)])) as T;
  }
  return v;
}
const data = shift(raw as unknown as Fixture, Math.floor(Date.now() / 1000) - (raw as unknown as Fixture).at);
const items = new Map(data.items.map((i) => [i.id, i]));
const meta = (id: number): Meta => data.meta[id];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const READ_ONLY = '演示版只能浏览：这一项要在本地运行 Lumen 才能用';

type Q = URLSearchParams;
const num = (q: Q, k: string): number | undefined => (q.get(k) ? Number(q.get(k)) : undefined);
const terms = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean);

function inScope(i: ListItem, q: Q): boolean {
  const m = meta(i.id);
  const feed = num(q, 'feed'), category = num(q, 'category'), since = num(q, 'since');
  const filter = q.get('filter'), kept = q.get('kept');
  if (feed && i.feed_id !== feed) return false;
  if (!feed && filter !== 'starred' && kept !== 'starred' && i.is_mark) return false;
  if (category && m.category !== category) return false;
  if (q.get('view') && m.view !== q.get('view')) return false;
  if (q.get('layout') && m.layout !== q.get('layout')) return false;
  if (q.get('tag') && !m.tags.includes(q.get('tag')!)) return false;
  if (filter === 'unread' && i.is_read) return false;
  if ((filter === 'starred' || kept === 'starred') && !i.is_starred) return false;
  if (kept === 'archived' && !m.archived) return false;
  if (since && i.published < since) return false;
  const text = `${m.head} ${m.body}`.toLowerCase();
  return terms(q.get('q') ?? '').every((t) => text.includes(t));
}

const newest = (a: ListItem, b: ListItem): number => b.published - a.published || b.id - a.id;
function shown(i: ListItem, q: Q, extra: Partial<ListItem> = {}): ListItem {
  const long = q.get('snippet') === 'long' ? meta(i.id).longSnippet : undefined;
  return { ...i, ...(long ? { snippet: long } : {}), ...extra };
}
// A search result's snippet is the text around the first term found.
function hit(i: ListItem, q: Q): ListItem {
  const text = meta(i.id).body, t = terms(q.get('q') ?? '')[0] ?? '';
  const at = Math.max(0, text.toLowerCase().indexOf(t) - 40);
  return shown(i, q, { hit: true, snippet: (at ? '…' : '') + text.slice(at, at + 160) });
}
const page = <T,>(list: T[], q: Q): T[] => { const o = num(q, 'offset') ?? 0; return list.slice(o, o + (num(q, 'limit') ?? 40)); };

function entries(q: Q): Response {
  const sort = q.get('sort');
  if (sort === 'rec') {
    const ordered = data.rec.order.flatMap((r) => { const i = items.get(r.id); return i && inScope(i, q) ? [shown(i, q, { rec: r.rec })] : []; });
    return json({ items: page(ordered, q), meta: data.rec.meta, total: ordered.length });
  }
  if (sort === 'relevance') {
    const ts = terms(q.get('q') ?? '');
    const inTitle = (i: ListItem): number => ts.filter((t) => `${i.title} ${i.title_zh ?? ''}`.toLowerCase().includes(t)).length;
    const found = data.items.filter((i) => inScope(i, q)).sort((a, b) => inTitle(b) - inTitle(a) || newest(a, b));
    return json({ items: page(found, q).map((i) => hit(i, q)) });
  }
  if (sort === 'semantic') {
    // Stands in for the vectors: two-character pieces of the query, found in the text or the tags.
    const s = (q.get('q') ?? '').replace(/\s+/g, '');
    const grams = s.length < 2 ? [s] : [...s].slice(0, -1).map((c, k) => c + s[k + 1]);
    const scored = data.items.flatMap((i) => {
      const scope = new URLSearchParams(q); scope.delete('q');
      if (!inScope(i, scope)) return [];
      const m = meta(i.id), hay = `${m.head} ${m.body} ${m.tags.join(' ')}`;
      const n = grams.filter((g) => hay.includes(g)).length;
      return n ? [{ i, n }] : [];
    }).sort((a, b) => b.n - a.n || newest(a.i, b.i));
    return json({ items: page(scored, q).map((x) => shown(x.i, q)) });
  }
  const [p, id] = (q.get('before') ?? '').split(':').map(Number);
  const list = data.items.filter((i) => inScope(i, q) && (!q.get('before') || i.published < p || (i.published === p && i.id < id))).sort(newest);
  return json({ items: list.slice(0, num(q, 'limit') ?? 40).map((i) => shown(i, q)) });
}

// The shelves are the server's (scripts/demo/snapshot.ts asked for each way); a 主题 or a 类型 picked, or
// only recent months, is filtered here, and the months counted again.
function newBooks(q: Q): Response {
  const topic = q.get('topic') ?? '', kind = q.get('kind') ?? '';
  const months = Number(q.get('recent') ?? 0);
  const filtered = !!(topic || kind || months);
  const all = data.newBooks[q.get('sort') === 'date' ? 'date' : 'post'][`${q.get('notOwned') === '1' ? 1 : 0}${q.get('shelves') === '1' && !topic ? 1 : 0}`];
  const cut = new Date(); cut.setMonth(cut.getMonth() - months);
  const recent = (d: string): boolean => { const m = /(\d{4})年(?:(\d{1,2})月)?/.exec(d); return !m || new Date(Number(m[1]), Number(m[2] ?? 12) - 1) >= cut; };
  const books = all.books.filter((x) => (!months || recent(x.book.date)) && (!topic || x.topic === topic) && (!kind || x.kind === kind));
  const counted = filtered ? (all.months ?? []).map((m) => ({ ...m, n: books.filter((b) => b.month === m.label).length })).filter((m) => m.n) : all.months;
  const o = Number(q.get('offset') ?? 0);
  return json({ ...all, books: books.slice(o, o + (Number(q.get('limit')) || 60)), total: books.length, months: counted });
}

// Unread counts follow what was marked in this visit.
function state(): AppState {
  const unread = data.items.filter((i) => !i.is_read && !i.is_mark);
  const byFeed = new Map<number, number>();
  for (const i of unread) byFeed.set(i.feed_id, (byFeed.get(i.feed_id) ?? 0) + 1);
  const s = data.state;
  return {
    ...s,
    feeds: s.feeds.map((f) => ({ ...f, unread: byFeed.get(f.id) ?? 0 })),
    tags: s.tags.map((t) => ({ ...t, unread: unread.filter((i) => meta(i.id).tags.includes(t.name)).length })),
    totals: { ...s.totals, unread: unread.length, starred: data.items.filter((i) => i.is_starred).length },
    marksUnread: data.items.filter((i) => i.is_mark && !i.is_read).length,
  };
}

function setMarked(ids: number[], patch: { read?: boolean; starred?: boolean }): void {
  for (const id of ids) {
    const i = items.get(id);
    if (!i) continue;
    const next = { ...i, ...(patch.read !== undefined ? { is_read: patch.read ? 1 : 0 } : {}), ...(patch.starred !== undefined ? { is_starred: patch.starred ? 1 : 0 } : {}) };
    items.set(id, next);
    data.items = data.items.map((x) => (x.id === id ? next : x));
    const d = data.details[id];
    if (d) data.details[id] = { ...d, is_read: next.is_read, is_starred: next.is_starred };
  }
}

// 任务进度 as it looks after a morning's reading: a note archived with its AI analysis, a summary asked for.
const JOBS = (() => {
  const now = Math.floor(Date.now() / 1000);
  const [a, b] = data.items.filter((i) => meta(i.id).view === 'article' && meta(i.id).archived).concat(data.items).slice(0, 2);
  return [
    { id: 2, kind: 'ai', entryId: b.id, title: b.title, state: 'done', step: '摘要已生成', startedAt: now - 1500, finishedAt: now - 1440 },
    { id: 1, kind: 'clip', entryId: a.id, title: a.title, state: 'done', step: 'AI 分析已写入笔记', startedAt: now - 3700, finishedAt: now - 3480,
      notePath: `WebClips/${a.title}.md` },
  ];
})();

async function route(method: string, url: URL, body: unknown): Promise<Response> {
  const path = url.pathname.replace(/^.*?\/api\//, '/');
  const q = url.searchParams;
  const b = (body ?? {}) as Record<string, unknown>;
  const entry = /^\/entries\/(\d+)(?:\/(\w+))?$/.exec(path);
  if (method === 'GET') {
    if (path === '/state') return json(state());
    if (path === '/entries') return entries(q);
    if (entry && !entry[2]) return data.details[entry[1]] ? json(data.details[entry[1]]) : json({ error: '没有这篇' }, 404);
    if (entry?.[2] === 'related') return json(data.related[entry[1]] ?? { ready: true, items: [] });
    if (entry?.[2] === 'books') return json(data.books[entry[1]] ?? { books: [], pending: false });
    if (entry?.[2] === 'friends') return json(data.friends[entry[1]] ?? { subjects: [] });
    if (entry?.[2] === 'rec') return json({ rec: data.rec.order.find((r) => r.id === Number(entry[1]))?.rec ?? null });
    if (entry?.[2] === 'comments') return data.comments[entry[1]] ? json(data.comments[entry[1]]) : json({ error: '演示版没有这篇的评论区' }, 404);
    if (path === '/books') return newBooks(q);
    if (path === '/books/details') return json({});
    if (path === '/snippets') return json({});
    const movie = /^\/douban\/movie\/(\d+)$/.exec(path);
    if (movie) return json(data.movies[movie[1]] ?? { error: '演示版没有这部影片的页面' }, data.movies[movie[1]] ? 200 : 404);
    if (path === '/reports') return json({ reports: data.reports });
    const report = /^\/reports\/(\w+)\/(.+)$/.exec(path);
    if (report) return json(data.report[`${report[1]}/${decodeURIComponent(report[2])}`] ?? { error: '没有这一期' }, data.report[`${report[1]}/${decodeURIComponent(report[2])}`] ? 200 : 404);
    if (path === '/marks') return json(q.get('filter') === 'all' ? data.marks.all : data.marks.unread);
    if (path === '/rec/profile') return json(data.profile);
    if (path === '/profile/stats') return json(data.stats);
    if (path === '/embedding/status') return json(data.embedding);
    if (path === '/jobs') return json({ jobs: JOBS, aiQueue: 0, fetching: 0 });
    if (path === '/ai/models') return json({ models: ['demo-model'] });
    if (path === '/hot') return json(data.hot);
    if (path === '/tocs') {
      const journal = q.get('journal') ?? '';
      const source = q.get('source') ?? '';
      const ofSource = source ? data.tocs.issues.filter((t) => t.source === source) : data.tocs.issues;
      const issues = journal ? ofSource.filter((t) => t.journal === journal) : ofSource;
      return json({ ...data.tocs, issues, total: issues.length, reading: 0, stalled: false });
    }
    if (path === '/notices') {
      const kind = q.get('kind') ?? '';
      const live = q.get('past') === '1' ? data.notices.items : data.notices.items.filter((n) => n.status !== 'past');
      const remote = (n: Notice): boolean => !!n.online && n.status === 'upcoming';
      const items = live.filter((n) => (!kind || n.kind === kind) && (q.get('online') !== '1' || remote(n)));
      return json({ ...data.notices, items, past: data.notices.items.length - live.length, online: live.filter(remote).length, reading: 0, stalled: false });
    }
    const ed = /^\/douban\/editions\/(\d+)$/.exec(path);
    if (ed) return json(data.editions[ed[1]] ?? { works: null, total: 1, editions: [], wished: false });
    return json({ error: READ_ONLY }, 404);
  }
  if (path === '/entries/mark') { setMarked(b.ids as number[], b as { read?: boolean; starred?: boolean }); return json({ ok: true }); }
  if (path === '/entries/mark-all') {
    const scope = new URLSearchParams(Object.entries(b).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
    const ids = data.items.filter((i) => !i.is_read && inScope(i, scope) && (!b.upTo || i.id <= Number(b.upTo))).map((i) => i.id);
    setMarked(ids, { read: true });
    return json({ count: ids.length });
  }
  if (path === '/marks/read') {
    const ids = data.items.filter((i) => i.is_mark && !i.is_read).map((i) => i.id);
    setMarked(ids, { read: true });
    return json({ count: ids.length });
  }
  if (entry?.[2] === 'view') return json({ ok: true });
  if (entry?.[2] === 'reaction') {
    const d = data.details[entry[1]];
    if (d) data.details[entry[1]] = { ...d, reaction: (b.reaction as EntryDetail['reaction']) ?? null };
    return json({ ok: true });
  }
  const cluster = /^\/rec\/clusters\/(\d+)$/.exec(path);
  if (cluster) {
    data.profile = { ...data.profile, clusters: data.profile.clusters.map((c) => (c.anchor === Number(cluster[1]) ? { ...c, ...b } : c)) };
    return json({ ok: true });
  }
  if (path === '/jobs') return json({ ok: true });
  if (path === '/hot/refresh') return json(data.hot);
  const done = acted(method, path, entry, b);
  return done ?? json({ error: READ_ONLY }, 403);
}

// What the actions that would write, fetch or ask the AI answer here: what they would have done, nothing kept.
const FULL_TEXT = '<p>（演示：真实使用时这里是从原网页抓回的全文，订阅里没给的段落和图片都在。）</p>';
function acted(method: string, path: string, entry: RegExpExecArray | null, b: Record<string, unknown>): Response | null {
  // A layout or 滚动标为已读 picked for a feed or a folder holds for this visit.
  const own = /^\/(feeds|categories)\/(\d+)$/.exec(path);
  if (own && method === 'PATCH') {
    const id = Number(own[2]);
    const keep = Object.fromEntries(Object.entries(b).filter(([k]) => k === 'layout' || k === 'scroll_read'));
    if (!Object.keys(keep).length) return json({ error: '演示版不改订阅：真实使用时这里会保存' }, 403);
    data.state = own[1] === 'feeds'
      ? { ...data.state, feeds: data.state.feeds.map((f) => (f.id === id ? { ...f, ...keep } : f)) }
      : { ...data.state, categories: data.state.categories.map((c) => (c.id === id ? { ...c, ...keep } : c)) };
    return json({ ok: true });
  }
  const d = entry ? data.details[entry[1]] : undefined;
  if (d && entry?.[2] === 'ai') {
    const next: EntryDetail = {
      ...d, ai_state: 2,
      ai_summary: d.ai_summary ?? `<p>演示摘要：${d.title}。真实使用时由你配置的模型读全文后写成两三句话。</p>`,
      content_full: b.fulltext ? d.content_full ?? `${d.content ?? ''}${FULL_TEXT}` : d.content_full,
    };
    data.details[entry[1]] = next;
    return json(next);
  }
  if (d && entry?.[2] === 'translate') {
    return d.content_tr ? json(d) : json({ error: '演示版只预先翻译了外文的几篇：真实使用时这里会调用模型翻译' }, 400);
  }
  if (d && entry?.[2] === 'clip') {
    const day = new Date();
    const ym = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`;
    return json({ path: '', relPath: `WebClips/${day.getFullYear()}/${ym}/${d.title}.md（演示，未写入）`, existed: false, analysis: 'off' });
  }
  if (path === '/digest') {
    const ids = (b.ids as number[] | undefined) ?? [];
    const titles = ids.map((id) => items.get(id)?.title).filter(Boolean).slice(0, 3);
    return json({ summary: `演示摘要：这一组 ${ids.length} 条说的是${titles.map((t) => `「${t}」`).join('、')}等。真实使用时由模型读完整组写成一段。`, cached: false });
  }
  if (path === '/douban/wish' || path === '/books/wish') return json({ ok: true, synced: false, subject: String(b.subject ?? '') });
  if (path === '/feeds/discover') {
    const url = String(b.url ?? '');
    return json({ candidates: [{ url, title: '（演示）在这个地址找到的订阅源', items: 20, view: 'article', kind: 'RSS' }] });
  }
  if (path === '/feeds' || path === '/categories' || path === '/opml') return json({ error: '演示版不添加订阅：真实使用时会订阅并立刻抓一次' }, 403);
  if (/^\/feeds\/\d+\/refresh$/.test(path)) return json({ ok: true, added: 0 });
  if (path === '/refresh') return json({ ok: true });
  if (path === '/reports/run') return json({ busy: false, results: [{ kind: b.kind, period: '', path: '', built: false, note: '演示版不调用模型，报告是预先生成的' }] });
  if (path === '/embedding/test') return json({ ok: true, dim: 1024 });
  if (path === '/settings') return json({ error: '演示版不保存设置' }, 403);
  return null;
}

const PLACES: [RegExp, string][] = [[/bilibili\.com|b23\.tv/, ' B 站'], [/douban\.com/, '豆瓣'], [/cnki\.net/, '知网'], [/meeting\.tencent|zoom\./, '会议链接']];
const placeOf = (href: string): string => PLACES.find(([re]) => re.test(href))?.[1] ?? '原文';

export function installDemo(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!/\/api\//.test(url.pathname)) return real(input, init);
    const text = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    return route((init?.method ?? 'GET').toUpperCase(), url, body);
  };
  // Nothing pushes changes in the demo.
  window.EventSource = class { addEventListener(): void {} close(): void {} } as unknown as typeof EventSource;
  // Links lead out to 豆瓣, B站, CNKI and invented addresses: say where instead of opening them.
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.origin === location.origin || a.dataset.demoOut !== undefined) return;
    e.preventDefault();
    e.stopPropagation();
    notify(`演示版不打开外链：真实使用时这里会打开${placeOf(a.href)}`);
  }, true);
  // The keys that open the original (space, o, ↵) go through window.open.
  window.open = (url?: string | URL): null => {
    notify(`演示版不打开外链：真实使用时这里会打开${placeOf(String(url ?? ''))}`);
    return null;
  };
  const banner = document.createElement('div');
  banner.className = 'demo-banner';
  const out = (text: string, href: string): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    a.dataset.demoOut = '';
    if (href !== HOME) a.target = '_blank';
    return a;
  };
  const note = document.createElement('span');
  note.textContent = '演示版 · 内容虚构，改动不保存';
  banner.append(out('← 主页', HOME), note, out('下载', DOWNLOADS), out('GitHub', REPO));
  document.body.append(banner);
}
