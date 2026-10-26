// 豆瓣 for 书单: the books of a 豆列, which subject a listed book is, and marking it 想读. Few requests,
// each on demand: a 豆列 is fetched once a week at most, a book is looked up once. Everything is asked
// as a visitor. 想读 is kept here; an extra that can write to the reader's own 豆瓣 account also marks
// it there (server/extras.ts).
import type { DB } from '../db.ts';
import { extras } from '../extras.ts';
import { log } from '../log.ts';
import { normTitle } from '../report/ngram.ts';
import { dateOf, type ListedBook } from './books.ts';

export const DOUBAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const DOUBAN_TIMEOUT_MS = 12_000;
const UA = DOUBAN_UA, TIMEOUT_MS = DOUBAN_TIMEOUT_MS;
const DOULIST_MAX_PAGES = 4;          // 100 books; a longer 豆列 shows its first hundred
const DOULIST_PAGE = 25;
const DOULIST_FRESH_S = 7 * 86400;
const PAGE_GAP_MS = 1500;
const MISS_RETRY_S = 30 * 86400;      // a book not yet on 豆瓣 is looked up again after a month

export class DoubanError extends Error {}

// A visitor's bid, as douban gives one to any browser; asked for again after a week.
const VISITOR_FOR_MS = 7 * 86400_000;
let visitor: { cookie: string; at: number } | null = null;
async function visitorCookie(): Promise<string> {
  if (visitor && Date.now() - visitor.at < VISITOR_FOR_MS) return visitor.cookie;
  const r = await fetch('https://www.douban.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  const bid = r?.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('bid=')) ?? '';
  // No bid (douban unreachable, say) is not kept: a week of asking without one read as douban refusing.
  if (bid) visitor = { cookie: bid, at: Date.now() };
  else log.warn('[douban] 没拿到访客 bid，这次不带 cookie 请求');
  return bid;
}

async function get(url: string, extra: Record<string, string> = {}, redirect: RequestRedirect = 'follow'): Promise<Response> {
  const jar = await visitorCookie();
  // A dropped connection or a timeout reads as 豆瓣 being unreachable, not as a server error.
  const r = await fetch(url, { headers: { ...(jar ? { Cookie: jar } : {}), 'User-Agent': UA, ...extra }, redirect, signal: AbortSignal.timeout(TIMEOUT_MS) })
    .catch((err: Error) => { throw new DoubanError(`豆瓣没连上（${err.name === 'TimeoutError' ? '超时' : err.message}），稍后再试`); });
  if (r.status === 403) throw new DoubanError('豆瓣拒绝了请求（403），可能是请求太频，稍后再试');
  return r;
}

export const doulistIdOf = (html: string): string | null => /douban\.com\/doulist\/(\d+)/.exec(html)?.[1] ?? null;

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–' };
const unescape = (s: string): string => s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] !== '#' ? ENTITIES[e.toLowerCase()] ?? m
  : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
const text = (s: string): string => unescape(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// One page of a 豆列: its book items (films and others are left out).
export function parseDoulistPage(html: string): { books: ListedBook[]; pages: number } {
  const pages = Number(/data-total-page="(\d+)"/.exec(html)?.[1] ?? 1);
  const books = html.split('class="doulist-item"').slice(1).flatMap((chunk): ListedBook[] => {
    const subject = /<div class="title">\s*<a href="https:\/\/book\.douban\.com\/subject\/(\d+)\/?"/.exec(chunk)?.[1];
    if (!subject) return [];
    const title = text(/<div class="title">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? '');
    const abstract = /<div class="abstract">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? '';
    const field = (name: string): string => text(new RegExp(`${name}:\\s*([^<]*)`).exec(abstract)?.[1] ?? '');
    return [{ title, cover: /<div class="post">[\s\S]*?<img src="([^"]+)"/.exec(chunk)?.[1] ?? null,
      authors: field('作者'), translators: field('译者'), publisher: field('出版社'), date: dateOf(field('出版年')) ?? '',
      isbn: '', subject, price: '', blurb: '' }];
  });
  return { books, pages };
}

