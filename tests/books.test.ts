import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBooks, dateOf } from '../server/content/books.ts';

const p = (...lines: string[]): string => lines.map((l) => `<p>${l}</p>`).join('');

test('a 联合书单 entry: title, cover, author, translator, publisher, ISBN, price, blurb', () => {
  const html = p('01', '<strong>《旧港事件：1860年大火与现代港城的形成》</strong>') +
    '<img alt="封面" src="https://x/img-proxy/?k=1">' +
    p('[美] 尤金·罗斯 著', '柳原 译', '远川馆 | 松溪人民出版社', 'ISBN：9787000000018', '定价：98.00元', '1860年，旧港发生大火。本书还原其经过。', '02');
  const [b] = extractBooks(html);
  assert.deepEqual(b, { title: '旧港事件：1860年大火与现代港城的形成', cover: 'https://x/img-proxy/?k=1',
    authors: '[美] 尤金·罗斯 著', translators: '柳原 译', publisher: '远川馆 | 松溪人民出版社', date: '', isbn: '9787000000018', subject: null,
    price: '98.00元', blurb: '1860年，旧港发生大火。本书还原其经过。02' });
});

test('lines run together: ISBN after the publisher, translator after the author, publisher after the translator', () => {
  const html = p('《世纪行旅》', '段远山 著周晚意译', '北城大学出版社ISBN：9787000000025', '简介。') +
    p('《骆驼与文明的缔造》', '[美]戴维·查尔斯 著', '扈青林译松溪出版集团', 'ISBN：9787000000032', '简介。');
  const [a, b] = extractBooks(html);
  assert.deepEqual([a.authors, a.translators, a.publisher, a.isbn], ['段远山 著', '周晚意译', '北城大学出版社', '9787000000025']);
  assert.deepEqual([b.translators, b.publisher], ['扈青林译', '松溪出版集团']);
});

test('译林 and 译文 are publishers, not a translator', () => {
  const html = p('《嘉礼旧事》', '任晚平 著', '石碑馆 | 译林出版社', 'ISBN：9787000000049') +
    p('《松溪神木记》', '龚静川 著', '上海译文出版社', 'ISBN：9787000000056');
  assert.deepEqual(extractBooks(html).map((b) => [b.translators, b.publisher]), [['', '石碑馆 | 译林出版社'], ['', '上海译文出版社']]);
});

test('a 豆瓣式 entry is read by its labels, a label alone on its line taking the next', () => {
  const html = p('书籍信息', '书名：旧名：相逢之书', '著者：（法）伊曼纽尔·勒韦尔', '译者：', '王晚舟、张书川', '出版社：北城师范大学出版社',
    'ISBN：978-7-000-00006-3', '页数：296', '【内容简介】《旧名》是朝向他者的书写。');
  const [b] = extractBooks(html);
  assert.deepEqual([b.title, b.authors, b.translators, b.publisher, b.isbn, b.blurb],
    ['旧名：相逢之书', '（法）伊曼纽尔·勒韦尔', '王晚舟、张书川', '北城师范大学出版社', '9787000000063', '《旧名》是朝向他者的书写。']);
});

test('no title line: the bare line above the labels, else a single-book post’s own title, else left out', () => {
  assert.equal(extractBooks(p('东方镜像', '作者:陈小川', 'ISBN: 9787000000070'))[0].title, '东方镜像');
  const headed = p('基本信息', '作者: 李晚霞', '出版社: 松溪人民出版社', 'ISBN: 9787000000087');
  assert.equal(extractBooks(headed, '新书速递｜《老屋与新家》')[0].title, '老屋与新家');
  assert.deepEqual(extractBooks(headed), []);
  assert.deepEqual(extractBooks(p('周远宁', '出版社: 旧港大学出版社', 'ISBN: 9787000000094')), []);
});

const img = (k: number): string => `<img src="https://x/${k}">`;

test('a numbered list without ISBNs: 《书名》 and one line of who, translator and publisher', () => {
  const html = [1, 2, 3].map((k) => img(k) + p(`0${k}《书${k}》`, `雅克·朗贝尔著，蓝川、李三远译，北城大学出版社，2019`)).join('') + p('结语。');
  const books = extractBooks(html, '一份当代艺术理论必读书单');
  assert.equal(books.length, 3);
  assert.deepEqual(extractBooks(html, '宋明川：当代科幻里的古典时刻'), [], 'an essay’s notes are not a list');
  assert.deepEqual([books[0].title, books[0].cover, books[0].authors, books[0].translators, books[0].publisher],
    ['书1', 'https://x/1', '雅克·朗贝尔著', '蓝川、李三远译', '北城大学出版社']);
});

