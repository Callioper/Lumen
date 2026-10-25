import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { Embedder, entryText, normalize, dot, EMBED_TEXT_CHARS, EmbedError } from '../server/rec/embed.ts';
import { relatedEntries } from '../server/rec/related.ts';
import type { Settings, Secrets } from '../server/config.ts';

const EMB = { enabled: true, baseUrl: 'https://api.example.com/v1', model: 'm1', batchSize: 2, intervalMs: 10 };
const settings = { embedding: EMB } as unknown as Settings;
const secrets = { embeddingApiKey: 'k' } as Secrets;

// Unit vectors pointing along a few axes, so similarities are known exactly.
const axis = (...xs: number[]): Float32Array => normalize(xs);
const VECS: Record<string, Float32Array> = {
  '火星探测': axis(1, 0, 0), '火星探测器着陆': axis(0.95, 0.31, 0), '火星车新发现': axis(0.7, 0.71, 0), '诗歌': axis(0, 0, 1),
};
const fakeEmbed = async (texts: string[]): Promise<Float32Array[]> => texts.map((t) => VECS[t.split('\n')[0]] ?? axis(0, 1, 0));

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '甲'), (2, 'https://b/feed', '乙'), (3, 'rsshub://douban/people/1/status', '豆瓣')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (?, ?, ?, ?, ?, ?)');
  add.run(1, 1, 'g1', '火星探测', '', 1000);
  add.run(2, 2, 'g2', '火星探测器着陆', '', 2000);
  add.run(3, 1, 'g3', '火星车新发现', '', 9_000_000);
  add.run(4, 2, 'g4', '诗歌', '', 1000);
  add.run(5, 3, 'g5', '某人 想读: 《三河》', '', 1000);
  return db;
}

test('the text is the title plus the summary, or the opening of the body', () => {
  const base = { title: 'T', title_zh: null, content_full: null };
  assert.equal(entryText({ ...base, ai_summary: '<p>摘要 &amp; 要点</p>', content: '<p>正文</p>' }), 'T\n摘要 & 要点');
  assert.equal(entryText({ ...base, ai_summary: null, content: '<p>正文</p>' }), 'T\n正文');
  assert.equal(entryText({ title: 'Mars', title_zh: '火星', ai_summary: null, content: null, content_full: null }), '火星（Mars）');
  // The body's opening is capped on its own; a long summary is cut at the overall limit.
  assert.equal(entryText({ ...base, ai_summary: null, content: 'x'.repeat(9000) }).length, 2 + 1500);
  assert.equal(entryText({ ...base, ai_summary: 'y'.repeat(9000), content: null }).length, EMBED_TEXT_CHARS);
});

test('vectors are stored unit-length, newest first, skipping Douban marks', async () => {
  const db = seed();
  const e = new Embedder(db, () => settings, () => secrets, fakeEmbed);
  assert.equal(await e.runBatch(), 2);
  assert.deepEqual((db.prepare('SELECT entry_id FROM embedding ORDER BY entry_id').all() as { entry_id: number }[]).map((r) => r.entry_id), [3, 4]);
  while (await e.runBatch());
  assert.deepEqual(e.status(), { enabled: true, model: 'm1', done: 4, pending: 0, lastError: null, pausedUntil: 0 });
  const v = e.index.get('m1', 2)!;
  assert.ok(Math.abs(dot(v, v) - 1) < 1e-6);
});

test('a model change re-embeds everything under the new name', async () => {
  const db = seed();
  const e = new Embedder(db, () => settings, () => secrets, fakeEmbed);
  while (await e.runBatch());
  const other = { embedding: { ...EMB, model: 'm2' } } as unknown as Settings;
  assert.equal(new Embedder(db, () => other, () => secrets, fakeEmbed).status().pending, 4);
});

test('related reading puts the same story from another feed first and drops unrelated ones', async () => {
  const db = seed();
  const e = new Embedder(db, () => settings, () => secrets, fakeEmbed);
  while (await e.runBatch());
  const r = relatedEntries(db, e.index, 'm1', 1);
  assert.deepEqual(r.map((x) => [x.id, x.sameStory]), [[2, true], [3, false]]);
  assert.equal(r[0].feed_title, '乙');
  assert.deepEqual(relatedEntries(db, e.index, 'm1', 999), []);
});

test('deleted entries take their vectors with them', async () => {
  const db = seed();
  const e = new Embedder(db, () => settings, () => secrets, fakeEmbed);
  while (await e.runBatch());
  db.prepare('DELETE FROM entry WHERE id = 2').run();
  e.index.reset();
  assert.equal(e.index.size('m1'), 3);
});

test('a failed request leaves the queue untouched', async () => {
  const db = seed();
  const e = new Embedder(db, () => settings, () => secrets, async () => { throw new EmbedError('HTTP 429', true); });
  await assert.rejects(e.runBatch(), /429/);
  assert.equal(e.status().done, 0);
});
