// 书影音标记's short foreign texts — a book's or a film's title, a friend's comment, the blurb and
// the short comments of a 豆瓣 page — translated before they are read, and kept by the text itself
// (tr_snippet), so one comment shown on a card, a board and a page is translated once. The article
// translator (translate.ts) leaves these alone: they are far under its length floor, and a title
// wants a name, not a paragraph. A text 豆瓣 shows as it is (a Chinese title with its original
// after it) is not foreign and is not sent.
import type { DB } from '../db.ts';
import type { Settings, Secrets } from '../config.ts';
import { chat, LlmError } from './llm.ts';
import { needsTranslation, translateTexts, modelBody, type TranslateFn } from './translate.ts';
import { listMarks } from '../api/marks.ts';
import { log } from '../log.ts';

const ST = { DONE: 2, FAILED: 3 } as const;
const MIN_LETTERS = 3;
const PUMP_MS = 10_000;
const GATHER_MS = 10 * 60_000;
const FIRST_GATHER_MS = 30_000;
const BATCH = 30;
const RETRY_PAUSE_MS = 60_000;
const MAX_OUTPUT_TOKENS = 4096;
const TIMEOUT_MS = 120_000;
const MAX_SNIPPET = 4000;

// A title with Chinese in it is 豆瓣's 「中文名 原名」 already. A Japanese one (kana among its kanji,
// 〈カラー図解〉海底探検の科学) is foreign unless a part of it, between spaces, is such a Chinese name.
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const chineseName = (part: string): boolean => /\p{Script=Han}{2,}/u.test(part) && !KANA.test(part);
export const foreignTitle = (t: string): boolean => {
  if (KANA.test(t)) return !t.split(/\s+/).some(chineseName);
  return needsTranslation(t, MIN_LETTERS) && !/\p{Script=Han}{2,}/u.test(t);
};
export const foreignText = (t: string): boolean => t.length <= MAX_SNIPPET && needsTranslation(t, MIN_LETTERS);

// What a 豆瓣 page (a book's SubjectPage or a film's MoviePage, kept as JSON) has to translate.
interface PageTexts { title?: string; intro?: string[]; authorIntro?: string[]; comments?: { text: string }[] }
export function pageTexts(p: PageTexts | null): string[] {
  if (!p) return [];
  return [...(p.title && foreignTitle(p.title) ? [p.title] : []),
    ...[...(p.intro ?? []), ...(p.authorIntro ?? []), ...(p.comments ?? []).map((c) => c.text)].filter(foreignText)];
}

export function groupTexts(groups: readonly { title: string; marks: readonly { comment: string }[] }[]): string[] {
  return groups.flatMap((g) => [...(foreignTitle(g.title) ? [g.title] : []), ...g.marks.map((m) => m.comment).filter((c) => c && foreignText(c))]);
}

// The ones not asked for yet are put in the queue.
export function wantSnippets(db: DB, texts: readonly string[]): void {
  const put = db.prepare('INSERT OR IGNORE INTO tr_snippet (src) VALUES (?)');
  for (const t of new Set(texts)) put.run(t);
}

// The translations there are, text → 中文.
export function snippetMap(db: DB, texts: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const get = db.prepare('SELECT zh FROM tr_snippet WHERE src = ? AND state = ?');
  for (const t of new Set(texts)) {
    const r = get.get(t, ST.DONE) as { zh: string } | undefined;
    if (r) out[t] = r.zh;
  }
  return out;
}

// Translations finished after a moment (s), for a page that was told more are ready.
export const snippetsSince = (db: DB, at: number): Record<string, string> =>
  Object.fromEntries((db.prepare('SELECT src, zh FROM tr_snippet WHERE state = ? AND at >= ?').all(ST.DONE, at) as { src: string; zh: string }[]).map((r) => [r.src, r.zh]));

function snippetTranslator(settings: Settings, apiKey: string): TranslateFn {
  return (numbered) => chat([
    { role: 'system', content: '你是人文社科方向的译者，把外文的书名、片名和短评译成通顺、准确的现代汉语。' },
    { role: 'user', content: `把下面编号的文字逐条译成中文。书名、片名用通行的中文译名，没有就意译；不要括注原文，不加书名号或引号，不加任何说明。每条以原编号开头，如「[1] 译文」；条数、编号与原文一致。\n\n${numbered}` },
  ], settings, apiKey, MAX_OUTPUT_TOKENS, TIMEOUT_MS, modelBody(settings.translate.model));
}

// The texts of what 书影音标记 shows: the last 30 days' cards and the 豆瓣 pages opened from them.
export function marksTexts(db: DB): string[] {
  const groups = listMarks(db, { unreadOnly: false });
  const subjects = groups.map((g) => g.subject).filter((s): s is string => !!s);
  const pages = subjects.length
    ? (db.prepare(`SELECT page FROM douban_subject WHERE page IS NOT NULL AND subject IN (${subjects.map(() => '?').join(', ')})`).all(...subjects) as { page: string }[])
    : [];
  return [...groupTexts(groups), ...pages.flatMap((r) => { try { return pageTexts(JSON.parse(r.page) as PageTexts); } catch { return []; } })];
}

export class SnippetTranslator {
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  private pausedUntil = 0;
  private db: DB;
  private getSettings: () => Settings;
  private getSecrets: () => Secrets;
  private onDone: () => void;
  private makeFn: (s: Settings, apiKey: string) => TranslateFn;

  constructor(db: DB, getSettings: () => Settings, getSecrets: () => Secrets, onDone: () => void, makeFn = snippetTranslator) {
    this.db = db;
    this.getSettings = getSettings;
    this.getSecrets = getSecrets;
    this.onDone = onDone;
    this.makeFn = makeFn;
  }

  start(): void {
    const gather = (): void => { try { wantSnippets(this.db, marksTexts(this.db)); } catch (e) { log.warn(`[snippets] ${(e as Error).message}`); } };
    this.timers = [setInterval(() => void this.pump(), PUMP_MS), setInterval(gather, GATHER_MS), setTimeout(gather, FIRST_GATHER_MS)];
  }
  stop(): void { for (const t of this.timers) clearTimeout(t); }

  async pump(): Promise<number> {
    const s = this.getSettings();
    const apiKey = this.getSecrets().aiApiKey;
    if (this.busy || !s.translate.enabled || !apiKey || Date.now() < this.pausedUntil) return 0;
    const rows = this.db.prepare('SELECT src FROM tr_snippet WHERE state IS NULL LIMIT ?').all(BATCH) as { src: string }[];
    if (!rows.length) return 0;
    this.busy = true;
    try {
      const texts = rows.map((r) => r.src);
      const { done } = await translateTexts(texts, this.makeFn(s, apiKey));
      const now = Math.floor(Date.now() / 1000);
      const put = this.db.prepare('UPDATE tr_snippet SET zh = ?, state = ?, at = ? WHERE src = ?');
      texts.forEach((t, i) => {
        const zh = done.get(i)?.trim();
        put.run(zh ?? null, zh ? ST.DONE : ST.FAILED, now, t);
      });
      if (done.size) this.onDone();
      return done.size;
    } catch (e) {
      if (e instanceof LlmError && e.retryable) this.pausedUntil = Date.now() + RETRY_PAUSE_MS;
      log.warn(`[snippets] ${(e as Error).message}`);
      return 0;
    } finally {
      this.busy = false;
    }
  }
}
