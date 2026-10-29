import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { ingest } from '../server/fetch/ingest.ts';

test('a 豆瓣 post written into a 话题 takes its topic link when it comes round again, without a second copy', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/1/status', '豆瓣广播 - 某人', 'social')").run();
  const feed = db.prepare('SELECT * FROM feed WHERE id = 1').get() as never;
  const now = Math.floor(Date.now() / 1000);
  const status = 'https://www.douban.com/people/1/status/99/';
  const item = (link: string) => ({ guid: status, title: '某人 : 「」', link, author: '', content: '<p>其实真要选，我可能会选老周。</p>',
    published: now - 3600, thumbnail: '', enclosures: [], categories: [] });
  const opts = { aiEnabled: false, now, retention: { days: 90, keepMinPerFeed: 50 } };
  assert.equal(ingest(db, feed, { title: '', siteUrl: '', description: '', items: [item(status)] } as never, opts), 1);
  assert.equal(ingest(db, feed, { title: '', siteUrl: '', description: '', items: [item('https://www.douban.com/topic/500000002/')] } as never, opts), 0);
  const rows = db.prepare('SELECT title, link FROM entry').all() as { title: string; link: string }[];
  assert.deepEqual(rows.map((r) => r.link), ['https://www.douban.com/topic/500000002/']);
  assert.match(rows[0].title, /老周/);
});

test('a 书评 put out as a 豆瓣 status takes the review link, and a status already pointing elsewhere is left alone', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/1/status', '豆瓣广播 - 某人', 'social')").run();
  const feed = db.prepare('SELECT * FROM feed WHERE id = 1').get() as never;
  const now = Math.floor(Date.now() / 1000);
  const item = (guid: string, link: string) => ({ guid, title: '某人 : 「第一章」', link, author: '', content: '<p>译按</p>',
    published: now - 3600, thumbnail: '', enclosures: [], categories: [] });
  const opts = { aiEnabled: false, now, retention: { days: 90, keepMinPerFeed: 50 } };
  const feedOf = (items: unknown[]) => ({ title: '', siteUrl: '', description: '', items } as never);
  const a = 'https://www.douban.com/people/1/status/98/';
  const b = 'https://www.douban.com/people/1/status/97/';
  ingest(db, feed, feedOf([item(a, a), item(b, 'https://www.douban.com/topic/1/')]), opts);
  ingest(db, feed, feedOf([item(a, 'https://book.douban.com/review/17874956/'), item(b, b)]), opts);
  const links = db.prepare('SELECT guid, link FROM entry ORDER BY guid').all() as { guid: string; link: string }[];
  assert.deepEqual(links.map((r) => r.link), ['https://www.douban.com/topic/1/', 'https://book.douban.com/review/17874956/']);
});
