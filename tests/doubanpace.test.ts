import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../server/db.ts';
import { loadSettings } from '../server/config.ts';
import { fetchFeed } from '../server/fetch/scheduler.ts';
import type { FeedRow } from '../server/fetch/ingest.ts';
import { BASE_GAP_MS, isDoubanUrl, isRefusal, takeDoubanTurn, doubanRefused, doubanAnswered, doubanWaitMs, doubanGapMs, deferredFetchAt, readerDoubanTurn, resetDoubanPace } from '../server/fetch/doubanpace.ts';

beforeEach(resetDoubanPace);

test('which addresses are 豆瓣, and what reads as its refusal', () => {
  assert.equal(isDoubanUrl('rsshub://douban/people/1010039/status'), true);
  assert.equal(isDoubanUrl('rsshub://lumen/douban/book/chart'), true);
  assert.equal(isDoubanUrl('https://www.douban.com/feed/review/book'), true);
  assert.equal(isDoubanUrl('https://img3.doubanio.com/view/subject/l/public/s1.jpg'), false);
  assert.equal(isDoubanUrl('rsshub://bilibili/user/video/1'), false);
  assert.equal(isRefusal(503, '[GET] "https://m.douban.com/rexxar/api/v2/status/user_timeline/1": 403'), true);
  assert.equal(isRefusal(503, 'Error: timeout'), false);
  assert.equal(isRefusal(429), true);
});

test('feeds and background lookups go one at a time, a gap apart', () => {
  const t = 1_000_000;
  assert.equal(takeDoubanTurn(t), true);
  assert.equal(takeDoubanTurn(t + 1000), false);
  assert.equal(takeDoubanTurn(t + BASE_GAP_MS), true);
});

test('a refusal stops everything for a cool-down that doubles, and widens the gap; answers bring both back', async () => {
  const t = 1_000_000;
  doubanRefused(t);
  assert.equal(doubanWaitMs(t), 20 * 60_000);
  assert.equal(takeDoubanTurn(t + 60_000), false);
  assert.ok(await readerDoubanTurn(t + 60_000) > 0, 'what the reader opens is turned away too');
  doubanRefused(t + 1000);           // one already on its way: no second cool-down
  assert.equal(doubanWaitMs(t), 20 * 60_000);
  const back = t + 20 * 60_000;
  doubanRefused(back);
  assert.equal(doubanWaitMs(back), 40 * 60_000);
  assert.equal(doubanGapMs(), BASE_GAP_MS * 4);
  const later = back + 40 * 60_000;
  doubanAnswered(later);
  assert.ok(doubanGapMs() < BASE_GAP_MS * 4);
  doubanRefused(later);
  assert.equal(doubanWaitMs(later), 20 * 60_000, 'an answer resets the cool-down');
});

test('the feeds a refusal stops come back spread over the time after it', () => {
  const t = 1_000_000_000;
  doubanRefused(t);
  const early = deferredFetchAt(t, 0), late = deferredFetchAt(t, 0.99);
  assert.equal(early, Math.ceil((t + 20 * 60_000) / 1000));
  assert.ok(late - early > 19 * 60);
});

test('a 豆瓣 feed refused is put back without its error count growing', async () => {
  const server = createServer((_, res) => { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('[GET] "https://m.douban.com/rexxar/api/v2/status/user_timeline/1": 403'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/1/status', '松溪', 'social')").run();
    const settings = { ...loadSettings(), rsshubBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    const out = await fetchFeed(db, db.prepare('SELECT * FROM feed WHERE id = 1').get() as unknown as FeedRow, settings);
    assert.equal(out.ok, false);
    const f = db.prepare('SELECT error_count, next_fetch_at FROM feed WHERE id = 1').get() as { error_count: number; next_fetch_at: number };
    assert.equal(f.error_count, 0);
    assert.ok(f.next_fetch_at * 1000 >= Date.now() + 19 * 60_000);
    assert.ok(doubanWaitMs() > 0);
  } finally { server.close(); }
});
