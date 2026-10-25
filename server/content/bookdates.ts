// 新书 is sectioned by the month a book came out, which a 书单 post often leaves out. Those books are
// looked up on 豆瓣 in the background (detailsFor: as a visitor, by ISBN where there is one, kept in
// douban_book), one every few seconds and a batch at a time, so 豆瓣 sees a reader browsing, not a
// crawl. A refusal stops the lookups for an hour. A book 豆瓣 has answered for is not asked again
// (one it did not know, after a month).
import type { DB } from '../db.ts';
import type { ListedBook } from './books.ts';
import { detailsFor, needsDetails, DoubanError } from './douban.ts';
import { log } from '../log.ts';

const GAP_MS = 6000;
const BATCH = 40;
const REFUSED_PAUSE_MS = 3600_000;

let running = false;
let pausedUntil = 0;

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

// Starts a batch unless one is running or 豆瓣 refused lately. Returns how many books are left to
// look up (0 while paused), for the page to say so.
export function fillDates(db: DB, undated: readonly ListedBook[], wait: (ms: number) => Promise<void> = sleep): number {
  const todo = undated.filter((b) => needsDetails(db, b));
  if (!todo.length || Date.now() < pausedUntil) return 0;
  if (running) return todo.length;
  running = true;
  void (async () => {
    let found = 0, asked = 0;
    try {
      for (const b of todo.slice(0, BATCH)) {
        const r = await detailsFor(db, { isbn: b.isbn, title: b.title });
        if (r.date) found++;
        if (r.fetched) { asked++; await wait(GAP_MS); }
      }
    } catch (err) {
      if (err instanceof DoubanError) {
        pausedUntil = Date.now() + REFUSED_PAUSE_MS;
        log.warn(`[books] 查出版时间被豆瓣拒绝，一小时后再查：${err.message}`);
      } else {
        // A database error: the next look at 新书 tries again.
        log.warn(`[books] 查出版时间中断：${(err as Error).message}`);
      }
    } finally {
      running = false;
      if (asked) log.info(`[books] 查了 ${asked} 本的出版时间，查到 ${found} 本`);
    }
  })();
  return todo.length;
}
