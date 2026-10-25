import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ImageCache, IMG_CACHE_MAX_ENTRY } from '../server/api/imgcache.ts';
import { coverUrl, normalizeImageUrl } from '../server/api/media.ts';

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-img-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('a cached image comes back with its type; empty and oversized bodies are not kept', () => withDir((dir) => {
  const c = new ImageCache(dir, 1024);
  assert.equal(c.get('https://a/x.jpg'), null);
  c.put('https://a/x.jpg', Buffer.from('jpeg'), 'image/jpeg');
  assert.deepEqual(c.get('https://a/x.jpg'), { body: Buffer.from('jpeg'), type: 'image/jpeg' });
  assert.ok(c.has('https://a/x.jpg'));
  c.put('https://a/empty', Buffer.alloc(0), 'image/png');
  c.put('https://a/huge', Buffer.alloc(IMG_CACHE_MAX_ENTRY + 1), 'image/png');
  assert.equal(c.has('https://a/empty'), false);
  assert.equal(c.has('https://a/huge'), false);
}));

test('pruning drops the least recently used images until the cache is under its cap', () => withDir((dir) => {
  const c = new ImageCache(dir, 150);
  const path = (u: string) => { const h = createHash('sha1').update(u).digest('hex'); return join(dir, h.slice(0, 2), h); };
  ['old', 'mid', 'new'].forEach((name, i) => {
    c.put(`https://a/${name}`, Buffer.alloc(100), 'image/png');
    const t = new Date(2026, 0, 1 + i);
    utimesSync(path(`https://a/${name}`), t, t);
  });
  assert.equal(c.prune(), 2);
  assert.deepEqual(['old', 'mid', 'new'].map((n) => c.has(`https://a/${n}`)), [false, false, true]);
  // The .type sidecars go with their images.
  assert.equal(readdirSync(dir).flatMap((d) => readdirSync(join(dir, d))).length, 2);
  assert.equal(c.prune(), 0);
}));

test('covers are shrunk only where the host resizes on request', () => {
  assert.equal(coverUrl('https://i0.hdslb.com/bfs/archive/a.jpg', 520), 'https://i0.hdslb.com/bfs/archive/a.jpg@520w.webp');
  assert.equal(coverUrl('https://i0.hdslb.com/bfs/archive/a.jpg@100w.jpg', 520), 'https://i0.hdslb.com/bfs/archive/a.jpg@100w.jpg');
  assert.equal(coverUrl('https://i0.hdslb.com/bfs/archive/a.jpg'), 'https://i0.hdslb.com/bfs/archive/a.jpg');
  assert.equal(coverUrl('https://img9.doubanio.com/a.jpg', 520), 'https://img9.doubanio.com/a.jpg');
  assert.equal(normalizeImageUrl('//i0.hdslb.com/a.jpg?x=1&amp;y=2'), 'https://i0.hdslb.com/a.jpg?x=1&y=2');
  assert.equal(normalizeImageUrl('data:image/png;base64,xx'), '');
});

test('Bilibili covers have two mirror hosts to fall back on; other hosts none', async () => {
  const { mirrorsOf } = await import('../server/api/media.ts');
  assert.deepEqual(mirrorsOf(new URL('https://i2.hdslb.com/bfs/a.jpg@520w.webp')).map((u) => u.href),
    ['https://i0.hdslb.com/bfs/a.jpg@520w.webp', 'https://i1.hdslb.com/bfs/a.jpg@520w.webp']);
  assert.deepEqual(mirrorsOf(new URL('https://example.com/a.jpg')), []);
});

test('an image behind the wechat2rss relay is fetched from WeChat itself', async () => {
  const { unwrapRelay } = await import('../server/api/media.ts');
  const orig = 'https://mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg&from=appmsg';
  assert.equal(unwrapRelay(`https://wechat2rss.example.com/img-proxy/?k=a7619d10&u=${encodeURIComponent(orig)}`), orig);
  // Anything else is left alone, a stray u= included.
  for (const raw of ['https://img.example.com/a.jpg?u=https%3A%2F%2Fx.com%2Fb.jpg', 'https://x.com/img-proxy/?u=javascript%3Aalert(1)', 'not a url']) assert.equal(unwrapRelay(raw), raw);
});

test('an article’s images to fetch ahead are its own, once each, as the reader will ask for them', async () => {
  const { contentImageUrls } = await import('../server/api/media.ts');
  const html = '<p><img src="https://a.cn/1.jpg?x=1&amp;y=2" loading="lazy"></p><img alt="" src="//b.cn/2.png"><img src="https://a.cn/1.jpg?x=1&amp;y=2">'
    + '<img src="data:image/png;base64,AAAA"><video poster="https://c.cn/p.jpg"></video>';
  assert.deepEqual(contentImageUrls(html), ['https://a.cn/1.jpg?x=1&y=2', 'https://b.cn/2.png']);
  assert.equal(contentImageUrls(Array.from({ length: 80 }, (_, i) => `<img src="https://a.cn/${i}.jpg">`).join('')).length, 60);
});