test('a list without 《》: the short line under a cover, its title broken at the colon, then 「著」', () => {
  const html = img(1) + p('自由之为自由：', '启蒙政治的现代性筹划', '张远均 著', '松溪书局·Sylva', '2026年8月', '本书是对启蒙政治思想的一个体系性重述，以《法的精神》为主。') +
    img(2) + p('心术与治理', '洪川 著', '北城出版中心') + img(3) + p('哲学入门', '（德） 伊林·费舍尔 著', '黄远洲 译', '北城出版中心·象形');
  const books = extractBooks(html, '哲学新书联合书单（2026年第7期）');
  assert.deepEqual(books.map((b) => b.title), ['自由之为自由：启蒙政治的现代性筹划', '心术与治理', '哲学入门']);
  assert.deepEqual([books[0].authors, books[0].publisher], ['张远均 著', '松溪书局·Sylva']);
  assert.deepEqual([books[2].translators, books[2].publisher], ['黄远洲 译', '北城出版中心·象形']);
});

test('a post naming a book or two is not a list', () => {
  assert.deepEqual(extractBooks(p('《一本书》', '某某 著', '某出版社')), []);
  assert.deepEqual(extractBooks(p('《一本书》', '某某著，某出版社', '《另一本》', '某某著，某出版社'), '书单'), []);
});

test('dates printed every way read one way; what is not a date is left alone', () => {
  assert.deepEqual(['2026-4', '2025年2月', '2026.04', '2026/1/15', '2025年', '2026年1月出版', '2026'].map(dateOf),
    ['2026年4月', '2025年2月', '2026年4月', '2026年1月', '2025年', '2026年1月', '2026年']);
  assert.deepEqual(['2026-13', '1860年', '848', '精装 32开'].map(dateOf), [null, null, null, null]);
});

test("a book's date, labelled or on its own line in a list", () => {
  const [labelled] = extractBooks('<p>《北洲一万年》</p><p>作者: 埃文德</p><p>出版社: 松溪书店</p><p>出版年: 2026-4</p><p>ISBN: 9787000000100</p>');
  assert.equal(labelled.date, '2026年4月');
  const list = extractBooks(['无声的球场', '追逐风暴的人', '重塑旧梦'].map((t) => `<p>《${t}》</p><p>某某 著</p><p>旧港出版社</p><p>2026年1月</p>`).join(''), '好书榜｜十本书');
  assert.deepEqual(list.map((b) => [b.authors, b.publisher, b.date]), Array(3).fill(['某某 著', '旧港出版社', '2026年1月']));
});

test('a date after the publisher, a heading in the list and an English heading on the blurb are cleaned off', () => {
  const list = extractBooks(['甲书', '乙书', '丙书'].map((t) => `<p>《${t}》</p><p>某某 著</p><p>松溪出版集团 2026 年 9 月</p><p>推荐理由：</p><p>About the Book本书讲述了一个很长很长的故事，从古至今，横跨东西，值得一读再读，读完再读一遍，读到第三遍才算懂了。</p>`).join(''), '书单｜三本');
  assert.deepEqual(list.map((b) => [b.publisher, b.date, b.blurb.slice(0, 4)]), Array(3).fill(['松溪出版集团', '2026年9月', '本书讲述']));
});

test('a title printed 「作者 | 书名」 above 出版商 and an unlabelled date', () => {
  const [b] = extractBooks(`<p>Mark O'Dell | The Man Who Taught A Harbour Town To Read - Lin Zhou</p><img src="https://x/c.jpg"><p>作者：Mark O'Dell</p>
    <p>出版商：松溪書店（香港）有限公司,</p><p>2023年10月</p><p>ISBN：700000004X</p><p>Lin Zhou is the scholar who invented a new script.</p>`, '書訊｜十本書');
  assert.deepEqual([b.title, b.publisher, b.date, b.cover], ['The Man Who Taught A Harbour Town To Read - Lin Zhou', '松溪書店（香港）有限公司', '2023年10月', 'https://x/c.jpg']);
});

