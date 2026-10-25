import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeSource } from '../server/fetch/recognize.ts';

const WECHAT = 'http://wechat2rss.example.com';
const one = (u: string): string | undefined => recognizeSource(u, WECHAT)[0]?.url;

test('maps a WeChat article, even behind the captcha wrapper, to its wechat2rss feed', () => {
  const art = 'https://mp.weixin.qq.com/s?__biz=MzAwMDAwMDAwMA==&mid=2247400001&idx=1';
  assert.equal(one(art), 'http://wechat2rss.example.com/feed/3000000000.xml');
  assert.deepEqual(recognizeSource(art), [], 'no wechat2rss server, no WeChat rule');
  const wrapped = 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x&target_url=' + encodeURIComponent(art);
  assert.equal(one(wrapped), 'http://wechat2rss.example.com/feed/3000000000.xml');
});

test('downgrades wechat2rss https to http', () => {
  assert.equal(one('https://wechat2rss.example.com/feed/3000000000.xml'), 'http://wechat2rss.example.com/feed/3000000000.xml');
});

test('maps platform pages to the RSSHub routes already in use', () => {
  assert.equal(one('https://www.douban.com/people/1000001/'), 'rsshub://douban/people/1000001/status');
  assert.equal(one('https://weibo.com/u/1000000002'), 'rsshub://weibo/user/1000000002');
  assert.equal(one('https://www.xiaoyuzhoufm.com/podcast/5e0000000000000000000001'), 'rsshub://xiaoyuzhou/podcast/5e0000000000000000000001');
  assert.deepEqual(recognizeSource('https://space.bilibili.com/1000000001').map((r) => r.url),
    ['rsshub://bilibili/user/dynamic/1000000001', 'rsshub://bilibili/user/video/1000000001']);
  assert.equal(one('https://navi.cnki.net/knavi/journals/BDZK/detail'), 'https://rss.cnki.net/knavi/rss/BDZK?pcode=CJFD,CCJD');
});

test('leaves ordinary sites to feed discovery', () => {
  assert.deepEqual(recognizeSource('https://sspai.com/'), []);
  assert.deepEqual(recognizeSource('not a url'), []);
});
