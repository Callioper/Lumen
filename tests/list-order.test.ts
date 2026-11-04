import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { listEntries, markReadBeyond } from '../server/api/queries.ts';

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://example.com/feed', '示例', 'article')").run();
  const ins = db.prepare("INSERT INTO entry (id, feed_id, guid, title, title_hash, link, content, published) VALUES (?, 1, ?, ?, ?, ?, '<p>x</p>', ?)");
  // Two share a time, so the tie is broken by id both ways.
  for (const [id, t] of [[1, 100], [2, 200], [3, 200], [4, 300], [5, 400]] as const) ins.run(id, `g${id}`, `第${id}篇`, `h${id}`, `https://example.com/${id}`, t);
  return db;
}
const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id);

test('最新 lists newest first and pages on from the last entry shown', () => {
  const db = seed();
  const first = listEntries(db, { filter: 'all' }, undefined, 2);
  assert.deepEqual(ids(first), [5, 4]);
  const last = first.at(-1)!;
  assert.deepEqual(ids(listEntries(db, { filter: 'all' }, { published: last.published, id: last.id }, 10)), [3, 2, 1]);
});

test('最旧 lists oldest first and pages on after the last entry shown, ties by id', () => {
  const db = seed();
  const first = listEntries(db, { filter: 'all' }, undefined, 2, true);
  assert.deepEqual(ids(first), [1, 2]);
  const last = first.at(-1)!;
  assert.deepEqual(ids(listEntries(db, { filter: 'all' }, { published: last.published, id: last.id }, 10, true)), [3, 4, 5]);
});

test('以下已读 marks the unread entries past the given one, on the side asked, and gives their ids', () => {
  const db = seed();
  db.prepare('UPDATE entry SET is_read = 1 WHERE id = 1').run();
  assert.deepEqual(markReadBeyond(db, { filter: 'all' }, { side: 'older', published: 200, id: 3 }).sort(), [2]);
  assert.deepEqual(markReadBeyond(db, { filter: 'all' }, { side: 'newer', published: 300, id: 4 }), [5]);
  const unread = (db.prepare('SELECT id FROM entry WHERE is_read = 0 ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  assert.deepEqual(unread, [3, 4]);
});

test('超过 N 天 marks what was published before the cutoff, within the list only', () => {
  const db = seed();
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (2, 'https://example.org/feed', '别的', 'article')").run();
  db.prepare("INSERT INTO entry (id, feed_id, guid, title, title_hash, link, content, published) VALUES (9, 2, 'g9', '别处', 'h9', 'https://example.org/9', '', 50)").run();
  const now = 300 + 86400;          // a day after entry 4
  assert.deepEqual(markReadBeyond(db, { filter: 'all', feed: 1 }, { days: 1 }, now).sort(), [1, 2, 3]);
  assert.equal((db.prepare('SELECT is_read FROM entry WHERE id = 9').get() as { is_read: number }).is_read, 0);
});
