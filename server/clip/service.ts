import type { DB } from '../db.ts';
import type { Settings, Secrets } from '../config.ts';
import type { Enricher } from '../ai/enrich.ts';
import { type Translator, needsTranslation, bilingualForArchive } from '../ai/translate.ts';
import { getEntry } from '../api/queries.ts';
import { plainText } from '../content/sanitize.ts';
import { log } from '../log.ts';
import { writeClip, htmlToMarkdown, formatDate, type ClipPage, type ClipResult } from './obsidian.ts';
import { LlmError } from '../ai/llm.ts';
import type { Jobs } from '../jobs.ts';
import { runAnalysis, fillAiSection, unitsWithoutQuote } from './analysis.ts';
import { cleanMarkdown, fixEmphasisSpacing, type CleanResult } from './clean.ts';
import { localizeImages } from './images.ts';
import { Libraries, type Person } from './library.ts';
import { seedPeople, seedTags } from './seed.ts';
import { safeFilename } from './obsidian.ts';
import {
  extractMetadata, ruleMetadata, resolveName, displayTitle, originalAlias, wordCount,
  type ArticleMeta, type MetaInput, type ResolvedName,
} from './metadata.ts';

export const CLIP_TAG = '已存档';
// Feed excerpts shorter than this are worth replacing with the readability full text.
const FULLTEXT_BELOW_CHARS = 500;
const MAX_SELECTION_CHARS = 20_000;
const IMAGE_BASENAME_CHARS = 40;
const SUMMARY_LABEL_CHARS = 8;

export interface ClipDeps {
  db: DB;
  enricher: Enricher;
  getSettings: () => Settings;
  getSecrets: () => Secrets;
  events: EventTarget;
  jobs: Jobs;
  translator: Translator;
}

export interface ClipOutcome extends ClipResult { analysis: 'queued' | 'off' | 'no-key' | 'skipped' }

type Entry = Record<string, unknown> & { tags: { name: string; source: string }[] };

async function loadWithText(d: ClipDeps, id: number, job: number): Promise<Entry> {
  let e = getEntry(d.db, id) as Entry | undefined;
  if (!e) throw new Error('文章不存在');
  d.jobs.update(job, { title: String(e.title ?? `#${id}`) });
  const html = String(e.content_full || e.content || '');
  if (plainText(html, FULLTEXT_BELOW_CHARS + 1).length < FULLTEXT_BELOW_CHARS && e.link) {
    d.jobs.update(job, { step: '订阅里只有摘要，正在抓取全文' });
    try {
      await d.enricher.process(id, { fulltext: true });
      e = (getEntry(d.db, id) as Entry | undefined) ?? e;
    } catch (err) {
      log.warn(`[clip] fulltext for ${id} failed, using feed content: ${(err as Error).message}`);
    }
  }
  return e;
}

// WeChat feeds carry no author field, but the article opens with "原创 作者名 2026-10-20 10:00".
const WECHAT_BYLINE = /^(?:原创\s+)?([^\s\d][^\s]{0,20})\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/m;

export function bylineAuthor(markdown: string): string {
  return WECHAT_BYLINE.exec(markdown.slice(0, 300))?.[1] ?? '';
}

// The first paragraph that says something: summaries may open with a "总结" heading or a bold label.
export function summaryLead(summary: string): string {
  const paras = summary.split(/\n\s*\n/).map((p) => p.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim());
  return paras.find((p) => p.length > SUMMARY_LABEL_CHARS) ?? paras[0] ?? '';
}

