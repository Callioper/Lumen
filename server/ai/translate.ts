import { parseHTML } from 'linkedom';
import type { DB } from '../db.ts';
import { indexEntry } from '../search.ts';
import type { Settings, Secrets } from '../config.ts';
import { chat, LlmError } from './llm.ts';
import { plainText, sanitizeWoven } from '../content/sanitize.ts';
import { log } from '../log.ts';

// tr_state: NULL not looked at yet, then one of these.
export const TR = { DONE: 2, FAILED: 3, SKIPPED: 4, RUNNING: 5 } as const;

// Entries this recent, and unread ones of any age, are translated in the background; older read ones on request.
const BACKFILL_DAYS = 3;
const PUMP_MS = 5000;
const SCAN_LIMIT = 50;
const RETRY_PAUSE_MS = 60_000;
// One request: about 8 s on MiniMax-M3.1-Flash (measured 10-21, 2.5k chars in).
const CHUNK_CHARS = 2500;
const MAX_OUTPUT_TOKENS = 8192;
const TIMEOUT_MS = 180_000;
// Below this share of Han characters a text counts as foreign; Japanese mixes in kana.
const HAN_SHARE = 0.2;
const SAMPLE_CHARS = 3000;

const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dt,dd,td,th,div';

function letters(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '').replace(/[\s\d\p{P}\p{S}]/gu, '');
}

export function isForeign(text: string): boolean {
  const s = letters(text.slice(0, SAMPLE_CHARS));
  if (!s) return false;
  const han = s.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kana = s.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  return han / s.length < HAN_SHARE || kana / s.length > 0.1;
}

// Douban's 「想读《English title》」 lines are foreign but not worth a translation.
export function needsTranslation(text: string, minChars: number): boolean {
  return letters(text).length >= minChars && isForeign(text);
}

interface Segmented { body: HTMLElement; blocks: Element[] }

