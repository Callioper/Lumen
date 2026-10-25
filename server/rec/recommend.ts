import type { DB } from '../db.ts';
import type { Settings, Secrets } from '../config.ts';
import { scopeWhere, itemsByIds, type Scope, type ListItem } from '../api/queries.ts';
import { chat } from '../ai/llm.ts';
import { modelBody } from '../ai/translate.ts';
import { log } from '../log.ts';
import type { VectorIndex } from './embed.ts';
import { currentProfile, forgetProfile, type Profile, type Cluster } from './profile.ts';
import { rank, type Candidate, type Ranked } from './rank.ts';

// Candidates: the list's entries found in the last two weeks; a quiet list falls back to its newest.
const WINDOW_S = 14 * 86400;
const MAX_CANDIDATES = 600;
const MIN_CANDIDATES = 100;
const FALLBACK_CANDIDATES = 300;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_KEYS = 20;
const NAMES_PER_BUILD = 4;

export interface RecInfo { reasons: string[]; explore?: boolean }
export interface RecMeta { coldStart: boolean; signals: number; needed: number }
export interface RecPage { items: (ListItem & { rec: RecInfo })[]; meta: RecMeta; total: number }

interface Cached { at: number; key: string; order: Ranked[]; meta: RecMeta }
const cache = new Map<string, Cached>();

function candidates(db: DB, scope: Scope, now: number): Candidate[] {
  const w = scopeWhere(scope);
  const and = w.sql ? ' AND ' : 'WHERE ';
  const select = (extra: string, args: (string | number)[], limit: number): Candidate[] =>
    (db.prepare(`SELECT e.id, e.feed_id AS feed, e.published, e.is_read AS isRead, f.title AS feedTitle,
        (e.is_starred = 1 OR e.reaction IS NOT NULL OR EXISTS (SELECT 1 FROM tag t WHERE t.entry_id = e.id AND t.source = 'clip')) AS acted,
        EXISTS (SELECT 1 FROM event v WHERE v.entry_id = e.id) AS seen,
        EXISTS (SELECT 1 FROM extract x WHERE x.entry_id = e.id AND x.data IS NOT NULL) AS listed
      FROM entry e JOIN feed f ON f.id = e.feed_id ${w.sql}${extra} ORDER BY e.id DESC LIMIT ?`).all(...w.args, ...args, limit) as unknown as
      (Omit<Candidate, 'isRead' | 'acted' | 'seen' | 'listed'> & { isRead: number; acted: number; seen: number; listed: number })[])
      .map((r) => ({ ...r, isRead: !!r.isRead, acted: !!r.acted, seen: !!r.seen, listed: !!r.listed }));
  const recent = select(`${and}e.id >= ?`, [(now - WINDOW_S) * 1_000_000], MAX_CANDIDATES);
  return recent.length >= MIN_CANDIDATES ? recent : select('', [], FALLBACK_CANDIDATES);
}

const scopeKey = (s: Scope): string => JSON.stringify([s.view, s.layout, s.feed, s.category, s.tag, s.q, s.filter]);

// offset 0 ranks afresh; later pages read the same order, so scrolling never reshuffles.
export function recommendPage(db: DB, index: VectorIndex, model: string, scope: Scope, offset: number, limit: number,
  now = Math.floor(Date.now() / 1000)): RecPage {
  const key = scopeKey(scope);
  let c = cache.get(key);
  if (offset === 0 || !c || Date.now() - c.at > CACHE_TTL_MS) {
    const profile = currentProfile(db, index, model);
    const order = rank(candidates(db, scope, now), profile, index, model, db, now);
    c = { at: Date.now(), key, order, meta: { coldStart: profile.coldStart, signals: profile.strongSignals, needed: 8 } };
    cache.delete(key);
    cache.set(key, c);
    while (cache.size > CACHE_KEYS) cache.delete(cache.keys().next().value!);
  }
  const slice = c.order.slice(offset, offset + limit);
  const byId = new Map(itemsByIds(db, slice.map((r) => r.id), scope.snippet === 'long').map((it) => [it.id, it]));
  const items = slice.flatMap((r) => {
    const it = byId.get(r.id);
    return it ? [{ ...it, rec: { reasons: r.reasons, ...(r.explore ? { explore: true } : {}) } }] : [];
  });
  return { items, meta: c.meta, total: c.order.length };
}

export function forgetRankings(): void { cache.clear(); forgetProfile(); }

// The reasons kept for an entry from the last ranking that placed it, for the reader.
export function reasonsFor(id: number): RecInfo | undefined {
  for (const c of cache.values()) {
    const r = c.order.find((x) => x.id === id);
    if (r) return { reasons: r.reasons, ...(r.explore ? { explore: true } : {}) };
  }
  return undefined;
}

