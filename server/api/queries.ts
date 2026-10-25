import type { DB } from '../db.ts';
import { VIEWS, LAYOUTS } from '../db.ts';
import { plainText } from '../content/sanitize.ts';
import { unreadMarks, MARK_WHERE } from './marks.ts';
import { commentSource } from '../comments/comments.ts';
import { parseQuery, allTerms, ftsMatch, SHORT_TERM_SQL, LIKE, likeArg, hitSnippet, SEARCH_BODY_CHARS, type ParsedQuery } from '../search.ts';

export interface Scope {
  view?: string;
  layout?: string;     // the sidebar tab: feeds whose effective layout is this one
  feed?: number;
  category?: number;
  tag?: string;
  filter?: 'all' | 'unread' | 'starred';
  q?: string;
  snippet?: 'long';    // 动态 shows the whole post and its pictures
  since?: number;      // published at or after (a search's 近一周/近一月/近一年)
  kept?: 'starred' | 'archived';   // a search among 收藏 or what went to Obsidian (已存档)
}

// Douban 「读过 / 想看 …」 marks live in 书影音标记. Lists spanning many feeds leave them out, and
// so do the unread counts; a single person's feed and 收藏 still show them.
const NOT_MARK = `NOT (${MARK_WHERE})`;
const keepsMarks = (scope: Scope): boolean => !!scope.feed || scope.filter === 'starred' || scope.kept === 'starred';

// A feed's effective layout: its own, else its category's, else the default for its view type.
// Must match effectiveLayout() in web/src/layout.ts (tests/layout.test.ts checks they agree).
export const EFFECTIVE_LAYOUT_SQL = `COALESCE(f.layout, (SELECT c.layout FROM category c WHERE c.id = f.category_id),
  CASE f.view WHEN 'social' THEN 'social' WHEN 'video' THEN 'masonry' WHEN 'picture' THEN 'masonry' ELSE 'list' END)`;

const searchOf = (scope: Scope): ParsedQuery | null => {
  const p = scope.q?.trim() ? parseQuery(scope.q) : null;
  return p && allTerms(p).length ? p : null;
};
const SHORT_TERM_ARGS = (SHORT_TERM_SQL.match(/\?/g) ?? []).length;

// Builds a WHERE clause shared by listing and mark-all-read so both see the same set.
// With `ftsJoined` the caller has joined entry_fts and matches the long terms itself, to rank by them.
export function scopeWhere(scope: Scope, ftsJoined = false): { sql: string; args: (string | number)[] } {
  const where: string[] = ['f.removed = 0'];
  const args: (string | number)[] = [];
  if (scope.feed) { where.push('e.feed_id = ?'); args.push(scope.feed); }
  if (!keepsMarks(scope)) where.push(NOT_MARK);
  if (scope.category) { where.push('f.category_id = ?'); args.push(scope.category); }
  if (scope.view && (VIEWS as readonly string[]).includes(scope.view)) { where.push('f.view = ?'); args.push(scope.view); }
  if (scope.layout && (LAYOUTS as readonly string[]).includes(scope.layout)) { where.push(`${EFFECTIVE_LAYOUT_SQL} = ?`); args.push(scope.layout); }
  if (scope.tag) { where.push('e.id IN (SELECT entry_id FROM tag WHERE name = ?)'); args.push(scope.tag); }
  if (scope.filter === 'unread') where.push('e.is_read = 0');
  if (scope.filter === 'starred' || scope.kept === 'starred') where.push('e.is_starred = 1');
  if (scope.kept === 'archived') where.push("e.id IN (SELECT entry_id FROM tag WHERE source = 'clip')");
  if (scope.since) { where.push('e.published >= ?'); args.push(scope.since); }
  const p = searchOf(scope);
  if (p) {
    // Every term must be there: the long ones through the index, the short ones in the text.
    if (p.long.length && !ftsJoined) { where.push('e.id IN (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?)'); args.push(ftsMatch(p.long)); }
    for (const t of p.short) { where.push(SHORT_TERM_SQL); args.push(...Array<string>(SHORT_TERM_ARGS).fill(likeArg(t))); }
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

export interface ListItem {
  id: number; feed_id: number; title: string; title_zh: string | null; author: string | null; link: string | null;
  published: number; is_read: number; is_starred: number; thumbnail: string | null; enclosures: string | null;
  snippet: string; has_summary: number; is_mark: number; images?: string[];
  hit?: boolean;       // a search result whose snippet is the text around what was searched for
}

export interface Cursor { published: number; id: number }

// "published:id" — list order is publication time, so a feed's backlog fetched today
// lands where it belongs instead of on top.
export function parseCursor(raw: string | undefined): Cursor | undefined {
  const m = raw?.match(/^(\d+):(\d+)$/);
  return m ? { published: Number(m[1]), id: Number(m[2]) } : undefined;
}

const SNIPPET_CHARS = 180;
const POST_CHARS = 1200;
const POST_IMAGES = 9;
const IMG_SRC = /<img[^>]+src="([^"]+)"/g;
// Weibo's inline emoji are images too; they belong to the text, not the picture grid.
const CHROME_IMAGE = /h5\.sinaimg\.cn\/|\/emoticon|\/face\//;

