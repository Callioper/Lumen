import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { coreName, queries, recordings, due, seconds, type Video } from '../server/content/replays.ts';
import { academicNotices, replayKey, type Notice } from '../server/content/notices.ts';

const notice = (o: Partial<Notice>): Notice => ({ kind: '讲座', name: '', date: '', end: '', deadline: '', place: '', organizer: '',
  speakers: [], contact: '', summary: '', online: '', live: '', ...o });
const at = (ymd: string): number => new Date(`${ymd}T20:00:00`).getTime() / 1000;
const video = (title: string, day: string, duration: string): Video => ({ bvid: 'BV1', title, author: 'up', pubdate: at(day), duration });

test('an event goes by its title without quotes, series and subtitle', () => {
  assert.equal(coreName('“一生所念”——2026年第25场知名学者学术讲座（远川讲座第58讲）'), '一生所念');
  assert.equal(coreName('百年诞辰 听见林舟——《林舟：广播电台访谈》新书分享'), '百年诞辰 听见林舟');
  assert.equal(seconds('121:52'), 7312);
  assert.equal(seconds('1:02:03'), 3723);
});

test('B站 is asked by title and first speaker, then the speakers, then the title', () => {
  assert.deepEqual(queries(notice({ name: '一生所念：对谈', speakers: ['林舟', '苏禾', '江屿'] })), ['一生所念 林舟', '林舟 苏禾 江屿', '一生所念']);
  assert.deepEqual(queries(notice({ name: '白川致夏迟书信手稿考释', speakers: ['季远教授（北城大学）'] })), ['白川致夏迟书信手稿考释 季远', '白川致夏迟书信手稿考释']);
});

test('a recording is long, put up after the event, and named for it', () => {
  const talk = notice({ name: '“一生所念”——知名学者学术讲座', date: '2026-10-22', speakers: ['林舟', '苏禾', '江屿'] });
  const found = recordings(talk, [
    video('林舟、苏禾、江屿：<em class="keyword">一生所念</em>的文学和电影', '2026-10-22', '121:52'),   // the one
    video('林舟 一生所念 精彩片段', '2026-10-23', '3:10'),                                          // a clip
    video('林舟、江屿：一生所念', '2026-05-01', '90:00'),                                          // before it
    video('江屿谈电影', '2026-10-24', '60:00'),                                                       // one speaker, other title
  ]);
  assert.deepEqual(found.map((v) => v.title), ['林舟、苏禾、江屿：一生所念的文学和电影']);
  const fuke = notice({ name: '百年诞辰 听见林舟——新书分享会', date: '2026-10-15', speakers: ['董远宝', '汪晚安'] });
  assert.equal(recordings(fuke, [video('董远宝×汪晚安 | 百年诞辰，听见林舟', '2026-10-17', '110:26')]).length, 1);
});

test('looked for on days 1, 3, 7, 14 and 30 after it ended, and no more after', () => {
  const n = notice({ date: '2026-10-01' });
  const day = (ymd: string): number => new Date(`${ymd}T00:00:00`).getTime() / 1000;
  assert.equal(due(n, '2026-10-01', undefined), false);                 // not over yet
  assert.equal(due(n, '2026-10-02', undefined), true);
  assert.equal(due(n, '2026-10-03', day('2026-10-02')), false);         // looked on day 1
  assert.equal(due(n, '2026-10-04', day('2026-10-02')), true);          // day 3 has come
  assert.equal(due(n, '2026-11-15', undefined), false);                 // let go
  assert.equal(due(notice({ kind: '征稿', date: '2026-10-01' }), '2026-10-02', undefined), false);
});

