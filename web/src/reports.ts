// 报告 page state: the list of built reports, the one on screen, and each paper's state now.
import { signal, computed, batch } from '@preact/signals';
import { api, type ReportKind, type ReportRow, type AnyReport, type EntryState } from './api.ts';
import { open, notify, setReportStep } from './store.ts';

export const REPORT_KINDS: { key: ReportKind; label: string }[] = [
  { key: 'papers', label: '论文周报' },
  { key: 'weekly', label: '周报' },
  { key: 'daily', label: '日报' },
];
// A journal card shows this many papers until it is opened, like a 简报 block.
export const JOURNAL_PREVIEW = 3;

export const reportRows = signal<ReportRow[]>([]);
export const reportKind = signal<ReportKind>('papers');
export const reportPeriod = signal<string | null>(null);
export const current = signal<{ report: AnyReport; path: string | null; state: Record<number, EntryState>; reprints?: Record<number, string> } | null>(null);
export const reportLoading = signal(false);
export const regenerating = signal(false);
// A paper can sit twice on the page (a pick is also in its topic), so the place is kept, not just the id.
export const selectedKey = signal<string | null>(null);
export const openJournals = signal<ReadonlySet<string>>(new Set());

export const rowsOfKind = computed(() => reportRows.value.filter((r) => r.kind === reportKind.value));

export const pickKey = (id: number): string => `pick:${id}`;
export const groupKey = (g: number, id: number): string => `group:${g}:${id}`;
export const journalKey = (feed: string, id: number): string => `journal:${feed}:${id}`;
export const threadKey = (t: number, id: number): string => `thread:${t}:${id}`;

interface Slot { key: string; id: number; journal?: string }

// Top to bottom as on screen, folded journal papers included (j/k opens their card).
const slots = computed<Slot[]>(() => {
  const r = current.value?.report;
  if (!r) return [];
  if (r.kind === 'weekly') return r.threads.flatMap((t, ti) => t.items.map((p) => ({ key: threadKey(ti, p.id), id: p.id })));
  if (r.kind === 'daily') return [
    ...r.picks.map((p) => ({ key: pickKey(p.id), id: p.id })),
    ...r.groups.flatMap((g, gi) => g.items.map((p) => ({ key: groupKey(gi, p.id), id: p.id }))),
  ];
  return [
    ...r.picks.map((p) => ({ key: pickKey(p.id), id: p.id })),
    ...r.groups.flatMap((g, gi) => g.items.map((p) => ({ key: groupKey(gi, p.id), id: p.id }))),
    ...r.journals.flatMap((j) => j.items.map((p) => ({ key: journalKey(j.feed, p.id), id: p.id, journal: j.feed }))),
  ];
});

export function toggleJournal(feed: string, on?: boolean): void {
  const next = new Set(openJournals.value);
  if (on ?? !next.has(feed)) next.add(feed); else next.delete(feed);
  openJournals.value = next;
}

export async function showReport(kind: ReportKind, period: string): Promise<void> {
  batch(() => { reportKind.value = kind; reportPeriod.value = period; reportLoading.value = true; selectedKey.value = null; openJournals.value = new Set(); });
  try {
    const r = await api.report(kind, period);
    if (reportPeriod.value === period) current.value = r;
  } catch (e) {
    notify((e as Error).message, true);
  } finally {
    reportLoading.value = false;
  }
}

// Opens the newest report of the kind, or keeps the one on screen if it is still listed.
export async function loadReports(kind = reportKind.value): Promise<void> {
  reportLoading.value = true;
  try {
    reportRows.value = (await api.reports()).reports;
  } catch (e) {
    notify((e as Error).message, true);
  } finally {
    reportLoading.value = false;
  }
  const rows = reportRows.value.filter((r) => r.kind === kind);
  const keep = rows.find((r) => r.period === reportPeriod.value && kind === reportKind.value);
  const next = keep ?? rows[0];
  if (next) {
    // 周报 and 论文周报 share their periods (2026-W42): what is on screen must be this kind too.
    if (keep && current.value?.report.kind === kind) { reportKind.value = kind; return; }
    await showReport(kind, next.period);
  } else batch(() => { reportKind.value = kind; reportPeriod.value = null; current.value = null; });
}

export async function openPaper(id: number, key: string): Promise<void> {
  const c = current.value;
  if (!c) return;
  if (c.state[id] === null) { notify('这篇已不在库里', true); return; }
  const slot = slots.value.find((s) => s.key === key);
  batch(() => {
    selectedKey.value = key;
    if (slot?.journal) toggleJournal(slot.journal, true);
  });
  try {
    const it = await api.entry(id);
    await open(it, { listScope: `report:${c.report.kind}:${c.report.period}`, sortMode: 'latest', position: slots.value.findIndex((s) => s.key === key) });
    const now = current.value;
    if (now) current.value = { ...now, state: { ...now.state, [id]: { read: true, starred: !!it.is_starred } } };
  } catch (e) {
    notify((e as Error).message, true);
  }
}

setReportStep((delta) => {
  const list = slots.value;
  const at = list.findIndex((s) => s.key === selectedKey.value);
  const next = list[at < 0 ? 0 : at + delta];
  if (next) void openPaper(next.id, next.key);
});

// Builds the latest period of the kind on screen again: one model call, and the groups may come out different.
export async function regenerate(): Promise<void> {
  regenerating.value = true;
  try {
    const r = await api.runReports(reportKind.value);
    const failed = r.results.find((x) => !x.built);
    if (r.busy) notify('已经在生成了，稍等');
    else if (failed) notify(failed.note ? `没生成：${failed.note}` : '没生成', true);
    else notify('已重新生成');
    reportPeriod.value = null;
    await loadReports(reportKind.value);
  } catch (e) {
    notify((e as Error).message, true);
  } finally {
    regenerating.value = false;
  }
}
