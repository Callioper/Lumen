// Share cards for pages sent by the browser extension: the page is read here, then shown by
// the web app at /share/<id>, which renders and copies the picture (web/src/share).
import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { validatePage, parsePublished } from '../clip/web.ts';
import { extractArticle } from '../content/readability.ts';
import { plainText } from '../content/sanitize.ts';
import type { Settings } from '../config.ts';
import { chat } from '../ai/llm.ts';
import { isForeign, modelBody } from '../ai/translate.ts';
import { log } from '../log.ts';
import { refineCard } from './share-sites.ts';

// Mirrors ShareData in web/src/share/data.ts; summary and quote are trimmed for the card there.
export interface ShareData {
  title: string; titleOrig?: string; source: string; icon?: string; author?: string; published?: number;
  cover?: string; summary?: string; quote?: string; url?: string;
  pending?: boolean;           // an AI summary or translation is on its way; poll /share/<id>
  aiNote?: string;             // why it did not come
}

// Kept beside the card for the AI pass, never sent to the page.
export interface ShareInput { text: string; weak: boolean; foreign: boolean }

const KEEP_MS = 60 * 60_000;
const MAX_KEPT = 50;
const RAW_TEXT_CHARS = 600;
const MIN_LEAD_CHARS = 20;

const kept = new Map<string, { at: number; data: ShareData }>();
// A blurb shorter than this says little more than the title; the AI writes one from the text.
const WEAK_SUMMARY = 60;
const AI_INPUT_CHARS = 4000;
const AI_TIMEOUT_MS = 40_000;
const AI_MAX_TOKENS = 1024;

const proxied = (u: string | undefined, base: string): string | undefined => {
  if (!u) return undefined;
  try {
    const abs = new URL(u, base);
    return /^https?:$/.test(abs.protocol) ? `/img?u=${encodeURIComponent(abs.href)}&w=1080` : undefined;
  } catch { return undefined; }
};

// First real paragraph of an AI summary (its bullet list does not read well on a card).
export function summaryLead(html: string): string {
  for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = plainText(m[1]);
    if (t.length >= MIN_LEAD_CHARS) return t;
  }
  return plainText(html, RAW_TEXT_CHARS);
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function sharePage(db: DB, body: unknown): { data: ShareData; input: ShareInput } | string {
  const page = validatePage(body);
  if (typeof page === 'string') return page;
  const b = body as Record<string, unknown>;
  // A page already in Lumen (archived, or the same link in a feed) brings its AI summary and feed.
  const known = db.prepare(`SELECT e.feed_id, e.ai_summary, f.title AS feed FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.link = ? ORDER BY (e.ai_summary IS NOT NULL) DESC, e.id DESC LIMIT 1`).get(page.url) as { feed_id: number; ai_summary: string | null; feed: string } | undefined;
  const article = extractArticle(page.html, page.url);
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  // Readability gives up on short pages; their body text is still a fair blurb.
  const bodyText = (): string => plainText(article?.content ?? /<body[^>]*>([\s\S]*)<\/body>/i.exec(page.html)?.[1] ?? '', RAW_TEXT_CHARS);
  const fromAi = known?.ai_summary ? summaryLead(known.ai_summary) : '';
  const summary = fromAi || str(b.description) || bodyText();
  // 「微信公众平台」 names the platform; the feed Lumen knows the article from names the account.
  const genericSite = /^(微信公众平台|weixin)$/i.test(page.siteName ?? '');
  const card = refineCard({
    title: page.title || article?.title || host,
    source: (genericSite && known?.feed) || page.siteName || article?.siteName || known?.feed || host,
    author: page.author || article?.byline || undefined,
    published: parsePublished(page.published) ?? undefined,
    summary: summary.slice(0, RAW_TEXT_CHARS) || undefined,
  }, page.html, page.url, !fromAi);
  const text = plainText(article?.content ?? '', AI_INPUT_CHARS) || bodyText();
  const data: ShareData = {
    ...card,
    icon: known ? `/icon/${known.feed_id}` : proxied(str(b.favicon), page.url),
    cover: proxied(str(b.image), page.url),
    quote: str(b.selectedText).slice(0, RAW_TEXT_CHARS * 2) || undefined,
    url: page.url,
  };
  return { data, input: {
    text,
    weak: !fromAi && (card.summary ?? '').length < WEAK_SUMMARY && text.length > (card.summary ?? '').length,
    foreign: isForeign(`${card.title} ${card.summary ?? ''}`),
  } };
}

