// 论文周报 as an Obsidian note. Every paper links to its original and to the entry in Lumen.
import type { PaperItem } from './collect.ts';
import type { InLibrary } from './zotero.ts';
import type { DailyItem, DailyReport } from './daily.ts';
import type { WeeklyReport } from './weekly.ts';

export interface PaperGroup { name: string; summary: string; items: PaperItem[] }
export interface PapersReport {
  kind: 'papers';
  period: string;              // 2026-W43: the database key only; notes and pages name the dates
  from: number; to: number;    // unix seconds, [from, to)
  overview: string;
  picks: PaperItem[];
  groups: PaperGroup[];
  journals: { feed: string; items: PaperItem[] }[];   // the rest of each journal's new issue
  total: number;
  zotero: Record<number, InLibrary>;
}

const day = (t: number): string => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Brackets in a title would close the link text early.
const linkText = (s: string): string => s.replace(/([[\]])/g, '\\$1');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// 2026年10月12日—10月18日; the year is repeated only when the range crosses one.
// The end of a range repeats only what changed: 10月12日—18日, 10月26日—11月1日, 2026年12月28日—2027年1月3日.
function span(from: number, to: number, y: (d: Date) => string, m: (d: Date) => string, d: (x: Date) => string, sep: string): string {
  const a = new Date(from * 1000), b = new Date((to - 1) * 1000);
  const head = y(a) + m(a) + d(a);
  if (a.toDateString() === b.toDateString()) return head;
  if (a.getFullYear() !== b.getFullYear()) return head + sep + y(b) + m(b) + d(b);
  return head + sep + (a.getMonth() !== b.getMonth() ? m(b) : '') + d(b);
}

export const rangeLabel = (from: number, to: number): string =>
  span(from, to, (x) => `${x.getFullYear()}年`, (x) => `${x.getMonth() + 1}月`, (x) => `${x.getDate()}日`, '—');

// File names, zero-padded so they sort by date: 论文周报 2026.10.12–18.md
const pad = (n: number): string => String(n).padStart(2, '0');
export const rangeSlug = (from: number, to: number): string =>
  span(from, to, (x) => `${x.getFullYear()}.`, (x) => `${pad(x.getMonth() + 1)}.`, (x) => pad(x.getDate()), '–');

export const lumenLink = (port: number, id: number): string => `http://127.0.0.1:${port}/#entry=${id}`;

function zoteroMark(v: InLibrary | undefined): string {
  if (v === true) return ' · Zotero 已在库';
  if (v === false) return ' · Zotero 未在库';
  return '';
}

function title(it: { title: string; link: string | null }): string {
  return it.link ? `[${linkText(it.title)}](${it.link})` : linkText(it.title);
}

function byline(it: PaperItem): string {
  return [it.authors, it.venue].filter(Boolean).join('｜');
}

function source(it: PaperItem): string {
  if (it.via === 'journal') return '';
  return `〔${[it.feed, ...(it.also.length ? [`另见：${it.also.join('、')}`] : [])].join('；')}〕`;
}

function paperLine(it: PaperItem, port: number, r: PapersReport, star: boolean): string[] {
  const head = `- ${star ? '★ ' : ''}**${title(it)}**　${byline(it)}${source(it)} · [Lumen](${lumenLink(port, it.id)})${zoteroMark(r.zotero[it.id])}`;
  return it.abstract ? [head, `  > ${it.abstractBy === 'ai' ? '（AI 摘要）' : ''}${oneLine(it.abstract)}`] : [head];
}

