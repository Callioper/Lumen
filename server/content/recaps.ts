// 纪要: a talk or a conference over, the account that held it (or another) often writes it up — 「讲座回顾
// ｜……」「会议综述」. Such a post is not read by the AI (notices.ts leaves out what is said to be over);
// it is matched to the event by its title as a recording is (eventname.ts), posted on the day or within
// two months after, and shown with the event in 学术动态.
import type { DB } from '../db.ts';
import type { Notice } from './notices.ts';
import { namedFor, speakerNames } from './eventname.ts';

// Said in the title to be over.
export const OVER_WORDS = ['回顾', '纪实', '纪要', '综述', '致辞', '笔记', '成功举办', '顺利举办', '圆满', '侧记', '发言稿', '实录', '闭幕', '回放'];
export const OVER = new RegExp(OVER_WORDS.join('|'));

export interface Recap { id: number; title: string; feedId: number; feed: string; published: number; link: string | null; image?: string | null }

const DAY_S = 86_400;
const POSTED_WITHIN_DAYS = 60;
const SPEAKER_WITHIN_DAYS = 30;
const FULL_NAME = 3;            // a two-character name alone is too common a pair of characters
const KINDS = new Set(['讲座', '会议', '活动']);
const CACHE_MS = 5 * 60_000;

// The articles titled as over, since `since`, newest first.
export function recapCandidates(db: DB, since: number): Recap[] {
  const rows = db.prepare(`SELECT e.id, e.title, e.published, e.link, e.thumbnail, f.id AS feed_id, f.title AS feed
    FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.published > ? AND f.view = 'article' AND (${OVER_WORDS.map(() => 'e.title LIKE ?').join(' OR ')})
    ORDER BY e.published DESC`).all(since, ...OVER_WORDS.map((w) => `%${w}%`)) as
    { id: number; title: string; published: number; link: string | null; thumbnail: string | null; feed_id: number; feed: string }[];
  return rows.map((r) => ({ id: r.id, title: r.title, feedId: r.feed_id, feed: r.feed, published: r.published, link: r.link, image: r.thumbnail }));
}

// The write-ups of each dated talk, conference or event, by its key; a post can be about more than one.
// A post that names none of them so will still do by one speaker's full name, posted within a month:
// 「讲座笔记 | 莫妮卡·贝洛×赖立里：艺术同样需要科学的推理过程」 is the talk 「从观念走向实验」 (2026-09-11);
// of two talks by one speaker, the latest before it.
export function matchRecaps<N extends Notice & { post: { id: number } }>(notices: readonly N[], posts: readonly Recap[], key: (n: N) => string): Map<string, Recap[]> {
  const out = new Map<string, Recap[]>();
  const add = (n: N, p: Recap): void => { out.set(key(n), [...(out.get(key(n)) ?? []), p]); };
  const dated = notices.filter((n) => n.date && KINDS.has(n.kind)).map((n) => ({ n, start: new Date(`${n.date}T00:00:00`).getTime() / 1000 }));
  const after = (start: number, p: Recap, days: number): boolean => p.published >= start && p.published <= start + days * DAY_S;
  for (const p of posts) {
    const named = dated.filter(({ n, start }) => p.id !== n.post.id && after(start, p, POSTED_WITHIN_DAYS) && namedFor(n, p.title));
    if (named.length) { for (const { n } of named) add(n, p); continue; }
    const bySpeaker = dated.filter(({ n, start }) => p.id !== n.post.id && after(start, p, SPEAKER_WITHIN_DAYS)
      && speakerNames(n).some((s) => s.length >= FULL_NAME && p.title.includes(s)));
    const latest = bySpeaker.sort((a, b) => b.start - a.start)[0];
    if (latest) add(latest.n, p);
  }
  return out;
}

// The query looks through every title of the last months: kept a few minutes, as the page is asked for often.
const cache = new WeakMap<DB, { at: number; since: number; posts: Recap[] }>();
export function recentRecaps(db: DB, since: number): Recap[] {
  const had = cache.get(db);
  if (had && Date.now() - had.at < CACHE_MS && had.since <= since) return had.posts.filter((p) => p.published > since);
  const posts = recapCandidates(db, since);
  cache.set(db, { at: Date.now(), since, posts });
  return posts;
}
