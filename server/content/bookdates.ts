// 新书 is sectioned by the month a book came out, which a 书单 post often leaves out; a tile also wants
// a cover, the author and the publisher, and 想读 the book's 豆瓣 subject. Those books are
// looked up on 豆瓣 in the background, the undated first, not only while 新书 is open (main.ts asks every
// quarter hour, 2026-11-02: a tile scrolled to asked 豆瓣 then, and a page of them asked a lot at once) (detailsFor: as a visitor, by ISBN where there is one, kept in
// douban_book), one per turn of 豆瓣's budget (doubanpace.ts) and a batch at a time, so 豆瓣 sees a
// reader browsing, not a crawl. A refusal stops the lookups until 豆瓣 is back. A book 豆瓣 has answered for is not asked again
// (one it did not know, after a month).
import type { DB } from '../db.ts';
import type { ListedBook } from './books.ts';
import { detailsFor, needsDetails, DoubanError } from './douban.ts';
import { log } from '../log.ts';
import { backgroundDoubanTurn, doubanWaitMs } from '../fetch/doubanpace.ts';

const BATCH = 40;

let running = false;
let pausedUntil = 0;

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

// Starts a batch unless one is running or 豆瓣 refused lately. Returns how many books are left to
// look up (0 while paused), for the page to say so.
export function fillDetails(db: DB, undated: readonly ListedBook[], wait: (ms: number) => Promise<void> = sleep): number {
  const todo = undated.filter((b) => needsDetails(db, b));
  if (!todo.length || Date.now() < pausedUntil || doubanWaitMs()) return 0;
  if (running) return todo.length;
  running = true;
  void (async () => {
    let found = 0, asked = 0;
    try {
      for (const b of todo.slice(0, BATCH)) {
        if (needsDetails(db, b) && !(await backgroundDoubanTurn(wait))) break;
        const r = await detailsFor(db, { isbn: b.isbn, title: b.title });
        if (r.date) found++;
        if (r.fetched) asked++;
      }
    } catch (err) {
      if (err instanceof DoubanError) {
        pausedUntil = Date.now() + doubanWaitMs();
        log.warn(`[books] 查出版时间被豆瓣拒绝：${err.message}`);
      } else {
        // A database error: the next look at 新书 tries again.
        log.warn(`[books] 查出版时间中断：${(err as Error).message}`);
      }
    } finally {
      running = false;
      if (asked) log.info(`[books] 向豆瓣查了 ${asked} 本书的信息，其中 ${found} 本有出版时间`);
    }
  })();
  return todo.length;
}
