// 期刊目录 and 学术动态: posts the AI reads once, for what a rule cannot read across accounts that each
// lay a table of contents or a call for papers out their own way. What it found is kept in `extract`
// by entry and kind (null: the post is not one), so a post is never asked about twice; a new
// version of a prompt asks again.
// Tried on 6 tables of contents and 13 notices (2026-10-23): all but one read right, and the posts
// that only looked like one (an author's bibliography, a 会议纪实, a news item) were turned down.
import type { DB } from '../db.ts';
import type { Settings, Secrets } from '../config.ts';
import { chat, LlmError, type ChatMessage } from '../ai/llm.ts';
import { modelBody } from '../ai/translate.ts';
import { log } from '../log.ts';

export type ExtractKind = 'toc' | 'notice' | 'reprint';

export interface Post { id: number; title: string; published: number }

export interface Extractor<T> {
  kind: ExtractKind;
  label: string;                         // in the log
  version: number;
  maxTokens: number;
  candidates(db: DB, since: number): Post[];
  ask(post: Post, text: string): ChatMessage[];
  read(raw: unknown, text: string): T | null;
  // The text to read where the post's own is not all of it (a post set in pictures: ocr.ts); its
  // own text otherwise.
  text?(html: string, settings: Settings): Promise<string>;
  textChars?: number;
}

const LOOK_BACK_DAYS = 180;
const TEXT_CHARS = 14_000;
// One at a time: the summaries and translations share the account's rate limit, and a 429 met at
// two at once (2026-10-23) stopped the first pass after 36 posts.
const RATE_WAITS_MS = [30_000, 60_000, 90_000];
const TIMEOUT_MS = 180_000;
const RETRY_AFTER_MS = 10 * 60_000;

