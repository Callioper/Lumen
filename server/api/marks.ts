// Douban "想读 / 看过 …" statuses grouped by the book, film or record they mark, so a
// subject five people marked reads as one card instead of five timeline rows.
import type { DB } from '../db.ts';
import { tx } from '../db.ts';
import { plainText } from '../content/sanitize.ts';
import { wishedSubjects, ownMarks } from '../content/douban.ts';

// 收藏到 is a subject saved into a 豆列: counted as a mark, it means "keeping this one" (2026-10-22).
export const MARK_ACTIONS = ['想读', '在读', '读过', '想看', '在看', '看过', '想听', '在听', '听过', '想玩', '在玩', '玩过', '收藏到'] as const;
// "某人 读过: 《书名》 评语" — the closing bracket may be lost when RSSHub truncates the title.
// Games are quoted 「」 instead of 《》.
const MARK_TITLE = new RegExp(`^(.+?) (${MARK_ACTIONS.join('|')}): [《「](.+?)(?:[》」]\\s*(.*))?$`, 's');
// A game links www.douban.com/game/<id>, everything else <kind>.douban.com/subject/<id>.
const SUBJECT_LINK = /https:\/\/(book|movie|music|www)\.douban\.com\/(?:subject|(game))\/(\d+)/;
const COVER = /<img[^>]+src="([^"]+)"/;
// Read marks older than this drop out of the "all" listing; unread ones always show.
export const MARKS_WINDOW_DAYS = 30;
const MAX_GROUPS = 300;

const IS_DOUBAN = "f.url LIKE 'rsshub://douban/people/%'";
const titled = (open: string): string => MARK_ACTIONS.map((a) => `e.title LIKE '% ${a}: ${open}%'`).join(' OR ');
// 「」 also quotes diaries and topics (收藏到: 「某篇日记」), so it only counts beside a subject or game link.
const LINKS_SUBJECT = "(e.content LIKE '%.douban.com/subject/%' OR e.content LIKE '%douban.com/game/%')";
const IS_MARK = `(${titled('《')} OR ((${titled('「')}) AND ${LINKS_SUBJECT}))`;
export const MARK_WHERE = `${IS_DOUBAN} AND ${IS_MARK}`;

export interface Mark { id: number; who: string; action: string; comment: string; published: number; is_read: number; link: string | null }
export interface MarkGroup {
  key: string; kind: 'book' | 'movie' | 'music' | 'game' | 'other'; title: string; url: string | null;
  cover: string | null; info: string; people: number; unread: number; latest: number; marks: Mark[];
  subject: string | null;   // the 豆瓣 subject id, null for a mark without a subject link
  wished: boolean;          // marked 想读 / 想看 from Lumen
}

export function parseMarkTitle(title: string): { who: string; action: string; subject: string; comment: string } | null {
  const m = MARK_TITLE.exec(title);
  return m ? { who: m[1].trim(), action: m[2], subject: m[3].trim(), comment: (m[4] ?? '').trim() } : null;
}

const kindOf = (host: string, game: string | undefined): MarkGroup['kind'] =>
  game ? 'game' : host === 'book' || host === 'movie' || host === 'music' ? host : 'other';

// The content is the comment, then the subject card: cover, bold title, "作者 / 年份 / 出版社", rating.
// Titles are cut short by RSSHub; the full comment is the text ahead of the card.
const fullComment = (content: string, fallback: string): string => plainText(content.split(/<img|<a\s/i)[0]) || fallback;

function subjectInfo(content: string): string {
  const card = content.split(/<\/strong>\s*<\/a>/i)[1] ?? '';
  return card.split(/<br\s*\/?>/i).map((l) => plainText(l)).filter((l) => l && l !== '评分：0').slice(0, 2).join(' · ');
}

interface Row { id: number; title: string; content: string; published: number; is_read: number; link: string | null }

