import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { fillEmptyTitle } from '../server/fetch/ingest.ts';
import { parseMarkTitle, listMarks, friendsMarks, unreadMarks, markMarksRead } from '../server/api/marks.ts';
import { parseChart } from '../rsshub/douban-chart.mjs';
import { parseEditions } from '../server/content/douban.ts';

test('an empty-quoted douban title takes the first sentence of the post', () => {
  assert.equal(fillEmptyTitle('松间 : 「」', '今天在河边走了很久也算是一个小小的分水岭。我决定明天继续早起。'), '松间 : 今天在河边走了很久也算是一个小小的分水岭。');
  assert.equal(fillEmptyTitle('北窗客 : 「」雨天也读书', '雨天也读书，那就是好的雨天'), '北窗客 : 雨天也读书');
  assert.equal(fillEmptyTitle('宇舟 转发小组讨论: 「」', '一山一水也自在'), '宇舟 转发小组讨论: 一山一水也自在');
  assert.equal([...fillEmptyTitle('甲 : 「」', '长'.repeat(200))].length, '甲 : '.length + 61);
  assert.equal(fillEmptyTitle('L.U.M.E 收藏到: 「」', ''), 'L.U.M.E 收藏到');
  assert.equal(fillEmptyTitle('Mistral : 「20世纪北城先锋文艺研究」', 'x'), 'Mistral : 「20世纪北城先锋文艺研究」');
});

test('mark titles split into who, action, subject and comment', () => {
  assert.deepEqual(parseMarkTitle('青菜豆腐汤 读过: 《在旧港做田野调查》即使对民族志研究者也有启发'),
    { who: '青菜豆腐汤', action: '读过', subject: '在旧港做田野调查', comment: '即使对民族志研究者也有启发' });
  assert.equal(parseMarkTitle('林间鹿 想读: 《午后散步的人》')?.comment, '');
  assert.equal(parseMarkTitle('某人 看过: 《一个被截断的长标题')?.subject, '一个被截断的长标题');
  assert.equal(parseMarkTitle('松溪玫瑰 收藏到: 《寻常小事》')?.action, '收藏到');
  assert.deepEqual(parseMarkTitle('松间 玩过: 「旧港迷途 DRIFTWOOD」挺好'),
    { who: '松间', action: '玩过', subject: '旧港迷途 DRIFTWOOD', comment: '挺好' });
});

test('收藏到 a book and a game quoted 「」 are marks; 收藏到 a diary is a post', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/1/status', 'a', 'social')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  const now = 1_800_000_000;
  add.run(1, 'g1', '甲 收藏到: 《书一》', card(11, '书一'), now - 30);
  add.run(2, 'g2', '甲 玩过: 「某游戏」需要磨合', '需要磨合<a href="https://www.douban.com/game/30000001/"><strong>某游戏</strong></a>', now - 20);
  add.run(3, 'g3', '甲 收藏到: 「寻找旧日的光」', '<a href="https://www.douban.com/topic/500000001/"><strong>寻找旧日的光</strong></a>', now - 10);
  const groups = listMarks(db, { unreadOnly: true, now });
  assert.deepEqual(groups.map((g) => [g.kind, g.title]).sort(), [['book', '书一'], ['game', '某游戏']]);
  assert.equal(groups.find((g) => g.kind === 'game')?.key, 'game:30000001');
  assert.equal(unreadMarks(db), 2);
});

const card = (id: number, title: string) =>
  `评语<img src="https://img3.doubanio.com/c.jpg" /><a href="https://book.douban.com/subject/${id}/"><strong>${title}</strong></a><br />作者 / 2026 / 某出版社<br />评分：0`;

test('marks group by subject, count people, and are read in bulk', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/1/status', 'a', 'social'), (2, 'rsshub://douban/people/2/status', 'b', 'social')").run();
  const now = 1_800_000_000;
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, ?, ?, ?, ?, ?, ?)');
  add.run(1, 1, 'g1', '甲 想读: 《书一》', card(11, '书一'), now - 100, 0);
  add.run(2, 2, 'g2', '乙 读过: 《书一》很好', card(11, '书一'), now - 50, 0);
  add.run(3, 1, 'g3', '甲 想读: 《书二》', card(22, '书二'), now - 10, 1);
  add.run(4, 1, 'g4', '甲 : 「随便说说」', '随便说说', now - 5, 0);
  const groups = listMarks(db, { unreadOnly: true, now });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].people, 2);
  assert.equal(groups[0].info, '作者 / 2026 / 某出版社');
  assert.equal(groups[0].marks.find((m) => m.who === '乙')?.comment, '评语');
  assert.equal(listMarks(db, { unreadOnly: false, now }).length, 2);
  assert.equal(unreadMarks(db), 2);
  assert.equal(markMarksRead(db, 1, now), 1);
  assert.equal(markMarksRead(db, undefined, now), 1);
  assert.equal((db.prepare('SELECT is_read FROM entry WHERE id = 4').get() as { is_read: number }).is_read, 0);
});

