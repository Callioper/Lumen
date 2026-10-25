// 学术动态: the conferences, calls for papers, talks, jobs and calls for applications the academic
// accounts post, read by the AI (extract.ts) into one item each (a post that rounds up fifteen
// conferences gives fifteen). A conference posted by two accounts, or in a first and a second
// notice, shows once; what is still to come is listed nearest first.
import type { DB } from '../db.ts';
import type { Settings } from '../config.ts';
import type { ChatMessage } from '../ai/llm.ts';
import { extracted, postLines, str, strs, type Extractor, type Post } from './extract.ts';
import { canOcr, ocrImages, postImages } from './ocr.ts';
import { log } from '../log.ts';
import { liveAccess, type LiveAccess } from './liveaccess.ts';
import { MARK_WHERE } from '../api/marks.ts';

export const NOTICE_KINDS = ['会议', '征稿', '讲座', '招聘', '申报', '征集', '活动'] as const;
export type NoticeKind = typeof NOTICE_KINDS[number];

// online: whether it can be followed from afar, '' when only in person or not said; live: where
// (「B站 远川」「腾讯会议 123 456 789」), '' when not said.
export const ONLINE = ['线上', '线上线下'] as const;
export type Online = '' | typeof ONLINE[number];
export interface Notice {
  kind: NoticeKind; name: string; date: string; end: string; deadline: string;
  place: string; organizer: string; speakers: string[]; contact: string; summary: string;
  online: Online; live: string;
}

// 2: online and live (2026-10-24). Posts read by 1 still show, without them, until read again.
export const NOTICE_VERSION = 3;
const OPEN_FOR_DAYS = 120;
const TITLE_HINTS = ['征稿', '征文', '会议', '论坛', '讲座', '工作坊', '研讨', '通知', '启事', '征集', '招聘', '招生', '申报', '预告', '年会', '读书会',
  '研修班', '讲习班', '夏令营', '暑期学校', '邀请函', '议程', 'call for', 'cfp',
  // A bookshop's or a publisher's talk: 「董树宝 x 汪民安：百年诞辰，听见福柯 | PAGEONE五道口」 says only who meets whom.
  '对谈', '分享会', '沙龙', '发布会', '直播预告', ' x ', ' × '];
// A 豆瓣 or 微博 post has no title to go by: 「周末会去上海参加《社会》组织的社会理论工作坊……欢迎来我们的
// panel」 is titled 「卖菜与跳舞，是我们这个时代的大业」. Its text is looked in instead (2026-10-24).
const BODY_HINTS = ['工作坊', '研讨会', '学术会议', '论坛', '讲座', '征稿', '征文', 'panel', '年会', '报告会', '读书会', '对谈', '分享会', '沙龙'];
// Said in the title to be over: no need to ask.
const OVER = /回顾|纪实|综述|致辞|笔记|成功举办|顺利举办|圆满|侧记|发言稿|实录|闭幕/;

const SYSTEM = '你从学术公众号推文里抽取会议、征稿、讲座等学术动态，只输出 JSON，不加说明。';
const prompt = (title: string, published: string, text: string): string => `推文标题：${title}
推文发布日期：${published}

判断这篇推文是不是在预告或征集一件尚待参加、投稿或申请的学术事项，并抽成 JSON：
{"items":[{"kind":"会议|征稿|讲座|招聘|申报|征集|活动","name":"事项名称，会议或讲座的题目，期刊征稿写刊名","date":"举办日期，YYYY-MM-DD，多天写起始日，没有则空","end":"结束日期，YYYY-MM-DD，单日或没有则空","deadline":"截止日期（截稿、报名、提交摘要、申请），YYYY-MM-DD，没有则空","place":"地点，线上写线上","organizer":"主办方","speakers":["主讲人，讲座才填"],"contact":"投稿或报名邮箱、链接，没有则空","summary":"一句话说明主题或要求，不超过60字","online":"线上|线上线下|空","live":"直播或线上参会的平台与入口，照抄推文里的会议号、密码、报名或直播链接、直播账号名，如「腾讯会议 123 456 789 密码 1234」「B站 远川」「视频号 澎湃新闻」；推文只写了平台就只写平台，不要编；没有则空"}]}
规则：
- 会议的一号、二号通知、征稿通知、会议议程都算「会议」；期刊、集刊、征文比赛的征稿算「征稿」；课题、项目、奖项申报算「申报」；成果、案例、选题征集算「征集」。
- 已经开过的会议、讲座的回顾、纪实、综述、致辞、笔记、发言稿不算，新闻报道不算：输出 {"items":[]}。
- 一篇推文汇总了多场会议时逐场列出。
- 日期缺年份时按推文发布日期推断；「周末」「下周三」「明天」这类说法按推文发布日期推算成具体日期。
- 个人动态（豆瓣、微博）里说自己要去参加、要作报告的会议、工作坊也算，名称写会议本身（如「《社会》社会理论工作坊」）；只是回忆、感想、读后感的不算。
- name 用中文：推文同时给出中文名和外文名时写中文名（如「文革时期的地下美术」，不写「Underground Art in the Cultural Revolution」）；只有外文名时照原文写，不要自己翻译。
- online 只看这件事本身能不能远程参加或观看：只在线上办写「线上」，现场之外另有直播或线上参会写「线上线下」，只在现场或没说写空。「在线投稿」「在线填报」「线上评选」「不设直播」都不算线上。

推文正文：
${text}`;

