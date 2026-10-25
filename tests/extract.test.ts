import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { postLines, parseJson, pendingCount } from '../server/content/extract.ts';
import { tocExtractor, withAbstracts, journalTocs, TOC_VERSION } from '../server/content/tocs.ts';
import { noticeExtractor, academicNotices, noticeKey, type Notice } from '../server/content/notices.ts';

test('postLines keeps a line per paragraph and decodes entities', () => {
  assert.deepEqual(postLines('<section><p>目&nbsp;录</p><p>题目<br>作者 &amp; 译者</p></section><p>  </p>'), ['目 录', '题目', '作者 & 译者']);
});

test('parseJson reads fenced or padded JSON and gives null for none', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('好的：{"a":[2]} 以上'), { a: [2] });
  assert.equal(parseJson('没有'), null);
  assert.equal(parseJson('{"a":'), null);
});

const art = (title: string, authors: string[], extra: Record<string, unknown> = {}) => ({ title, authors, subtitle: '', translators: [], page: '', ...extra });

test('a table of contents is mended where the AI errs the same way each time', () => {
  const toc = tocExtractor.read({ journal: '《世界文学》', issue: '2026年第5期', sections: [
    { name: '特别企划', articles: [art('老龄化社会与青年发展', []), art('守望乡土——论驻村文学', ['苏禾'], { subtitle: '——论驻村文学' })] },
    { name: '小说', articles: [art('入谷之前', ['〔新加坡〕林清岚作'], { translators: ['白鹭'] }), art('启示录', ['柯   远'])] },
  ] }, '');
  assert.ok(toc);
  assert.equal(toc.journal, '世界文学');
  assert.deepEqual(toc.sections.map((s) => s.articles.map((a) => a.title)), [['守望乡土'], ['入谷之前', '启示录']]);
  assert.equal(toc.sections[0].articles[0].subtitle, '论驻村文学');
  assert.deepEqual(toc.sections[1].articles[0].authors, ['〔新加坡〕林清岚']);
  assert.deepEqual(toc.sections[1].articles[1].authors, ['柯远']);
});

test('a post that is not one issue\'s contents gives nothing', () => {
  assert.equal(tocExtractor.read({ journal: '', issue: '', sections: [] }, ''), null);
  assert.equal(tocExtractor.read({ journal: '某刊', issue: '1', sections: [{ name: '', articles: [art('一', ['甲']), art('二', ['乙'])] }] }, ''), null);
  assert.equal(tocExtractor.read('nonsense', ''), null);
});

test('abstracts printed after the contents are hung on their articles, a broken title too', () => {
  const sections = [{ name: '', articles: [
    { ...art('埃尔德的手迹：《旧港手稿》中的性别权力与文化协商', ['马晴川']), abstract: '', keywords: [] },
    { ...art('渡鸦：《雾港》中的“语言动物”', ['冯远舟']), abstract: '', keywords: [] },
  ] }];
  const lines = ['渡鸦：《雾港》中的 “语言动物”', '冯远舟', '摘  要：渡鸦是一个无法定义的语言动物。', '关键词：《雾港》；戏剧；渡鸦',
    '在线阅读：', '埃尔德的手迹：', '《旧港手稿》中的性别权力', '与文化协商', '马晴川', '摘要：《旧港手稿》是一部协作性诗歌抄本，', '生成于都铎时期。', '关键词：文本性理论；文化协商'];
  const [s] = withAbstracts(sections, lines);
  assert.equal(s.articles[0].abstract, '《旧港手稿》是一部协作性诗歌抄本，生成于都铎时期。');
  assert.deepEqual(s.articles[0].keywords, ['文本性理论', '文化协商']);
  assert.equal(s.articles[1].abstract, '渡鸦是一个无法定义的语言动物。');
  assert.deepEqual(s.articles[1].keywords, ['《雾港》', '戏剧', '渡鸦']);
});

