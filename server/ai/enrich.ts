import { marked } from 'marked';
import type { DB } from '../db.ts';
import { indexEntry } from '../search.ts';
import type { Settings, Secrets } from '../config.ts';
import { chat, LlmError } from './llm.ts';
import { fetchFullText } from '../content/readability.ts';
import { sanitize, plainText } from '../content/sanitize.ts';
import { log } from '../log.ts';

export const AI = { NONE: 0, QUEUED: 1, DONE: 2, FAILED: 3, SKIPPED: 4 } as const;

interface Job {
  id: number; title: string; link: string | null; content: string | null; content_full: string | null;
  feed_title: string; feed_url: string; view: string; ai_summary: number; ai_translate_title: number; ai_classify: number; fulltext: number;
}

export interface Tasks { summary: boolean; title: boolean; classify: boolean }

export function isMostlyChinese(text: string): boolean {
  const t = text.replace(/\s/g, '');
  if (!t) return true;
  const han = t.match(/[㐀-鿿]/g)?.length ?? 0;
  return han / t.length > 0.3;
}

export function buildPrompt(job: Pick<Job, 'title' | 'feed_title'>, text: string, tasks: Tasks, allowedTags: string[]): string {
  const parts = [`文章标题：${job.title}`, `来源：${job.feed_title}`, '', '正文：', text, '', '请按下面的格式输出，只输出要求的段落，不要别的说明：'];
  if (tasks.title) parts.push('【标题】把标题译成通顺的中文，一行。');
  if (tasks.classify) parts.push(`【标签】从这个列表里选 0-2 个最贴切的，用顿号分隔；没有合适的写「无」：${allowedTags.join('、')}`);
  if (tasks.summary) parts.push('【摘要】先用一两句话概括全文主旨，再用 3-5 条 Markdown 列表列出关键论点或信息。用中文，不要复述标题，不要评价写作质量。');
  return parts.join('\n');
}

export interface AiResult { titleZh?: string; tags: string[]; summaryHtml?: string }

export function parseAiOutput(out: string, tasks: Tasks, allowedTags: string[]): AiResult {
  const section = (name: string): string | undefined => {
    const m = out.match(new RegExp(`【${name}】([\\s\\S]*?)(?=\\n?【(?:标题|标签|摘要)】|$)`));
    return m?.[1].trim() || undefined;
  };
  const result: AiResult = { tags: [] };
  if (tasks.title) result.titleZh = section('标题')?.split('\n')[0].replace(/^["“《]|["”》]$/g, '').trim();
  if (tasks.classify) {
    const raw = section('标签') ?? '';
    result.tags = raw.split(/[、,，\s]+/).map((t) => t.trim()).filter((t) => allowedTags.includes(t)).slice(0, 2);
  }
  if (tasks.summary) {
    const md = section('摘要') ?? (out.includes('【') ? undefined : out);
    if (md) result.summaryHtml = sanitize(marked.parse(md, { async: false }) as string);
  }
  return result;
}

const VECTOR_RETRY_MS = 30_000;

export class Enricher {
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  private pausedUntil = 0;

  private db: DB;
  private getSettings: () => Settings;
  private getSecrets: () => Secrets;
  private onChange: () => void;
  // Tags from the nearest tagged articles (server/rec/tagknn.ts); null when the vote is unclear or there is no vector yet.
  tagByNeighbours: (id: number) => string[] | null = () => null;
  // True while a fresh article's vector is still being computed: its tag-only call waits for the vote.
  awaitsVector: (id: number) => boolean = () => false;
  private deferred = new Map<number, number>();   // id → not before (ms)

  constructor(db: DB, getSettings: () => Settings, getSecrets: () => Secrets, onChange: () => void) {
    this.db = db;
    this.getSettings = getSettings;
    this.getSecrets = getSecrets;
    this.onChange = onChange;
  }

  start(): void { this.timer = setInterval(() => void this.pump(), 5000); }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  queueSize(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM entry WHERE ai_state = 1').get() as { n: number }).n;
  }

  async pump(): Promise<void> {
    const s = this.getSettings();
    if (Date.now() < this.pausedUntil) return;
    const free = s.ai.concurrency - this.active;
    if (free <= 0) return;
    const now = Date.now();
    for (const [id, until] of this.deferred) if (until <= now) this.deferred.delete(id);
    const ids = (this.db.prepare('SELECT id FROM entry WHERE ai_state = 1 ORDER BY id DESC LIMIT ?').all(free + this.deferred.size) as { id: number }[])
      .filter(({ id }) => !this.deferred.has(id)).slice(0, free);
    for (const { id } of ids) {
      this.db.prepare('UPDATE entry SET ai_state = 5 WHERE id = ?').run(id); // 5 = in progress, reset on boot
      this.active++;
      void this.process(id, null).finally(() => { this.active--; setImmediate(() => void this.pump()); });
    }
  }

