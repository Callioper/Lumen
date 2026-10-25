import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Feed view types, Folo-style: decides how the middle column renders.
export const VIEWS = ['article', 'social', 'picture', 'video', 'audio'] as const;
export type View = (typeof VIEWS)[number];
// How the middle column lays a list out; NULL on a feed or category means "decide from the view type".
export const LAYOUTS = ['list', 'social', 'cards', 'masonry', 'compact', 'digest'] as const;
export type Layout = (typeof LAYOUTS)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS category (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  site_url TEXT,
  description TEXT,
  category_id INTEGER REFERENCES category(id) ON DELETE SET NULL,
  view TEXT NOT NULL DEFAULT 'article',
  ttl INTEGER NOT NULL DEFAULT 0,          -- seconds, 0 = default
  dedupe TEXT NOT NULL DEFAULT 'guid',     -- 'guid' | 'title'
  ai_summary INTEGER NOT NULL DEFAULT 0,
  ai_translate_title INTEGER NOT NULL DEFAULT 0,
  ai_classify INTEGER NOT NULL DEFAULT 1,
  fulltext INTEGER NOT NULL DEFAULT 0,
  icon_url TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  last_fetch_at INTEGER NOT NULL DEFAULT 0,  -- unix seconds
  next_fetch_at INTEGER NOT NULL DEFAULT 0,
  last_ok_at INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  etag TEXT,
  last_modified TEXT
);
CREATE TABLE IF NOT EXISTS entry (
  id INTEGER PRIMARY KEY,                   -- microsecond timestamp, FreshRSS-compatible
  feed_id INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  title_hash TEXT,
  author TEXT,
  link TEXT,
  content TEXT,
  content_full TEXT,
  thumbnail TEXT,
  enclosures TEXT,                          -- JSON array [{url,type,length}]
  published INTEGER NOT NULL,               -- unix seconds
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  ai_state INTEGER NOT NULL DEFAULT 0,      -- 0 none, 1 queued, 2 done, 3 failed, 4 skipped
  ai_summary TEXT,                          -- sanitized HTML
  title_zh TEXT,
  UNIQUE (feed_id, guid)
);
CREATE INDEX IF NOT EXISTS entry_feed_id ON entry(feed_id, id DESC);
CREATE INDEX IF NOT EXISTS entry_published ON entry(published DESC, id DESC);
CREATE INDEX IF NOT EXISTS entry_unread ON entry(is_read, id DESC);
CREATE INDEX IF NOT EXISTS entry_starred ON entry(is_starred, id DESC);
CREATE INDEX IF NOT EXISTS entry_ai_queue ON entry(ai_state) WHERE ai_state = 1;
CREATE INDEX IF NOT EXISTS entry_title_hash ON entry(feed_id, title_hash);
CREATE INDEX IF NOT EXISTS entry_link ON entry(feed_id, link);
CREATE TABLE IF NOT EXISTS tag (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'feed',       -- 'feed' | 'ai' | 'user'
  PRIMARY KEY (entry_id, name)
);
CREATE INDEX IF NOT EXISTS tag_name ON tag(name);
-- 检索 (server/search.ts): both titles; author and AI summary; the text.
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
  title, meta, body, content='', contentless_delete=1, tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- Web login sessions (server/auth.ts): the sha256 of each cookie, never the cookie itself.
