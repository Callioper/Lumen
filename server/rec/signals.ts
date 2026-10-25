import type { DB } from '../db.ts';

// What the reader did with one article, logged for the recommendation profile.
// One weight table for every consumer (profile, source stats, recent intent), so the
// same action never counts differently in two places.
export const EVENT_WEIGHTS = {
  like: 8,
  unlike: -8,
  clip: 8,            // 存档到 Obsidian
  star: 6,
  unstar: -6,
  read_complete: 4,
  skim: 1,
  skip: 0,            // j/k past it in under SKIP_MS: neither interest nor disinterest
  bounce: 0,          // opened and left at once: only feeds the per-source stats
  less_topic: -6,     // 少推这类
  less_source: -6,    // 少推这个源
  less_undo: 6,
} as const;
export type EventType = keyof typeof EVENT_WEIGHTS;

export const REACTIONS = ['like', 'less_topic', 'less_source'] as const;
export type Reaction = (typeof REACTIONS)[number];

export const SKIP_MS = 3_000;
export const BOUNCE_MS = 10_000;
export const BOUNCE_PROGRESS = 0.25;
export const COMPLETE_PROGRESS = 0.9;
// Reading speed used to estimate how long an article takes; Chinese characters per minute.
export const CHARS_PER_MINUTE = 500;
export const COMPLETE_MAX_MS = 60_000;
export const COMPLETE_SHARE = 0.3;
export const COMPLETE_MIN_MS = 5_000;
// A view is stored at most this long; a tab left open overnight is not eight hours of reading.
export const MAX_ACTIVE_MS = 30 * 60_000;

export interface ListContext { listScope?: string; sortMode?: string; position?: number }

// Time an article must be actively on screen before scrolling to its end counts as reading it.
export function completeAfterMs(chars: number): number {
  const estimate = (chars / CHARS_PER_MINUTE) * 60_000;
  return Math.max(COMPLETE_MIN_MS, Math.min(COMPLETE_MAX_MS, estimate * COMPLETE_SHARE));
}

export function classifyView(progress: number, activeMs: number, chars: number): EventType {
  if (activeMs < SKIP_MS) return 'skip';
  if (activeMs < BOUNCE_MS && progress < BOUNCE_PROGRESS) return 'bounce';
  if (progress >= COMPLETE_PROGRESS && activeMs >= completeAfterMs(chars)) return 'read_complete';
  return 'skim';
}

const textLength = (html: string | null): number => (html ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;

export function logEvent(db: DB, entryId: number, type: EventType, extra: ListContext & { progress?: number; activeMs?: number } = {}): void {
  db.prepare(`INSERT INTO event (entry_id, feed_id, type, weight, progress, active_ms, list_scope, sort_mode, position, created_at)
    SELECT id, feed_id, ?, ?, ?, ?, ?, ?, ?, ? FROM entry WHERE id = ?`)
    .run(type, EVENT_WEIGHTS[type], extra.progress ?? null, extra.activeMs ?? null, extra.listScope ?? null, extra.sortMode ?? null,
      extra.position ?? null, Math.floor(Date.now() / 1000), entryId);
}

// The reader reports how far and how long an article was read when it is left.
export function logView(db: DB, entryId: number, progress: number, activeMs: number, ctx: ListContext): EventType | null {
  const row = db.prepare('SELECT content, content_full FROM entry WHERE id = ?').get(entryId) as { content: string | null; content_full: string | null } | undefined;
  if (!row) return null;
  const p = Math.max(0, Math.min(1, progress));
  const ms = Math.max(0, Math.min(MAX_ACTIVE_MS, Math.round(activeMs)));
  const type = classifyView(p, ms, textLength(row.content_full || row.content));
  logEvent(db, entryId, type, { ...ctx, progress: p, activeMs: ms });
  return type;
}

// Sets 喜欢 / 少推这类 / 少推这个源 (null clears it) and logs the change as events that cancel out on undo.
export function setReaction(db: DB, entryId: number, next: Reaction | null): boolean {
  const row = db.prepare('SELECT reaction FROM entry WHERE id = ?').get(entryId) as { reaction: Reaction | null } | undefined;
  if (!row) return false;
  const prev = row.reaction;
  if (prev === next) return true;
  db.prepare('UPDATE entry SET reaction = ? WHERE id = ?').run(next, entryId);
  if (prev === 'like') logEvent(db, entryId, 'unlike');
  else if (prev) logEvent(db, entryId, 'less_undo');
  if (next) logEvent(db, entryId, next);
  return true;
}

export interface ProfileStats {
  days: number;
  signals: number;                                  // events that carry a preference (weight ≠ 0)
  byType: { type: string; n: number }[];
  feeds: { id: number; title: string; score: number; views: number; bounces: number }[];
  recent: { entryId: number; title: string; feed: string; type: string; at: number }[];
  bulkRead: number;                                 // read without opening, so not counted
}

export function profileStats(db: DB, days = 30): ProfileStats {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const byType = db.prepare('SELECT type, COUNT(*) AS n FROM event WHERE created_at >= ? GROUP BY type ORDER BY n DESC').all(since) as ProfileStats['byType'];
  const signals = (db.prepare('SELECT COUNT(*) AS n FROM event WHERE created_at >= ? AND weight != 0').get(since) as { n: number }).n;
  const feeds = db.prepare(`SELECT f.id, f.title, SUM(ev.weight) AS score,
      SUM(ev.type IN ('read_complete','skim','skip','bounce')) AS views, SUM(ev.type = 'bounce') AS bounces
    FROM event ev JOIN feed f ON f.id = ev.feed_id WHERE ev.created_at >= ?
    GROUP BY f.id ORDER BY score DESC, views DESC LIMIT 20`).all(since) as ProfileStats['feeds'];
  const recent = db.prepare(`SELECT ev.entry_id AS entryId, COALESCE(e.title_zh, e.title, '') AS title, COALESCE(f.title, '') AS feed, ev.type, ev.created_at AS at
    FROM event ev LEFT JOIN entry e ON e.id = ev.entry_id LEFT JOIN feed f ON f.id = ev.feed_id
    WHERE ev.weight != 0 ORDER BY ev.id DESC LIMIT 30`).all() as ProfileStats['recent'];
  // Counted from the first recorded event: before that, opened articles left no trace either.
  const first = (db.prepare('SELECT MIN(created_at) AS t FROM event').get() as { t: number | null }).t;
  const bulkRead = first === null ? 0 : (db.prepare(`SELECT COUNT(*) AS n FROM entry e WHERE e.is_read = 1 AND e.read_at >= ?
    AND NOT EXISTS (SELECT 1 FROM event ev WHERE ev.entry_id = e.id)`).get(Math.max(since, first)) as { n: number }).n;
  return { days, signals, byType, feeds, recent, bulkRead };
}