test('notices are kept to the kinds and dates the page understands', () => {
  const out = noticeExtractor.read({ items: [
    { kind: '学术会议', name: '某研讨会', date: '2026年11月', deadline: '2026-10-30', speakers: ['甲'] },
    { kind: '讲座', name: '某讲座', date: '2026-11-06', end: '2026-11-06', speakers: ['叶晚晴'] },
    { kind: '会议', name: '' },
  ] }, '');
  assert.ok(out);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, '活动');
  assert.equal(out[0].date, '');
  assert.equal(out[0].deadline, '2026-10-30');
  assert.deepEqual(out[0].speakers, []);
  assert.equal(out[1].end, '');
  assert.deepEqual(out[1].speakers, ['叶晚晴']);
  assert.equal(noticeExtractor.read({ items: [] }, ''), null);
});

test('a conference\'s first and second notices share a key', () => {
  const n = (name: string): Notice => ({ kind: '会议', name, date: '', end: '', deadline: '', place: '', organizer: '', speakers: [], contact: '', summary: '', online: '', live: '' });
  assert.equal(noticeKey(n('“回望与出发”学术研讨会（一号通知）')), noticeKey(n('“回望与出发”学术研讨会二号通知')));
  assert.equal(noticeKey(n('“回望与出发”学术研讨会')), noticeKey(n('回望与出发学术研讨会邀请函')));
  assert.equal(noticeKey(n('理想，还需要吗？——白川作品对谈（远川讲座第64讲）')), noticeKey(n('理想，还需要吗？——白川作品对谈')));
  assert.equal(noticeKey({ ...n('《远方文学评论（高教版）》2027年稿件'), kind: '征稿' }), noticeKey({ ...n('《远方文学评论（高教版）》'), kind: '征稿' }));
});

test('a conference named with and without its theme shows once; one on now comes first', () => {
  const { db, add, put } = setup();
  add(1, '年会通知', 9);
  add(2, '年会二轮通知', 4);
  add(3, '展览', 2);
  put.run(1, 'notice', JSON.stringify([notice({ name: '第三十三届松溪传记文学研究年会', date: '2026-11-20' })]));
  put.run(2, 'notice', JSON.stringify([notice({ name: '第三十三届松溪传记文学研究年会：区域传记书写研究', date: '2026-11-20' })]));
  put.run(3, 'notice', JSON.stringify([notice({ kind: '活动', name: '楼外楼：北城美术中的望海楼', date: '2026-09-23', end: '2026-12-31' })]));
  const page = academicNotices(db, { kind: '', past: false, now: new Date(2026, 9, 23) });
  assert.deepEqual(page.items.map((v) => [v.name, v.next?.what, v.posts]), [
    ['楼外楼：北城美术中的望海楼', '进行中', 1], ['第三十三届松溪传记文学研究年会：区域传记书写研究', '举办', 2]]);
});

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '某公众号')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  const put = db.prepare('INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, ?, 1, ?, 0)');
  const now = Math.floor(Date.now() / 1000);
  return { db, add: (id: number, title: string, back: number) => add.run(id, `g${id}`, title, '<p>正文</p>', now - back * 86_400), put };
}

const notice = (o: Partial<Notice>): Notice => ({ kind: '会议', name: '', date: '', end: '', deadline: '', place: '', organizer: '', speakers: [], contact: '', summary: '', online: '', live: '', ...o });

test('学术动态 lists what is to come nearest first, merges repeats and keeps what is over aside', () => {
  const { db, add, put } = setup();
  const today = new Date(2026, 9, 23);
  add(1, '会议通知（一号）', 20);
  add(2, '会议通知（二号）', 5);
  add(3, '讲座与征稿', 3);
  put.run(1, 'notice', JSON.stringify([notice({ name: '认知诗学研讨会（一号通知）', date: '2026-12-05', organizer: '某大学' })]));
  put.run(2, 'notice', JSON.stringify([notice({ name: '认知诗学研讨会（二号通知）', date: '2026-12-05', deadline: '2026-11-10' })]));
  put.run(3, 'notice', JSON.stringify([notice({ kind: '讲座', name: '慢读与快读', date: '2026-10-30' }),
    notice({ kind: '征稿', name: '某集刊' }), notice({ kind: '讲座', name: '已开过的讲座', date: '2026-10-01' })]));
  const page = academicNotices(db, { kind: '', past: false, now: today });
  assert.deepEqual(page.items.map((n) => n.name), ['慢读与快读', '认知诗学研讨会（二号通知）', '某集刊']);
  const conf = page.items[1];
  assert.deepEqual(conf.next, { what: '截止', date: '2026-11-10' });
  assert.equal(conf.organizer, '某大学');          // from the first notice
  assert.equal(conf.posts, 2);
  assert.equal(page.items[2].status, 'open');
  assert.equal(page.past, 1);
  assert.deepEqual(page.kinds, [{ label: '会议', n: 1 }, { label: '征稿', n: 1 }, { label: '讲座', n: 1 }]);
  assert.deepEqual(academicNotices(db, { kind: '讲座', past: true, now: today }).items.map((n) => n.name), ['慢读与快读', '已开过的讲座']);
});

