// 书单 as Lumen shows them: the books of one post (its text, or the 豆列 a 关注书单 broadcast points to),
// each marked with whether Zotero has it and whether 想读 was marked from here; and 新书, every such
// post's books once, by post or by date.
import type { DB } from '../db.ts';
import { extractBooks, dateOf, LIST_POST, type ListedBook } from './books.ts';
import { doulistBooks, doulistIdOf, knownBooks, keyOf, wishedSubjects, ownMarks } from './douban.ts';
import { zoteroLibrary, inLibrary } from './library.ts';
import { normTitle } from '../report/ngram.ts';
import { sortedOf, BOOK_KINDS, OTHER_TOPIC } from './bookkinds.ts';
import { reprintBookIndex, type BookReprint } from './reprints.ts';
import { shelvesOf, type Shelf } from './bookshelves.ts';

// mine: what the reader marked it on 豆瓣 themselves (读过, 想读 …), from their interests feed.
export interface BookView extends ListedBook { inZotero: boolean | null; wished: boolean; mine: string | null }

interface PostRow { id: number; title: string; html: string | null; feed: string; feed_id: number; published: number; link: string | null }

const DOULIST_POST = /关注书单|豆列/;
// 「想读心性现实主义论稿」: a 豆瓣 mark of one book is not a 书单.
const MARK_POST = /^(?:想读|读过|在读|看过|想看|在看)/;
const FEED_CACHE_MS = 30 * 60_000;    // how long before the whole table is scanned again

// A 豆列 cached before dates had their own field printed them after the publisher: 「三联书店 · 2018-12」.
function withDate(b: ListedBook): ListedBook {
  if (b.date !== undefined) return b;
  const [, publisher = b.publisher, printed = ''] = /^(.*?)\s*·\s*([^·]+)$/.exec(b.publisher) ?? [];
  const date = dateOf(printed);
  return date ? { ...b, publisher, date } : { ...b, date: '' };
}

export function viewBooks(db: DB, books: readonly ListedBook[]): BookView[] {
  if (!books.length) return [];
  const lib = zoteroLibrary();
  const known = knownBooks(db, books);
  const subjectOf = (b: ListedBook): string | null => b.subject ?? known.get(keyOf(b))?.subject ?? null;
  const wished = wishedSubjects(db, [...new Set(books.map(subjectOf).filter((s): s is string => !!s))]);
  const own = ownMarks(db);
  return books.map((old) => {
    const b = withDate(old);
    const k = known.get(keyOf(b));
    const subject = b.subject ?? k?.subject ?? null;
    return { ...b, cover: b.cover ?? k?.cover ?? null, date: b.date || k?.date || '', authors: b.authors || k?.authors || '',
      publisher: b.publisher || k?.publisher || '', subject, inZotero: lib ? inLibrary(lib, b) : null,
      wished: !!k?.wished || (!!subject && wished.has(subject)), mine: (subject && own.get(subject)) ?? null };
  });
}

// fetchDoulist: the reader opened this post, so a 豆列 not seen yet may be fetched now.
export async function postBooks(db: DB, row: { title: string; html: string | null }, fetchDoulist: boolean): Promise<{ books: BookView[]; pending: boolean }> {
  const html = row.html ?? '';
  const doulist = DOULIST_POST.test(row.title) ? doulistIdOf(html) : null;
  if (doulist) {
    const books = await doulistBooks(db, doulist, fetchDoulist);
    return { books: books ? viewBooks(db, books) : [], pending: !books };
  }
  return { books: viewBooks(db, extractBooks(html, row.title)), pending: false };
}

interface ScannedPost { row: PostRow; doulist: boolean; books: ListedBook[] }
let feedCache: { db: DB; at: number; top: number; posts: ScannedPost[] } | null = null;

const scanPost = (row: PostRow): ScannedPost[] => {
  if (DOULIST_POST.test(row.title) && doulistIdOf(row.html ?? '')) return [{ row, doulist: true, books: [] }];
  if (MARK_POST.test(row.title) || !/ISBN/.test(row.html ?? '') && !LIST_POST.test(row.title)) return [];
  const books = extractBooks(row.html ?? '', row.title);
  return books.length ? [{ row, doulist: false, books }] : [];
};

