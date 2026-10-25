import { createHash } from 'node:crypto';
import { type DB, type View, tx, newEntryId } from '../db.ts';
import { indexEntry } from '../search.ts';
import { sanitize, plainText, decodeEntities } from '../content/sanitize.ts';
import type { ParsedFeed, ParsedItem } from './parse.ts';

export interface FeedRow {
  id: number;
  url: string;
  title: string;
  site_url: string | null;
  description: string | null;
  category_id: number | null;
  view: View;
  ttl: number;
  dedupe: 'guid' | 'title';
  ai_summary: number;
  ai_translate_title: number;
  ai_classify: number;
  fulltext: number;
  icon_url: string | null;
  paused: number;
  quiet?: number;           // entries arrive already read
  last_fetch_at: number;
  next_fetch_at: number;
  last_ok_at: number;
  error_count: number;
  last_error: string | null;
  etag: string | null;
  last_modified: string | null;
}

export const titleHash = (title: string): string => createHash('sha1').update(title.trim()).digest('hex');

// Douban statuses without a subject arrive titled "某人 : 「」", so the list showed only the
// name. Use the text after the empty quotes, or else the post's first sentence.
const EMPTY_QUOTE = /^(.+?)( ?: )「」\s*(.*)$/s;
const TITLE_SENTENCE_MAX = 60;

function firstSentence(text: string): string {
  const t = text.trim();
  const s = /^(.+?[。！？!?…]+)/.exec(t)?.[1] ?? t;
  const chars = [...s];
  return chars.length > TITLE_SENTENCE_MAX ? chars.slice(0, TITLE_SENTENCE_MAX).join('') + '…' : s;
}

const FIRST_SENTENCE_CHARS = 1500;
export function fillEmptyTitle(title: string, text: string): string {
  const m = EMPTY_QUOTE.exec(title);
  if (!m) return title;
  const rest = m[3].trim() || firstSentence(text);
  return rest ? `${m[1]}${m[2]}${rest}` : m[1];
}

// Merge duplicates (same feed + link): keep the oldest row, which carries the user's
// read/star state, and move any AI output from the newer copy onto it.
export function dedupeByLink(db: DB): number {
  const dups = db.prepare(`SELECT MIN(id) AS keep, GROUP_CONCAT(id) AS ids FROM entry
    WHERE link IS NOT NULL AND link != '' GROUP BY feed_id, link HAVING COUNT(*) > 1`).all() as { keep: number; ids: string }[];
  let removed = 0;
  tx(db, () => {
    for (const d of dups) {
      for (const id of d.ids.split(',').map(Number).filter((x) => x !== d.keep)) {
        db.prepare(`UPDATE entry SET ai_summary = COALESCE(ai_summary, (SELECT ai_summary FROM entry WHERE id = ?)),
          title_zh = COALESCE(title_zh, (SELECT title_zh FROM entry WHERE id = ?)),
          content_full = COALESCE(content_full, (SELECT content_full FROM entry WHERE id = ?)),
          ai_state = MAX(ai_state, (SELECT ai_state FROM entry WHERE id = ?)) WHERE id = ?`).run(id, id, id, id, d.keep);
        db.prepare("UPDATE OR IGNORE tag SET entry_id = ? WHERE entry_id = ?").run(d.keep, id);
        db.prepare('DELETE FROM entry_fts WHERE rowid = ?').run(id);
        db.prepare('DELETE FROM entry WHERE id = ?').run(id);
        removed++;
      }
      indexEntry(db, d.keep);
    }
  });
  return removed;
}

export function inferView(url: string, items: ParsedItem[] = []): View {
  const u = url.toLowerCase();
  if (/(bilibili|youtube|douyin|vimeo)/.test(u)) return 'video';
  if (/(xiaoyuzhou|podcast|xyzfm|fireside|anchor\.fm|ximalaya)/.test(u)) return 'audio';
  if (/(douban\/people|weibo|twitter|telegram|mastodon|zhihu\/people|jike)/.test(u)) return 'social';
  if (/(instagram|pixiv|unsplash|lofter)/.test(u)) return 'picture';
  if (items.length && items.filter((i) => i.enclosures.some((e) => e.type.startsWith('audio'))).length > items.length / 2) return 'audio';
  return 'article';
}

export interface IngestOptions {
  aiEnabled: boolean;
  now?: number;
  retention?: { days: number; keepMinPerFeed: number };
}

// How old an item may be and still come in as new. Separate from how long entries are kept: with
// storage set to keep everything, a podcast's whole 2018 back catalogue came back unread.
export const BACKLOG_WINDOW = { days: 90, keepMinPerFeed: 50 } as const;

