import type { DB } from '../db.ts';
import { dot, type VectorIndex } from './embed.ts';
import { SAME_STORY_SIM, SAME_STORY_WINDOW_S } from './related.ts';
import type { Profile, Cluster } from './profile.ts';
import { keywordHits } from './keywords.ts';

// 推荐 order for one list (第三期): score = 语义 + 新鲜度 + 来源 + 状态 − 负向 − 重复, then MMR with
// per-feed and per-cluster caps, and two 破茧 picks. Weights follow Dibao's scale (reports/).

const W = { semantic: 0.42, recent: 0.18, semanticCap: 0.6, fresh: 0.18, negative: 0.5, source: 0.06, keyword: 0.05, keywordCap: 0.1 } as const;
const RANK_WEIGHTS = [1, 1 / 2, 1 / 3, 1 / 4];
const RANK_NORM = RANK_WEIGHTS.reduce((a, b) => a + b, 0);
const FRESH_HOURS = 36;
const DISCOVERY_GRACE_S = 24 * 3600;         // freshness counts from max(发布, 入库 − 24h): back issues and late fetches are not stale on arrival
const NEW_WITHOUT_VECTOR = 0.1;              // just in, no vector yet
const NEW_WINDOW_S = 72 * 3600;
const STATE = { unread: 0.04, read: -0.06, acted: -0.1 } as const;
const LESS_SOURCE = 0.3;
const DUPLICATE = 0.25;
const SOURCE_PRIOR_N = 5;                    // Bayesian smoothing of each feed's completion rate
const MMR_LAMBDA = 0.75;
const MMR_DEPTH = 120;
const CAP_DEPTH = 20;
const PER_FEED = 4;
const PER_CLUSTER = 6;
export const EXPLORE_AT = [9, 19];           // 0-based: the 10th and 20th place
const EXPLORE_AGE_S = 48 * 3600;
export const EXPLORE_MAX_SEMANTIC = 0.03;

// listed: 学术动态 or 期刊目录 was read out of it — a notice or a table of contents, which has a page of its own.
export interface Candidate { id: number; feed: number; published: number; isRead: boolean; acted: boolean; seen: boolean; feedTitle: string; listed?: boolean }

export interface Ranked {
  id: number;
  score: number;
  reasons: string[];
  explore?: boolean;
  duplicateOf?: number;
}

export interface FeedStat { rate: number; n: number }

// Each feed's share of opened articles that were read to the end, smoothed towards the overall share.
export function feedStats(db: DB): { stats: Map<number, FeedStat>; prior: number } {
  const rows = db.prepare(`SELECT feed_id, SUM(type = 'read_complete') AS done, SUM(type IN ('read_complete', 'skim', 'bounce')) AS n
    FROM event GROUP BY feed_id`).all() as { feed_id: number; done: number; n: number }[];
  const done = rows.reduce((a, r) => a + r.done, 0), n = rows.reduce((a, r) => a + r.n, 0);
  const prior = n ? done / n : 0;
  return { prior, stats: new Map(rows.map((r) => [r.feed_id, { rate: (r.done + SOURCE_PRIOR_N * prior) / (r.n + SOURCE_PRIOR_N), n: r.n }])) };
}

const gain = (sim: number, t: number): number => Math.max(0, Math.min(1, (sim - t) / (1 - t)));

interface Scored extends Ranked { vec?: Float32Array; feed: number; cluster: number; semantic: number; at: number }

function semanticOf(v: Float32Array, p: Profile): { value: number; cluster: number; byCluster: number; recent: number; recentOf: number } {
  const live = p.pos.filter((c) => !c.hidden);
  const parts = live.map((c, i) => ({ i, g: gain(dot(v, c.centroid), p.threshold) * c.weight * c.maturity })).filter((x) => x.g > 0)
    .sort((a, b) => b.g - a.g);
  const byCluster = parts.slice(0, RANK_WEIGHTS.length).reduce((s, x, k) => s + x.g * RANK_WEIGHTS[k], 0) / RANK_NORM * W.semantic;
  let recent = 0, recentOf = 0;
  for (const r of p.recent) {
    const g = gain(dot(v, r.vec), p.threshold) * r.weight * W.recent;
    if (g > recent) { recent = g; recentOf = r.id; }
  }
  return { value: Math.min(W.semanticCap, byCluster + recent), cluster: parts[0] ? p.pos.indexOf(live[parts[0].i]) : -1, byCluster, recent, recentOf };
}

function negativeOf(v: Float32Array, p: Profile): number {
  let worst = 0;
  for (const c of p.neg) if (!c.hidden) worst = Math.max(worst, gain(dot(v, c.centroid), p.threshold) * c.weight * c.maturity);
  return worst * W.negative;
}