// An article titled as a notice (LIKE ignores ASCII case, so CFP is cfp), or a post that speaks of
// one (豆瓣's 想读 / 看过 marks aside), and not said to be over.
function candidates(db: DB, since: number): Post[] {
  const like = (col: string, words: readonly string[]): string => words.map(() => `${col} LIKE ?`).join(' OR ');
  const args = (words: readonly string[]): string[] => words.map((w) => `%${w}%`);
  return (db.prepare(`SELECT e.id, e.title, e.published FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.published > ? AND (
      (f.view = 'article' AND (${like('e.title', TITLE_HINTS)}))
      OR (f.view = 'social' AND NOT (${MARK_WHERE}) AND (${like('COALESCE(e.content_full, e.content)', BODY_HINTS)})))`)
    .all(since, ...args(TITLE_HINTS), ...args(BODY_HINTS)) as unknown as Post[]).filter((r) => !OVER.test(r.title));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string => (DAY.test(str(v)) ? str(v) : '');

function readNotices(raw: unknown): Notice[] | null {
  const items = (raw as { items?: unknown })?.items;
  const out = (Array.isArray(items) ? items : []).map((it): Notice | null => {
    const r = (it ?? {}) as Record<string, unknown>;
    const name = str(r.name);
    if (!name) return null;
    const kind = (NOTICE_KINDS as readonly string[]).includes(str(r.kind)) ? str(r.kind) as NoticeKind : '活动';
    const date = day(r.date);
    const end = day(r.end) > date ? day(r.end) : '';
    return { kind, name, date, end, deadline: day(r.deadline), place: str(r.place), organizer: str(r.organizer),
      speakers: kind === '讲座' ? strs(r.speakers) : [], contact: str(r.contact), summary: str(r.summary),
      online: (ONLINE as readonly string[]).includes(str(r.online)) ? str(r.online) as Online : '', live: str(r.live) };
  }).filter((n): n is Notice => !!n);
  return out.length ? out : null;
}

// A talk posted as its poster alone: 「【讲座预告】Ada Morrow | Women Filmmakers in Harbor Cities」
// (one events account, 2026-10-24) has a dateline and two pictures, its date and room only in them. A post
// with this little text of its own is read with what its pictures say (ocr.ts).
const THIN_TEXT = 200;
async function text(html: string, settings: Settings): Promise<string> {
  const own = postLines(html).join('\n');
  const images = postImages(html);
  if (own.replace(/\s/g, '').length >= THIN_TEXT || !images.length || !canOcr()) return own;
  try {
    const read = (await ocrImages(images, settings)).filter((lines) => lines.length);
    return [own, ...read.map((lines, i) => `【图${i + 1}】\n${lines.join('\n')}`)].filter(Boolean).join('\n');
  } catch (e) {
    log.warn(`[学术动态] OCR 没跑成，只读推文文字：${(e as Error).message}`);
    return own;
  }
}

export const noticeExtractor: Extractor<Notice[]> = {
  kind: 'notice', label: '学术动态', version: NOTICE_VERSION, maxTokens: 6000,
  candidates, text,
  ask: (post, text): ChatMessage[] => [{ role: 'system', content: SYSTEM },
    { role: 'user', content: prompt(post.title, localDay(new Date(post.published * 1000)), text) }],
  read: (raw) => readNotices(raw),
};

// recorded: over, but a recording went up on B站 lately (replays.ts); shown with what is to come.
export type NoticeStatus = 'upcoming' | 'open' | 'recorded' | 'past';
export interface Replay { bvid: string; title: string; author: string; at: number; minutes: number }
export interface NoticeView extends Notice {
  status: NoticeStatus;
  access?: LiveAccess;               // how to get in, for what can be followed online and is still to come
  replays: Replay[];
  next: { what: '截止' | '举办' | '进行中'; date: string } | null;     // 进行中: date is when it ends
  post: { id: number; title: string; feedId: number; feed: string; published: number; link: string | null };
  posts: number;
}
export interface Count { label: string; n: number }

// 「……学术研讨会（二号通知）」 and 「……学术研讨会邀请函」 are the same conference, and 「白川作品对谈（远川讲座
// 第64讲）」 the same talk; a journal's call is the journal's, whatever year it asks for.
const NOTICE_WORDS = /[（(][^）)]*[）)]|(?:[一二三四五六七八九十\d]+[号轮])?(?:通知|邀请函|会议议程|征稿启事|征稿)$/g;
const JOURNAL = /《([^》]+)》/;
export const noticeKey = (n: Notice): string =>
  ((n.kind === '征稿' && JOURNAL.exec(n.name)?.[1]) || n.name).replace(NOTICE_WORDS, '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
// 「第三十三届中外传记文学研究年会」 and the same with its theme after a colon: one name holds the other.
const MIN_HELD = 10;
const sameName = (a: string, b: string): boolean => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= MIN_HELD && (a.includes(b) || b.includes(a))));
// …and on the same days: the 上海站 and 成都站 of a forum, the 64th and 65th talk of a series, are not
// one. A second notice often moves the deadline of the same conference, so where it has days of its own
// only those count; a journal's special issue and its standing call differ by their deadlines alone.
const differ = (a: string, b: string): boolean => !!a && !!b && a !== b;
// A roundup shortens a long name in the middle (「第八届……联盟年会暨外语学科……」): on the same day,
// a long enough shared beginning will do. A conference's call for papers is the conference.
const SHARED_START = 12;
const sharedStart = (a: string, b: string): number => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
const MEETING = new Set<NoticeKind>(['会议', '征稿']);
// Three accounts call one talk 「一生所念」, 「一生所念：林舟、苏禾、江屿对谈」 and 「“一生所念”——……（远川讲座
// 第58讲）」: on the same day, two speakers in common make it one.
const SHARED_SPEAKERS = 2;
const sameSpeakers = (a: Notice, b: Notice): boolean => a.speakers.filter((s) => b.speakers.includes(s)).length >= SHARED_SPEAKERS;
// A forwarded post names it its own way (「《社会》组织的社会理论工作坊」, 「《社会》社会理论工作坊」): one
// organiser holding one kind of event in one city on one day holds one.
const sameHost = (a: Notice, b: Notice): boolean => !!a.organizer && a.organizer === b.organizer && !!a.place && a.place === b.place;
const sameEvent = (a: Notice, b: Notice): boolean => {
  if (a.kind === b.kind && !!a.date && a.date === b.date && (sameSpeakers(a, b) || sameHost(a, b))) return true;
  if (a.kind !== b.kind && !(MEETING.has(a.kind) && MEETING.has(b.kind) && (a.date || b.date))) return false;
  const [ka, kb] = [noticeKey(a), noticeKey(b)];
  const named = sameName(ka, kb) || (!!a.date && a.date === b.date && sharedStart(ka, kb) >= SHARED_START);
  return named && (a.date || b.date ? !differ(a.date, b.date) : !differ(a.deadline, b.deadline));
};

