import type { DB } from '../db.ts';
import type { Settings, Secrets } from '../config.ts';
import { httpPost } from '../fetch/post.ts';
import { MARK_WHERE } from '../api/marks.ts';
import { log } from '../log.ts';

// Turns each article into a vector (title + AI summary, or the opening of the body) so that
// similar articles can be found: related reading, the same story from other feeds, and later
// the interest profile.

export const EMBED_TEXT_CHARS = 1800;
const BODY_CHARS = 1500;
const REQUEST_TIMEOUT_MS = 60_000;
// After a rate limit or outage, wait this long before trying again; a bad key stops the queue until settings change.
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export class EmbedError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const strip = (html: string | null): string => (html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export interface TextRow { title: string; title_zh: string | null; ai_summary: string | null; content: string | null; content_full: string | null }

export function entryText(r: TextRow): string {
  const title = r.title_zh && r.title_zh !== r.title ? `${r.title_zh}（${r.title}）` : r.title;
  const summary = strip(r.ai_summary);
  const body = summary || strip(r.content_full || r.content).slice(0, BODY_CHARS);
  return `${title}\n${body}`.trim().slice(0, EMBED_TEXT_CHARS);
}

export function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  const out = new Float32Array(v.length);
  const k = n > 0 ? 1 / Math.sqrt(n) : 0;
  for (let i = 0; i < v.length; i++) out[i] = v[i] * k;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array): Float32Array => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export async function embedTexts(texts: string[], s: Settings['embedding'], settings: Settings, apiKey: string): Promise<Float32Array[]> {
  if (!apiKey) throw new EmbedError('未配置向量服务的密钥', false);
  const url = s.baseUrl.replace(/\/$/, '') + '/embeddings';
  let res: { status: number; text: string };
  try {
    res = await httpPost(url, { model: s.model, input: texts, encoding_format: 'float' }, { authorization: `Bearer ${apiKey}` }, settings, REQUEST_TIMEOUT_MS);
  } catch (e) {
    throw new EmbedError(`连不上向量服务：${(e as Error).message}`, true);
  }
  if (res.status === 401 || res.status === 403) throw new EmbedError(`向量服务拒绝了密钥（HTTP ${res.status}）`, false);
  if (res.status === 429 || res.status >= 500) throw new EmbedError(`向量服务 HTTP ${res.status}`, true);
  if (res.status >= 400) throw new EmbedError(`向量服务 HTTP ${res.status}: ${res.text.slice(0, 200)}`, false);
  let data: { data?: { index?: number; embedding?: number[] }[] };
  try { data = JSON.parse(res.text); } catch { throw new EmbedError('向量服务返回的不是 JSON', true); }
  const rows = data.data ?? [];
  if (rows.length !== texts.length || rows.some((r) => !Array.isArray(r.embedding) || !r.embedding.length)) {
    throw new EmbedError(`向量服务返回 ${rows.length} 条，应为 ${texts.length} 条`, true);
  }
  return [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => normalize(r.embedding!));
}

// All vectors of the current model, kept in memory: a brute-force scan over ~20k of them takes a few ms.
export class VectorIndex {
  private readonly db: DB;
  private vecs: Map<number, Float32Array> | null = null;
  private model = '';

  constructor(db: DB) { this.db = db; }

  private load(model: string): Map<number, Float32Array> {
    if (this.vecs && this.model === model) return this.vecs;
    const rows = this.db.prepare('SELECT entry_id, vec FROM embedding WHERE model = ?').all(model) as { entry_id: number; vec: Uint8Array }[];
    this.vecs = new Map(rows.map((r) => [r.entry_id, fromBlob(r.vec)]));
    this.model = model;
    return this.vecs;
  }

  get(model: string, id: number): Float32Array | undefined { return this.load(model).get(id); }
  size(model: string): number { return this.load(model).size; }
  add(model: string, id: number, v: Float32Array): void { if (this.vecs && this.model === model) this.vecs.set(id, v); }
  // Retention removed entries: rebuild on the next read.
  reset(): void { this.vecs = null; }

  nearest(model: string, id: number, k: number, minSim: number): { id: number; sim: number }[] {
    const q = this.load(model).get(id);
    return q ? this.nearestTo(model, q, k, minSim, id) : [];
  }

  // The k vectors closest to any vector (a search query's), best first.
  nearestTo(model: string, q: Float32Array, k: number, minSim: number, self = -1): { id: number; sim: number }[] {
    const close: { id: number; sim: number }[] = [];
    for (const [other, v] of this.load(model)) {
      if (other === self) continue;
      const sim = dot(q, v);
      if (sim >= minSim) close.push({ id: other, sim });
    }
    return close.sort((a, b) => b.sim - a.sim).slice(0, k);
  }