// Feeds that list their whole back catalogue (podcasts) re-serve what retention deleted, and it came
// back as unread. Items older than the retention window are admitted only while the feed holds fewer
// than its keep-minimum, newest first, which is exactly what retention would leave in place.
function oldItemsToSkip(db: DB, feed: FeedRow, items: ParsedItem[], isNew: (it: ParsedItem) => boolean,
  retention: IngestOptions['retention'], now: number): Set<ParsedItem> {
  if (!retention) return new Set();
  const cutoff = now - retention.days * 86400;
  const fresh = items.filter(isNew);
  const isOld = (it: ParsedItem): boolean => it.published !== null && it.published < cutoff;
  const old = fresh.filter(isOld).sort((a, b) => (b.published ?? 0) - (a.published ?? 0));
  const have = (db.prepare('SELECT COUNT(*) AS n FROM entry WHERE feed_id = ?').get(feed.id) as { n: number }).n;
  const recent = fresh.length - old.length;
  return new Set(old.slice(Math.max(0, retention.keepMinPerFeed - have - recent)));
}

// A thumbnail given as a relative path (scott.jpg, /img/a.png) is resolved against the entry, as its
// content's images are; asked of /img as it stood it could only fail.
export function thumbnailOf(src: string, base: string): string | null {
  if (!src) return null;
  try {
    const u = new URL(src, base || undefined);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export function ingest(db: DB, feed: FeedRow, parsed: ParsedFeed, opts: IngestOptions): number {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const exists = db.prepare('SELECT 1 FROM entry WHERE feed_id = ? AND guid = ?');
  // FreshRSS stored hashed guids, so after migration the link is the only stable identity.
  const sameLink = db.prepare('SELECT 1 FROM entry WHERE feed_id = ? AND link = ? LIMIT 1');
  const sameTitle = db.prepare('SELECT 1 FROM entry WHERE feed_id = ? AND title_hash = ? LIMIT 1');
  // A quiet feed (the reader's own 豆瓣 收藏, say) is still fetched, tagged and fed to the reports;
  // its entries just never count as unread.
  const read = feed.quiet ? 1 : 0;
  const insert = db.prepare(`INSERT INTO entry (id, feed_id, guid, title, title_hash, author, link, content, thumbnail, enclosures, published, ai_state, is_read, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${read}, ${read ? now : 'NULL'})`);
  const insertTag = db.prepare("INSERT OR IGNORE INTO tag (entry_id, name, source) VALUES (?, ?, 'feed')");
  const wantsWork = feed.fulltext || (opts.aiEnabled && (feed.ai_summary || feed.ai_translate_title || feed.ai_classify));
  const base = feed.site_url || feed.url;
  const isDouban = feed.url.includes('douban');
  // A 豆瓣 post written into a 话题 used to link to its status page; the topic is the post (rsshub/server.mjs
  // douban-topic-link). Its guid stayed, so a post already here takes the new link when it comes round again.
  const relink = db.prepare("UPDATE entry SET link = ? WHERE feed_id = ? AND guid = ? AND link IS NOT ? AND ? LIKE 'https://www.douban.com/topic/%'");

  const isNew = (it: ParsedItem): boolean => {
    const guid = it.guid.slice(0, 2000);
    return !!guid && !exists.get(feed.id, guid) && !(it.link && sameLink.get(feed.id, it.link));
  };
  const skip = oldItemsToSkip(db, feed, parsed.items, isNew, opts.retention, now);
  // Oldest first so ids increase in publication order within a batch.
  const items = [...parsed.items].reverse().filter((it) => !skip.has(it));
  let added = 0;
  tx(db, () => {
    for (const it of items) {
      const guid = it.guid.slice(0, 2000);
      if (guid && isDouban && it.link) relink.run(it.link, feed.id, guid, it.link, it.link);
      if (!guid || exists.get(feed.id, guid)) continue;
      if (it.link && sameLink.get(feed.id, it.link)) continue;
      const content = sanitize(it.content, it.link || base);
      const raw = decodeEntities(it.title).slice(0, 1000);
      const title = (isDouban ? fillEmptyTitle(raw, plainText(content, FIRST_SENTENCE_CHARS)) : raw) || '(无标题)';
      const th = titleHash(title);
      if (feed.dedupe === 'title' && sameTitle.get(feed.id, th)) continue;
      const id = newEntryId();
      const published = it.published && it.published <= now + 86400 ? it.published : now;
      insert.run(id, feed.id, guid, title, th, it.author.slice(0, 300), it.link, content,
        thumbnailOf(it.thumbnail, it.link || base), it.enclosures.length ? JSON.stringify(it.enclosures) : null, published, wantsWork ? 1 : 0);
      for (const c of it.categories.slice(0, 10)) insertTag.run(id, c.replace(/^#/, '').slice(0, 60));
      indexEntry(db, id);
      added++;
    }
  });
  return added;
}
