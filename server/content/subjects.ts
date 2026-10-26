// The 豆瓣 book or film an entry is about, when its link is that subject's page (豆瓣's new-book picks, the
// monthly chart, one's own interests, 定档推荐): the list and the reader then offer 想读 / 想看 on it,
// as 新书, 标记 and 书影榜 do, and say when it is marked already.
import type { DB } from '../db.ts';
import { wishedSubjects, ownMarks } from './douban.ts';

// mine: the reader's own mark on 豆瓣 (读过, 想看 …), from their interests feed.
export interface EntrySubject { kind: 'book' | 'movie'; subject: string; wished: boolean; mine: string | null }

const SUBJECT_LINK = /^https?:\/\/(book|movie)\.douban\.com\/subject\/(\d{1,12})(?:[/?#]|$)/;
// The chart links the app's dispatch page: www.douban.com/doubanapp/dispatch/book/<subject>.
const DISPATCH_LINK = /^https?:\/\/www\.douban\.com\/doubanapp\/dispatch\/(book|movie)\/(\d{1,12})(?:[/?#]|$)/;

export function subjectOfLink(link: string | null | undefined): { kind: 'book' | 'movie'; subject: string } | null {
  const m = link ? SUBJECT_LINK.exec(link) ?? DISPATCH_LINK.exec(link) : null;
  return m ? { kind: m[1] as 'book' | 'movie', subject: m[2] } : null;
}

// The items with their subject as `douban`, left off where the link is not one.
export function withSubjects<T extends { link: string | null }>(db: DB, items: T[]): (T & { douban?: EntrySubject })[] {
  const found = items.map((it) => subjectOfLink(it.link));
  if (!found.some(Boolean)) return items;
  const subjects = [...new Set(found.flatMap((f) => (f ? [f.subject] : [])))];
  const wished = wishedSubjects(db, subjects);
  const own = ownMarks(db);
  return items.map((it, i) => {
    const f = found[i];
    return f ? { ...it, douban: { ...f, wished: wished.has(f.subject), mine: own.get(f.subject) ?? null } } : it;
  });
}
