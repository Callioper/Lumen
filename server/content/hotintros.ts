// 书影榜's blurbs: a book's 内容简介 or a film's 剧情简介, from the 豆瓣 page Lumen keeps for the subject
// (douban_subject.page, what the detail pages read). Ones not kept yet are fetched in the background,
// a few seconds apart like bookdates.ts, so a page of 书影榜 costs 豆瓣 a reader's browsing; a refusal
// stops it for an hour.
import type { DB } from '../db.ts';
import { editionsOf, DoubanError } from './douban.ts';
import { moviePage } from './doubanmovie.ts';
import { log } from '../log.ts';

const GAP_MS = 6000;
const BATCH = 30;
const REFUSED_PAUSE_MS = 3600_000;
const INTRO_CHARS = 140;

export interface HotSubject { kind: 'book' | 'movie'; subject: string }

let running = false;
let pausedUntil = 0;
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

// The kept blurb of each subject, cut to a few lines; '' when the page has none.
export function keptIntros(db: DB, subjects: readonly HotSubject[]): Map<string, string> {
  const out = new Map<string, string>();
  const get = db.prepare('SELECT page FROM douban_subject WHERE subject = ? AND page IS NOT NULL');
  for (const s of subjects) {
    const row = get.get(s.subject) as { page: string } | undefined;
    if (!row) continue;
    try {
      const page = JSON.parse(row.page) as { kind?: string; intro?: string[] };
      // A book's page and a film's are kept in one table: take the one of the right kind.
      if ((s.kind === 'movie') !== (page.kind === 'movie')) continue;
      out.set(s.subject, introLine(page.intro ?? []));
    } catch { /* an unreadable page is fetched again */ }
  }
  return out;
}

export function introLine(paras: readonly string[]): string {
  const all = paras.join(' ').replace(/\s+/g, ' ').trim();
  return all.length > INTRO_CHARS ? `${all.slice(0, INTRO_CHARS)}…` : all;
}

// Starts fetching the ones with no page yet, unless a batch is running or 豆瓣 refused lately.
export function fillIntros(db: DB, missing: readonly HotSubject[], wait: (ms: number) => Promise<void> = sleep): number {
  if (!missing.length || running || Date.now() < pausedUntil) return missing.length;
  running = true;
  void (async () => {
    let n = 0;
    try {
      for (const s of missing.slice(0, BATCH)) {
        if (s.kind === 'book') await editionsOf(db, s.subject); else await moviePage(db, s.subject);
        n++;
        await wait(GAP_MS);
      }
    } catch (err) {
      if (err instanceof DoubanError) { pausedUntil = Date.now() + REFUSED_PAUSE_MS; log.warn(`[hot] 取简介被豆瓣拒绝，一小时后再取：${err.message}`); }
      else log.warn(`[hot] 取简介中断：${(err as Error).message}`);
    } finally {
      running = false;
      if (n) log.info(`[hot] 取了 ${n} 条简介`);
    }
  })();
  return missing.length;
}
