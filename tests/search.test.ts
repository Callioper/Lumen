import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { indexEntries, parseQuery, hitSnippet } from '../server/search.ts';
import { listEntries, searchEntries, type Scope } from '../server/api/queries.ts';

const filler = '这是一段很长的铺垫文字，'.repeat(200);   // pushes a term past the old 1500-character cut

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '某号')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, author, content, ai_summary, published, is_read) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)');
  add.run(1, 'g1', '霍尔德与后人类主体', '甲', '<p>讨论霍尔德。</p>', null, 1000, 1);
  add.run(2, 'g2', '一篇长文', '乙', `<p>${filler}后来谈到霍尔德的后人类，又谈到佛朗。</p>`, null, 3000, 0);
  add.run(3, 'g3', 'Posthuman bodies', '丙', '<p>English text only.</p>', '<p>本文讨论霍尔德的后人类论述。</p>', 2000, 0);
  add.run(4, 'g4', '佛朗讲座', '丁', '<p>关于权力。</p>', null, 4000, 0);
  indexEntries(db, [1, 2, 3, 4]);
  return db;
}
const all = (q: string): Scope => ({ filter: 'all', q });
const ids = (xs: { id: number }[]): number[] => xs.map((x) => x.id);

test('a query is split on spaces, quotes keep a phrase, short and long terms go apart', () => {
  assert.deepEqual(parseQuery('霍尔德  后人类 佛朗'), { long: ['霍尔德', '后人类'], short: ['佛朗'] });
  assert.deepEqual(parseQuery('"后人类 主体" Holder'), { long: ['后人类 主体', 'holder'], short: [] });
});

test('every term must be found, wherever it is in the text, the summary or the title', () => {
  const db = setup();
  assert.deepEqual(ids(listEntries(db, all('霍尔德 后人类'), undefined, 10)), [2, 3, 1]);
  // 「佛朗」 is two characters: matched in the text itself, together with an indexed term.
  assert.deepEqual(ids(listEntries(db, all('霍尔德 佛朗'), undefined, 10)), [2]);
  assert.deepEqual(ids(listEntries(db, all('佛朗'), undefined, 10)), [4, 2]);
});

test('by relevance a title hit comes before a hit deep in the text', () => {
  const db = setup();
  assert.equal(searchEntries(db, all('霍尔德'), 0, 10)[0].id, 1);
  assert.deepEqual(ids(searchEntries(db, all('佛朗'), 0, 10)), [4, 2]);
  assert.deepEqual([...ids(searchEntries(db, all('佛朗'), 0, 1)), ...ids(searchEntries(db, all('佛朗'), 1, 1))], [4, 2]);
  assert.deepEqual(ids(searchEntries(db, all('霍尔德'), 1, 1)), ids(searchEntries(db, all('霍尔德'), 0, 10)).slice(1, 2));
});

test('a result shows the text around the term, from the summary when the text lacks it', () => {
  const db = setup();
  const [deep] = listEntries(db, all('佛朗 后人类'), undefined, 10);
  assert.ok(deep.hit && deep.snippet.includes('后人类') && deep.snippet.startsWith('…'));
  const summary = listEntries(db, all('后人类论述'), undefined, 10)[0];
  assert.equal(summary.id, 3);
  assert.ok(summary.hit && summary.snippet.includes('后人类论述'));
});

test('a snippet is ellipsized on the side it was cut', () => {
  assert.equal(hitSnippet('短文提到佛朗。', ['佛朗']), '短文提到佛朗。');
  assert.equal(hitSnippet('没有', ['佛朗']), null);
});

test('a percent sign or underscore in a short term is matched literally', () => {
  const db = setup();
  assert.deepEqual(listEntries(db, all('%'), undefined, 10), []);
});
