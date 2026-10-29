import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../server/db.ts';
import { loadSettings, type Settings } from '../server/config.ts';
import { fetchFeed, lanFeedUrl, resetLanState } from '../server/fetch/scheduler.ts';
import type { FeedRow } from '../server/fetch/ingest.ts';

const ATOM = (title: string): string => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title>
<entry><title>第一篇</title><link href="https://mp.weixin.qq.com/s/1"/><id>1</id><updated>2026-10-24T08:00:00Z</updated><content>正文</content></entry>
</feed>`;

// A server that answers with a feed, or (broken) drops every connection, counting what it was asked.
async function serve(title: string, broken = false): Promise<{ origin: string; hits: string[]; close: () => void }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (broken) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/atom+xml' }); res.end(ATOM(title));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => server.close() };
}

const settingsWith = (base: string, lan: string): Settings => ({ ...loadSettings(), proxy: '', wechat2rssBase: base, wechat2rssLan: lan });
const feedOn = (db: ReturnType<typeof openDb>, url: string): FeedRow => {
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, ?, '公众号', 'article')").run(url);
  return db.prepare('SELECT * FROM feed WHERE id = 1').get() as unknown as FeedRow;
};

test('a feed on the public wechat2rss address maps to the home one; others do not', () => {
  const s = settingsWith('http://w2r.example.com', 'http://192.168.0.2:8087');
  assert.equal(lanFeedUrl('http://w2r.example.com/feed/3237377160.xml', s), 'http://192.168.0.2:8087/feed/3237377160.xml');
  assert.equal(lanFeedUrl('http://w2r.example.com/feed/1.xml?k=a', { ...s, wechat2rssLan: 'http://192.168.0.2:8087/' }), 'http://192.168.0.2:8087/feed/1.xml?k=a');
  assert.equal(lanFeedUrl('https://www.gcores.com/rss', s), null);
  assert.equal(lanFeedUrl('http://w2r.example.com/feed/1.xml', { ...s, wechat2rssLan: '' }), null);
});

test('at home the feed comes from the home address, not the tunnel', async () => {
  resetLanState();
  const tunnel = await serve('隧道'), lan = await serve('局域网');
  try {
    const db = openDb(':memory:');
    const out = await fetchFeed(db, feedOn(db, `${tunnel.origin}/feed/42.xml`), settingsWith(tunnel.origin, lan.origin));
    assert.equal(out.ok, true);
    assert.deepEqual([lan.hits, tunnel.hits], [['/feed/42.xml'], []]);
  } finally { tunnel.close(); lan.close(); }
});

test('away from home the tunnel is used, and the home address is not tried again for a while', async () => {
  resetLanState();
  const tunnel = await serve('隧道'), lan = await serve('局域网', true);
  try {
    const db = openDb(':memory:');
    const feed = feedOn(db, `${tunnel.origin}/feed/42.xml`);
    const s = settingsWith(tunnel.origin, lan.origin);
    assert.equal((await fetchFeed(db, feed, s)).ok, true);
    assert.equal((await fetchFeed(db, feed, s)).ok, true);
    assert.equal(lan.hits.length, 1);
    assert.equal(tunnel.hits.length, 2);
  } finally { tunnel.close(); lan.close(); resetLanState(); }
});

test('a home address that times out is tried again next round', async () => {
  resetLanState();
  const tunnel = await serve('隧道');
  const hits: string[] = [];
  const slow = createServer((req) => { hits.push(req.url ?? ''); });   // never answers
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
  try {
    const db = openDb(':memory:');
    const feed = feedOn(db, `${tunnel.origin}/feed/42.xml`);
    const s = { ...settingsWith(tunnel.origin, `http://127.0.0.1:${(slow.address() as AddressInfo).port}`), fetchTimeoutMs: 300 };
    assert.equal((await fetchFeed(db, feed, s)).ok, true);   // home timed out, the tunnel answered
    assert.equal((await fetchFeed(db, feed, s)).ok, true);
    assert.deepEqual([hits.length, tunnel.hits.length], [2, 2]);
  } finally { tunnel.close(); slow.closeAllConnections(); slow.close(); resetLanState(); }
});
