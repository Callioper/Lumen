import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { foreignTitle, foreignText, pageTexts, groupTexts, wantSnippets, snippetMap, snippetsSince, SnippetTranslator } from '../server/ai/snippets.ts';
import { loadSettings } from '../server/config.ts';

const DEFAULT_SETTINGS = loadSettings();

test('a foreign title or comment is sent; a Chinese one, 豆瓣\'s 中文名 with its original, or a word or two are not', () => {
  assert.equal(foreignTitle('The Undiscovered Self'), true);
  assert.equal(foreignTitle('松溪谋杀案 Pine Creek Murders (2026)'), false);
  assert.equal(foreignTitle('ヤニねこ'), true);
  assert.equal(foreignTitle('OK'), false);
  assert.equal(foreignText('A slow, wonderful book about grief and the sea.'), true);
  assert.equal(foreignText('很喜欢，把原来的大制作拍成了小品'), false);
});

test('what a card and a 豆瓣 page have to translate', () => {
  const groups = [{ title: 'Ways of Listening', marks: [{ comment: '' }, { comment: 'Still the best intro to looking.' }, { comment: '好看' }] }];
  assert.deepEqual(groupTexts(groups), ['Ways of Listening', 'Still the best intro to looking.']);
  const page = { title: '聆听之道', intro: ['Seven essays on images.', '七篇文章。'], authorIntro: [], comments: [{ text: 'Brilliant and brief.' }] };
  assert.deepEqual(pageTexts(page), ['Seven essays on images.', 'Brilliant and brief.']);
  assert.deepEqual(pageTexts(null), []);
});

test('texts are queued once, translated in a batch, and handed back by text and by time', async () => {
  const db = openDb(':memory:');
  wantSnippets(db, ['Ways of Listening', 'Brilliant and brief.', 'Ways of Listening']);
  const settings = { ...DEFAULT_SETTINGS, translate: { ...DEFAULT_SETTINGS.translate, enabled: true } };
  let calls = 0, told = 0;
  const fn = async (numbered: string): Promise<string> => { calls++; return numbered.replace('Ways of Listening', '聆听之道').replace('Brilliant and brief.', '精彩而简短。'); };
  const t = new SnippetTranslator(db, () => settings, () => ({ aiApiKey: 'k' } as never), () => { told++; }, () => fn);
  assert.equal(await t.pump(), 2);
  assert.equal(await t.pump(), 0);
  assert.equal(calls, 1);
  assert.equal(told, 1);
  assert.deepEqual(snippetMap(db, ['Ways of Listening', 'Unknown']), { 'Ways of Listening': '聆听之道' });
  assert.equal(snippetsSince(db, 0)['Brilliant and brief.'], '精彩而简短。');
  assert.deepEqual(snippetsSince(db, Math.floor(Date.now() / 1000) + 60), {});
});

test('nothing is sent while translation is off or without a key', async () => {
  const db = openDb(':memory:');
  wantSnippets(db, ['Ways of Listening']);
  const fn = async (): Promise<string> => { throw new Error('should not be called'); };
  const off = new SnippetTranslator(db, () => ({ ...DEFAULT_SETTINGS, translate: { ...DEFAULT_SETTINGS.translate, enabled: false } }), () => ({ aiApiKey: 'k' } as never), () => {}, () => fn);
  assert.equal(await off.pump(), 0);
});

test('a Japanese title is foreign; one 豆瓣 gives with its Chinese name is not', () => {
  assert.equal(foreignTitle('〈カラー図解〉深海観察の科学'), true);
  assert.equal(foreignTitle('深海观察的科学 〈カラー図解〉深海観察の科学'), false);
  assert.equal(foreignTitle('雪国'), false);
});
