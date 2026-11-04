import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventTitle, eventPath, eventPage, addToNote, writeEventNote, type EventPick } from '../server/clip/event.ts';
import { NO_EVENT, EVENT_BODY_TEMPLATE, type ClipPage } from '../server/clip/obsidian.ts';

const BASE: ClipPage = {
  title: '讲座预告｜书信手稿考释', titleZh: '', url: 'https://mp.example.invalid/preview', content: '![](440/海报.png)\n\n讲座简介……',
  selectedText: '', author: '', feed: '松溪人文', published: Date.UTC(2026, 9, 19, 5) / 1000, summary: '', summaryLead: '', tags: [],
  displayTitle: '', headline: '', alias: '', authorLinks: '', translatorLinks: '', origin: '', type: '', keywords: '书信', tagLine: '#比较文学',
  words: 10, citation: '', ...NO_EVENT,
};
const TALK: EventPick = {
  role: 'own', kind: '讲座',
  event: { kind: '讲座', name: '“书信手稿考释”', date: '2026-10-22', time: '14:00', end: '', deadline: '', place: '汇文楼 1100', organizer: '松溪大学人文学院',
    speakers: ['林舟教授（松溪大学）'], contact: '', summary: '考释百余封书信。', online: '', live: '', replays: [] },
};
const resolveSpeakers = (names: string[]) => names.map((zh) => ({ zh, link: `[[${zh}]]` }));

test('the title is 主讲人｜题目（举办日）, filed under the year it is held', () => {
  assert.equal(eventTitle(['林舟'], '“书信手稿考释”', '2026-10-22', 0), '林舟｜书信手稿考释（20261022）');
  assert.equal(eventTitle([], '松溪文艺学年会', '2026-11-08', 0), '松溪文艺学年会（20261108）');
  assert.equal(eventTitle(['甲', '乙', '丙'], '对谈', '2026-11-08', 0), '甲、乙等｜对谈（20261108）');
  assert.equal(eventPath('Notes/Lectures/', '林舟｜书信手稿考释（20261022）', '2026-10-22', 0),
    'Notes/Lectures/2026/林舟｜书信手稿考释（20261022）.md');
});

test('a 预告 makes the note in the lecture layout, from what 学术动态 read', () => {
  const page = eventPage({ pick: TALK, count: 1, base: BASE, content: BASE.content, postUrl: BASE.url, resolveSpeakers });
  assert.equal(page.displayTitle, '林舟｜书信手稿考释（20261022）');
  assert.equal(page.speakerLinks, '[[林舟]]');
  assert.equal(page.poster, '![](440/海报.png)');
  assert.equal(page.postLinks, '[预告](https://mp.example.invalid/preview)');
  assert.match(page.content, /^## 讲座信息\n\n!\[\]/);
  const vault = mkdtempSync(join(tmpdir(), 'lumen-event-'));
  try {
    const rel = eventPath('Lectures', page.displayTitle, TALK.event.date, BASE.published);
    const r = writeEventNote(vault, rel, EVENT_BODY_TEMPLATE, page, BASE.url);
    assert.equal(r.existed, false);
    const note = readFileSync(r.path, 'utf8');
    for (const line of ['- date:: [[2026-10-22]]', '- time:: 14:00', '- place:: 汇文楼 1100', '- type:: 讲座', '- author:: [[林舟]]',
      '- organizer:: 松溪大学人文学院', '- 海报:: ![](440/海报.png)', '>summary:: 考释百余封书信。', '# Notes']) assert.ok(note.includes(line), line);
    // the same post again adds nothing
    assert.equal(writeEventNote(vault, rel, EVENT_BODY_TEMPLATE, page, BASE.url).existed, true);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('a 回顾 goes into the note of its talk: its section before 「# Notes」, its link and the recording filled in', () => {
  const recap: EventPick = { ...TALK, role: 'recap', event: { ...TALK.event, post: { id: 1, title: '', feedId: 1, feed: '', published: 0, link: BASE.url },
    replays: [{ bvid: 'BV1xx', title: '', author: '松溪人文', at: 0, minutes: 90 }] } };
  const page = eventPage({ pick: recap, count: 1, base: { ...BASE, url: 'https://mp.example.invalid/recap' }, content: '季老师首先……', postUrl: 'https://mp.example.invalid/recap', resolveSpeakers });
  assert.equal(page.url, BASE.url, 'the note still links its 预告');
  const note = '# Metadata\n- 公众号:: [预告](https://mp.example.invalid/preview)\n- 录屏:: \n\n## 讲座信息\n\n简介\n\n# Notes\n我的笔记';
  const out = addToNote(note, page, 'https://mp.example.invalid/recap')!;
  assert.match(out, /- 公众号:: \[预告\]\(https:\/\/mp\.example\.invalid\/preview\) · \[回顾\]\(https:\/\/mp\.example\.invalid\/recap\)/);
  assert.match(out, /- 录屏:: \[B站 · 松溪人文\]\(https:\/\/www\.bilibili\.com\/video\/BV1xx\)/);
  assert.ok(out.indexOf('## 回顾｜松溪人文') < out.indexOf('# Notes'));
  assert.ok(out.endsWith('# Notes\n我的笔记'), 'what the reader wrote stays where it was');
  assert.equal(addToNote(out, page, 'https://mp.example.invalid/recap'), null);
});

test('a post listing several talks gives each a few lines, not the whole post', () => {
  const page = eventPage({ pick: TALK, count: 3, base: BASE, content: BASE.content, postUrl: BASE.url, resolveSpeakers });
  assert.match(page.content, /- 时间：2026-10-22 14:00\n- 地点：汇文楼 1100/);
  assert.match(page.content, /共 3 场/);
  assert.equal(page.poster, '');
});
