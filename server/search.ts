// 检索: what the full-text index holds for an entry, and how a query typed into the search box is
// read. The index (entry_fts) is trigram, so a term of three characters or more is looked up in it;
// a shorter one (「福柯」「媒介」) cannot be, and is matched against the text itself among what the
// longer terms leave, or across the library when the query has nothing longer (about 0.2 s at 18k).
import type { DB } from './db.ts';
import { plainText } from './content/sanitize.ts';
import { log } from './log.ts';

// The whole text goes in, up to a cap so one huge page cannot swell the index.
export const SEARCH_BODY_CHARS = 60_000;
// Bumped when what goes into the index changes; a database on an older version is rebuilt.
const INDEX_VERSION = '2';
const REBUILD_BATCH = 50;   // about half a second each, so the server keeps answering

interface IndexRow { id: number; title: string; title_zh: string | null; author: string | null; ai_summary: string | null; body: string | null }
const INDEX_SELECT = `SELECT id, title, title_zh, author, ai_summary, COALESCE(content_tr, content_full, content) AS body FROM entry`;

// Three columns, weighted in that order when ranking: both titles; who wrote it and the AI
// summary; the text (with its translation woven in, when there is one).
function columns(r: IndexRow): [string, string, string] {
  return [[r.title, r.title_zh].filter(Boolean).join(' '),
    [r.author, r.ai_summary ? plainText(r.ai_summary, 4000) : ''].filter(Boolean).join(' '),
    plainText(r.body ?? '', SEARCH_BODY_CHARS)];
}

// (Re)index entries after anything that goes into the index changed: new, full text fetched, AI
// summary or Chinese title written, translated.
export function indexEntries(db: DB, ids: readonly number[]): void {
  if (!ids.length) return;
  const del = db.prepare('DELETE FROM entry_fts WHERE rowid = ?');
  const ins = db.prepare('INSERT INTO entry_fts (rowid, title, meta, body) VALUES (?, ?, ?, ?)');
  const get = db.prepare(`${INDEX_SELECT} WHERE id = ?`);
  for (const id of ids) {
    const r = get.get(id) as IndexRow | undefined;
    del.run(id);
    if (r) ins.run(id, ...columns(r));
  }
}
export const indexEntry = (db: DB, id: number): void => indexEntries(db, [id]);

// Called once at startup (db.ts recreated the table when its columns changed): an index of an
// older version is filled again in the background, a batch at a time, newest entries first so
// what is searched most is back soonest. Until it finishes, older entries are missing from results.
export function rebuildSearchIndexIfStale(db: DB): void {
  const version = (db.prepare("SELECT value FROM meta WHERE key = 'search_index'").get() as { value: string } | undefined)?.value;
  if (version === INDEX_VERSION) return;
  const ids = (db.prepare('SELECT id FROM entry ORDER BY id DESC').all() as { id: number }[]).map((r) => r.id);
  db.exec('DELETE FROM entry_fts');
  const started = Date.now();
  log.info(`[search] 重建全文索引：${ids.length} 篇`);
  let at = 0;
  const step = (): void => {
    try {
      db.exec('BEGIN');
      indexEntries(db, ids.slice(at, at + REBUILD_BATCH));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      log.error(`[search] 重建全文索引中断：${(e as Error).message}`);
      return;
    }
    at += REBUILD_BATCH;
    if (at < ids.length) { setImmediate(step); return; }
    db.exec("INSERT INTO entry_fts(entry_fts) VALUES('optimize')");
    db.prepare("INSERT INTO meta (key, value) VALUES ('search_index', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(INDEX_VERSION);
    log.info(`[search] 全文索引重建完成：${ids.length} 篇，${Math.round((Date.now() - started) / 1000)} 秒`);
  };
  setImmediate(step);
}

// 「海尔斯 后人类」 is two terms, both required; 「"后人类 主体"」 in quotes is one.
export interface ParsedQuery { long: string[]; short: string[] }
const MIN_INDEXED = 3;
export function parseQuery(q: string): ParsedQuery {
  const terms = [...q.matchAll(/"([^"]+)"|“([^”]+)”|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()).filter(Boolean);
  const unique = [...new Set(terms.map((t) => t.toLowerCase()))];
  return { long: unique.filter((t) => [...t].length >= MIN_INDEXED), short: unique.filter((t) => [...t].length < MIN_INDEXED) };
}
export const allTerms = (p: ParsedQuery): string[] => [...p.long, ...p.short];

export const ftsMatch = (terms: readonly string[]): string => terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');

// A short term anywhere in what the index would hold; takes likeArg(term) once per `?`.
export const LIKE = String.raw`LIKE ? ESCAPE '\'`;
export const SHORT_TERM_SQL = `(e.title ${LIKE} OR e.title_zh ${LIKE} OR e.author ${LIKE} OR e.ai_summary ${LIKE}
  OR COALESCE(e.content_tr, e.content_full, e.content) ${LIKE})`;
export const likeArg = (t: string): string => `%${t.replace(/[%_\\]/g, (c) => '\\' + c)}%`;

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 120;

// The stretch of text around the first term it contains, ellipsized; null when none is in it.
export function hitSnippet(text: string, terms: readonly string[]): string | null {
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return null;
  const from = Math.max(0, at - SNIPPET_BEFORE);
  const to = Math.min(text.length, at + SNIPPET_AFTER);
  return (from > 0 ? '…' : '') + text.slice(from, to).trim() + (to < text.length ? '…' : '');
}
