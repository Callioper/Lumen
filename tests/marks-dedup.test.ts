import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { listEntries, appState, postImages } from '../server/api/queries.ts';
import { coverUrl } from '../server/api/media.ts';

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/42/status', '某人', 'social'), (2, 'https://a/feed', '博客', 'article')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read, is_starred) VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
  add.run(1, 1, 'g1', '某人 读过: 《献给松鼠的花束》 好看', '', 3, 0);
  add.run(2, 1, 'g2', '某人 : 今天去了图书馆', '<p>今天去了图书馆</p><img src="https://wx1.sinaimg.cn/mw2000/a.jpg"><img src="https://h5.sinaimg.cn/m/emoticon/x.png">', 2, 0);
  add.run(3, 2, 'g3', '一篇文章', '', 1, 0);
  add.run(4, 1, 'g4', '某人 想看: 《沙洲》', '', 0, 1);
  return db;
}

test('lists spanning many feeds leave Douban marks to 书影音标记', () => {
  const db = seed();
  const ids = (scope: Parameters<typeof listEntries>[1]) => listEntries(db, scope, undefined, 50).map((e) => e.id);
  assert.deepEqual(ids({ filter: 'all' }), [2, 3]);
  assert.deepEqual(ids({ filter: 'all', layout: 'social' }), [2]);
  // One person's own feed is their whole timeline, and a starred mark stays in 收藏.
  assert.deepEqual(ids({ feed: 1, filter: 'all' }), [1, 2, 4]);
  assert.deepEqual(ids({ filter: 'starred' }), [4]);
  assert.deepEqual(listEntries(db, { feed: 1, filter: 'all' }, undefined, 50).map((e) => e.is_mark), [1, 0, 1]);
});

test('unread counts leave marks out too', () => {
  const db = seed();
  const s = appState(db) as { feeds: { id: number; unread: number }[]; totals: { unread: number }; marksUnread: number };
  assert.deepEqual(s.feeds.map((f) => [f.id, f.unread]).sort(), [[1, 1], [2, 1]]);
  assert.equal(s.totals.unread, 2);
});

test('动态 gets the whole post and its pictures, without inline emoji', () => {
  const db = seed();
  const [post] = listEntries(db, { feed: 1, filter: 'all', snippet: 'long' }, undefined, 50).filter((e) => e.id === 2);
  assert.equal(post.snippet, '今天去了图书馆');
  assert.deepEqual(post.images, ['https://wx1.sinaimg.cn/mw2000/a.jpg']);
  assert.equal(listEntries(db, { feed: 1, filter: 'all' }, undefined, 50)[0].images, undefined);
  assert.deepEqual(postImages('<img src="a?x=1&amp;y=2"><img src="a?x=1&amp;y=2">'), ['a?x=1&y=2']);
  assert.equal(coverUrl('https://wx1.sinaimg.cn/mw2000/a.jpg', 480), 'https://wx1.sinaimg.cn/mw690/a.jpg');
});