  private load(id: number): Job | undefined {
    return this.db.prepare(`SELECT e.id, e.title, e.link, e.content, e.content_full, f.title AS feed_title, f.url AS feed_url, f.view,
      f.ai_summary, f.ai_translate_title, f.ai_classify, f.fulltext FROM entry e JOIN feed f ON f.id = e.feed_id WHERE e.id = ?`).get(id) as unknown as Job | undefined;
  }

  // force: on-demand from the reader; ignores feed flags for the requested tasks.
  async process(id: number, force: Partial<Tasks & { fulltext: boolean }> | null): Promise<void> {
    const s = this.getSettings();
    const job = this.load(id);
    if (!job) return;
    try {
      let full = job.content_full;
      if ((force?.fulltext ?? job.fulltext) && !full && job.link) {
        try {
          full = await fetchFullText(job.link, s);
          if (full) {
            this.db.prepare('UPDATE entry SET content_full = ? WHERE id = ?').run(full, id);
            indexEntry(this.db, id);
          }
        } catch (e) {
          log.warn(`[fulltext] ${job.link}: ${(e as Error).message}`);
        }
      }
      const text = plainText(full || job.content || '', s.ai.maxInputChars);
      const isAcademic = /cnki\.net/i.test(job.feed_url) || job.view === 'video';
      const tasks: Tasks = {
        summary: force ? !!force.summary : !!job.ai_summary && text.length >= s.ai.summaryMinChars && !isAcademic,
        title: (force ? !!force.title : !!job.ai_translate_title) && !isMostlyChinese(job.title),
        classify: force ? !!force.classify : !!job.ai_classify && job.view === 'article' && text.length >= 100,
      };
      // A call made only to tag is saved when the neighbours agree.
      if (!force && tasks.classify && !tasks.summary && !tasks.title) {
        if (this.tagByNeighbours(id)) {
          this.db.prepare('UPDATE entry SET ai_state = ? WHERE id = ?').run(AI.DONE, id);
          this.onChange();
          return;
        }
        if (this.awaitsVector(id)) {
          this.db.prepare('UPDATE entry SET ai_state = ? WHERE id = ?').run(AI.QUEUED, id);
          this.deferred.set(id, Date.now() + VECTOR_RETRY_MS);
          return;
        }
      }
      const apiKey = this.getSecrets().aiApiKey;
      if (!s.ai.enabled || !apiKey || (!tasks.summary && !tasks.title && !tasks.classify)) {
        // A forced full-text-only run must not mark an already summarised entry as skipped.
        if (!force) this.db.prepare('UPDATE entry SET ai_state = ? WHERE id = ?').run(AI.SKIPPED, id);
        return;
      }
      const out = await chat([
        { role: 'system', content: '你是人文社科方向的中文阅读助手，输出简洁、准确，忠于原文。' },
        { role: 'user', content: buildPrompt(job, text || job.title, tasks, s.ai.allowedTags) },
      ], s, apiKey);
      const r = parseAiOutput(out, tasks, s.ai.allowedTags);
      this.db.prepare('UPDATE entry SET ai_state = ?, ai_summary = COALESCE(?, ai_summary), title_zh = COALESCE(?, title_zh) WHERE id = ?')
        .run(AI.DONE, r.summaryHtml ?? null, r.titleZh ?? null, id);
      if (r.summaryHtml || r.titleZh) indexEntry(this.db, id);
      // The model's tags replace a guess from the neighbours (tag's key is entry and name, not source).
      if (r.tags.length) this.db.prepare("DELETE FROM tag WHERE entry_id = ? AND source = 'knn'").run(id);
      const ins = this.db.prepare("INSERT OR IGNORE INTO tag (entry_id, name, source) VALUES (?, ?, 'ai')");
      for (const t of r.tags) ins.run(id, s.ai.tagPrefix + t);
      this.onChange();
    } catch (e) {
      const retryable = e instanceof LlmError && e.retryable;
      log.warn(`[ai] entry ${id}: ${(e as Error).message}`);
      if (retryable) this.pausedUntil = Date.now() + 60_000;   // back off the whole queue on rate limits
      this.db.prepare('UPDATE entry SET ai_state = ? WHERE id = ?').run(retryable ? AI.QUEUED : AI.FAILED, id);
      if (force) throw e;
    }
  }
}
