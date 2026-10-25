import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadOf, mergeSimilar, chooseDaily, assembleDaily, missedPicks, pickExplore, type DailyItem, type DailyReport } from '../server/report/daily.ts';
import { weeklyInput, assembleWeekly, type WeeklyStats } from '../server/report/weekly.ts';
import { lastDay } from '../server/report/run.ts';
import { renderDaily, renderWeekly } from '../server/report/render.ts';

const at = (s: string): number => Math.floor(new Date(s).getTime() / 1000);
const item = (id: number, over: Partial<DailyItem> = {}): DailyItem =>
  ({ id, title: `标题${id}号的一篇文章`, feed: 'f', link: null, lead: '', interest: 0, read: false, kept: false, also: [], ...over });

test('the lead is the AI summary gist, else the opening of the text', () => {
  assert.equal(leadOf('<p>文章聚焦一艘货轮驶入旧港及双方不同表述。受访学者认为此事意在试探。</p><ul><li>细节</li></ul>', null),
    '文章聚焦一艘货轮驶入旧港及双方不同表述。');
  assert.equal(leadOf(null, '<p>正文开头第一句说的就是这件事本身的来龙去脉。第二句。</p>'), '正文开头第一句说的就是这件事本身的来龙去脉。');
});

test('the same story from two feeds is kept once, with the other under 另见', () => {
  const out = mergeSimilar([item(1, { title: '旧港书院一百岁，还有什么它的书我们没读过', feed: '青螺', interest: 0.1 }),
    item(2, { title: '旧港书院一百岁，还有什么它的书我们没读过？', feed: '溪石', interest: 0.3 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].feed, '溪石');
  assert.deepEqual(out[0].also, ['青螺']);
});

test('candidates: highest interest, a few per feed, and what the reader kept always in', () => {
  const items = [
    ...[1, 2, 3, 4, 5].map((i) => item(i, { feed: 'busy', interest: 0.5 - i / 100 })),
    item(6, { feed: 'quiet', interest: 0.2 }),
    item(7, { feed: 'busy', interest: -0.2, kept: true }),
  ];
  const chosen = chooseDaily(items, 4, 2).map((i) => i.id);
  assert.deepEqual(chosen, [1, 2, 6, 7]);
});

test('a day is due at 06:00 the next morning', () => {
  assert.equal(lastDay(at('2026-10-22T07:00:00')).period, '2026-10-21');
  assert.equal(lastDay(at('2026-10-22T05:00:00')).period, '2026-10-20');
  const d = lastDay(at('2026-10-22T07:00:00'));
  assert.equal(d.to - d.from, 86400);
});

const daily = (period: string, groups: { name: string; summary: string; items: DailyItem[] }[]): DailyReport =>
  ({ kind: 'daily', period, from: at(`${period}T00:00:00`), to: at(`${period}T00:00:00`) + 86400, overview: '', picks: [], groups, total: 0, arrived: 0 });

test('the weekly draws threads from the dailies’ groups, items once each, closest first', () => {
  const d1 = daily('2026-10-19', [{ name: '旧港百年', summary: '纪念文章', items: [item(1, { interest: 0.1 }), item(2, { interest: 0.4 })] },
    { name: '其他', summary: '', items: [item(9)] }]);
  const d2 = daily('2026-10-20', [{ name: '旧港纪念', summary: '续谈', items: [item(2, { interest: 0.4 }), item(3, { interest: 0.2 })] }]);
  const { lines } = weeklyInput([d1, d2]);
  assert.deepEqual(lines.map((l) => [l.title, l.authors]), [['旧港百年', '10月19日'], ['旧港纪念', '10月20日']]);
  const stats: WeeklyStats = { arrived: 10, completed: 1, skimmed: 2, starred: 0, liked: 0, topFeeds: [] };
  const w = assembleWeekly({ from: d1.from, to: d1.from + 7 * 86400, period: '2026-W43' }, [d1, d2],
    { overview: '本周谈旧港', groups: [{ name: '旧港百年', summary: '一周都在谈', items: [0, 1] }] }, stats);
  assert.deepEqual(w.threads[0].items.map((i) => i.id), [2, 3, 1]);
  assert.deepEqual(w.threads[0].days, ['2026-10-19', '2026-10-20']);
  const note = renderWeekly(w, 8780);
  assert.match(note, /^# 周报（2026年10月19日—25日）$/m);
  assert.match(note, /读完 1 篇，略读 2 篇/);
});

test('the weekly lists friends’ hot books and films when it has them', () => {
  const stats: WeeklyStats = { arrived: 0, completed: 0, skimmed: 0, starred: 0, liked: 0, topFeeds: [] };
  const p = { from: at('2026-10-19T00:00:00'), to: at('2026-10-26T00:00:00'), period: '2026-W43' };
  const hot = { book: [{ subject: '1', title: '偶像', people: 6, who: '甲、乙、丙', isNew: false }],
    movie: [{ subject: '2', title: '风暴', people: 2, who: '甲、乙', isNew: true }] };
  const note = renderWeekly(assembleWeekly(p, [], { overview: '', groups: [] }, stats, hot), 8780);
  assert.match(note, /^## 本周友邻热点$/m);
  assert.match(note, /^- \[偶像\]\(https:\/\/book\.douban\.com\/subject\/1\/\)：6 位友邻（甲、乙、丙 等）$/m);
  assert.match(note, /^- \[风暴\]\(https:\/\/movie\.douban\.com\/subject\/2\/\)：2 位友邻（甲、乙） · 新上榜$/m);
  const empty = renderWeekly(assembleWeekly(p, [], { overview: '', groups: [] }, stats, { book: [], movie: [] }), 8780);
  assert.doesNotMatch(empty, /友邻热点/);
});

test('the daily note lists picks and groups', () => {
  const items = [item(1, { lead: '一句简介。', interest: 0.3 }), item(2, { read: true })];
  const r = assembleDaily({ from: at('2026-10-21T00:00:00'), to: at('2026-10-22T00:00:00'), period: '2026-10-21' }, items,
    { overview: '今天谈 AI', groups: [{ name: '人工智能', summary: '两条', items: [0, 1] }] }, 300);
  assert.deepEqual(r.picks.map((i) => i.id), [1, 2]);
  const note = renderDaily(r, 8780);
  assert.match(note, /^# 日报（2026年10月21日）$/m);
  assert.match(note, /^## 人工智能（2）$/m);
  assert.match(note, /> 一句简介。/);
});

test('CNKI’s <正> marker is not part of the lead', () => {
  assert.equal(leadOf(null, '&lt;正&gt;谈论底层文学，首先需要厘清底层的含义。'), '谈论底层文学，首先需要厘清底层的含义。');
});

test('你可能错过 leaves out what was opened or kept, however is_read stands', () => {
  const items = [item(1, { read: true }), item(2, { kept: true }), item(3), item(4)];
  assert.deepEqual(missedPicks(items, new Set([3])).map((i) => i.id), [1, 4]);
});

test('破茧 is the longest unopened piece the profile says nothing about, left out of the day otherwise', () => {
  const lead = '这是一句足够长的导语，说明这篇文章在讲什么事情。';
  const it = (id: number, interest: number, chars: number, more: Partial<DailyItem> = {}) =>
    ({ id, title: `第${id}篇`, feed: '某号', link: null, lead, interest, read: false, kept: false, also: [], chars, ...more });
  const pool = [it(1, 0.3, 9000), it(2, 0.01, 3000), it(3, 0.02, 6000), it(4, -0.1, 9000), it(5, 0.0, 8000, { read: true }), it(8, 0.0, 7000), it(6, 0.0, 800)];
  const opened = new Set([8]);   // marked read in bulk (5) still counts as unopened; opened (8) does not
  assert.equal(pickExplore(pool, [pool[0]], opened)?.id, 5);
  assert.equal(pickExplore(pool, [pool[0], pool[4]], opened)?.id, 3);
  assert.equal(pickExplore(pool, pool, opened), null);
  assert.equal('chars' in (pickExplore(pool, [], opened)! as object), false);
});

test('a daily with a 破茧 pick says so in the note', () => {
  const lead = '这是一句足够长的导语，说明这篇文章在讲什么事情。';
  const x: DailyItem = { id: 7, title: '远方的文章', feed: '某号', link: null, lead, interest: 0, read: false, kept: false, also: [] };
  const r = assembleDaily({ period: '2026-10-21', from: 0, to: 86400 }, [], { overview: '', groups: [] }, 10, new Set(), x);
  const md = renderDaily(r, 8780);
  assert.match(md, /## 破茧\n\n和你平常读的方向不同，换换口味。\n\n- \*\*远方的文章\*\*/);
});
