import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanMarkdown, unproxy } from '../server/clip/clean.ts';
import { imageSize, isFurniture, isDecoration } from '../server/clip/images.ts';
import { Libraries, parsePeople, parseTags, findPerson, nameKey, aliasesOf } from '../server/clip/library.ts';
import {
  validateMetadata, ruleMetadata, cleanTitle, extractJson, resolveName, displayTitle, originalAlias, wordCount, type MetaInput,
} from '../server/clip/metadata.ts';

const FACTS = { byline: '', sourceAccount: '', origin: '', citation: '' };
const input = (markdown: string, over: Partial<MetaInput> = {}): MetaInput =>
  ({ title: '乡野心灵 | 理论争鸣与多元实践', feed: '叙事学公众号', author: '', facts: FACTS, markdown, ...over });

// ---- clean ----

test('proxy links are turned back into their target', () => {
  const u = 'https://wechat2rss.example.com/img-proxy/?k=abc&u=' + encodeURIComponent('https://mmbiz.qpic.cn/a.jpg?wx_fmt=jpeg');
  assert.equal(unproxy(u), 'https://mmbiz.qpic.cn/a.jpg?wx_fmt=jpeg');
  assert.equal(unproxy('not a url'), 'not a url');
});

test('wechat head, decorative gifs and the tail after END are removed, facts kept', () => {
  const body = Array.from({ length: 12 }, (_, i) => `正文第${i + 1}段，讲乡野心灵的理论论辩。`).join('\n\n');
  const md = [
    '以下文章来源于：松溪社科杂志', '松溪社科杂志', '一份综合性学术期刊',
    '白川远 2026-10-19 19:59 上海',
    '![](https://mmbiz.qpic.cn/mmbiz_gif/x/0?wx_fmt=gif)',
    '**乡野心灵 | 理论争鸣与多元实践**',
    body,
    '原文出处', '《松溪社会科学》2025年第4期',
    '引用格式：林舟. 乡野心灵[J]. 松溪社会科学, 2025(4).',
    'END', '往期回顾', '[某篇旧文](https://mp.weixin.qq.com/s/1)',
  ].join('\n\n');
  const r = cleanMarkdown(md, '乡野心灵 | 理论争鸣与多元实践');
  assert.equal(r.facts.byline, '白川远');
  assert.equal(r.facts.sourceAccount, '松溪社科杂志');
  assert.equal(r.facts.origin, '《松溪社会科学》2025年第4期');
  assert.match(r.facts.citation, /^林舟/);
  assert.ok(r.markdown.startsWith('正文第1段'), r.markdown.slice(0, 40));
  assert.doesNotMatch(r.markdown, /END|往期|mmbiz_gif|一份综合性/);
  assert.equal(r.stats.tailCut, true);
});

test('escapes and broken bold are tidied, bold numbered titles become headings', () => {
  const r = cleanMarkdown('\\[注1\\] 文本 a\\-b\n\n**一、问题的提出**\n\n****x****', '题');
  assert.match(r.markdown, /^\[注1\] 文本 a-b/);
  assert.match(r.markdown, /\n## 一、问题的提出\n/);
});

test('an END marker early in the text does not cut the article', () => {
  const md = ['开头', 'END', ...Array.from({ length: 10 }, (_, i) => `后面还有正文${i}，篇幅很长很长很长。`)].join('\n\n');
  const r = cleanMarkdown(md, '题');
  assert.equal(r.stats.tailCut, false);
  assert.match(r.markdown, /后面还有正文9/);
});

// ---- images ----

test('image headers give width and height', () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 480, ext: 'png' });
  const gif = Buffer.alloc(16); gif.write('GIF89a', 0, 'ascii'); gif.writeUInt16LE(30, 6); gif.writeUInt16LE(30, 8);
  assert.deepEqual(imageSize(gif), { width: 30, height: 30, ext: 'gif' });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 600, height: 300, ext: 'jpg' });
  assert.equal(imageSize(Buffer.from('hello world, not an image')), null);
});

test('icons, dividers and banners count as furniture; photos do not', () => {
  assert.equal(isFurniture({ width: 64, height: 64, ext: 'png' }), true);
  assert.equal(isFurniture({ width: 1080, height: 60, ext: 'png' }), true);
  assert.equal(isFurniture({ width: 1080, height: 720, ext: 'jpg' }), false);
});

