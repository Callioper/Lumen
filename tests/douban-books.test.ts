import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoulistPage, pickSuggestion, doulistIdOf, ogImageOf, subjectDetails } from '../server/content/douban.ts';
import { buildLibrary, inLibrary, isbn13 } from '../server/content/library.ts';

const item = (id: string, title: string, abstract: string, host = 'book'): string => `<div class="doulist-item"><div class="post"><a href="x"><img src="https://img3.doubanio.com/${id}.jpg"/></a></div>
  <div class="title"> <a href="https://${host}.douban.com/subject/${id}/" target="_blank"> ${title} </a> </div>
  <div class="abstract"> ${abstract} </div></div>`;

test('a 豆列 page: its books with subject, cover, author and publisher; films left out', () => {
  const html = '<span class="thispage" data-total-page="5">1</span>' +
    item('30000003', '必然之港', '作者: [美]格雷格·格兰特 <br /> 出版社: 松溪社科出版社 <br /> 出版年: 2018-12') +
    item('1000002', '旧港别梦', '导演: 陈远歌', 'movie');
  const { books, pages } = parseDoulistPage(html);
  assert.equal(pages, 5);
  assert.deepEqual(books.map((b) => [b.title, b.subject, b.authors, b.publisher, b.date, b.cover]),
    [['必然之港', '30000003', '[美]格雷格·格兰特', '松溪社科出版社', '2018年12月', 'https://img3.doubanio.com/30000003.jpg']]);
});

test('a 关注书单 broadcast points to its 豆列', () => {
  assert.equal(doulistIdOf('<a href="https://www.douban.com/doulist/3000001/"><strong>松溪非虚构奖</strong></a>'), '3000001');
});

test('豆瓣 suggestions: the book whose title (or main title) is the listed one', () => {
  const items = [{ title: '诗学中的不满（修订版）', id: '1', type: 'b' }, { title: '诗学中的不满', id: '2', type: 'b' }, { title: '诗学中的不满', id: '9', type: 'm' }];
  assert.equal(pickSuggestion(items, '诗学中的不满'), '2');
  assert.equal(pickSuggestion([{ title: '自由之为自由', id: '3', type: 'b' }], '自由之为自由：启蒙政治的现代性筹划'), '3');
  assert.equal(pickSuggestion([{ title: '别的书', id: '4', type: 'b' }], '诗学中的不满'), null);
});

test('a subject page offers its cover to link previews', () => {
  assert.equal(ogImageOf('<meta property="og:title" content="必然之港" />\n<meta property="og:image" content="https://img1.doubanio.com/view/subject/l/public/s32.jpg" />'),
    'https://img1.doubanio.com/view/subject/l/public/s32.jpg');
  assert.equal(ogImageOf('<title>页面不存在</title>'), null);
});

test('in Zotero: by ISBN in either printing, or by title, a subtitle on either side', () => {
  const lib = buildLibrary([{ field: 'ISBN', value: '978-7-000-00001-8 7000000015' }, { field: 'title', value: '诗学中的不满' },
    { field: 'title', value: '自由之为自由：启蒙政治的现代性筹划' }, { field: 'title', value: '悲歌' }]);
  assert.equal(isbn13('7000000015'), '9787000000018');
  assert.ok(inLibrary(lib, { isbn: '9787000000018', title: '不相干' }));
  assert.ok(inLibrary(lib, { isbn: '', title: '诗学中的不满：朗贝尔文集' }));
  assert.ok(inLibrary(lib, { isbn: '', title: '自由之为自由' }));
  assert.ok(!inLibrary(lib, { isbn: '', title: '悲歌的诞生：林舟' }), 'a two-character main title is too short to match on');
});

test('a subject page: author, publisher and date from its info block', () => {
  const html = `<meta property="og:image" content="https://img1.doubanio.com/l/s1.jpg" />
  <div id="info" class="">
    <span><span class="pl"> 作者</span>:
        <a class="" href="/author/1">[美] 史远民</a> / <a href="/author/2">某某</a>
    </span><br/>
    <span class="pl">出版社:</span>
      <a href="https://book.douban.com/press/1000">北城书局</a>
    <br>
    <span class="pl">出版年:</span> 2026-6<br/>
    <span class="pl">ISBN:</span> 9787000000131<br/>
  </div>`;
  assert.deepEqual(subjectDetails(html), { cover: 'https://img1.doubanio.com/l/s1.jpg', date: '2026年6月', authors: '[美] 史远民 / 某某', publisher: '北城书局' });
});