export interface ClusterView {
  anchor: number; name: string | null; hidden: boolean; polarity: 'pos' | 'neg';
  size: number; feeds: number; weight: number; maturity: number; samples: { id: number; title: string }[];
}

const SAMPLES = 4;

function view(db: DB, c: Cluster, polarity: 'pos' | 'neg'): ClusterView {
  const get = db.prepare('SELECT id, COALESCE(title_zh, title) AS title FROM entry WHERE id = ?');
  const samples = c.members.slice(0, SAMPLES).flatMap((id) => { const r = get.get(id) as { id: number; title: string } | undefined; return r ? [r] : []; });
  return { anchor: c.anchor, name: c.name, hidden: c.hidden, polarity, size: c.members.length, feeds: c.feeds,
    weight: Math.round(c.weight * 100) / 100, maturity: Math.round(c.maturity * 100) / 100, samples };
}

export interface ProfileView {
  coldStart: boolean; signals: number; needed: number; threshold: number; hasRecent: boolean;
  clusters: ClusterView[];
  keywords: string[];
  compare: { mode: string; opened: number; completed: number }[];
}

export function profileView(db: DB, index: VectorIndex, model: string): ProfileView {
  const p = currentProfile(db, index, model);
  // Opened from the first ten places of each order, and how many of those were read to the end.
  const compare = db.prepare(`SELECT sort_mode AS mode, COUNT(*) AS opened, SUM(type = 'read_complete') AS completed FROM event
    WHERE position < 10 AND sort_mode IS NOT NULL AND type IN ('read_complete', 'skim', 'bounce', 'skip') GROUP BY sort_mode`).all() as ProfileView['compare'];
  return { coldStart: p.coldStart, signals: p.strongSignals, needed: 8, threshold: Math.round(p.threshold * 1000) / 1000, hasRecent: p.recent.length > 0,
    clusters: [...p.pos.map((c) => view(db, c, 'pos')), ...p.neg.map((c) => view(db, c, 'neg'))], keywords: (p.keywords ?? []).map((k) => k.name), compare };
}

export function updateCluster(db: DB, anchor: number, patch: { name?: string | null; hidden?: boolean }): void {
  const cur = db.prepare('SELECT name, hidden, by_user FROM rec_cluster WHERE anchor = ?').get(anchor) as { name: string | null; hidden: number; by_user: number } | undefined;
  const name = patch.name === undefined ? cur?.name ?? null : patch.name;
  const hidden = patch.hidden === undefined ? cur?.hidden ?? 0 : patch.hidden ? 1 : 0;
  // A name the reader cleared goes back to the model; one they typed is theirs.
  const byUser = patch.name === undefined ? cur?.by_user ?? 0 : patch.name === null ? 0 : 1;
  db.prepare(`INSERT INTO rec_cluster (anchor, name, hidden, by_user, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(anchor) DO UPDATE SET name = excluded.name, hidden = excluded.hidden, by_user = excluded.by_user, updated_at = excluded.updated_at`)
    .run(anchor, name, hidden, byUser, Math.floor(Date.now() / 1000));
  forgetRankings();
}

// Clusters of two or more get a short Chinese name from their titles, a few per pass, in the background.
export async function nameClusters(db: DB, index: VectorIndex, settings: Settings, secrets: Secrets, profile?: Profile): Promise<number> {
  if (!secrets.aiApiKey) return 0;
  const p = profile ?? currentProfile(db, index, settings.embedding.model);
  const todo = [...p.pos, ...p.neg].filter((c) => !c.name && c.members.length >= 2).slice(0, NAMES_PER_BUILD);
  let named = 0;
  for (const c of todo) {
    const titles = view(db, c, 'pos').samples.map((s) => `- ${s.title}`).join('\n');
    try {
      const out = await chat([{ role: 'user', content: `下面几篇文章属于同一个阅读兴趣。给这个兴趣起一个 2 到 8 个字的中文名称，像书店分类标签那样具体，只输出名称本身。\n\n${titles}` }],
        settings, secrets.aiApiKey, 1024, 60_000, modelBody(settings.translate.model));
      const name = out.split('\n')[0].replace(/^[「《"“]|[」》"”。]$/g, '').trim().slice(0, 12);
      if (!name) continue;
      db.prepare(`INSERT INTO rec_cluster (anchor, name, hidden, by_user, updated_at) VALUES (?, ?, 0, 0, ?)
        ON CONFLICT(anchor) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at WHERE rec_cluster.by_user = 0`).run(c.anchor, name, Math.floor(Date.now() / 1000));
      named++;
    } catch (e) {
      log.warn(`[rec] naming cluster ${c.anchor}: ${(e as Error).message}`);
      break;
    }
  }
  if (named) forgetRankings();
  return named;
}