// Kept only when the paper's own title is not just the headline with a prefix trimmed off.
export function pushHeadline(headline: string, title: string): string {
  const squash = (s: string): string => s.replace(/[\s|｜丨:：·\-—_*“”"'《》（）()]/g, '');
  return squash(headline).includes(squash(title)) ? '' : headline.trim();
}

interface Prepared { clean: CleanResult; meta: ArticleMeta; authors: ResolvedName[]; translators: ResolvedName[]; content: string }

function toPage(e: Entry, selectedText: string, prefix: string, p: Prepared): ClipPage {
  const summary = e.ai_summary ? fixEmphasisSpacing(htmlToMarkdown(String(e.ai_summary))) : '';
  const published = Number(e.published) || 0;
  const feed = String(e.feed_title ?? '');
  const authorsZh = p.authors.map((a) => a.zh);
  return {
    title: String(e.title ?? ''),
    titleZh: String(e.title_zh ?? ''),
    url: String(e.link ?? ''),
    content: p.content,
    selectedText: selectedText.trim(),
    author: authorsZh.join('、') || String(e.author ?? '').trim() || bylineAuthor(p.content),
    feed,
    published,
    summary,
    summaryLead: summaryLead(summary),
    tags: e.tags.filter((t) => t.source === 'ai' || t.source === 'knn').map((t) => t.name.slice(prefix.length)),
    displayTitle: displayTitle(authorsZh, p.meta.title, feed, published),
    headline: pushHeadline(String(e.title ?? ''), p.meta.title),
    alias: originalAlias(p.meta, published),
    authorLinks: p.authors.map((a) => a.link).join(', '),
    translatorLinks: p.translators.map((a) => a.link).join(', '),
    origin: p.meta.origin,
    type: p.meta.type,
    keywords: p.meta.keywords.join('、'),
    tagLine: p.meta.tags.map((t) => `#${t}`).join(' '),
    words: wordCount(p.content),
    citation: p.clean.facts.citation,
  };
}

function emit(d: ClipDeps, detail: Record<string, unknown>): void {
  d.events.dispatchEvent(new CustomEvent('clip', { detail }));
}

// A thinking-mode call takes 2–3 minutes and the connection occasionally drops mid-way
// ("fetch failed"); one retry covers that. Refusals and bad requests are not retried.
const ANALYSIS_ATTEMPTS = 2;

const isTransient = (err: unknown): boolean => !(err instanceof LlmError) || err.retryable;

function analysisStep(s: Settings, attempt: number): string {
  const how = s.clip.thinking ? '思考模式，约 2–5 分钟' : '约 30–60 秒';
  return `AI 分析中（${how}）${attempt > 1 ? `· 第 ${attempt} 次尝试` : ''}`;
}

async function analyseWithRetry(d: ClipDeps, id: number, job: number, page: ClipPage): Promise<string> {
  const meta = {
    title: page.title, author: page.author, source: page.feed, url: page.url,
    published: page.published ? formatDate(new Date(page.published * 1000), 'yyyy-LL-dd') : '',
  };
  for (let attempt = 1; ; attempt++) {
    d.jobs.update(job, { step: analysisStep(d.getSettings(), attempt) });
    try {
      return await runAnalysis(meta, page.content, d.getSettings(), d.getSecrets().aiApiKey);
    } catch (err) {
      if (attempt >= ANALYSIS_ATTEMPTS || !isTransient(err)) throw err;
      log.warn(`[clip] analysis for ${id} attempt ${attempt} failed, retrying: ${(err as Error).message}`);
    }
  }
}

const FILL_STEP: Record<ReturnType<typeof fillAiSection>, string> = {
  filled: '已存档，AI 分析已写入',
  'not-empty': '已存档；笔记的 AI 一节已有内容，分析未写入',
  'no-section': '已存档；笔记里找不到「# AI」一节，分析未写入',
};

async function analyseInBackground(d: ClipDeps, id: number, job: number, file: string, page: ClipPage): Promise<void> {
  const started = Date.now();
  try {
    const out = await analyseWithRetry(d, id, job, page);
    const r = fillAiSection(file, out);
    log.info(`[clip] analysis for ${id}: ${r} in ${Math.round((Date.now() - started) / 1000)}s (${out.length} chars, ${unitsWithoutQuote(out).length} units without quote)`);
    d.jobs.finish(job, r === 'filled' ? 'done' : 'failed', FILL_STEP[r]);
    emit(d, { id, stage: 'analysis', ok: r === 'filled', result: r });
  } catch (err) {
    log.warn(`[clip] analysis for ${id} failed: ${(err as Error).message}`);
    d.jobs.finish(job, 'failed', '已存档，AI 分析失败', (err as Error).message);
    emit(d, { id, stage: 'analysis', ok: false, error: (err as Error).message });
  }
}

const SKIP_STEP: Record<'skipped' | 'off' | 'no-key', string> = {
  skipped: '已存档过，未重复写入',
  off: '已存档（AI 分析已关闭）',
  'no-key': '已存档（未配置 AI 密钥，跳过分析）',
};

// The folder notes are archived under, taken from the path template: the part before the first {{.
const clipsFolder = (pathTemplate: string): string =>
  pathTemplate.replace(/^\/?vault\//, '').split('{{')[0].replace(/\/+$/, '');

function libraries(s: Settings): Libraries {
  const libs = new Libraries(s.clip.vaultPath, s.clip.tagLibrary, s.clip.nameLibrary, s.clip.authorsFolder);
  libs.ensureSeeded(() => seedTags(s.clip.vaultPath),
    () => seedPeople(s.clip.vaultPath, s.clip.authorsFolder, clipsFolder(s.clip.pathTemplate)));
  return libs;
}

async function metadataFor(d: ClipDeps, id: number, input: MetaInput, libs: Libraries, people: Person[]): Promise<ArticleMeta> {
  const s = d.getSettings();
  const key = d.getSecrets().aiApiKey;
  if (!s.clip.aiMetadata || !key) return ruleMetadata(input);
  try {
    return await extractMetadata(input, libs.tags(), people, s, key);
  } catch (err) {
    log.warn(`[clip] metadata for ${id} fell back to rules: ${(err as Error).message}`);
    return ruleMetadata(input);
  }
}

async function saveImages(s: Settings, id: number, markdown: string, title: string, published: number): Promise<string> {
  const when = new Date((published || Date.now() / 1000) * 1000);
  const base = safeFilename(`${formatDate(when, 'yyyyLLdd')} ${title}`).slice(0, IMAGE_BASENAME_CHARS).trim();
  const r = await localizeImages(markdown, { vaultPath: s.clip.vaultPath, folder: `${s.clip.imageFolder}/${formatDate(when, 'yyyy-LL')}`, baseName: base, settings: s });
  log.info(`[clip] images for ${id}: ${r.saved} saved, ${r.dropped} dropped as decoration, ${r.failed} left as remote links`);
  return r.markdown;
}

// A foreign article goes into the vault with its translation, paragraph after paragraph; one not
// translated yet is translated now. If that fails the note still gets the original.
async function archiveHtml(d: ClipDeps, id: number, job: number, e: Entry): Promise<string> {
  const source = e.content_full ? 'full' : 'feed';
  const html = String(e.content_full || e.content || '');
  const s = d.getSettings();
  let tr = e.tr_of === source ? (e.content_tr as string | null) : null;
  if (!tr && s.translate.enabled && d.getSecrets().aiApiKey && needsTranslation(plainText(html, 6000), s.translate.minChars)) {
    d.jobs.update(job, { step: '翻译正文（外文文章，译文随原文一起存档）' });
    try {
      await d.translator.translate(id, source);
      tr = (d.db.prepare('SELECT content_tr FROM entry WHERE id = ? AND tr_of = ?').get(id, source) as { content_tr: string | null } | undefined)?.content_tr ?? null;
    } catch (err) {
      log.warn(`[clip] translation for ${id} failed, archiving the original only: ${(err as Error).message}`);
    }
  }
  return tr ? bilingualForArchive(tr) : html;
}

async function prepare(d: ClipDeps, id: number, job: number, e: Entry): Promise<Prepared> {
  const s = d.getSettings();
  d.jobs.update(job, { step: '整理正文格式' });
  const clean = cleanMarkdown(htmlToMarkdown(await archiveHtml(d, id, job, e)), String(e.title ?? ''), String(e.feed_title ?? ''));
  const libs = libraries(s);
  const people = libs.people();
  d.jobs.update(job, { step: '识别作者、译者、出处与标签' });
  const input: MetaInput = { title: String(e.title ?? ''), feed: String(e.feed_title ?? ''), author: String(e.author ?? ''),
    facts: clean.facts, markdown: clean.markdown };
  const meta = await metadataFor(d, id, input, libs, people);
  const pages = libs.authorPages();
  const authors = meta.authors.map((n) => resolveName(n, people, pages));
  const translators = meta.translators.map((n) => resolveName(n, people, pages));
  libs.addPeople([...authors, ...translators].filter((r) => r.isNew).map((r) => ({ zh: r.zh, original: r.original, aliases: [] })));
  libs.addTags(meta.newTags);
  let content = clean.markdown;
  if (s.clip.downloadImages) {
    d.jobs.update(job, { step: '保存图片到 Obsidian' });
    content = await saveImages(s, id, content, meta.title, Number(e.published) || 0);
  }
  log.info(`[clip] cleaned ${id}: ${clean.stats.charsBefore}→${clean.stats.charsAfter} chars, tail ${clean.stats.tailCut ? 'cut' : 'kept'}, metadata by ${meta.source}`);
  return { clean, meta, authors, translators, content };
}

async function writeNote(d: ClipDeps, id: number, job: number, e: Entry, selectedText: string): Promise<{ res: ClipResult; page: ClipPage }> {
  const s = d.getSettings();
  const prepared = await prepare(d, id, job, e);
  d.jobs.update(job, { step: '写入 Obsidian 笔记' });
  const page = toPage(e, selectedText.slice(0, MAX_SELECTION_CHARS), s.ai.tagPrefix, prepared);
  const res = writeClip(s.clip, page);
  d.db.prepare("INSERT OR IGNORE INTO tag (entry_id, name, source) VALUES (?, ?, 'clip')").run(id, CLIP_TAG);
  return { res, page };
}

export async function clipEntry(d: ClipDeps, id: number, selectedText: string): Promise<ClipOutcome> {
  if (!d.getSettings().clip.vaultPath) throw new Error('还没设置 Obsidian 库的位置：在 设置 → 存档 里填上就能存档');
  const job =d.jobs.start('clip', id, `#${id}`, '读取文章');
  let written: { res: ClipResult; page: ClipPage };
  try {
    const e = await loadWithText(d, id, job);
    written = await writeNote(d, id, job, e, selectedText);
  } catch (err) {
    d.jobs.finish(job, 'failed', '存档失败', (err as Error).message);
    throw err;
  }
  const { res, page } = written;
  d.jobs.update(job, { notePath: res.path });
  const s = d.getSettings();
  const skip = res.existed ? 'skipped' : !s.clip.aiAnalysis ? 'off' : !d.getSecrets().aiApiKey ? 'no-key' : null;
  if (skip) {
    d.jobs.finish(job, 'done', SKIP_STEP[skip]);
    return { ...res, analysis: skip };
  }
  void analyseInBackground(d, id, job, res.path, page);
  return { ...res, analysis: 'queued' };
}