test('学术动态 shows an event that is over while its recording is recent, and narrows to what can be followed online', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://a/feed', '远川', 'article')").run();
  const now = new Date();
  const ymd = (back: number): string => { const d = new Date(now.getTime() - back * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const items = [
    notice({ name: '已过有录像', date: ymd(5) }), notice({ name: '已过无录像', date: ymd(5) }),
    notice({ name: '要来的直播', date: ymd(-3), online: '线上线下', live: 'B站 远川' }), notice({ name: '要来的线下', date: ymd(-3) }),
  ];
  db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (1, 1, ?, ?, ?, ?)').run('g', '讲座预告', '<p>x</p>', Math.floor(now.getTime() / 1000));
  db.prepare("INSERT INTO extract (entry_id, kind, version, data, at) VALUES (1, 'notice', 2, ?, 0)").run(JSON.stringify(items));
  db.prepare('INSERT INTO replay (key, checked, found) VALUES (?, 0, ?)').run(replayKey(items[0]),
    JSON.stringify([{ bvid: 'BV1', title: '录像', author: '远川', at: 0, minutes: 90 }]));
  const page = academicNotices(db, { kind: '', past: false, now });
  assert.deepEqual(page.items.map((n) => [n.name, n.status]), [['要来的直播', 'upcoming'], ['要来的线下', 'upcoming'], ['已过有录像', 'recorded']]);
  assert.equal(page.items[2].replays[0].bvid, 'BV1');
  assert.equal(page.online, 1);
  assert.deepEqual(academicNotices(db, { kind: '', past: false, online: true, now }).items.map((n) => n.name), ['要来的直播']);
});

test('a post read by the first prompt still shows, without online, until it is read again', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://a/feed', '号', 'article')").run();
  db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (1, 1, ?, ?, ?, ?)').run('g', '征稿', '<p>x</p>', Math.floor(Date.now() / 1000));
  const { online: _o, live: _l, ...v1 } = notice({ kind: '征稿', name: '《某刊》' });
  db.prepare("INSERT INTO extract (entry_id, kind, version, data, at) VALUES (1, 'notice', 1, ?, 0)").run(JSON.stringify([v1]));
  const [n] = academicNotices(db, { kind: '', past: false }).items;
  assert.deepEqual([n.name, n.online, n.live], ['《某刊》', '', '']);
});

test('one talk under three names on one day, by two of its speakers, is one item', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://a/feed', '号', 'article')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (?, 1, ?, ?, ?, ?)');
  const put = db.prepare("INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, 'notice', 2, ?, 0)");
  const sp = ['林舟', '苏禾', '江屿'];
  ['一生所念', '一生所念：林舟、苏禾、江屿对谈', '“一生所念”——2026年第25场知名学者学术讲座（远川讲座第58讲）'].forEach((name, i) => {
    add.run(i + 1, `g${i}`, '预告', '<p>x</p>', Math.floor(Date.now() / 1000) - i);
    put.run(i + 1, JSON.stringify([notice({ name, date: '2099-01-01', speakers: sp })]));
  });
  add.run(9, 'g9', '预告', '<p>x</p>', 0);
  put.run(9, JSON.stringify([notice({ name: '另一场', date: '2099-01-01', speakers: ['江屿'] })]));
  assert.deepEqual(academicNotices(db, { kind: '', past: false }).items.map((n) => [n.name, n.posts]), [['一生所念', 3], ['另一场', 1]]);
});

test('a forwarded workshop named its own way, by one organiser in one city on one day, is one item', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://a/feed', '号', 'social')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (?, 1, ?, ?, ?, ?)');
  const put = db.prepare("INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, 'notice', 2, ?, 0)");
  const host = { kind: '会议' as const, date: '2099-01-01', organizer: '《松溪社会》', place: '上海' };
  [['《松溪社会》组织的社会理论工作坊', 1], ['《松溪社会》社会理论工作坊', 2]].forEach(([name, id]) => {
    add.run(id, `g${id}`, '转发', '<p>x</p>', Math.floor(Date.now() / 1000) - Number(id));
    put.run(id, JSON.stringify([notice({ ...host, name: String(name) })]));
  });
  add.run(3, 'g3', '转发', '<p>x</p>', 0);
  put.run(3, JSON.stringify([notice({ ...host, place: '北京', name: '《松溪社会》另一场' })]));
  assert.deepEqual(academicNotices(db, { kind: '', past: false }).items.map((n) => n.posts), [2, 1]);
});

test('two copies of one talk show the fuller one: its name, its speakers', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://a/feed', '号', 'article')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (?, 1, ?, ?, ?, ?)');
  const put = db.prepare("INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, 'notice', 2, ?, 0)");
  add.run(1, 'g1', '直播预告', '<p>x</p>', Math.floor(Date.now() / 1000) - 100);
  put.run(1, JSON.stringify([notice({ name: 'AI、哲学与艺术NO.17：机器人代劳——自动化时代生成新需求的制度原型', date: '2099-01-01', speakers: ['梅远华', '陈本川'], summary: '探讨制度原型' })]));
  add.run(2, 'g2', '直播预告', '<p>x</p>', Math.floor(Date.now() / 1000));
  put.run(2, JSON.stringify([notice({ name: 'AI、哲学与艺术NO.17：机器人', date: '2099-01-01', online: '线上' })]));
  const [n] = academicNotices(db, { kind: '', past: false }).items;
  assert.equal(n.posts, 2);
  assert.match(n.name, /机器人代劳/);
  assert.deepEqual([n.speakers.length, n.online], [2, '线上']);
});
