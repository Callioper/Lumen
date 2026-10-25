import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { validatePage, parsePublished, saveWebPage, WEB_CATEGORY } from '../server/clip/web.ts';

const BODY = '<p>' + '这是一段足够长的正文，用来让 Readability 认出文章主体。'.repeat(20) + '</p>';
const html = (extra = '') => `<html><head><title>页面标题</title></head><body><nav>导航</nav><article><h1>页面标题</h1>${BODY}${extra}</article></body></html>`;

test('page payloads are validated before anything is stored', () => {
  assert.equal(validatePage(null), '请求体应为对象');
  assert.equal(validatePage({ url: 'javascript:alert(1)', html: 'x' }), 'url 应为 http(s) 地址');
  assert.equal(validatePage({ url: 'https://a.com/x', html: '  ' }), 'html 不能为空');
  const ok = validatePage({ url: 'https://a.com/x', html: '<p>x</p>', title: 't', siteName: 5 });
  assert.equal(typeof ok, 'object');
  assert.equal((ok as { siteName?: string }).siteName, undefined);
});

test('publish times read ISO, plain and Chinese forms, China time by default', () => {
  assert.equal(parsePublished('2026-10-20T10:00:00+08:00'), Date.UTC(2026, 9, 20, 2) / 1000);
  assert.equal(parsePublished('2026年10月20日 10:00'), Date.UTC(2026, 9, 20, 2) / 1000);
  assert.equal(parsePublished('2026-10-20'), Date.UTC(2026, 9, 19, 16) / 1000);
  assert.equal(parsePublished('昨天'), null);
  assert.equal(parsePublished(undefined), null);
});

test('a page lands in a paused per-site feed under 网页剪藏 and is not stored twice', () => {
  const db = openDb(':memory:');
  const page = { url: 'https://mp.weixin.qq.com/s/abc', title: '论文题目', html: html('<script>evil()</script>'), siteName: '某公众号', published: '2026年10月20日 10:00' };
  const first = saveWebPage(db, page, 1_800_000_000);
  assert.equal(first.existed, false);
  const e = db.prepare('SELECT e.*, f.title ft, f.paused, c.name cat FROM entry e JOIN feed f ON f.id = e.feed_id JOIN category c ON c.id = f.category_id WHERE e.id = ?')
    .get(first.id) as Record<string, unknown>;
  assert.equal(e.ft, '某公众号');
  assert.equal(e.paused, 1);
  assert.equal(e.cat, WEB_CATEGORY);
  assert.equal(e.is_read, 1);
  assert.equal(e.title, '论文题目');
  assert.equal(e.published, Date.UTC(2026, 9, 20, 2) / 1000);
  assert.doesNotMatch(String(e.content), /evil|导航/);
  assert.deepEqual(saveWebPage(db, page), { id: first.id, existed: true });
  const other = saveWebPage(db, { url: 'https://example.com/post', title: '', html: html() }, 1_800_000_000);
  assert.equal((db.prepare('SELECT f.title FROM entry e JOIN feed f ON f.id = e.feed_id WHERE e.id = ?').get(other.id) as { title: string }).title, 'example.com');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM category WHERE name = ?').get(WEB_CATEGORY) as { n: number }).n, 1);
});
