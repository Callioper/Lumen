// 录像: after a talk or a conference is over, whether a recording of it went up on B站. Looked for
// a few times in the month after (the organiser, a publisher or a listener uploads it days or weeks
// later); what is found is kept in `replay` and shown with the event in 学术动态.
import type { DB } from '../db.ts';
import type { Settings } from '../config.ts';
import { httpGet, decodeBody } from '../fetch/http.ts';
import { log } from '../log.ts';
import { academicNotices, localDay, replayKey, type Notice, type Replay } from './notices.ts';
import { coreName, namedFor, speakerNames } from './eventname.ts';

export { coreName };

const DAY_S = 86_400;
// Days after the event a search is due on; after the last, the event is let go.
const CHECK_ON_DAYS = [1, 3, 7, 14, 30];
const KINDS = new Set(['讲座', '会议', '活动']);
const MIN_MINUTES = 15;              // shorter is a trailer or a clip
const UPLOADED_WITHIN_DAYS = 60;
const SEARCHES_PER_PASS = 8;
const GAP_MS = 3000;                 // between searches: B站 answers -412 to a burst
const BACKOFF_MS = 3600_000;         // after a refused search
const QUERY_CHARS = 20;
const MIN_NAME = 2;

const SEARCH = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&order=pubdate&keyword=';
const VISITOR = 'https://api.bilibili.com/x/frontend/finger/spi';
// B站's search wants a browser and a visitor cookie, nothing more: no login.
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export interface Video { bvid: string; title: string; author: string; pubdate: number; duration: string }

const plain = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// 「121:52」 or 「1:02:03」 → seconds.
export function seconds(duration: string): number {
  const parts = duration.split(':').map(Number);
  return parts.some((n) => !Number.isFinite(n)) ? 0 : parts.reduce((s, n) => s * 60 + n, 0);
}

// What to ask B站, best first: the title with the first speaker, the speakers, the title alone.
export function queries(n: Notice): string[] {
  const core = coreName(n.name).slice(0, QUERY_CHARS);
  const names = speakerNames(n);
  return [...new Set([names[0] ? `${core} ${names[0]}` : '', names.length >= 2 ? names.slice(0, 3).join(' ') : '', core]
    .map((q) => q.trim()).filter((q) => q.length >= MIN_NAME))];
}

// The videos that are a recording of it: long enough, put up after it started and not long after,
// and named for it (two of its speakers, one and half its title, or nearly all its title).
export function recordings(n: Notice, videos: readonly Video[]): Video[] {
  const start = new Date(`${n.date}T00:00:00`).getTime() / 1000;
  return videos.map((v) => ({ ...v, title: plain(v.title) })).filter((v) =>
    seconds(v.duration) >= MIN_MINUTES * 60 && v.pubdate >= start - DAY_S && v.pubdate <= start + UPLOADED_WITHIN_DAYS * DAY_S
    && namedFor(n, v.title));
}

// Due when a day in CHECK_ON_DAYS has come since it was last looked for, and nothing found yet.
export function due(n: Notice, today: string, checked: number | undefined): boolean {
  if (!n.date || !KINDS.has(n.kind)) return false;
  const over = n.end || n.date;
  if (over >= today) return false;
  const ended = new Date(`${over}T00:00:00`).getTime() / 1000;
  const now = new Date(`${today}T00:00:00`).getTime() / 1000;
  const reached = CHECK_ON_DAYS.filter((d) => ended + d * DAY_S <= now);
  if (!reached.length || now - ended > (CHECK_ON_DAYS.at(-1)! + 1) * DAY_S) return false;
  return checked === undefined || checked < ended + reached.at(-1)! * DAY_S;
}

let visitor: { cookie: string; at: number } | null = null;
let refusedAt = 0;
const VISITOR_FOR_MS = 12 * 3600_000;

async function cookie(settings: Settings): Promise<string> {
  if (visitor && Date.now() - visitor.at < VISITOR_FOR_MS) return visitor.cookie;
  const res = await httpGet(VISITOR, settings, { headers: { 'user-agent': BROWSER } });
  const b3 = (JSON.parse(decodeBody(res.body, res.headers.get('content-type'))) as { data?: { b_3?: string } }).data?.b_3;
  if (!b3) throw new Error('B站没给访客 cookie');
  visitor = { cookie: `buvid3=${b3}`, at: Date.now() };
  return visitor.cookie;
}

class Refused extends Error {}

async function search(q: string, settings: Settings): Promise<Video[]> {
  const res = await httpGet(SEARCH + encodeURIComponent(q), settings,
    { headers: { 'user-agent': BROWSER, cookie: await cookie(settings), referer: 'https://search.bilibili.com/' } });
  if (res.status !== 200) throw new Refused(`HTTP ${res.status}`);
  const j = JSON.parse(decodeBody(res.body, res.headers.get('content-type'))) as { code: number; message?: string; data?: { result?: Video[] } };
  if (j.code !== 0) throw new Refused(`${j.code} ${j.message ?? ''}`);
  return (j.data?.result ?? []).map((v) => ({ bvid: v.bvid, title: plain(v.title), author: v.author, pubdate: v.pubdate, duration: v.duration }));
}

const wait = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
let running: Promise<number> | null = null;

// One pass: the events due, a few searches at most. The number of events a recording was found for.
export function findReplays(db: DB, settings: Settings, now = new Date()): Promise<number> {
  if (running) return running;
  if (Date.now() - refusedAt < BACKOFF_MS) return Promise.resolve(0);
  running = (async () => {
    const today = localDay(now);
    const checked = new Map((db.prepare('SELECT key, checked FROM replay').all() as { key: string; checked: number }[]).map((r) => [r.key, r.checked]));
    const todo = academicNotices(db, { kind: '', past: true, now }).items.filter((n) => !n.replays.length && due(n, today, checked.get(replayKey(n))));
    const put = db.prepare(`INSERT INTO replay (key, checked, found) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET checked = excluded.checked, found = excluded.found`);
    let searches = 0, found = 0;
    for (const n of todo) {
      if (searches >= SEARCHES_PER_PASS) break;
      let hits: Video[] = [];
      for (const q of queries(n)) {
        if (searches >= SEARCHES_PER_PASS) break;
        if (searches) await wait(GAP_MS);
        searches++;
        hits = recordings(n, await search(q, settings));
        if (hits.length) break;
      }
      const replays: Replay[] = hits.map((v) => ({ bvid: v.bvid, title: v.title, author: v.author, at: v.pubdate, minutes: Math.round(seconds(v.duration) / 60) }));
      put.run(replayKey(n), Math.floor(now.getTime() / 1000), replays.length ? JSON.stringify(replays) : null);
      if (replays.length) { found++; log.info(`[replay] 《${n.name}》在 B站有录像：${replays[0].title}`); }
    }
    return found;
  })().catch((e) => {
    if (e instanceof Refused) { refusedAt = Date.now(); log.warn(`[replay] B站搜索被拒（${e.message}），一小时后再试`); }
    else log.warn(`[replay] ${(e as Error).message}`);
    return 0;
  }).finally(() => { running = null; });
  return running;
}
