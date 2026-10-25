import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { destinationsOf, withDestinations } from '../server/content/destinations.ts';

test('an entry is marked with the pages read out of it: a notice, a table of contents, a CNKI feed', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://e.org/feed', '某号'), (2, 'https://rss.cnki.net/knavi/rss/NFWT?pcode=CJFD,CCJD', '南方文坛')").run();
  const add = db.prepare("INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (?, ?, ?, ?, '<p>x</p>', 0)");
  for (const [id, feed] of [[1, 1], [2, 1], [3, 1], [4, 2], [5, 1]]) add.run(id, feed, `g${id}`, `t${id}`);
  const ex = db.prepare('INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, ?, 1, ?, 0)');
  ex.run(1, 'notice', '[{"title":"论坛"}]');
  ex.run(2, 'notice', '[]');            // read, nothing found
  ex.run(3, 'toc', '{"journals":[]}');
  ex.run(3, 'notice', '[{"title":"讲座"}]');
  ex.run(5, 'reprint', null);           // failed read
  const of = destinationsOf(db, [1, 2, 3, 4, 5].map((id) => ({ id, feed_id: id === 4 ? 2 : 1 })));
  assert.deepEqual(of.get(1), ['notices']);
  assert.equal(of.has(2), false);
  assert.deepEqual(of.get(3), ['notices', 'tocs']);
  assert.deepEqual(of.get(4), ['tocs']);
  assert.equal(of.has(5), false);
  const items = withDestinations(db, [{ id: 1, feed_id: 1 }, { id: 2, feed_id: 1 }]);
  assert.deepEqual(items, [{ id: 1, feed_id: 1, pages: ['notices'] }, { id: 2, feed_id: 1 }]);
  assert.deepEqual(withDestinations(db, []), []);
});
