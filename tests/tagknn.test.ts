import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voteTags, awaitsVector } from '../server/rec/tagknn.ts';
import type { VectorIndex } from '../server/rec/embed.ts';
import type { Settings } from '../server/config.ts';

const unit = (xs: number[]): Float32Array => { const n = Math.hypot(...xs); return new Float32Array(xs.map((x) => x / n)); };

// Ten references near the x axis tagged 哲学 (six also 文学), ten near y tagged 媒介.
const refs = [
  ...Array.from({ length: 10 }, (_, i) => ({ id: i, vec: unit([1, 0.01 * i, 0]), tags: i < 6 ? ['AI:哲学', 'AI:文学'] : ['AI:哲学'] })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, vec: unit([0.01 * i, 1, 0]), tags: ['AI:媒介'] })),
];

test('a tag at least half the ten nearest carry is taken, most shared first', () => {
  assert.deepEqual(voteTags(unit([1, 0.02, 0]), refs), ['AI:哲学', 'AI:文学']);
  assert.deepEqual(voteTags(unit([0, 1, 0.1]), refs), ['AI:媒介']);
});

test('a split vote gives nothing, and so do too few references', () => {
  assert.deepEqual(voteTags(unit([1, 1, 0]), refs, -1, 10, 0.6), []);
  assert.deepEqual(voteTags(unit([1, 0, 0]), refs.slice(0, 5)), []);
});

test('the article itself does not vote for its own tags', () => {
  const near = voteTags(refs[0].vec, refs, 0);
  assert.ok(near.includes('AI:哲学'));
  // Leaving out 0, only five of its nearest ten carry 文学 (1–5): exactly half, still in.
  assert.deepEqual(near, ['AI:哲学', 'AI:文学']);
});

test('a fresh article without a vector waits for one; an old one or no service does not', () => {
  const index = { get: (_m: string, id: number) => (id === 1 ? new Float32Array([1]) : undefined) } as unknown as VectorIndex;
  const on = { embedding: { enabled: true, model: 'm' } } as unknown as Settings;
  const now = 1_800_000_000_000;
  const arrived = (msAgo: number): number => (now - msAgo) * 1000;
  assert.equal(awaitsVector(index, on, true, arrived(60_000), now), true);
  assert.equal(awaitsVector(index, on, true, arrived(11 * 60_000), now), false);
  assert.equal(awaitsVector(index, on, false, arrived(60_000), now), false);
  assert.equal(awaitsVector(index, on, true, 1, now), false);
});