test('a roundup gives its notices no pictures; a notice of its own post takes that post', () => {
  const { db, add, put } = setup();
  add(1, '年会通知', 9);
  add(2, '会议汇总', 2);
  put.run(1, 'notice', JSON.stringify([notice({ name: '第八届外语学科发展联盟年会', date: '2026-11-20' })]));
  put.run(2, 'notice', JSON.stringify([notice({ name: '第八届外语学科发展联盟年会', date: '2026-11-20' }),
    ...Array.from({ length: 6 }, (_, i) => notice({ name: `汇总里的第${i + 1}个会`, date: '2026-12-01' }))]));
  const page = academicNotices(db, { kind: '', past: false, now: new Date(2026, 9, 23) });
  const own = (name: string) => page.items.find((n) => n.name === name)?.own;
  assert.equal(own('第八届外语学科发展联盟年会')?.id, 1);
  assert.equal(own('汇总里的第1个会'), null);
});

test('期刊目录 shows an issue posted twice once, and counts what is left to read', () => {
  const { db, add } = setup();
  add(1, '《外国文学》2026年第4期目录', 30);
  add(2, '转发：《外国文学》2026年第4期目录及摘要', 10);
  add(3, '《世界文学》2026年第5期目录', 2);
  add(4, '软件目录', 1);
  const toc = (journal: string) => JSON.stringify({ journal, issue: '2026年第4期', sections: [{ name: '', articles: [] }] });
  const putToc = db.prepare('INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, ?, ?, ?, 0)');
  putToc.run(1, 'toc', TOC_VERSION, toc('外国文学'));
  putToc.run(2, 'toc', TOC_VERSION, toc('外国文学'));
  putToc.run(4, 'toc', TOC_VERSION, null);
  const page = journalTocs(db, { journal: '', offset: 0, limit: 10 });
  assert.equal(page.total, 1);
  assert.equal(page.issues[0].post?.id, 2);
  assert.deepEqual(page.journals, [{ label: '外国文学', n: 1, group: '外国文学' }]);
  assert.equal(pendingCount(db, tocExtractor), 1);     // only 《世界文学》 is still to read
});

test('two sessions of a series, or a talk on another day, are not merged', () => {
  const { db, add, put } = setup();
  add(1, '论坛上海站', 3);
  add(2, '论坛成都站', 2);
  put.run(1, 'notice', JSON.stringify([notice({ name: '青年学者论坛（上海站）', date: '2026-11-10' })]));
  put.run(2, 'notice', JSON.stringify([notice({ name: '青年学者论坛（成都站）', date: '2026-12-05' }), notice({ name: '（第65讲）' }), notice({ name: '（第66讲）' })]));
  const page = academicNotices(db, { kind: '', past: false, now: new Date(2026, 9, 23) });
  assert.equal(page.items.length, 4);
});