test('a small PNG that squeezes to almost nothing is an ornament; a screenshot that size is not', () => {
  const arc = { width: 218, height: 233, ext: 'png' as const };
  assert.equal(isDecoration(Buffer.alloc(1_200), arc), true);
  assert.equal(isDecoration(Buffer.alloc(24_000), arc), false);
  assert.equal(isDecoration(Buffer.alloc(1_200), { ...arc, ext: 'jpg' }), false);
  assert.equal(isDecoration(Buffer.alloc(30_000), { width: 1080, height: 1440, ext: 'png' }), false);
});

// ---- libraries ----

test('tag and name libraries parse their line formats', () => {
  assert.deepEqual(parseTags('# 标签库\n\n- 文学理论/叙事学\n- #媒介研究 — 说明\n不是条目'), ['文学理论/叙事学', '媒介研究']);
  const people = parsePeople('- 马克·菲尔德 | Mark Fielder | 马克·费尔德、菲尔德\n- 夏迟\n- | 无中文名');
  assert.equal(people.length, 2);
  assert.deepEqual(people[0], { zh: '马克·菲尔德', original: 'Mark Fielder', aliases: ['马克·费尔德', '菲尔德'] });
  assert.equal(findPerson(people, '', 'mark  fielder')?.zh, '马克·菲尔德');
  assert.equal(findPerson(people, '马克·费尔德')?.zh, '马克·菲尔德');
  assert.equal(nameKey('Mark·Fielder'), nameKey('mark fielder'));
});

test('aliases are read from inline and list frontmatter', () => {
  assert.deepEqual(aliasesOf('aliases: [Mark Fielder, "费尔德"]'), ['Mark Fielder', '费尔德']);
  assert.deepEqual(aliasesOf('aliases:\n  - Donna Harlow\n  - 哈洛'), ['Donna Harlow', '哈洛']);
  assert.deepEqual(aliasesOf('title: x'), []);
});