export function listMarks(db: DB, opts: { unreadOnly: boolean; now?: number }): MarkGroup[] {
  const since = (opts.now ?? Math.floor(Date.now() / 1000)) - MARKS_WINDOW_DAYS * 86400;
  const rows = db.prepare(`SELECT e.id, e.title, substr(COALESCE(e.content, ''), 1, 2000) AS content, e.published, e.is_read, e.link
    FROM entry e JOIN feed f ON f.id = e.feed_id WHERE ${MARK_WHERE} AND (e.is_read = 0 OR e.published > ?)
    ORDER BY e.published DESC`).all(since) as unknown as Row[];
  const groups = new Map<string, MarkGroup>();
  for (const r of rows) {
    const p = parseMarkTitle(r.title);
    if (!p) continue;
    const sub = SUBJECT_LINK.exec(r.content);
    const key = sub ? `${kindOf(sub[1], sub[2])}:${sub[3]}` : `title:${p.subject}`;
    const g = groups.get(key) ?? {
      key, kind: sub ? kindOf(sub[1], sub[2]) : 'other', title: p.subject, url: sub?.[0] ?? null,
      cover: COVER.exec(r.content)?.[1] ?? null, info: subjectInfo(r.content), people: 0, unread: 0, latest: 0, marks: [],
      subject: sub?.[3] ?? null, wished: false,
    };
    g.marks.push({ id: r.id, who: p.who, action: p.action, comment: fullComment(r.content, p.comment), published: r.published, is_read: r.is_read, link: r.link });
    g.unread += r.is_read ? 0 : 1;
    g.latest = Math.max(g.latest, r.published);
    groups.set(key, g);
  }
  const wished = wishedSubjects(db, [...groups.values()].flatMap((g) => (g.subject ? [g.subject] : [])));
  // Marked on the reader's own 豆瓣 counts too: 想读 is then not offered again.
  const own = ownMarks(db);
  const withWish = [...groups.values()].map((g) => ({ ...g, wished: !!g.subject && (wished.has(g.subject) || own.has(g.subject)) }));
  const out = mergeEditions(db, withWish).map((g) => ({ ...g, people: new Set(g.marks.map((m) => m.who)).size }));
  return out.filter((g) => !opts.unreadOnly || g.unread > 0)
    .sort((a, b) => b.people - a.people || b.latest - a.latest).slice(0, MAX_GROUPS);
}

// Two editions of one book are one card. Which work a subject belongs to is known only for books
// whose 其他版本 were looked up (douban_subject.works), so cards join as that fills in; nothing is
// fetched here. The card keeps the edition most people marked.
// A damaged cache row must not take the marks page (and the weekly report) down with it.
function editionList(json: string): { subject: string }[] {
  try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? (v as { subject: string }[]) : []; } catch { return []; }
}

function mergeEditions(db: DB, groups: MarkGroup[]): MarkGroup[] {
  const books = groups.filter((g) => g.kind === 'book' && g.subject);
  if (books.length < 2) return groups;
  const works = new Map((db.prepare(`SELECT subject, works FROM douban_subject WHERE works IS NOT NULL AND subject IN (${books.map(() => '?').join(', ')})`)
    .all(...books.map((g) => g.subject!)) as { subject: string; works: string }[]).map((r) => [r.subject, r.works]));
  // Every edition the looked-up pages listed, so a card whose own page was never opened still joins.
  const listed = db.prepare(`SELECT works, editions FROM douban_subject WHERE works IS NOT NULL AND editions IS NOT NULL`).all() as { works: string; editions: string }[];
  for (const r of listed) for (const e of editionList(r.editions)) if (!works.has(e.subject)) works.set(e.subject, r.works);
  const byWork = new Map<string, MarkGroup>();
  const out: MarkGroup[] = [];
  for (const g of [...groups].sort((a, b) => b.marks.length - a.marks.length)) {
    const w = g.kind === 'book' && g.subject ? works.get(g.subject) : undefined;
    const into = w ? byWork.get(w) : undefined;
    if (!into) { if (w) byWork.set(w, g); out.push(g); continue; }
    into.marks = [...into.marks, ...g.marks].sort((a, b) => b.published - a.published);
    into.unread += g.unread;
    into.latest = Math.max(into.latest, g.latest);
    into.wished ||= g.wished;
  }
  return out;
}

