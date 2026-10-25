import type { DB } from '../db.ts';
import type { Settings } from '../config.ts';
import { httpGet, decodeBody, describeError } from './http.ts';
import { parseFeed } from './parse.ts';
import { ingest, BACKLOG_WINDOW, type FeedRow } from './ingest.ts';
import { log } from '../log.ts';
import { warmFeedCovers, warmUnreadImages } from '../api/media.ts';

const TICK_MS = 30_000;
const MAX_BACKOFF = 86_400;
const RSSHUB_TIMEOUT_MS = 75_000;
const SLOW_FEED_TIMEOUT_MS = 120_000;

export function resolveFeedUrl(url: string, settings: Settings): string {
  return url.startsWith('rsshub://') ? settings.rsshubBase.replace(/\/$/, '') + '/' + url.slice('rsshub://'.length) : url;
}

const DUE_WINDOW = 200;

export function nextDelay(feed: Pick<FeedRow, 'ttl' | 'error_count'>, settings: Settings, ok: boolean, retryAfter?: number): number {
  const ttl = feed.ttl || settings.defaultTtl;
  if (retryAfter) return Math.min(Math.max(retryAfter, 60), MAX_BACKOFF);
  if (ok) return Math.round(ttl * (0.9 + Math.random() * 0.2));   // jitter spreads load (douban!)
  return Math.min(ttl * 2 ** Math.min(feed.error_count, 5), MAX_BACKOFF);
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((t - Date.now()) / 1000));
}

export interface FetchOutcome { ok: boolean; added: number; error?: string }

export async function fetchFeed(db: DB, feed: FeedRow, settings: Settings): Promise<FetchOutcome> {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.8' };
  if (feed.etag) headers['if-none-match'] = feed.etag;
  if (feed.last_modified) headers['if-modified-since'] = feed.last_modified;
  const done = (ok: boolean, err: string | null, retryAfter?: number, extra: Record<string, unknown> = {}): void => {
    const errorCount = ok ? 0 : feed.error_count + 1;
    const delay = nextDelay({ ...feed, error_count: errorCount }, settings, ok, retryAfter);
    db.prepare(`UPDATE feed SET last_fetch_at = ?, next_fetch_at = ?, error_count = ?, last_error = ?,
      last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END,
      etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
      site_url = COALESCE(site_url, ?), icon_url = COALESCE(icon_url, ?),
      title = CASE WHEN title = url AND ? <> '' THEN ? ELSE title END WHERE id = ?`)
      .run(now, now + delay, errorCount, err, ok ? 1 : 0, now,
        (extra.etag as string) ?? null, (extra.lastModified as string) ?? null,
        (extra.siteUrl as string) || null, (extra.image as string) || null,
        // A feed added by its address alone is titled with it until the feed names itself.
        (extra.title as string) ?? '', (extra.title as string) ?? '', feed.id);
  };
  try {
    const isRsshub = feed.url.startsWith('rsshub://');
    // The bridge renders some routes in a headless browser; it gives up at 60s itself.
    // A feed that timed out last time gets a longer budget: wechat2rss serves 5MB files
    // through a slow tunnel, so the default is too short for it but fine for everything else.
    const timedOut = feed.error_count > 0 && /超时/.test(feed.last_error ?? '');
    const timeoutMs = Math.max(isRsshub ? RSSHUB_TIMEOUT_MS : settings.fetchTimeoutMs, timedOut ? SLOW_FEED_TIMEOUT_MS : 0);
    const res = await httpGet(resolveFeedUrl(feed.url, settings), settings, { headers, timeoutMs });
    if (res.status === 304) { done(true, null); return { ok: true, added: 0 }; }
    if (res.status >= 400) {
      // The bridge answers failures with a plain-text reason worth surfacing.
      const reason = isRsshub ? decodeBody(res.body, res.headers.get('content-type')).split('\n')[0].slice(0, 160) : '';
      const err = `HTTP ${res.status}${reason ? ' ' + reason : ''}`;
      done(false, err, res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get('retry-after')) : undefined);
      return { ok: false, added: 0, error: err };
    }
    const parsed = await parseFeed(decodeBody(res.body, res.headers.get('content-type')));
    const added = ingest(db, feed, parsed, { aiEnabled: settings.ai.enabled, retention: BACKLOG_WINDOW });
    done(true, null, undefined, {
      etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'),
      siteUrl: parsed.siteUrl, image: parsed.image, title: parsed.title.trim(),
    });
    return { ok: true, added };
  } catch (e) {
    const err = describeError(e);
    done(false, err);
    return { ok: false, added: 0, error: err };
  }
}

