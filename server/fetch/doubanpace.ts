// One budget for everything Lumen asks of 豆瓣: the ~95 豆瓣 feeds (through RSSHub or not), the 新书
// dates and 书影榜 blurbs looked up in the background, and what the reader opens. 豆瓣 refuses an
// address that asks too much at once (10-29: a restart fetched the due 豆瓣 feeds in two minutes, and
// for an hour after every 豆瓣 request was 403), so:
// - the requests go one at a time, at least `gap` apart; feeds and background lookups wait their turn,
//   what the reader opens goes ahead of them, a little apart still;
// - a refusal stops all of them for a cool-down (20 minutes, doubling while refusals go on, at most
//   6 hours), and widens the gap; answers narrow it back.
// The feeds a refusal stops are put back spread over the cool-down after it, not all at its end.
import { log } from '../log.ts';

export const BASE_GAP_MS = 20_000;
const MAX_GAP_MS = 120_000;
const READER_GAP_MS = 1500;
const COOL_START_MS = 20 * 60_000;
const COOL_MAX_MS = 6 * 3600_000;
const NARROW = 0.9;

let gap = BASE_GAP_MS;
let last = 0;
let blockedUntil = 0;
let cool = COOL_START_MS;

// 「rsshub://douban/people/…」「rsshub://lumen/douban/…」「https://www.douban.com/feed/…」, not the image CDN.
export const isDoubanUrl = (url: string): boolean =>
  /^rsshub:\/\/(?:lumen\/)?douban\//.test(url) || /^https?:\/\/(?:[\w-]+\.)?douban\.com\//.test(url);

// What RSSHub says when 豆瓣 refused it: 「HTTP 403 [GET] "https://m.douban.com/rexxar/…": 403」.
export const isRefusal = (status: number, reason = ''): boolean =>
  status === 403 || status === 429 || /douban\.com\S*\s*:?\s*(?:403|429)\b/.test(reason);

export function doubanWaitMs(now = Date.now()): number { return Math.max(0, blockedUntil - now); }
export const doubanGapMs = (): number => gap;

// Whether a feed or a background lookup may go now; if so, its turn is taken.
export function takeDoubanTurn(now = Date.now()): boolean {
  if (now < blockedUntil || now - last < gap) return false;
  last = now;
  return true;
}

// For what the reader opened: waits the short gap, or says how long 豆瓣 is off (ms, 0 when it is not).
export async function readerDoubanTurn(now = Date.now()): Promise<number> {
  const wait = doubanWaitMs(now);
  if (wait) return wait;
  const lag = last + READER_GAP_MS - now;
  last = Math.max(now, last + READER_GAP_MS);
  if (lag > 0) await new Promise((ok) => setTimeout(ok, lag));
  return 0;
}

// Background loops: wait for a turn; false when 豆瓣 is off, to stop until it is back.
export async function backgroundDoubanTurn(sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms))): Promise<boolean> {
  for (;;) {
    if (doubanWaitMs()) return false;
    if (takeDoubanTurn()) return true;
    await sleep(Math.max(250, last + gap - Date.now()));
  }
}

export function doubanRefused(now = Date.now()): void {
  if (now < blockedUntil) return;   // the requests already on their way when the first was refused
  blockedUntil = now + cool;
  log.warn(`[douban] 豆瓣拒绝了本机的请求，暂停访问 ${Math.round(cool / 60_000)} 分钟；之后每次请求间隔 ${Math.round(Math.min(gap * 2, MAX_GAP_MS) / 1000)} 秒`);
  cool = Math.min(cool * 2, COOL_MAX_MS);
  gap = Math.min(gap * 2, MAX_GAP_MS);
}

export function doubanAnswered(now = Date.now()): void {
  if (now < blockedUntil) return;
  cool = COOL_START_MS;
  gap = Math.max(BASE_GAP_MS, Math.round(gap * NARROW));
}

// When a feed stopped by a refusal is tried again: some time over the cool-down after it.
export function deferredFetchAt(now = Date.now(), rand = Math.random()): number {
  const wait = doubanWaitMs(now);
  return Math.ceil((now + wait + rand * Math.max(wait, COOL_START_MS)) / 1000);
}

// The message for a request turned away while 豆瓣 is off.
export const offMessage = (ms: number): string =>
  `豆瓣暂时拒绝了本机的请求（多半是短时间里请求太多），Lumen 已暂停访问豆瓣，约 ${Math.max(1, Math.ceil(ms / 60_000))} 分钟后自动恢复`;

export function resetDoubanPace(): void { gap = BASE_GAP_MS; last = 0; blockedUntil = 0; cool = COOL_START_MS; }
