import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates } from '../server/content/pictures.ts';

const relay = (inner: string, k: string): string =>
  `https://w2r.example/img-proxy/?k=${k}&amp;u=${encodeURIComponent(inner)}`;

test('a WeChat GIF is left out, also inside a relay address', () => {
  const html = `<p>会议将于10月举行。</p><img src="${relay('https://mmbiz.qpic.cn/mmbiz_gif/abc/0?wx_fmt=gif', 'a')}" />`
    + `<img src="https://mmbiz.qpic.cn/mmbiz_jpg/poster/0?wx_fmt=jpeg" /><p>${'议程与嘉宾介绍。'.repeat(8)}</p>`;
  assert.deepEqual(candidates(html), ['https://mmbiz.qpic.cn/mmbiz_jpg/poster/0?wx_fmt=jpeg']);
});

test('the picture closing the post (a QR code, a follow banner) is left out', () => {
  const html = `<img src="https://mmbiz.qpic.cn/mmbiz_jpg/poster/0" /><p>${'正文很长。'.repeat(10)}</p><img src="https://mmbiz.qpic.cn/mmbiz_png/qr/0" /><p>长按关注</p>`;
  assert.deepEqual(candidates(html), ['https://mmbiz.qpic.cn/mmbiz_jpg/poster/0']);
});

test('one picture under two relay addresses is kept once, and only web links count', () => {
  const inner = 'https://mmbiz.qpic.cn/mmbiz_png/same/0?wx_fmt=png';
  const html = `<img src="${relay(inner, 'a')}" /><img src="${relay(inner, 'b')}" /><img src="data:image/png;base64,xx" />`
    + `<p>${'后面还有很多正文。'.repeat(6)}</p>`;
  assert.deepEqual(candidates(html), [relay(inner, 'a').replace(/&amp;/g, '&')]);
});

test('a status that is one photo and a line keeps its photo', () => {
  const html = '<p>下周讲座</p><img src="https://img1.doubanio.com/view/status/l/public/poster.jpg" /><p>周三下午</p>';
  assert.deepEqual(candidates(html), ['https://img1.doubanio.com/view/status/l/public/poster.jpg']);
});