test('a second notice that moves the deadline is the same conference; a special issue is not the standing call', () => {
  const { db, add, put } = setup();
  add(1, '一号通知', 9);
  add(2, '二号通知', 3);
  put.run(1, 'notice', JSON.stringify([notice({ name: '某年会', date: '2026-12-05', deadline: '2026-10-30' }),
    notice({ kind: '征稿', name: '《某刊》', deadline: '2026-11-30' })]));
  put.run(2, 'notice', JSON.stringify([notice({ name: '某年会', date: '2026-12-05', deadline: '2026-11-15' }),
    notice({ kind: '征稿', name: '《某刊》专刊', deadline: '2027-01-31' })]));
  const page = academicNotices(db, { kind: '', past: false, now: new Date(2026, 9, 23) });
  assert.deepEqual(page.items.map((v) => [v.name, v.deadline, v.posts]), [
    ['某年会', '2026-11-15', 2], ['《某刊》', '2026-11-30', 1], ['《某刊》专刊', '2027-01-31', 1]]);
});

test("a roundup's shortened name and a conference's call for papers are the conference", () => {
  const { db, add, put } = setup();
  add(1, '征稿通知', 9);
  add(2, '会议通知', 5);
  add(3, '会议汇总', 2);
  put.run(1, 'notice', JSON.stringify([notice({ kind: '征稿', name: '松溪文艺理论研究2026年度论坛', deadline: '2026-11-01' })]));
  put.run(2, 'notice', JSON.stringify([notice({ name: '松溪文艺理论研究2026年度论坛', date: '2026-12-15' }),
    notice({ name: '第八届北城高校外语学科发展联盟年会暨新时代背景下外语学科守正创新与价值重构研讨会', date: '2026-12-26' })]));
  put.run(3, 'notice', JSON.stringify([notice({ name: '第八届北城高校外语学科发展联盟年会暨外语学科守正创新与价值重构研讨会', date: '2026-12-26' }),
    notice({ name: '第八届北城高校外语学科发展联盟年会暨另一个研讨会', date: '2027-03-01' })]));
  const page = academicNotices(db, { kind: '', past: false, now: new Date(2026, 9, 23) });
  assert.deepEqual(page.items.map((v) => [v.kind, v.posts]), [['会议', 2], ['会议', 2], ['会议', 1]]);
  assert.equal(page.items[0].deadline, '2026-11-01');
});

test('期刊目录 keeps unnumbered issues apart, shows the fullest copy, and skips a row written wrong', () => {
  const { db, add, put } = setup();
  const toc = (issue: string, n: number) => JSON.stringify({ journal: '外国文学', issue,
    sections: [{ name: '', articles: Array.from({ length: n }, (_, i) => ({ title: `篇${i}`, subtitle: '', authors: ['甲'], translators: [], page: '', abstract: '', keywords: [] })) }] });
  add(1, '目录甲', 30); add(2, '目录乙', 20); add(3, '全文目录', 12); add(4, '预告', 10); add(5, '坏行', 5);
  put.run(1, 'toc', toc('', 5));
  put.run(2, 'toc', toc('', 6));
  put.run(3, 'toc', toc('2026年第4期', 17));
  put.run(4, 'toc', toc('2026年第4期', 3));
  put.run(5, 'toc', '{"journal":');
  const page = journalTocs(db, { journal: '', offset: 0, limit: 10 });
  assert.deepEqual(page.issues.map((t) => [t.post?.id, t.articles]), [[3, 17], [2, 6], [1, 5]]);
});

test('期刊目录 shows an issue in Chinese when its 英文目录 came after with as many articles', () => {
  const { db, add, put } = setup();
  const toc = (titles: string[]) => JSON.stringify({ journal: '松溪青年研究', issue: '2026年第10期',
    sections: [{ name: '', articles: titles.map((title) => ({ title, subtitle: '', authors: ['甲'], translators: [], page: '', abstract: '', keywords: [] })) }] });
  add(1, '《松溪青年研究》2026年第10期目录', 14); add(2, 'Songxi Youth Study, Issue 10, 2026（英文目录）', 1);
  put.run(1, 'toc', toc(['少子化社会与青年发展', '“反向适老”', '老年课堂里的青年人']));
  put.run(2, 'toc', toc(['Low Fertility Society and Youth Development', '“Reverse Aging-Adaptation”', 'Young People in Classrooms for the Elderly']));
  const [issue] = journalTocs(db, { journal: '', offset: 0, limit: 10 }).issues;
  assert.equal(issue.post?.id, 1);
  assert.equal(issue.sections[0].articles[0].title, '少子化社会与青年发展');
});