// How close one entry is to the reader's interests, net of 少推这类, and which interest it is closest to
// (for reports, which group by interest instead of ordering a list).
export function interestOf(v: Float32Array, p: Profile): { value: number; cluster: Cluster | null } {
  const s = semanticOf(v, p);
  return { value: s.value - negativeOf(v, p), cluster: s.cluster >= 0 ? p.pos[s.cluster] : null };
}

const clusterLabel =(c: Cluster | undefined): string => (c?.name ? `「${c.name}」` : '你喜欢的那类文章');

const TITLE_IN_REASON = 18;

// 「米歇尔·福柯」 reads as 福柯 in a reason.
const shortName = (n: string): string => (n.startsWith('《') ? n : n.split('·').pop() ?? n);
const KEYWORD_SUMMARY_CHARS = 600;
const KEYWORD_CHUNK = 500;

// Which of the reader's names each candidate mentions in its title, author or summary.
function keywordsIn(db: DB, cands: readonly Candidate[], p: Profile): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (p.coldStart || !p.keywords?.length || !p.vocab) return out;
  for (let i = 0; i < cands.length; i += KEYWORD_CHUNK) {
    const ids = cands.slice(i, i + KEYWORD_CHUNK).map((c) => c.id);
    const rows = db.prepare(`SELECT id, COALESCE(title_zh, '') || ' ' || title || ' ' || COALESCE(author, '') || ' ' || substr(COALESCE(ai_summary, ''), 1, ${KEYWORD_SUMMARY_CHARS}) AS t
      FROM entry WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number; t: string }[];
    for (const r of rows) { const hits = keywordHits(p.keywords, r.t, p.vocab); if (hits.length) out.set(r.id, hits); }
  }
  return out;
}

export function rank(cands: Candidate[], p: Profile, index: VectorIndex, model: string, db: DB, now = Math.floor(Date.now() / 1000)): Ranked[] {
  const { stats, prior } = feedStats(db);
  const titles = new Map<number, string>();
  const titleStmt = db.prepare('SELECT COALESCE(title_zh, title) AS t FROM entry WHERE id = ?');
  const titleOf = (id: number): string => {
    if (!titles.has(id)) {
      const t = ((titleStmt.get(id) as { t: string | null } | undefined)?.t ?? '').trim();
      titles.set(id, t.length > TITLE_IN_REASON ? `${t.slice(0, TITLE_IN_REASON)}…` : t);
    }
    return titles.get(id)!;
  };
  // Stories already read or liked: a fresh copy of one of them from another feed is not news.
  const named = keywordsIn(db, cands, p);
  const known = [...p.pos, ...p.neg].flatMap((cl) => cl.members).flatMap((id) => { const v = index.get(model, id); return v ? [{ id, v }] : []; });
  const scored: Scored[] = cands.map((c) => {
    const vec = index.get(model, c.id);
    const discovered = Math.floor(c.id / 1_000_000);
    const at = Math.max(c.published || 0, discovered - DISCOVERY_GRACE_S);
    const fresh = Math.exp(-Math.max(0, now - at) / 3600 / FRESH_HOURS) * W.fresh;
    const reasons: string[] = [];
    let semantic = 0, cluster = -1, negative = 0;
    // What was opened or acted on already would only match itself; it is not pushed up again.
    const handled = c.seen || c.acted;
    const echo = vec && !handled ? known.find((k) => k.id !== c.id && dot(k.v, vec) >= SAME_STORY_SIM) : undefined;
    if (!p.coldStart && vec && !handled && !echo) {
      const s = semanticOf(vec, p);
      semantic = s.value; cluster = s.cluster;
      negative = negativeOf(vec, p);
      if (s.byCluster >= 0.04) reasons.push(`和${clusterLabel(p.pos[s.cluster])}相近`);
      if (s.recent >= 0.03 && s.recentOf !== c.id) reasons.push(`和你这几天读的「${titleOf(s.recentOf)}」相近`);
      if (negative >= 0.1) reasons.push('和你说过「少推这类」的文章有点像，排后了');
    } else if (!p.coldStart && now - discovered < NEW_WINDOW_S) {
      semantic = NEW_WITHOUT_VECTOR;
    }
    const st = stats.get(c.feed);
    const lift = st && prior > 0 ? Math.max(-1, Math.min(1, st.rate / prior - 1)) : 0;
    const source = lift * W.source;
    if (source >= 0.02) reasons.push(`「${c.feedTitle}」的文章你常读完`);
    const less = p.lessSourceFeeds.has(c.feed) ? LESS_SOURCE : 0;
    if (less) reasons.push(`你说过「少推这个源」，排后了`);
    const state = c.acted ? STATE.acted : c.isRead ? STATE.read : STATE.unread;
    const names = handled || echo ? [] : named.get(c.id) ?? [];
    const keyword = Math.min(W.keywordCap, names.length * W.keyword);
    if (names.length) reasons.unshift(`提到了你常看的：${names.slice(0, 2).map(shortName).join('、')}`);
    if (fresh >= 0.12 && reasons.length < 2) reasons.push('新到');
    if (echo) reasons.unshift('同一件事你已经读过了');
    return { id: c.id, vec, feed: c.feed, cluster, semantic, at, reasons, duplicateOf: echo?.id,
      score: semantic + fresh + keyword + source + state - negative - less - (echo ? DUPLICATE : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  markDuplicates(scored);
  scored.sort((a, b) => b.score - a.score);
  const ordered = diversify(scored, p.threshold);
  if (!p.coldStart) insertExplore(ordered, scored, cands, now);
  return ordered.map(({ id, score, reasons, explore, duplicateOf }) => ({ id, score, reasons: reasons.slice(0, 2), explore, duplicateOf }));
}

// The same story from several feeds: the best placed one stays and says so, the others sink.
function markDuplicates(xs: Scored[]): void {
  const kept: Scored[] = [];
  for (const x of xs) {
    if (x.duplicateOf) continue;   // already a copy of something read: says so, and is penalised once
    const twin =x.vec && kept.find((k) => k.vec && Math.abs(k.at - x.at) <= SAME_STORY_WINDOW_S && dot(k.vec, x.vec!) >= SAME_STORY_SIM);
    if (!twin) { kept.push(x); continue; }
    x.duplicateOf = twin.id;
    x.score -= DUPLICATE;
    x.reasons = ['同一件事排在前面的那篇里了'];
    const n = (twin as Scored & { twins?: number }).twins = ((twin as Scored & { twins?: number }).twins ?? 1) + 1;
    twin.reasons = [`${n} 个源都报道了这件事`, ...twin.reasons.filter((r) => !r.includes('个源都报道'))];
  }
}

// MMR over the head of the list; within the first CAP_DEPTH, at most PER_FEED per feed and PER_CLUSTER per cluster.
// Similarity is counted only above the profile's threshold, on the same 0–1 scale as the scores:
// raw cosine (0.6–0.7 between any two articles on one subject) would outweigh the scores themselves.
export function diversify(xs: Scored[], threshold: number): Scored[] {
  const pool = xs.slice(0, MMR_DEPTH);
  const rest = xs.slice(MMR_DEPTH);
  const out: Scored[] = [];
  const perFeed = new Map<number, number>(), perCluster = new Map<number, number>();
  // Each one's closest similarity to what is already placed, updated with each pick rather than
  // recounted against the whole list (that was cubic in the depth: ~370 ms a ranking).
  const maxSim = new Array<number>(pool.length).fill(0);
  while (pool.length) {
    let best = -1, bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const x = pool[i];
      if (out.length < CAP_DEPTH && ((perFeed.get(x.feed) ?? 0) >= PER_FEED || (x.cluster >= 0 && (perCluster.get(x.cluster) ?? 0) >= PER_CLUSTER))) continue;
      const val = MMR_LAMBDA * x.score - (1 - MMR_LAMBDA) * gain(maxSim[i], threshold);
      if (val > bestVal) { bestVal = val; best = i; }
    }
    if (best < 0) best = 0;   // every candidate hits a cap: take the next anyway
    const [x] = pool.splice(best, 1);
    maxSim.splice(best, 1);
    if (x.vec) pool.forEach((o, i) => { if (o.vec) maxSim[i] = Math.max(maxSim[i], dot(o.vec, x.vec!)); });
    out.push(x);
    perFeed.set(x.feed, (perFeed.get(x.feed) ?? 0) + 1);
    if (x.cluster >= 0) perCluster.set(x.cluster, (perCluster.get(x.cluster) ?? 0) + 1);
  }
  return [...out, ...rest];
}

// 破茧: recent, untouched articles that match none of the profile, from two different feeds; something
// to read, so not a lecture notice or a table of contents (they match nothing for being short, not for being far).
function insertExplore(ordered: Scored[], scored: Scored[], cands: Candidate[], now: number): void {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const picks: Scored[] = [];
  for (const x of [...scored].sort((a, b) => b.at - a.at)) {
    const c = byId.get(x.id)!;
    if (picks.length >= EXPLORE_AT.length) break;
    if (c.isRead || c.seen || c.acted || c.listed || x.duplicateOf || x.semantic > EXPLORE_MAX_SEMANTIC || now - x.at > EXPLORE_AGE_S || x.score < 0) continue;
    if (picks.some((p) => p.feed === x.feed)) continue;
    picks.push(x);
  }
  picks.forEach((x, i) => {
    const at = EXPLORE_AT[i];
    if (ordered.length <= at) return;
    const from = ordered.indexOf(x);
    const marked = { ...x, explore: true, reasons: ['破茧：和你平常读的方向不同，换换口味'] };
    if (from <= at) { ordered[from] = marked; return; }   // already that high on its own: keep the place, say why
    ordered.splice(from, 1);
    ordered.splice(at, 0, marked);
  });
}
