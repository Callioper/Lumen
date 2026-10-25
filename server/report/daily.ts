// 日报: what came in on one day, chosen by the reader's interests and grouped by topic in one LLM call.
// Weibo and Douban posts are left out (they read as a timeline, not as articles); podcasts and videos stay.
import type { DB } from '../db.ts';
import type { VectorIndex } from '../rec/embed.ts';
import { currentProfile } from '../rec/profile.ts';
import { interestOf, EXPLORE_MAX_SEMANTIC } from '../rec/rank.ts';
import { plainText } from '../content/sanitize.ts';
import { titleOverlap } from './ngram.ts';
import type { Period } from './collect.ts';
import type { Voice, Written } from './write.ts';

export const DAILY_VIEWS = ['article', 'video', 'audio'];
const CANDIDATES = 36;      // what the model groups: enough for 4–8 topics, small enough for one call
const PER_FEED = 3;         // one busy account does not fill the day
const PICKS = 3;
const LEAD_CHARS = 120;
const SAME_ITEM = 0.8;
const MIN_TITLE_FOR_MATCH = 6;
const EXPLORE_MIN_CHARS = 1500;   // 破茧 wants something with substance, not a notice

export interface DailyItem {
  id: number;
  title: string;
  feed: string;
  link: string | null;
  lead: string;              // the AI summary's first sentence, else the opening of the text
  interest: number;
  read: boolean;
  kept: boolean;             // starred, liked or read to the end that day: in regardless of score
  also: string[];
}

export interface DailyReport {
  kind: 'daily';
  period: string;            // 2026-10-21
  from: number; to: number;
  overview: string;
  picks: DailyItem[];        // 你可能错过: the closest to the reader's interests never opened
  explore?: DailyItem | null;   // 破茧: one long piece far from the reader's usual reading (absent in reports before 10-22)
  groups: { name: string; summary: string; items: DailyItem[] }[];
  total: number;             // candidates grouped
  arrived: number;           // everything that came in that day, timelines included
}

export const DAILY_VOICE: Voice = {
  system: '你是一份个人阅读日报的编辑，把一天收到的文章、播客和视频按事件与议题归并，并写导语。只依据给出的标题和简介，不补充其中没有的事实，不评价好坏。',
  groups: '4–8', example: '「人工智能与写作」「中菲南海摩擦」「福柯百年」',
  mention: '说明这组在讲什么事或什么问题、各条的角度有何不同；提到某条时用来源或标题',
  overview: '再写 2–3 句总述，说出这一天最集中的话题。',
};

interface Row { id: number; title: string; title_zh: string | null; link: string | null; html: string | null; ai_summary: string | null;
  feed: string; is_read: number; is_starred: number; reaction: string | null; completed: number }

// The first sentence of the stored AI summary (its opening <p> is the gist), else the opening of the text.
export function leadOf(aiSummary: string | null, html: string | null): string {
  const gist = aiSummary ? /<p>([\s\S]*?)<\/p>/.exec(aiSummary)?.[1] ?? '' : '';
  // CNKI starts its abstracts with <正> (body text).
  const text = plainText(gist || html || '', 600).replace(/\s+/g, ' ').replace(/^<正>\s*/, '').trim();
  const first = /^[\s\S]*?[。！？](?=\s|$|[^”」』）)])/.exec(text)?.[0] ?? text;
  return (first.length >= 20 ? first : text).slice(0, LEAD_CHARS);
}

// Arrival order, as for the papers; a reposted story is kept once with the others under 另见.
export function mergeSimilar(items: DailyItem[]): DailyItem[] {
  const out: DailyItem[] = [];
  for (const it of items) {
    const twin = it.title.length >= MIN_TITLE_FOR_MATCH
      ? out.find((o) => o.title.length >= MIN_TITLE_FOR_MATCH && titleOverlap(o.title, it.title) >= SAME_ITEM) : undefined;
    if (!twin) { out.push(it); continue; }
    const [keep, drop] = it.interest > twin.interest ? [it, twin] : [twin, it];
    out[out.indexOf(twin)] = { ...keep, also: [...new Set([...keep.also, ...drop.also, drop.feed].filter((f) => f !== keep.feed))],
      read: keep.read || drop.read, kept: keep.kept || drop.kept };
  }
  return out;
}

