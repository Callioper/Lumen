// 标记's cards open on a book's or a film's 豆瓣 page, which was fetched when the card was opened: a wait
// of a few seconds each (a film's is three requests), and a reader going down the cards asked 豆瓣 a
// lot at once (2026-11-01). So the pages of the cards listed are fetched ahead, in the background,
// newest card first, a turn of 豆瓣's budget per request (doubanpace.ts), so they come in at the pace
// of the feeds, and a refusal stops them until 豆瓣 is back. A page kept and fresh is not asked again.
import type { DB } from '../db.ts';
import { listMarks, type MarkGroup } from '../api/marks.ts';
import { bookPageFresh, editionsOf, DoubanNeedsLogin } from './douban.ts';
import { moviePageFresh, moviePage, MOVIE_REQUESTS } from './doubanmovie.ts';
import { backgroundDoubanTurn, doubanWaitMs } from '../fetch/doubanpace.ts';
import { log } from '../log.ts';

const BATCH = 30;
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

type Card = Pick<MarkGroup, 'kind' | 'subject' | 'title'> & { subject: string; kind: 'book' | 'movie' };

// The cards whose page would be fetched on opening, newest first.
export function cardsToFetch(db: DB, now = Math.floor(Date.now() / 1000)): Card[] {
  return listMarks(db, { unreadOnly: false, now }).flatMap((g) => {
    if (!g.subject || (g.kind !== 'book' && g.kind !== 'movie')) return [];
    const fresh = g.kind === 'book' ? bookPageFresh(db, g.subject, now) : moviePageFresh(db, g.subject, now);
    return fresh || (gone.get(g.subject) ?? 0) > now ? [] : [{ kind: g.kind, subject: g.subject, title: g.title }];
  });
}

let running = false;
// A subject 豆瓣 answers 404 for (taken down) is not asked again for a week; it was asked every round.
const GONE_S = 7 * 86400;
const gone = new Map<string, number>();
// One shown to members only stays so; a month, then it is tried once more.
const MEMBERS_ONLY_S = 30 * 86400;

// One batch, unless one is running or 豆瓣 is off. Returns how many pages were fetched.
export async function prefetchMarkPages(db: DB, wait: (ms: number) => Promise<void> = sleep,
  fetchPage: (card: Card) => Promise<unknown> = (c) => (c.kind === 'book' ? editionsOf(db, c.subject) : moviePage(db, c.subject))): Promise<number> {
  if (running || doubanWaitMs()) return 0;
  const todo = cardsToFetch(db).slice(0, BATCH);
  if (!todo.length) return 0;
  running = true;
  let done = 0;
  try {
    for (const card of todo) {
      // Opened meanwhile, or fetched by another card of the same subject.
      if (card.kind === 'book' ? bookPageFresh(db, card.subject) : moviePageFresh(db, card.subject)) continue;
      let turns = card.kind === 'movie' ? MOVIE_REQUESTS : 1;
      while (turns-- > 0) if (!(await backgroundDoubanTurn(wait))) return done;
      try {
        await fetchPage(card);
        done++;
      } catch (e) {
        log.warn(`[marks] 预取条目页没成：${card.title}：${(e as Error).message}`);
        if (/HTTP 404/.test((e as Error).message)) gone.set(card.subject, Math.floor(Date.now() / 1000) + GONE_S);
        if (e instanceof DoubanNeedsLogin) gone.set(card.subject, Math.floor(Date.now() / 1000) + MEMBERS_ONLY_S);
        if (doubanWaitMs()) break;
      }
    }
    return done;
  } finally {
    running = false;
    if (done) log.info(`[marks] 预取了 ${done} 个标记的豆瓣条目页`);
  }
}
