import type { DB } from './db.ts';
import type { Settings } from './config.ts';

export type Retention = Settings['retention'];

// Feeds marked noisy are kept as Lumen always kept everything; the rest follows settings (by
// default forever). Douban 想读/看过 marks stay too: they feed the monthly new-book shares.
export const NOISY_RETENTION: Retention = { days: 90, keepMinPerFeed: 50, maxPerFeed: 400 };
const IS_NOISE = "f.noisy = 1";

// Posts that 学术动态, 期刊目录 or 新书 were read out of are kept whatever their feed's limits: those
// pages are kept for good, and an event or a book whose post is gone goes with it.
function prune(db: DB, r: Retention, noise: boolean): number {
  const cutoff = Math.floor(Date.now() / 1000) - r.days * 86400;
  // Keep starred and archived-to-Obsidian entries, keep the newest N per feed, drop the rest beyond the age or count limit.
  // Newest by publication: ordering by id kept re-served back-catalogue items over the latest ones.
  const doomed = `SELECT id FROM (
      SELECT e.id, e.published, e.is_starred, ROW_NUMBER() OVER (PARTITION BY e.feed_id ORDER BY e.published DESC, e.id DESC) AS rn
      FROM entry e JOIN feed f ON f.id = e.feed_id WHERE ${noise ? IS_NOISE : `NOT ${IS_NOISE}`}
    ) WHERE is_starred = 0 AND rn > ? AND (published < ? OR rn > ?)
      AND id NOT IN (SELECT entry_id FROM tag WHERE source = 'clip')
      AND id NOT IN (SELECT entry_id FROM extract WHERE data IS NOT NULL)
      AND id NOT IN (SELECT id FROM temp.kept_post)`;
  db.prepare(`DELETE FROM entry_fts WHERE rowid IN (${doomed})`).run(r.keepMinPerFeed, cutoff, r.maxPerFeed);
  return Number(db.prepare(`DELETE FROM entry WHERE id IN (${doomed})`).run(r.keepMinPerFeed, cutoff, r.maxPerFeed).changes);
}

// keep: further posts to spare, the 书单 新书 lists books from (content/booklists.ts bookPostIds).
export function pruneOld(db: DB, s: Settings, keep: readonly number[] = []): number {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS kept_post (id INTEGER PRIMARY KEY); DELETE FROM temp.kept_post;');
  const add = db.prepare('INSERT OR IGNORE INTO temp.kept_post (id) VALUES (?)');
  for (const id of keep) add.run(id);
  try {
    return prune(db, NOISY_RETENTION, true) + prune(db, s.retention, false);
  } finally { db.exec('DELETE FROM temp.kept_post'); }
}

// SQLite keeps deleted pages inside the file. Rewrite it once a fifth of it is dead space
// (takes a few seconds for ~400MB; writes wait meanwhile).
const VACUUM_FREE_RATIO = 0.2;

export function compactIfWasteful(db: DB): number {
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
  if (!pages || free / pages < VACUUM_FREE_RATIO) return 0;
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  db.exec('VACUUM');
  return free * pageSize;
}
