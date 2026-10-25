import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { boxesToLines, postImages, type OcrBox } from '../server/content/ocr.ts';
import { readReprints, reprintIndex, reprintBookIndex, bookAuthorNames, isHumanities, REPRINT_VERSION } from '../server/content/reprints.ts';
import { journalTocs, journalGroup, TOC_VERSION } from '../server/content/tocs.ts';

const box = (x0: number, y0: number, x1: number, text: string, h = 24): OcrBox =>
  ({ box: [[x0, y0], [x1, y0], [x1, y0 + h], [x0, y0 + h]], score: 0.99, text });

test('a contents page beside its imprint reads column by column, a running head across both let be', () => {
  const lines = boxesToLines([
    box(60, 20, 1000, '全国教育类权威期刊 中小学骨干教师必备'),
    box(20, 100, 380, '主 管：中华人民共和国教育部'),
    box(400, 100, 820, '03 化学教学中发散性思维的特征、'),
    box(20, 140, 300, '主 办：中国人民大学'),
    box(470, 140, 700, '影响因素与培养路径'), box(900, 140, 1060, '鲁晚晴、毕远林'),
    box(20, 180, 360, '编辑出版：中国人民大学书报资料中心'),
    box(400, 180, 800, '08 《松溪药谱》中的化学知识体系'),
    box(20, 220, 250, '中心主任：徐远军'),
    box(470, 220, 600, '与教育价值研究'), box(950, 220, 1060, '张远方等'),
  ]);
  assert.deepEqual(lines, [
    '全国教育类权威期刊 中小学骨干教师必备',
    '主 管：中华人民共和国教育部', '主 办：中国人民大学', '编辑出版：中国人民大学书报资料中心', '中心主任：徐远军',
    '03 化学教学中发散性思维的特征、', '影响因素与培养路径 鲁晚晴、毕远林', '08 《松溪药谱》中的化学知识体系', '与教育价值研究 张远方等',
  ]);
});

test('a post\'s pictures are its originals, not wechat2rss\'s relay', () => {
  const u = encodeURIComponent('https://mmbiz.qpic.cn/a/640?wx_fmt=png');
  assert.deepEqual(postImages(`<p><img src="https://w.example/img-proxy/?k=1&amp;u=${u}"><img data-src="https://mmbiz.qpic.cn/b/0"></p>`),
    ['https://mmbiz.qpic.cn/a/640?wx_fmt=png', 'https://mmbiz.qpic.cn/b/0']);
});

const answer = { journals: [
  { name: '《出版业》', code: '', issue: '2026年第8期', sections: [{ name: '', articles: [
    { title: '“署名理论”视域下机器生成作品的作者认定', authors: ['冯远青', '刘 晚妮'], source: '《松溪法学》2026年第4期', abstract: '机器生成作品的出现引发作者身份危机。' },
  ] }] },
  { name: '', issue: '2026年第8期', sections: [] },
] };

test('the AI\'s answer keeps the journals that list an article', () => {
  const read = readReprints(answer)!;
  assert.equal(read.length, 1);
  assert.equal(read[0].name, '出版业');
  assert.deepEqual(read[0].sections[0].articles[0].authors, ['冯远青', '刘晚妮']);
  assert.equal(readReprints({ journals: [] }), null);
});

test('a reprinted article is marked in 期刊目录, and the 复印 issue is listed in its own group', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://a/feed', '某刊', 'article')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  const put = db.prepare('INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, ?, ?, ?, 0)');
  add.run(1, 'g1', '《松溪法学》2026年第4期目录', '', 100);
  add.run(2, 'g2', '抢鲜看 | 人大复印报刊资料最新目录与文章摘要', '', 200);
  const art = (title: string) => ({ title, subtitle: '', authors: ['某'], translators: [], page: '', abstract: '', keywords: [] });
  put.run(1, 'toc', TOC_VERSION, JSON.stringify({ journal: '松溪法学', issue: '2026年第4期', sections: [{ name: '', articles: [
    art('“署名理论”视域下机器生成作品的作者认定'), art('数据产权的三重结构'), art('平台责任再思考')] }] }));
  put.run(2, 'reprint', REPRINT_VERSION, JSON.stringify(readReprints(answer)));
  assert.equal(reprintIndex(db)('署名理论视域下机器生成作品的作者认定'), '人大复印《出版业》2026年第8期');
  const page = journalTocs(db, { journal: '', offset: 0, limit: 10 });
  const own = page.issues.find((t) => t.source === 'post')!;
  assert.equal(own.sections[0].articles[0].reprint, '人大复印《出版业》2026年第8期');
  assert.equal(own.sections[0].articles[1].reprint, undefined);
  const copy = page.issues.find((t) => t.source === 'reprint')!;
  assert.equal(copy.journal, '人大复印·出版业');
  assert.equal(copy.sections[0].articles[0].reprintOf, '《松溪法学》2026年第4期');
  assert.equal(journalGroup(copy.journal), '人大复印');
  assert.deepEqual(page.sources.map((s) => s.label), ['公众号', '人大复印']);
});

test('a book\'s Chinese authors are matched by name, a foreign one not', () => {
  assert.deepEqual(bookAuthorNames('张三、李四 主编'), ['张三', '李四']);
  assert.deepEqual(bookAuthorNames('[美] 尤金·罗斯 著'), []);
  assert.deepEqual(bookAuthorNames('（清）王远之撰'), ['王远之']);
  assert.equal(isHumanities('文艺理论'), true);
  assert.equal(isHumanities('中国古代、近代文学研究'), true);
  assert.equal(isHumanities('中学历史、地理教与学'), false);
  assert.equal(isHumanities('法理学、法史学'), false);
});

test('a book shows 人大复印 for an article naming it, or one by its author; school journals left out on asking', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title, view) VALUES (1, 'https://a/feed', '书报资料中心', 'article')").run();
  db.prepare("INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (1, 1, 'g', '全文转载文章目录', '', 100, 0)").run();
  const art = (title: string, authors: string[]) => ({ title, authors, source: '' });
  db.prepare('INSERT INTO extract (entry_id, kind, version, data, at) VALUES (1, ?, ?, ?, 0)').run('reprint', REPRINT_VERSION, JSON.stringify(readReprints({ journals: [
    { name: '文艺理论', issue: '2026年第10期', sections: [{ name: '', articles: [art('重读《写实传统的历史》：一种辩证法', ['王五'])] }] },
    { name: '初中语文教与学', issue: '2026年第9期', sections: [{ name: '', articles: [art('整本书阅读的任务设计', ['赵六'])] }] },
  ] })));
  const all = reprintBookIndex(db);
  assert.equal(all({ title: '写实传统的历史：从古典小说到今天', authors: '[英] 某某 著' })?.review?.label, '人大复印《文艺理论》2026年第10期');
  assert.equal(all({ title: '另一本书', authors: '王五 著' })?.author?.name, '王五');
  assert.equal(all({ title: '课堂', authors: '赵六 著' })?.author?.label, '人大复印《初中语文教与学》2026年第9期');
  assert.equal(reprintBookIndex(db, true)({ title: '课堂', authors: '赵六 著' }), undefined);
  assert.equal(all({ title: '无关', authors: '钱七' }), undefined);
});
