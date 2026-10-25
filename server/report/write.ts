// The one LLM call of a report: group the items by topic, name and sum up each group, and write an
// overview. Inputs are titles and abstract leads only; anything the model returns is checked against them.
import type { Settings } from '../config.ts';
import { chat, type ChatMessage } from '../ai/llm.ts';
import { extractJson } from '../clip/metadata.ts';

const LEAD_CHARS = 90;
const MAX_TOKENS = 2000;
const TIMEOUT_MS = 180_000;
export const OTHER_GROUP = '其他';

export interface WriteItem { title: string; authors: string; venue: string; abstract: string }
export interface Group { name: string; summary: string; items: number[] }   // indexes into the input
export interface Written { overview: string; groups: Group[] }

// How each report asks: who the model is, how many groups, how to refer to an item.
export interface Voice { system: string; groups: string; example: string; mention: string; overview: string }

export const PAPERS_VOICE: Voice = {
  system: '你是人文社科期刊的编辑，按议题归并文章并写导语。只依据给出的题名和摘要，不补充其中没有的事实，不评价文章优劣。',
  groups: '3–6', example: '「新大众文艺」「人工智能与文艺」',
  mention: '说明这组文章在讨论什么问题、角度有何不同，可点名作者；提到文章时用作者名或题名',
  overview: '再写 2–3 句总述，说出本期最集中的议题。',
};

export function buildMessages(items: readonly WriteItem[], what: string, voice: Voice = PAPERS_VOICE): ChatMessage[] {
  const lines = items.map((it, i) => {
    const meta = [it.authors, it.venue].filter(Boolean).join('｜');
    return `[${i + 1}] ${it.title}${meta ? `（${meta}）` : ''}${it.abstract ? ` —— ${it.abstract.slice(0, LEAD_CHARS)}` : ''}`;
  });
  return [
    { role: 'system', content: voice.system },
    { role: 'user', content: `下面是${what}，共 ${items.length} 条。\n` +
      `请按议题分成 ${voice.groups} 组，每条只归入一组；组名 4–10 个字，要具体（如${voice.example}），不要「其他」「综合」这类。` +
      `每组写 2–3 句，${voice.mention}；只谈本组编号里的，不提别组的；不写「第几篇」「第几条」。${voice.overview}\n` +
      '只输出 JSON：{"overview":"…","groups":[{"name":"…","items":[编号,…],"summary":"…"}]}\n\n' + lines.join('\n') },
  ];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// The model quotes Chinese terms with straight quotes inside JSON strings (贾洁以"挂职文学"讨论),
// which ends the string early. A JSON quote always touches JSON punctuation on one side; one with
// text on both sides is such a term quote and becomes a Chinese quote, opening and closing in turn.
export function lenientJson(raw: string): unknown {
  try { return extractJson(raw); } catch { /* repaired below */ }
  let open = true;
  const fixed = raw.replace(/"/g, (q, at: number, s: string) => {
    if (/[{[,:\s]/.test(s[at - 1] ?? ' ') || /[,}\]:\s]/.test(s[at + 1] ?? ' ')) return q;
    const out = open ? '“' : '”';
    open = !open;
    return out;
  });
  return extractJson(fixed);
}

// Each item in exactly one group, in the first group that claims it; unclaimed ones go to 其他.
export function parseWritten(raw: string, n: number): Written {
  const j = lenientJson(raw) as { overview?: unknown; groups?: unknown };
  const seen = new Set<number>();
  const groups: Group[] = [];
  for (const g of Array.isArray(j.groups) ? j.groups : []) {
    const name = str((g as Record<string, unknown>).name);
    const raw = (g as Record<string, unknown>).items;
    const items = (Array.isArray(raw) ? raw : []).map(Number)
      .filter((k) => Number.isInteger(k) && k >= 1 && k <= n && !seen.has(k - 1)).map((k) => k - 1);
    if (!name || !items.length) continue;     // an unnamed group's items fall to 其他
    items.forEach((k) => seen.add(k));
    groups.push({ name, summary: str((g as Record<string, unknown>).summary), items });
  }
  const rest = [...Array(n).keys()].filter((k) => !seen.has(k));
  if (rest.length) groups.push({ name: OTHER_GROUP, summary: '', items: rest });
  return { overview: str(j.overview), groups };
}

export async function writeGroups(items: readonly WriteItem[], what: string, settings: Settings, apiKey: string,
  voice: Voice = PAPERS_VOICE): Promise<Written> {
  if (!items.length) return { overview: '', groups: [] };
  // No reasoning needed; MiniMax thinking would only add minutes.
  const extra = /minimax/i.test(settings.ai.baseUrl) ? { thinking: { type: 'disabled' } } : {};
  const ask = (): Promise<string> => chat(buildMessages(items, what, voice), settings, apiKey, MAX_TOKENS, TIMEOUT_MS, extra);
  try {
    return parseWritten(await ask(), items.length);
  } catch (e) {
    if (!(e instanceof SyntaxError) && !/JSON/.test((e as Error).message)) throw e;
    return parseWritten(await ask(), items.length);   // one more try when the answer did not parse
  }
}
