import type { DB } from '../db.ts';
import type { VectorIndex } from './embed.ts';

// Cosine similarity of unit vectors. "Related" must clear what random pairs of this library
// reach: 99% of them stay under p99 (≈0.56 for bge-m3 here), and neighbours at 0.50–0.55 read as noise.
export const RELATED_FLOOR = 0.55;
export const RELATED_MARGIN = 0.05;
export const PER_FEED_MAX = 3;
// Measured on cross-feed pairs within three days: the same event (a joint livestream, one news item in two papers)
// starts around 0.78–0.86; 0.88 missed most of them. Below 0.80 it is the same topic, not the same story.
export const SAME_STORY_SIM = 0.8;
export const SAME_STORY_WINDOW_S = 3 * 86400;
export const RELATED_LIMIT = 6;
const CANDIDATES = 30;
// The background is re-sampled once the library has grown or shrunk by this share.
const RECALIBRATE_SHARE = 0.1;

let calibrated: { model: string; size: number; min: number } | null = null;
export function relatedThreshold(index: VectorIndex, model: string): number {
  const size = index.size(model);
  if (!calibrated || calibrated.model !== model || Math.abs(size - calibrated.size) > calibrated.size * RECALIBRATE_SHARE) {
    const bg = index.background(model);
    calibrated = { model, size, min: Math.max(RELATED_FLOOR, bg.n ? bg.p99 + RELATED_MARGIN : RELATED_FLOOR) };
  }
  return calibrated.min;
}

export interface RelatedItem {
  id: number; feed_id: number; feed_title: string; title: string; title_zh: string | null; author: string | null; link: string | null;
  published: number; is_read: number; is_starred: number; thumbnail: string | null; enclosures: string | null;
  snippet: string; has_summary: number; is_mark: number;
  sim: number;
  sameStory: boolean;          // another feed's report of the same thing
}

export function relatedEntries(db: DB, index: VectorIndex, model: string, id: number, limit = RELATED_LIMIT): RelatedItem[] {
  const near = index.nearest(model, id, CANDIDATES, relatedThreshold(index, model));
  if (!near.length) return [];
  const self = db.prepare('SELECT feed_id, published FROM entry WHERE id = ?').get(id) as { feed_id: number; published: number } | undefined;
  if (!self) return [];
  const sims = new Map(near.map((n) => [n.id, n.sim]));
  const rows = db.prepare(`SELECT e.id, e.feed_id, f.title AS feed_title, e.title, e.title_zh, e.author, e.link, e.published, e.is_read, e.is_starred,
      e.thumbnail, e.enclosures, '' AS snippet, (e.ai_summary IS NOT NULL) AS has_summary, 0 AS is_mark
    FROM entry e JOIN feed f ON f.id = e.feed_id WHERE e.id IN (${near.map(() => '?').join(',')})`).all(...near.map((n) => n.id)) as Omit<RelatedItem, 'sim' | 'sameStory'>[];
  const items = rows.map((r): RelatedItem => {
    const sim = Number(sims.get(r.id)!.toFixed(4));
    return { ...r, sim, sameStory: sim >= SAME_STORY_SIM && r.feed_id !== self.feed_id && Math.abs(r.published - self.published) <= SAME_STORY_WINDOW_S };
  });
  // The same story elsewhere first, then by similarity; one feed's near-identical reposts count once,
  // and a podcast's own back catalogue does not fill the whole list.
  items.sort((a, b) => Number(b.sameStory) - Number(a.sameStory) || b.sim - a.sim);
  const seenTitles = new Set<string>();
  const perFeed = new Map<number, number>();
  return items.filter((it) => {
    const key = `${it.feed_id}:${it.title.trim()}`;
    const n = perFeed.get(it.feed_id) ?? 0;
    if (seenTitles.has(key) || n >= PER_FEED_MAX) return false;
    seenTitles.add(key);
    perFeed.set(it.feed_id, n + 1);
    return true;
  }).slice(0, limit);
}
