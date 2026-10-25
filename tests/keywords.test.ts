import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { vocabulary, namesMentioned, keywordProfile, keywordHits } from '../server/rec/keywords.ts';

const people = [
  { zh: '米歇尔·佛朗', original: 'Michel Ferrant', aliases: ['佛朗'] },
  { zh: '罗兰·贝尔', original: 'Roland Berle', aliases: ['贝尔'] },
  { zh: '凯瑟琳·霍尔德', original: 'N. Katherine Holder', aliases: ['霍尔德', 'Holder'] },
  { zh: '王', original: '', aliases: [] },
];

test('a name is found by any of its forms; one-character names are not used', () => {
  const v = vocabulary(people);
  assert.equal(v.has('王'), false);
  assert.deepEqual([...namesMentioned('重读佛朗与 Holder', v)].sort(), ['凯瑟琳·霍尔德', '米歇尔·佛朗']);
});

test('a short form running into another transliterated name is someone else', () => {
  const v = vocabulary(people);
  assert.deepEqual([...namesMentioned('导读贝尔德《性别迷宫》', v)], []);
  assert.deepEqual([...namesMentioned('贝尔、杜兰及其他', v)], ['罗兰·贝尔']);
});

test('a name kept in two articles becomes a keyword and is found in a new one', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '某号')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published) VALUES (?, 1, ?, ?, ?, 0)');
  add.run(1, 'a', '重读佛朗', '<p>知识地层学</p>');
  add.run(2, 'b', '一篇访谈', '<p>谈到米歇尔·佛朗和霍尔德</p>');
  add.run(3, 'c', '只提一次的人', '<p>罗兰·贝尔</p>');
  const kws = keywordProfile(db, [1, 2, 3], people);
  assert.deepEqual(kws.map((k) => k.name), ['米歇尔·佛朗']);
  assert.deepEqual(keywordHits(kws, '佛朗百年：新书', vocabulary(people)), ['米歇尔·佛朗']);
  assert.deepEqual(keywordHits(kws, '与佛朗无关的贝尔德', vocabulary(people)), ['米歇尔·佛朗']);
  assert.deepEqual(keywordHits(kws, '别的事', vocabulary(people)), []);
});
