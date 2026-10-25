// 评论区: the comments under an entry's original page, fetched when the reader opens the section
// and kept a day. One adapter per site, chosen by the entry's link; each turns the site's answer
// into the same Comment shape. Douban is asked anonymously through its mobile API (rexxar), so
// the reader's cookie is never spent on this; it once blocked a burst of requests, and opening a
// section costs one.
import type { DB } from '../db.ts';
import { log } from '../log.ts';

export interface Comment { who: string; text: string; time: number; likes: number; rating?: number; replies: Comment[] }
export interface Comments { source: string; url: string; total: number; comments: Comment[]; fetchedAt: number;
  stale?: string }   // why this older copy is shown instead of a fresh one
export class CommentsError extends Error {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 12_000;
const SHOWN = 20;
const FRESH_S = 86400;

interface Adapter { source: string; match: RegExp; fetch: (m: RegExpExecArray) => Promise<{ total: number; comments: Comment[] }> }

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status === 403 || r.status === 429) throw new CommentsError(`对方拒绝了请求（${r.status}），稍后再试`);
  if (r.status === 404) throw new CommentsError('原页面不存在或已删除');
  if (!r.ok) throw new CommentsError(`对方返回 ${r.status}`);
  return r.json();
}

// 「2026-10-20 17:23:47」, China time.
const doubanTime = (s: unknown): number => {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s) : null;
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] ?? 0)) / 1000) : 0;
};
type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? v as Raw : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const rexxar = (path: string): Promise<unknown> =>
  getJson(`https://m.douban.com/rexxar/api/v2/${path}`, { Referer: 'https://m.douban.com/' });

// Replies to a review or a broadcast, each with the replies under it.
export function doubanComment(c: Raw): Comment {
  return { who: str(obj(c.author).name), text: str(c.text), time: doubanTime(c.create_time), likes: num(c.vote_count),
    replies: list(c.replies).map(doubanComment) };
}
// Short reviews of a book, film or record: only those that say something.
export function doubanInterest(c: Raw): Comment {
  const rating = num(obj(c.rating).value);
  return { who: str(obj(c.user).name), text: str(c.comment), time: doubanTime(c.create_time), likes: num(c.vote_count),
    ...(rating ? { rating } : {}), replies: [] };
}
export function sspaiComment(c: Raw): Comment {
  return { who: str(obj(c.user).nickname), text: str(c.comment), time: num(c.created_at), likes: num(c.likes_count),
    replies: list(c.reply).map(sspaiComment) };
}

const ADAPTERS: Adapter[] = [
  { source: '豆瓣短评', match: /^https?:\/\/(book|movie|music)\.douban\.com\/subject\/(\d+)/,
    fetch: async (m) => {
      const r = obj(await rexxar(`${m[1]}/${m[2]}/interests?count=${SHOWN}&order_by=hot`));
      return { total: num(r.total), comments: list(r.interests).map(doubanInterest).filter((c) => c.text) };
    } },
  { source: '豆瓣回应', match: /^https?:\/\/(?:book|movie|music|www)\.douban\.com\/review\/(\d+)/,
    fetch: async (m) => {
      const r = obj(await rexxar(`review/${m[1]}/comments?count=${SHOWN}`));
      return { total: num(r.total), comments: list(r.comments).map(doubanComment) };
    } },
  { source: '豆瓣回应', match: /^https?:\/\/www\.douban\.com\/people\/[^/]+\/status\/(\d+)/,
    fetch: async (m) => {
      const r = obj(await rexxar(`status/${m[1]}/comments?count=${SHOWN}`));
      return { total: num(r.total), comments: list(r.comments).map(doubanComment) };
    } },
  { source: '少数派评论', match: /^https?:\/\/sspai\.com\/post\/(\d+)/,
    fetch: async (m) => {
      const r = obj(await getJson(`https://sspai.com/api/v1/comment/user/article/hot/page/get?limit=${SHOWN}&offset=0&article_id=${m[1]}`, {}));
      if (num(r.error)) throw new CommentsError(str(r.msg) || '少数派返回错误');
      return { total: num(r.total), comments: list(r.data).map(sspaiComment) };
    } },
];

const adapterFor = (link: string | null): { a: Adapter; m: RegExpExecArray } | null => {
  for (const a of ADAPTERS) { const m = link ? a.match.exec(link) : null; if (m) return { a, m }; }
  return null;
};
// Which site's comments an entry can show, or null; the reader offers the section only then.
export const commentSource = (link: string | null): string | null => adapterFor(link)?.a.source ?? null;

// Cached a day; `refresh` asks again anyway.
export async function commentsFor(db: DB, entryId: number, refresh = false, now = Math.floor(Date.now() / 1000)): Promise<Comments | null> {
  const e = db.prepare('SELECT link FROM entry WHERE id = ?').get(entryId) as { link: string | null } | undefined;
  const hit = adapterFor(e?.link ?? null);
  if (!e?.link || !hit) return null;
  const cached = db.prepare('SELECT data, fetched_at FROM comment_cache WHERE entry_id = ?').get(entryId) as { data: string; fetched_at: number } | undefined;
  if (cached && !refresh && now - cached.fetched_at < FRESH_S) return JSON.parse(cached.data) as Comments;
  try {
    const got = await hit.a.fetch(hit.m);
    const out: Comments = { source: hit.a.source, url: e.link, total: Math.max(got.total, got.comments.length), comments: got.comments.slice(0, SHOWN), fetchedAt: now };
    db.prepare(`INSERT INTO comment_cache (entry_id, fetched_at, data) VALUES (?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`).run(entryId, now, JSON.stringify(out));
    return out;
  } catch (err) {
    const msg = err instanceof CommentsError ? err.message : (err as Error).name === 'TimeoutError' ? '对方没有应答（超时）' : (err as Error).message;
    log.warn(`[comments] ${e.link}: ${msg}`);
    // An older copy is better than nothing when the site does not answer.
    if (cached) return { ...(JSON.parse(cached.data) as Comments), stale: msg };
    throw new CommentsError(msg);
  }
}
