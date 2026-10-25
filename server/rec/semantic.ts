// 意思相近: a search by meaning rather than by the words. The query is embedded with the library's
// own model (one call, remembered while the results are paged through), and the articles whose
// vectors are closest come first, within the list's scope and the search filters. Only articles
// with a vector can be found this way; the word search stays the default.
import type { DB } from '../db.ts';
import type { Settings } from '../config.ts';
import type { VectorIndex } from './embed.ts';
import { embedTexts, EmbedError } from './embed.ts';
import { scopeWhere, itemsByIds, type Scope, type ListItem } from '../api/queries.ts';

// A short query sits 0.4–0.65 from every article (bge-m3, measured on six queries, docs §3), so a
// fixed floor admits everything; what is close is what is near the best match. 量子计算: best 0.64,
// within 0.12 nine articles; 后人类: best 0.56, the floor stops it at about 150.
const SCANNED = 2000;                   // the closest this many, before the scope narrows them
export const SEMANTIC_POOL = 200;       // shown at most
export const SEMANTIC_MARGIN = 0.12;
export const SEMANTIC_FLOOR = 0.45;
const CACHED_QUERIES = 50;

export type EmbedQuery = (q: string) => Promise<Float32Array>;

export function queryEmbedder(getSettings: () => Settings, getKey: () => string, embed = embedTexts): EmbedQuery {
  const cache = new Map<string, Float32Array>();
  return async (q) => {
    const settings = getSettings();
    const key = `${settings.embedding.model}\u0000${q}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const apiKey = getKey();
    if (!settings.embedding.enabled || !apiKey) throw new EmbedError('没有开启向量服务，用不了「意思相近」', false);
    // The first call after a while sometimes fails to connect (seen once at 10 s); one more try.
    const once = async (): Promise<Float32Array> => (await embed([q], settings.embedding, settings, apiKey))[0];
    const vec = await once().catch((e: unknown) => { if (e instanceof EmbedError && e.retryable) return once(); throw e; });
    cache.set(key, vec);
    if (cache.size > CACHED_QUERIES) cache.delete(cache.keys().next().value!);
    return vec;
  };
}

// The ids closest to the query that the scope admits, best first; the margin is taken from the
// best one in scope, so searching one feed is not judged against another feed's best match.
export function semanticIds(db: DB, index: VectorIndex, model: string, vec: Float32Array, scope: Scope): number[] {
  const near = index.nearestTo(model, vec, SCANNED, SEMANTIC_FLOOR);
  if (!near.length) return [];
  const w = scopeWhere({ ...scope, q: undefined });
  const admitted = new Set((db.prepare(`SELECT e.id FROM entry e JOIN feed f ON f.id = e.feed_id
    ${w.sql ? w.sql + ' AND' : 'WHERE'} e.id IN (${near.map(() => '?').join(',')})`)
    .all(...w.args, ...near.map((n) => n.id)) as { id: number }[]).map((r) => r.id));
  const inScope = near.filter((n) => admitted.has(n.id));
  return inScope.filter((n) => n.sim >= inScope[0].sim - SEMANTIC_MARGIN).slice(0, SEMANTIC_POOL).map((n) => n.id);
}

export async function semanticSearch(db: DB, index: VectorIndex, model: string, embedQuery: EmbedQuery,
  scope: Scope, offset: number, limit: number): Promise<ListItem[]> {
  const q = scope.q?.trim();
  if (!q) return [];
  const page = semanticIds(db, index, model, await embedQuery(q), scope).slice(offset, offset + limit);
  const byId = new Map(itemsByIds(db, page, scope.snippet === 'long').map((i) => [i.id, i]));
  return page.flatMap((id) => byId.get(id) ?? []);
}