// Cached for a week; null when it has never been fetched and fetchNow is false.
export async function doulistBooks(db: DB, id: string, fetchNow: boolean): Promise<ListedBook[] | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT books, fetched FROM doulist WHERE id = ?').get(id) as { books: string; fetched: number } | undefined;
  if (row && (now - row.fetched < DOULIST_FRESH_S || !fetchNow)) return JSON.parse(row.books) as ListedBook[];
  if (!fetchNow) return null;
  const books: ListedBook[] = [];
  for (let page = 0, pages = 1; page < Math.min(pages, DOULIST_MAX_PAGES); page++) {
    if (page) await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
    const r = await get(`https://www.douban.com/doulist/${id}/${page ? `?start=${page * DOULIST_PAGE}` : ''}`);
    if (!r.ok) throw new DoubanError(`豆列打不开（HTTP ${r.status}）`);
    const parsed = parseDoulistPage(await r.text());
    pages = parsed.pages;
    books.push(...parsed.books);
  }
  db.prepare('INSERT INTO doulist (id, books, fetched) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET books = excluded.books, fetched = excluded.fetched')
    .run(id, JSON.stringify(books), now);
  return books;
}

const bookKey = (b: { isbn: string; title: string }): string => (b.isbn ? `isbn:${b.isbn}` : `title:${normTitle(b.title)}`);

// What 豆瓣 says of a book whose post leaves something out: its cover, when it came out, who wrote it, who published it.
export interface Details { cover: string | null; date: string; authors: string; publisher: string }
export interface KnownBook extends Details { subject: string | null; wished: boolean }

interface DetailsRow { key: string; subject: string | null; wished_at: number | null; cover: string | null; date: string | null; authors: string | null; publisher: string | null }
const detailsOf = (r: DetailsRow): Details => ({ cover: tileSized(r.cover), date: r.date ?? '', authors: r.authors ?? '', publisher: r.publisher ?? '' });

// What Lumen already knows of each book: its subject, what 豆瓣 filled in, and whether 想读 was marked from here.
export function knownBooks(db: DB, books: readonly ListedBook[]): Map<string, KnownBook> {
  const keys = books.map(bookKey);
  const out = new Map<string, KnownBook>();
  if (!keys.length) return out;
  const rows = db.prepare(`SELECT key, subject, wished_at, cover, date, authors, publisher FROM douban_book WHERE key IN (${keys.map(() => '?').join(', ')})`)
    .all(...keys) as unknown as DetailsRow[];
  for (const r of rows) out.set(r.key, { subject: r.subject, wished: r.wished_at !== null, ...detailsOf(r) });
  return out;
}
export const keyOf = bookKey;

// The suggestions carry a thumbnail (/s/) too small for a tile; the same picture comes in /m/.
const tileSized = (u: string | null): string | null => u?.replace('/view/subject/s/', '/view/subject/m/') || null;

interface Suggestion { title?: string; id?: string; type?: string; pic?: string; year?: string; author_name?: string }

// 豆瓣's title suggestions: the one whose title is the book's (main) title.
function suggested(items: readonly Suggestion[], title: string): Suggestion | null {
  const full = normTitle(title), main = normTitle(title.split(/[：:]|——/)[0]);
  const books = items.filter((i) => (i.type ?? 'b') === 'b' && i.id);
  return books.find((i) => normTitle(i.title ?? '') === full) ?? books.find((i) => normTitle(i.title ?? '') === main) ?? null;
}
export const pickSuggestion = (items: readonly Suggestion[], title: string): string | null => suggested(items, title)?.id ?? null;

// The cover of a subject page, as it offers it to link previews.
export const ogImageOf = (html: string): string | null =>
  /<meta\s+property="og:image"\s+content="([^"]+)"/.exec(html)?.[1] ?? null;

