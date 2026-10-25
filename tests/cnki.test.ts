import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { issueNumber, cnkiIssues, cnkiLinker, journalKey, searchCnki } from '../server/content/cnki.ts';
import { journalTocs, journalGroup } from '../server/content/tocs.ts';

const day = (ymd: string): number => new Date(`${ymd}T00:00:00`).getTime() / 1000;

test('the issue number follows from the pace of issue; too few issues or no steady pace gives none', () => {
  const bimonthly = [day('2026-03-25'), day('2026-05-25'), day('2026-07-25')];
  assert.equal(issueNumber(day('2026-07-25'), bimonthly), '4');
  assert.equal(issueNumber(day('2026-09-05'), [day('2026-07-05'), day('2026-09-05')]), '5');
  assert.equal(issueNumber(day('2026-08-25'), [day('2026-06-25'), day('2026-07-25'), day('2026-08-25')]), '8');
  assert.equal(issueNumber(day('2026-08-25'), [day('2026-08-25')]), '');
  assert.equal(issueNumber(day('2026-08-25'), [day('2026-08-10'), day('2026-08-25')]), '');
});

test('a journal name is matched without its edition in brackets', () => {
  assert.equal(journalKey('北京大学学报(哲社版)'), journalKey('《北京大学学报》'));
});

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://rss.cnki.net/knavi/rss/NFWT?pcode=CJFD,CCJD', '南方文坛'), (2, 'https://e.org/feed', '某号')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, author, content, link, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run(1, 1, 'a', 'AI是寻常的', '苏晚;', '&lt;正&gt;一、对雷蒙·威尔顿的百年致敬', 'https://kns.cnki.net/kcms2/a', day('2026-09-05'));
  add.run(2, 1, 'b', '一位诗人的四副面孔', '温叙;', '本文讨论诗人的四种形象。', 'https://kns.cnki.net/kcms2/b', day('2026-09-05'));
  add.run(3, 1, 'c', '同期次日入库', '某丙;', '摘要', 'https://kns.cnki.net/kcms2/d', day('2026-09-06'));
  add.run(4, 1, 'd', '旧一期', '某甲;某乙;', '摘要', 'https://kns.cnki.net/kcms2/c', day('2026-07-05'));
  add.run(5, 1, 'e', '旧一期二', '', '摘要', null, day('2026-07-05'));
  add.run(6, 1, 'f', '旧一期三', '', '摘要', null, day('2026-07-05'));
  add.run(7, 1, 'g', '网络首发', '', '摘要', null, day('2026-10-20'));
  return db;
}

test('CNKI entries dated within days of each other make one issue; a stray online-first one none', () => {
  const issues = cnkiIssues(seed());
  assert.deepEqual(issues.map((t) => [t.issue, t.articles.length, t.partial]), [['2026年第5期', 3, false], ['2026年第4期', 3, true]]);
  const [, lead, abs] = issues[0].articles;
  assert.equal(lead.lead, true);
  assert.equal(lead.abstract, '一、对雷蒙·威尔顿的百年致敬');
  assert.equal(abs.lead, false);
  assert.deepEqual(issues[1].articles[0].authors, ['某甲', '某乙']);
  assert.equal(issues[1].articles[1].link, searchCnki('TI', '旧一期二'));
  assert.equal(issues[0].link, 'https://navi.cnki.net/knavi/journals/NFWT/detail?uniplatform=NZKPT');
});

test('contents read from posts link to the CNKI article when a feed has it, else to a search', () => {
  const link = cnkiLinker(seed());
  assert.equal(link.article('AI 是寻常的'), 'https://kns.cnki.net/kcms2/a');
  assert.equal(link.article('别的文章'), searchCnki('TI', '别的文章'));
  assert.equal(link.journal('《南方文坛》'), 'https://navi.cnki.net/knavi/journals/NFWT/detail?uniplatform=NZKPT');
  assert.equal(link.journal('文艺理论研究'), searchCnki('LY', '文艺理论研究'));
});

test('the contents page takes both sources, newest first, and narrows to one', () => {
  const db = seed();
  db.prepare("INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (9, 2, 'p', '目录', '<p>x</p>', ?)").run(day('2026-08-01'));
  db.prepare("INSERT INTO extract (entry_id, kind, version, data, at) VALUES (9, 'toc', 1, ?, 0)")
    .run(JSON.stringify({ journal: '文艺理论研究', issue: '2026年第2期', sections: [{ name: '', articles: [{ title: 'AI是寻常的', subtitle: '', authors: [], translators: [], page: '', abstract: '', keywords: [] }] }] }));
  const page = journalTocs(db, { journal: '', offset: 0, limit: 10 });
  assert.deepEqual(page.issues.map((t) => t.key), ['cnki:1:' + day('2026-09-05'), 'post:9', 'cnki:1:' + day('2026-07-05')]);
  assert.equal(page.issues[1].sections[0].articles[0].link, 'https://kns.cnki.net/kcms2/a');
  assert.deepEqual(page.sources, [{ label: '公众号', n: 1 }, { label: '知网', n: 2 }]);
  assert.equal(journalTocs(db, { journal: '', source: 'post', offset: 0, limit: 10 }).total, 1);
});

test('a CNKI feed lends a post its abstracts; an article opening is not one', () => {
  const link = cnkiLinker(seed());
  assert.equal(link.abstract('一位诗人的四副面孔'), '本文讨论诗人的四种形象。');
  assert.equal(link.abstract('AI是寻常的'), '');
  assert.equal(link.abstract('没有的文章'), '');
});

test('journals fall into kinds, the subject before the university', () => {
  assert.equal(journalGroup('西安外国语大学学报'), '外语');
  assert.equal(journalGroup('南开学报(哲社版)'), '综合·学报');
  assert.equal(journalGroup('中国社会科学'), '综合·学报');
  assert.equal(journalGroup('哲学研究'), '哲学');
  assert.equal(journalGroup('当代外国文学'), '外国文学');
  assert.equal(journalGroup('中国比较文学'), '外国文学');
  assert.equal(journalGroup('南方文坛'), '文学');
  assert.equal(journalGroup('文艺理论与批评'), '文学');
  assert.equal(journalGroup('中国青年研究'), '社会·青年');
  assert.equal(journalGroup('某某'), '其他');
});