// Every 书单 post, newest first. Posts that came in since the last scan are scanned on their own;
// the whole table again only every so often, for full texts fetched later and posts pruned.
function bookPosts(db: DB): ScannedPost[] {
  const top = (db.prepare('SELECT max(id) AS m FROM entry').get() as { m: number | null }).m ?? 0;
  const fresh = feedCache && feedCache.db === db && Date.now() - feedCache.at < FEED_CACHE_MS ? feedCache : null;
  if (fresh && fresh.top === top) return fresh.posts;
  const rows = db.prepare(`SELECT e.id, e.title, COALESCE(e.content_full, e.content) AS html, f.title AS feed, f.id AS feed_id, e.published, e.link
    FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.id > ? AND (e.title LIKE '%书%' OR COALESCE(e.content_full, e.content) LIKE '%ISBN%') ORDER BY e.published DESC, e.id DESC`)
    .all(fresh?.top ?? 0) as unknown as PostRow[];
  const scanned = rows.flatMap(scanPost);
  const posts = fresh
    ? [...scanned, ...fresh.posts].sort((a, b) => b.row.published - a.row.published || b.row.id - a.row.id)
    : scanned;
  feedCache = { db, at: fresh?.at ?? Date.now(), top, posts };
  return posts;
}

// The posts 新书 lists books from, 豆列 among them: retention spares them (retention.ts).
export const bookPostIds = (db: DB): number[] => bookPosts(db).map((p) => p.row.id);

export interface BookFrom { id: number; title: string; feed: string; feedId: number; published: number }
// posts: how many 书单 listed it; month: its section when by date; topic: its 主题, null until classified;
// reprint: what 人大复印 took up about it or by its author (reprints.ts); shelf: its shelf within the month (bookshelves.ts).
export interface NewBook { book: BookView; from: BookFrom; posts: number; month?: string; shelf?: string; topic: string | null; kind: string | null; reprint?: BookReprint }
export interface NewBooksQuery { offset: number; limit: number; byDate: boolean; recentMonths: number; notOwned: boolean; topic?: string; kind?: string; humanities?: boolean; shelves?: boolean }
export interface MonthCount { label: string; n: number; shelves?: Shelf[] }
export interface NewBooksPage { books: NewBook[]; total: number; posts: number; months?: MonthCount[];
  topics: { label: string; n: number }[]; kinds: { label: string; n: number }[]; unsorted: { key: string; b: ListedBook }[]; undated: ListedBook[] }

// 「2026年4月」 → months since year 0. A year alone counts as its last month when deciding what is
// recent, so it is never cut too soon, and as before its first when ordering, so it follows the
// books of that year whose month is known.
function monthOf(date: string, yearAlone: 'last' | 'before'): number | null {
  const m = /^(\d{4})年(?:(\d{1,2})月)?$/.exec(date);
  return m ? +m[1] * 12 + (m[2] ? +m[2] - 1 : yearAlone === 'last' ? 11 : -0.5) : null;
}

export const tileKey = (b: ListedBook): string => b.isbn || b.subject || normTitle(b.title);