export function postImages(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(IMG_SRC)) {
    const src = m[1].replace(/&amp;/g, '&');
    if (!CHROME_IMAGE.test(src) && !out.includes(src)) out.push(src);
    if (out.length >= POST_IMAGES) break;
  }
  return out;
}

const itemColumns = (long: boolean): string => `e.id, e.feed_id, e.title, e.title_zh, e.author, e.link, e.published, e.is_read, e.is_starred,
      e.thumbnail, e.enclosures, e.ai_summary IS NOT NULL AS has_summary, (${MARK_WHERE}) AS is_mark,
      ${long ? `substr(COALESCE(e.content, ''), 1, 20000)` : `substr(COALESCE(e.ai_summary, e.content, ''), 1, 1500)`} AS raw`;

const toItems = (rows: (ListItem & { raw: string })[], long: boolean): ListItem[] => rows.map(({ raw, ...r }) => (long
  ? { ...r, snippet: plainText(raw, POST_CHARS), images: postImages(raw) }
  : { ...r, snippet: plainText(raw, SNIPPET_CHARS) }));

// A search result shows where the terms are: the text around the first one found in the text,
// else in the AI summary; failing both (a title-only hit), the usual opening.
const HIT_COLUMNS = `, COALESCE(e.content_tr, e.content_full, e.content) AS hit_body, e.ai_summary AS hit_summary`;
type HitRow = ListItem & { raw: string; hit_body: string | null; hit_summary: string | null };
function withHits(rows: HitRow[], long: boolean, terms: string[]): ListItem[] {
  return rows.map(({ hit_body, hit_summary, ...r }) => {
    const [item] = toItems([r], long);
    const hit = hitSnippet(plainText(hit_body ?? '', SEARCH_BODY_CHARS), terms) ?? hitSnippet(plainText(hit_summary ?? '', SEARCH_BODY_CHARS), terms);
    return hit && !long ? { ...item, snippet: hit, hit: true } : item;
  });
}

export function listEntries(db: DB, scope: Scope, before: Cursor | undefined, limit: number): ListItem[] {
  const w = scopeWhere(scope);
  const long = scope.snippet === 'long';
  const p = searchOf(scope);
  const cursor = before ? (w.sql ? ' AND ' : 'WHERE ') + '(e.published < ? OR (e.published = ? AND e.id < ?))' : '';
  const rows = db.prepare(`SELECT ${itemColumns(long)}${p ? HIT_COLUMNS : ''}
    FROM entry e JOIN feed f ON f.id = e.feed_id ${w.sql}${cursor} ORDER BY e.published DESC, e.id DESC LIMIT ?`)
    .all(...w.args, ...(before ? [before.published, before.published, before.id] : []), limit) as unknown as HitRow[];
  return p ? withHits(rows, long, allTerms(p)) : toItems(rows, long);
}

// Weights of entry_fts's columns: a term in a title counts most, then author and summary, then text.
const BM25 = 'bm25(entry_fts, 10.0, 4.0, 1.0)';

