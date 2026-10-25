import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, choosePictures, type Found } from '../server/content/pictures.ts';

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

// Shapes are height / width; text is the characters OCR read (measured 10-26), null while not read.
const pic = (url: string, shape: number, text: number | null): Found => ({ url, shape, text });

test('read through, posters are told by their text, whatever their shape', () => {
  const found = [pic('gate', 0.6, 21), pic('poster', 1.4, 464), pic('emblem', 1.0, 5), pic('programme', 0.7, 1115), pic('forest', 1.5, 0), pic('banner', 0.5, 47)];
  assert.deepEqual(choosePictures(found, 8), ['poster', 'programme']);
});

test('lying down, a card the post ends on is not a programme', () => {
  const found = [pic('programme', 0.65, 659), pic('benefits', 0.56, 296), pic('speakerCard', 0.56, 116), pic('poster', 1.8, 401)];
  assert.deepEqual(choosePictures(found, 8), ['programme', 'poster']);
});

test('read through and no poster among them, the square ones are shown (speakers)', () => {
  const found = [pic('campus', 0.6, 0), pic('speaker1', 1.0, 0), pic('speaker2', 1.05, 3), pic('tall', 1.5, 1)];
  assert.deepEqual(choosePictures(found, 8), ['speaker1', 'speaker2']);
});

test('not all read, the shape decides: upright first, else square', () => {
  assert.deepEqual(choosePictures([pic('wide', 0.6, 900), pic('tall', 1.4, null), pic('square', 1.0, 0)], 8), ['tall']);
  assert.deepEqual(choosePictures([pic('wide', 0.6, null), pic('square', 1.0, null)], 8), ['square']);
});

test('no more than asked for', () => {
  const found = [1, 2, 3, 4, 5].map((i) => pic(`p${i}`, 1.4, 500));
  assert.deepEqual(choosePictures(found, 3), ['p1', 'p2', 'p3']);
});
