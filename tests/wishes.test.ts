import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { subjectOfLink, withSubjects } from '../server/content/subjects.ts';
import { markInterest, wishedSubjects } from '../server/content/douban.ts';
import { viewBooks } from '../server/content/booklists.ts';

test('a 豆瓣 subject is read off an entry\'s link, the chart\'s dispatch link too', () => {
  assert.deepEqual(subjectOfLink('https://book.douban.com/subject/36514915/'), { kind: 'book', subject: '36514915' });
  assert.deepEqual(subjectOfLink('https://movie.douban.com/subject/25798131/?from=x'), { kind: 'movie', subject: '25798131' });
  assert.deepEqual(subjectOfLink('https://www.douban.com/doubanapp/dispatch/book/26712445'), { kind: 'book', subject: '26712445' });
  assert.equal(subjectOfLink('https://book.douban.com/review/17868292/'), null);
  assert.equal(subjectOfLink('https://www.douban.com/people/1/status/2/'), null);
  assert.equal(subjectOfLink(null), null);
});

test('想读 marked on one page shows on the others: by subject, wherever it was clicked', async () => {
  const db = openDb(':memory:');
  // An old mark kept only by the book's key is carried over (openDb runs this statement).
  db.prepare("INSERT INTO douban_book (key, subject, title, looked_at, wished_at) VALUES ('isbn:9787', '111', '甲', 1, 5)").run();
  db.exec(`INSERT INTO douban_subject (subject, wished_at) SELECT subject, MAX(wished_at) FROM douban_book WHERE wished_at IS NOT NULL AND subject IS NOT NULL GROUP BY subject
    ON CONFLICT(subject) DO UPDATE SET wished_at = COALESCE(douban_subject.wished_at, excluded.wished_at)`);
  assert.deepEqual([...wishedSubjects(db, ['111'])], ['111']);

  // Marked from 标记 or 书影榜: a 书单's tile of the same book says so.
  await markInterest(db, 'book', '222');
  const [tile] = viewBooks(db, [{ title: '乙', cover: null, authors: '', translators: '', publisher: '', date: '', isbn: '', subject: '222', price: '', blurb: '' }]);
  assert.equal(tile.wished, true);

  const items = withSubjects(db, [{ link: 'https://book.douban.com/subject/222/' }, { link: 'https://book.douban.com/subject/333/' }, { link: null }]);
  assert.deepEqual(items.map((i) => i.douban?.wished ?? null), [true, false, null]);
});
