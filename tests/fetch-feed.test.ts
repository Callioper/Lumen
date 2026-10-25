import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../server/db.ts';
import { loadSettings } from '../server/config.ts';
import { fetchFeed } from '../server/fetch/scheduler.ts';
import { thumbnailOf, type FeedRow } from '../server/fetch/ingest.ts';

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>松溪札记</title><link href="https://example.invalid/"/>
<entry><title>第一篇</title><link href="https://example.invalid/1"/><id>1</id><updated>2026-10-24T08:00:00Z</updated><content>正文</content></entry>
</feed>`;

async function serve(body: string): Promise<{ url: string; close: () => void }> {
  const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'application/atom+xml' }); res.end(body); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`, close: () => server.close() };
}

const row = (db: ReturnType<typeof openDb>, id: number): FeedRow => db.prepare('SELECT * FROM feed WHERE id = ?').get(id) as unknown as FeedRow;

test('a feed added by its address alone takes the title the feed gives itself', async () => {
  const s = await serve(ATOM);
  try {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, ?, ?, 'article')").run(s.url, s.url);
    const out = await fetchFeed(db, row(db, 1), loadSettings());
    assert.equal(out.ok, true);
    assert.equal(out.added, 1);
    assert.equal(row(db, 1).title, '松溪札记');
  } finally { s.close(); }
});

test('a title the reader gave is kept', async () => {
  const s = await serve(ATOM);
  try {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, ?, '我的叫法', 'article')").run(s.url);
    await fetchFeed(db, row(db, 1), loadSettings());
    assert.equal(row(db, 1).title, '我的叫法');
  } finally { s.close(); }
});

test('a relative thumbnail is resolved against its entry', () => {
  assert.equal(thumbnailOf('scott.jpg', 'https://blog.example.invalid/2026/10/24/post/'), 'https://blog.example.invalid/2026/10/24/post/scott.jpg');
  assert.equal(thumbnailOf('/img/a.png', 'https://blog.example.invalid/p/1'), 'https://blog.example.invalid/img/a.png');
  assert.equal(thumbnailOf('https://cdn.example.invalid/a.png', 'https://blog.example.invalid/'), 'https://cdn.example.invalid/a.png');
  assert.equal(thumbnailOf('scott.jpg', ''), null);
  assert.equal(thumbnailOf('javascript:alert(1)', 'https://blog.example.invalid/'), null);
  assert.equal(thumbnailOf('', 'https://blog.example.invalid/'), null);
});
