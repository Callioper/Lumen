import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { newBooks } from '../server/content/booklists.ts';

process.env.LUMEN_ZOTERO_DB = 'Z:/no/such/zotero.sqlite';   // Zotero unread: inZotero null, nothing hidden

const card = (title: string, date: string, isbn: string): string =>
  `<p>书名：${title}</p><p>作者：某某</p><p>出版社：某出版社</p>${date ? `<p>出版年：${date}</p>` : ''}<p>ISBN：${isbn}</p>`;

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '书讯号')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  const now = new Date();
  const ym = (back: number): string => { const d = new Date(now.getFullYear(), now.getMonth() - back, 1); return `${d.getFullYear()}-${d.getMonth() + 1}`; };
  // The newer post lists an old book and a book its older post lists too; the older post a recent book and an undated one.
  add.run(2, 'g2', '新书速递', card('旧书', '2001-3', '9787000000011') + card('重出的书', ym(1), '9787000000028'), 2000);
  add.run(1, 'g1', '书讯', card('近书', ym(0), '9787000000035') + card('无日期', '', '9787000000042') + card('重出的书', ym(1), '9787000000028'), 1000);
  return db;
}
const q = { offset: 0, limit: 50, byDate: false, recentMonths: 0, notOwned: false };
const titles = (r: ReturnType<typeof newBooks>): string[] => r.books.map((x) => x.book.title);

test('新书 by post: newest post first, a book listed twice shown once from the newer post', () => {
  const r = newBooks(setup(), q);
  assert.deepEqual(titles(r), ['旧书', '重出的书', '近书', '无日期']);
  assert.equal(r.books[1].from.id, 2);
  assert.deepEqual([r.total, r.posts], [4, 2]);
});

test('新书 by date: newest book first, undated last', () => {
  assert.deepEqual(titles(newBooks(setup(), { ...q, byDate: true })), ['近书', '重出的书', '旧书', '无日期']);
});

test('新书 by date: sections by month, books from before the last two years together, the undated ones offered for lookup', () => {
  const r = newBooks(setup(), { ...q, byDate: true });
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  assert.deepEqual(r.books.map((x) => x.month), [`${now.getFullYear()}年${now.getMonth() + 1}月`, `${last.getFullYear()}年${last.getMonth() + 1}月`, '更早出版', '出版时间待查']);
  assert.deepEqual(r.undated.map((b) => b.title), ['无日期']);
});

test('新书 of the last three months keeps a book whose date is not known yet', () => {
  assert.deepEqual(titles(newBooks(setup(), { ...q, recentMonths: 3 })), ['重出的书', '近书', '无日期']);
});

test("新书 by date: a book known only by its year follows that year's books whose month is known", () => {
  const db = setup();
  const y = new Date().getFullYear();
  db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (3, 1, ?, ?, ?, 3000, 0)')
    .run('g3', '书讯', card('只知年份', String(y), '9787000000059'));
  const order = titles(newBooks(db, { ...q, byDate: true }));
  assert.ok(order.indexOf('只知年份') > order.indexOf('近书') && order.indexOf('只知年份') < order.indexOf('旧书'), order.join(' '));
});

