import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { readSorted, sortKinds, sortedOf } from '../server/content/bookkinds.ts';
import { loadSettings } from '../server/config.ts';
import { LlmError } from '../server/ai/llm.ts';
import type { ListedBook } from '../server/content/books.ts';

const book = (title: string): ListedBook => ({ title, cover: null, authors: '某人 著', translators: '', publisher: '某社', date: '', isbn: '', subject: null, price: '', blurb: '简介' });

test('an answer is read as a kind and a subject per book; no kind of the five is null, an unlisted subject 其他', () => {
  const out = '好的：{"1":{"kind":"虚构","topic":"小说"},"2":{"kind":"学术","topic":"量子力学"},"3":{"kind":"散文","topic":"哲学"}}';
  assert.deepEqual(readSorted(out, 4), [{ kind: '虚构', topic: '小说' }, { kind: '学术', topic: '其他' }, null, null]);
  assert.deepEqual(readSorted('不是 JSON', 2), [null, null]);
});

test('books are sorted a batch at a time, kept, and one the answer skipped is left to ask again', async () => {
  const db = openDb(':memory:');
  const books = ['甲', '乙', '丙'].map((t) => ({ key: t, b: book(t) }));
  const asked: string[] = [];
  const ask = async (p: string): Promise<string> => { asked.push(p); return '{"1":{"kind":"非虚构","topic":"历史"},"2":{"kind":"童书","topic":"科普"}}'; };
  const n = await sortKinds(db, books, loadSettings(), { aiApiKey: 'k' } as never, ask);
  assert.equal(n, 2);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /1\. 《甲》 某人 著 ｜ 某社/);
  assert.deepEqual([...sortedOf(db, ['甲', '乙', '丙'])], [['甲', { kind: '非虚构', topic: '历史' }], ['乙', { kind: '童书', topic: '科普' }]]);
});

test('a batch the AI refuses to read is asked one book at a time; the refused book is filed 其他 and not asked again', async () => {
  const db = openDb(':memory:');
  const books = ['甲', '禁', '丙'].map((t) => ({ key: t, b: book(t) }));
  const asked: string[] = [];
  const ask = async (p: string): Promise<string> => {
    asked.push(p);
    if (p.includes('《禁》')) throw new LlmError('内容被 AI 服务的审查拒绝', false, true);
    return '{"1":{"kind":"学术","topic":"哲学"}}';
  };
  const n = await sortKinds(db, books, loadSettings(), { aiApiKey: 'k' } as never, ask);
  assert.equal(n, 3);
  assert.equal(asked.length, 4);   // the batch, then each of the three alone
  assert.deepEqual(sortedOf(db, ['禁']).get('禁'), { kind: '其他', topic: '其他' });
  assert.equal(sortedOf(db, ['甲', '丙']).size, 2);
  asked.length = 0;
  assert.equal(await sortKinds(db, books, loadSettings(), { aiApiKey: 'k' } as never, ask), 0);
  assert.equal(asked.length, 0);
});
