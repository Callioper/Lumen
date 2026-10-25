// 知网: the journals subscribed through CNKI's RSS laid out as tables of contents, one issue per
// day of issue, and the links into CNKI that the contents read out of posts get.
import type { DB } from '../db.ts';
import { plainText } from './sanitize.ts';
import type { TocArticle } from './tocs.ts';

const RSS = /^https?:\/\/rss\.cnki\.net\/knavi\/rss\/([A-Za-z0-9]+)/;
const DAY = 86_400;
// Days between issues and how many issues a year that means; the gap is the median one.
const FREQUENCIES: { gap: number; perYear: number }[] = [{ gap: 30, perYear: 12 }, { gap: 61, perYear: 6 }, { gap: 91, perYear: 4 }, { gap: 182, perYear: 2 }];
const GAP_SLACK = 0.25;
const OPENING = /^<正>\s*/;
// CNKI dates an issue's articles a day or two apart; a day further than this starts another issue.
const SAME_ISSUE_DAYS = 7;
// Fewer articles than this on their own are online-first ones, not an issue.
const MIN_ARTICLES = 3;

export const searchCnki = (field: 'TI' | 'LY', kw: string): string =>
  `https://kns.cnki.net/kns8s/defaultresult/index?korder=${field}&kw=${encodeURIComponent(kw)}`;
export const journalPage = (code: string): string => `https://navi.cnki.net/knavi/journals/${code}/detail?uniplatform=NZKPT`;

// A journal's name without its 《》, spaces and bracketed edition: 「北京大学学报(哲社版)」 is 北京大学学报.
export const journalKey = (s: string): string => s.replace(/[(（][^)）]*[)）]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
export const titleKey = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

interface Feed { id: number; title: string; code: string }

export function cnkiFeeds(db: DB): Feed[] {
  const rows = db.prepare("SELECT id, title, url FROM feed WHERE url LIKE '%rss.cnki.net/knavi/rss/%'").all() as { id: number; title: string; url: string }[];
  return rows.flatMap((r) => {
    const code = RSS.exec(r.url)?.[1];
    return code ? [{ id: r.id, title: r.title.replace(/-CNKI$/, ''), code: code.toUpperCase() }] : [];
  });
}

// Which issue of its year an issue is, from how far apart the feed's issues come out; '' when the
// feed has too few issues to tell, or they keep no steady pace.
export function issueNumber(day: number, days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((d, i) => (d - sorted[i]) / DAY).sort((a, b) => a - b);
  if (!gaps.length) return '';
  const gap = gaps[Math.floor(gaps.length / 2)];
  const f = FREQUENCIES.find((x) => Math.abs(gap - x.gap) <= x.gap * GAP_SLACK);
  if (!f) return '';
  const month = new Date(day * 1000).getMonth() + 1;
  return String(Math.ceil(month / (12 / f.perYear)));
}

export interface CnkiIssue {
  journal: string; issue: string; inferred: boolean; at: number; feed: { id: number; title: string };
  link: string; articles: TocArticle[];
}

// Every issue the feeds have brought in, newest first. The oldest issue of a feed may be cut short:
// the RSS only ever carries the last twenty articles.
export function cnkiIssues(db: DB): (CnkiIssue & { partial: boolean })[] {
  const out: (CnkiIssue & { partial: boolean })[] = [];
  const rows = db.prepare('SELECT title, author, content, link, published FROM entry WHERE feed_id = ? ORDER BY published DESC, id');
  for (const f of cnkiFeeds(db)) {
    type Row = { title: string; author: string | null; content: string | null; link: string | null; published: number };
    const groups: { at: number; rows: Row[] }[] = [];
    for (const r of rows.all(f.id) as Row[]) {        // newest first
      const last = groups[groups.length - 1];
      if (last && last.at - r.published <= SAME_ISSUE_DAYS * DAY) { last.at = r.published; last.rows.push(r); }
      else groups.push({ at: r.published, rows: [r] });
    }
    const issues = groups.filter((g) => g.rows.length >= MIN_ARTICLES);
    const days = issues.map((g) => g.at);
    issues.forEach((g, i) => {
      const d = new Date(g.at * 1000);
      const n = issueNumber(g.at, days);
      out.push({
        journal: f.title, issue: n ? `${d.getFullYear()}年第${n}期` : `${d.getFullYear()}年${d.getMonth() + 1}月`, inferred: !!n,
        at: g.at, feed: { id: f.id, title: f.title }, link: journalPage(f.code), partial: i === issues.length - 1 && issues.length > 1,
        articles: g.rows.map(cnkiArticle),
      });
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// CNKI gives an article's abstract, or, for one without, the opening of its text marked <正>.
function cnkiArticle(r: { title: string; author: string | null; content: string | null; link: string | null }): TocArticle {
  const text = plainText(r.content ?? '');
  const lead = OPENING.test(text);
  return {
    title: r.title.replace(/\s+/g, ' ').trim(), subtitle: '', page: '', keywords: [], translators: [],
    authors: (r.author ?? '').split(/[;；,，]/).map((s) => s.trim()).filter(Boolean),
    abstract: text.replace(OPENING, ''), lead, link: r.link ?? searchCnki('TI', r.title),
  };
}

// Links for the contents read out of posts: an article the CNKI feeds have is linked to itself,
// any other to a CNKI search by its title; an issue to its journal's page when the journal is
// subscribed through CNKI, else to a search by the journal's name.
export function cnkiLinker(db: DB): { article: (title: string) => string; journal: (name: string) => string; abstract: (title: string) => string } {
  const feeds = cnkiFeeds(db);
  const codes = new Map(feeds.map((f) => [journalKey(f.title), f.code]));
  const links = new Map<string, string>();
  const abstracts = new Map<string, string>();
  if (feeds.length) {
    const rows = db.prepare(`SELECT title, link, content FROM entry WHERE feed_id IN (${feeds.map(() => '?').join(',')})`)
      .all(...feeds.map((f) => f.id)) as { title: string; link: string | null; content: string | null }[];
    for (const r of rows) {
      if (r.link) links.set(titleKey(r.title), r.link);
      const text = plainText(r.content ?? '');
      if (text && !OPENING.test(text)) abstracts.set(titleKey(r.title), text);   // an opening is not an abstract
    }
  }
  return {
    article: (title) => links.get(titleKey(title)) ?? searchCnki('TI', title),
    journal: (name) => { const code = codes.get(journalKey(name)); return code ? journalPage(code) : searchCnki('LY', name); },
    abstract: (title) => abstracts.get(titleKey(title)) ?? '',
  };
}
