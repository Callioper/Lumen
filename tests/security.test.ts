import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isPrivateHostname, assertPublicUrl, BlockedAddressError } from '../server/fetch/guard.ts';
import { mergeSettings, type Settings } from '../server/config.ts';
import { proxyImage } from '../server/api/media.ts';
import { DEFAULT_CLIP } from '../server/clip/obsidian.ts';
import { proxied, safeLink } from '../web/src/util.ts';

const SETTINGS: Settings = {
  host: '127.0.0.1', port: 8780, webLogin: false, defaultTtl: 3600, fetchConcurrency: 6, perHostConcurrency: 2, fetchTimeoutMs: 20000,
  proxy: 'http://127.0.0.1:10808', noProxy: ['localhost'], rsshubBase: 'http://127.0.0.1:1200', wechat2rssBase: '', wechat2rssLan: '', zoteroDb: '', ocrPython: '', ocrEngine: '', updateCheck: false,
  retention: { days: 90, keepMinPerFeed: 50, maxPerFeed: 400 },
  ai: { enabled: true, baseUrl: 'https://api.example.com/v1', model: 'm', concurrency: 2, maxInputChars: 6000, summaryMinChars: 200, tagPrefix: 'AI:', allowedTags: ['哲学'] },
  embedding: { enabled: false, baseUrl: 'https://api.example.com/v1', model: 'e', batchSize: 16, intervalMs: 2000 },
  translate: { enabled: false, model: 't', minChars: 300, maxChars: 30000, shareCards: false },
  clip: { ...DEFAULT_CLIP, aiAnalysis: false, analysisModel: '', thinking: false, aiMetadata: false, downloadImages: false,
    imageFolder: 'img', tagLibrary: 'tags.md', nameLibrary: 'names.md', authorsFolder: 'authors', reportFolder: 'reports' },
};

test('private IPv4 ranges are blocked, public ones are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '120.53.130.158', '100.128.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('IPv6 loopback, local and IPv4-mapped private addresses are blocked', () => {
  for (const ip of ['::1', '::', 'fd00::1', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('2400:3200::1'), false);
  assert.equal(isPrivateAddress('::ffff:808:808'), false);
});

test('hostname check covers localhost variants and normalised numeric forms', () => {
  for (const raw of ['http://localhost/', 'http://localhost./', 'http://a.localhost/', 'http://printer.local/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/']) {
    assert.equal(isPrivateHostname(new URL(raw).hostname), true, raw);
  }
  assert.equal(isPrivateHostname('www.douban.com'), false);
});

test('assertPublicUrl rejects non-http schemes and private literals without DNS', async () => {
  await assert.rejects(assertPublicUrl(new URL('file:///C:/Windows/win.ini')), BlockedAddressError);
  await assert.rejects(assertPublicUrl(new URL('http://127.0.0.1:1200/douban/people/1/status')), BlockedAddressError);
  await assert.doesNotReject(assertPublicUrl(new URL('http://93.184.216.34/')));
});

test('mergeSettings keeps host/port and drops unknown keys', () => {
  const next = mergeSettings(SETTINGS, { host: '0.0.0.0', port: 1, evil: true, defaultTtl: 1800 });
  assert.equal(typeof next, 'object');
  const s = next as Settings;
  assert.equal(s.host, '127.0.0.1');
  assert.equal(s.port, 8780);
  assert.equal(s.defaultTtl, 1800);
  assert.equal('evil' in s, false);
});

test('mergeSettings rejects values that would wedge the app', () => {
  assert.equal(typeof mergeSettings(SETTINGS, { noProxy: 'x' }), 'string');
  assert.equal(typeof mergeSettings(SETTINGS, { fetchConcurrency: 0 }), 'string');
  assert.equal(typeof mergeSettings(SETTINGS, { defaultTtl: -5 }), 'string');
  assert.equal(typeof mergeSettings(SETTINGS, { proxy: 'not a url' }), 'string');
  assert.equal(typeof mergeSettings(SETTINGS, { ai: { baseUrl: 'javascript:alert(1)' } }), 'string');
  assert.equal(typeof mergeSettings(SETTINGS, { retention: { days: 0 } }), 'string');
});

test('mergeSettings accepts an empty proxy and a zero summary threshold', () => {
  const s = mergeSettings(SETTINGS, { proxy: '', ai: { summaryMinChars: 0 } }) as Settings;
  assert.equal(s.proxy, '');
  assert.equal(s.ai.summaryMinChars, 0);
  assert.equal(s.ai.model, 'm');
});

test('image proxy refuses private targets before any network request', async () => {
  for (const u of ['http://127.0.0.1:8780/api/state', 'http://localhost./x.png', 'http://[::ffff:7f00:1]/x', 'ftp://example.com/x.png']) {
    const res = await proxyImage(u, SETTINGS);
    assert.equal(res.status, 403, u);
  }
  assert.equal((await proxyImage('not a url', SETTINGS)).status, 400);
});

test('frontend proxies protocol-relative images and only links to http(s)', () => {
  assert.equal(proxied('//img.example.com/a.png'), '/img?u=' + encodeURIComponent('https://img.example.com/a.png'));
  assert.equal(proxied('/icon/3'), '/icon/3');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink(' https://example.com/a '), 'https://example.com/a');
  assert.equal(safeLink(null), null);
});
