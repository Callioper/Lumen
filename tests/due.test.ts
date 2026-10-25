import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueSoon, daysUntil } from '../web/src/due.ts';
import type { Notice } from '../web/src/api.ts';

const FROM = new Date('2026-10-26T00:00:00');
const notice = (name: string, next: Notice['next'], status: Notice['status'] = 'upcoming'): Notice =>
  ({ name, next, status, kind: '会议', date: '', end: '', deadline: '', place: '', organizer: '', speakers: [], contact: '', summary: '', online: '', live: '', replays: [], post: { id: 1 }, posts: 1 }) as unknown as Notice;

test('counts days from local midnight', () => {
  assert.equal(daysUntil('2026-10-26', FROM), 0);
  assert.equal(daysUntil('2026-11-25', FROM), 30);
});

test('splits deadlines from what is held, nearest first, within each window', () => {
  const { closing, starting } = dueSoon([
    notice('far call', { what: '截止', date: '2026-11-26' }),
    notice('call b', { what: '截止', date: '2026-11-20' }),
    notice('call a', { what: '截止', date: '2026-10-28' }),
    notice('talk', { what: '举办', date: '2026-11-02' }),
    notice('far talk', { what: '举办', date: '2026-11-10' }),
    notice('running', { what: '进行中', date: '2026-10-20' }),
    notice('no date', null),
    notice('over', { what: '举办', date: '2026-10-27' }, 'past'),
  ], FROM);
  assert.deepEqual(closing.map((n) => n.name), ['call a', 'call b']);
  assert.deepEqual(starting.map((n) => n.name), ['running', 'talk']);
});