CREATE TABLE IF NOT EXISTS web_session (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL);
-- AI summaries of one 每日简报 block, keyed by the hash of its entry ids.
-- 评论区 (server/comments/): what a site answered for an entry, kept a day.
CREATE TABLE IF NOT EXISTS comment_cache (entry_id INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE, fetched_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS digest (key TEXT PRIMARY KEY, summary TEXT NOT NULL, created INTEGER NOT NULL);
-- 日报/周报/论文周报 (server/report/): one row per kind and period, e.g. ('papers', '2026-W43').
CREATE TABLE IF NOT EXISTS report (
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  data TEXT NOT NULL,                       -- JSON as rendered, so reopening costs nothing
  path TEXT,                                -- the note written into Obsidian
  created INTEGER NOT NULL,
  PRIMARY KEY (kind, period)
);
-- Reading signals for recommendations (server/rec/signals.ts). No foreign key on entry_id:
-- the history outlives the entries that retention removes.
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL,
  feed_id INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  weight REAL NOT NULL,
  progress REAL,                            -- 0..1, furthest point reached
  active_ms INTEGER,                        -- time on screen while the reader was active
  list_scope TEXT,                          -- which list it was opened from, e.g. 'all', 'feed:12'
  sort_mode TEXT,                           -- 'latest' | 'recommend'
  position INTEGER,                         -- 0-based place in that list
  created_at INTEGER NOT NULL               -- unix seconds
);
CREATE INDEX IF NOT EXISTS event_entry ON event(entry_id);
CREATE INDEX IF NOT EXISTS event_created ON event(created_at);
CREATE INDEX IF NOT EXISTS event_feed ON event(feed_id, created_at);
-- Unit-length float32 vectors of title + summary (server/rec/embed.ts).
CREATE TABLE IF NOT EXISTS embedding (
  entry_id INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  vec BLOB NOT NULL,
  created INTEGER NOT NULL
);
-- Recommendation clusters the reader named or hid (server/rec/profile.ts), keyed by a member entry.
CREATE TABLE IF NOT EXISTS rec_cluster (
  anchor INTEGER PRIMARY KEY,
  name TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  by_user INTEGER NOT NULL DEFAULT 0,      -- 0 named by the model, may be renamed when the cluster changes
  updated_at INTEGER NOT NULL
);
-- 豆列 a 关注书单 broadcast points to, shown as its book list (server/content/douban.ts).
CREATE TABLE IF NOT EXISTS doulist (id TEXT PRIMARY KEY, books TEXT NOT NULL, fetched INTEGER NOT NULL);
-- A 书单 book looked up on 豆瓣, keyed 'isbn:…' or 'title:…': its subject (null: not on 豆瓣), and when
-- 想读 was marked from Lumen.
CREATE TABLE IF NOT EXISTS douban_book (key TEXT PRIMARY KEY, subject TEXT, title TEXT, looked_at INTEGER NOT NULL, wished_at INTEGER);
-- 新书's 主题 by the old neighbour vote (booktopics.ts, retired 2026-10-24: book_kind.topic replaced it). Unread.
CREATE TABLE IF NOT EXISTS book_topic (key TEXT PRIMARY KEY, topic TEXT NOT NULL, at INTEGER NOT NULL);
-- 新书's 类型 and 主题 by book (server/content/bookkinds.ts), keyed as its tile is: ISBN, subject or title.
CREATE TABLE IF NOT EXISTS book_kind (key TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL);
-- 期刊目录 and 学术动态 (server/content/extract.ts): what the AI read out of a post, as JSON; null when
-- the post was not one. A new version of a prompt reads the post again.
CREATE TABLE IF NOT EXISTS extract (entry_id INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, data TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, kind));
-- 热点's public lists (server/report/hot.ts): each list's last good items as JSON.
-- 学术动态's recordings on B站 (server/content/replays.ts), by event: when last looked for, and what was
-- found as JSON (null: nothing yet).
CREATE TABLE IF NOT EXISTS replay (key TEXT PRIMARY KEY, checked INTEGER NOT NULL, found TEXT);
CREATE TABLE IF NOT EXISTS hot_list (key TEXT PRIMARY KEY, fetched INTEGER NOT NULL, items TEXT NOT NULL);
-- A 豆瓣 subject by its id (书影音标记, 新书): the other editions of the work it belongs to, as JSON,
-- asked for at most once a month, and when it was marked 想读 / 想看 from Lumen.
CREATE TABLE IF NOT EXISTS douban_subject (subject TEXT PRIMARY KEY, works TEXT, total INTEGER, editions TEXT, editions_at INTEGER, wished_at INTEGER);
-- 书影音标记's short foreign texts (titles, friends' comments, a 豆瓣 page's blurb and short comments)
-- and their Chinese, by the text itself (server/ai/snippets.ts). state: NULL queued, 2 done, 3 failed.
CREATE TABLE IF NOT EXISTS tr_snippet (src TEXT PRIMARY KEY, zh TEXT, state INTEGER, at INTEGER);
`;

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_size_limit = 67108864;');   // 64 MB: what the WAL keeps after a checkpoint
  dropOldSearchIndex(db);
  db.exec(SCHEMA);
  addMissingColumns(db);
  // On added columns, so after them. 喜欢 / 少推: few rows, read on every 推荐 (the profile's key and signals).
  db.exec('CREATE INDEX IF NOT EXISTS entry_reaction ON entry(reaction)');
  return db;
}

// The index once held only the title and the opening of the text; a table of that shape is
// dropped here, recreated by SCHEMA and filled again by rebuildSearchIndexIfStale().
function dropOldSearchIndex(db: DB): void {
  const cols = (db.prepare("SELECT name FROM pragma_table_info('entry_fts')").all() as { name: string }[]).map((c) => c.name);
  if (cols.length && !cols.includes('meta')) db.exec("DROP TABLE entry_fts; DELETE FROM meta WHERE key = 'search_index';");
}

// Columns added after the first release; CREATE TABLE IF NOT EXISTS leaves existing tables alone.
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ['feed', 'layout', 'TEXT'],
  ['category', 'layout', 'TEXT'],
  ['feed', 'scroll_read', 'INTEGER'],       // NULL follows the category; 1 marks entries read once scrolled past
  ['category', 'scroll_read', 'INTEGER'],
  ['feed', 'noisy', 'INTEGER NOT NULL DEFAULT 0'],  // 1: kept only 90 days / 400 entries (server/retention.ts)
  ['feed', 'quiet', 'INTEGER NOT NULL DEFAULT 0'],
  ['feed', 'removed', 'INTEGER NOT NULL DEFAULT 0'],  // 1: unsubscribed, kept for the posts 学术动态/新书/收藏 hold (server/unsubscribe.ts)  // 1: entries arrive read; followed for the workflows, not for reading
  ['entry', 'reaction', 'TEXT'],            // 'like' | 'less_topic' | 'less_source'
  ['entry', 'tr_state', 'INTEGER'],         // NULL unchecked; server/ai/translate.ts TR
  ['entry', 'content_tr', 'TEXT'],          // the body with each foreign block paired with its translation
  ['entry', 'tr_of', 'TEXT'],               // 'full' | 'feed': which body content_tr was made from
  ['entry', 'tr_note', 'TEXT'],             // what was left out, or why it failed
  ['douban_book', 'cover', 'TEXT'],         // 豆瓣's cover, for a listed book whose post prints none; '' none found
  ['douban_book', 'cover_at', 'INTEGER'],   // when 豆瓣 was asked for the details below; NULL never
  ['douban_book', 'date', 'TEXT'],          // and what it gave, '' none: when it came out,
  ['douban_book', 'authors', 'TEXT'],       // who wrote it,
  ['douban_book', 'publisher', 'TEXT'],     // who published it
  ['douban_subject', 'page', 'TEXT'],       // the subject page as read (SubjectPage JSON, server/content/douban.ts)
  ['book_kind', 'topic', 'TEXT'],          // 主题 in 豆瓣's tags (bookkinds.ts BOOK_TOPICS); NULL sorted by kind alone
  ['entry', 'knn_checked', 'INTEGER'],      // 1: the old-library tag vote has looked at it (server/rec/tagknn.ts)
];
function addMissingColumns(db: DB): void {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}


let lastId = 0;
// Monotonic microsecond ids; same scheme as FreshRSS so migrated ids stay valid
// for GReader clients (item id = hex of this number).
export function newEntryId(): number {
  const now = Date.now() * 1000;
  lastId = Math.max(now, lastId + 1);
  return lastId;
}
export function seedEntryId(db: DB): void {
  const row = db.prepare('SELECT MAX(id) AS m FROM entry').get() as { m: number | null };
  lastId = Math.max(lastId, row.m ?? 0);
}
