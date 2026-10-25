import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveAccess } from '../server/content/liveaccess.ts';

test('a meeting number and password are read where the post prints them', () => {
  const a = liveAccess('线上：腾讯会议 号：123-456-789\n会议密码：2026', '腾讯会议', '某所');
  assert.equal(a.meeting, '腾讯会议 123 456 789，密码 2026');
});

test('a post that names only the platform gives no number', () => {
  assert.equal(liveAccess('📍线上：腾讯会议', '腾讯会议', '松溪研习社').meeting, '');
});

test('registration and live-room links are kept, with WeChat hyphens mended', () => {
  const a = liveAccess('报名：https://example.zoom.us/webinar/register/WN_AbcD‑efg\n直播间 https://live.bilibili.com/123', 'Zoom', '');
  assert.deepEqual(a.links, [
    { label: 'Zoom', url: 'https://example.zoom.us/webinar/register/WN_AbcD-efg' },
    { label: 'B站直播间', url: 'https://live.bilibili.com/123' },
  ]);
});

test('a B站 account named but not linked is searched for by its name, else the organizer', () => {
  const named = liveAccess('进行。松溪研习社B站号和微信视频号同步直播。', '', '某某');
  assert.deepEqual(named.links, [{ label: 'B站 · 松溪研习社', url: `https://search.bilibili.com/upuser?keyword=${encodeURIComponent('松溪研习社')}` }]);
  const bare = liveAccess('📍 直播：松溪研习社微信视频号 + B站账号同步放送', '', '松溪研习社、The Fold');
  assert.equal(bare.links[0].label, 'B站 · 松溪研习社');
});

test('every B站 account a post names is linked, the speakers streaming at once', () => {
  const a = liveAccess('直播预告\n林舟讲电影B站号\n苏禾聊外国文学B站号\n影评人江屿B站号\n远川批评中心视频号', 'B站', '北城师范大学');
  assert.deepEqual(a.links.map((l) => l.label), ['B站 · 林舟讲电影', 'B站 · 苏禾聊外国文学', 'B站 · 影评人江屿']);
});