// 按相关度: through the index by bm25 when the query has a term of three characters or more;
// with short terms only, entries naming one in a title come first. Newest first among equals.
export function searchEntries(db: DB, scope: Scope, offset: number, limit: number): ListItem[] {
  const p = searchOf(scope);
  if (!p) return [];
  const long = scope.snippet === 'long';
  const titled = p.short.map(() => `(e.title ${LIKE} OR e.title_zh ${LIKE})`).join(' + ');
  const titledArgs = p.short.flatMap((t) => [likeArg(t), likeArg(t)]);
  let rows: HitRow[];
  if (p.long.length) {
    const w = scopeWhere(scope, true);
    rows = db.prepare(`SELECT ${itemColumns(long)}${HIT_COLUMNS}, ${BM25} AS score
      FROM entry_fts JOIN entry e ON e.id = entry_fts.rowid JOIN feed f ON f.id = e.feed_id
      ${w.sql ? w.sql + ' AND' : 'WHERE'} entry_fts MATCH ?
      ORDER BY score, e.published DESC, e.id DESC LIMIT ? OFFSET ?`)
      .all(...w.args, ftsMatch(p.long), limit, offset) as unknown as HitRow[];
  } else {
    // No index serves one- or two-character words. Sorting every match by title hits read all their
    // texts (0.4–0.5 s for 福柯); instead the title matches are found among titles alone, and the
    // rest follow in publication order, which stops at the page.
    const w = scopeWhere(scope);
    const conds = w.sql.replace(/^WHERE /, '');
    // COALESCE: with no 中文标题 the test is NULL, and NOT NULL would drop the row from the rest.
    const inTitle = `(${p.short.map(() => `e.title ${LIKE} OR COALESCE(e.title_zh, '') ${LIKE}`).join(' OR ')})`;
    const head = (db.prepare(`SELECT e.id, ${titled} AS titled FROM entry e JOIN feed f ON f.id = e.feed_id
      WHERE ${inTitle} AND ${conds} ORDER BY titled DESC, e.published DESC, e.id DESC`)
      .all(...titledArgs, ...titledArgs, ...w.args) as { id: number }[]).map((r) => r.id);
    const tail = offset + limit > head.length
      ? (db.prepare(`SELECT e.id FROM entry e JOIN feed f ON f.id = e.feed_id WHERE NOT ${inTitle} AND ${conds}
          ORDER BY e.published DESC, e.id DESC LIMIT ? OFFSET ?`)
          .all(...titledArgs, ...w.args, offset + limit - Math.max(offset, head.length), Math.max(0, offset - head.length)) as { id: number }[]).map((r) => r.id)
      : [];
    const page = [...head.slice(offset, offset + limit), ...tail];
    const byId = new Map((db.prepare(`SELECT ${itemColumns(long)}${HIT_COLUMNS} FROM entry e JOIN feed f ON f.id = e.feed_id
      WHERE e.id IN (${page.map(() => '?').join(',') || 'NULL'})`).all(...page) as unknown as HitRow[]).map((r) => [r.id, r]));
    rows = page.flatMap((id) => byId.get(id) ?? []);
  }
  return withHits(rows.map(({ score: _s, ...r }: HitRow & { score?: number }) => r), long, allTerms(p));
}

// List items for ids picked elsewhere (the 推荐 order), in no particular order.
export function itemsByIds(db: DB, ids: number[], long = false): ListItem[] {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT ${itemColumns(long)} FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as (ListItem & { raw: string })[];
  return toItems(rows, long);
}

export function getEntry(db: DB, id: number): Record<string, unknown> | undefined {
  const e = db.prepare(`SELECT e.*, f.title AS feed_title, f.site_url AS feed_site, f.view FROM entry e JOIN feed f ON f.id = e.feed_id WHERE e.id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!e) return undefined;
  const tags = (db.prepare('SELECT name, source FROM tag WHERE entry_id = ?').all(id) as { name: string; source: string }[]);
  return { ...e, tags, comment_source: commentSource(e.link as string | null) };
}

// Counts start from the few unread entries (entry_unread) rather than from every feed's or tag's
// entries: a per-feed count touched the large entry rows and took 60–70 ms of each /state.
export function appState(db: DB): Record<string, unknown> {
  const categories = db.prepare('SELECT id, name, sort, layout, scroll_read FROM category ORDER BY sort, name').all();
  const unreadOf = new Map((db.prepare(`SELECT e.feed_id AS id, COUNT(*) AS n FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.is_read = 0 AND ${NOT_MARK} GROUP BY e.feed_id`).all() as { id: number; n: number }[]).map((r) => [r.id, r.n]));
  const feeds = (db.prepare(`SELECT f.id, f.title, f.url, f.site_url, f.category_id, f.view, f.layout, f.scroll_read, f.noisy, f.quiet, f.ttl, f.dedupe, f.ai_summary, f.ai_translate_title,
      f.ai_classify, f.fulltext, f.paused, f.last_ok_at, f.last_fetch_at, f.next_fetch_at, f.error_count, f.last_error
    FROM feed f WHERE f.removed = 0 ORDER BY f.title COLLATE NOCASE`).all() as { id: number }[]).map((f) => ({ ...f, unread: unreadOf.get(f.id) ?? 0 }));
  const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM entry e JOIN feed f ON f.id = e.feed_id WHERE e.is_read = 0 AND ${NOT_MARK}) AS unread,
      (SELECT COUNT(*) FROM entry WHERE is_starred = 1) AS starred,
      (SELECT COUNT(*) FROM entry) AS total`).get();
  const tagUnread = new Map((db.prepare(`SELECT t.name, COUNT(*) AS n FROM entry e JOIN tag t ON t.entry_id = e.id
    WHERE e.is_read = 0 AND t.source IN ('ai','knn','user') GROUP BY t.name`).all() as { name: string; n: number }[]).map((r) => [r.name, r.n]));
  // A name the model and the neighbours both gave reports 'ai'.
  const tags = (db.prepare(`SELECT name, MIN(source) AS source, COUNT(*) AS n FROM tag
    WHERE source IN ('ai','knn','user') GROUP BY name ORDER BY n DESC`).all() as { name: string }[])
    .map((t) => ({ ...t, unread: tagUnread.get(t.name) ?? 0 }));
  return { categories, feeds, totals, tags, marksUnread: unreadMarks(db) };
}
