import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { commentSource, commentsFor, doubanComment, doubanInterest, sspaiComment } from '../server/comments/comments.ts';

test('the site is told by the entry link; others have no comment section', () => {
  assert.equal(commentSource('https://book.douban.com/review/10000001/'), '豆瓣回应');
  assert.equal(commentSource('https://www.douban.com/people/100000001/status/1000000001/'), '豆瓣回应');
  assert.equal(commentSource('https://movie.douban.com/subject/1000003/'), '豆瓣短评');
  assert.equal(commentSource('https://sspai.com/post/100001'), '少数派评论');
  assert.equal(commentSource('https://mp.weixin.qq.com/s/abc'), null);
  assert.equal(commentSource(null), null);
});

test('each site answer becomes the same shape, with China time read as such', () => {
  const d = doubanComment({ text: '好看', vote_count: 2, create_time: '2026-10-20 17:23:47', author: { name: '某人' },
    replies: [{ text: '同意', create_time: '2026-10-20 17:39:50', author: { name: '作者' } }] });
  assert.deepEqual(d, { who: '某人', text: '好看', time: Date.UTC(2026, 9, 20, 9, 23, 47) / 1000, likes: 2,
    replies: [{ who: '作者', text: '同意', time: Date.UTC(2026, 9, 20, 9, 39, 50) / 1000, likes: 0, replies: [] }] });
  assert.equal(doubanInterest({ comment: '一般', rating: { value: 3 }, user: { name: '甲' } }).rating, 3);
  assert.equal(doubanInterest({ comment: '无评分', user: { name: '乙' } }).rating, undefined);
  assert.deepEqual(sspaiComment({ comment: '稳定', created_at: 1792584912, likes_count: 1, user: { nickname: '丙' }, reply: [] }),
    { who: '丙', text: '稳定', time: 1792584912, likes: 1, replies: [] });
  assert.deepEqual(doubanComment({}), { who: '', text: '', time: 0, likes: 0, replies: [] });
});

test('comments are fetched once a day, and an old copy stands in when the site fails', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://sspai.com/feed', '少数派')").run();
  db.prepare("INSERT INTO entry (id, feed_id, guid, title, link, published) VALUES (1, 1, 'g', 't', 'https://sspai.com/post/1', 0)").run();
  db.prepare("INSERT INTO entry (id, feed_id, guid, title, link, published) VALUES (2, 1, 'h', 't', 'https://example.com/a', 0)").run();
  const real = globalThis.fetch;
  let asked = 0;
  let fail = false;
  globalThis.fetch = (async () => {
    asked++;
    if (fail) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ error: 0, total: 1, data: [{ comment: '好文', created_at: 1, likes_count: 0, user: { nickname: '甲' }, reply: [] }] }));
  }) as typeof fetch;
  try {
    const first = await commentsFor(db, 1, false, 1000);
    assert.equal(first?.comments[0].text, '好文');
    await commentsFor(db, 1, false, 1000 + 3600);
    assert.equal(asked, 1);
    fail = true;
    assert.equal((await commentsFor(db, 1, true, 1000 + 7200))?.comments[0].text, '好文');
    assert.equal(asked, 2);
    assert.equal(await commentsFor(db, 2), null);
  } finally {
    globalThis.fetch = real;
  }
});

test('when the site does not answer, the older copy comes back marked as such', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '少数派')").run();
  db.prepare("INSERT INTO entry (id, feed_id, guid, title, link, published) VALUES (1, 1, 'g', 't', 'https://sspai.com/post/1', 0)").run();
  const old = { source: '少数派评论', url: 'https://sspai.com/post/1', total: 1, comments: [{ who: '甲', text: '旧评论', time: 1, likes: 0, replies: [] }], fetchedAt: 100 };
  db.prepare('INSERT INTO comment_cache (entry_id, fetched_at, data) VALUES (1, 100, ?)').run(JSON.stringify(old));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  try {
    const got = await commentsFor(db, 1, true, 200);
    assert.equal(got?.comments[0].text, '旧评论');
    assert.match(got?.stale ?? '', /fetch failed/);
    // A fresh cache is served as it is, without asking the site.
    const fresh = await commentsFor(db, 1, false, 150);
    assert.equal(fresh?.stale, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
