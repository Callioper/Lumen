import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepReadTrail, noteRead } from '../web/src/util.ts';

const list = (reads: number[]) => reads.map((r, i) => ({ id: i + 1, is_read: r }));
const trail = (l: { id: number; is_read: number }[], order: number[], pinned: number | null = null) =>
  keepReadTrail(l, order, (i) => i.id, (i) => !!i.is_read, pinned).map((i) => i.id);

test('the unread view keeps only the three entries read most recently, however they were read', () => {
  // 1-6 read in order (opened, scrolled past or marked as a block); 7 and 8 still unread.
  assert.deepEqual(trail(list([1, 1, 1, 1, 1, 1, 0, 0]), [1, 2, 3, 4, 5, 6]), [4, 5, 6, 7, 8]);
  // Read out of order: what counts is when, not where.
  assert.deepEqual(trail(list([1, 1, 1, 1, 0]), [4, 1, 3, 2]), [1, 2, 3, 5]);
});

test('the open entry, unread ones and rows already read on load are never dropped', () => {
  assert.deepEqual(trail(list([1, 0, 1, 1, 1, 1]), [1, 3, 4, 5, 6], 1), [1, 2, 4, 5, 6]);
  assert.deepEqual(trail(list([1, 1, 1, 1, 1]), [3, 4, 5, 2]), [1, 2, 4, 5]);
});

test('short trails leave the list untouched; reading again moves an entry to the end', () => {
  const l = list([1, 1, 0]);
  assert.equal(keepReadTrail(l, [1, 2], (i) => i.id, (i) => !!i.is_read), l);
  assert.deepEqual(noteRead([1, 2, 3], [2, 4]), [1, 3, 2, 4]);
});
