import type { DB } from '../db.ts';
import { dot, normalize, type VectorIndex } from './embed.ts';
import { relatedThreshold } from './related.ts';
import { EVENT_WEIGHTS } from './signals.ts';
import { keywordProfile, vocabulary, people, type Keyword } from './keywords.ts';

// The reader's interests as vectors (第三期, reports/邸报推荐模式调研-2026-10-21.md): one layer of
// clusters over strongly signalled entries, plus a short-term intent from the last three days.

export const POS_CLUSTERS = 24;
export const NEG_CLUSTERS = 16;
const HALF_LIFE_DAYS = 45;
const RECENT_HOURS = 72;
const RECENT_HALF_LIFE_H = 18;
// A read to the end (4) counts as strong; a skim (1) only adds to an entry that has more.
export const STRONG = 4;
export const COLD_START_SIGNALS = 8;

export interface Cluster {
  anchor: number;            // strongest member; names and hiding attach to it
  members: number[];
  centroid: Float32Array;
  weight: number;            // decayed signal, 1 for the heaviest cluster of its polarity
  maturity: number;          // grows with members and with the number of feeds behind them
  feeds: number;
  name: string | null;
  hidden: boolean;
}

export interface Profile {
  pos: Cluster[];
  neg: Cluster[];
  recent: RecentRead[];      // what was read in the last three days, each on its own
  threshold: number;         // a similarity below this says nothing about interest
  strongSignals: number;
  coldStart: boolean;
  lessSourceFeeds: Map<number, number>;   // feed → entries marked 少推这个源
  keywords?: Keyword[];      // 关键词通道: names in the kept articles (server/rec/keywords.ts)
  vocab?: Map<string, string>;
  key: string;
}

// Kept apart rather than averaged: the mean of reads on different subjects sits near the centre of
// the whole library and would call everything "close to what you read".
export interface RecentRead { id: number; vec: Float32Array; weight: number }

interface Signal { id: number; feed: number; weight: number; at: number }

const decay = (ageS: number, halfLifeS: number): number => Math.pow(0.5, Math.max(0, ageS) / halfLifeS);

// Strong signals come from what the entry is now (liked, starred, archived, 少推这类), so undoing
// one simply removes it; reading to the end and skimming come from the event log.
export function collectSignals(db: DB, now: number): Signal[] {
  const rows = db.prepare(`SELECT e.id, e.feed_id AS feed, e.is_starred AS starred, e.reaction,
      EXISTS (SELECT 1 FROM tag t WHERE t.entry_id = e.id AND t.source = 'clip') AS clipped,
      COALESCE((SELECT MAX(created_at) FROM event v WHERE v.entry_id = e.id), e.read_at, e.id / 1000000) AS at,
      (SELECT COALESCE(MAX(CASE type WHEN 'read_complete' THEN ${EVENT_WEIGHTS.read_complete} ELSE 0 END), 0)
        + COALESCE(MAX(CASE type WHEN 'skim' THEN ${EVENT_WEIGHTS.skim} ELSE 0 END), 0) FROM event v WHERE v.entry_id = e.id) AS reading
    FROM entry e
    WHERE e.is_starred = 1 OR e.reaction IN ('like', 'less_topic')
      OR e.id IN (SELECT entry_id FROM tag WHERE source = 'clip')
      OR e.id IN (SELECT entry_id FROM event WHERE type IN ('read_complete', 'skim'))`).all() as {
    id: number; feed: number; starred: number; reaction: string | null; clipped: number; at: number; reading: number }[];
  const halfLife = HALF_LIFE_DAYS * 86400;
  return rows.map((r) => {
    let w = r.reading;
    if (r.reaction === 'like') w += EVENT_WEIGHTS.like;
    if (r.starred) w += EVENT_WEIGHTS.star;
    if (r.clipped) w += EVENT_WEIGHTS.clip;
    if (r.reaction === 'less_topic') w = EVENT_WEIGHTS.less_topic;
    return { id: r.id, feed: r.feed, weight: w * decay(now - r.at, halfLife), at: r.at };
  }).filter((s) => s.weight !== 0);
}

interface Item { id: number; feed: number; vec: Float32Array; weight: number }
export type RawCluster = Omit<Cluster, 'name' | 'hidden' | 'weight'> & { total: number };

