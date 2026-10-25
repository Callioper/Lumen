import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { removeFeed, restoreFeed } from '../server/unsubscribe.ts';
import { appState, listEntries } from '../server/api/queries.ts';
import { extracted } from '../server/content/extract.ts';
import { importOpml } from '../server/api/opml.ts';

function library() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://a/feed', '某号', 'article'), (2, 'https://b/feed', '别的号', 'article')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read, is_starred) VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
  [[1, '会议通知', 0], [2, '书单', 0], [3, '收藏的', 1], [4, '寻常一篇', 0]].forEach(([id, title, star]) => add.run(id, 1, `g${id}`, title, '<p>x</p>', 1_800_000_000 + Number(id), star));
  add.run(9, 2, 'g9', '别处一篇', '<p>x</p>', 1_800_000_000, 0);
  db.prepare("INSERT INTO extract (entry_id, kind, version, data, at) VALUES (1, 'notice', 2, '[]', 0), (4, 'notice', 2, NULL, 0)").run();
  return db;
}

test('removing a feed keeps the posts 学术动态, 新书 and the stars hold, out of sight but still under its name', () => {
  const db = library();
  assert.deepEqual(removeFeed(db, 1, [2]), { kept: 3 });
  const ids = (db.prepare('SELECT id, is_read FROM entry WHERE feed_id = 1 ORDER BY id').all() as { id: number; is_read: number }[]);
  assert.deepEqual(ids.map((r) => [r.id, r.is_read]), [[1, 1], [2, 1], [3, 1]]);
  assert.deepEqual((appState(db).feeds as { id: number }[]).map((f) => f.id), [2]);
  assert.deepEqual(listEntries(db, {}, undefined, 50).map((e) => e.id), [9]);
  assert.equal(extracted(db, 'notice', 2)[0].post.feed, '某号');
  restoreFeed(db, 1, null);
  assert.deepEqual((appState(db).feeds as { id: number }[]).map((f) => f.id).sort(), [1, 2]);
});

test('a feed with nothing held goes altogether', () => {
  const db = library();
  assert.deepEqual(removeFeed(db, 2, []), { kept: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feed WHERE id = 2').get()!.n, 0);
});

test('importing an OPML that lists an unsubscribed feed brings it back', () => {
  const db = library();
  removeFeed(db, 1, []);
  const opml = '<opml><body><outline text="松溪"><outline xmlUrl="https://a/feed" text="某号"/><outline xmlUrl="https://b/feed" text="别的号"/></outline></body></opml>';
  assert.deepEqual(importOpml(db, opml), { added: 1, skipped: 1 });
  assert.deepEqual((appState(db).feeds as { id: number }[]).map((f) => f.id).sort(), [1, 2]);
});
