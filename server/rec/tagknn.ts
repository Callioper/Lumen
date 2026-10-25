// 标签 by nearest neighbours: an article gets the tags most of its ten closest LLM-tagged articles
// share. Measured on 1363 tagged articles (docs/简报周报检索存储方案.md §1.1): a tag at least half the
// neighbours carry agrees with the LLM 78% of the time. Used where tagging alone would cost a model
// call, and to tag the old library for free. Written with source 'knn', kept apart from 'ai'.
import type { DB } from '../db.ts';
import type { VectorIndex } from './embed.ts';
import type { Settings } from '../config.ts';
import { dot } from './embed.ts';
import { log } from '../log.ts';

export const KNN_K = 10;
export const KNN_MIN_SHARE = 0.5;
const KNN_MAX_TAGS = 2;
const MIN_REFERENCES = 200;          // fewer tagged articles than this and the vote means little
const BACKFILL_BATCH = 100;

interface Reference { id: number; vec: Float32Array; tags: string[] }

// The tagged articles the vote is taken among; rebuilt per pass (cheap next to the vote itself).
export function references(db: DB, index: VectorIndex, model: string): Reference[] {
  const rows = db.prepare("SELECT entry_id AS id, group_concat(name, char(31)) AS tags FROM tag WHERE source = 'ai' GROUP BY entry_id").all() as { id: number; tags: string }[];
  return rows.flatMap((r) => { const vec = index.get(model, r.id); return vec ? [{ id: r.id, vec, tags: r.tags.split('\x1f') }] : []; });
}

// The tags at least KNN_MIN_SHARE of the K nearest references carry, most shared first.
export function voteTags(vec: Float32Array, refs: readonly Reference[], self = -1, k = KNN_K, minShare = KNN_MIN_SHARE): string[] {
  const top: { sim: number; tags: string[] }[] = [];
  for (const r of refs) {
    if (r.id === self) continue;
    const sim = dot(vec, r.vec);
    if (top.length >= k && sim <= top[top.length - 1].sim) continue;
    top.push({ sim, tags: r.tags });
    top.sort((a, b) => b.sim - a.sim);
    if (top.length > k) top.pop();
  }
  if (top.length < k) return [];
  const votes = new Map<string, number>();
  for (const t of top) for (const tag of new Set(t.tags)) votes.set(tag, (votes.get(tag) ?? 0) + 1);
  return [...votes].filter(([, n]) => n / k >= minShare).sort((a, b) => b[1] - a[1]).slice(0, KNN_MAX_TAGS).map(([tag]) => tag);
}

// A fresh article (ids are arrival times in microseconds) whose vector is still on its way; past
// VECTOR_WAIT the embedder is presumably stuck and the model is asked instead.
const VECTOR_WAIT_MS = 10 * 60_000;
export function awaitsVector(index: VectorIndex, settings: Settings, hasKey: boolean, id: number, now = Date.now()): boolean {
  return settings.embedding.enabled && hasKey && !index.get(settings.embedding.model, id) && now - id / 1000 < VECTOR_WAIT_MS;
}

export function enoughReferences(refs: readonly Reference[]): boolean { return refs.length >= MIN_REFERENCES; }

const insertKnn = (db: DB, id: number, tags: string[]): void => {
  const ins = db.prepare("INSERT OR IGNORE INTO tag (entry_id, name, source) VALUES (?, ?, 'knn')");
  for (const t of tags) ins.run(id, t);
};

// One article, when it has a vector: the tags written, or null when the vote was not clear enough.
export function tagByNeighbours(db: DB, index: VectorIndex, model: string, id: number, refs = references(db, index, model)): string[] | null {
  const vec = index.get(model, id);
  if (!vec || !enoughReferences(refs)) return null;
  const tags = voteTags(vec, refs, id);
  if (!tags.length) return null;
  insertKnn(db, id, tags);
  return tags;
}

// Articles with a vector and no tag of any kind but the feed's own; checked once each (knn_checked).
const UNTAGGED = `SELECT e.id FROM entry e JOIN feed f ON f.id = e.feed_id
  WHERE f.view = 'article' AND e.knn_checked IS NULL
    AND NOT EXISTS (SELECT 1 FROM tag t WHERE t.entry_id = e.id AND t.source IN ('ai', 'knn', 'user'))
    AND EXISTS (SELECT 1 FROM embedding m WHERE m.entry_id = e.id AND m.model = ?)
  ORDER BY e.id DESC`;

let backfilling = false;
// The old library, in batches between which the server answers; done in a few minutes, then each
// pass only sees what arrived since.
export function backfillKnnTags(db: DB, index: VectorIndex, model: string): void {
  if (backfilling) return;
  const refs = references(db, index, model);
  if (!enoughReferences(refs)) return;
  const ids = (db.prepare(UNTAGGED).all(model) as { id: number }[]).map((r) => r.id);
  if (!ids.length) return;
  backfilling = true;
  const started = Date.now();
  let at = 0, tagged = 0;
  const mark = db.prepare('UPDATE entry SET knn_checked = 1 WHERE id = ?');
  const step = (): void => {
    try {
      db.exec('BEGIN');
      for (const id of ids.slice(at, at + BACKFILL_BATCH)) {
        if (tagByNeighbours(db, index, model, id, refs)) tagged++;
        mark.run(id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      backfilling = false;
      log.error(`[tags] 补标签中断：${(e as Error).message}`);
      return;
    }
    at += BACKFILL_BATCH;
    if (at < ids.length) { setImmediate(step); return; }
    backfilling = false;
    log.info(`[tags] 按相近文章补标签：查了 ${ids.length} 篇，打上 ${tagged} 篇，${Math.round((Date.now() - started) / 1000)} 秒`);
  };
  setImmediate(step);
}
