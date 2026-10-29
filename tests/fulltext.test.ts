import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedCopyBetter } from '../server/content/readability.ts';

const para = (n: number): string => `<p>${'刀光一闪，竹叶尤落，生死未分，胜负已决。'.repeat(n)}</p>`;
const img = (i: number): string => `<img src="https://image.example.com/${i}.jpg">`;

test('keeps the feed copy when the page lost its script-loaded pictures', () => {
  const feed = para(20) + img(1) + para(20) + img(2) + para(20) + img(3);
  const page = para(20) + '<figure></figure>' + para(20) + '<figure></figure>' + para(20);
  assert.equal(feedCopyBetter(feed, page), true);
});

test('takes the page when the feed is only a summary', () => {
  const feed = para(2) + img(1) + img(2);
  const page = para(60);
  assert.equal(feedCopyBetter(feed, page), false);
});

test('takes the page when it keeps the pictures', () => {
  const feed = para(20) + img(1) + img(2) + img(3);
  const page = para(20) + img(1) + img(2);
  assert.equal(feedCopyBetter(feed, page), false);
});

test('takes the page when the feed has one picture or none', () => {
  assert.equal(feedCopyBetter(para(20) + img(1), para(20)), false);
  assert.equal(feedCopyBetter(null, para(20)), false);
});