// Greedy single-layer clustering: heaviest signals first, each joins the most similar cluster when
// close enough, else starts its own. Only the heaviest `max` clusters are kept.
export function cluster(items: Item[], joinAt: number, max: number): RawCluster[] {
  const out: { members: number[]; sum: Float32Array; centroid: Float32Array; total: number; feeds: Set<number> }[] = [];
  for (const it of [...items].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))) {
    const w = Math.abs(it.weight);
    let best = -1, bestSim = joinAt;
    out.forEach((c, i) => { const s = dot(c.centroid, it.vec); if (s >= bestSim) { best = i; bestSim = s; } });
    if (best < 0) {
      out.push({ members: [it.id], sum: it.vec.map((x) => x * w), centroid: it.vec, total: w, feeds: new Set([it.feed]) });
      continue;
    }
    const c = out[best];
    for (let k = 0; k < c.sum.length; k++) c.sum[k] += it.vec[k] * w;
    c.centroid = normalize(c.sum);
    c.members.push(it.id);
    c.total += w;
    c.feeds.add(it.feed);
  }
  return out.sort((a, b) => b.total - a.total).slice(0, max).map((c) => ({
    anchor: c.members[0], members: c.members, centroid: c.centroid, total: c.total, feeds: c.feeds.size,
    maturity: (1 - Math.exp(-c.members.length / 2)) * (c.feeds.size >= 2 ? 1 : 0.75),
  }));
}


export function buildProfile(db: DB, index: VectorIndex, model: string, now = Math.floor(Date.now() / 1000)): Profile {
  const signals = collectSignals(db, now);
  const withVec = signals.flatMap((s) => { const vec = index.get(model, s.id); return vec ? [{ ...s, vec }] : []; });
  const joinAt = relatedThreshold(index, model);
  const bg = index.size(model) > 50 ? index.background(model).p95 : 0.5;
  const pick = (items: Item[], max: number): Cluster[] => {
    const cs = cluster(items, joinAt, max);
    const top = cs[0]?.total || 1;
    return cs.map((c) => ({ ...c, weight: c.total / top, name: null, hidden: false }));
  };
  const pos = pick(withVec.filter((s) => s.weight > 0), POS_CLUSTERS);
  const neg = pick(withVec.filter((s) => s.weight < 0), NEG_CLUSTERS);
  // Scoring starts where unrelated pairs end (background p95), below the joining threshold: members sit
  // above that by construction, so calibrating on them would leave almost nothing to score.
  const threshold = bg;

  const recentStart = now - RECENT_HOURS * 3600;
  const recentItems = withVec.filter((s) => s.weight > 0 && s.at >= recentStart);
  const recentRaw = recentItems.map((s) => ({ id: s.id, vec: s.vec, weight: s.weight * decay(now - s.at, RECENT_HALF_LIFE_H * 3600) }));
  const recentTop = Math.max(0, ...recentRaw.map((r) => r.weight));
  const recent: RecentRead[] = recentTop >= STRONG * 0.5 ? recentRaw.map((r) => ({ ...r, weight: r.weight / recentTop })) : [];

  applyOverrides(db, pos);
  applyOverrides(db, neg);
  const lessSourceFeeds = new Map((db.prepare("SELECT feed_id, COUNT(*) AS n FROM entry WHERE reaction = 'less_source' GROUP BY feed_id").all() as { feed_id: number; n: number }[])
    .map((r) => [r.feed_id, r.n]));
  const strongSignals = signals.filter((s) => s.weight >= STRONG * 0.5).length;
  const known = people();
  const keywords = keywordProfile(db, signals.filter((s) => s.weight > 0).map((s) => s.id), known);
  return { pos, neg, recent, threshold, strongSignals, coldStart: strongSignals < COLD_START_SIGNALS, lessSourceFeeds, key: profileKey(db, index, model),
    keywords, vocab: vocabulary(known) };
}

// Names and hiding are stored against a member entry, so they follow the cluster as it grows.
function applyOverrides(db: DB, clusters: Cluster[]): void {
  const get = db.prepare('SELECT anchor, name, hidden FROM rec_cluster WHERE anchor = ?');
  for (const c of clusters) {
    for (const id of c.members) {
      const o = get.get(id) as { anchor: number; name: string | null; hidden: number } | undefined;
      if (!o) continue;
      c.anchor = o.anchor; c.name = o.name; c.hidden = !!o.hidden;
      break;
    }
  }
}

// Changes whenever a signal does: rebuilding is cheap, but not per list page.
export function profileKey(db: DB, index: VectorIndex, model: string): string {
  const r = db.prepare(`SELECT (SELECT COALESCE(MAX(id), 0) FROM event) AS ev, (SELECT COUNT(*) FROM entry WHERE is_starred = 1) AS st,
    (SELECT COUNT(*) FROM entry WHERE reaction IS NOT NULL) AS re, (SELECT COUNT(*) FROM tag WHERE source = 'clip') AS cl,
    (SELECT COALESCE(MAX(updated_at), 0) FROM rec_cluster) AS rc, (SELECT COUNT(*) FROM rec_cluster) AS rn`).get() as Record<string, number>;
  return `${Object.values(r).join(':')}:${index.size(model)}:${Math.floor(Date.now() / 3_600_000)}`;
}

let cached: Profile | null = null;
export function currentProfile(db: DB, index: VectorIndex, model: string): Profile {
  const key = profileKey(db, index, model);
  if (!cached || cached.key !== key) cached = buildProfile(db, index, model);
  return cached;
}
export function forgetProfile(): void { cached = null; }
