import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { pruneOld, compactIfWasteful } from '../server/retention.ts';
import type { Settings } from '../server/config.ts';

const OLD = Math.floor(Date.now() / 1000) - 400 * 86400;
const RULES = { retention: { days: 90, keepMinPerFeed: 1, maxPerFeed: 400 } } as Settings;

function seed(): ReturnType<typeof openDb> {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ret-')), 'lumen.db'));
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://example.com/f', 'f')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, published, is_starred, content) VALUES (?, 1, ?, ?, ?, ?, ?)');
  // Large enough that the pruned pages outweigh the schema's own, however many tables it grows.
  const body = 'x'.repeat(80_000);
  for (let id = 1; id <= 6; id++) add.run(id, `g${id}`, `t${id}`, OLD, id === 2 ? 1 : 0, body);
  db.prepare("INSERT INTO tag (entry_id, name, source) VALUES (3, '已存档', 'clip')").run();
  return db;
}

test('old entries go, except starred, archived and the newest per feed', () => {
  const db = seed();
  assert.equal(pruneOld(db, RULES), 3);
  const left = (db.prepare('SELECT id FROM entry ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  assert.deepEqual(left, [2, 3, 6]);
});

test('database is compacted once deleted pages pile up', () => {
  const db = seed();
  pruneOld(db, RULES);
  assert.ok(compactIfWasteful(db) > 0);
  assert.equal(compactIfWasteful(db), 0);
  assert.equal((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count, 0);
});

test('a feed re-serving its back catalogue does not refill what retention removed', async () => {
  const { ingest } = await import('../server/fetch/ingest.ts');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://example.com/pod', 'pod')").run();
  const feed = db.prepare('SELECT * FROM feed WHERE id = 1').get() as never;
  const now = Math.floor(Date.now() / 1000);
  const ep = (n: number, ageDays: number) => ({ guid: `ep${n}`, title: `第${n}期`, link: `https://example.com/ep${n}`, author: '', content: '',
    published: now - ageDays * 86400, thumbnail: '', enclosures: [], categories: [] });
  // Newest first, as feeds list them: two recent episodes and a long back catalogue.
  const parsed = { title: 'pod', siteUrl: '', description: '', items: [ep(10, 1), ep(9, 5), ...[8, 7, 6, 5, 4, 3, 2, 1].map((n) => ep(n, 100 + (10 - n) * 30))] };
  const rules = { days: 90, keepMinPerFeed: 4 };
  assert.equal(ingest(db, feed, parsed as never, { aiEnabled: false, now, retention: rules }), 4);
  const titles = () => (db.prepare('SELECT title FROM entry ORDER BY published DESC').all() as { title: string }[]).map((r) => r.title);
  assert.deepEqual(titles(), ['第10期', '第9期', '第8期', '第7期']);
  assert.equal(pruneOld(db, { retention: { ...rules, maxPerFeed: 400 } } as Settings), 0);
  assert.equal(ingest(db, feed, parsed as never, { aiEnabled: false, now, retention: rules }), 0);
  // A genuinely new episode still comes in.
  assert.equal(ingest(db, feed, { ...parsed, items: [ep(11, 0), ...parsed.items] } as never, { aiEnabled: false, now, retention: rules }), 1);
});

test('retention keeps the newest by publication even when old items were inserted later', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://example.com/f', 'f')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, published) VALUES (?, 1, ?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);
  add.run(1, 'recent', 'recent', now - 86400);
  add.run(2, 'old-a', 'old-a', OLD);
  add.run(3, 'old-b', 'old-b', OLD - 1);
  assert.equal(pruneOld(db, RULES), 2);
  assert.deepEqual((db.prepare('SELECT guid FROM entry').all() as { guid: string }[]).map((r) => r.guid), ['recent']);
});

test('with storage set to keep everything, only noisy feeds are pruned; Douban marks stay', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, noisy) VALUES (1, 'https://example.com/a', 'kept', 0), (2, 'https://example.com/b', 'noisy', 1), (3, 'rsshub://douban/people/1/status', 'douban', 0)").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, published) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 3; i++) {
    add.run(10 + i, 1, `a${i}`, `文章${i}`, OLD - i);
    add.run(20 + i, 2, `b${i}`, `噪声${i}`, OLD - i);
    add.run(30 + i, 3, `c${i}`, `某人 读过: 《书${i}》 不错`, OLD - i);
    add.run(40 + i, 3, `d${i}`, `某人的一条广播${i}`, OLD - i);
  }
  const forever = { retention: { days: 36500, keepMinPerFeed: 50, maxPerFeed: 1_000_000 } } as Settings;
  // NOISY_RETENTION keeps the newest 50 per feed, so lower it through many old rows instead.
  for (let i = 3; i < 60; i++) { add.run(100 + i, 2, `bb${i}`, `噪声${i}`, OLD - i); add.run(200 + i, 3, `cc${i}`, `某人 看过: 《片${i}》`, OLD - i); }
  const removed = pruneOld(db, forever);
  const count = (where: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM entry WHERE ${where}`).get() as { n: number }).n;
  assert.equal(removed, 10);
  assert.equal(count('feed_id = 1'), 3);
  assert.equal(count('feed_id = 2'), 50);
  assert.equal(count("feed_id = 3 AND title LIKE '% 读过: 《%' OR feed_id = 3 AND title LIKE '% 看过: 《%'"), 60);
  assert.equal(count("feed_id = 3 AND title LIKE '%广播%'"), 3);
});

test('a quiet feed’s entries arrive read but are stored like any other', async () => {
  const { ingest } = await import('../server/fetch/ingest.ts');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, quiet) VALUES (1, 'https://www.douban.com/feed/people/1/interests', 'me', 1)").run();
  db.prepare("INSERT INTO feed (id, url, title) VALUES (2, 'https://example.com/f', 'f')").run();
  const now = Math.floor(Date.now() / 1000);
  const item = { guid: 'w1', title: '想读找回时间', link: 'https://book.douban.com/subject/1/', author: '', content: '', published: now, thumbnail: '', enclosures: [], categories: [] };
  for (const id of [1, 2]) {
    const feed = db.prepare('SELECT * FROM feed WHERE id = ?').get(id) as never;
    assert.equal(ingest(db, feed, { title: '', siteUrl: '', description: '', items: [item] } as never, { aiEnabled: false, now }), 1);
  }
  const rows = db.prepare('SELECT feed_id, is_read, read_at FROM entry ORDER BY feed_id').all() as { feed_id: number; is_read: number; read_at: number | null }[];
  assert.deepEqual(rows.map((r) => [r.feed_id, r.is_read, r.read_at]), [[1, 1, now], [2, 0, null]]);
});

test('posts 学术动态 or 期刊目录 were read out of, and 书单 新书 lists, outlast their feed\'s limits', () => {
  const db = seed();
  db.prepare("INSERT INTO extract (entry_id, kind, version, data, at) VALUES (1, 'notice', 2, '[]', 0), (4, 'toc', 1, NULL, 0)").run();
  assert.equal(pruneOld(db, RULES, [5]), 1);
  const left = (db.prepare('SELECT id FROM entry ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  assert.deepEqual(left, [1, 2, 3, 5, 6]);         // 4 was read and found not to be one
});
