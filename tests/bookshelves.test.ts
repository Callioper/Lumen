import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shelvesOf, REST_SHELF } from '../server/content/bookshelves.ts';

const many = (t: string, n: number): string[] => Array.from({ length: n }, () => t);

test('a month is cut into shelves of a handful: a big 主题 alone, the small ones by field, too few joining the smallest shelf', () => {
  const topics = [...many('历史', 8), ...many('小说', 4), '散文随笔', '文学研究', ...many('社会学', 2), '经济', '教育', '心理学', '哲学', '科普', null];
  const { shelves, of } = shelvesOf(topics);
  assert.deepEqual(shelves.map((s) => [s.label, s.n]), [['小说·散文随笔·文学研究', 6], ['历史', 8], ['社会科学', 8]]);
  assert.deepEqual(shelves[2].topics, ['社会学', '经济', '教育', '心理学', '哲学', '科普', '未归类']);
  assert.equal(of[0], '历史');
  assert.equal(of.at(-1), '社会科学');
});

test('enough left over makes 其余, and a field\'s shelf grown too large gives its biggest 主题 their own', () => {
  const topics = [...many('历史', 25), ...many('小说', 25), ...many('女性主义', 7), ...many('社会学', 6), ...many('经济', 5), ...many('心理学', 5), '哲学', '科普', '电影', null];
  const { shelves } = shelvesOf(topics);
  assert.deepEqual(shelves.map((s) => [s.label, s.n]), [['小说', 25], ['历史', 25], ['女性主义', 7], ['社会学', 6], ['经济·心理学', 10], [REST_SHELF, 4]]);
});

test('a small month, or one that would be a single shelf, is not cut', () => {
  assert.deepEqual(shelvesOf(many('历史', 8)).shelves, []);
  assert.deepEqual(shelvesOf(many('历史', 20)).shelves, []);
});
