// Which of the pages Lumen builds out of posts an entry went into: 学术动态 (a notice read out of it),
// 期刊目录 (a table of contents or a 人大复印 issue read out of it, or a CNKI feed's article) and 新书
// (a 书单 split into books). The list and the reader mark an entry with them, so a post met in its
// feed says where it has been sorted out.
import type { DB } from '../db.ts';
import { cnkiFeeds } from './cnki.ts';
import { bookPostIds } from './booklists.ts';

export type Destination = 'notices' | 'tocs' | 'books';
const ORDER: Destination[] = ['notices', 'tocs', 'books'];
const OF_KIND: Record<string, Destination> = { notice: 'notices', toc: 'tocs', reprint: 'tocs' };

export function destinationsOf(db: DB, entries: readonly { id: number; feed_id: number }[]): Map<number, Destination[]> {
  const out = new Map<number, Set<Destination>>();
  const add = (id: number, d: Destination): void => { out.set(id, (out.get(id) ?? new Set()).add(d)); };
  if (!entries.length) return new Map();
  const ids = entries.map((e) => e.id);
  const rows = db.prepare(`SELECT entry_id AS id, kind FROM extract
    WHERE entry_id IN (${ids.map(() => '?').join(',')}) AND data IS NOT NULL AND data NOT IN ('[]', 'null')`)
    .all(...ids) as { id: number; kind: string }[];
  for (const r of rows) if (OF_KIND[r.kind]) add(r.id, OF_KIND[r.kind]);
  const cnki = new Set(cnkiFeeds(db).map((f) => f.id));
  for (const e of entries) if (cnki.has(e.feed_id)) add(e.id, 'tocs');
  const books = new Set(bookPostIds(db));
  for (const id of ids) if (books.has(id)) add(id, 'books');
  return new Map([...out].map(([id, s]) => [id, ORDER.filter((d) => s.has(d))]));
}

// The items with their destinations as `pages`, left off where there are none.
export function withDestinations<T extends { id: number; feed_id: number }>(db: DB, items: T[]): (T & { pages?: Destination[] })[] {
  const of = destinationsOf(db, items);
  return items.map((it) => (of.has(it.id) ? { ...it, pages: of.get(it.id) } : it));
}
