// 每日简报: a few lines summing up one feed's (or one list's) entries of a day.
// Summaries are cached by the set of entry ids, so reopening a block costs nothing.
import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import type { Settings } from '../config.ts';
import { chat, type ChatMessage } from './llm.ts';
import { plainText } from '../content/sanitize.ts';

export const DIGEST_MAX_ENTRIES = 120;
const SNIPPET_CHARS = 80;
const DIGEST_MAX_TOKENS = 600;
const DIGEST_TIMEOUT_MS = 90_000;

export interface DigestEntry { title: string; snippet: string; feed: string }

export function digestKey(ids: readonly number[]): string {
  return createHash('sha1').update([...ids].sort((a, b) => a - b).join(',')).digest('hex');
}

export function validateDigestIds(b: unknown): number[] | string {
  const ids = (b as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return 'ids 应为非空数组';
  if (ids.length > DIGEST_MAX_ENTRIES) return `一次最多 ${DIGEST_MAX_ENTRIES} 条`;
  if (!ids.every((x) => Number.isSafeInteger(x) && x > 0)) return 'ids 应为正整数';
  return [...new Set(ids as number[])];
}

export function loadDigestEntries(db: DB, ids: readonly number[]): DigestEntry[] {
  const q = db.prepare(`SELECT e.title, e.title_zh, e.content, f.title AS feed FROM entry e JOIN feed f ON f.id = e.feed_id WHERE e.id = ?`);
  const out: DigestEntry[] = [];
  for (const id of ids) {
    const r = q.get(id) as { title: string; title_zh: string | null; content: string | null; feed: string } | undefined;
    if (r) out.push({ title: r.title_zh || r.title, snippet: plainText(r.content ?? '', SNIPPET_CHARS), feed: r.feed });
  }
  return out;
}

export function buildDigestMessages(entries: readonly DigestEntry[], maxChars: number): ChatMessage[] {
  const feeds = [...new Set(entries.map((e) => e.feed))];
  const lines: string[] = [];
  let used = 0;
  for (const [i, e] of entries.entries()) {
    const line = `${i + 1}. ${e.title}${e.snippet && e.snippet !== e.title ? ` —— ${e.snippet}` : ''}${feeds.length > 1 ? `（${e.feed}）` : ''}`;
    if (used + line.length > maxChars) { lines.push(`……另有 ${entries.length - i} 条从略`); break; }
    lines.push(line);
    used += line.length;
  }
  return [
    { role: 'system', content: '你是中文信息编辑，把一组同日条目归纳成简报，忠于条目，不补充条目里没有的事实。' },
    { role: 'user', content: `下面是${feeds.length === 1 ? `「${feeds[0]}」` : '几个来源'}同一天的 ${entries.length} 条内容（期刊的话就是同一期的目录）。` +
      '请归纳成不超过 3 行的简报：每行一个主题，以「· 」开头，概括这个主题下的几条在说什么，可点名关键人物、机构、书名；' +
      '期刊目录则按议题归并，说出这一期集中讨论什么、有无专题栏目。' +
      '只输出这几行，不要标题、开场白或总结。\n\n' + lines.join('\n') },
  ];
}

// Keeps at most three bullet lines and drops anything the model wrapped around them.
export function parseDigest(out: string): string {
  const bullets = out.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^(?:[-*•·]|\d+[.、)])\s*/, '').trim()).filter(Boolean);
  return bullets.slice(0, 3).map((l) => `· ${l}`).join('\n');
}

export async function summarizeDigest(db: DB, ids: readonly number[], settings: Settings, apiKey: string): Promise<{ summary: string; cached: boolean }> {
  const key = digestKey(ids);
  const hit = db.prepare('SELECT summary FROM digest WHERE key = ?').get(key) as { summary: string } | undefined;
  if (hit) return { summary: hit.summary, cached: true };
  const entries = loadDigestEntries(db, ids);
  if (!entries.length) throw new Error('这些条目已不存在');
  // A digest needs no reasoning; MiniMax thinking would only add minutes.
  const extra = /minimax/i.test(settings.ai.baseUrl) ? { thinking: { type: 'disabled' } } : {};
  const out = await chat(buildDigestMessages(entries, settings.ai.maxInputChars), settings, apiKey, DIGEST_MAX_TOKENS, DIGEST_TIMEOUT_MS, extra);
  const summary = parseDigest(out);
  if (!summary) throw new Error('AI 没有给出简报');
  db.prepare('INSERT OR REPLACE INTO digest (key, summary, created) VALUES (?, ?, ?)').run(key, summary, Math.floor(Date.now() / 1000));
  return { summary, cached: false };
}
