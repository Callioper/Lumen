import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filmTitle, friendsHot, markWeight, parseListItem } from '../server/report/hot.ts';
import type { MarkGroup } from '../server/api/marks.ts';

const DAY = 86400;
const now = 1_800_000_000;
const group = (subject: string, kind: MarkGroup['kind'], marks: [string, string, number, string?][]): MarkGroup => ({
  key: `${kind}:${subject}`, kind, title: `T${subject}`, url: null, cover: null, info: '', people: 0, unread: 0, latest: now,
  subject, wished: false,
  marks: marks.map(([who, action, ago, comment], i) => ({ id: i, who, action, comment: comment ?? '', published: now - ago * DAY, is_read: 1, link: null })),
});

test('a friend counts once, by their weightiest mark', () => {
  assert.equal(markWeight('读过', '好看'), 1.5);
  assert.equal(markWeight('读过', ''), 1);
  assert.equal(markWeight('想读', ''), 1);
  assert.equal(markWeight('收藏到', ''), 0.8);
});

test('friends hot: two people at least, recent marks weigh more, and the day it reached the list', () => {
  const hot = friendsHot([
    group('1', 'book', [['甲', '想读', 1], ['乙', '读过', 2, '好']]),          // fresh
    group('2', 'book', [['甲', '想读', 20], ['乙', '想读', 21], ['丙', '想读', 22]]),   // more people, old
    group('3', 'movie', [['甲', '想看', 1], ['甲', '看过', 0, '好看']]),           // one person twice
    group('4', 'music', [['甲', '想听', 1], ['乙', '想听', 1]]),                  // not books or films
    group('5', 'book', [['甲', '想读', 40], ['乙', '想读', 1]]),                  // one mark outside the window
  ], now);
  assert.deepEqual(hot.map((h) => h.subject), ['1', '2']);
  assert.equal(hot[0].people, 2);
  assert.ok(hot[0].isNew);
  assert.equal(hot[0].since, now - 1 * DAY, 'the second friend to mark it');
  assert.equal(hot[1].isNew, false);
});

test('a public list item takes its subject from either link form', () => {
  assert.deepEqual(parseListItem({
    url: 'https://www.douban.com/doubanapp/dispatch/movie/30000004', title: '你能看见旧港',
    content_html: '<p>你能看见旧港</p><p>You Can See the Harbour</p><p>9.1</p><p>2026 / 美国 / 纪录片</p><img src="https://img9.doubanio.com/p.jpg">',
  }), { subject: '30000004', title: '你能看见旧港', cover: 'https://img9.doubanio.com/p.jpg', info: '2026 / 美国 / 纪录片', rating: 9.1 });
  assert.equal(parseListItem({ url: 'https://book.douban.com/subject/30000002/', title: '落在松溪的雨' })?.subject, '30000002');
  assert.equal(parseListItem({ url: 'https://www.douban.com/note/1/', title: 'x' }), null);
});

test('a film mark loses its original title and year', () => {
  const lrm = String.fromCharCode(0x200e);
  assert.equal(filmTitle(`生化危机：爆发夜 Resident Evil${lrm} (2026)`), '生化危机：爆发夜');
  assert.equal(filmTitle(`死神 千年血战篇 -祸进谭- BLEACH 千年血戦篇 -禍進譚-${lrm} (2026)`), '死神 千年血战篇 -祸进谭-');
  assert.equal(filmTitle(`千与千寻 千と千尋の神隠し${lrm} (2001)`), '千与千寻 千と千尋の神隠し');
  assert.equal(filmTitle('出租车司机'), '出租车司机');
});

test('a friend who marked it long ago and again yesterday did not just arrive', () => {
  const [h] = friendsHot([group('9', 'book', [['甲', '想读', 20], ['甲', '读过', 1, '好'], ['乙', '想读', 25]])], now);
  assert.equal(h.since, now - 20 * DAY, 'the second friend by first mark');
  assert.equal(h.isNew, false);
});