test('libraries are seeded once and new entries go under their own heading', () => {
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  mkdirSync(join(vault, 'authors'));
  writeFileSync(join(vault, 'authors', 'Mark Fielder.md'), '---\naliases: [马克·菲尔德]\n---\n');
  const libs = new Libraries(vault, 'idx/tags.md', 'idx/names.md', 'authors');
  libs.ensureSeeded(() => ['哲学'], () => [{ zh: '夏迟', original: '', aliases: [] }, { zh: 'Bruno Lauder', original: '', aliases: [] }]);
  libs.ensureSeeded(() => ['不会写入'], () => []);
  assert.deepEqual(libs.tags(), ['哲学']);
  libs.addTags(['哲学', '媒介研究']);
  libs.addPeople([{ zh: '夏迟', original: '', aliases: [] }, { zh: '唐娜·哈洛', original: 'Donna Harlow', aliases: [] }]);
  const names = readFileSync(join(vault, 'idx/names.md'), 'utf8');
  assert.match(names, /## 待补中文名（暂以原名占位）\n\n- Bruno Lauder/);
  assert.match(names, /## 待确认（Lumen 新增）\n\n- 唐娜·哈洛 \| Donna Harlow\n$/);
  assert.equal((names.match(/- 夏迟/g) ?? []).length, 1);
  assert.match(readFileSync(join(vault, 'idx/tags.md'), 'utf8'), /## 待整理（Lumen 新增）\n\n- 媒介研究\n$/);
  assert.equal(libs.authorPages().get(nameKey('马克·菲尔德')), 'Mark Fielder');
});

// ---- metadata ----

const TEXT = '文/林舟\n\n本文讨论乡野心灵。译者：夏迟。原文题为 Rural Minds in Fiction，作者 Alan Pember。\n\n更多正文。';
const PEOPLE = [{ zh: '艾伦·彭伯', original: 'Alan Pember', aliases: [] }];

test('model output is checked against the text: unseen names, titles and tags are dropped', () => {
  const raw = {
    title: '理论争鸣与多元实践',
    authors: [{ zh: '林舟', original: '' }, { zh: '程远舟', original: 'Cheng Yuanzhou' }],
    translators: [{ zh: '夏迟', original: 'Xia Chi' }],
    original: { title: 'Rural Minds in Fiction', authors: ['Alan Pember', 'Someone Else'], date: '2010年' },
    origin: '', type: '书评', keywords: ['乡野心灵', '叙事学', '这是一个非常非常非常长的关键词超过上限'],
    tags: ['#文学理论/叙事学', '不存在的标签', '另一个新标签'],
  };
  const m = validateMetadata(raw, input(TEXT), ['文学理论/叙事学'], PEOPLE);
  assert.equal(m.title, '理论争鸣与多元实践');
  assert.deepEqual(m.authors, [{ zh: '林舟', original: '' }]);
  assert.deepEqual(m.translators, [{ zh: '夏迟', original: '' }]);     // the pinyin is not in the text
  assert.deepEqual(m.original, { title: 'Rural Minds in Fiction', authors: ['Alan Pember'], date: '2010' });
  assert.equal(m.type, '书评');
  assert.deepEqual(m.keywords, ['乡野心灵', '叙事学']);
  assert.deepEqual(m.tags, ['文学理论/叙事学', '不存在的标签']);
  assert.deepEqual(m.newTags, ['不存在的标签']);
});

test('a title the model rewrote rather than trimmed is not used', () => {
  assert.equal(cleanTitle('理论争鸣与多元实践', '乡野心灵 | 理论争鸣与多元实践'), '理论争鸣与多元实践');
  assert.equal(cleanTitle('完全不同的题目', '乡野心灵 | 理论争鸣与多元实践'), '乡野心灵 | 理论争鸣与多元实践');
  assert.equal(cleanTitle('社会', '乡野心灵'), '乡野心灵');
  // a paper reposted under an editor's headline keeps the title printed in the article
  assert.equal(cleanTitle('乡野心灵：理论争鸣与多元实践', '读懂“乡野心灵”，看这一篇就够了', '林舟 教授\n\n乡野心灵：\n\n理论争鸣与多元实践\n\n正文'),
    '乡野心灵：理论争鸣与多元实践');
  assert.equal(cleanTitle('凭空编的题目', '读懂“乡野心灵”', '正文里没有它'), '读懂“乡野心灵”');
});

test('a foreign author known only by the original spelling in the text is kept', () => {
  const m = validateMetadata({ authors: [{ zh: '艾伦·彭伯', original: 'Alan Pember' }], type: '乱写' }, input(TEXT), [], []);
  assert.deepEqual(m.authors, [{ zh: '艾伦·彭伯', original: 'Alan Pember' }]);
  assert.equal(m.type, '其他');
});

test('a repost without an origin falls back to the source account', () => {
  const m = validateMetadata({}, input(TEXT, { facts: { ...FACTS, sourceAccount: '松溪社科杂志', byline: '白川远' } }), [], []);
  assert.equal(m.origin, '转自微信公众号「松溪社科杂志」');
  assert.deepEqual(m.authors, [{ zh: '白川远', original: '' }]);
  assert.equal(ruleMetadata(input(TEXT)).source, 'rules');
});

test('JSON is found inside fences or prose', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.throws(() => extractJson('没有 JSON'), /JSON/);
});

test('names resolve to the library Chinese form and link to an author page', () => {
  const pages = new Map([[nameKey('Mark Fielder'), 'Mark Fielder'], [nameKey('夏迟'), '夏迟']]);
  const people = [{ zh: '马克·菲尔德', original: 'Mark Fielder', aliases: ['马克·费尔德'] }];
  assert.deepEqual(resolveName({ zh: '马克·费尔德', original: '' }, people, pages),
    { zh: '马克·菲尔德', original: 'Mark Fielder', link: '[[Mark Fielder|马克·菲尔德]]', isNew: false });
  assert.equal(resolveName({ zh: '夏迟', original: '' }, [], pages).link, '[[夏迟]]');
  const fresh = resolveName({ zh: '本杰明·诺斯', original: 'Benjamin Norse' }, [], new Map());
  assert.deepEqual(fresh, { zh: '本杰明·诺斯', original: 'Benjamin Norse', link: '[[本杰明·诺斯]]', isNew: true });
});

test('titles take the 作者｜题目（yyyymmdd） shape, translations keep the original as alias', () => {
  const t = new Date(2026, 9, 21, 9).getTime() / 1000;
  assert.equal(displayTitle(['林舟', '夏迟'], '乡野心灵', '某号', t), '林舟、夏迟｜乡野心灵（20261021）');
  assert.equal(displayTitle([], '乡野心灵', '某号', t), '某号｜乡野心灵（20261021）');
  // The title already names its author; a column prefix that is not the author stays.
  assert.equal(displayTitle(['沈子川'], '沈子川｜夜里的灯都成了黄色的', '远川', t), '沈子川｜夜里的灯都成了黄色的（20261021）');
  assert.equal(displayTitle(['沈子川'], '沈子川 | 夜里的灯都成了黄色的', '远川', t), '沈子川｜夜里的灯都成了黄色的（20261021）');
  assert.equal(displayTitle(['江屿'], '观点荐读｜新群众文艺主体论', '北城文艺', t), '江屿｜观点荐读｜新群众文艺主体论（20261021）');
  // More than two authors: the first two and 等.
  assert.equal(displayTitle(['傅远', '吕青松', '任晓东', '刘川'], '新群众文艺的生长与远方回响', 'x', t), '傅远、吕青松等｜新群众文艺的生长与远方回响（20261021）');
  assert.equal(displayTitle(['林舟', '林舟'], '乡野心灵', 'x', t), '林舟｜乡野心灵（20261021）');
  const meta = { ...ruleMetadata(input(TEXT)), original: { title: 'Rural Minds in Fiction', authors: ['Alan Pember'], date: '2010' } };
  assert.equal(originalAlias(meta, t), 'Alan Pember｜Rural Minds in Fiction（2010）');
  assert.equal(originalAlias({ ...meta, original: { ...meta.original, date: '' } }, t), 'Alan Pember｜Rural Minds in Fiction（20261021）');
  assert.equal(originalAlias(ruleMetadata(input(TEXT)), t), '');
});

test('the push headline is kept only when the paper title is not a trimmed version of it', async () => {
  const { pushHeadline } = await import('../server/clip/service.ts');
  assert.equal(pushHeadline('林舟 | 乡野心灵：理论争鸣与多元实践', '乡野心灵：理论争鸣与多元实践'), '');
  assert.equal(pushHeadline('读懂“乡野心灵”，看这一篇就够了', '乡野心灵：理论争鸣与多元实践'), '读懂“乡野心灵”，看这一篇就够了');
});

test('word count treats each Chinese character and each other word as one', () => {
  assert.equal(wordCount('乡野心灵 is a theory ![[img.png]] [链接](https://x.y)'), 9);
});

test('origin numbers the model changed fall back to the text; author prefixes leave the title', async () => {
  const { numbersIn, stripAuthorPrefix } = await import('../server/clip/metadata.ts');
  assert.deepEqual(numbersIn('《松溪外语研究》2026第二十三辑'), ['2026', '23']);
  const facts = { ...FACTS, origin: '原文载于《松溪外语研究》2026第二十三辑，经期刊与作者授权由“远方文学研究”微信公众号推出。' };
  const bad = validateMetadata({ origin: '原载《松溪外语研究》2026年第1期' }, input(TEXT, { facts }), [], []);
  assert.equal(bad.origin, '原文载于《松溪外语研究》2026第二十三辑');
  const good = validateMetadata({ origin: '原载《松溪外语研究》2026年第23辑' }, input(TEXT, { facts }), [], []);
  assert.equal(good.origin, '原载《松溪外语研究》2026年第23辑');
  assert.equal(stripAuthorPrefix('许南岸 | 人工智能背景下的人文自觉', [{ zh: '许南岸', original: '' }]), '人工智能背景下的人文自觉');
  assert.equal(stripAuthorPrefix('茶座 | 旧物的文化与政治', [{ zh: '许南岸', original: '' }]), '茶座 | 旧物的文化与政治');
});

test('account name, odd bold markers, glued images and sign-offs are cleaned', () => {
  const body = Array.from({ length: 8 }, (_, i) => `正文第${i}段，篇幅足够长的一段文字。`).join('\n\n');
  const md = ['远方文学研究', '**【作者简介】', '林舟，**北城大学教授', '![](https://a.b/x.jpg)**林舟 教授', body,
    '[旧文一](https://mp.weixin.qq.com/s/1)', '[旧文二](https://mp.weixin.qq.com/s/2)', '欢迎关注**'].join('\n\n');
  const r = cleanMarkdown(md, '乡野心灵', '远方文学研究');
  assert.ok(r.markdown.startsWith('【作者简介】\n\n林舟，北城大学教授\n\n![](https://a.b/x.jpg)\n\n*林舟 教授*'), r.markdown.slice(0, 80));
  assert.ok(r.markdown.endsWith('正文第7段，篇幅足够长的一段文字。'), r.markdown.slice(-40));
});

test('a number on its own line above a short line becomes a section heading', () => {
  const md = '开头一段，讲了很多事情。\n\n1\n\n你需要的可能不是「理解」，只是「距离」\n\n先回到最简单的任务。\n\n共 3 篇\n\n这是一句完整的话。';
  const out = cleanMarkdown(md, 't').markdown;
  assert.match(out, /^## 1 你需要的可能不是「理解」，只是「距离」$/m);
  assert.doesNotMatch(out, /^## .*共 3 篇/m);
});

test('bold and italic runs that Obsidian would not close get a space on the failing side', async () => {
  const { fixEmphasisSpacing } = await import('../server/clip/clean.ts');
  assert.equal(fixEmphasisSpacing('**摘要：**新大众文艺'), '**摘要：** 新大众文艺');
  assert.equal(fixEmphasisSpacing('归纳为**“人类感性”**（Kelly）'), '归纳为 **“人类感性”**（Kelly）');
  assert.equal(fixEmphasisSpacing('形成*“从服务到创造”*的转变'), '形成 *“从服务到创造”* 的转变');
  assert.equal(fixEmphasisSpacing('这是**重点**而已，**“引语”**。'), '这是**重点**而已，**“引语”**。');
  assert.equal(fixEmphasisSpacing('`a**：**b` 和\n```\n**x：**y\n```'), '`a**：**b` 和\n```\n**x：**y\n```');
});

test('a numbered title ending on a colon takes the next line; a bold question may be long', () => {
  const md = '正文第一段，讲了很多事情。\n\n**02**\n\n**算力过剩、框架松动和无尽回溯：  \n**\n\n**“离身心智”面对的困境**\n\n正文。\n\n3\n\n**能否解释“统一token假说”具体指什么？它真正的作用有哪些？在当下这个人工智能时代又意味着什么？**\n\n回答。';
  const out = cleanMarkdown(md, 't').markdown;
  assert.match(out, /^## 02 算力过剩、框架松动和无尽回溯：“离身心智”面对的困境$/m);
  assert.match(out, /^## 3 能否解释“统一token假说”具体指什么？/m);
});

test('swipe prompts go, bold titles become headings, bold paragraphs lose their bold, captions are set apart', () => {
  const long = '周四，我们发布了三篇同题评论，邀请大家玩了一场“找卧底”的游戏，截止今天中午共有两百多位读者参与了投票，结果相当出人意料，大家几乎一致认为第一篇最像机器写的。';
  const md = ['开头一段，讲了很多事情。', `**${long}**`, '![](https://a.b/v.png)', '投票结果', '***究竟哪一篇评论是由AI生成的？***',
    '左滑', '查看答案👈', '**AI书评生成交互过程**', '**张三**', '**——评行烟烟《非赢游戏》**', '![](https://a.b/w.png)', '1、首先，这部小说更新在公众号上。'].join('\n\n');
  const out = cleanMarkdown(md, 't').markdown.split('\n\n');
  assert.deepEqual(out, ['开头一段，讲了很多事情。', long, '![](https://a.b/v.png)', '*投票结果*', '## 究竟哪一篇评论是由AI生成的？',
    '## AI书评生成交互过程', '**张三**', '**——评行烟烟《非赢游戏》**', '![](https://a.b/w.png)', '1、首先，这部小说更新在公众号上。']);
});