test('two posts listing one book differently make one tile that knows what both knew', async () => {
  const { mergeListings } = await import('../server/content/booklists.ts');
  const book = (o: Partial<import('../server/content/books.ts').ListedBook>) => ({ title: '', cover: null, authors: '', translators: '', publisher: '',
    date: '', isbn: '', subject: null, price: '', blurb: '', ...o });
  const merged = mergeListings([
    { from: 'new', b: book({ title: '《银钱与家书》', publisher: '北城出版中心｜时刻者', date: '2026年8月' }) },
    { from: 'old', b: book({ title: '银钱与家书：旧港侨批商号的百年沉浮', publisher: '北城出版集团 北城出版中心', isbn: '9787000000117', blurb: '较长的推荐语' }) },
    // One short title, two publishers: two books.
    { from: 'a', b: book({ title: '留白', publisher: '中信出版集团' }) },
    { from: 'b', b: book({ title: '留白', publisher: '上海人民出版社' }) },
    // One place, two publishers: two books.
    { from: 'e', b: book({ title: '自由', publisher: '上海译文出版社' }) },
    // Both print an ISBN and they differ: two books, whatever the title says.
    { from: 'c', b: book({ title: '过度教育', isbn: '9787000000124', publisher: '北城师范大学出版社' }) },
    { from: 'd', b: book({ title: '过度教育', isbn: '9787000000000', publisher: '北城师范大学出版社' }) },
  ]);
  assert.deepEqual(merged.map((m) => [m.from, m.posts, m.b.title]), [
    ['new', 2, '银钱与家书：旧港侨批商号的百年沉浮'], ['a', 1, '留白'], ['b', 1, '留白'], ['e', 1, '自由'], ['c', 1, '过度教育'], ['d', 1, '过度教育']]);
  assert.deepEqual([merged[0].b.isbn, merged[0].b.date, merged[0].b.blurb], ['9787000000117', '2026年8月', '较长的推荐语']);
});

test('新书 counts and narrows by kind and topic, and names the books still to sort', () => {
  const db = setup();
  db.prepare("INSERT INTO book_kind (key, kind, topic, at) VALUES ('9787000000011', '非虚构', '历史', 0), ('9787000000028', '学术', '哲学', 0), ('9787000000035', '学术', '哲学', 0)").run();
  const all = newBooks(db, { offset: 0, limit: 10, byDate: false, recentMonths: 0, notOwned: false });
  assert.deepEqual(all.topics, [{ label: '哲学', n: 2 }, { label: '历史', n: 1 }]);
  assert.deepEqual(all.kinds, [{ label: '非虚构', n: 1 }, { label: '学术', n: 2 }]);
  assert.deepEqual(all.unsorted.map((x) => x.key), ['9787000000042']);
  assert.deepEqual(newBooks(db, { offset: 0, limit: 10, byDate: false, recentMonths: 0, notOwned: false, kind: '非虚构' }).topics, [{ label: '历史', n: 1 }]);
  const phil = newBooks(db, { offset: 0, limit: 10, byDate: false, recentMonths: 0, notOwned: false, topic: '哲学' });
  assert.deepEqual(phil.books.map((x) => x.book.title).sort(), ['近书', '重出的书']);
  assert.equal(phil.books.find((x) => x.book.title === '重出的书')!.posts, 2);
});

test('a listing that ties two tiles together folds them, and one post counts once', async () => {
  const { mergeListings } = await import('../server/content/booklists.ts');
  const book = (o: Partial<import('../server/content/books.ts').ListedBook>) => ({ title: '', cover: null, authors: '', translators: '', publisher: '',
    date: '', isbn: '', subject: null, price: '', blurb: '', ...o });
  const merged = mergeListings([
    { from: 'p3', b: book({ title: '夜航', publisher: '演示书局' }) },                                  // title only
    { from: 'p2', b: book({ title: '夜间航行的人', isbn: '9787000000999', publisher: '演示书局' }) },   // ISBN, another title
    { from: 'p1', b: book({ title: '夜航：一部小史', isbn: '9787000000999', publisher: '演示书局' }) }, // both: one book
    { from: 'p1', b: book({ title: '《夜航》', publisher: '演示书局' }) },                              // p1 again
  ]);
  assert.deepEqual(merged.map((m) => [m.from, m.posts, m.b.isbn]), [['p3', 3, '9787000000999']]);
});

test('a 书单 that comes in after 新书 was shown is on the next look, in its place by date', () => {
  const db = setup();
  assert.equal(newBooks(db, q).total, 4);
  db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (5, 1, ?, ?, ?, 1500, 0)')
    .run('g5', '书讯', card('补来的书', '2020-1', '9787000000066'));
  assert.deepEqual(titles(newBooks(db, q)), ['旧书', '重出的书', '补来的书', '近书', '无日期']);
});
