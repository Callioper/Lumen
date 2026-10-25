import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { normalize, type VectorIndex } from '../server/rec/embed.ts';
import { collectSignals, buildProfile, cluster, COLD_START_SIGNALS } from '../server/rec/profile.ts';
import { rank, EXPLORE_AT, type Candidate } from '../server/rec/rank.ts';
import { updateCluster, recommendPage, forgetRankings } from '../server/rec/recommend.ts';

const DIM = 64;
const NOW = 1_800_000_000;
// Topic t plus a little of dimension 7, so members of one topic sit close but not on top of each other.
const topic = (t: number, jitter = 0): Float32Array => { const v = new Float32Array(DIM); v[t] = 1; v[7] = 0.25 + jitter; return normalize(v); };
// On topic t but its own article: ≈ 0.75 to the topic, ≈ 0.57 to each other, both below the same-story line.
const distinct = (t: number, k: number): Float32Array => { const v = new Float32Array(DIM); v[t] = 1; v[7] = 0.25; v[10 + k] = 0.9; return normalize(v); };

function fakeIndex(vecs: Map<number, Float32Array>): VectorIndex {
  return {
    get: (_m: string, id: number) => vecs.get(id),
    size: () => vecs.size,
    background: () => ({ n: 1000, p50: 0.1, p95: 0.3, p99: 0.4 }),
  } as unknown as VectorIndex;
}

let nextId = 0;
function world() {
  const db = openDb(':memory:');
  for (const [id, title] of [[1, '甲刊'], [2, '乙刊'], [3, '丙刊'], [4, '丁刊'], [5, '戊刊']] as const) db.prepare('INSERT INTO feed (id, url, title) VALUES (?, ?, ?)').run(id, `https://e.org/${id}`, title);
  const vecs = new Map<number, Float32Array>();
  const add = (feed: number, t: number, opts: { ageH?: number; starred?: boolean; reaction?: string; read?: boolean; jitter?: number; vec?: Float32Array } = {}): number => {
    const at = NOW - (opts.ageH ?? 1) * 3600;
    const id = at * 1_000_000 + nextId++;
    db.prepare('INSERT INTO entry (id, feed_id, guid, title, published, is_starred, reaction, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, feed, `g${id}`, `topic ${t} #${id % 1000}`, at, opts.starred ? 1 : 0, opts.reaction ?? null, opts.read ? 1 : 0);
    vecs.set(id, opts.vec ?? topic(t, opts.jitter ?? (id % 7) * 0.01));
    return id;
  };
  return { db, vecs, add, index: fakeIndex(vecs) };
}

const candidatesOf = (db: ReturnType<typeof world>['db'], ids: number[]): Candidate[] => ids.map((id) => {
  const r = db.prepare('SELECT e.feed_id, e.published, e.is_read, e.is_starred, e.reaction, f.title FROM entry e JOIN feed f ON f.id = e.feed_id WHERE e.id = ?').get(id) as
    { feed_id: number; published: number; is_read: number; is_starred: number; reaction: string | null; title: string };
  return { id, feed: r.feed_id, published: r.published, isRead: !!r.is_read, acted: !!r.is_starred || !!r.reaction, seen: false, feedTitle: r.title };
});

test('signals come from what an entry is now: an unstar of a never-starred entry adds nothing', () => {
  const { db, add } = world();
  const liked = add(1, 0, { reaction: 'like', ageH: 48 });
  const starred = add(1, 0, { starred: true });
  const tidied = add(2, 1);
  db.prepare("INSERT INTO event (entry_id, feed_id, type, weight, created_at) VALUES (?, 2, 'unstar', -6, ?)").run(tidied, NOW);
  const less = add(3, 2, { reaction: 'less_topic' });
  const got = new Map(collectSignals(db, NOW).map((s) => [s.id, s.weight]));
  assert.ok(got.get(liked)! > 7.7 && got.get(liked)! < 7.8);     // 8 × 0.5^(2/45): two days of a 45-day half-life
  assert.ok(got.get(starred)! > 5.9);
  assert.equal(got.has(tidied), false);
  assert.ok(got.get(less)! < -5.9);
});

test('greedy clustering keeps topics apart and the heaviest first', () => {
  const items = [
    { id: 1, feed: 1, vec: topic(0), weight: 8 }, { id: 2, feed: 2, vec: topic(0, 0.05), weight: 6 },
    { id: 3, feed: 1, vec: topic(1), weight: 4 }, { id: 4, feed: 1, vec: topic(2), weight: 1 },
  ];
  const cs = cluster(items, 0.6, 2);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0].members, [1, 2]);
  assert.equal(cs[0].feeds, 2);
  assert.ok(cs[0].maturity > cs[1].maturity);
});

