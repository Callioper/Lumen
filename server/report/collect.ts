// The papers of one period: detected by rule, merged across reposts, scored against the reader's interests.
import type { DB } from '../db.ts';
import type { VectorIndex } from '../rec/embed.ts';
import { currentProfile } from '../rec/profile.ts';
import { interestOf } from '../rec/rank.ts';
import { detectPaper, type Paper } from './papers.ts';
import { titleOverlap } from './ngram.ts';

// Two titles this alike are one paper (the same 「人间感」 article came from two accounts and twice from one).
const SAME_PAPER = 0.8;
const MIN_TITLE_FOR_MATCH = 6;
// Below this an entry is not close to any interest; a journal paper under it stays out of the topic groups.
export const INTEREST_FLOOR = 0.04;

export interface Period { from: number; to: number }   // unix seconds, [from, to)

export interface PaperItem extends Paper {
  id: number;
  link: string | null;
  feed: string;
  also: string[];             // other feeds that carried the same paper
  interest: number;
  read: boolean;
}

interface Row { id: number; link: string | null; title: string; author: string | null; html: string | null; summary: string | null; feed: string; view: string; cat: string | null; is_read: number }

// Arrival time, not publication: a back issue fetched this week is news this week.
function rows(db: DB, p: Period): Row[] {
  return db.prepare(`SELECT e.id, e.link, e.title, e.author, COALESCE(e.content_full, e.content) AS html, e.ai_summary AS summary, f.title AS feed, f.view,
      c.name AS cat, e.is_read FROM entry e JOIN feed f ON f.id = e.feed_id LEFT JOIN category c ON c.id = f.category_id
    WHERE e.id >= ? AND e.id < ? AND f.noisy = 0 ORDER BY e.id`).all(p.from * 1_000_000, p.to * 1_000_000) as unknown as Row[];
}

// One stored paper read again with the current rules; null when the entry is gone or no longer a paper.
// Used to refresh a built report's bibliographic lines without regrouping it.
export function redetect(db: DB, item: PaperItem): PaperItem {
  const r = db.prepare(`SELECT e.id, e.link, e.title, e.author, COALESCE(e.content_full, e.content) AS html, e.ai_summary AS summary, f.title AS feed, f.view,
      c.name AS cat, e.is_read FROM entry e JOIN feed f ON f.id = e.feed_id LEFT JOIN category c ON c.id = f.category_id
    WHERE e.id = ?`).get(item.id) as unknown as Row | undefined;
  const p = r && detectPaper({ title: r.title, feedTitle: r.feed, category: r.cat, view: r.view, html: r.html ?? '', author: r.author, summary: r.summary });
  return p ? { ...item, authors: p.authors || item.authors, venue: p.venue || item.venue, abstract: p.abstract || item.abstract, abstractBy: p.abstract ? p.abstractBy : item.abstractBy } : item;
}

// The fuller record wins: a journal's own listing, else the repost with an abstract and a venue.
const richness = (x: PaperItem): number => (x.via === 'journal' ? 4 : 0) + (x.abstract ? 2 : 0) + (x.venue ? 1 : 0) + (x.authors ? 1 : 0);

export function mergeReposts(items: PaperItem[]): PaperItem[] {
  const out: PaperItem[] = [];
  for (const it of items) {
    const twin = it.title.length >= MIN_TITLE_FOR_MATCH
      ? out.find((o) => o.title.length >= MIN_TITLE_FOR_MATCH && titleOverlap(o.title, it.title) >= SAME_PAPER) : undefined;
    if (!twin) { out.push(it); continue; }
    const [keep, drop] = richness(it) > richness(twin) ? [it, twin] : [twin, it];
    const merged: PaperItem = {
      ...keep,
      also: [...new Set([...keep.also, ...drop.also, drop.feed].filter((f) => f !== keep.feed))],
      interest: Math.max(keep.interest, drop.interest),
      read: keep.read || drop.read,
    };
    out[out.indexOf(twin)] = merged;
  }
  return out;
}

export function collectPapers(db: DB, index: VectorIndex, model: string, p: Period): PaperItem[] {
  const profile = currentProfile(db, index, model);
  const found: PaperItem[] = [];
  for (const r of rows(db, p)) {
    const paper = detectPaper({ title: r.title, feedTitle: r.feed, category: r.cat, view: r.view, html: r.html ?? '', author: r.author, summary: r.summary });
    if (!paper) continue;
    const v = index.get(model, r.id);
    const interest = v && !profile.coldStart ? interestOf(v, profile).value : 0;
    found.push({ ...paper, id: r.id, link: r.link, feed: r.feed, also: [], interest, read: !!r.is_read });
  }
  return mergeReposts(found).sort((a, b) => b.interest - a.interest);
}
