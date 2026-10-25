// 新书 by kind and by subject, both in 豆瓣读书's own words. Kind: 虚构 / 非虚构 / 学术 / 童书 / 其他,
// the split 豆瓣's 新书速递 makes (虚构类, 非虚构类) with 学术 taken out of 非虚构, since most of these
// 书单 are academic. Subject (主题): one of the tags 豆瓣读书 files books under (book.douban.com/tag:
// 小说, 哲学, 历史, 社会学 …), narrowed to the fields these 书单 cover. 豆瓣 itself cannot be asked: a
// book weeks old has no member tags yet (rexxar answers tags: [] for all of them, tried 2026-10-24),
// and 新书速递's own split covers only its hundred books. So the AI reads title, author, publisher and
// blurb, a batch at a time, and both are kept in book_kind; a book is never asked about twice.
// The subject was voted by the library's own tags before (booktopics.ts, gone 2026-10-24): a children's
// bird guide came out 哲学, a story collection 科幻研究.
import type { DB } from '../db.ts';
import type { Settings, Secrets } from '../config.ts';
import type { ListedBook } from './books.ts';
import { chat } from '../ai/llm.ts';
import { modelBody } from '../ai/translate.ts';
import { log } from '../log.ts';

export const BOOK_KINDS = ['虚构', '非虚构', '学术', '童书', '其他'] as const;
export type BookKind = typeof BOOK_KINDS[number];
export const BOOK_TOPICS = ['小说', '诗歌', '散文随笔', '文学研究', '哲学', '历史', '社会学', '人类学', '政治', '经济', '心理学',
  '传记', '艺术', '电影', '宗教', '文化研究', '媒介研究', '科普', '教育', '女性主义', '其他'] as const;
export const OTHER_TOPIC = '其他';
const BATCH = 30;
const BLURB_CHARS = 160;
const MAX_TOKENS = 3072;
const TIMEOUT_MS = 180_000;
const RETRY_AFTER_MS = 10 * 60_000;

const SYSTEM = '你是图书编辑，按豆瓣读书的习惯给新书归类，只输出 JSON。';
const prompt = (lines: string): string => `给下面每本书定一个类型和一个主题。
类型只能是这五个之一：
- 虚构：小说、诗歌、戏剧、故事集（含科幻、推理、奇幻、网络小说）
- 非虚构：写给一般读者的纪实、传记、回忆录、随笔散文、书信日记、大众历史、科普、心理自助、社会观察
- 学术：学者写给学界的专著、论文集、学术译著、理论或思想经典、研究性的文学与艺术批评
- 童书：写给孩子的绘本、图鉴、儿童文学与儿童科普
- 其他：画册图录、工具书、教材教辅、实用指南
拿不准时：作者是学者、出版社是大学或社科类出版社、简介讲研究和理论的归学术；讲故事和人物命运、写给大众的归非虚构。
主题用豆瓣读书的标签，只能是这些之一：${BOOK_TOPICS.join('、')}。
主题按书讲的是什么定，不按体裁：研究小说、诗歌、文学理论、比较文学、翻译的书是「文学研究」，小说本身是「小说」；讲电影的是「电影」，讲美术、音乐、建筑、设计的是「艺术」；传播、媒介、技术与社会的是「媒介研究」；都不合适才用「其他」。
输出 {"1":{"kind":"类型","topic":"主题"},"2":…}，编号与下面一致，不加说明。

${lines}`;

const line = (b: ListedBook, i: number): string =>
  `${i + 1}. 《${b.title}》 ${b.authors} ｜ ${b.publisher} ｜ ${b.blurb.replace(/\s+/g, ' ').slice(0, BLURB_CHARS)}`;

export interface Sorted { kind: BookKind; topic: string }
const isKind = (v: string): v is BookKind => (BOOK_KINDS as readonly string[]).includes(v);

// The JSON answer read into a kind and a subject per book: null where the kind is none of the five;
// a subject not on the list counts as 其他.
export function readSorted(out: string, n: number): (Sorted | null)[] {
  const json = /\{[\s\S]*\}/.exec(out)?.[0] ?? '{}';
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(json) as Record<string, unknown>; } catch { /* nothing read: all null */ }
  return Array.from({ length: n }, (_, i) => {
    const v = (raw[String(i + 1)] ?? {}) as Record<string, unknown>;
    const kind = String(v.kind ?? '').trim();
    const topic = String(v.topic ?? '').trim();
    if (!isKind(kind)) return null;
    return { kind, topic: (BOOK_TOPICS as readonly string[]).includes(topic) ? topic : OTHER_TOPIC };
  });
}

// The books sorted so far; one sorted by kind alone (before 主题 was asked too) is not counted.
export function sortedOf(db: DB, keys: readonly string[]): Map<string, Sorted> {
  const want = new Set(keys);
  const rows = db.prepare('SELECT key, kind, topic FROM book_kind WHERE topic IS NOT NULL').all() as { key: string; kind: BookKind; topic: string }[];
  return new Map(rows.filter((r) => want.has(r.key)).map((r) => [r.key, { kind: r.kind, topic: r.topic }]));
}

let running: Promise<number> | null = null;
let failedAt = 0;

export function canSortKinds(settings: Settings, secrets: Secrets, now = Date.now()): boolean {
  return !!settings.ai.baseUrl && !!secrets.aiApiKey && (!!running || now - failedAt >= RETRY_AFTER_MS);
}

type Ask = (prompt: string) => Promise<string>;

// The books not sorted yet, a batch per request; one pass at once. The number sorted.
export function sortKinds(db: DB, books: readonly { key: string; b: ListedBook }[], settings: Settings, secrets: Secrets,
  ask: Ask = (p) => chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: p }], settings, secrets.aiApiKey, MAX_TOKENS, TIMEOUT_MS, modelBody(settings.translate.model))): Promise<number> {
  if (running) return running;
  if (!canSortKinds(settings, secrets)) return Promise.resolve(0);
  const known = sortedOf(db, books.map((x) => x.key));
  const todo = books.filter((x) => !known.has(x.key));
  if (!todo.length) return Promise.resolve(0);
  running = (async () => {
    const put = db.prepare('INSERT OR REPLACE INTO book_kind (key, kind, topic, at) VALUES (?, ?, ?, ?)');
    let done = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const sorted = readSorted(await ask(prompt(batch.map((x, j) => line(x.b, j)).join('\n'))), batch.length);
      const now = Math.floor(Date.now() / 1000);
      // A book the answer skipped is asked again next pass rather than filed under 其他.
      batch.forEach((x, j) => { const s = sorted[j]; if (s) { put.run(x.key, s.kind, s.topic, now); done++; } });
    }
    log.info(`[books] 按类型与主题归类：${done} 本`);
    return done;
  })().catch((e: Error) => {
    failedAt = Date.now();
    log.warn(`[books] 归类中断，10 分钟后再试：${e.message}`);
    return 0;
  }).finally(() => { running = null; });
  return running;
}
