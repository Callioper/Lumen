// 周报: the week's daily topics drawn together into a few threads (one LLM call over the dailies'
// group names and summaries, not over the articles again), and what the reader did that week.
import type { DB } from '../db.ts';
import type { HotPick } from './hot.ts';
import type { Period } from './collect.ts';
import type { DailyItem, DailyReport } from './daily.ts';
import type { Voice, Written, WriteItem } from './write.ts';

const THREAD_ITEMS = 6;      // the closest to the reader's interests; the rest are counted
const TOP_FEEDS = 5;

export interface WeeklyThread {
  name: string;
  summary: string;
  days: string[];            // daily periods the thread came up on
  items: DailyItem[];
  more: number;              // further items in the thread's daily groups
}

export interface WeeklyStats {
  arrived: number;           // everything that came in, timelines included
  completed: number;         // read to the end
  skimmed: number;
  starred: number;
  liked: number;
  topFeeds: { feed: string; opened: number }[];
}

export interface WeeklyReport {
  kind: 'weekly';
  period: string;            // 2026-W43
  from: number; to: number;
  overview: string;
  threads: WeeklyThread[];
  dailies: string[];         // the daily periods it was drawn from
  stats: WeeklyStats;
  total: number;             // items across the threads
  hot?: { book: HotPick[]; movie: HotPick[] };   // 本周友邻热点 (from 2026-10-23 on)
}

export const WEEKLY_VOICE: Voice = {
  system: '你是一份个人阅读周报的编辑。下面是一周里每天日报的议题和导语，请把相同或相近的议题归成本周主线。只依据给出的内容，不补充其中没有的事实。',
  groups: '3–5', example: '「人工智能与人文学科」「鲁迅逝世九十周年」',
  mention: '说明这条主线一周里怎么展开、哪几天出现、有何变化',
  overview: '再写 2–3 句总述，说出这一周最集中的话题。',
};

const dayLabel = (period: string): string => { const [, m, d] = period.split('-'); return `${Number(m)}月${Number(d)}日`; };

// One line per daily group: what the model merges.
export function weeklyInput(dailies: DailyReport[]): { lines: WriteItem[]; refs: { day: string; group: number }[] } {
  const lines: WriteItem[] = [];
  const refs: { day: string; group: number }[] = [];
  for (const d of dailies) d.groups.forEach((g, gi) => {
    if (!g.summary) return;    // 其他 carries no summary and no topic
    lines.push({ title: g.name, authors: dayLabel(d.period), venue: `${g.items.length} 条`, abstract: g.summary });
    refs.push({ day: d.period, group: gi });
  });
  return { lines, refs };
}

export function assembleWeekly(p: Period & { period: string }, dailies: DailyReport[], written: Written, stats: WeeklyStats, hot?: WeeklyReport['hot']): WeeklyReport {
  const { refs } = weeklyInput(dailies);
  const byDay = new Map(dailies.map((d) => [d.period, d]));
  const threads = written.groups.map((g): WeeklyThread => {
    const parts = g.items.map((k) => refs[k]);
    const seen = new Set<number>();
    const items: DailyItem[] = [];
    for (const r of parts) for (const it of byDay.get(r.day)!.groups[r.group].items) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    items.sort((a, b) => b.interest - a.interest);
    return { name: g.name, summary: g.summary, days: [...new Set(parts.map((r) => r.day))].sort(), items: items.slice(0, THREAD_ITEMS),
      more: Math.max(0, items.length - THREAD_ITEMS) };
  });
  return { kind: 'weekly', period: p.period, from: p.from, to: p.to, overview: written.overview, threads,
    dailies: dailies.map((d) => d.period), stats, total: threads.reduce((n, t) => n + t.items.length + t.more, 0), hot };
}

// From what the reader did, not from is_read: marking a list read sets thousands of those a day.
export function weeklyStats(db: DB, p: Period): WeeklyStats {
  const inWeek = [p.from * 1_000_000, p.to * 1_000_000];
  const count = (type: string): number =>
    (db.prepare('SELECT count(DISTINCT entry_id) AS n FROM event WHERE type = ? AND created_at >= ? AND created_at < ?').get(type, p.from, p.to) as { n: number }).n;
  const arrived = (db.prepare('SELECT count(*) AS n FROM entry WHERE id >= ? AND id < ?').get(...inWeek) as { n: number }).n;
  const starred = (db.prepare('SELECT count(*) AS n FROM entry WHERE is_starred = 1 AND id >= ? AND id < ?').get(...inWeek) as { n: number }).n;
  const liked = (db.prepare("SELECT count(*) AS n FROM entry WHERE reaction = 'like' AND id >= ? AND id < ?").get(...inWeek) as { n: number }).n;
  const topFeeds = db.prepare(`SELECT f.title AS feed, count(DISTINCT v.entry_id) AS opened FROM event v JOIN feed f ON f.id = v.feed_id
    WHERE v.type IN ('read_complete', 'skim') AND v.created_at >= ? AND v.created_at < ? GROUP BY f.id ORDER BY opened DESC LIMIT ?`)
    .all(p.from, p.to, TOP_FEEDS) as { feed: string; opened: number }[];
  return { arrived, completed: count('read_complete'), skimmed: count('skim'), starred, liked, topFeeds: topFeeds.map((r) => ({ ...r })) };
}
