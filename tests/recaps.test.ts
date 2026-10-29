import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRecaps, OVER, type Recap } from '../server/content/recaps.ts';
import { replayKey, type Notice } from '../server/content/notices.ts';

type Held = Notice & { post: { id: number } };
const notice = (o: Partial<Notice>, id = 1): Held => ({ kind: '讲座', name: '', date: '', end: '', deadline: '', place: '', organizer: '',
  speakers: [], contact: '', summary: '', online: '', live: '', ...o, post: { id } });
const at = (ymd: string): number => new Date(`${ymd}T20:00:00`).getTime() / 1000;
const post = (title: string, day: string, id = 100): Recap => ({ id, title, feedId: 1, feed: '某号', published: at(day), link: null });

test('a write-up is said to be over in its title', () => {
  assert.ok(OVER.test('讲座回顾｜奇点已来？我们如何想象与书写现实'));
  assert.ok(OVER.test('会议纪要｜某某研讨会'));
  assert.ok(!OVER.test('讲座预告｜奇点已来？'));
});

test('a write-up finds its talk by title, posted on the day or after', () => {
  const talk = notice({ name: '“奇点已来？我们如何想象与书写现实”（远川讲座第60讲）', date: '2026-10-16' });
  const found = matchRecaps([talk], [post('讲座回顾｜奇点已来？我们如何想象与书写现实', '2026-10-20')], replayKey);
  assert.equal(found.get(replayKey(talk))?.length, 1);
  assert.equal(matchRecaps([talk], [post('讲座回顾｜奇点已来？我们如何想象与书写现实', '2026-10-10')], replayKey).size, 0);
  assert.equal(matchRecaps([talk], [post('讲座回顾｜奇点已来？我们如何想象与书写现实', '2027-01-20')], replayKey).size, 0);
});

test('one full speaker name will do, for the latest talk of that speaker within a month', () => {
  const first = notice({ name: '早一场', date: '2026-08-20', speakers: ['莫妮卡·贝洛'] }, 1);
  const talk = notice({ name: '从观念走向实验：艺术对现实的追问', date: '2026-09-11', speakers: ['莫妮卡·贝洛'] }, 2);
  const found = matchRecaps([first, talk], [post('讲座笔记 | 莫妮卡·贝洛×赖立里：艺术同样需要科学的推理过程', '2026-09-15')], replayKey);
  assert.deepEqual([...found.keys()], [replayKey(talk)]);
  // two characters are too common to go by
  const short = notice({ name: '毕生所爱', date: '2026-10-22', speakers: ['林白'] });
  assert.equal(matchRecaps([short], [post('活动回顾｜林白谈电影', '2026-10-25')], replayKey).size, 0);
});

test('a call for papers or an undated event has no write-up', () => {
  const call = notice({ kind: '征稿', name: '人工智能时代的文学跨学科研究', date: '2026-09-24' });
  const undated = notice({ name: '人工智能时代的文学跨学科研究' });
  assert.equal(matchRecaps([call, undated], [post('讲座回顾｜人工智能时代的文学跨学科研究', '2026-09-30')], replayKey).size, 0);
});
