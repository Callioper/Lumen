// When reports are due, building them, and where they go: a row in `report` and a note in Obsidian.
// A scheduler calls POST /api/reports/run {ifDue: true} (scripts/report-due.mjs, e.g. every half hour); only a missing period is built.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.ts';
import type { Settings, Secrets } from '../config.ts';
import type { VectorIndex } from '../rec/embed.ts';
import { log } from '../log.ts';
import { collectPapers, redetect, INTEREST_FLOOR, type PaperItem, type Period } from './collect.ts';
import { writeGroups } from './write.ts';
import { collectDaily, assembleDaily, openedIds, missedPicks, DAILY_VOICE, type DailyReport, type DailyItem } from './daily.ts';
import { weeklyInput, assembleWeekly, weeklyStats, WEEKLY_VOICE, type WeeklyReport } from './weekly.ts';
import { weeklyHot } from './hot.ts';
import { checkZotero } from './zotero.ts';
import { renderPapers, renderDaily, renderWeekly, rangeLabel, rangeSlug, type PapersReport } from './render.ts';

const DUE_HOUR = 6;
const JOURNAL_IN_GROUPS = 10;
const PICKS = 3;

export interface ReportDeps { db: DB; index: VectorIndex; settings: Settings; secrets: Secrets }
export interface RunResult { kind: string; period: string; path: string; built: boolean; failed?: boolean; note?: string }
export type AnyReport = PapersReport | DailyReport | WeeklyReport;

// ISO week: Monday first, week 1 holds the year's first Thursday.
export function isoWeek(t: number): string {
  const d = new Date(t * 1000);
  const day = (d.getDay() + 6) % 7;
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week = 1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

const localDay = (d: Date, plusDays: number): number =>
  Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays).getTime() / 1000);

// The last complete local week (Monday to Monday) that is due: a week becomes due at 06:00 on the
// Monday after it, so before that on a Monday it is still the week before.
export function lastWeek(now: number): Period & { period: string } {
  const d = new Date(now * 1000);
  const sinceMonday = (d.getDay() + 6) % 7;
  let to = localDay(d, -sinceMonday);
  if (now < to + DUE_HOUR * 3600) to = localDay(d, -sinceMonday - 7);
  const from = localDay(new Date(to * 1000), -7);
  return { from, to, period: isoWeek(from) };
}

const isoDay = (t: number): string => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The last complete local day that is due: a day becomes due at 06:00 the next morning.
export function lastDay(now: number): Period & { period: string } {
  const d = new Date(now * 1000);
  let to = localDay(d, 0);
  if (now < to + DUE_HOUR * 3600) to = localDay(d, -1);
  const from = localDay(new Date(to * 1000), -1);
  return { from, to, period: isoDay(from) };
}

// Reposts are what the reader chose to follow, so all of them are grouped; of the journals' own
// listings only the closest to the reader's interests are, the rest folded per journal.
export function splitPapers(papers: PaperItem[]): { grouped: PaperItem[]; journals: { feed: string; items: PaperItem[] }[] } {
  const journalPicks = new Set(papers.filter((p) => p.via === 'journal' && p.interest >= INTEREST_FLOOR)
    .slice(0, JOURNAL_IN_GROUPS).map((p) => p.id));
  const grouped = papers.filter((p) => p.via === 'repost' || journalPicks.has(p.id));
  const byFeed = new Map<string, PaperItem[]>();
  for (const p of papers) if (p.via === 'journal' && !journalPicks.has(p.id)) byFeed.set(p.feed, [...(byFeed.get(p.feed) ?? []), p]);
  return { grouped, journals: [...byFeed].sort((a, b) => b[1].length - a[1].length).map(([feed, items]) => ({ feed, items })) };
}

