import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventTime } from '../server/content/eventtime.ts';

test('the time written after the event\'s date', () => {
  assert.equal(eventTime('时间：10月29日（周三）14:00-16:00\n地点：主楼', '2026-10-29'), '14:00');
  assert.equal(eventTime('2026年10月29日 下午2点半，在图书馆', '2026-10-29'), '14:30');
  assert.equal(eventTime('讲座时间：2026.10.29 19：30', '2026-10-29'), '19:30');
  assert.equal(eventTime('10月29日 晚上7点 线上', '2026-10-29'), '19:00');
});

test('another day\'s time is not taken for this one', () => {
  const text = '10月28日 9:00 报到\n10月29日 14:00 开幕';
  assert.equal(eventTime(text, '2026-10-29'), '14:00');
});

test('a post with one time only is taken at it', () => {
  assert.equal(eventTime('本周四晚 19:00，我们在书店见', '2026-10-29'), '19:00');
});

test('no time, or a number that is not one', () => {
  assert.equal(eventTime('10月29日举行，详见海报', '2026-10-29'), '');
  assert.equal(eventTime('第3点：请提前报名', '2026-10-29'), '');
  assert.equal(eventTime('9:00 报到，14:00 开幕', '2026-10-30'), '');
});
