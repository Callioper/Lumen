import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPaper, splitHeading, authorsInText, type PaperInput } from '../server/report/papers.ts';
import { mergeReposts, type PaperItem } from '../server/report/collect.ts';
import { parseWritten, OTHER_GROUP } from '../server/report/write.ts';
import { isoWeek, lastWeek, splitPapers } from '../server/report/run.ts';
import { checkZotero } from '../server/report/zotero.ts';
import { renderPapers, rangeLabel, rangeSlug, type PapersReport } from '../server/report/render.ts';
import { setKeySources } from '../server/report/sources.ts';

// The 论文周报's key accounts are the reader's own (data/key-sources.json); these stand in for them.
setKeySources({
  '松溪青年研究': { journal: '松溪青年研究' }, '远方文学评论': { journal: '远方文学评论' },
  '旧港文学OldHarbor': { journal: '旧港文学', literary: true },
  '青螺Spirals': {}, '长夜批判社': {}, '溪石': {}, '行走的读书人': {},
});

const input = (over: Partial<PaperInput>): PaperInput =>
  ({ title: '', feedTitle: '某公众号', category: '学人', view: 'article', html: '', author: null, ...over });

test('a repost with 摘要 and 关键词 is a paper, with its authors taken from the headline', () => {
  const p = detectPaper(input({ title: '林望舟 苏晚禾｜当普通人走到台前：新群众文艺的“烟火气”',
    html: `<p>摘要：新群众文艺让普通人走到台前。这是第二句。这是第三句，${"很长".repeat(90)}。</p><p>关键词：新群众文艺</p><p>原刊《松溪社会科学》2026年08期</p>` }));
  assert.ok(p);
  assert.equal(p.authors, '林望舟、苏晚禾');
  assert.equal(p.title, '当普通人走到台前：新群众文艺的“烟火气”');
  assert.equal(p.venue, '《松溪社会科学》2026年08期');
  assert.equal(p.abstract, '新群众文艺让普通人走到台前。这是第二句。');
  assert.equal(p.via, 'repost');
});

test('journal listings are papers with CNKI authors; a 目次 or authorless item is not', () => {
  const j = { category: '学术期刊', feedTitle: '文史哲' };
  const p = detectPaper(input({ ...j, title: '《松溪志》乡约观念及其现代意义', author: '杜若;夏迟;', html: '<p>《松溪志》蕴含乡约观念。其二。</p>' }));
  assert.equal(p?.authors, '杜若、夏迟');
  assert.equal(p?.venue, '文史哲');
  assert.equal(p?.abstract, '《松溪志》蕴含乡约观念。其二。');
  assert.equal(detectPaper(input({ ...j, title: '本期目次', author: '' })), null);
  assert.equal(detectPaper(input({ ...j, title: '北大学人', author: null })), null);
});

test('passing mentions of a journal do not make a paper', () => {
  // A podcast and a Douban post quoting a journal; a newspaper; a source line without year and issue.
  assert.equal(detectPaper(input({ view: 'audio', title: '212. 认识北城作家', html: '原载《收获》2025年第3期' })), null);
  assert.equal(detectPaper(input({ title: '网文里的时空想象', html: '本文原载《文艺报》2026年10月' })), null);
  assert.equal(detectPaper(input({ title: '我研究的是石头', html: '本文发表于《科幻世界》' })), null);
  assert.equal(detectPaper(input({ title: '“松溪社会观察”第六季招募开启', html: '摘要：x 关键词：y 原刊《十月》2026年第1期' })), null);
  assert.ok(detectPaper(input({ title: '基础研究的政治学', html: '原刊《读书》2025年第8期' })));
});

test('headline column labels and occasions are not taken for authors', () => {
  assert.deepEqual(splitHeading('学术论文｜程远山、柯宁：当代先锋小说中的“戏仿”因素'), { authors: '程远山、柯宁', title: '当代先锋小说中的“戏仿”因素' });
  assert.deepEqual(splitHeading('松溪书院建院90周年｜叶闻：一个时代的结束'), { authors: '叶闻', title: '一个时代的结束' });
  assert.equal(splitHeading('重新回到田垄：当代青年与乡土生活的相遇').authors, '');
  assert.equal(splitHeading('埃米尔·罗萨特｜永恒的折返').authors, '埃米尔·罗萨特');
});