  // Similarity between random pairs: what "unrelated" looks like for this model and this library.
  background(model: string, pairs = 4000, rand: () => number = Math.random): { n: number; p50: number; p95: number; p99: number } {
    const vs = [...this.load(model).values()];
    if (vs.length < 50) return { n: 0, p50: 0, p95: 0, p99: 0 };
    const sims: number[] = [];
    for (let i = 0; i < pairs; i++) {
      const a = vs[Math.floor(rand() * vs.length)], b = vs[Math.floor(rand() * vs.length)];
      if (a !== b) sims.push(dot(a, b));
    }
    sims.sort((x, y) => x - y);
    const at = (q: number): number => Number(sims[Math.min(sims.length - 1, Math.floor(q * sims.length))].toFixed(4));
    return { n: sims.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
  }
}

export interface EmbedStatus { enabled: boolean; model: string; done: number; pending: number; lastError: string | null; pausedUntil: number }

// Entries still to embed, newest first so fresh arrivals jump the backfill. Douban marks are not articles.
const PENDING_SQL = `FROM entry e JOIN feed f ON f.id = e.feed_id
  WHERE NOT (${MARK_WHERE}) AND NOT EXISTS (SELECT 1 FROM embedding m WHERE m.entry_id = e.id AND m.model = ?)`;

type EmbedFn = typeof embedTexts;

export class Embedder {
  readonly index: VectorIndex;
  private readonly embed: EmbedFn;
  private readonly db: DB;
  private readonly getSettings: () => Settings;
  private readonly getSecrets: () => Secrets;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private lastError: string | null = null;
  private pausedUntil = 0;
  private backoff = BACKOFF_MS;
  private stoppedFor = '';             // key + model that failed for good; changing either resumes
  // Every entry up to this id has a vector for this model: later rounds look only above it. Without it a
  // round with nothing left still read the whole table (and the 豆瓣 marks' content) every 30 seconds.
  private doneUpTo = { model: '', id: 0 };

  constructor(db: DB, getSettings: () => Settings, getSecrets: () => Secrets, embed: EmbedFn = embedTexts) {
    this.db = db;
    this.embed = embed;
    this.getSettings = getSettings;
    this.getSecrets = getSecrets;
    this.index = new VectorIndex(db);
  }

  start(): void { this.schedule(5_000); }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pump(), ms);
  }

  private configKey(): string { return `${this.getSettings().embedding.model}\u0000${this.getSecrets().embeddingApiKey}`; }

  status(): EmbedStatus {
    const s = this.getSettings().embedding;
    const done = (this.db.prepare('SELECT COUNT(*) AS n FROM embedding WHERE model = ?').get(s.model) as { n: number }).n;
    const pending = (this.db.prepare(`SELECT COUNT(*) AS n ${PENDING_SQL}`).get(s.model) as { n: number }).n;
    return { enabled: s.enabled, model: s.model, done, pending, lastError: this.lastError, pausedUntil: this.pausedUntil };
  }

  // One batch; returns how many entries got a vector.
  async runBatch(): Promise<number> {
    const settings = this.getSettings();
    const s = settings.embedding;
    const above = this.doneUpTo.model === s.model ? this.doneUpTo.id : 0;
    const newest = (this.db.prepare('SELECT MAX(id) AS id FROM entry').get() as { id: number | null }).id ?? 0;
    const rows = this.db.prepare(`SELECT e.id, e.title, e.title_zh, e.ai_summary, e.content, e.content_full ${PENDING_SQL}
      AND e.id > ? ORDER BY e.id DESC LIMIT ?`).all(s.model, above, s.batchSize) as unknown as (TextRow & { id: number })[];
    // A short batch is all that was left: once it is stored, everything up to `newest` is done.
    const last = rows.length < s.batchSize;
    if (!rows.length) { this.doneUpTo = { model: s.model, id: newest }; return 0; }
    const vecs = await this.embed(rows.map(entryText), s, settings, this.getSecrets().embeddingApiKey);
    const put = this.db.prepare('INSERT OR REPLACE INTO embedding (entry_id, model, vec, created) VALUES (?, ?, ?, ?)');
    const now = Math.floor(Date.now() / 1000);
    rows.forEach((r, i) => { put.run(r.id, s.model, toBlob(vecs[i]), now); this.index.add(s.model, r.id, vecs[i]); });
    if (last) this.doneUpTo = { model: s.model, id: newest };
    return rows.length;
  }

  private async pump(): Promise<void> {
    const s = this.getSettings().embedding;
    const idle = (): void => this.schedule(Math.max(s.intervalMs, 30_000));
    if (this.busy) return;
    if (!s.enabled || !this.getSecrets().embeddingApiKey || this.stoppedFor === this.configKey() || Date.now() < this.pausedUntil) { idle(); return; }
    this.busy = true;
    try {
      const n = await this.runBatch();
      this.lastError = null;
      this.backoff = BACKOFF_MS;
      this.schedule(n ? s.intervalMs : 30_000);
    } catch (e) {
      const err = e as EmbedError;
      this.lastError = err.message;
      if (err.retryable) {
        this.pausedUntil = Date.now() + this.backoff;
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      } else {
        this.stoppedFor = this.configKey();
      }
      log.warn(`[embed] ${err.message}`);
      idle();
    } finally {
      this.busy = false;
    }
  }

  // Settings or key changed: try again at once instead of waiting out a pause.
  resume(): void {
    this.stoppedFor = '';
    this.pausedUntil = 0;
    this.backoff = BACKOFF_MS;
    this.lastError = null;
    this.schedule(500);
  }
}