// The innermost block elements that carry foreign text. Text sitting directly in the body
// (some feeds use <br> only) is first wrapped into paragraphs so it has a block too.
export function segment(html: string): Segmented {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body as unknown as HTMLElement;
  const leaves = (): Element[] => [...body.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
  const covered = leaves().reduce((n, el) => n + (el.textContent ?? '').trim().length, 0);
  if (covered < (body.textContent ?? '').trim().length / 2) {
    const parts = body.innerHTML.split(/(?:<br\s*\/?>\s*){2,}|\n{2,}/i).map((p) => p.trim()).filter(Boolean);
    body.innerHTML = parts.map((p) => /^<(p|div|h\d|ul|ol|blockquote|figure|table|pre)\b/i.test(p) ? p : `<p>${p}</p>`).join('');
  }
  const blocks = leaves().filter((el) => {
    if (el.closest('pre, code')) return false;
    const t = (el.textContent ?? '').trim();
    return letters(t).length >= 2 && isForeign(t);
  });
  return { body, blocks };
}

// The block's text with its <br>s kept as line breaks (date / time / venue lines).
export function blockText(el: Element): string {
  for (const br of el.querySelectorAll('br')) br.before(el.ownerDocument.createTextNode('\n'));
  return (el.textContent ?? '').replace(/[ \t\r\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

export function parseNumbered(out: string): Map<number, string> {
  const found = new Map<number, string>();
  const marks = [...out.matchAll(/^\s*\[(\d+)\]\s*/gm)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : out.length;
    const text = out.slice(m.index + m[0].length, end).trim();
    if (text) found.set(Number(m[1]), text);
  });
  return found;
}

export function chunkTexts(texts: string[], limit = CHUNK_CHARS): number[][] {
  const chunks: number[][] = [];
  let cur: number[] = [], size = 0;
  texts.forEach((t, i) => {
    if (cur.length && size + t.length > limit) { chunks.push(cur); cur = []; size = 0; }
    cur.push(i); size += t.length;
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}

export type TranslateFn = (numbered: string) => Promise<string>;

export function modelBody(model: string): Record<string, unknown> {
  // M3 models think before answering and cannot switch it off; low keeps it to a few dozen tokens.
  return /^MiniMax-M3/i.test(model) ? { model, reasoning_effort: 'low' } : { model };
}

export function llmTranslator(settings: Settings, apiKey: string): TranslateFn {
  return (numbered) => chat([
    { role: 'system', content: '你是人文社科方向的学术译者，把外文译成通顺、准确的现代汉语。人名、书名、术语首次出现时括注原文。' },
    { role: 'user', content: `把下面编号的段落逐段译成中文。每段以原编号开头，如「[1] 译文」；段数、编号与原文一致，不合并、不省略、不加任何说明。\n\n${numbered}` },
  ], settings, apiKey, MAX_OUTPUT_TOKENS, TIMEOUT_MS, modelBody(settings.translate.model));
}

export interface Outcome { done: Map<number, string>; rejected: number }

// Translates the texts in chunks. A chunk whose numbering comes back wrong, or that the
// service refuses, is halved and retried, so one refused paragraph costs only itself.
// Rate limits and outages are thrown: the whole entry is tried again later.
export async function translateTexts(texts: string[], fn: TranslateFn): Promise<Outcome> {
  const done = new Map<number, string>();
  let rejected = 0;
  const run = async (ids: number[]): Promise<void> => {
    const numbered = ids.map((i) => `[${i + 1}] ${texts[i]}`).join('\n\n');
    let got: Map<number, string> | null = null;
    try {
      got = parseNumbered(await fn(numbered));
    } catch (e) {
      if (e instanceof LlmError && e.retryable) throw e;
      if (ids.length === 1) { rejected++; log.warn(`[translate] 段落被拒：${(e as Error).message}`); return; }
    }
    const complete = got && ids.every((i) => got.has(i + 1));
    if (got && (complete || ids.length === 1)) {
      for (const i of ids) { const t = got.get(i + 1); if (t) done.set(i, t); }
      if (!complete) rejected++;
      return;
    }
    const half = Math.ceil(ids.length / 2);
    await run(ids.slice(0, half));
    await run(ids.slice(half));
  };
  for (const ids of chunkTexts(texts)) await run(ids);
  return { done, rejected };
}

// Each translated block keeps its original in .tr-src and gains .tr-zh; the reader's CSS
// shows one, the other, or both.
export function weave(seg: Segmented, done: Map<number, string>): string {
  seg.blocks.forEach((el, i) => {
    const zh = done.get(i);
    if (!zh) return;
    const doc = el.ownerDocument;
    const src = doc.createElement('span');
    src.className = 'tr-src';
    while (el.firstChild) src.appendChild(el.firstChild);
    const tr = doc.createElement('span');
    tr.className = 'tr-zh';
    tr.textContent = zh;
    el.append(src, tr);
    el.classList.add('tr');
  });
  return sanitizeWoven(seg.body.innerHTML);
}

const HEADING = /^H[1-6]$/;
const IN_PLACE = new Set(['LI', 'TD', 'TH', 'DT', 'DD']);

// For the Obsidian note: each translated paragraph is followed by its translation; list items
// and table cells keep both in one cell; headings read 「译文（原文）」 so the outline stays single.
export function bilingualForArchive(woven: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${woven}</body></html>`);
  for (const el of [...document.body.querySelectorAll('.tr')]) {
    const src = el.querySelector(':scope > .tr-src');
    const zh = el.querySelector(':scope > .tr-zh');
    if (!src || !zh) continue;
    const zhText = zh.textContent ?? '';
    zh.remove();
    if (HEADING.test(el.tagName)) {
      const orig = (src.textContent ?? '').replace(/\s+/g, ' ').trim();
      el.textContent = orig ? `${zhText}（${orig}）` : zhText;
    } else {
      src.replaceWith(...src.childNodes);
      if (IN_PLACE.has(el.tagName)) {
        el.append(document.createElement('br'));
        for (const [i, line] of zhText.split('\n').entries()) {
          if (i) el.append(document.createElement('br'));
          el.append(document.createTextNode(line));
        }
      } else {
        const p = document.createElement(el.tagName === 'DIV' ? 'p' : el.tagName.toLowerCase());
        zhText.split('\n').forEach((line, i) => { if (i) p.append(document.createElement('br')); p.append(document.createTextNode(line)); });
        el.after(p);
      }
    }
    el.classList.remove('tr');
    if (!el.classList.length) el.removeAttribute('class');
  }
  return document.body.innerHTML;
}

interface Row { id: number; title: string; title_zh: string | null; content: string | null; content_full: string | null }

export class Translator {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private pausedUntil = 0;
  // One translation per entry and body at a time: the reader asking for an entry the pass is
  // already on waits for that one.
  private running = new Map<string, Promise<void>>();
  lastError: string | null = null;

  private db: DB;
  private getSettings: () => Settings;
  private getSecrets: () => Secrets;
  private onChange: () => void;
  private makeFn: (s: Settings, apiKey: string) => TranslateFn;

  constructor(db: DB, getSettings: () => Settings, getSecrets: () => Secrets, onChange: () => void, makeFn = llmTranslator) {
    this.db = db;
    this.getSettings = getSettings;
    this.getSecrets = getSecrets;
    this.onChange = onChange;
    this.makeFn = makeFn;
  }

  start(): void {
    this.db.prepare('UPDATE entry SET tr_state = NULL WHERE tr_state = ?').run(TR.RUNNING);   // interrupted by a restart
    this.timer = setInterval(() => void this.pump(), PUMP_MS);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  // Looks at recent entries the summariser is done with, skips the Chinese ones, and
  // translates one foreign entry per round.
  async pump(): Promise<void> {
    const s = this.getSettings();
    if (this.busy || !s.translate.enabled || !this.getSecrets().aiApiKey || Date.now() < this.pausedUntil) return;
    this.busy = true;
    try {
      const since = (Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86400) * 1_000_000;
      const rows = this.db.prepare(`SELECT id, title, title_zh, content, content_full FROM entry
        WHERE (id >= ? OR is_read = 0) AND tr_state IS NULL AND ai_state NOT IN (1, 5) ORDER BY id DESC LIMIT ?`).all(since, SCAN_LIMIT) as unknown as Row[];
      // Every Chinese entry in the batch is settled at once, so a long translation does not hold them up.
      let next: number | undefined;
      for (const r of rows) {
        if (needsTranslation(plainText(r.content_full || r.content || '', SAMPLE_CHARS * 2), s.translate.minChars)) next ??= r.id;
        else this.db.prepare('UPDATE entry SET tr_state = ? WHERE id = ?').run(TR.SKIPPED, r.id);
      }
      if (next !== undefined) await this.translate(next).catch(() => { /* recorded on the entry */ });
    } finally {
      this.busy = false;
    }
  }

  // source: which body to translate; by default the full text when there is one.
  translate(id: number, source?: 'full' | 'feed'): Promise<void> {
    const r = this.db.prepare('SELECT content_full FROM entry WHERE id = ?').get(id) as { content_full: string | null } | undefined;
    if (!r) return Promise.resolve();
    const of = source ?? (r.content_full ? 'full' : 'feed');
    const key = `${id}:${of}`;
    const now = this.running.get(key);
    if (now) return now;
    const p = this.translateBody(id, of).finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  private async translateBody(id: number, of: 'full' | 'feed'): Promise<void> {
    const s = this.getSettings();
    const apiKey = this.getSecrets().aiApiKey;
    const r = this.db.prepare('SELECT id, title, title_zh, content, content_full FROM entry WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!r) return;
    const html = (of === 'full' ? r.content_full : r.content) ?? '';
    this.db.prepare('UPDATE entry SET tr_state = ? WHERE id = ?').run(TR.RUNNING, id);
    try {
      const seg = segment(html);
      let budget = s.translate.maxChars;
      const texts: string[] = [];
      for (const el of seg.blocks) {
        const t = blockText(el);
        if (budget - t.length < 0) break;
        budget -= t.length;
        texts.push(t);
      }
      const truncated = texts.length < seg.blocks.length;
      seg.blocks.length = texts.length;
      const wantTitle = !r.title_zh && isForeign(r.title);
      const all = wantTitle ? [...texts, r.title] : texts;
      const { done, rejected } = await translateTexts(all, this.makeFn(s, apiKey));
      const titleZh = wantTitle ? done.get(texts.length)?.split('\n')[0].replace(/^["“《]|["”》]$/g, '').trim() : undefined;
      const note = [rejected ? `${rejected} 处未译（AI 服务拒绝或漏译）` : '', truncated ? `只译了前 ${s.translate.maxChars} 字` : '']
        .filter(Boolean).join('；') || null;
      if (!done.size && texts.length) throw new LlmError('没有一段译出来（AI 服务拒绝或返回格式不对）', false);
      this.db.prepare('UPDATE entry SET tr_state = ?, content_tr = ?, tr_of = ?, tr_note = ?, title_zh = COALESCE(title_zh, ?) WHERE id = ?')
        .run(TR.DONE, weave(seg, done), of, note, titleZh ?? null, id);
      indexEntry(this.db, id);
      this.lastError = null;
      this.onChange();
    } catch (e) {
      const retryable = e instanceof LlmError && e.retryable;
      this.lastError = (e as Error).message;
      log.warn(`[translate] entry ${id}: ${this.lastError}`);
      if (retryable) this.pausedUntil = Date.now() + RETRY_PAUSE_MS;
      this.db.prepare('UPDATE entry SET tr_state = ?, tr_note = ? WHERE id = ?').run(retryable ? null : TR.FAILED, retryable ? null : this.lastError, id);
      throw e;
    }
  }
}
