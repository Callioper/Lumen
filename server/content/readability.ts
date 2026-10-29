import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { Settings } from '../config.ts';
import { httpGet, decodeBody } from '../fetch/http.ts';
import { sanitize } from './sanitize.ts';
import { extras } from '../extras.ts';

const MIN_TEXT = 200;

// Fetch the article page and extract its main content. Returns null when the
// page has no recognisable article (login walls, captcha, SPA shells).
export async function fetchFullText(link: string, settings: Settings): Promise<string | null> {
  // The link comes from feed content, so it must not reach local services.
  const cookie = extras.pageCookie?.(new URL(link));
  const res = await httpGet(link, settings, { headers: { accept: 'text/html,application/xhtml+xml', ...(cookie ? { cookie } : {}) }, publicOnly: true });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return extractArticle(decodeBody(res.body, res.headers.get('content-type')), res.url)?.content ?? null;
}

// Whether the feed's own copy is the better one: a page whose pictures are put in by script (a games site leaves a
// 「加载中」 box in each figure) gives Readability the text without them, while the feed carried both. Kept
// when the feed has at least two pictures, the page under half as many, and the feed most of the text.
export function feedCopyBetter(feedHtml: string | null, pageHtml: string): boolean {
  const pictures = (h: string): number => h.match(/<img\b/gi)?.length ?? 0;
  const textLength = (h: string): number => h.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
  if (!feedHtml) return false;
  const inFeed = pictures(feedHtml);
  return inFeed >= 2 && pictures(pageHtml) < inFeed / 2 && textLength(feedHtml) >= textLength(pageHtml) * 0.7;
}

export interface Article { title: string; byline: string; content: string; siteName: string }

// Main content of a page's HTML, sanitized; null when there is no recognisable article.
export function extractArticle(html: string, baseUrl: string): Article | null {
  const { document } = parseHTML(html);
  // WeChat articles hide the body until JS runs and lazy-load images.
  document.querySelectorAll('[data-src]').forEach((el: Element) => el.setAttribute('src', el.getAttribute('data-src') ?? ''));
  document.querySelectorAll('#js_content').forEach((el: Element) => el.removeAttribute('style'));
  const article = new Readability(document as unknown as Document, { charThreshold: MIN_TEXT }).parse();
  if (!article?.content || (article.textContent ?? '').trim().length < MIN_TEXT) return null;
  return { title: (article.title ?? '').trim(), byline: (article.byline ?? '').trim(), siteName: (article.siteName ?? '').trim(),
    content: sanitize(article.content, baseUrl) };
}
