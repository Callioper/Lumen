import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { sharePage, summaryLead, keepShare, getShare, wantsAi, enhanceShare, parseCardReply } from '../server/api/share.ts';
import { stripSite, refineCard } from '../server/api/share-sites.ts';

const BODY = `<p>${'正文的第一段，讲了这篇文章的主要内容。'.repeat(8)}</p>`;
const page = (extra: Record<string, unknown> = {}) => ({
  url: 'https://example.com/a/1', title: '一篇文章', html: `<html><head><title>x</title></head><body><article>${BODY}</article></body></html>`, ...extra,
});

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (7, 'https://example.com/feed', '某刊')").run();
  db.prepare("INSERT INTO entry (id, feed_id, guid, title, link, ai_summary, published) VALUES (1, 7, 'g', 't', 'https://example.com/known', ?, 0)")
    .run('<p>短</p><p>这是一段足够长的 AI 摘要首段，概括了文章的论点。</p><ul><li>要点一</li></ul>');
  return db;
}

test('the card takes the first real paragraph of an AI summary, not its bullet list', () => {
  assert.equal(summaryLead('<p>短</p><p>这是一段足够长的 AI 摘要首段，概括了文章的论点。</p><ul><li>要点</li></ul>'), '这是一段足够长的 AI 摘要首段，概括了文章的论点。');
});

test('a page Lumen already has brings its summary and feed', () => {
  const r = sharePage(seed(), page({ url: 'https://example.com/known' }));
  assert.ok(typeof r !== 'string');
  const d = r.data;
  assert.equal(d.summary, '这是一段足够长的 AI 摘要首段，概括了文章的论点。');
  assert.equal(d.icon, '/icon/7');
  assert.equal(d.source, '某刊');
});

test('an unknown page uses its description, proxied cover and site name', () => {
  const r = sharePage(seed(), page({ description: '页面自带的简介', image: '/cover.jpg', siteName: '某站', selectedText: '  选中的一段  ', published: '2026-10-20 10:00' }));
  assert.ok(typeof r !== 'string');
  const d = r.data;
  assert.equal(d.summary, '页面自带的简介');
  assert.equal(d.cover, `/img?u=${encodeURIComponent('https://example.com/cover.jpg')}&w=1080`);
  assert.equal(d.source, '某站');
  assert.equal(d.quote, '选中的一段');
  assert.equal(d.published, Date.UTC(2026, 9, 20, 2) / 1000);
});

test('without a description the body opening is the summary; non-http images are dropped', () => {
  const r = sharePage(seed(), page({ image: 'javascript:alert(1)' }));
  assert.ok(typeof r !== 'string');
  const d = r.data;
  assert.ok(d.summary?.startsWith('正文的第一段'));
  assert.equal(d.cover, undefined);
  assert.equal(sharePage(seed(), { url: 'file:///c:/x', html: '<p>x</p>' }), 'url 应为 http(s) 地址');
});

test('kept cards expire after an hour', () => {
  const id = keepShare({ title: 't', source: 's' }, 1000);
  assert.equal(getShare(id, 1000 + 59 * 60_000)?.title, 't');
  assert.equal(getShare(id, 1000 + 61 * 60_000), undefined);
});

test('card text drops a repeated title and ends on a sentence when it can', async () => {
  const { clip, dropTitle } = await import('../web/src/share/data.ts');
  assert.equal(dropTitle('猫就是老虎？家猫和老虎有什么关系', '猫就是老虎？'), '家猫和老虎有什么关系');
  assert.equal(dropTitle('另一段话', '标题'), '另一段话');
  assert.equal(clip('第一句很长很长。第二句', 10), '第一句很长很长。');
  assert.equal(clip('一二三四五六七八九十十一', 6), '一二三四五六…');
  assert.equal(clip('短句', 10), '短句');
});

