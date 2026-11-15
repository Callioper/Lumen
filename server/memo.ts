// A value worked out from the whole library, kept until an entry comes in. The list asks for some of these
// on every page (which posts went into 新书, one's own 豆瓣 marks), and working them out each time was
// most of what a page cost (2026-11-16). Entries only arrive with a higher id, so the highest id says
// whether anything new came in; maxAgeMs bounds what an edit to older rows can leave stale.
import type { DB } from './db.ts';

interface Kept<T> { top: number; at: number; value: T }

export function untilNewEntry<T>(compute: (db: DB) => T, maxAgeMs = 5 * 60_000): (db: DB) => T {
  const kept = new WeakMap<DB, Kept<T>>();
  return (db) => {
    const top = (db.prepare('SELECT max(id) AS m FROM entry').get() as { m: number | null }).m ?? 0;
    const hit = kept.get(db);
    if (hit && hit.top === top && Date.now() - hit.at < maxAgeMs) return hit.value;
    const value = compute(db);
    kept.set(db, { top, at: Date.now(), value });
    return value;
  };
}
