import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import type { Settings } from '../server/config.ts';
import { EmbedError, type VectorIndex } from '../server/rec/embed.ts';
import { semanticIds, queryEmbedder, SEMANTIC_MARGIN } from '../server/rec/semantic.ts';
import { listEntries } from '../server/api/queries.ts';

// Similarities as the index would report them, best first.
const fakeIndex = (sims: Record<number, number>): VectorIndex => ({
  nearestTo: (_m: string, _q: Float32Array, k: number, minSim: number) =>
    Object.entries(sims).map(([id, sim]) => ({ id: Number(id), sim })).filter((n) => n.sim >= minSim)
      .sort((a, b) => b.sim - a.sim).slice(0, k),
}) as unknown as VectorIndex;

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '甲号'), (2, 'https://b/feed', '乙号')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, published, is_starred) VALUES (?, ?, ?, ?, ?, ?)');
  add.run(1, 1, 'g1', '一', 1000, 0);
  add.run(2, 1, 'g2', '二', 2000, 1);
  add.run(3, 2, 'g3', '三', 3000, 0);
  add.run(4, 2, 'g4', '四', 4000, 0);
  db.prepare("INSERT INTO tag (entry_id, name, source) VALUES (4, '已存档', 'clip')").run();
  return db;
}
const vec = new Float32Array([1]);

test('what is near the best match comes back, best first; the rest of the pool does not', () => {
  const db = setup();
  const sims = { 1: 0.62, 2: 0.6, 3: 0.62 - SEMANTIC_MARGIN - 0.01, 4: 0.55 };
  assert.deepEqual(semanticIds(db, fakeIndex(sims), 'm', vec, { filter: 'all', q: 'x' }), [1, 2, 4]);
});

test('within one feed the margin is taken from that feed\'s best', () => {
  const db = setup();
  const sims = { 1: 0.65, 2: 0.64, 3: 0.5, 4: 0.48 };
  assert.deepEqual(semanticIds(db, fakeIndex(sims), 'm', vec, { filter: 'all', q: 'x', feed: 2 }), [3, 4]);
});

test('the search filters narrow by time, 收藏 and 已存档', () => {
  const db = setup();
  const sims = { 1: 0.6, 2: 0.6, 3: 0.6, 4: 0.6 };
  const near = (s: object): number[] => semanticIds(db, fakeIndex(sims), 'm', vec, { filter: 'all', q: 'x', ...s }).sort();
  assert.deepEqual(near({ since: 2500 }), [3, 4]);
  assert.deepEqual(near({ kept: 'starred' }), [2]);
  assert.deepEqual(near({ kept: 'archived' }), [4]);
  assert.deepEqual(listEntries(db, { filter: 'all', since: 2500 }, undefined, 10).map((i) => i.id), [4, 3]);
});

test('a query is embedded once and remembered; without the service it says so', async () => {
  let calls = 0;
  const embed = async (texts: string[]) => { calls++; return texts.map(() => new Float32Array([1])); };
  const on = { embedding: { enabled: true, model: 'm' } } as unknown as Settings;
  const q = queryEmbedder(() => on, () => 'k', embed);
  await q('后人类'); await q('后人类');
  assert.equal(calls, 1);
  const off = queryEmbedder(() => on, () => '', embed);
  await assert.rejects(off('后人类'), /没有开启向量服务/);
});

test('a failed connection is tried once more', async () => {
  let calls = 0;
  const embed = async (texts: string[]) => { if (++calls === 1) throw new EmbedError('连不上', true); return texts.map(() => new Float32Array([1])); };
  const on = { embedding: { enabled: true, model: 'm' } } as unknown as Settings;
  await queryEmbedder(() => on, () => 'k', embed)('后人类');
  assert.equal(calls, 2);
});
