import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { cardsToFetch, prefetchMarkPages } from '../server/content/markpages.ts';
import { resetDoubanPace, doubanRefused, doubanWaitMs, BASE_GAP_MS } from '../server/fetch/doubanpace.ts';
import { PAGE_VERSION, DoubanNeedsLogin } from '../server/content/douban.ts';
import { needsLogin } from '../server/content/doubanmovie.ts';

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/42/status', '某人', 'social')").run();
  const now = Math.floor(Date.now() / 1000);
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  add.run(1, 'g1', '某人 读过: 《松溪的花》', '<a href="https://book.douban.com/subject/111/"><strong>松溪的花</strong></a>', now - 60);
  add.run(2, 'g2', '某人 看过: 《沙洲》', '<a href="https://movie.douban.com/subject/222/"><strong>沙洲</strong></a>', now - 30);
  add.run(3, 'g3', '某人 想读: 《已经有了》', '<a href="https://book.douban.com/subject/333/"><strong>已经有了</strong></a>', now);
  db.prepare('INSERT INTO douban_subject (subject, editions_at, page) VALUES (?, ?, ?)').run('333', now, JSON.stringify({ v: PAGE_VERSION, title: '已经有了' }));
  return db;
}

test('标记\'s cards whose 豆瓣 page is not kept are fetched ahead, newest first, a turn per request', async () => {
  resetDoubanPace();
  const db = seed();
  assert.deepEqual(cardsToFetch(db).map((c) => [c.kind, c.subject]), [['movie', '222'], ['book', '111']]);
  const asked: string[] = [];
  let waited = 0;
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const n = await prefetchMarkPages(db, async (ms) => { waited += ms; mock.timers.tick(ms); }, async (c) => { asked.push(c.subject); });
    assert.equal(n, 2);
  } finally { mock.timers.reset(); }
  assert.deepEqual(asked, ['222', '111']);
  // the film's three requests and the book's one each took a turn: three gaps waited between the four
  assert.ok(waited >= 3 * BASE_GAP_MS, String(waited));
});

test('a film 豆瓣 shows only to members is not taken for a refusal: the others go on, and it is not asked again', async () => {
  resetDoubanPace();
  const db = seed();
  const asked: string[] = [];
  const fetchPage = async (c: { subject: string }): Promise<void> => {
    asked.push(c.subject);
    if (c.subject === '222') throw new DoubanNeedsLogin('豆瓣这个条目要登录才能看');
  };
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    assert.equal(await prefetchMarkPages(db, async (ms) => { mock.timers.tick(ms); }, fetchPage), 1);
    assert.equal(doubanWaitMs(), 0);
    assert.deepEqual(cardsToFetch(db).map((c) => c.subject), ['111']);
  } finally { mock.timers.reset(); }
  assert.deepEqual(asked, ['222', '111']);
  resetDoubanPace();
});

test('a 403 from rexxar is a refusal unless it says the subject needs a member', () => {
  assert.equal(needsLogin('{"request": "GET \\/v2\\/movie\\/36604401", "msg": "need_permission", "code": 1000}'), true);
  assert.equal(needsLogin('<html>403 Forbidden</html>'), false);
  assert.equal(needsLogin(''), false);
});

test('nothing is fetched ahead while 豆瓣 is refusing', async () => {
  resetDoubanPace();
  doubanRefused();
  const asked: string[] = [];
  assert.equal(await prefetchMarkPages(seed(), async () => {}, async (c) => { asked.push(c.subject); }), 0);
  assert.deepEqual(asked, []);
  resetDoubanPace();
});
