import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.ts';
import { DATA_DIR, type Settings } from '../config.ts';
import { httpGet } from '../fetch/http.ts';
import { isPrivateHostname, BlockedAddressError } from '../fetch/guard.ts';
import { ImageCache } from './imgcache.ts';
import { EFFECTIVE_LAYOUT_SQL } from './queries.ts';
import { log } from '../log.ts';

export const ICON_DIR = join(DATA_DIR, 'icons');
const NEGATIVE_TTL_MS = 86_400_000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// Only passive formats: an SVG (or anything else that can carry script) served from our
// origin and opened as a page would run with full access to the API.
const SAFE_MEDIA = /^(image\/(png|jpeg|pjpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/(mp4|webm|ogg|quicktime))$/;
const ICON_FALLBACK_TYPE = 'image/x-icon';

const mediaType = (raw: string | null): string => (raw ?? '').split(';')[0].trim().toLowerCase();

// Belt and braces for proxied bytes: even if a type slips through, it cannot run script or be framed.
const MEDIA_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  // Not same-origin: article images are asked for from Lumen's other loopback name (web/src/util.ts
  // imageOrigin). An image anyone may embed is no secret; script and framing stay shut above.
  'cross-origin-resource-policy': 'cross-origin',
};

// Hotlink-protected hosts (douban 418, sspai 403) accept their own origin as referer;
// WeChat's CDN only accepts no referer at all.
export function refererFor(u: URL): string | undefined {
  if (/(qpic\.cn|qlogo\.cn)$/.test(u.hostname)) return undefined;
  return u.origin + '/';
}