export function renderPapers(r: PapersReport, port: number): string {
  const picked = new Set(r.picks.map((p) => p.id));
  const out: string[] = [
    '---',
    'tags: [Lumen报告, 论文周报]',
    `range: ${day(r.from)} — ${day(r.to - 1)}`,
    `papers: ${r.total}`,
    '---',
    `# 论文周报（${rangeLabel(r.from, r.to)}）`,
    '',
  ];
  if (r.overview) out.push('> [!abstract] 本周', `> ${oneLine(r.overview)}`, '');
  out.push(`共 ${r.total} 篇：公众号转发与按兴趣挑出的期刊论文分议题列在前面，各刊新刊的其余篇目折叠在最后。`, '');
  if (r.picks.length) {
    out.push('## 值得精读', '');
    r.picks.forEach((it, i) => {
      out.push(`${i + 1}. **${title(it)}**　${byline(it)}${source(it)} · [Lumen](${lumenLink(port, it.id)})${zoteroMark(r.zotero[it.id])}`);
      if (it.abstract) out.push(`   > ${it.abstractBy === 'ai' ? '（AI 摘要）' : ''}${oneLine(it.abstract)}`);
    });
    out.push('');
  }
  if (r.groups.length) out.push('## 议题', '');
  for (const g of r.groups) {
    out.push(`### ${g.name}（${g.items.length}）`, '');
    if (g.summary) out.push(oneLine(g.summary), '');
    for (const it of g.items) out.push(...paperLine(it, port, r, picked.has(it.id)));
    out.push('');
  }
  if (r.journals.length) out.push('## 期刊新刊', '');
  for (const j of r.journals) {
    out.push(`> [!note]- ${j.feed}（${j.items.length}）`);
    // Titles link to Lumen only: CNKI's links run to 300 characters and made the note ten times longer.
    for (const it of j.items) out.push(`> - [${linkText(it.title)}](${lumenLink(port, it.id)})　${it.authors}`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function itemLine(it: DailyItem, port: number, numbered?: number): string[] {
  const head = `${numbered ? `${numbered}.` : '-'} **${title(it)}**　〔${[it.feed, ...(it.also.length ? [`另见：${it.also.join('、')}`] : [])].join('；')}〕 · [Lumen](${lumenLink(port, it.id)})`;
  return it.lead ? [head, `${numbered ? '   ' : '  '}> ${oneLine(it.lead)}`] : [head];
}

export function renderDaily(r: DailyReport, port: number): string {
  const out: string[] = ['---', 'tags: [Lumen报告, 日报]', `date: ${day(r.from)}`, `items: ${r.total}`, '---', `# 日报（${rangeLabel(r.from, r.to)}）`, ''];
  if (r.overview) out.push('> [!abstract] 今日', `> ${oneLine(r.overview)}`, '');
  out.push(`这一天进来 ${r.arrived} 条，按兴趣挑出 ${r.total} 条分议题列出。`, '');
  if (r.picks.length) {
    out.push('## 你可能错过', '');
    r.picks.forEach((it, i) => out.push(...itemLine(it, port, i + 1)));
    out.push('');
  }
  if (r.explore) out.push('## 破茧', '', '和你平常读的方向不同，换换口味。', '', ...itemLine(r.explore, port), '');
  for (const g of r.groups) {
    out.push(`## ${g.name}（${g.items.length}）`, '');
    if (g.summary) out.push(oneLine(g.summary), '');
    for (const it of g.items) out.push(...itemLine(it, port));
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const shortDay = (period: string): string => { const [, m, d] = period.split('-'); return `${Number(m)}月${Number(d)}日`; };

export function renderWeekly(r: WeeklyReport, port: number): string {
  const s = r.stats;
  const out: string[] = ['---', 'tags: [Lumen报告, 周报]', `range: ${day(r.from)} — ${day(r.to - 1)}`, '---', `# 周报（${rangeLabel(r.from, r.to)}）`, ''];
  if (r.overview) out.push('> [!abstract] 本周', `> ${oneLine(r.overview)}`, '');
  out.push(`由 ${r.dailies.length} 份日报汇成：${r.dailies.map(shortDay).join('、')}。`, '');
  r.threads.forEach((t, i) => {
    out.push(`## ${i + 1}. ${t.name}`, '', `*${t.days.map(shortDay).join('、')}*`, '');
    if (t.summary) out.push(oneLine(t.summary), '');
    for (const it of t.items) out.push(...itemLine(it, port));
    if (t.more) out.push(`- ……另有 ${t.more} 条`);
    out.push('');
  });
  const hot = r.hot && [...r.hot.book, ...r.hot.movie].length ? r.hot : null;
  if (hot) {
    out.push('## 本周友邻热点', '');
    for (const [label, kind, list] of [['书', 'book', hot.book], ['影视', 'movie', hot.movie]] as const) {
      if (!list.length) continue;
      out.push(`**${label}**`, '');
      for (const h of list) out.push(`- [${h.title}](https://${kind}.douban.com/subject/${h.subject}/)：${h.people} 位友邻（${h.who}${h.people > 3 ? ' 等' : ''}）${h.isNew ? ' · 新上榜' : ''}`);
      out.push('');
    }
  }
  out.push('## 本周阅读', '',
    `- 进来 ${s.arrived} 条；读完 ${s.completed} 篇，略读 ${s.skimmed} 篇`,
    `- 本周进来的文章里收藏 ${s.starred} 篇，点喜欢 ${s.liked} 篇`);
  if (s.topFeeds.length) out.push(`- 最常打开：${s.topFeeds.map((f) => `${f.feed}（${f.opened}）`).join('、')}`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