test('the author, binding and size between a subtitled title and its ISBN; date and publisher after it', () => {
  const [b] = extractBooks(`<p>心术与治理：古典思想发微（增订本）</p><p>洪川 著</p><p>精装 32开 496页</p><p>定价：98.80元</p><p>ISBN：978-7-000-00011-7</p>
    <p>2026年8月第1版第1次</p><p>北城出版集团 北城出版中心</p><p>推荐语｜</p><p>北城大学洪川教授力作。</p>`, '读者赠书｜洪川 新著');
  assert.deepEqual([b.title, b.authors, b.publisher, b.date, b.price], ['心术与治理：古典思想发微（增订本）', '洪川 著', '北城出版集团 北城出版中心', '2026年8月', '98.80元']);
});

test('「Contact us」 over 「主编」 is a masthead, not a book', () => {
  const books = extractBooks(['甲书', '乙书', '丙书'].map((t) => `<p>《${t}》</p><p>某某 著</p><p>旧港出版社</p>`).join('') +
    '<img src="https://x/m.jpg"><p>Contact us</p><p>主编</p><p>张迟</p>', '好书榜｜三本');
  assert.deepEqual(books.map((b) => b.title), ['甲书', '乙书', '丙书']);
});

test('one book a post recommends by name, with no ISBN, is read from the line its title names', () => {
  const html = ['<p>我们本期推荐的图书是由松溪外语出版社出版、杨川教授著：《知识旅行学》。</p>', '<p>【赠书规则】</p>',
    '<p><img src="https://img/cover.jpg"></p>', '<p>知识旅行学</p>', '<p>杨川 著</p>', '<p>出版社：松溪外语出版社 </p>',
    '<p>内容简介</p>', '<p>翻译远不止是两种语言之间的符号转换，更是人类知识跨越边界的旅行。本书系统阐释了翻译与知识的关系。</p>'].join('');
  const [b, more] = extractBooks(html, '好书推荐 | 杨川著《知识旅行学》【互动赠书】');
  assert.equal(more, undefined);
  assert.deepEqual([b.title, b.authors, b.publisher, b.cover], ['知识旅行学', '杨川 著', '松溪外语出版社', 'https://img/cover.jpg']);
  assert.match(b.blurb, /^翻译远不止/);
  assert.deepEqual(extractBooks(html, '杨川著《知识旅行学》读后'), []);       // not a book post by its title
});

test('a publisher\'s monthly list: 「01#《…》」 titles, one broken over two lines, the price on its own line', () => {
  const html = p('01#《在暮色中：一份时代诊断》', '[荷]扬·维尔德 著', '柯远 译', '松溪书店', '68.00元', 'ISBN：9787000000063', '本书源于一次演讲。') +
    p('02#《城邦为何兴盛：禀赋', '与兴衰》', '方远 著', '松溪书店', '138.00元', 'ISBN：9787000000070', '一部原创著作。');
  const [a, b] = extractBooks(html, '每月书单');
  assert.deepEqual([a.title, a.authors, a.translators, a.publisher, a.price], ['在暮色中：一份时代诊断', '[荷]扬·维尔德 著', '柯远 译', '松溪书店', '68.00元']);
  assert.deepEqual([b.title, b.price, b.blurb], ['城邦为何兴盛：禀赋与兴衰', '138.00元', '一部原创著作。']);
});

test('the same list\'s one-line rows: 「N.《书名》作者 出版社 定价 ISBN」', () => {
  const html = p('01#《在暮色中》', '扬·维尔德 著', '松溪书店', '68.00元', 'ISBN：9787000000063', '简介。', '本月新书',
    '1.《松溪研究（第十三辑）》松溪纪念馆 编松溪书店 75.00元 9787000000087',
    '2.《在暮色中》扬·维尔德 著 柯远 译 松溪书店 68.00元 9787000000063', '9.《海外文献编年》吴原 编著 松溪书店 98.00元 9787000000100',
    '26·《跨境之河》杨秋 著 松溪书店 68.00元 9787000000094');
  const books = extractBooks(html, '每月书单');
  assert.deepEqual(books.map((b) => b.title), ['在暮色中', '松溪研究（第十三辑）', '海外文献编年', '跨境之河']);
  const [, c, e, d] = books;
  assert.equal(e.authors, '吴原 编著');
  assert.deepEqual([c.authors, c.publisher, c.price, c.isbn], ['松溪纪念馆 编', '松溪书店', '75.00元', '9787000000087']);
  assert.deepEqual([d.authors, d.isbn], ['杨秋 著', '9787000000094']);
});