test('the card link drops tracking and keeps what opens the article', async () => {
  const { shareUrl, printedUrl } = await import('../web/src/share/data.ts');
  // Printed under the QR code on one line only; a long WeChat link would be copied off the picture broken.
  assert.equal(printedUrl('https://example.com/a?id=3'), 'example.com/a?id=3');
  assert.equal(printedUrl('https://mp.weixin.qq.com/s?__biz=MzIzNzM3NzE2MA==&mid=2247758979&idx=1&sn=df08f355aa6e974e86246c93fdf83cdc'),
    'mp.weixin.qq.com · 链接较长，请扫码打开');
  assert.equal(printedUrl('https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOpQrStUv'), 'mp.weixin.qq.com/s/AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(shareUrl('http://mp.weixin.qq.com/s?__biz=MzAwMDAwMDAwMA==&mid=2247400001&idx=1&sn=0a1b2c3d&chksm=abc&scene=21&poc_token=HO3J#rd'),
    'https://mp.weixin.qq.com/s?__biz=MzAwMDAwMDAwMA==&mid=2247400001&idx=1&sn=0a1b2c3d');
  assert.equal(shareUrl('https://example.com/a?id=3&utm_source=x'), 'https://example.com/a?id=3');
  assert.equal(shareUrl('https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOpQrStUv#new_tab'), 'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOpQrStUv');
});

test('titles lose the site name at either end, but keep their own separators', () => {
  assert.equal(stripSite('下午察：旧港新片未映先遇舆论考验 | 联合早报网', ['联合早报']), '下午察：旧港新片未映先遇舆论考验');
  assert.equal(stripSite('实测！5个例子，不写代码也能做动画！_哔哩哔哩_bilibili', ['哔哩哔哩', 'bilibili']), '实测！5个例子，不写代码也能做动画！');
  assert.equal(stripSite('控制论 - 维基百科，自由的百科全书', ['维基百科']), '控制论');
  assert.equal(stripSite('新群众文艺专号观点荐读| 新群众文艺主体论', ['北城文艺杂志', 'weixin']), '新群众文艺专号观点荐读| 新群众文艺主体论');
  assert.equal(stripSite('豆瓣', ['豆瓣']), '豆瓣');
});

test('site rules: bilibili names the UP主 and cuts the counts, wikipedia takes the lead, github the repo', () => {
  const bili = refineCard({ title: '某个视频_哔哩哔哩_bilibili', source: '哔哩哔哩', author: 'AI松溪坊', summary: '视频简介：讲了一件事。, 视频播放量 2232、弹幕量 10, 视频作者 AI松溪坊' },
    '<meta name="author" content="AI松溪坊"><div class="pubdate-ip-text">2026-10-21 22:10:12</div>', 'https://www.bilibili.com/video/BV1x', true);
  assert.deepEqual([bili.title, bili.source, bili.author, bili.summary], ['某个视频', 'AI松溪坊', undefined, '讲了一件事。']);
  assert.equal(bili.published, Date.UTC(2026, 9, 21, 14, 10, 12) / 1000);

  const wiki = refineCard({ title: '控制论 - 维基百科，自由的百科全书', source: '维基媒体基金会', author: '维基媒体项目贡献者', summary: '关于数学分支，请见控制理论。' },
    '<div id="mw-content-text"><div class="mw-parser-output"><p>短</p><p>控制论是探索调节系统的跨学科研究<sup class="reference">[1]</sup>，用于研究控制系统的结构、局限和发展。</p></div></div>',
    'https://zh.wikipedia.org/wiki/x', true);
  assert.deepEqual([wiki.title, wiki.source, wiki.author], ['控制论', '维基百科', undefined]);
  assert.equal(wiki.summary, '控制论是探索调节系统的跨学科研究，用于研究控制系统的结构、局限和发展。');

  const gh = refineCard({ title: 'GitHub - obsidianmd/obsidian-releases: Community plugins list.', source: 'GitHub', summary: 'Community plugins list. - obsidianmd/obsidian-releases' }, '', 'https://github.com/obsidianmd/obsidian-releases', true);
  assert.deepEqual([gh.title, gh.summary], ['obsidianmd/obsidian-releases', 'Community plugins list.']);

  const db = refineCard({ title: '小狐狸 (豆瓣)', source: '豆瓣', author: '安东尼·德·圣-维耶尔 作者' }, '', 'https://book.douban.com/subject/1/', true);
  assert.deepEqual([db.title, db.author], ['小狐狸', '安东尼·德·圣-维耶尔']);
});

