// A talk or a conference archived as one: into the vault's lecture or meeting folder, in the Lecture
// Note layout, from what 学术动态 read of the post (notices.ts) — no AI of its own. One event is one
// note: its 预告 makes it, and a 回顾 posted after (recaps.ts) is added to the same note rather than
// making another. 存档 decides by itself (auto): a post 学术动态 read as a 讲座 or a 会议 is archived
// so, anything else as an article; the reader can say which instead.
import type { DB } from '../db.ts';
import type { Settings, Secrets } from '../config.ts';
import { eventsOfPost, looksLikeNotice, noticeExtractor, type NoticeView, type Notice } from '../content/notices.ts';
import { readPostNow } from '../content/extract.ts';
import { speakerNames } from '../content/eventname.ts';
import { eventTime } from '../content/eventtime.ts';
import { log } from '../log.ts';
import { render, resolveClipPath, safeFilename, type ClipPage, type ClipResult } from './obsidian.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

export const CLIP_MODES = ['auto', 'article', 'lecture', 'meeting'] as const;
export type ClipMode = typeof CLIP_MODES[number];
export type EventKind = '讲座' | '会议';

const KIND_OF_MODE: Record<'lecture' | 'meeting', EventKind> = { lecture: '讲座', meeting: '会议' };
// 活动 (a book launch, a 沙龙) stays an article unless the reader says otherwise.
const AUTO_KINDS: Partial<Record<string, EventKind>> = { 讲座: '讲座', 会议: '会议' };
const MAX_EVENTS = 6;          // a 系列讲座 post: a note for each talk, up to this many
const TITLE_SPEAKERS = 2;

export interface EventPick { event: Notice & { replays?: NoticeView['replays']; post?: NoticeView['post'] }; role: 'own' | 'recap'; kind: EventKind }
interface Post { id: number; title: string; published: number }

// The events to archive this post as; none: archive it as an article.
export async function eventsToArchive(db: DB, post: Post, mode: ClipMode, settings: Settings, secrets: Secrets): Promise<EventPick[]> {
  if (mode === 'article') return [];
  let found = eventsOfPost(db, post.id);
  // Not read yet (a web page from the browser, a post the pass has not reached): read it now, if it
  // looks like a notice or the reader says it is one.
  if (!found.some((f) => f.role === 'own') && (mode !== 'auto' || looksLikeNotice(post.title))) {
    try {
      if (await readPostNow(db, noticeExtractor, post, settings, secrets) !== undefined) found = eventsOfPost(db, post.id);
    } catch (err) {
      log.warn(`[clip] 学术动态没读成 #${post.id}：${(err as Error).message}`);
    }
  }
  const forced = mode === 'auto' ? null : KIND_OF_MODE[mode];
  const kindOf = (n: Notice): EventKind | undefined => forced ?? AUTO_KINDS[n.kind];
  const own = found.filter((f) => f.role === 'own' && kindOf(f.view));
  const picked = own.length ? own : found.filter((f) => f.role === 'recap' && kindOf(f.view));
  if (picked.length) return picked.slice(0, MAX_EVENTS).map((f) => ({ event: f.view, role: f.role, kind: kindOf(f.view)! }));
  if (!forced) return [];
  // Said to be one, though nothing was read of it: the note starts from the post's title.
  return [{ event: { kind: forced, name: post.title, date: '', end: '', deadline: '', place: '', organizer: '', speakers: [], contact: '', summary: '', online: '', live: '' }, role: 'own', kind: forced }];
}

const day8 = (date: string, published: number): string => date ? date.replace(/-/g, '')
  : new Date(published * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const bareName = (name: string): string => name.replace(/^[“"「『]+|[”"」』]+$/g, '').trim();

// 主讲人｜题目（20261022）; a conference, or a talk with no speaker read, by its name alone.
export function eventTitle(speakers: string[], name: string, date: string, published: number): string {
  const who = speakers.length > TITLE_SPEAKERS ? `${speakers.slice(0, TITLE_SPEAKERS).join('、')}等` : speakers.join('、');
  return `${who ? `${who}｜` : ''}${bareName(name)}（${day8(date, published)}）`;
}

// The vault-relative path: the folder, the year it is held, the title.
export function eventPath(folder: string, title: string, date: string, published: number): string {
  return `${folder.replace(/[/\\]+$/, '')}/${day8(date, published).slice(0, 4)}/${safeFilename(title)}.md`;
}

const FIRST_PICTURE = /!\[[^\]]*\]\([^)]+\)|!\[\[[^\]]+\]\]/;