// A subject page's info block: 「<span class="pl"> 作者</span>: <a>史乐民</a> / …<br>」, one field per <br>.
export function subjectDetails(html: string): Details {
  const info = /<div id="info"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const field = (name: string): string => {
    const m = new RegExp(`<span class="pl">\\s*${name}\\s*:?\\s*</span>\\s*:?([\\s\\S]*?)<br`).exec(info);
    return m ? text(m[1]).replace(/^[:：]\s*/, '').replace(/\s*\/\s*/g, ' / ') : '';
  };
  return { cover: ogImageOf(html), date: dateOf(field('出版年')) ?? '', authors: field('作者'), publisher: field('出版社') || field('出品方') };
}

async function lookUp(b: { isbn: string; title: string }): Promise<{ subject: string | null } & Details> {
  if (b.isbn) {
    const r = await get(`https://book.douban.com/isbn/${b.isbn}/`);
    const subject = /book\.douban\.com\/subject\/(\d+)/.exec(r.url)?.[1];
    if (r.ok && subject) return { subject, ...subjectDetails(await r.text()) };
  }
  const r = await get(`https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(b.title.split(/[：:]|——/)[0])}`, { 'X-Requested-With': 'XMLHttpRequest' });
  if (!r.ok) throw new DoubanError(`豆瓣搜索失败（HTTP ${r.status}）`);
  const hit = suggested(await r.json() as Suggestion[], b.title);
  return { subject: hit?.id ?? null, cover: tileSized(hit?.pic ?? null), date: hit?.year ? dateOf(hit.year) ?? '' : '', authors: hit?.author_name ?? '', publisher: '' };
}

// Each lookup records all it found, so what is asked for later costs nothing. cover_at: when the details were looked for.
function remember(db: DB, b: { isbn: string; title: string }, found: { subject: string | null } & Details, now: number): void {
  db.prepare(`INSERT INTO douban_book (key, subject, title, looked_at, cover, cover_at, date, authors, publisher) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET subject = COALESCE(excluded.subject, douban_book.subject), looked_at = excluded.looked_at,
      cover = excluded.cover, cover_at = excluded.cover_at, date = excluded.date, authors = excluded.authors, publisher = excluded.publisher`)
    .run(bookKey(b), found.subject, b.title, now, found.cover ?? '', now, found.date, found.authors, found.publisher);
}

// The subject a book is, looked up once (a miss is retried after a month).
async function subjectOf(db: DB, b: { isbn: string; title: string; subject?: string | null }): Promise<string | null> {
  if (b.subject) return b.subject;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT subject, looked_at FROM douban_book WHERE key = ?').get(bookKey(b)) as { subject: string | null; looked_at: number } | undefined;
  if (row && (row.subject || now - row.looked_at < MISS_RETRY_S)) return row.subject;
  const found = await lookUp(b);
  remember(db, b, found, now);
  return found.subject;
}

// 豆瓣's details for a book its post leaves some out of, looked for once (a book not found is tried again after a month).
// fetched: 豆瓣 was asked this time (the page spaces such asks out; an answer from the table needs no wait).
type KeptRow = DetailsRow & { cover_at: number | null };
const keptRow = (db: DB, b: { isbn: string; title: string }): KeptRow | undefined =>
  db.prepare('SELECT key, subject, wished_at, cover, cover_at, date, authors, publisher FROM douban_book WHERE key = ?').get(bookKey(b)) as KeptRow | undefined;
// date is NULL on a row looked up before details were kept.
const answered = (row: KeptRow | undefined, now: number): boolean =>
  row?.cover_at != null && row.date !== null && (!!row.subject || now - row.cover_at < MISS_RETRY_S);
// Whether detailsFor would ask 豆瓣 for this book now.
export const needsDetails = (db: DB, b: { isbn: string; title: string }): boolean => !answered(keptRow(db, b), Math.floor(Date.now() / 1000));

