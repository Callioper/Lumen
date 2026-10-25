import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { validateDigestIds, buildDigestMessages, parseDigest, digestKey, summarizeDigest, loadDigestEntries, DIGEST_MAX_ENTRIES } from '../server/ai/digest.ts';
import type { Settings } from '../server/config.ts';
import { groupDigest, displayOrder, resolveScrollRead, type LayoutContext } from '../web/src/layout.ts';

test('digest requests take a bounded list of positive ids, duplicates dropped', () => {
  assert.equal(validateDigestIds(null), 'ids 应为非空数组');
  assert.equal(validateDigestIds({ ids: [] }), 'ids 应为非空数组');
  assert.equal(validateDigestIds({ ids: [1, 'x'] }), 'ids 应为正整数');
  assert.equal(validateDigestIds({ ids: [0] }), 'ids 应为正整数');
  assert.match(String(validateDigestIds({ ids: Array.from({ length: DIGEST_MAX_ENTRIES + 1 }, (_, i) => i + 1) })), /最多/);
  assert.deepEqual(validateDigestIds({ ids: [3, 1, 3] }), [3, 1]);
});

test('the cache key ignores order', () => {
  assert.equal(digestKey([3, 1, 2]), digestKey([1, 2, 3]));
  assert.notEqual(digestKey([1, 2]), digestKey([1, 2, 3]));
});

test('the prompt lists each entry once and stops at the character budget', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ title: `标题${i}`, snippet: '正文'.repeat(20), feed: '联合早报' }));
  const [, user] = buildDigestMessages(entries, 400);
  assert.match(user.content, /「联合早报」同一天的 30 条/);
  assert.match(user.content, /^1\. 标题0 —— /m);
  assert.match(user.content, /另有 \d+ 条从略/);
  assert.ok(user.content.length < 900);
  const mixed = buildDigestMessages([{ title: 'a', snippet: '', feed: '甲' }, { title: 'b', snippet: 'b', feed: '乙' }], 1000)[1].content;
  assert.match(mixed, /几个来源/);
  assert.match(mixed, /1\. a（甲）\n2\. b（乙）/);
});

test('model output is cut to at most three bullet lines', () => {
  assert.equal(parseDigest('· 一\n\n- 二\n3. 三\n· 四'), '· 一\n· 二\n· 三');
  assert.equal(parseDigest('  \n'), '');
});

test('a cached digest is returned without calling the AI', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '联合早报')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (?, 1, ?, ?, ?, 0)');
  add.run(10, 'g10', '标题甲', '<p>正文甲</p>');
  add.run(11, 'g11', '标题乙', '');
  assert.deepEqual(loadDigestEntries(db, [11, 10, 99]).map((e) => e.title), ['标题乙', '标题甲']);
  db.prepare('INSERT INTO digest (key, summary, created) VALUES (?, ?, 0)').run(digestKey([10, 11]), '· 已缓存');
  // No settings and no key: any real AI call would throw, so a result proves the cache answered.
  const out = await summarizeDigest(db, [11, 10], {} as Settings, '');
  assert.deepEqual(out, { summary: '· 已缓存', cached: true });
});

test('每日简报 splits each day into one block per feed, a single feed into one block per day', () => {
  const now = new Date(2026, 9, 21, 15).getTime();
  const at = (d: number, h: number, feed_id: number) => ({ published: new Date(2026, 9, d, h).getTime() / 1000, feed_id });
  const list = [at(21, 12, 1), at(21, 11, 2), at(21, 9, 1), at(20, 8, 2)];
  assert.deepEqual(groupDigest(list, false, now).map((b) => [b.day, b.feedId, b.items.length]), [['今天', 1, 2], ['今天', 2, 1], ['昨天', 2, 1]]);
  assert.deepEqual(groupDigest(list, true, now).map((b) => [b.day, b.items.length]), [['今天', 3], ['昨天', 1]]);
});

test('滚过即读 is off unless the feed, its category or this browser turned it on', () => {
  const ctx: LayoutContext = {
    feeds: new Map([[1, { id: 1, view: 'article', category_id: 5, layout: null, scroll_read: null }],
      [2, { id: 2, view: 'article', category_id: 5, layout: null, scroll_read: 0 }],
      [3, { id: 3, view: 'article', category_id: 6, layout: null, scroll_read: null }]]),
    categories: [{ id: 5, layout: null, scroll_read: 1 }, { id: 6, layout: null, scroll_read: null }],
    local: {}, localScrollRead: { 'tab:social': true },
  };
  assert.equal(resolveScrollRead({ kind: 'feed', id: 1 }, 'all', ctx), true);
  assert.equal(resolveScrollRead({ kind: 'feed', id: 2 }, 'all', ctx), false);
  assert.equal(resolveScrollRead({ kind: 'feed', id: 3 }, 'all', ctx), false);
  assert.equal(resolveScrollRead({ kind: 'category', id: 5 }, 'all', ctx), true);
  assert.equal(resolveScrollRead({ kind: 'all' }, 'social', ctx), true);
  assert.equal(resolveScrollRead({ kind: 'all' }, 'list', ctx), false);
  assert.equal(resolveScrollRead({ kind: 'marks' }, 'social', ctx), false);
});

test('j/k in 每日简报 walk one feed of a day before moving to the next feed', () => {
  const now = new Date(2026, 9, 21, 15).getTime();
  const at = (id: number, h: number, feed_id: number) => ({ id, published: new Date(2026, 9, 21, h).getTime() / 1000, feed_id });
  const list = [at(1, 12, 28), at(2, 11, 101), at(3, 10, 28), at(4, 9, 101), at(5, 8, 28)];
  assert.deepEqual(displayOrder(list, 'digest', false, now).map((i) => i.id), [1, 3, 5, 2, 4]);
  assert.deepEqual(displayOrder(list, 'list', false, now).map((i) => i.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(displayOrder(list, 'compact', false, now).map((i) => i.id), [1, 2, 3, 4, 5]);
});