// The section the post gives the note: the whole post when it is about this one event, a few lines
// when it lists several, the write-up under its own heading when it is a 回顾.
export function eventSection(pick: EventPick, content: string, count: number, feed: string, postTitle: string): string {
  const n = pick.event;
  if (pick.role === 'recap') return `## 回顾｜${feed}\n\n${content}`;
  if (count === 1) return `## ${pick.kind}信息\n\n${content}`;
  const lines = [
    n.date && `- 时间：${n.date}${n.time ? ` ${n.time}` : ''}`, n.place && `- 地点：${n.place}`,
    n.speakers.length && `- 主讲：${n.speakers.join('、')}`, n.summary && `- 简介：${n.summary}`,
  ].filter(Boolean);
  return `## ${pick.kind}信息\n\n${lines.join('\n')}\n\n出自「${postTitle}」，这篇推文共 ${count} 场。`;
}

export interface EventNoteInput {
  pick: EventPick; count: number; base: ClipPage; content: string;
  postUrl: string; resolveSpeakers: (names: string[]) => { zh: string; link: string }[];
}

// The page an event note is rendered from: the article's page with the event's fields in.
export function eventPage(x: EventNoteInput): ClipPage {
  const n = x.pick.event;
  const speakers = x.resolveSpeakers(speakerNames(n));
  const preview = x.pick.role === 'recap' ? n.post?.link ?? '' : x.postUrl;
  const replay = n.replays?.[0];
  return {
    ...x.base,
    url: preview || x.postUrl,
    content: eventSection(x.pick, x.content, x.count, x.base.feed, x.base.title),
    selectedText: x.pick.role === 'own' && x.count === 1 ? x.base.selectedText : '',
    displayTitle: eventTitle(speakers.map((s) => s.zh), n.name, n.date, x.base.published),
    eventKind: x.pick.kind, eventDate: n.date, eventTime: n.time || (n.date ? eventTime(x.content, n.date) : ''), place: n.place, organizer: n.organizer,
    speakerLinks: speakers.map((s) => s.link).join(', '),
    poster: x.pick.role === 'own' && x.count === 1 ? FIRST_PICTURE.exec(x.content)?.[0] ?? '' : '',
    postLinks: [preview && `[预告](${preview})`, x.pick.role === 'recap' && `[回顾](${x.postUrl})`].filter(Boolean).join(' · '),
    replay: replay ? `[B站 · ${replay.author}](https://www.bilibili.com/video/${replay.bvid})` : '',
    eventSummary: n.summary,
  };
}

const NOTES = /^# Notes\s*$/m;

// A note this event already has gets the post added to it: its section before 「# Notes」, its link
// on the 公众号 line, a recording on an empty 录屏 line. A post already in it is not added twice.
export function addToNote(note: string, page: ClipPage, postUrl: string): string | null {
  if (postUrl && note.includes(postUrl)) return null;
  const link = page.postLinks.split(' · ').filter((l) => !note.includes(l.replace(/^\[[^\]]*\]/, ''))).join(' · ');
  let out = note.replace(/^(- 公众号::)(.*)$/m, (_, k: string, v: string) => {
    const all = [v.trim(), link].filter(Boolean).join(' · ');
    return all ? `${k} ${all}` : k;
  });
  if (page.replay) out = out.replace(/^(- 录屏::)\s*$/m, `$1 ${page.replay}`);
  const section = `${page.content}\n`;
  return NOTES.test(out) ? out.replace(NOTES, `${section}\n# Notes`) : `${out.trimEnd()}\n\n${section}`;
}

export function writeEventNote(vault: string, relPath: string, template: string, page: ClipPage, postUrl: string): ClipResult & { added: boolean } {
  const full = resolveClipPath(vault, relPath);
  const rel = relative(vault, full).replaceAll('\\', '/');
  if (!existsSync(full)) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, render(template, page), { encoding: 'utf8', flag: 'wx' });
    return { path: full, relPath: rel, existed: false, added: false };
  }
  const next = addToNote(readFileSync(full, 'utf8'), page, postUrl);
  if (next === null) return { path: full, relPath: rel, existed: true, added: false };
  writeFileSync(full, next, 'utf8');
  return { path: full, relPath: rel, existed: false, added: true };
}