// Whether the card is worth an AI pass: a thin blurb, or a page not in Chinese.
export const wantsAi = (input: ShareInput, settings: Settings, hasKey: boolean): boolean =>
  settings.translate.shareCards && hasKey && (input.weak || input.foreign);

const PROMPT = `你在为一张文章分享卡写文字。根据下面的文章，按两行输出，不要别的内容：
标题：中文标题（原标题是中文就照抄；是外文就译成通顺的中文，专名保留常见译法）
摘要：用一到两句中文概括这篇文章讲了什么，60 到 110 字，不评价、不用“本文”开头`;

const unquote = (s: string): string => s.replace(/^[「《"“*]+|[」》"”*]+$/g, '').trim();

// 「标题：…」「摘要：…」, or (as the model often answers) the same two lines without the labels.
export function parseCardReply(out: string): { title?: string; summary?: string } {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const line = (k: string): string | undefined => {
    const hit = lines.find((l) => l.replace(/^\*+/, '').startsWith(k));
    return hit ? unquote(hit.replace(/^\*+/, '').slice(k.length).replace(/^\**\s*[:：]\s*/, '')) || undefined : undefined;
  };
  const title = line('标题'), summary = line('摘要');
  if (title || summary || lines.length < 2) return { title, summary };
  return { title: unquote(lines[0]) || undefined, summary: unquote(lines.slice(1).join('')) || undefined };
}

// Fills in the summary (and a Chinese title for a foreign page) after the card is first shown.
export async function enhanceShare(id: string, input: ShareInput, settings: Settings, apiKey: string,
  ask: typeof chat = chat): Promise<void> {
  const v = kept.get(id);
  if (!v) return;
  const d = v.data;
  try {
    const out = await ask([{ role: 'user', content: `${PROMPT}

原标题：${d.title}

${input.text}` }],
      settings, apiKey, AI_MAX_TOKENS, AI_TIMEOUT_MS, modelBody(settings.translate.model));
    const r = parseCardReply(out);
    if (!r.title && !r.summary) throw new Error(`AI 没按格式返回（${out.replace(/\s+/g, ' ').trim().slice(0, 60) || '空'}）`);
    // 「owner/repo」, a product name and the like are names, not titles to translate.
    const isName = /^[\w.-]+\/[\w.-]+$/.test(d.title) || !/\s/.test(d.title);
    const retitle = input.foreign && !isName && r.title && r.title !== d.title && !isForeign(r.title);
    v.data = { ...d, pending: false,
      ...(retitle ? { title: r.title, titleOrig: d.title } : {}),
      ...(r.summary && (input.weak || input.foreign) ? { summary: r.summary } : {}) };
  } catch (e) {
    log.warn(`[share] AI card text: ${(e as Error).message}`);
    v.data = { ...d, pending: false, aiNote: `AI 摘要没生成：${(e as Error).message}` };
  }
}

export function keepShare(data: ShareData, now = Date.now()): string {
  for (const [id, v] of kept) if (now - v.at > KEEP_MS) kept.delete(id);
  while (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value!);
  const id = randomUUID();
  kept.set(id, { at: now, data });
  return id;
}

export function getShare(id: string, now = Date.now()): ShareData | undefined {
  const v = kept.get(id);
  return v && now - v.at <= KEEP_MS ? v.data : undefined;
}
