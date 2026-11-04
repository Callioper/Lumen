import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { ingest } from '../server/fetch/ingest.ts';
import { normalizeMuteWords, mutedBy, applyMuteWords } from '../server/content/mute.ts';

test('keeps the words trimmed, without blanks or repeats', () => {
  assert.deepEqual(normalizeMuteWords([' 抽奖 ', '', '抽奖', 'AI', 'ai', '  ']), ['抽奖', 'AI']);
});

test('a title containing a word is muted, case aside, the Chinese title too', () => {
  assert.equal(mutedBy('本周福利：抽奖送耳机', null, ['抽奖']), '抽奖');
  assert.equal(mutedBy('New ai tools', null, ['AI']), 'AI');
  assert.equal(mutedBy('Weekly deals', '每周优惠', ['优惠']), '优惠');
  assert.equal(mutedBy('福柯与权力', null, ['抽奖', '优惠']), null);
  assert.equal(mutedBy('anything', null, []), null);
});

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://example.com/feed', '示例', 'article')").run();
  const feed = db.prepare('SELECT * FROM feed WHERE id = 1').get() as never;
  const now = Math.floor(Date.now() / 1000);
  const item = (n: number, title: string) => ({ guid: `g${n}`, title, link: `https://example.com/${n}`, author: '', content: '<p>正文</p>',
    published: now - 3600 + n, thumbnail: '', enclosures: [], categories: [] });
  const parsed = (items: unknown[]) => ({ title: '', siteUrl: '', description: '', items } as never);
  return { db, feed, now, item, parsed };
}

test('an entry whose title has a muted word comes in read; the others unread', () => {
  const { db, feed, now, item, parsed } = setup();
  ingest(db, feed, parsed([item(1, '新品抽奖开始了'), item(2, '读福柯')]), { aiEnabled: false, now, muteWords: ['抽奖'] });
  const rows = db.prepare('SELECT title, is_read, read_at FROM entry ORDER BY guid').all() as { title: string; is_read: number; read_at: number | null }[];
  assert.deepEqual(rows.map((r) => [r.title, r.is_read]), [['新品抽奖开始了', 1], ['读福柯', 0]]);
  assert.equal(rows[0].read_at, now);
});

test('saving the words marks the unread entries they cover, and only those', () => {
  const { db, feed, now, item, parsed } = setup();
  ingest(db, feed, parsed([item(1, '限时优惠'), item(2, '读福柯'), item(3, '又一个优惠')]), { aiEnabled: false, now });
  db.prepare("UPDATE entry SET is_read = 1 WHERE guid = 'g3'").run();
  assert.equal(applyMuteWords(db, ['优惠'], now), 1);
  const unread = (db.prepare('SELECT title FROM entry WHERE is_read = 0').all() as { title: string }[]).map((r) => r.title);
  assert.deepEqual(unread, ['读福柯']);
  assert.equal(applyMuteWords(db, [], now), 0);
});
