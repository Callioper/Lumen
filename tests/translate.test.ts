import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { loadSettings } from '../server/config.ts';
import { LlmError } from '../server/ai/llm.ts';
import { isForeign, needsTranslation, segment, parseNumbered, chunkTexts, translateTexts, weave, Translator, TR, type TranslateFn } from '../server/ai/translate.ts';

const EN = 'The future is already here, it is just not evenly distributed across the world. ';

// Answers every numbered paragraph with 「译n」, or only the ones keep() allows.
const fake = (keep: (n: number) => boolean = () => true, calls: string[] = []): TranslateFn => async (numbered) => {
  calls.push(numbered);
  return [...numbered.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1])).filter(keep).map((n) => `[${n}] 译${n}`).join('\n\n');
};

test('foreign means few Han characters; Douban one-liners are too short to bother', () => {
  assert.equal(isForeign(EN), true);
  assert.equal(isForeign('这是一段中文正文，夹着 English words 也还是中文为主。'), false);
  assert.equal(isForeign('これは日本語の文章です。漢字も少し入ります。'), true);
  assert.equal(needsTranslation('某人 想读: 《The Song of the Harbour》', 300), false);
  assert.equal(needsTranslation(EN.repeat(6), 300), true);
});

test('blocks are the innermost foreign paragraphs; Chinese ones and code are left alone', () => {
  const seg = segment(`<div><p>${EN}</p><p>已经是中文的一段，不用再译。</p><ul><li>First <a href="https://x.org">point</a></li></ul><pre><code>const x = 1;</code></pre></div>`);
  assert.deepEqual(seg.blocks.map((b) => b.tagName), ['P', 'LI']);
});

test('a body of bare text and <br>s is split into paragraphs first', () => {
  const seg = segment(`${EN}<br><br>${EN}second`);
  assert.equal(seg.blocks.length, 2);
});

test('numbered output is read back by number, wherever the lines break', () => {
  const got = parseNumbered('[1] 第一段\n[2] 第二段\n跨行的续文\n\n[3] 第三段');
  assert.equal(got.get(2), '第二段\n跨行的续文');
  assert.equal(got.size, 3);
  assert.deepEqual(chunkTexts(['a'.repeat(1500), 'b'.repeat(1500), 'c'], 2500), [[0], [1, 2]]);
});

test('a chunk with a missing paragraph is halved until the gap is isolated', async () => {
  const calls: string[] = [];
  const { done, rejected } = await translateTexts(['one', 'two', 'three', 'four'], fake((n) => n !== 3, calls));
  assert.deepEqual([...done.keys()].sort(), [0, 1, 3]);
  assert.equal(rejected, 1);
  assert.ok(calls.length > 1);
});

test('a refused paragraph costs only itself; a rate limit stops the entry', async () => {
  const refuse: TranslateFn = async (numbered) => {
    if (numbered.includes('bad')) throw new LlmError('内容被 AI 服务的审查拒绝', false);
    return fake()(numbered);
  };
  const r = await translateTexts(['fine', 'bad', 'also fine'], refuse);
  assert.deepEqual([...r.done.keys()].sort(), [0, 2]);
  assert.equal(r.rejected, 1);
  await assert.rejects(translateTexts(['x'], async () => { throw new LlmError('HTTP 429', true); }), /429/);
});

test('woven html pairs original and translation and stays sanitised', () => {
  const seg = segment(`<p>${EN}<a href="https://x.org">link</a></p><p onclick="x()">${EN}</p>`);
  const html = weave(seg, new Map([[0, '<b>译文</b>'], [1, '第二段']]));
  assert.match(html, /<p class="tr"><span class="tr-src">The future[^]*<a href="https:\/\/x.org"[^>]*>link<\/a><\/span><span class="tr-zh">&lt;b&gt;译文&lt;\/b&gt;<\/span><\/p>/);
  assert.doesNotMatch(html, /onclick/);
});

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://e.org/feed', 'f')").run();
  const now = Math.floor(Date.now() / 1000) * 1_000_000;
  const ins = db.prepare("INSERT INTO entry (id, feed_id, guid, title, content, published, ai_state) VALUES (?, 1, ?, ?, ?, 0, ?)");
  ins.run(now + 1, 'a', 'An English essay', `<p>${EN.repeat(5)}</p><p>${EN}</p>`, 2);
  ins.run(now + 2, 'b', '中文文章', `<p>${'这是一篇中文文章的正文。'.repeat(30)}</p>`, 2);
  ins.run(now + 3, 'c', 'Waiting', `<p>${EN.repeat(5)}</p>`, 1);   // the summariser has not run yet
  ins.run(now - 10 * 86400 * 1_000_000, 'd', 'Old essay', `<p>${EN.repeat(5)}</p>`, 2);
  return { db, now };
}

