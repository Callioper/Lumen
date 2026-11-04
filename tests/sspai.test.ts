import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sspaiPostId, bodyOfReply } from '../server/content/sspai.ts';

test('takes the post id from a 少数派 article link', () => {
  assert.equal(sspaiPostId('https://sspai.com/post/118404'), '118404');
  assert.equal(sspaiPostId('https://sspai.com/post/118404/'), '118404');
  assert.equal(sspaiPostId('https://www.sspai.com/post/7?utm_source=rss'), '7');
});

test('leaves other 少数派 pages and other sites to the page reader', () => {
  assert.equal(sspaiPostId('https://sspai.com/prime/story/how-to-analyze-health-data-with-agent'), null);
  assert.equal(sspaiPostId('https://sspai.com/t/k5amzw62dcsd'), null);
  assert.equal(sspaiPostId('https://example.com/post/118404'), null);
  assert.equal(sspaiPostId('https://sspai.com.evil.example/post/1'), null);
  assert.equal(sspaiPostId('not a url'), null);
});

test('reads the body out of the API reply', () => {
  assert.equal(bodyOfReply({ error: 0, data: { body: '<figure><img src="a.jpg"></figure>' } }), '<figure><img src="a.jpg"></figure>');
});

test('has no body for an unknown id, an empty body or a malformed reply', () => {
  assert.equal(bodyOfReply({ error: 2007, msg: '文章数据不存在' }), null);
  assert.equal(bodyOfReply({ error: 0, data: { body: '   ' } }), null);
  assert.equal(bodyOfReply({ error: 0, data: {} }), null);
  assert.equal(bodyOfReply(null), null);
  assert.equal(bodyOfReply('oops'), null);
});
