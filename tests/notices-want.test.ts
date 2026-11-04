import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { academicNotices, noticeHits, setWanted, type Notice } from '../server/content/notices.ts';

const notice = (o: Partial<Notice>): Notice => ({ kind: '讲座', name: '', date: '', end: '', deadline: '', place: '', organizer: '', speakers: [], contact: '', summary: '', online: '', live: '', ...o });

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '某公众号')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  const put = db.prepare('INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, ?, 1, ?, 0)');
  const now = Math.floor(Date.now() / 1000);
  add.run(1, 'g1', '讲座预告', '<p>正文</p>', now);
  add.run(2, 'g2', '会议通知', '<p>正文</p>', now);
  put.run(1, 'notice', JSON.stringify([notice({ name: '媒介考古学的方法', date: '2026-11-20', summary: '从基特勒谈起' })]));
  put.run(2, 'notice', JSON.stringify([notice({ kind: '会议', name: '宋代词学研讨会', date: '2026-11-25' })]));
  return db;
}
const NOW = new Date(2026, 10, 5);

test('想听 marks an event by its name and date, survives a reread, and can be listed alone', () => {
  const db = setup();
  const first = academicNotices(db, { kind: '', past: false, now: NOW });
  assert.equal(first.wanted, 0);
  const talk = first.items.find((v) => v.name === '媒介考古学的方法')!;
  assert.equal(talk.wanted, false);
  setWanted(db, talk.key, true, talk.name, talk.date);
  const again = academicNotices(db, { kind: '', past: false, now: NOW });
  assert.equal(again.wanted, 1);
  assert.equal(again.items.find((v) => v.name === '媒介考古学的方法')!.wanted, true);
  assert.deepEqual(academicNotices(db, { kind: '', past: false, wanted: true, now: NOW }).items.map((v) => v.name), ['媒介考古学的方法']);
  setWanted(db, talk.key, false);
  assert.equal(academicNotices(db, { kind: '', past: false, now: NOW }).wanted, 0);
});

test('关注词 are found in the name, summary, speakers and organizer, case aside', () => {
  const n = notice({ name: 'AI 与文学', summary: '讨论基特勒', speakers: ['某某'], organizer: '媒介研究中心' });
  assert.deepEqual(noticeHits(n, ['ai', '基特勒', '媒介', '宋词']), ['ai', '基特勒', '媒介']);
  assert.deepEqual(noticeHits(n, []), []);
});

test('the page tells each event its 关注词 hits', () => {
  const db = setup();
  const page = academicNotices(db, { kind: '', past: false, words: ['媒介', '基特勒'], now: NOW });
  assert.deepEqual(page.items.map((v) => [v.name, v.hits]), [['媒介考古学的方法', ['媒介', '基特勒']], ['宋代词学研讨会', []]]);
});