const item = (over: Partial<PaperItem>): PaperItem => ({ authors: '', title: '', venue: '', abstract: '', via: 'repost', id: 1, link: null,
  feed: 'A', also: [], interest: 0, read: false, ...over });

test('the same paper from several accounts is one item, keeping the fuller record and naming the others', () => {
  const out = mergeReposts([
    item({ id: 1, feed: '北城审美文化', title: '当普通人走到台前：新群众文艺的“烟火气”', interest: 0.1 }),
    item({ id: 2, feed: '溪石', title: '当普通人走到台前——新群众文艺的烟火气', abstract: '有摘要', interest: 0.2, read: true }),
    item({ id: 3, feed: '远川', title: '夜里的灯都成了黄色的' }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 2);
  assert.deepEqual(out[0].also, ['北城审美文化']);
  assert.equal(out[0].interest, 0.2);
  assert.equal(out[0].read, true);
});

test('model groups are checked: each item once, out-of-range and repeated numbers dropped, the rest under 其他', () => {
  const w = parseWritten('好的：```json\n{"overview":"总述","groups":[{"name":"甲","items":[1,2,9],"summary":"s"},{"name":"乙","items":[2]},{"name":"","items":[3]}]}\n```', 4);
  assert.equal(w.overview, '总述');
  assert.deepEqual(w.groups.map((g) => [g.name, g.items]), [['甲', [0, 1]], [OTHER_GROUP, [2, 3]]]);
});

test('weeks run Monday to Monday and fall due at 06:00 the Monday after', () => {
  const at = (s: string): number => Math.floor(new Date(s).getTime() / 1000);
  assert.equal(isoWeek(at('2026-10-19T12:00:00')), '2026-W43');
  assert.equal(isoWeek(at('2026-01-01T12:00:00')), '2026-W01');
  assert.equal(isoWeek(at('2027-01-01T12:00:00')), '2026-W53');
  const w = lastWeek(at('2026-10-22T09:00:00'));
  assert.deepEqual([w.period, w.from, w.to], ['2026-W42', at('2026-10-12T00:00:00'), at('2026-10-19T00:00:00')]);
  assert.equal(lastWeek(at('2026-10-19T05:00:00')).period, '2026-W41');
  assert.equal(lastWeek(at('2026-10-19T06:30:00')).period, '2026-W42');
});

test('reposts are all grouped; of journal listings only those close to the reader, the rest folded per journal', () => {
  const s = splitPapers([
    item({ id: 1, via: 'repost', interest: 0 }),
    item({ id: 2, via: 'journal', feed: '文史哲', interest: 0.2 }),
    item({ id: 3, via: 'journal', feed: '文史哲', interest: 0.01 }),
    item({ id: 4, via: 'journal', feed: '哲学研究', interest: 0 }),
  ]);
  assert.deepEqual(s.grouped.map((x) => x.id), [1, 2]);
  assert.deepEqual(s.journals.map((j) => [j.feed, j.items.map((x) => x.id)]), [['文史哲', [3]], ['哲学研究', [4]]]);
});

test('Zotero: a matching title is in the library; once Zotero stops answering, the rest are unknown', async () => {
  let calls = 0;
  const fake = (async (url: string) => {
    calls++;
    if (calls === 3) throw new Error('ECONNREFUSED');
    const q = decodeURIComponent(new URL(url).searchParams.get('q')!);
    return new Response(JSON.stringify(q === '当普通人走到台前' ? [{ data: { title: '当普通人走到台前：新群众文艺的“烟火气”' } }] : []));
  }) as typeof fetch;
  const r = await checkZotero(['当普通人走到台前：新群众文艺的“烟火气”', '夜里的灯都成了黄色的', '第三篇论文题目', '第四篇论文题目'], fake);
  assert.deepEqual(r, [true, false, null, null]);
  assert.equal(calls, 3);
});

test('the note links each paper to its original and to Lumen, and escapes brackets in titles', () => {
  const p = item({ id: 7, title: '论[括号]问题', link: 'https://x/1', authors: '某某', venue: '《读书》2026年第10期', abstract: '一句话。', feed: '溪石', also: ['远川'] });
  const r: PapersReport = { kind: 'papers', period: '2026-W42', from: 0, to: 86400 * 7, overview: '本周总述',
    picks: [p], groups: [{ name: '议题甲', summary: '组导语', items: [p] }], journals: [{ feed: '文史哲', items: [item({ id: 8, title: '刊内文' })] }],
    total: 2, zotero: { 7: true } };
  const md = renderPapers(r, 8780);
  assert.match(md, /^---\ntags: \[Lumen报告, 论文周报\]\nrange: /);
  assert.ok(!md.includes('W42'));
  assert.ok(md.includes('**[论\\[括号\\]问题](https://x/1)**　某某｜《读书》2026年第10期〔溪石；另见：远川〕 · [Lumen](http://127.0.0.1:8780/#entry=7) · Zotero 已在库'));
  assert.ok(md.includes('- ★ **[论'));
  assert.ok(md.includes('> [!note]- 文史哲（1）'));
  assert.ok(md.includes('### 议题甲（1）\n\n组导语'));
});

test('straight quotes the model puts around Chinese terms inside JSON strings are repaired', () => {
  const raw = '{"overview":"本周讨论"新大众文艺"。","groups":[{"name":"文艺","items":[1],"summary":"苏禾以"驻村文学"讨论，另谈"AI"艺术"}]}';
  const w = parseWritten(raw, 1);
  assert.equal(w.overview, '本周讨论“新大众文艺”。');
  assert.equal(w.groups[0].summary, '苏禾以“驻村文学”讨论，另谈“AI”艺术');
});

test('notes name the dates, not the week number', () => {
  const at = (s: string): number => Math.floor(new Date(s).getTime() / 1000);
  assert.equal(rangeLabel(at('2026-10-12T00:00:00'), at('2026-10-19T00:00:00')), '2026年10月12日—18日');
  assert.equal(rangeLabel(at('2026-10-26T00:00:00'), at('2026-11-02T00:00:00')), '2026年10月26日—11月1日');
  assert.equal(rangeLabel(at('2026-10-21T00:00:00'), at('2026-10-22T00:00:00')), '2026年10月21日');
  assert.equal(rangeLabel(at('2026-12-28T00:00:00'), at('2027-01-04T00:00:00')), '2026年12月28日—2027年1月3日');
  assert.equal(rangeSlug(at('2026-10-12T00:00:00'), at('2026-10-19T00:00:00')), '2026.10.12–18');
  assert.equal(rangeSlug(at('2026-10-26T00:00:00'), at('2026-11-02T00:00:00')), '2026.10.26–11.01');
  assert.equal(rangeSlug(at('2026-10-21T00:00:00'), at('2026-10-22T00:00:00')), '2026.10.21');
  assert.equal(rangeSlug(at('2026-12-28T00:00:00'), at('2027-01-04T00:00:00')), '2026.12.28–2027.01.03');
});

test('authors and venue are found in the text when the headline has none', () => {
  const refs = '参考文献 [1] 陈立.年度工作报告[J].《松溪学刊》2026年第3期。'.repeat(150);
  const p = detectPaper(input({ title: '从“技能断层”到“意义危机”', feedTitle: '松溪青年研究',
    html: `<p>原创 柳原 2026-10-16 08:00 北京</p><p>本文作者柳 原摘要：青年就业问题。关键词：青年</p><p>${refs}</p><p>本文原载《松溪青年研究》2026年第10期，第101-110页</p>` }));
  assert.equal(p?.authors, '柳原');
  assert.equal(p?.venue, '《松溪青年研究》2026年第10期');
  // The account's own name as byline is not an author; an author line in the text still is.
  assert.equal(authorsInText('溪石 2026-10-12 10:38 北京 正文', '溪石'), '');
  assert.equal(authorsInText('原创 编辑部 2026-10-12 作者：程远山、柯宁（北城大学）', 'x'), '程远山、柯宁');
  assert.equal(authorsInText('经作者授权后推送', 'x'), '');
});

test('a bare 作者 in running prose is not an author line', () => {
  assert.equal(authorsInText('松溪纵横 2026-10-12 正文里作者指出，服务业……', '松溪纵横'), '');
});

test('本文作者指出 is prose; the byline names the author instead', () => {
  assert.equal(authorsInText('江屿 2026-10-15 15:58 北京 导读 本文作者指出，随着服务业……', '松溪纵横'), '江屿');
});

test('a note after the journal name does not hide the issue; stray spaces leave the title', () => {
  const p = detectPaper(input({ title: '学术论文｜程远山、柯宁：当代先锋小说中的“戏仿”因素 及其生成机制', feedTitle: '北城文学研究院',
    html: '<p>编者按 程远山教授与柯宁所撰《当代先锋小说中的“戏仿”因素及其生成机制》刊载于《松溪文艺》（CSSCI来源期刊）2026年第5期，系国家社科基金项目成果。</p>' }));
  assert.equal(p?.authors, '程远山、柯宁');
  assert.equal(p?.title, '当代先锋小说中的“戏仿”因素及其生成机制');
  assert.equal(p?.venue, '《松溪文艺》2026年第5期');
});

test('a 辑刊 volume counts as the issue', () => {
  const p = detectPaper(input({ title: '顾明川 | 扎根生活，走向远方——评禾禾《松溪茶事》', feedTitle: '旧港网文研究',
    html: '<p>顾明川原文发表于《网文研究集刊》第十辑【摘要】《松溪茶事》聚焦青年群体。【关键词】网络文学</p>' }));
  assert.equal(p?.venue, '《网文研究集刊》第十辑');
});

test('内容提要, 载于, 来源于 and issues written as 秋季刊 / 10月刊 / 第N卷 are recognised', () => {
  const a = detectPaper(input({ title: '许南岸｜人工智能与人文的自觉', feedTitle: '青螺Spirals',
    html: '<p>以下文章来源于《北城论坛》，作者许南岸。内容提要：人工智能技术对学术研究的冲击已经到来。关键词：人工智能 文科</p>' }));
  assert.equal(a?.venue, '《北城论坛》');
  assert.match(a?.abstract ?? '', /^人工智能技术/);
  const b = detectPaper(input({ title: '沈子川 | 一位理论家的“暗房”', feedTitle: '溪石', html: '<p>原载于《旧港学刊》2026年秋季刊</p>' }));
  assert.equal(b?.venue, '《旧港学刊》2026年秋季刊');
  const c = detectPaper(input({ title: '韩述 | “边界冲击”', feedTitle: 'x', html: '<p>全文载于《域外理论评述》2021年第6期</p>' }));
  assert.equal(c?.venue, '《域外理论评述》2021年第6期');
  const d = detectPaper(input({ title: '新人可以喝咖啡吗？', feedTitle: 'x',
    html: '<p>来源：《北方史期刊》（Northern History Review）第35卷</p><p>参考文献 [1] ……</p>' }));
  assert.equal(d?.venue, '《北方史期刊》第35卷');
  // A numbered issue with no year, no 辑 and no notes is a magazine, not a paper.
  assert.equal(detectPaper(input({ title: '如何练习观看 | 安德烈·莫尔', feedTitle: '光影札记', html: '<p>原载于《Lightbox》第 264 期</p>' })), null);
});

test('an occasion and a dash in front of the title name the author', () => {
  assert.deepEqual(splitHeading('松溪书院建院九十周年纪念丨穆言川——全球市场与自我否定的政治逻辑'), { authors: '穆言川', title: '全球市场与自我否定的政治逻辑' });
  // A dash inside an ordinary title is left alone.
  assert.equal(splitHeading('扎根生活，走向远方——评禾禾《松溪茶事》').authors, '');
});

test('key accounts: literary works are left out, a journal account names itself, long annotated posts count', () => {
  const long = '正文。'.repeat(2500);
  // 旧港文学 posts poems with 原载于《旧港文学》: no abstract, no notes, not a paper.
  assert.equal(detectPaper(input({ title: '诗歌回响 | 卡•维恩【美国】：卡·维恩诗选', feedTitle: '旧港文学OldHarbor',
    html: '<p>原载于《旧港文学》2011年第1期</p>' })), null);
  const j = detectPaper(input({ title: '林荞 | 苏禾散文中的边地书写', feedTitle: '远方文学评论', html: '<p>摘要：边地书写。关键词：苏禾</p>' }));
  assert.equal(j?.venue, '《远方文学评论》');
  const t = detectPaper(input({ title: '格雷戈・沃尔曼｜奥斯卡・兰德，网络的织者（1999）', feedTitle: '行走的读书人',
    html: `<p>${long}</p><p>${long}发表于学术期刊『Signal Compass』第20卷第3期</p><p>注释 [1] ……</p>` }));
  assert.equal(t?.authors, '格雷戈・沃尔曼');
  assert.equal(t?.venue, '《Signal Compass》第20卷第3期');
  // The same long post from an account not on the list is not taken on length alone.
  assert.equal(detectPaper(input({ title: '格雷戈・沃尔曼｜奥斯卡・兰德', feedTitle: '某号', html: `<p>${long}${long}</p><p>注释 [1]</p>` })), null);
});

test('a translation cited as its source, a translator after the author, a label run into the abstract', () => {
  const p = detectPaper(input({ title: '编译｜成为耐心者的重要性', feedTitle: '长夜批判社',
    html: '<p>作者：齐格弗里·鲍姆译者：青叶 来源：Baumer, K. (1987). "The Importance of Being Patient." 正文</p>' }));
  assert.equal(p?.authors, '齐格弗里·鲍姆');
  assert.match(p?.venue ?? '', /^Baumer, K\. \(1987\)\. "The Importance of Being Patient\."/);
  const a = detectPaper(input({ title: '韦临｜抒情传统研究海外谱系中的语言论美学', feedTitle: 'x',
    html: '<p>韦临，教授，文学博士。摘要要了解百年来海外学者的古典美学研究，须先看抒情传统一脉。关键词：抒情传统</p><p>原载于《松溪文论》2026年第3期</p>' }));
  assert.match(a?.abstract ?? '', /^要了解百年来/);
});

test('a translation with no journal shows its original title', () => {
  const long = '正文。'.repeat(2500);
  const p = detectPaper(input({ title: '约翰・罗森｜沉默抗议的正当性（1969）', feedTitle: '行走的读书人',
    html: `<p>本文作者为 John・Rosen 。原文『The Justification of Quiet Protest』最初收入一部文集。</p><p>${long}${long}</p><p>注释 [1]</p>` }));
  assert.equal(p?.venue, '原文『The Justification of Quiet Protest』');
});

test('names with initials or Latin letters between dots, and authors joined by &', () => {
  assert.equal(splitHeading('达林・P・霍尔特｜反思田野人类学（2004）').authors, '达林・P・霍尔特');
  assert.equal(splitHeading('Miriam・N.・Hollar｜把怯懦置于诸恶之首（1982）').authors, 'Miriam・N.・Hollar');
  assert.equal(splitHeading('罗晚晴&尤川｜难以捉摸的天意（2023）').authors, '罗晚晴、尤川');
  // A plain English phrase has no dot and is not a name.
  assert.equal(splitHeading('Poetry, History｜Memory').authors, '');
});

test('a repost naming its source as 原文出处 or only in a GB/T reference still gets its venue', () => {
  const body = '<p>作者 / 程墨川 内容提要：“影像哲学”作为一种新的当代哲学转向在近年来重新受到重视。关键词：影像</p><p>正文……</p>';
  const a = detectPaper(input({ title: '程墨川｜“影像哲学”中的“非表征主义”语法', html: `${body}<p>原文出处： 《域外美学》第43辑，松溪教育出版社 2025</p>` }));
  assert.equal(a?.venue, '《域外美学》第43辑');
  const b = detectPaper(input({ title: '程墨川｜“影像哲学”中的“非表征主义”语法', html: `${body}<p>引用格式： 程墨川. “影像哲学”中的“非表征主义”语法[J].域外美学,2025,(2):52-66.</p>` }));
  assert.equal(b?.venue, '《域外美学》2025年第2期');
});

test('a repost with no 摘要 takes its AI summary\'s opening, marked as AI; one with an abstract keeps its own', () => {
  const html = '<p>编者按 本文依托一位理论家晚年的政论遗稿。</p><p>本文原载于《旧港学刊》2026年秋季刊。</p><p>正文很长……</p>';
  const p = detectPaper(input({ title: '沈子川｜一位理论家的“暗房”', html, summary: '<p>文章重审这位理论家的核心政治思想。其后又谈到一个老难题。</p>' }));
  assert.equal(p?.venue, '《旧港学刊》2026年秋季刊');
  assert.equal(p?.abstractBy, 'ai');
  assert.match(p!.abstract, /^文章重审这位理论家/);
  const own = detectPaper(input({ title: '林望舟｜题名', html: '<p>摘要：这是作者自己的摘要，说明了论文的主要观点和方法。关键词：甲</p>', summary: '<p>AI 的话。</p>' }));
  assert.equal(own?.abstractBy, undefined);
  assert.match(own!.abstract, /^这是作者自己的摘要/);
});