function trained() {
  const w = world();
  // Ten liked articles on topic 0 from two feeds: past the cold start.
  for (let i = 0; i < COLD_START_SIGNALS + 2; i++) w.add(1 + (i % 2), 0, { reaction: 'like', ageH: 100 + i, read: true });
  return w;
}

test('with a profile, articles near what was liked come first; with too few signals the order is by freshness', () => {
  const { db, add, index } = trained();
  const near = add(3, 0, { ageH: 20, vec: distinct(0, 0) });
  const far = add(4, 3, { ageH: 1 });
  const p = buildProfile(db, index, 'm', NOW);
  assert.equal(p.coldStart, false);
  const order = rank(candidatesOf(db, [near, far]), p, index, 'm', db, NOW);
  assert.equal(order[0].id, near);
  assert.match(order[0].reasons[0], /相近/);

  const cold = world();
  const a = cold.add(3, 0, { ageH: 20 }), b = cold.add(4, 3, { ageH: 1 });
  const cp = buildProfile(cold.db, cold.index, 'm', NOW);
  assert.equal(cp.coldStart, true);
  assert.equal(rank(candidatesOf(cold.db, [a, b]), cp, cold.index, 'm', cold.db, NOW)[0].id, b);
});

test('the head of the list holds at most four per feed while others are left', () => {
  const { db, add, index } = trained();
  const ids = Array.from({ length: 30 }, (_, i) => add(3, 0, { ageH: 2 + i, vec: distinct(0, i) }));
  const filler = Array.from({ length: 12 }, (_, i) => add(1 + (i % 2), 6, { ageH: 5 + i, vec: distinct(6, 30 + i) }));
  const order = rank(candidatesOf(db, [...ids, ...filler]), buildProfile(db, index, 'm', NOW), index, 'm', db, NOW);
  // Feed 3 scores best on every count, yet gives up places once it has four.
  assert.ok(order.slice(0, 12).filter((r) => ids.includes(r.id)).length <= 4);
});

test('two 破茧 picks, from different feeds, are lifted to 10th and 20th', () => {
  const { db, add, index } = world();
  // Four interests, so neither the per-feed nor the per-cluster cap lets the odd ones in by itself.
  for (let i = 0; i < 12; i++) add(1 + (i % 2), i % 4, { reaction: 'like', ageH: 100 + i, read: true });
  const good = Array.from({ length: 40 }, (_, i) => add(1 + (i % 5), i % 4, { ageH: 2 + i / 4, vec: distinct(i % 4, i) }));
  const odd = [add(4, 4, { ageH: 40 }), add(5, 5, { ageH: 41 })];
  const order = rank(candidatesOf(db, [...good, ...odd]), buildProfile(db, index, 'm', NOW), index, 'm', db, NOW);
  // Each pick sits at its slot, or higher if diversity already put it there, and says why.
  const at = odd.map((id) => order.findIndex((r) => r.id === id));
  assert.ok(at[0] <= EXPLORE_AT[0] || at[1] <= EXPLORE_AT[0]);
  assert.ok(at.every((i) => i <= EXPLORE_AT[1] && order[i].explore && /破茧/.test(order[i].reasons[0])));
});