export class Scheduler {
  private running = new Set<number>();
  private hostLoad = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private db: DB;
  private getSettings: () => Settings;
  private onAdded: () => void;

  constructor(db: DB, getSettings: () => Settings, onAdded: () => void) {
    this.db = db;
    this.getSettings = getSettings;
    this.onAdded = onAdded;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get busy(): number { return this.running.size; }

  private host(feed: FeedRow): string {
    try { return new URL(resolveFeedUrl(feed.url, this.getSettings())).host; } catch { return '?'; }
  }

  async tick(): Promise<void> {
    const settings = this.getSettings();
    const slots = settings.fetchConcurrency - this.running.size;
    if (slots <= 0) return;
    const now = Math.floor(Date.now() / 1000);
    // Read well past the free slots: when the earliest due are all on one host (a hundred rsshub:// feeds
    // after a restart), a window of slots × 4 held only those, and the other feeds waited behind them.
    const due = this.db.prepare('SELECT * FROM feed WHERE paused = 0 AND next_fetch_at <= ? ORDER BY next_fetch_at LIMIT ?')
      .all(now, Math.max(slots * 4, DUE_WINDOW)) as unknown as FeedRow[];
    let started = 0;
    for (const feed of due) {
      if (started >= slots) break;
      if (this.running.has(feed.id)) continue;
      const host = this.host(feed);
      if ((this.hostLoad.get(host) ?? 0) >= settings.perHostConcurrency) continue;
      started++;
      void this.run(feed, host);
    }
  }

  async run(feed: FeedRow, host = this.host(feed)): Promise<FetchOutcome> {
    this.running.add(feed.id);
    this.hostLoad.set(host, (this.hostLoad.get(host) ?? 0) + 1);
    try {
      const out = await fetchFeed(this.db, feed, this.getSettings());
      if (out.added) {
        log.info(`[fetch] ${feed.title}: +${out.added}`);
        this.onAdded();
        void warmFeedCovers(this.db, feed.id, out.added, this.getSettings()).catch((e) => log.warn(`[img] warm ${feed.title}: ${(e as Error).message}`));
        void warmUnreadImages(this.db, this.getSettings()).catch((e) => log.warn(`[img] 预取文章图片：${(e as Error).message}`));
      }
      else if (!out.ok) log.warn(`[fetch] ${feed.title}: ${out.error}`);
      return out;
    } finally {
      this.running.delete(feed.id);
      this.hostLoad.set(host, (this.hostLoad.get(host) ?? 1) - 1);
      // Keep the pipeline full instead of waiting for the next tick.
      setImmediate(() => void this.tick());
    }
  }

  async refreshNow(feedId?: number): Promise<FetchOutcome | null> {
    if (feedId === undefined) {
      this.db.prepare('UPDATE feed SET next_fetch_at = 0 WHERE paused = 0').run();
      void this.tick();
      return null;
    }
    const feed = this.db.prepare('SELECT * FROM feed WHERE id = ?').get(feedId) as unknown as FeedRow | undefined;
    if (!feed) throw new Error('源不存在');
    if (this.running.has(feed.id)) return { ok: true, added: 0, error: '正在抓取' };
    return this.run(feed);
  }
}