test('douban chart page parses into items dated by the chart release', () => {
  const html = `<div class="page-header">\n<h1>\n 9月热门图书榜\n</h1></div>
    <a href="?subcat=all&updated_at=2026-09-01" class="month">8月</a>
    <a href="?subcat=novel&amp;updated_at=2026-10-08">小说</a>
    <li class="media clearfix"><strong class="green-num-box">1</strong>
      <img class="subject-cover" src="https://img3.doubanio.com/view/subject/s/public/s1.jpg"/>
      <a class="fleft" href="https://book.douban.com/subject/30000002/">落在松溪的雨</a>
      <p class="subject-abstract color-gray"> 陆青远 / 2026-8 / 松溪人民出版社 </p>
      <span class="font-small fleft">9.1</span><span class="fleft ml8 color-gray">(1994人评价)</span>
      <span class="tag">文学</span></li>`;
  const d = parseChart(html, 'all');
  assert.equal(d.title, '豆瓣9月热门图书榜-全部');
  assert.equal(d.item.length, 1);
  assert.equal(d.item[0].guid, 'https://book.douban.com/subject/30000002/');
  assert.equal(d.item[0].pubDate, '2026-10-07T16:00:00.000Z');
  assert.match(d.item[0].description, /s\/public|l\/public/);
  assert.match(d.item[0].description, /第 1 名[\s\S]*9\.1分/);
});

test('友邻标记: an article linking a Douban subject shows who marked it, and not a subject whose id only begins alike', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/1/status', 'a', 'social'), (3, 'https://news/feed', '书评号', 'article')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, ?, ?, ?, ?, ?, 1)');
  add.run(1, 1, 'm1', '林间鹿 读过: 《冰》 好看', card(123, '冰'), 100);
  add.run(2, 1, 'm2', '林间鹿 想读: 《别的书》', card(1234, '别的书'), 200);
  add.run(3, 3, 'p1', '书评：安娜·卡兰《冰》', '<p>见 <a href="https://book.douban.com/subject/123/">豆瓣</a></p>', 300);
  const [s, ...rest] = friendsMarks(db, 3);
  assert.equal(rest.length, 0);
  assert.equal(s.title, '冰');
  assert.deepEqual(s.marks.map((m) => [m.who, m.action, m.comment]), [['林间鹿', '读过', '评语']]);
  assert.deepEqual(friendsMarks(db, 1), []);   // a mark itself links only its own subject, which it excludes
});

test('a subject page lists the other editions of its work', () => {
  const html = `<div class="gray_ad version_works"><h2><span>这本书的其他版本</span>
    <span class="pl">&nbsp;(<a href="https://book.douban.com/works/1000001">全部615</a>) </span></h2><ul>
    <li class="mb8 pl"><div class="meta-wrapper"><div class="meta">
      <a href="https://book.douban.com/subject/20000001/">北城人民出版社 （2013）</a>
      <div class="count"><span>8.1分</span> 121275人读过</div></div></div></li>
    <li class="mb8 pl"><div class="meta-wrapper"><div class="meta">
      <a href="https://book.douban.com/subject/1000078/">未知出版社 （2000）</a>
      <div class="count"> 2人读过</div></div></div></li></ul></div>`;
  assert.deepEqual(parseEditions(html), { works: '1000001', total: 615, editions: [
    { subject: '20000001', publisher: '北城人民出版社', year: '2013', rating: 8.1, readers: 121275 },
    { subject: '1000078', publisher: '未知出版社', year: '2000', rating: null, readers: 2 },
  ] });
  assert.deepEqual(parseEditions('<div id="info"></div>'), { works: null, total: 0, editions: [] });
});

test('marks of two editions of one work share a card once the work is known', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/1/status', 'a', 'social')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  const now = 1_800_000_000;
  add.run(1, 'g1', '甲 想读: 《局外人》', card(11, '局外人'), now - 30);
  add.run(2, 'g2', '乙 读过: 《局外人》', card(12, '局外人'), now - 20);
  add.run(3, 'g3', '丙 想读: 《局外人》', card(11, '局外人'), now - 10);
  assert.equal(listMarks(db, { unreadOnly: true, now }).length, 2);
  db.prepare("INSERT INTO douban_subject (subject, works, total, editions, editions_at) VALUES ('11', 'w1', 2, ?, ?)")
    .run(JSON.stringify([{ subject: '12', publisher: '', year: '', rating: null, readers: 0 }]), now);
  const groups = listMarks(db, { unreadOnly: true, now });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'book:11');
  assert.deepEqual([groups[0].people, groups[0].unread, groups[0].marks.length], [3, 3, 3]);
});

test('a 想读 made on the other edition still shows on the merged card, and a damaged cache row is skipped', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'rsshub://douban/people/1/status', 'a', 'social')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  const now = 1_800_000_000;
  add.run(1, 'g1', '甲 想读: 《局外人》', card(11, '局外人'), now - 30);
  add.run(2, 'g2', '乙 读过: 《局外人》', card(11, '局外人'), now - 25);
  add.run(3, 'g3', '丙 读过: 《局外人》', card(12, '局外人'), now - 20);
  db.prepare("INSERT INTO douban_subject (subject, works, total, editions, editions_at) VALUES ('11', 'w1', 2, ?, ?)")
    .run(JSON.stringify([{ subject: '12', publisher: '', year: '', rating: null, readers: 0 }]), now);
  db.prepare("INSERT INTO douban_subject (subject, wished_at) VALUES ('12', ?)").run(now);
  db.prepare("INSERT INTO douban_subject (subject, works, editions, editions_at) VALUES ('99', 'w9', 'not json', ?)").run(now);
  const groups = listMarks(db, { unreadOnly: true, now });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'book:11');
  assert.equal(groups[0].wished, true);
});
