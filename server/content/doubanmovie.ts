// A film's or a series' page in Lumen. movie.douban.com sends a visitor to its 安全验证 page
// (sec.douban.com), so the film is read from the mobile site's own API (rexxar) instead, which
// answers a visitor: the subject, its hot short comments and what is liked alongside. Three
// requests, a little apart, kept a month in douban_subject.page like a book's page.
import type { DB } from '../db.ts';
import { DoubanError, type ShortComment, type Similar } from './douban.ts';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const TIMEOUT_MS = 12_000;
const GAP_MS = 1200;
const FRESH_S = 30 * 86400;
const COMMENTS = 10;
export const MOVIE_VERSION = 1;

export interface MoviePage {
  v: number; kind: 'movie';
  title: string; original: string; aka: string[]; year: string; cover: string | null;
  pubdate: string[]; durations: string[]; countries: string[]; languages: string[]; genres: string[];
  directors: string[]; actors: string[]; isTv: boolean; episodes: number;
  rating: number | null; votes: number;
  intro: string[]; comments: ShortComment[]; commentTotal: number; reviewTotal: number; similar: Similar[];
}

type Json = Record<string, unknown>;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String((x as Json)?.name ?? '')).filter(Boolean) : []);
const rateOf = (v: unknown): number | null => { const n = Number((v as Json | null)?.value); return n > 0 ? n : null; };
const picOf = (v: unknown): string | null => String((v as Json | null)?.normal ?? (v as Json | null)?.large ?? '') || null;

export function readMovie(subject: Json, interests: Json, recs: unknown): MoviePage {
  const rating = subject.rating as Json | null;
  return {
    v: MOVIE_VERSION, kind: 'movie',
    title: String(subject.title ?? ''), original: String(subject.original_title ?? ''), aka: strs(subject.aka).map((s) => s.replace(/\u200e/g, '')),
    year: String(subject.year ?? ''), cover: picOf(subject.pic),
    pubdate: strs(subject.pubdate), durations: strs(subject.durations), countries: strs(subject.countries), languages: strs(subject.languages),
    genres: strs(subject.genres), directors: names(subject.directors), actors: names(subject.actors),
    isTv: subject.is_tv === true, episodes: Number(subject.episodes_count) || 0,
    rating: rateOf(rating), votes: Number(rating?.count) || 0,
    intro: String(subject.intro ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean),
    comments: (Array.isArray(interests.interests) ? interests.interests as Json[] : []).slice(0, COMMENTS).map((c): ShortComment => ({
      who: String((c.user as Json | null)?.name ?? ''), stars: rateOf(c.rating), time: String(c.create_time ?? '').slice(0, 10),
      text: String(c.comment ?? '').trim(), votes: Number(c.vote_count) || 0,
    })).filter((c) => c.text),
    commentTotal: Number(subject.comment_count) || Number(interests.total) || 0, reviewTotal: Number(subject.review_count) || 0,
    similar: (Array.isArray(recs) ? recs as Json[] : []).map((r): Similar => ({
      subject: String(r.id ?? ''), title: String(r.title ?? ''), cover: picOf(r.pic), rating: rateOf(r.rating),
    })).filter((s) => /^\d+$/.test(s.subject)),
  };
}

async function rexxar(path: string, subject: string): Promise<unknown> {
  const r = await fetch(`https://m.douban.com/rexxar/api/v2/movie/${subject}${path}`, {
    headers: { 'User-Agent': UA, Referer: `https://m.douban.com/movie/subject/${subject}/` }, signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: Error) => { throw new DoubanError(`豆瓣没连上（${err.name === 'TimeoutError' ? '超时' : err.message}），稍后再试`); });
  if (!r.ok) throw new DoubanError(r.status === 403 || r.status === 429 ? '豆瓣拒绝了请求，可能是请求太频，稍后再试' : `豆瓣条目打不开（HTTP ${r.status}）`);
  return r.json();
}

const PARTIAL_KEEP_S = 3600;
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

export async function moviePage(db: DB, subject: string): Promise<{ page: MoviePage; wished: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT page, editions_at, wished_at FROM douban_subject WHERE subject = ?').get(subject) as { page: string | null; editions_at: number | null; wished_at: number | null } | undefined;
  const kept = row?.page ? JSON.parse(row.page) as Partial<MoviePage> : null;
  if (kept?.kind === 'movie' && kept.v === MOVIE_VERSION && row?.editions_at && now - row.editions_at < FRESH_S) return { page: kept as MoviePage, wished: !!row.wished_at };
  const s = await rexxar('', subject) as Json;
  await sleep(GAP_MS);
  // The comments and the recommendations may fail on their own; the page still shows, but is kept for an
  // hour only, where a refused request used to stand as "no comments" until the page went stale.
  let partial = false;
  const interests = await rexxar(`/interests?count=${COMMENTS}&order_by=hot`, subject).catch(() => { partial = true; return {}; }) as Json;
  await sleep(GAP_MS);
  const recs = await rexxar('/recommendations?count=10', subject).catch(() => { partial = true; return []; });
  const page = readMovie(s, interests, recs);
  const keptAt = partial ? now - FRESH_S + PARTIAL_KEEP_S : now;
  db.prepare(`INSERT INTO douban_subject (subject, editions_at, page) VALUES (?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET editions_at = excluded.editions_at, page = excluded.page`).run(subject, keptAt, JSON.stringify(page));
  return { page, wished: !!row?.wished_at };
}