test('a lecture notice or a table of contents is never a 破茧 pick', () => {
  const { db, add, index } = world();
  for (let i = 0; i < 12; i++) add(1 + (i % 2), i % 4, { reaction: 'like', ageH: 100 + i, read: true });
  const good = Array.from({ length: 40 }, (_, i) => add(1 + (i % 5), i % 4, { ageH: 2 + i / 4, vec: distinct(i % 4, i) }));
  const odd = [add(4, 4, { ageH: 40 }), add(5, 5, { ageH: 41 })];
  const cands = candidatesOf(db, [...good, ...odd]).map((c) => (odd.includes(c.id) ? { ...c, listed: true } : c));
  const order = rank(cands, buildProfile(db, index, 'm', NOW), index, 'm', db, NOW);
  assert.ok(order.filter((r) => odd.includes(r.id)).every((r) => !r.explore));
});

test('the same story from two feeds keeps one up front and sinks the other', () => {
  const { db, add, index } = trained();
  const a = add(3, 1, { ageH: 2, jitter: 0 });
  const b = add(4, 1, { ageH: 3, jitter: 0.001 });
  const c = add(5, 2, { ageH: 5 });
  const order = rank(candidatesOf(db, [a, b, c]), buildProfile(db, index, 'm', NOW), index, 'm', db, NOW);
  const dup = order.find((r) => r.duplicateOf);
  assert.ok(dup);
  assert.equal(order.at(-1)!.id, dup.id);
  assert.match(order.find((r) => r.id === dup.duplicateOf)!.reasons[0], /2 个源都报道了/);
});

test('a hidden cluster stops pulling its topic up, and a rename keeps it hidden', () => {
  const { db, add, index } = trained();
  const near = add(3, 0, { ageH: 30, vec: distinct(0, 0) });
  const far = add(4, 3, { ageH: 1 });
  const anchor = buildProfile(db, index, 'm', NOW).pos[0].anchor;
  updateCluster(db, anchor, { hidden: true });
  updateCluster(db, anchor, { name: '某个主题' });
  const p = buildProfile(db, index, 'm', NOW);
  assert.equal(p.pos[0].hidden, true);
  assert.equal(p.pos[0].name, '某个主题');
  assert.equal(rank(candidatesOf(db, [near, far]), p, index, 'm', db, NOW)[0].id, far);
});

test('pages after the first come from the same order', () => {
  const { db, add, index } = trained();
  for (let i = 0; i < 12; i++) add(1 + (i % 5), i % 6, { ageH: i });
  forgetRankings();
  const first = recommendPage(db, index, 'm', { filter: 'all' }, 0, 5);
  add(2, 0, { ageH: 0 });   // arrives while scrolling: not slipped into page two
  const second = recommendPage(db, index, 'm', { filter: 'all' }, 5, 5);
  const ids = [...first.items, ...second.items].map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(first.items.every((i) => Array.isArray(i.rec.reasons)));
});

test('an article already opened, or a copy of a story already liked, is not pushed up by the profile', () => {
  const { db, add, index } = trained();
  const liked = db.prepare("SELECT id FROM entry WHERE reaction = 'like' LIMIT 1").get() as { id: number };
  const copy = add(5, 0, { ageH: 2 });
  index.get('m', copy)!.set(index.get('m', liked.id)!);   // the same story, from another feed
  const opened = add(4, 0, { ageH: 2, read: true });
  db.prepare("INSERT INTO event (entry_id, feed_id, type, weight, created_at) VALUES (?, 4, 'skim', 1, ?)").run(opened, NOW);
  const fresh = add(3, 0, { ageH: 3, vec: distinct(0, 1) });
  const cands = candidatesOf(db, [copy, opened, fresh]);
  cands.find((c) => c.id === opened)!.seen = true;
  const order = rank(cands, buildProfile(db, index, 'm', NOW), index, 'm', db, NOW);
  assert.equal(order[0].id, fresh);
  assert.match(order.find((r) => r.id === copy)!.reasons[0], /已经读过/);
});