test('the worker skips Chinese, waits for the summariser, takes the newest first, and translates title and body', async () => {
  const { db, now } = seed();
  const settings = { ...loadSettings(), translate: { enabled: true, model: 'm', minChars: 300, maxChars: 30000, shareCards: false } };
  const t = new Translator(db, () => settings, () => ({ aiApiKey: 'k' }) as never, () => {}, () => fake());
  await t.pump();
  const rows = db.prepare('SELECT id, tr_state, tr_of, title_zh, content_tr FROM entry ORDER BY id').all() as { id: number; tr_state: number | null; tr_of: string; title_zh: string; content_tr: string }[];
  const by = new Map(rows.map((r) => [r.id - now, r]));
  assert.equal(by.get(2)?.tr_state, TR.SKIPPED);
  assert.equal(by.get(3)?.tr_state, null);
  assert.equal(by.get(-10 * 86400 * 1_000_000)?.tr_state, null);
  assert.equal(by.get(1)?.tr_state, TR.DONE);
  assert.equal(by.get(1)?.tr_of, 'feed');
  assert.equal(by.get(1)?.title_zh, '译3');
  assert.equal((by.get(1)?.content_tr.match(/tr-zh/g) ?? []).length, 2);
});

test('an old entry is translated in the background while unread, and left alone once read', async () => {
  const { db, now } = seed();
  const old = now - 10 * 86400 * 1_000_000;
  db.prepare("INSERT INTO entry (id, feed_id, guid, title, content, published, ai_state, is_read) VALUES (?, 1, 'e', 'Old read essay', ?, 0, 2, 1)").run(old - 1, `<p>${EN.repeat(5)}</p>`);
  const settings = { ...loadSettings(), translate: { enabled: true, model: 'm', minChars: 300, maxChars: 30000, shareCards: false } };
  const t = new Translator(db, () => settings, () => ({ aiApiKey: 'k' }) as never, () => {}, () => fake());
  await t.pump();
  await t.pump();
  const state = (id: number) => (db.prepare('SELECT tr_state FROM entry WHERE id = ?').get(id) as { tr_state: number | null }).tr_state;
  assert.equal(state(old), TR.DONE);
  assert.equal(state(old - 1), null);
});

test('asking for an entry already being translated waits for that one instead of asking again', async () => {
  const { db, now } = seed();
  const settings = { ...loadSettings(), translate: { enabled: true, model: 'm', minChars: 300, maxChars: 30000, shareCards: false } };
  const calls: string[] = [];
  const t = new Translator(db, () => settings, () => ({ aiApiKey: 'k' }) as never, () => {}, () => fake(() => true, calls));
  await Promise.all([t.translate(now + 1), t.translate(now + 1, 'feed')]);
  assert.equal(calls.length, 1);
  await t.translate(now + 1);       // done: a fresh request runs again
  assert.equal(calls.length, 2);
});

test('line breaks inside a paragraph reach the model as newlines', async () => {
  const { blockText } = await import('../server/ai/translate.ts');
  const seg = segment('<p>Date: 27 October<br>Time: 4:30 pm<br/>Venue: LG04</p>');
  assert.equal(blockText(seg.blocks[0]), 'Date: 27 October\nTime: 4:30 pm\nVenue: LG04');
});

test('the archive gets each paragraph followed by its translation; headings and list items stay single', async () => {
  const { bilingualForArchive } = await import('../server/ai/translate.ts');
  const { htmlToMarkdown } = await import('../server/clip/obsidian.ts');
  const seg = segment(`<h2>${EN}</h2><p>${EN}<a href="https://x.org">link</a></p><ul><li>${EN}</li></ul><p>中文段落不动。</p>`);
  const woven = weave(seg, new Map([[0, '标题译文'], [1, '段落译文\n第二行'], [2, '条目译文']]));
  const md = htmlToMarkdown(bilingualForArchive(woven));
  assert.match(md, /^## 标题译文（The future is already here/m);
  assert.match(md, /evenly distributed across the world\. \[link\]\(https:\/\/x\.org\)\n\n段落译文 {2}\n第二行/);
  assert.match(md, /^-\s+The future[^\n]*\s*\n\s*条目译文/m);
  assert.match(md, /中文段落不动。/);
  assert.doesNotMatch(md, /tr-src|tr-zh|class=/);
});