export async function buildPapers(d: ReportDeps, p: Period & { period: string }): Promise<PapersReport> {
  const papers = collectPapers(d.db, d.index, d.settings.embedding.model, p);
  const { grouped, journals } = splitPapers(papers);
  const written = await writeGroups(grouped, `一周内公众号转发和期刊新发的学术论文`, d.settings, d.secrets.aiApiKey);
  const inZotero = await checkZotero(grouped.map((g) => g.title));
  return {
    kind: 'papers', period: p.period, from: p.from, to: p.to, overview: written.overview,
    picks: [...grouped].sort((a, b) => Number(a.read) - Number(b.read) || b.interest - a.interest).slice(0, PICKS),
    groups: written.groups.map((g) => ({ name: g.name, summary: g.summary, items: g.items.map((k) => grouped[k]) })),
    journals,
    total: papers.length,
    zotero: Object.fromEntries(grouped.map((g, i) => [g.id, inZotero[i]])),
  };
}

export async function buildDaily(d: ReportDeps, p: Period & { period: string }): Promise<DailyReport> {
  const { items, arrived, explore } = collectDaily(d.db, d.index, d.settings.embedding.model, p);
  const written = await writeGroups(items.map((i) => ({ title: i.title, authors: i.feed, venue: '', abstract: i.lead })),
    '一天里收到的文章、播客和视频', d.settings, d.secrets.aiApiKey, DAILY_VOICE);
  return assembleDaily(p, items, written, arrived, openedIds(d.db, items.map((i) => i.id)), explore);
}

// From the week's dailies; null when there are none to draw from.
export async function buildWeekly(d: ReportDeps, p: Period & { period: string }): Promise<WeeklyReport | null> {
  const dailies = (d.db.prepare(`SELECT data FROM report WHERE kind = 'daily' AND json_extract(data, '$.from') >= ?
      AND json_extract(data, '$.from') < ? ORDER BY json_extract(data, '$.from')`).all(p.from, p.to) as { data: string }[])
    .map((r) => JSON.parse(r.data) as DailyReport);
  const { lines } = weeklyInput(dailies);
  if (!lines.length) return null;
  const written = await writeGroups(lines, '一周里每天日报的议题（括号里是日期和条数）', d.settings, d.secrets.aiApiKey, WEEKLY_VOICE);
  return assembleWeekly(p, dailies, written, weeklyStats(d.db, p), weeklyHot(d.db, p.to));
}

const KIND_NAME = { papers: '论文周报', daily: '日报', weekly: '周报' } as const;

// Where the note goes in the vault; null without one (设置 → 存档), and then the report lives in Lumen only.
const notePath = (d: ReportDeps, r: AnyReport): string | null => d.settings.clip.vaultPath
  ? join(d.settings.clip.vaultPath, d.settings.clip.reportFolder, KIND_NAME[r.kind], `${KIND_NAME[r.kind]} ${rangeSlug(r.from, r.to)}.md`)
  : null;

function writeNote(path: string | null, r: AnyReport, port: number): void {
  if (!path) return;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, render(r, port), 'utf8');
}

function render(r: AnyReport, port: number): string {
  if (r.kind === 'daily') return renderDaily(r, port);
  if (r.kind === 'weekly') return renderWeekly(r, port);
  return renderPapers(r, port);
}

function save(d: ReportDeps, r: AnyReport): string | null {
  const path = notePath(d, r);
  writeNote(path, r, d.settings.port);
  d.db.prepare('INSERT OR REPLACE INTO report (kind, period, data, path, created) VALUES (?, ?, ?, ?, ?)')
    .run(r.kind, r.period, JSON.stringify(r), path, Math.floor(Date.now() / 1000));
  return path;
}

// The stored report of a period, if there is one; its path is null when it was built without a vault.
const existing = (db: DB, kind: string, period: string): { path: string | null } | undefined =>
  db.prepare('SELECT path FROM report WHERE kind = ? AND period = ?').get(kind, period) as { path: string | null } | undefined;

