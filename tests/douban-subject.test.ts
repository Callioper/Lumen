import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSubjectPage } from '../server/content/douban.ts';

const html = readFileSync(new URL('./fixtures/douban-subject-demo.html', import.meta.url), 'utf8');

test('a 豆瓣 subject page gives its info block, counts, intros, contents, short comments and the books liked alongside', () => {
  const p = parseSubjectPage(html);
  assert.equal(p.title, '雾港书简');
  assert.equal(p.cover, 'https://img.invalid/view/subject/l/public/s0090001.jpg');
  const f = new Map(p.fields);
  assert.equal(f.get('作者'), '[英] 艾琳·霍索恩');
  assert.equal(f.get('译者'), '林舟');
  assert.equal(f.get('出品方'), '远川 / 远川·文艺');
  assert.equal(f.get('页数'), '368');
  assert.equal(f.get('定价'), '68.00元');
  assert.equal(f.get('原作名'), 'Letters from the Fog Harbour');
  assert.equal(f.get('ISBN'), '9787000000018');
  assert.equal(p.rating, null);
  assert.deepEqual([p.doing, p.done, p.wish], [12, 30, 860]);
  assert.equal(p.intro.length, 11, 'the full 内容简介, not the folded one');
  assert.ok(!p.intro.some((x) => x.includes('展开全部')));
  assert.match(p.authorIntro[0], /^艾琳·霍索恩/);
  assert.deepEqual(p.toc, ['序', '第一辑 春', '第二辑 夏', '第三辑 秋', '第四辑 冬', '未寄出的信', '译后记'], 'a full-width space is read as a space');
  assert.equal(p.commentTotal, 4);
  assert.equal(p.reviewTotal, 2);
  assert.equal(p.comments.length, 3);
  assert.equal(p.comments[0].who, '潮间带');
  assert.equal(p.comments[0].stars, 5);
  assert.equal(p.comments[0].time, '2026-10-10');
  assert.equal(p.comments[0].votes, 8);
  assert.match(p.comments[0].text, /^最喜欢写冬天的那一辑[\s\S]*\n推荐给喜欢慢慢读的人！$/, 'the folded comment in full, its line break kept');
  assert.equal(p.comments[1].text, '译文很顺，书信的语气留住了。');
  assert.equal(p.comments[2].stars, null);
  assert.equal(p.similar.length, 10);
  assert.deepEqual(p.similar[0], { subject: '90000002', title: '灯塔之夜', cover: 'https://img.invalid/view/subject/s/public/s0090002.jpg', rating: 7.8 });
  assert.equal(p.similar[1].rating, null);
});

test('a rated subject page gives its rating and how many rated it', () => {
  const p = parseSubjectPage('<strong class="ll rating_num" property="v:average"> 8.6 </strong><a href="comments"><span property="v:votes">1234</span>人评价</a>');
  assert.equal(p.rating, 8.6);
  assert.equal(p.votes, 1234);
});

test('entities in a subject page are read as the characters they stand for', () => {
  const p = parseSubjectPage('<h2><span>内容简介</span></h2><div class="intro"><p>the new &#34;knowledge&#34; economy &amp; its &lt;offices&gt;&#x2014;homes</p></div>');
  assert.deepEqual(p.intro, ['the new "knowledge" economy & its <offices>—homes']);
});