// What comes next: the deadline while it is ahead, else the event while it is.
function nextOf(n: Notice, today: string): NoticeView['next'] {
  if (n.deadline && n.deadline >= today) return { what: '截止', date: n.deadline };
  if (n.date && n.date >= today) return { what: '举办', date: n.date };
  if (n.date && n.end >= today) return { what: '进行中', date: n.end };
  return null;
}

// Two copies of one event: the fuller one (more of its fields filled) gives the name and the rest, the
// other fills its gaps — 「AI、哲学与艺术NO.17：机器人」 with no speakers gives way to the copy naming five.
const filled = (n: Notice, keys: (keyof Notice)[]): number => keys.filter((k) => (Array.isArray(n[k]) ? (n[k] as string[]).length : n[k])).length;
const merged = (x: Notice, y: Notice): Notice => {
  const keys = Object.keys(y) as (keyof Notice)[];          // y is a copy as read, with only a notice's fields
  const [a, b] = filled(y, keys) > filled(x, keys) ? [y, x] : [x, y];
  const out = { ...a };
  for (const k of Object.keys(a) as (keyof Notice)[]) {
    const empty = Array.isArray(out[k]) ? !(out[k] as string[]).length : !out[k];
    if (empty) (out as Record<string, unknown>)[k] = b[k];
  }
  // The copy that names the accounts says more than one saying only 「B站」 (一生所念, 2026-10-20: four posts).
  if (b.live.length > out.live.length) out.live = b.live;
  return out;
};