// Hosts that resize on request. Bilibili's CDN returns a webp of the given width for "@<w>w.webp";
// its originals are full-size screenshots, far larger than a cover needs.
export function coverUrl(raw: string, width?: number): string {
  if (width && /^https?:\/\/i\d\.hdslb\.com\/bfs\//.test(raw) && !raw.includes('@')) return `${raw}@${width}w.webp`;
  // Weibo serves 2000px originals; mw690 is its own 690px rendition.
  if (width && /^https?:\/\/\w+\.sinaimg\.cn\/(mw2000|large)\//.test(raw)) return raw.replace(/\/(mw2000|large)\//, '/mw690/');
  return raw;
}

// wechat2rss hands out its images through its own relay (…/img-proxy/?k=…&u=<the mmbiz URL>), a
// tunnel that took 3–7 s an image and timed out on some (measured 10-23); the original on WeChat's
// CDN answers in under 0.2 s. Six such images in flight held the browser's every connection to
// Lumen, so opening the next article waited behind them.
export function unwrapRelay(raw: string): string {
  try {
    const u = new URL(raw);
    const inner = u.searchParams.get('u');
    return /\/img-proxy\/?$/.test(u.pathname) && inner && /^https?:\/\//.test(inner) ? inner : raw;
  } catch { return raw; }
}

// 1080 is the share card's cover (web/src/share).
export const COVER_WIDTHS = [160, 480, 520, 1080] as const;

const imageCache = new ImageCache();
const inflight = new Map<string, Promise<Response>>();
const CACHE_HEADERS = { 'cache-control': 'public, max-age=1209600, immutable' };

const served = (body: Buffer, type: string, from: string): Response =>
  new Response(new Uint8Array(body), { headers: { ...MEDIA_HEADERS, 'content-type': type, ...CACHE_HEADERS, 'x-lumen-cache': from } });

export async function proxyImage(raw: string, settings: Settings, width?: number): Promise<Response> {
  let u: URL;
  try { u = new URL(coverUrl(unwrapRelay(raw), width)); } catch { return new Response('bad url', { status: 400 }); }
  if (!/^https?:$/.test(u.protocol) || isPrivateHostname(u.hostname)) return new Response('forbidden', { status: 403 });
  const key = u.toString();
  const hit = imageCache.get(key);
  if (hit && SAFE_MEDIA.test(hit.type)) return served(hit.body, hit.type, 'hit');
  // A warm-up and a viewer asking for the same cover share one download.
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchImage(u, settings).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return (await pending).clone();
}

// Bilibili's i0/i1/i2 hosts serve the same files, and one of them at times resets every
// connection from here (seen on i2, 10-21) while the others answer.
export function mirrorsOf(u: URL): URL[] {
  const m = /^i(\d)\.hdslb\.com$/.exec(u.hostname);
  if (!m) return [];
  return ['0', '1', '2'].filter((n) => n !== m[1]).map((n) => { const v = new URL(u); v.hostname = `i${n}.hdslb.com`; return v; });
}

async function download(u: URL, settings: Settings): ReturnType<typeof httpGet> {
  const ref = refererFor(u);
  return httpGet(u.toString(), settings, {
    headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...(ref ? { referer: ref } : {}) },
    maxBytes: MAX_IMAGE_BYTES, timeoutMs: 20000, publicOnly: true,
  });
}

async function fetchImage(u: URL, settings: Settings): Promise<Response> {
  let res;
  try {
    res = await download(u, settings);
  } catch (e) {
    if (e instanceof BlockedAddressError) return new Response('forbidden', { status: 403 });
    let retried: Awaited<ReturnType<typeof httpGet>> | undefined;
    for (const alt of mirrorsOf(u)) {
      try { retried = await download(alt, settings); break; } catch { /* next mirror */ }
    }
    if (!retried) throw e;
    res = retried;
  }
  const type = mediaType(res.headers.get('content-type'));
  if (res.status >= 400) return new Response(null, { status: res.status });
  if (!SAFE_MEDIA.test(type)) return new Response('unsupported media type', { status: 415 });
  if (type.startsWith('image/')) {
    try { imageCache.put(u.toString(), res.body, type); } catch (e) { log.warn(`[img] cache write failed: ${(e as Error).message}`); }
  }
  return served(res.body, type, 'miss');
}

// Fetches covers into the cache in the background, a few at a time; failures are ignored,
// the viewer will simply fetch them live.
export async function warmCovers(urls: readonly string[], width: number | undefined, settings: Settings, concurrency = 3): Promise<number> {
  const todo = [...new Set(urls)].filter((raw) => {
    try { return !imageCache.has(new URL(coverUrl(unwrapRelay(raw), width)).toString()); } catch { return false; }
  });
  let warmed = 0;
  const worker = async (): Promise<void> => {
    for (let raw = todo.shift(); raw; raw = todo.shift()) {
      try { if ((await proxyImage(raw, settings, width)).ok) warmed++; } catch { /* left for the viewer */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return warmed;
}

// ── the images of unread articles, fetched before they are opened ────────────────────────────────
// Opening an article used to wait on its images: fetched only then, from CDNs that can take seconds
// each, while they held the browser's connections to Lumen. Now the unread articles of the last
// few days have theirs in the cache already, at the key the reader asks for (/img?u=<src>).
const WARM_DAYS = 3;
const WARM_ENTRIES = 300;
const WARM_IMAGES_PER_ENTRY = 60;
const WARM_CONCURRENCY = 2;     // in the background: the reader's own requests come first
const IMG_SRC = /<img\b[^>]*?\ssrc="([^"]+)"/gi;

export function contentImageUrls(html: string): string[] {
  const urls = [...html.matchAll(IMG_SRC)].map((m) => normalizeImageUrl(m[1])).filter(Boolean);
  return [...new Set(urls)].slice(0, WARM_IMAGES_PER_ENTRY);
}

let warmingContent = false;
// One pass at a time; a pass asked for while one runs is skipped, the next sweep picks it up.
export async function warmUnreadImages(db: DB, settings: Settings, now = Date.now()): Promise<number> {
  if (warmingContent) return 0;
  warmingContent = true;
  try {
    const rows = db.prepare(`SELECT COALESCE(e.content_full, e.content) AS html FROM entry e JOIN feed f ON f.id = e.feed_id
      WHERE e.is_read = 0 AND e.published > ? AND f.view IN ('article', 'social') ORDER BY e.published DESC LIMIT ?`)
      .all(Math.floor(now / 1000) - WARM_DAYS * 86400, WARM_ENTRIES) as { html: string | null }[];
    const urls = rows.flatMap((r) => contentImageUrls(r.html ?? ''));
    const warmed = await warmCovers(urls, undefined, settings, WARM_CONCURRENCY);
    if (warmed) log.info(`[img] 预取未读文章图片 ${warmed} 张`);
    return warmed;
  } finally {
    warmingContent = false;
  }
}

// The width each layout shows covers at, matching proxiedCover in the web app. Lists that show
// no cover (标题流, 简报) are not warmed.
const LAYOUT_COVER_WIDTH: Record<string, number> = { masonry: 520, cards: 480, list: 160, social: 160 };

// After a fetch: puts the new entries' covers in the cache at the size their list will ask for.
export async function warmFeedCovers(db: DB, feedId: number, added: number, settings: Settings): Promise<number> {
  const row = db.prepare(`SELECT ${EFFECTIVE_LAYOUT_SQL} AS layout FROM feed f WHERE f.id = ?`).get(feedId) as { layout: string } | undefined;
  const width = row && LAYOUT_COVER_WIDTH[row.layout];
  if (!width || added <= 0) return 0;
  const urls = (db.prepare('SELECT thumbnail FROM entry WHERE feed_id = ? AND thumbnail IS NOT NULL ORDER BY id DESC LIMIT ?')
    .all(feedId, added) as { thumbnail: string }[]).map((r) => normalizeImageUrl(r.thumbnail)).filter(Boolean);
  return warmCovers(urls, width, settings);
}

// The same clean-up the web app does before asking /img for an entry's thumbnail.
export function normalizeImageUrl(url: string): string {
  const abs = url.startsWith('//') ? 'https:' + url : url;
  return /^https?:\/\//.test(abs) ? abs.replace(/&amp;/g, '&') : '';
}

export function pruneImageCache(): number {
  return imageCache.prune();
}

interface IconFeed { id: number; url: string; site_url: string | null; icon_url: string | null }

export async function feedIcon(db: DB, id: number, settings: Settings): Promise<Response> {
  mkdirSync(ICON_DIR, { recursive: true });
  const file = join(ICON_DIR, String(id));
  // Known to have none: the browser may remember that too, instead of asking on every list. 204, not 404:
  // the <img> still fails and shows the letter, but the console doesn't log a failed load for each feed.
  if (existsSync(file + '.none') && Date.now() - statSync(file + '.none').mtimeMs < NEGATIVE_TTL_MS) return noIcon();
  if (existsSync(file)) {
    const stored = existsSync(file + '.type') ? mediaType(readFileSync(file + '.type', 'utf8')) : '';
    // A few icons migrated from FreshRSS are SVG; the sandbox CSP in MEDIA_HEADERS keeps them inert.
    // New fetches never store SVG.
    const type = SAFE_MEDIA.test(stored) || stored === 'image/svg+xml' ? stored : ICON_FALLBACK_TYPE;
    return new Response(readFileSync(file), { headers: { ...MEDIA_HEADERS, 'content-type': type, 'cache-control': 'public, max-age=604800' } });
  }
  const feed = db.prepare('SELECT id, url, site_url, icon_url FROM feed WHERE id = ?').get(id) as unknown as IconFeed | undefined;
  if (!feed) return new Response(null, { status: 404 });
  const site = feed.site_url && /^https?:/.test(feed.site_url) ? feed.site_url : null;
  const candidates = [feed.icon_url, site && new URL('/favicon.ico', site).toString()].filter(Boolean) as string[];
  // Nothing to try yet (a feed not fetched once): not remembered as iconless, or its icon would stay
  // missing for a day after the first fetch filled in the site.
  if (!candidates.length) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  for (const c of candidates) {
    try {
      const u = new URL(c);
      const ref = refererFor(u);
      const res = await httpGet(c, settings, { maxBytes: 2 * 1024 * 1024, timeoutMs: 10000, headers: ref ? { referer: ref } : {}, publicOnly: true });
      const served = mediaType(res.headers.get('content-type'));
      // Many servers label favicon.ico as octet-stream; anything non-raster is stored as an icon type.
      const type = SAFE_MEDIA.test(served) ? served : /\.ico$/i.test(u.pathname) && !served.startsWith('image/') ? ICON_FALLBACK_TYPE : '';
      if (res.status < 400 && res.body.length > 0 && type) {
        writeFileSync(file, res.body);
        writeFileSync(file + '.type', type);
        return new Response(new Uint8Array(res.body), { headers: { ...MEDIA_HEADERS, 'content-type': type, 'cache-control': 'public, max-age=604800' } });
      }
    } catch {
      // try next candidate
    }
  }
  writeFileSync(file + '.none', '');
  return noIcon();
}

const noIcon = (): Response => new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=86400' } });
