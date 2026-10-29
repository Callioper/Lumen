import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calledJournal, journalRank, rankIs, rankKey } from '../server/content/ranks.ts';

const kinds = (name: string, opts?: { exact?: boolean }): string[] =>
  (journalRank(name, opts)?.in ?? []).filter((x) => x.current && (x.kind === 'cssci' || x.kind === 'pku')).map((x) => x.kind).sort();

test('the ways a journal name is written come to one key', () => {
  assert.equal(rankKey('北京大学学报（哲学社会科学版）'), rankKey('《北京大学学报(哲学社会科学版)》'));
  assert.equal(rankKey('课程·教材·教法'), rankKey('课程.教材.教法'));
  assert.equal(rankKey('河南大学学报(社科版)'), rankKey('河南大学学报(社会科学版)'));
  assert.equal(rankKey('澳门理工学报(人文社科版)'), rankKey('澳门理工学报(人文社会科学版)'));
  assert.equal(rankKey('东南大学学报(哲社版)'), rankKey('东南大学学报(哲学社会科学版)'));
});

test('a journal in the current CSSCI and 北大核心 is marked by both', () => {
  assert.deepEqual(kinds('文艺理论研究'), ['cssci', 'pku']);
  assert.deepEqual(kinds('河南大学学报(社科版)'), ['cssci', 'pku']);
});

test('a name without its edition is taken for its one humanities edition', () => {
  // 北大 also has 安徽大学学报(自然科学版), which a reader leaving the edition out does not mean
  assert.deepEqual(kinds('安徽大学学报'), ['cssci', 'pku']);
  // CSSCI names it bare, 北大 with its edition: the bare name gets both
  assert.deepEqual(kinds('上海财经大学学报', { exact: true }), ['cssci', 'pku']);
});

test('an exact lookup does not guess from the start of a name', () => {
  assert.equal(journalRank('华东师范大学', { exact: true }), null);
  assert.equal(journalRank('人大复印·文艺理论'), null);
  assert.equal(journalRank(''), null);
});

test('an older edition is kept, not current', () => {
  const r = journalRank('文史哲')!;
  assert.ok(r.in.some((x) => x.kind === 'cssci' && x.edition === '2021–2022' && !x.current));
  assert.equal(r.in[0].edition >= r.in[r.in.length - 1].edition, true);
});

test('a rank filter takes the current edition only', () => {
  const r = journalRank('文艺理论研究');
  assert.ok(rankIs(r, 'cssci'));
  assert.ok(rankIs(r, ''));
  assert.ok(!rankIs(null, 'pku'));
  assert.ok(rankIs(null, ''));
  const only2021 = { in: [{ kind: 'cssci' as const, edition: '2021–2022', current: false }] };
  assert.ok(!rankIs(only2021, 'cssci'));
  assert.ok(!rankIs(only2021, 'school'));
  assert.ok(rankIs({ in: [], school: { short: '某校', level: 'A', from: '' } }, 'school'));
});

test('a call for papers is for the journal its title names in 《》', () => {
  assert.equal(calledJournal('《河南大学学报》（社会科学版）征稿'), '河南大学学报');
  assert.equal(calledJournal('第三届某某论坛征文'), '');
});

test('AMI marks a journal by its level, and the filter takes 核心 or above', () => {
  const r = journalRank('考古学报');
  assert.equal(r?.in.find((x) => x.kind === 'ami')?.level, '顶级');
  assert.ok(rankIs(r, 'ami'));
  const ext = { in: [{ kind: 'ami' as const, level: '扩展', edition: '2022', current: true }] };
  assert.ok(!rankIs(ext, 'ami'));
});

test('北大核心 2020 is kept as an older edition', () => {
  const r = journalRank('学术月刊')!;
  assert.ok(r.in.some((x) => x.kind === 'pku' && x.edition === '2020 年版' && !x.current));
});

test('人大复印 来源期刊 and 国家社科 资助期刊 are marked too', () => {
  const r = journalRank('文学评论')!;
  assert.ok(r.in.some((x) => x.kind === 'rdfy' && x.current));
  assert.ok(r.in.some((x) => x.kind === 'nssf' && x.current));
});