// ifDue: build only a period that has no report yet (the latest one; older gaps are not caught up).
// The daily goes first: Monday's weekly is drawn from the dailies, Sunday's included. One kind failing
// does not keep the others from being built.
export async function runReports(d: ReportDeps, opts: { ifDue: boolean; now?: number; kinds?: AnyReport['kind'][] }): Promise<RunResult[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const kinds = opts.kinds ?? ['daily', 'weekly', 'papers'];
  const day = lastDay(now), week = lastWeek(now);
  const plans: { kind: AnyReport['kind']; p: Period & { period: string }; build: () => Promise<AnyReport | null> }[] = [
    { kind: 'daily', p: day, build: () => buildDaily(d, day) },
    { kind: 'weekly', p: week, build: () => buildWeekly(d, week) },
    { kind: 'papers', p: week, build: () => buildPapers(d, week) },
  ];
  const out: RunResult[] = [];
  for (const { kind, p, build } of plans.filter((x) => kinds.includes(x.kind))) {
    const had = existing(d.db, kind, p.period);
    if (had && opts.ifDue) { out.push({ kind, period: p.period, path: had.path ?? '', built: false }); continue; }
    try {
      const r = await build();
      if (!r) { out.push({ kind, period: p.period, path: '', built: false, note: '这一周还没有日报' }); continue; }
      const path = save(d, r);
      log.info(`[report] ${KIND_NAME[kind]}（${rangeLabel(p.from, p.to)}）：${r.total} 条${path ? ` → ${path}` : ''}`);
      out.push({ kind, period: p.period, path: path ?? '', built: true });
    } catch (e) {
      log.warn(`[report] ${KIND_NAME[kind]}（${rangeLabel(p.from, p.to)}）没生成：${(e as Error).message}`);
      out.push({ kind, period: p.period, path: '', built: false, failed: true, note: (e as Error).message });
    }
  }
  return out;
}

// Rewrites the notes from the stored reports after a format or rule change, without asking the model again
// (the groups stay as the reader saw them). A note under an old file name is moved, not duplicated.
export function rerenderReports(d: ReportDeps): RunResult[] {
  const rows = d.db.prepare('SELECT data, path FROM report').all() as { data: string; path: string | null }[];
  return rows.map((row) => {
    const stored = JSON.parse(row.data) as AnyReport;
    // A paper's authors, venue and abstract follow the current rules; the groups and overview stay as written.
    const again = (items: PaperItem[]): PaperItem[] => items.map((it) => redetect(d.db, it));
    // A daily's picks follow what has been opened since.
    const dailyAgain = (stored: DailyReport): DailyReport => {
      const clean = (it: DailyItem): DailyItem => ({ ...it, lead: it.lead.replace(/^<正>\s*/, '') });   // CNKI's marker, before leadOf dropped it
      const groups = stored.groups.map((g) => ({ ...g, items: g.items.map(clean) }));
      const all = groups.flatMap((g) => g.items).sort((a, b) => b.interest - a.interest);
      // Dailies from before 破茧 get one: picking it reads the library only, the model is not asked.
      const explore = stored.explore !== undefined ? stored.explore
        : collectDaily(d.db, d.index, d.settings.embedding.model, { from: stored.from, to: stored.to }).explore;
      return { ...stored, groups, picks: missedPicks(all, openedIds(d.db, all.map((i) => i.id))), explore };
    };
    const r: AnyReport = stored.kind === 'daily' ? dailyAgain(stored) : stored.kind !== 'papers' ? stored : { ...stored, picks: again(stored.picks),
      groups: stored.groups.map((g) => ({ ...g, items: again(g.items) })), journals: stored.journals.map((j) => ({ ...j, items: again(j.items) })) };
    const path = notePath(d, r);
    if (path && row.path && row.path !== path && existsSync(row.path) && !existsSync(path)) {
      mkdirSync(join(path, '..'), { recursive: true });
      renameSync(row.path, path);
    }
    writeNote(path, r, d.settings.port);
    d.db.prepare('UPDATE report SET path = ?, data = ? WHERE kind = ? AND period = ?').run(path, JSON.stringify(r), r.kind, r.period);
    return { kind: r.kind, period: r.period, path: path ?? '', built: false };
  });
}
