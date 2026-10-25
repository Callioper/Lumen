import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readMovie } from '../server/content/doubanmovie.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('a film is read from 豆瓣 mobile API answers: its facts, hot short comments and the films liked alongside', () => {
  const m = readMovie(fixture('rexxar-movie-demo.json') as never, fixture('rexxar-movie-demo-interests.json') as never,
    fixture('rexxar-movie-demo-recommendations.json'));
  assert.equal(m.title, '雾港夜航');
  assert.equal(m.original, 'Night Ferry');
  assert.equal(m.cover, 'https://img.invalid/view/photo/s_ratio_poster/public/p0090101.jpg');
  assert.deepEqual(m.directors, ['玛拉·温特斯']);
  assert.equal(m.actors[0], '托马斯·瑞德');
  assert.deepEqual(m.genres, ['剧情', '悬疑']);
  assert.deepEqual(m.durations, ['102分钟']);
  assert.deepEqual([m.rating, m.votes], [7.6, 12840]);
  assert.deepEqual(m.aka, ['夜渡', 'Night Ferry'], 'the left-to-right marks 豆瓣 leaves in a title are dropped');
  assert.deepEqual(m.intro, ['最后一班渡船在大雾里偏离了航线。', '船上七个陌生人，各自带着一个不肯说的理由。']);
  assert.deepEqual([m.commentTotal, m.reviewTotal], [2140, 96]);
  assert.equal(m.comments.length, 5, 'a blank comment is dropped');
  assert.equal(m.comments[0].who, '潮间带');
  assert.equal(m.comments[0].stars, 4);
  assert.equal(m.comments[0].time, '2026-09-19');
  assert.equal(m.comments[3].stars, null);
  assert.equal(m.similar.length, 9, 'a slot that is not a subject is dropped');
  assert.equal(m.similar[0].title, '灯塔看守人');
  assert.equal(m.similar[0].rating, 7.9);
  assert.equal(m.similar[2].rating, null);
});