// Highest interest first, at most PER_FEED from one feed; what the reader kept comes in on top of that.
export function chooseDaily(items: DailyItem[], limit = CANDIDATES, perFeed = PER_FEED): DailyItem[] {
  const kept = items.filter((i) => i.kept);
  const count = new Map<string, number>();
  const chosen: DailyItem[] = [];
  for (const it of [...items].sort((a, b) => b.interest - a.interest)) {
    if (it.kept || chosen.length >= limit) continue;
    const n = count.get(it.feed) ?? 0;
    if (n >= perFeed) continue;
    count.set(it.feed, n + 1);
    chosen.push(it);
  }
  return [...kept, ...chosen].sort((a, b) => b.interest - a.interest);
}

// 破茧: among what was not chosen, one piece the profile says nothing about (and that is not of a
// kind the reader turned down), never opened (marking a list read does not count), with a real
// text; the longest wins.
export function pickExplore(pool: readonly (DailyItem & { chars: number })[], chosen: readonly DailyItem[], opened: Set<number>): DailyItem | null {
  const taken = new Set(chosen.map((i) => i.id));
  const best = pool.filter((i) => !taken.has(i.id) && !opened.has(i.id) && !i.kept && i.interest >= 0 && i.interest <= EXPLORE_MAX_SEMANTIC
    && i.chars >= EXPLORE_MIN_CHARS && i.lead.length >= 20).sort((a, b) => b.chars - a.chars)[0];
  if (!best) return null;
  const { chars: _, ...item } = best;
  return item;
}

export function collectDaily(db: DB, index: VectorIndex, model: string, p: Period): { items: DailyItem[]; arrived: number; explore: DailyItem | null } {
  const profile = currentProfile(db, index, model);
  const marks = DAILY_VIEWS.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT e.id, e.title, e.title_zh, e.link, COALESCE(e.content_full, e.content) AS html, e.ai_summary, f.title AS feed,
      e.is_read, e.is_starred, e.reaction,
      EXISTS (SELECT 1 FROM event v WHERE v.entry_id = e.id AND v.type = 'read_complete') AS completed
    FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.id >= ? AND e.id < ? AND f.noisy = 0 AND f.view IN (${marks}) ORDER BY e.id`)
    .all(p.from * 1_000_000, p.to * 1_000_000, ...DAILY_VIEWS) as unknown as Row[];
  const arrived = (db.prepare('SELECT count(*) AS n FROM entry WHERE id >= ? AND id < ?').get(p.from * 1_000_000, p.to * 1_000_000) as { n: number }).n;
  const items = rows.map((r): DailyItem & { chars: number } => {
    const v = index.get(model, r.id);
    return {
      chars: plainText(r.html ?? '', EXPLORE_MIN_CHARS * 4).length,
      id: r.id, title: (r.title_zh || r.title).trim(), feed: r.feed, link: r.link, lead: leadOf(r.ai_summary, r.html),
      interest: v && !profile.coldStart ? interestOf(v, profile).value : 0,
      read: !!r.is_read, kept: !!r.is_starred || r.reaction === 'like' || !!r.completed, also: [],
    };
  });
  const chosen = chooseDaily(mergeSimilar(items.map(({ chars: _, ...it }) => it)));
  return { items: chosen, arrived, explore: profile.coldStart ? null : pickExplore(items, chosen, openedIds(db, items.map((i) => i.id))) };
}

// Entries the reader opened (read, skimmed, or opened and left): is_read cannot tell, marking a list read sets it.
export function openedIds(db: DB, ids: readonly number[]): Set<number> {
  if (!ids.length) return new Set();
  const rows = db.prepare(`SELECT DISTINCT entry_id AS id FROM event WHERE type IN ('read_complete', 'skim', 'bounce')
    AND entry_id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

// The closest to the reader's interests among those never opened nor kept.
export const missedPicks = (items: readonly DailyItem[], opened: Set<number>): DailyItem[] =>
  items.filter((i) => !i.kept && !opened.has(i.id)).slice(0, PICKS);

export function assembleDaily(p: Period & { period: string }, items: DailyItem[], written: Written, arrived: number,
  opened: Set<number> = new Set(), explore: DailyItem | null = null): DailyReport {
  return {
    kind: 'daily', period: p.period, from: p.from, to: p.to, overview: written.overview,
    picks: missedPicks(items, opened), explore,
    groups: written.groups.map((g) => ({ name: g.name, summary: g.summary, items: g.items.map((k) => items[k]) })),
    total: items.length, arrived,
  };
}