// An event is looked for on B站 by its name and day (replays.ts keeps what was found under this).
export const replayKey = (n: Notice): string => `${noticeKey(n)}|${n.date}`;
const RECORDED_FOR_DAYS = 30;

function storedReplays(db: DB): Map<string, Replay[]> {
  const rows = db.prepare('SELECT key, found FROM replay WHERE found IS NOT NULL').all() as { key: string; found: string }[];
  return new Map(rows.flatMap((r) => { try { return [[r.key, JSON.parse(r.found) as Replay[]]]; } catch { return []; } }));
}

export const localDay = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

// The page: narrowed to a kind, or to what can be followed online, with what is over left out
// unless asked for.
export function academicNotices(db: DB, opts: { kind: string; past: boolean; online?: boolean; now?: Date }):
  { items: NoticeView[]; kinds: Count[]; past: number; online: number } {
  const now = opts.now ?? new Date();
  const today = localDay(now);
  const staleBefore = Math.floor(now.getTime() / 1000) - OPEN_FOR_DAYS * 86_400;
  const recordedSince = localDay(new Date(now.getTime() - RECORDED_FOR_DAYS * 86_400_000));
  const replays = storedReplays(db);
  const byKey = new Map<string, NoticeView>();
  // Every post an event was read from: the way in is looked for in all of them.
  const postsOf = new Map<NoticeView, number[]>();
  for (const { data, post } of extracted<Notice[]>(db, 'notice', NOTICE_VERSION)) {
    for (const read of data) {
      const n: Notice = { ...read, online: read.online ?? '', live: read.live ?? '' };     // read by version 1
      const k = [...byKey.keys()].find((key) => sameEvent(byKey.get(key)!, n)) ?? `${post.id}:${byKey.size}`;
      const had = byKey.get(k);
      // Newest post first: a later notice of the same conference fills in what the first left out.
      if (had) {
        const v = { ...had, ...merged(had, n), posts: had.post.id === post.id ? had.posts : had.posts + 1 };
        const ids = postsOf.get(had)!;
        postsOf.delete(had);
        postsOf.set(v, ids.includes(post.id) ? ids : [...ids, post.id]);
        byKey.set(k, v);
        continue;
      }
      const v: NoticeView = { ...n, status: 'open', next: null, replays: [], post, posts: 1 };
      postsOf.set(v, [post.id]);
      byKey.set(k, v);
    }
  }
  const all = [...byKey.values()].map((v) => {
    const ids = postsOf.get(v) ?? [v.post.id];
    const next = nextOf(v, today);
    // An undated call stays open a while; one posted months ago is likely closed.
    const dated = !!(v.date || v.deadline) || v.post.published < staleBefore;
    const found = replays.get(replayKey(v)) ?? [];
    const recorded = !next && found.length > 0 && (v.end || v.date) >= recordedSince;
    const out: NoticeView = { ...v, next, replays: found, status: (next ? 'upcoming' : recorded ? 'recorded' : dated ? 'past' : 'open') as NoticeStatus };
    postsOf.set(out, ids);
    return out;
  });
  const rank: Record<NoticeStatus, number> = { upcoming: 0, open: 1, recorded: 2, past: 3 };
  const when = (v: NoticeView): string => (v.next!.what === '进行中' ? today : v.next!.date);     // what is on now first
  all.sort((a, b) => rank[a.status] - rank[b.status]
    || (a.status === 'upcoming' ? when(a).localeCompare(when(b)) : b.post.published - a.post.published));
  const shown = opts.past ? all : all.filter((v) => v.status !== 'past');
  const counts = new Map<string, number>();
  for (const v of shown) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
  const kinds = NOTICE_KINDS.filter((k) => counts.has(k)).map((k) => ({ label: k, n: counts.get(k)! }));
  // What can still be followed from afar: 线上 and 直播 are worth knowing only before the day.
  const remote = (v: NoticeView): boolean => !!v.online && v.status === 'upcoming';
  const body = db.prepare('SELECT COALESCE(content_full, content) AS html FROM entry WHERE id = ?');
  const withAccess = (v: NoticeView): NoticeView => {
    if (!remote(v)) return v;
    const text = (postsOf.get(v) ?? [v.post.id])
      .map((id) => postLines((body.get(id) as { html: string | null } | undefined)?.html ?? '').join('\n')).join('\n');
    return { ...v, access: liveAccess(text, v.live, v.organizer) };
  };
  const items = shown.filter((v) => (!opts.kind || v.kind === opts.kind) && (!opts.online || remote(v))).map(withAccess);
  return { items, kinds, past: all.length - shown.length, online: shown.filter(remote).length };
}