test('a thin or foreign card asks for AI; a known AI summary does not', () => {
  const r = sharePage(seed(), page({ title: 'Why Harbor Labs Worked', description: 'Or, how MBA culture killed it',
    html: `<html><body><article><p>${'Harbor Labs was a place where researchers had time. '.repeat(20)}</p></article></body></html>` }));
  assert.ok(typeof r !== 'string');
  assert.deepEqual([r.input.weak, r.input.foreign], [true, true]);
  const known = sharePage(seed(), page({ url: 'https://example.com/known' }));
  assert.ok(typeof known !== 'string');
  assert.equal(known.input.weak, false);
  const on = { translate: { shareCards: true } } as never, off = { translate: { shareCards: false } } as never;
  assert.equal(wantsAi(r.input, on, true), true);
  assert.equal(wantsAi(r.input, off, true), false);
  assert.equal(wantsAi(r.input, on, false), false);
});

test('the AI pass translates a foreign title, keeps the original, and reports a failure on the card', async () => {
  assert.deepEqual(parseCardReply('标题：「港湾实验室为何成功」\n摘要：文章认为，港湾实验室的成功来自给研究者的时间。'),
    { title: '港湾实验室为何成功', summary: '文章认为，港湾实验室的成功来自给研究者的时间。' });
  // As the model often answers: the two lines without their labels; a single line is not enough to guess.
  assert.deepEqual(parseCardReply('港湾实验室为何成功\n\n港湾实验室以自由探索著称。'), { title: '港湾实验室为何成功', summary: '港湾实验室以自由探索著称。' });
  assert.deepEqual(parseCardReply('**摘要**：只给了摘要。'), { title: undefined, summary: '只给了摘要。' });
  assert.deepEqual(parseCardReply('只有一行'), { title: undefined, summary: undefined });
  const gh = keepShare({ title: 'obsidianmd/obsidian-releases', source: 'GitHub', pending: true });
  await enhanceShare(gh, { text: 'x', weak: false, foreign: true }, { translate: { model: 'm' } } as never, 'k', (async () => '标题：Obsidian 公共发布仓库\n摘要：介绍社区插件的提交流程。') as never);
  assert.deepEqual([getShare(gh)?.title, getShare(gh)?.summary], ['obsidianmd/obsidian-releases', '介绍社区插件的提交流程。']);
  const input = { text: 'body', weak: true, foreign: true };
  const settings = { translate: { model: 'm' } } as never;
  const id = keepShare({ title: 'Why Harbor Labs Worked', source: 'North Fund', summary: 'Or, how MBA culture killed it', pending: true });
  await enhanceShare(id, input, settings, 'k', (async () => '标题：港湾实验室为何成功\n摘要：文章认为，港湾实验室的成功来自给研究者的时间。') as never);
  assert.deepEqual(getShare(id), { title: '港湾实验室为何成功', titleOrig: 'Why Harbor Labs Worked', source: 'North Fund',
    summary: '文章认为，港湾实验室的成功来自给研究者的时间。', pending: false });
  const bad = keepShare({ title: 'X', source: 's', pending: true });
  await enhanceShare(bad, input, settings, 'k', (async () => { throw new Error('超时'); }) as never);
  assert.deepEqual([getShare(bad)?.pending, getShare(bad)?.aiNote], [false, 'AI 摘要没生成：超时']);
});
