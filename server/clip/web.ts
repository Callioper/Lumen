// Pages sent by the browser extension: stored as an entry under a paused per-site feed in the
// 「网页剪藏」 category, then archived by the same pipeline as feed entries.
import type { DB } from '../db.ts';
import { tx, newEntryId } from '../db.ts';
import { indexEntry } from '../search.ts';
import { titleHash } from '../fetch/ingest.ts';
import { extractArticle } from '../content/readability.ts';
import { sanitize } from '../content/sanitize.ts';

export const WEB_CATEGORY = '网页剪藏';
const WEB_FEED_PREFIX = 'lumen://web/';
export const MAX_PAGE_HTML = 8_000_000;
const MAX_FIELD = 300;

export interface WebPage {
  url: string; title: string; html: string;
  siteName?: string; author?: string; published?: string;   // read from the live page by the extension
}

export function validatePage(b: unknown): WebPage | string {
  if (!b || typeof b !== 'object') return '请求体应为对象';
  const p = b as Record<string, unknown>;
  if (typeof p.url !== 'string' || !/^https?:\/\//i.test(p.url)) return 'url 应为 http(s) 地址';
  if (typeof p.html !== 'string' || !p.html.trim()) return 'html 不能为空';
  if (p.html.length > MAX_PAGE_HTML) return '页面太大';
  const opt = (k: string): string | undefined => (typeof p[k] === 'string' ? (p[k] as string).trim().slice(0, MAX_FIELD) : undefined);
  return { url: p.url, html: p.html, title: opt('title') ?? '', siteName: opt('siteName'), author: opt('author'), published: opt('published') };
}

// "2026-10-20T10:00:00+08:00", "2026-10-20 10:00", "2026年10月20日 10:00"; China time when no zone is given.
export function parsePublished(s: string | undefined): number | null {
  if (!s) return null;
  const m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})日?(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim());
  if (hasZone) {
    const t = Date.parse(s.trim());
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +sec);
  return Number.isNaN(utc) ? null : Math.floor(utc / 1000);
}

function ensureCategory(db: DB): number {
  db.prepare('INSERT OR IGNORE INTO category (name, sort) VALUES (?, 999)').run(WEB_CATEGORY);
  return (db.prepare('SELECT id FROM category WHERE name = ?').get(WEB_CATEGORY) as { id: number }).id;
}

// One paused feed per site, so the note's source is the site (or WeChat account) name.
function ensureFeed(db: DB, site: string, siteUrl: string): number {
  const url = WEB_FEED_PREFIX + encodeURIComponent(site);
  const found = db.prepare('SELECT id FROM feed WHERE url = ?').get(url) as { id: number } | undefined;
  if (found) return found.id;
  const r = db.prepare("INSERT INTO feed (url, title, site_url, category_id, view, paused, ai_summary) VALUES (?, ?, ?, ?, 'article', 1, 1)")
    .run(url, site, siteUrl, ensureCategory(db));
  return Number(r.lastInsertRowid);
}

export interface SavedPage { id: number; existed: boolean }

export function saveWebPage(db: DB, page: WebPage, now = Math.floor(Date.now() / 1000)): SavedPage {
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  const article = extractArticle(page.html, page.url);
  const site = page.siteName || article?.siteName || host;
  return tx(db, () => {
    const feedId = ensureFeed(db, site, new URL(page.url).origin);
    const dup = db.prepare('SELECT id FROM entry WHERE feed_id = ? AND link = ?').get(feedId, page.url) as { id: number } | undefined;
    if (dup) return { id: dup.id, existed: true };
    // Without a recognisable article the whole page body is kept, sanitized.
    const content = article?.content ?? sanitize(page.html, page.url);
    const title = page.title || article?.title || host;
    const id = newEntryId();
    db.prepare(`INSERT INTO entry (id, feed_id, guid, title, title_hash, author, link, content, published, is_read, read_at, ai_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0)`)
      .run(id, feedId, page.url, title, titleHash(title), (page.author || article?.byline || '').slice(0, MAX_FIELD), page.url, content,
        parsePublished(page.published) ?? now, now);
    indexEntry(db, id);
    return { id, existed: false };
  });
}