// ── one book, one tile ────────────────────────────────────────────────────────────────────────────
// Two posts often list one book differently: one prints the ISBN and the other not, one the subtitle
// and the other not, one in 《》. Measured 2026-10-23: 51 of 714 tiles were such repeats. They are one
// tile when the ISBN agrees, or when the title up to its subtitle agrees and so does the publisher
// (which keeps two books of one short title apart). The publisher is compared on what is left once
// the words every publisher shares are taken out, places too: 「大学问 | 广西师范」 and 「广西师范大学出版社」
// agree, 「上海人民出版社」 and 「上海译文出版社」 do not. A publisher with nothing left, or none printed,
// agrees only with one that contains it (「上海书店出版社·也人」), or when the title is long enough not
// to be another book's.
const GENERIC_PUBLISHER = /出版社|出版集团|出版公司|出版中心|有限公司|出版|集团|大学|人民|书局|书店|文化|印书馆|文艺|传媒|股份/g;
const PLACE = /中国|北京|上海|天津|重庆|广西|广东|江苏|浙江|四川|湖南|湖北|山东|河南|河北|山西|陕西|安徽|福建|江西|云南|贵州|辽宁|吉林|黑龙江|甘肃|青海|宁夏|新疆|西藏|内蒙古|海南|华东|华中|东北|西南|西北/g;
const LONG_TITLE = 6;
export const titleCore = (t: string): string => normTitle(t.replace(/^《(.*)》$/, '$1').split(/[：:（(]/)[0]);
function publisherPairs(p: string): Set<string> {
  const han = p.replace(GENERIC_PUBLISHER, ' ').replace(PLACE, ' ').match(/\p{Script=Han}+/gu) ?? [];
  return new Set(han.flatMap((w) => [...w].slice(0, -1).map((c, i) => c + w[i + 1])));
}
function samePublisher(a: string, b: string, core: string): boolean {
  const pa = publisherPairs(a), pb = publisherPairs(b);
  if (pa.size && pb.size) return [...pa].some((x) => pb.has(x));
  const [na, nb] = [normTitle(a), normTitle(b)];
  return (!!na && !!nb && (na.includes(nb) || nb.includes(na))) || core.length >= LONG_TITLE;
}
function sameBook(a: ListedBook, b: ListedBook): boolean {
  if (a.isbn && b.isbn) return a.isbn === b.isbn;
  if (a.subject && b.subject) return a.subject === b.subject;
  const core = titleCore(a.title);
  return core.length >= 2 && core === titleCore(b.title) && samePublisher(a.publisher, b.publisher, core);
}
// What each listing knows, together: the first that has a field gives it; the longest title (the
// one with its subtitle) and the longest blurb win.
function combine(a: ListedBook, b: ListedBook): ListedBook {
  const pick = <K extends keyof ListedBook>(k: K): ListedBook[K] => (a[k] || b[k]) as ListedBook[K];
  const bare = (t: string): string => t.replace(/^《(.*)》$/, '$1');
  const [ta, tb] = [bare(a.title), bare(b.title)];
  return { ...a, title: tb.length > ta.length ? tb : ta, cover: pick('cover'), authors: pick('authors'), translators: pick('translators'),
    publisher: pick('publisher'), date: pick('date'), isbn: pick('isbn'), subject: pick('subject'), price: pick('price'),
    blurb: b.blurb.length > a.blurb.length ? b.blurb : a.blurb };
}
export interface Listing<F> { b: ListedBook; from: F; posts: number }
// Newest post first in, newest post first out: a merged tile keeps the post that listed it last.
// posts counts distinct posts, so one post listing a book twice, differently, counts once. A listing
// that ties two tiles together (an ISBN one of them has, a title the other has) folds them into one.
export function mergeListings<F>(listed: readonly { b: ListedBook; from: F }[]): Listing<F>[] {
  const out: ({ b: ListedBook; from: F; froms: Set<F> } | null)[] = [];
  // Only tiles sharing an ISBN, a subject or a title core can be the same book.
  const byKey = new Map<string, number[]>();
  const keys = (b: ListedBook): string[] => [b.isbn && `i:${b.isbn}`, b.subject && `s:${b.subject}`, `t:${titleCore(b.title)}`].filter((k): k is string => !!k);
  const near = (b: ListedBook): number[] => [...new Set(keys(b).flatMap((k) => byKey.get(k) ?? []))].sort((m, n) => m - n);
  const index = (i: number): void => { for (const k of keys(out[i]!.b)) if (!byKey.get(k)?.includes(i)) byKey.set(k, [...(byKey.get(k) ?? []), i]); };
  for (const x of listed) {
    const at = near(x.b).find((i) => out[i] && sameBook(out[i]!.b, x.b));
    if (at === undefined) { out.push({ b: x.b, from: x.from, froms: new Set([x.from]) }); index(out.length - 1); continue; }
    let tile = { ...out[at]!, b: combine(out[at]!.b, x.b), froms: new Set([...out[at]!.froms, x.from]) };
    for (const j of near(tile.b)) {
      const other = out[j];
      if (j === at || !other || !sameBook(tile.b, other.b)) continue;
      tile = { ...tile, b: combine(tile.b, other.b), froms: new Set([...tile.froms, ...other.froms]) };
      out[j] = null;
    }
    out[at] = tile;
    index(at);
  }
  return out.flatMap((t) => (t ? [{ b: t.b, from: t.from, posts: t.froms.size }] : []));
}

// 新书: every listed book once, from the newest post that lists it, newest post first or newest
// book first. 豆列 are left out: they gather older books, and open as a book card on their own post.
// A book with no date known yet stays in a 「recent」 list: its date is looked for once it is shown.
// The section a book falls in when 新书 is ordered by date. A 书单 lists the odd reprint of an old
// book; those from before the last two years go together under 更早出版 rather than a section each.
const EARLIER_MONTHS = 24;
export function monthLabel(date: string, now = new Date()): string {
  const m = /^(\d{4})年(?:(\d{1,2})月)?$/.exec(date);
  if (!m) return '出版时间待查';
  if ((monthOf(date, 'last') ?? 0) < now.getFullYear() * 12 + now.getMonth() - EARLIER_MONTHS) return '更早出版';
  return m[2] ? `${m[1]}年${+m[2]}月` : `${m[1]}年（月份不详）`;
}

export function newBooks(db: DB, q: NewBooksQuery): NewBooksPage {
  const listed = mergeListings(bookPosts(db).filter((p) => !p.doulist).flatMap(({ row, books }) => {
    const from: BookFrom = { id: row.id, title: row.title, feed: row.feed, feedId: row.feed_id, published: row.published };
    // One post listing a book twice (a cover line and a details line) is still one listing.
    const seen = new Set<string>();
    return books.filter((b) => !seen.has(tileKey(b)) && !!seen.add(tileKey(b))).map((b) => ({ b, from }));
  }));
  const views = viewBooks(db, listed.map((x) => x.b));
  const now = new Date();
  const cutoff = now.getFullYear() * 12 + now.getMonth() - q.recentMonths;
  const keys = listed.map((x) => tileKey(x.b));
  const sorted = sortedOf(db, keys);
  const unsorted = listed.flatMap((x, i) => (sorted.has(keys[i]) ? [] : [{ key: keys[i], b: x.b }]));
  const reprinted = reprintBookIndex(db, q.humanities);
  let all: NewBook[] = listed.map((x, i) => {
    const reprint = reprinted(views[i]);
    return { book: views[i], from: x.from, posts: x.posts, topic: sorted.get(keys[i])?.topic ?? null, kind: sorted.get(keys[i])?.kind ?? null, ...(reprint && { reprint }) };
  });
  if (q.notOwned) all = all.filter((x) => !x.book.inZotero);
  if (q.recentMonths > 0) all = all.filter((x) => { const m = monthOf(x.book.date, 'last'); return m === null || m >= cutoff; });
  // Kind counts over what the other filters leave, then narrowed to the kind; topic counts likewise
  // within it, so each chip says what choosing it would show.
  const kindCounts = new Map<string, number>();
  for (const x of all) if (x.kind) kindCounts.set(x.kind, (kindCounts.get(x.kind) ?? 0) + 1);
  const kindList = BOOK_KINDS.filter((k) => kindCounts.has(k)).map((label) => ({ label, n: kindCounts.get(label)! }));
  if (q.kind) all = all.filter((x) => x.kind === q.kind);
  const counts = new Map<string, number>();
  for (const x of all) if (x.topic) counts.set(x.topic, (counts.get(x.topic) ?? 0) + 1);
  const topicList = [...counts].sort((a, b) => (a[0] === OTHER_TOPIC ? 1 : b[0] === OTHER_TOPIC ? -1 : b[1] - a[1])).map(([label, n]) => ({ label, n }));
  if (q.topic) all = all.filter((x) => x.topic === q.topic);
  // Books whose date no post gave and 豆瓣 was not asked for yet (bookdates.ts looks them up).
  const undated = listed.flatMap((x, i) => (views[i].date ? [] : [x.b]));
  const page = { topics: topicList, kinds: kindList, unsorted, undated };
  if (q.byDate) {
    // Undated last; otherwise newest first, the post order kept among books of one month.
    const order = all.map((x, i) => ({ x, i, m: monthOf(x.book.date, 'before') ?? -1 }));
    order.sort((a, b) => b.m - a.m || a.i - b.i);
    all = order.map((o) => ({ ...o.x, month: monthLabel(o.x.book.date, now) }));
  } else {
    // By post, one section per month the 书单 came out in: what came in stays where it was put.
    all = all.map((x) => ({ ...x, month: postMonth(x.from.published) }));
  }
  // A 主题 chosen is one shelf already.
  const { books, months } = byMonth(all, !!q.shelves && !q.topic);
  return { books: books.slice(q.offset, q.offset + q.limit), total: books.length, posts: new Set(books.map((x) => x.from.id)).size, months, ...page };
}

// The months in their order, each with its count; with shelves, each month's books put shelf by shelf
// (the order within a shelf kept), so a page cut anywhere leaves a shelf whole above it.
function byMonth(all: readonly NewBook[], shelves: boolean): { books: NewBook[]; months: MonthCount[] } {
  const runs: NewBook[][] = [];
  for (const x of all) { const last = runs.at(-1); if (last && last[0].month === x.month) last.push(x); else runs.push([x]); }
  const books: NewBook[] = [];
  const months: MonthCount[] = [];
  for (const run of runs) {
    if (!shelves) { books.push(...run); months.push({ label: run[0].month!, n: run.length }); continue; }
    const cut = shelvesOf(run.map((x) => x.topic));
    const rank = new Map(cut.shelves.map((s, i) => [s.label, i]));
    const placed = run.map((x, i) => ({ x: cut.shelves.length ? { ...x, shelf: cut.of[i] } : x, r: rank.get(cut.of[i]) ?? 0, i }));
    placed.sort((a, b) => a.r - b.r || a.i - b.i);
    books.push(...placed.map((p) => p.x));
    months.push({ label: run[0].month!, n: run.length, ...(cut.shelves.length && { shelves: cut.shelves }) });
  }
  return { books, months };
}

const postMonth = (published: number): string => { const d = new Date(published * 1000); return `${d.getFullYear()}年${d.getMonth() + 1}月推送`; };
