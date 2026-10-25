// Unsubscribing: a feed's posts go, except those another page was made from — an event or a call in
// 学术动态, an issue in 期刊目录, a book in 新书 — and those starred or archived to Obsidian. While any are
// left the feed stays behind as removed: out of the sidebar, the lists and the fetch, but still the
// name its posts are shown under. Subscribing to it again brings it back.
import { tx, type DB } from './db.ts';

export function removeFeed(db: DB, id: number, bookPosts: readonly number[]): { kept: number } {
  return tx(db, () => {
    const keep = new Set((db.prepare(`SELECT id FROM entry WHERE feed_id = ? AND (is_starred = 1
        OR id IN (SELECT entry_id FROM tag WHERE source = 'clip')
        OR id IN (SELECT entry_id FROM extract WHERE data IS NOT NULL))`).all(id) as { id: number }[]).map((r) => r.id));
    const own = new Set((db.prepare('SELECT id FROM entry WHERE feed_id = ?').all(id) as { id: number }[]).map((r) => r.id));
    for (const p of bookPosts) if (own.has(p)) keep.add(p);
    if (!keep.size) {
      db.prepare('DELETE FROM entry_fts WHERE rowid IN (SELECT id FROM entry WHERE feed_id = ?)').run(id);
      db.prepare('DELETE FROM feed WHERE id = ?').run(id);
      return { kept: 0 };
    }
    db.exec('CREATE TEMP TABLE IF NOT EXISTS kept_on_remove (id INTEGER PRIMARY KEY); DELETE FROM temp.kept_on_remove;');
    const add = db.prepare('INSERT INTO temp.kept_on_remove (id) VALUES (?)');
    for (const k of keep) add.run(k);
    const gone = 'SELECT id FROM entry WHERE feed_id = ? AND id NOT IN (SELECT id FROM temp.kept_on_remove)';
    db.prepare(`DELETE FROM entry_fts WHERE rowid IN (${gone})`).run(id);
    db.prepare(`DELETE FROM entry WHERE id IN (${gone})`).run(id);
    db.prepare('UPDATE entry SET is_read = 1 WHERE feed_id = ? AND is_read = 0').run(id);
    db.prepare('UPDATE feed SET removed = 1, paused = 1, category_id = NULL WHERE id = ?').run(id);
    db.exec('DELETE FROM temp.kept_on_remove');
    return { kept: keep.size };
  });
}

// Subscribing to a removed feed again: it comes back where it is put, and is fetched as before.
export function restoreFeed(db: DB, id: number, categoryId: number | null): void {
  db.prepare('UPDATE feed SET removed = 0, paused = 0, category_id = ?, next_fetch_at = 0 WHERE id = ?').run(categoryId, id);
}
