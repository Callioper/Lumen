import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { classifyView, completeAfterMs, logView, setReaction, logEvent, profileStats, COMPLETE_MAX_MS, COMPLETE_MIN_MS } from '../server/rec/signals.ts';

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '博客'), (2, 'https://b/feed', '期刊')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (?, ?, ?, ?, ?, 0)');
  add.run(1, 1, 'g1', '长文', `<p>${'字'.repeat(5000)}</p>`);
  add.run(2, 1, 'g2', '短讯', '<p>一句话的短讯</p>');
  add.run(3, 2, 'g3', '论文', '');
  return db;
}
const events = (db: ReturnType<typeof seed>) =>
  db.prepare('SELECT entry_id, feed_id, type, weight, list_scope, position FROM event ORDER BY id').all() as Record<string, unknown>[];

test('scrolling to the end of a long article only counts as read after enough active time', () => {
  // 5000 characters ≈ 10 minutes at 500/min; 30% of that is capped at one minute.
  assert.equal(completeAfterMs(5000), COMPLETE_MAX_MS);
  assert.equal(classifyView(1, 20_000, 5000), 'skim');
  assert.equal(classifyView(1, 61_000, 5000), 'read_complete');
});

test('short articles complete quickly but never under the floor', () => {
  assert.equal(completeAfterMs(10), COMPLETE_MIN_MS);
  assert.equal(classifyView(1, 6_000, 10), 'read_complete');
});

test('a quick pass with j/k is neutral and a quick exit is a bounce', () => {
  assert.equal(classifyView(1, 2_000, 10), 'skip');
  assert.equal(classifyView(0.1, 8_000, 5000), 'bounce');
  assert.equal(classifyView(0.5, 8_000, 5000), 'skim');
});

test('a view is stored with its list context and clamped values', () => {
  const db = seed();
  assert.equal(logView(db, 1, 1.7, 99 * 3600_000, { listScope: 'feed:1', sortMode: 'latest', position: 3 }), 'read_complete');
  const row = { ...(db.prepare('SELECT progress, active_ms, sort_mode FROM event').get() as Record<string, unknown>) };
  assert.deepEqual(row, { progress: 1, active_ms: 30 * 60_000, sort_mode: 'latest' });
  assert.equal(events(db)[0].position, 3);
  assert.equal(logView(db, 999, 1, 1000, {}), null);
});

test('reactions log events that cancel out when undone or switched', () => {
  const db = seed();
  setReaction(db, 2, 'like');
  setReaction(db, 2, 'like');                 // same reaction again: no new event
  setReaction(db, 2, 'less_topic');
  setReaction(db, 2, null);
  assert.deepEqual(events(db).map((e) => e.type), ['like', 'unlike', 'less_topic', 'less_undo']);
  assert.equal(events(db).reduce((s, e) => s + Number(e.weight), 0), 0);
  assert.equal((db.prepare('SELECT reaction FROM entry WHERE id = 2').get() as { reaction: string | null }).reaction, null);
  assert.equal(setReaction(db, 999, 'like'), false);
});

test('events outlive the entry but go with their feed', () => {
  const db = seed();
  logEvent(db, 3, 'star');
  db.prepare('DELETE FROM entry WHERE id = 3').run();
  assert.equal(events(db).length, 1);
  db.prepare('DELETE FROM feed WHERE id = 2').run();
  assert.equal(events(db).length, 0);
});

test('profile stats separate signals from neutral views and count unopened reads', () => {
  const db = seed();
  logView(db, 1, 1, 70_000, {});
  logView(db, 2, 1, 1_000, {});
  setReaction(db, 1, 'like');
  db.prepare('UPDATE entry SET is_read = 1, read_at = ? WHERE id = 3').run(Math.floor(Date.now() / 1000));
  const s = profileStats(db);
  assert.equal(s.signals, 2);
  assert.equal(s.bulkRead, 1);
  assert.deepEqual(s.feeds.map((f) => [f.title, f.score, f.views]), [['博客', 12, 2]]);
  assert.deepEqual(s.recent.map((r) => r.type), ['like', 'read_complete']);
});