const BLOCK_END = /<\/(?:p|section|h\d|li|div|tr|blockquote)>|<br\s*\/?>/gi;
const ENTITIES: Record<string, string> = { nbsp: ' ', ensp: ' ', emsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

// The post's text a line per paragraph, which is where its tables of contents break.
export function postLines(html: string): string[] {
  return html.replace(BLOCK_END, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|ensp|emsp|amp|lt|gt|quot|#39);/g, (_, k: string) => ENTITIES[k])
    .replace(/&#\d+;/g, '')
    .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// The JSON an answer holds, fenced or not; null when there is none.
export function parseJson(out: string): unknown {
  const body = out.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

export const canExtract = (settings: Settings, secrets: Secrets): boolean => settings.ai.enabled && !!secrets.aiApiKey;

const running = new Map<ExtractKind, Promise<number>>();
const failedAt = new Map<ExtractKind, number>();

export const isExtracting = (kind: ExtractKind): boolean => running.has(kind);
// A pass stopped by an outage or a refused account, waiting before the next.
export const isStalled = (kind: ExtractKind, now = Date.now()): boolean => now - (failedAt.get(kind) ?? 0) < RETRY_AFTER_MS;

// How many candidates have not been read yet.
export function pendingCount<T>(db: DB, ex: Extractor<T>, now = Date.now()): number {
  return unread(db, ex, now).length;
}

function unread<T>(db: DB, ex: Extractor<T>, now: number): Post[] {
  const since = Math.floor(now / 1000) - LOOK_BACK_DAYS * 86_400;
  const done = new Set((db.prepare('SELECT entry_id FROM extract WHERE kind = ? AND version = ?').all(ex.kind, ex.version) as { entry_id: number }[])
    .map((r) => r.entry_id));
  return ex.candidates(db, since).filter((p) => !done.has(p.id));
}

// A post the AI could not be got to read (its answer cut short or garbled, or it timed out each try):
// counted, and after the second pass that fails on it set down as not one, so it cannot hold up the
// posts behind it for good.
class PostFailed extends Error {}
const STRIKES_TO_SKIP = 2;
const strikes = new Map<string, number>();

// The account cannot be used (a revoked key, no balance left): stop now, read nothing as not one.
const accountRefused = (e: unknown): boolean => e instanceof LlmError && !e.retryable && !e.perPost;

// Reads the candidates not read yet, one at a time; one pass per kind at a time. A post refused for
// what it says, or with no text, is set down as not one; a rate limit or an outage is waited out a few
// times and then stops the pass, as a refused account does at once, and the next waits 10 minutes.
export function runExtract<T>(db: DB, ex: Extractor<T>, settings: Settings, secrets: Secrets, now = Date.now()): Promise<number> {
  const busy = running.get(ex.kind);
  if (busy) return busy;
  if (!canExtract(settings, secrets) || isStalled(ex.kind, now)) return Promise.resolve(0);
  const todo = unread(db, ex, now);
  db.prepare('DELETE FROM extract WHERE kind = ? AND entry_id NOT IN (SELECT id FROM entry)').run(ex.kind);
  if (!todo.length) return Promise.resolve(0);
  const put = db.prepare('INSERT OR REPLACE INTO extract (entry_id, kind, version, data, at) VALUES (?, ?, ?, ?, ?)');
  const store = (post: Post, data: T | null): void => {
    put.run(post.id, ex.kind, ex.version, data === null ? null : JSON.stringify(data), Math.floor(Date.now() / 1000));
    if (data !== null) found++;
  };
  const model = modelBody(settings.translate.model);
  let found = 0;
  const body = db.prepare('SELECT COALESCE(content_full, content) AS html FROM entry WHERE id = ?');
  const one = async (post: Post): Promise<void> => {
    const html = (body.get(post.id) as { html: string | null } | undefined)?.html;
    const text = ex.text ? await ex.text(html ?? '', settings) : html ? postLines(html).join('\n') : '';
    if (!text) { store(post, null); return; }
    let out: string;
    try {
      out = await chat(ex.ask(post, text.slice(0, ex.textChars ?? TEXT_CHARS)), settings, secrets.aiApiKey, ex.maxTokens, TIMEOUT_MS, model);
    } catch (e) {
      if (e instanceof LlmError && e.perPost) { log.warn(`[extract] #${post.id} 模型不肯读这篇，记为无内容：${e.message}`); store(post, null); return; }
      throw e;
    }
    const raw = parseJson(out);
    if (raw === null) throw new PostFailed('AI 的回答读不出 JSON（可能被截断）');
    let data: T | null;
    try { data = ex.read(raw, text); } catch (e) { throw new PostFailed((e as Error).message); }
    store(post, data);
  };
  // A rate limit or an outage is waited out a few times; a refused account or an unreadable answer is not.
  const patiently = async (job: () => Promise<void>): Promise<void> => {
    for (let i = 0; ; i++) {
      try { return await job(); } catch (e) {
        if (e instanceof PostFailed || accountRefused(e) || i >= RATE_WAITS_MS.length) throw e;
        await new Promise((ok) => setTimeout(ok, RATE_WAITS_MS[i]));
      }
    }
  };
  const strike = (post: Post): void => {
    const k = `${ex.kind}:${post.id}`;
    const n = (strikes.get(k) ?? 0) + 1;
    if (n < STRIKES_TO_SKIP) { strikes.set(k, n); return; }
    strikes.delete(k);
    store(post, null);
    log.warn(`[${ex.label}] 跳过读不了的一篇：${post.title}`);
  };
  const pass = (async () => {
    for (const p of todo) {
      try { await patiently(() => one(p)); } catch (e) {
        if (e instanceof PostFailed) { strike(p); continue; }
        // A post too long to answer in time times out each try; the network being down is no fault of the post.
        if ((e as Error).name === 'TimeoutError') strike(p);
        throw e;
      }
    }
    log.info(`[${ex.label}] 读了 ${todo.length} 篇，${found} 篇有内容`);
    return found;
  })().catch((e: Error) => { failedAt.set(ex.kind, Date.now()); log.warn(`[${ex.label}] 中断，10 分钟后再试：${e.message}`); return found; })
    .finally(() => { running.delete(ex.kind); });
  running.set(ex.kind, pass);
  return pass;
}

// image: the post's cover, which 首页 shows beside what was found in it.
export interface Found<T> { data: T; post: { id: number; title: string; feedId: number; feed: string; published: number; link: string | null; image?: string | null } }

// What was found, newest post first. A post read by an older prompt shows what that one found until
// it is read again: a new version empties no page while the posts are gone through anew.
export function extracted<T>(db: DB, kind: ExtractKind, version: number): Found<T>[] {
  const rows = db.prepare(`SELECT x.data, e.id, e.title, e.published, e.link, e.thumbnail, f.id AS feed_id, f.title AS feed
    FROM extract x JOIN entry e ON e.id = x.entry_id JOIN feed f ON f.id = e.feed_id
    WHERE x.kind = ? AND x.version <= ? AND x.data IS NOT NULL ORDER BY e.published DESC, e.id DESC`).all(kind, version) as
    { data: string; id: number; title: string; published: number; link: string | null; thumbnail: string | null; feed_id: number; feed: string }[];
  return rows.flatMap((r) => {
    let data: T;
    try { data = JSON.parse(r.data) as T; } catch { return []; }      // a row written wrong costs only itself
    return [{ data, post: { id: r.id, title: r.title, feedId: r.feed_id, feed: r.feed, published: r.published, link: r.link, image: r.thumbnail } }];
  });
}