export function unreadMarks(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM entry e JOIN feed f ON f.id = e.feed_id WHERE ${MARK_WHERE} AND e.is_read = 0`).get() as { n: number }).n;
}

// Ids grow with arrival, so upTo keeps marks that arrived after the list was loaded unread.
export function markMarksRead(db: DB, upTo = Number.MAX_SAFE_INTEGER, now = Math.floor(Date.now() / 1000)): number {
  return tx(db, () => Number(db.prepare(`UPDATE entry SET is_read = 1, read_at = ? WHERE id IN
    (SELECT e.id FROM entry e JOIN feed f ON f.id = e.feed_id WHERE ${MARK_WHERE} AND e.is_read = 0 AND e.id <= ?)`).run(now, upTo).changes));
}

// 友邻标记 under an article: the Douban subjects it links to, each with who among the followed
// people marked it and what they said. Looked up in the local library only, no request goes out.
const LINKED_SUBJECT = /(book|movie|music)\.douban\.com\/subject\/(\d+)/g;
const SUBJECTS_LOOKED_UP = 20;
export interface SubjectMarks { kind: MarkGroup['kind']; id: string; title: string; url: string; cover: string | null; info: string; marks: Mark[]; wished: boolean }

export function linkedSubjects(html: string, link: string | null): { kind: string; id: string }[] {
  const seen = new Map<string, string>();
  for (const m of `${link ?? ''} ${html}`.matchAll(LINKED_SUBJECT)) if (!seen.has(m[2])) seen.set(m[2], m[1]);
  return [...seen].slice(0, SUBJECTS_LOOKED_UP).map(([id, kind]) => ({ kind, id }));
}

export function friendsMarks(db: DB, entryId: number): SubjectMarks[] {
  const e = db.prepare('SELECT link, COALESCE(content_full, content) AS html FROM entry WHERE id = ?').get(entryId) as { link: string | null; html: string | null } | undefined;
  if (!e) return [];
  const find = db.prepare(`SELECT e.id, e.title, substr(COALESCE(e.content, ''), 1, 2000) AS content, e.published, e.is_read, e.link
    FROM entry e JOIN feed f ON f.id = e.feed_id WHERE ${MARK_WHERE} AND e.id != ? AND e.content LIKE ? ORDER BY e.published DESC`);
  const linked = linkedSubjects(e.html ?? '', e.link);
  const wished = wishedSubjects(db, linked.map((l) => l.id));
  return linked.flatMap(({ kind, id }): SubjectMarks[] => {
    // A mark is about the first subject it links; that also keeps 「subject/123」 from finding 「subject/1234」.
    const rows = (find.all(entryId, `%douban.com/subject/${id}%`) as unknown as Row[])
      .filter((r) => SUBJECT_LINK.exec(r.content)?.[3] === id);
    const parsed = rows.map((r) => ({ r, p: parseMarkTitle(r.title) })).filter((x) => x.p);
    if (!parsed.length) return [];
    const first = parsed[0];
    return [{
      kind: kindOf(kind, undefined), id, title: first.p!.subject, url: `https://${kind}.douban.com/subject/${id}/`,
      cover: COVER.exec(first.r.content)?.[1] ?? null, info: subjectInfo(first.r.content),
      marks: parsed.map(({ r, p }) => ({ id: r.id, who: p!.who, action: p!.action, comment: fullComment(r.content, p!.comment), published: r.published, is_read: r.is_read, link: r.link })),
      wished: wished.has(id),
    }];
  });
}