export async function detailsFor(db: DB, b: { isbn: string; title: string }): Promise<{ subject: string | null; fetched: boolean } & Details> {
  const now = Math.floor(Date.now() / 1000);
  const row = keptRow(db, b);
  if (row && answered(row, now)) return { subject: row.subject, fetched: false, ...detailsOf(row) };
  const found = await lookUp(b);
  remember(db, b, found, now);
  return { ...found, subject: found.subject ?? row?.subject ?? null, fetched: true };
}

// Mark a book 想读: kept here, and on the reader's 豆瓣 account too where an extra does that
// (synced says so). The subject is still looked up, so that the mark follows the book across lists.
export async function markWish(db: DB, b: { isbn: string; title: string; subject?: string | null }): Promise<{ subject: string; synced: boolean }> {
  const subject = await subjectOf(db, b);
  if (!subject) throw new DoubanError('豆瓣上没找到这本书');
  if (extras.doubanWish) await extras.doubanWish('book', subject);
  const key = bookKey(b), now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO douban_book (key, subject, title, looked_at, wished_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET subject = excluded.subject, wished_at = excluded.wished_at`).run(key, subject, b.title, now, now);
  keepWish(db, subject, now);
  return { subject, synced: !!extras.doubanWish };
}

// ── 这本书的其他版本 ───────────────────────────────────────────────────────────────────────────
// A book's subject page lists a few other editions of the same work (「这本书的其他版本 · 全部615」),
// each 「出版社 （年）」 with its rating and how many read it. Fetched when a book is opened, kept a month.
const EDITIONS_FRESH_S = 30 * 86400;

export interface Edition { subject: string; publisher: string; year: string; rating: number | null; readers: number }
export interface Editions { works: string | null; total: number; editions: Edition[]; wished: boolean; page: SubjectPage | null }

// ── 条目页 ────────────────────────────────────────────────────────────────────────────────────
// What else the same page holds, read from the one fetch the editions already cost.
// PAGE_VERSION: a page kept under an older reading is fetched again.
export const PAGE_VERSION = 2;
export interface ShortComment { who: string; stars: number | null; time: string; text: string; votes: number }
export interface Similar { subject: string; title: string; cover: string | null; rating: number | null }
export interface SubjectPage {
  v: number;
  title: string; cover: string | null;
  fields: [string, string][];          // the info block as it stands: 作者, 译者, 出版社 …
  rating: number | null; votes: number;
  doing: number; done: number; wish: number;
  intro: string[]; authorIntro: string[]; toc: string[];
  comments: ShortComment[]; commentTotal: number; reviewTotal: number;
  similar: Similar[];
}

const paragraphs = (html: string): string[] => {
  const ps = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => text(m[1])).filter((p) => p && !/^\(展开全部\)$/.test(p));
  return ps.length ? ps : html.split(/<br\s*\/?>/).map(text).filter(Boolean);
};

// The section under 「<h2><span>内容简介</span>」: its full text when it is folded (span.all), else the shown one.
function section(html: string, name: string): string | null {
  const at = html.search(new RegExp(`<h2>\\s*<span[^>]*>${name}</span>`));
  if (at < 0) return null;
  const rest = html.slice(at);
  const end = rest.slice(5).search(/<h2>|<div id="db-rec-section"|<div id="comments-section"/);
  return end < 0 ? rest : rest.slice(0, end + 5);
}
function introOf(html: string, name: string): string[] {
  const s = section(html, name);
  if (!s) return [];
  const full = /<span class="all hidden">([\s\S]*?)<\/span>\s*<\/div>/.exec(s)?.[1] ?? /<div class="intro">([\s\S]*?)<\/div>/.exec(s)?.[1] ?? '';
  return paragraphs(full);
}

// A short comment's own line breaks stay (the page shows them).
const lines = (s: string): string => s.split(/\n+/).map(text).filter(Boolean).join('\n');
const num = (s: string | undefined): number => Number(s?.replace(/,/g, '') ?? 0) || 0;
const STARS: Record<string, number> = { allstar10: 1, allstar20: 2, allstar30: 3, allstar40: 4, allstar50: 5 };

export function parseSubjectPage(html: string): SubjectPage {
  const info = /<div id="info"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const fields = info.split(/<br\s*\/?>/).map((chunk): [string, string] | null => {
    const label = /<span class="pl">([\s\S]*?)<\/span>/.exec(chunk);
    if (!label) return null;
    const name = text(label[1]).replace(/[:：]\s*$/, '');
    const value = text(chunk.slice(label.index + label[0].length)).replace(/^[:：]\s*/, '').replace(/\s*\/\s*/g, ' / ');
    return name && value ? [name, value] : null;
  }).filter((f): f is [string, string] => !!f);
  const dir = /<div class="indent" id="dir_\d+_full"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]
    ?? /<div class="indent" id="dir_\d+_short"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const toc = dir.split(/<br\s*\/?>/).map(text).filter((l) => l && !/^[·\s]+(\(.*\))?$/.test(l) && !/^·\s·/.test(l));
  const comments = [...html.matchAll(/<li class="comment-item"[\s\S]*?<\/li>/g)].slice(0, 10).map(([li]): ShortComment => ({
    who: text(/<span class="comment-info">\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(li)?.[1] ?? ''),
    stars: STARS[/user-stars (allstar\d0)/.exec(li)?.[1] ?? ''] ?? null,
    time: /class="comment-time"[^>]*>([^<]+)</.exec(li)?.[1]?.trim().slice(0, 10) ?? '',
    text: lines(/<span class="hide-item full">([\s\S]*?)<\/span>/.exec(li)?.[1] ?? /<span class="short">([\s\S]*?)<\/span>/.exec(li)?.[1] ?? ''),
    votes: num(/class="vote-count"[^>]*>(\d+)</.exec(li)?.[1]),
  })).filter((c) => c.text);
  const rec = /<div id="db-rec-section"[\s\S]*?<div class="content clearfix">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const similar = [...rec.matchAll(/<dl>([\s\S]*?)<\/dl>/g)].map(([, dl]): Similar | null => {
    const subject = /subject\/(\d+)\//.exec(dl)?.[1];
    if (!subject) return null;
    const rate = /<span class="subject-rate">([\d.]+)<\/span>/.exec(dl)?.[1];
    return { subject, title: text(/<dd>\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(dl)?.[1] ?? ''), cover: /<img[^>]*src="([^"]+)"/.exec(dl)?.[1] ?? null, rating: rate ? Number(rate) : null };
  }).filter((s): s is Similar => !!s);
  const count = (status: string): number => num(new RegExp(`status=${status}">(\\d+)人`).exec(html)?.[1]);
  const rating = /property="v:average">\s*([\d.]+)\s*</.exec(html)?.[1];
  return {
    v: PAGE_VERSION,
    title: text(/<span property="v:itemreviewed">([\s\S]*?)<\/span>/.exec(html)?.[1] ?? ''), cover: ogImageOf(html),
    fields, rating: rating ? Number(rating) : null, votes: num(/property="v:votes">(\d+)</.exec(html)?.[1]),
    doing: count('N'), done: count('P'), wish: count('F'),
    intro: introOf(html, '内容简介'), authorIntro: introOf(html, '作者简介'), toc,
    comments, commentTotal: num(/comments\/">全部 (\d+) 条/.exec(html)?.[1]),
    reviewTotal: num(/<a href="reviews">全部 (\d+) 条/.exec(html)?.[1]),
    similar,
  };
}

const EDITION = /<div class="meta">\s*<a href="https:\/\/book\.douban\.com\/subject\/(\d+)\/">([^<]+)<\/a>\s*<div class="count">([\s\S]*?)<\/div>/g;

export function parseEditions(html: string): Omit<Editions, 'wished' | 'page'> {
  const works = /book\.douban\.com\/works\/(\d+)">全部(\d+)/.exec(html);
  const editions = [...html.matchAll(EDITION)].map(([, subject, label, count]): Edition => {
    const m = /^(.*?)\s*[（(]\s*(\d{4})?[^）)]*[）)]\s*$/.exec(text(label).trim());
    const c = text(count);
    return {
      subject, publisher: (m?.[1] ?? text(label)).trim(), year: m?.[2] ?? '',
      rating: /([\d.]+)分/.test(c) ? Number(/([\d.]+)分/.exec(c)![1]) : null,
      readers: Number(/(\d+)人读过/.exec(c)?.[1] ?? 0),
    };
  });
  return { works: works?.[1] ?? null, total: works ? Number(works[2]) : editions.length, editions };
}

interface SubjectRow { works: string | null; total: number | null; editions: string | null; editions_at: number | null; wished_at: number | null; page: string | null }

const pageOf = (raw: string | null): SubjectPage | null => {
  const p = raw ? JSON.parse(raw) as SubjectPage : null;
  return p?.v === PAGE_VERSION ? p : null;
};

export async function editionsOf(db: DB, subject: string): Promise<Editions> {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT works, total, editions, editions_at, wished_at, page FROM douban_subject WHERE subject = ?').get(subject) as SubjectRow | undefined;
  const kept = pageOf(row?.page ?? null);
  if (row?.editions_at && now - row.editions_at < EDITIONS_FRESH_S && kept) {
    return { works: row.works, total: row.total ?? 0, editions: JSON.parse(row.editions ?? '[]') as Edition[], wished: !!row.wished_at, page: kept };
  }
  const r = await get(`https://book.douban.com/subject/${subject}/`);
  if (!r.ok) throw new DoubanError(`豆瓣条目打不开（HTTP ${r.status}）`);
  const html = await r.text();
  // A login or risk-control page answers 200 too; cached, it would read 「只有这一版」 for a month.
  if (!/book\.douban\.com\/subject\//.test(r.url) || !html.includes('id="info"')) throw new DoubanError('豆瓣返回的不是条目页，稍后再试');
  const found = parseEditions(html);
  const page = parseSubjectPage(html);
  db.prepare(`INSERT INTO douban_subject (subject, works, total, editions, editions_at, page) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET works = excluded.works, total = excluded.total, editions = excluded.editions, editions_at = excluded.editions_at, page = excluded.page`)
    .run(subject, found.works, found.total, JSON.stringify(found.editions), now, JSON.stringify(page));
  return { ...found, wished: !!row?.wished_at, page };
}


// From a 书影音标记 card, by subject; synced as markWish.
export async function markInterest(db: DB, kind: 'book' | 'movie', subject: string): Promise<{ synced: boolean }> {
  if (extras.doubanWish) await extras.doubanWish(kind, subject);
  keepWish(db, subject, Math.floor(Date.now() / 1000));
  return { synced: !!extras.doubanWish };
}

// Every 想读 / 想看 marked from Lumen, wherever it was clicked, is kept by subject: each page that shows
// a book or a film asks wishedSubjects, so a mark made on one shows on all.
function keepWish(db: DB, subject: string, now: number): void {
  db.prepare('INSERT INTO douban_subject (subject, wished_at) VALUES (?, ?) ON CONFLICT(subject) DO UPDATE SET wished_at = excluded.wished_at')
    .run(subject, now);
}

// The reader's own 想读 / 读过 … on 豆瓣, from their interests feed (its titles read 「想读夺回时间」), by subject.
export function ownMarks(db: DB): Map<string, string> {
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

export const wishedSubjects = (db: DB, subjects: readonly string[]): Set<string> => subjects.length
  ? new Set((db.prepare(`SELECT subject FROM douban_subject WHERE wished_at IS NOT NULL AND subject IN (${subjects.map(() => '?').join(', ')})`)
    .all(...subjects) as { subject: string }[]).map((r) => r.subject))
  : new Set();
