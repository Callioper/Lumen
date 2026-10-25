// 期刊目录 and 学术动态 of the demo library (scripts/demo/seed.ts): what the AI would have read out of
// the demo journals' posts, so the demo never asks it. Every journal, person and event is made up.
import type { ReprintIssue } from '../../server/content/reprints.ts';

const ahead = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

type Article = { title: string; subtitle?: string; authors: string[]; translators?: string[]; page: string; abstract?: string; keywords?: string[] };
const art = (a: Article): Record<string, unknown> => ({ subtitle: '', translators: [], abstract: '', keywords: [], ...a });
const toc = (journal: string, issue: string, sections: [name: string, articles: Article[]][]): Record<string, unknown> =>
  ({ journal, issue, sections: sections.map(([name, articles]) => ({ name, articles: articles.map(art) })) });

// [feed, post title, days ago, what was read].
export const DEMO_TOCS: [feed: string, title: string, age: number, toc: Record<string, unknown>][] = [
  ['jlt', '《文艺理论动态》2026年第5期目录、摘要', 2, toc('文艺理论动态', '2026年第5期', [
    ['媒介与文学', [
      { title: '屏幕之后的阅读', subtitle: '数字界面中的注意力与文本', authors: ['林远'], page: '4',
        abstract: '本文讨论屏幕阅读如何改写注意力的分配方式，并以三种界面设计为例，说明文本在可滚动的页面中如何被重新编排。', keywords: ['屏幕阅读', '注意力', '界面'] },
      { title: '算法推荐与文学趣味的形成', authors: ['周未', '沈禾'], page: '18',
        abstract: '以三家阅读平台的榜单为材料，考察推荐算法怎样参与塑造「好看」的标准，以及读者如何在榜单之外寻找书。', keywords: ['算法', '文学趣味', '平台'] },
    ]],
    ['理论译介', [
      { title: '论中介', authors: ['〔德国〕卡尔·韦伯'], translators: ['陈默'], page: '32' },
      { title: '后人类叙事的三个问题', authors: ['许青'], page: '47', abstract: '后人类叙事常被当作题材，本文把它当作形式问题：谁在叙述，向谁叙述，叙述在哪里结束。' },
    ]],
    ['书评', [{ title: '评《分布的心》', authors: ['唐槐'], page: '61' }]],
  ])],
  ['jmc', '《媒介与文明》2026年第3期目录', 9, toc('媒介与文明', '2026年第3期', [
    ['', [
      { title: '档案、平台与记忆', authors: ['韩栎'], page: '1' },
      { title: '技术物的时间性', subtitle: '一个现象学的考察', authors: ['唐槐'], page: '15' },
      { title: '声音景观研究的方法', authors: ['罗川'], page: '29' },
      { title: '幻灯片里的城市', subtitle: '二十世纪初的公共放映与市民观看', authors: ['沈知远'], page: '43' },
    ]],
  ])],
  ['jcl', '比较文学通讯 | 2026年秋季号目录', 5, toc('比较文学通讯', '2026年秋季号', [
    ['专题：译名的旅行', [
      { title: '一个概念的五种译法', subtitle: '以「媒介」为例', authors: ['韩素'], page: '3', abstract: '梳理一个理论概念在四十年里的五种中文译法，说明译名的更替如何记录了理解的变化。', keywords: ['译名', '概念史'] },
      { title: '重译的伦理', authors: ['周以宁'], page: '21' },
    ]],
    ['比较诗学', [
      { title: '山水与风景', subtitle: '两种观看传统的相遇', authors: ['江枫', '白露'], page: '38' },
      { title: '日常科幻的中文谱系', authors: ['林舟'], page: '55' },
    ]],
  ])],
  ['jcl', '比较文学通讯 | 2026年夏季号目录', 38, toc('比较文学通讯', '2026年夏季号', [
    ['', [
      { title: '世界文学的边缘', authors: ['许岚'], page: '3' },
      { title: '翻译作为接触区', authors: ['陈默'], page: '19' },
      { title: '城市书写与地方感', authors: ['何晴'], page: '34' },
    ]],
  ])],
];

// 人大复印报刊资料: its 全文转载 contents as read from the post's pictures (server/content/reprints.ts).
// They mark what they reprint: 「屏幕之后的阅读」 in 期刊目录 and the 论文周报, the review and the author
// in 新书.
export const DEMO_REPRINTS: [feed: string, title: string, age: number, issues: ReprintIssue[]][] = [
  ['rdfy', '复印报刊资料最新目录｜文艺理论、文化研究 2026年第10期', 1, [
    { name: '文艺理论', code: 'J1', issue: '2026年第10期', sections: [
      { name: '文艺学前沿', articles: [
        { title: '屏幕之后的阅读', subtitle: '数字界面中的注意力与文本', authors: ['林远'], page: '3', source: '《文艺理论动态》2026年第5期', abstract: '' },
        { title: '在城市的河道边阅读风景', subtitle: '', authors: ['江枫'], page: '15', source: '《生态与人文》2026年第4期', abstract: '' },
      ] },
      { name: '书评', articles: [
        { title: '时间的切片', subtitle: '评何晴《奔跑的时间》', authors: ['罗川'], page: '40', source: '《读书与评论》2026年第9期', abstract: '' },
      ] },
    ] },
    { name: '文化研究', code: 'G0', issue: '2026年第10期', sections: [
      { name: '', articles: [
        { title: '档案、平台与记忆', subtitle: '', authors: ['韩栎'], page: '5', source: '《媒介与文明》2026年第3期', abstract: '' },
        { title: '早期幻灯放映与公共观看的形成', subtitle: '', authors: ['沈知远'], page: '12', source: '《媒介与文明》2026年第2期', abstract: '' },
        { title: '社区书房的二十年', subtitle: '', authors: ['许岚'], page: '18', source: '《城市与社会》2026年第2期', abstract: '' },
      ] },
    ] },
  ]],
];

// A journal subscribed through CNKI's RSS: its articles come one by one and are put together into issues.
// [title, authors, abstract, days ago]: two issues two months apart, so the issue number is worked out.
export const DEMO_CNKI: [title: string, authors: string, abstract: string, age: number][] = [
  ['叙事中的机器视角', '林舟;白露', '从三部近作出发，讨论以机器为叙述者的小说如何安排视角与可靠性。', 3],
  ['不可靠叙述的再定义', '周未', '在认知叙事学的框架里重新界定不可靠叙述，区分事实、价值与知识三个层面。', 3],
  ['口述史文本的叙事结构', '许岚', '以一座城市的口述史项目为材料，分析讲述者如何组织「从前」与「后来」。', 3],
  ['游戏叙事与选择的幻觉', '唐槐', '<正>电子游戏常以「选择」吸引玩家，可大多数分支最后汇入同一个结局……', 3],
  ['叙事学的媒介转向', '韩栎', '回顾近二十年叙事学向电影、游戏与网络文本扩展的过程。', 63],
  ['时间的叙事与气候', '江枫', '气候小说如何处理人的时间与地质时间之间的落差。', 63],
  ['档案小说的形式', '陈默', '讨论以档案、信件、表格组织起来的小说，及其对「真实」的承诺。', 63],
];

// What the posts say, beyond the title, where it matters: the live room is read from it (liveaccess.ts).
type Item = Record<string, unknown>;
const ev = (o: Item): Item => ({ end: '', deadline: '', place: '', organizer: '', speakers: [], contact: '', summary: '', online: '', live: '', date: '', ...o });

// [feed, post title, days ago, what was read, post text]. Some events are posted by two or three
// accounts and show once; the past ones show under 「已结束」, one with its recording found on B站.
export const DEMO_NOTICES: [feed: string, title: string, age: number, items: Item[], text?: string][] = [
  ['essay', '会议通知 | “媒介与文明”青年学者工作坊（一号通知）', 6, [ev({ kind: '会议', name: '“媒介与文明”青年学者工作坊', date: ahead(40), end: ahead(41), deadline: ahead(2),
    place: '松溪大学人文楼', organizer: '松溪大学文学院', contact: 'workshop@demo.lumen.invalid', summary: '征集媒介史、技术哲学与文学研究交叉方向的论文摘要。' })]],
  ['jlt', '征稿启事 | 《文艺理论动态》常年征稿', 12, [ev({ kind: '征稿', name: '《文艺理论动态》', organizer: '编辑部', contact: 'submit@demo.lumen.invalid',
    summary: '常年接收文艺理论、比较诗学与文化研究方向的来稿。' })]],
  ['essay', '讲座预告 | 档案中的声音', 1, [ev({ kind: '讲座', name: '档案中的声音', date: ahead(3), place: '线上', organizer: '思想札记', speakers: ['罗川'],
    summary: '从录音档案谈声音研究的方法与材料。', online: '线上', live: '腾讯会议 000 000 000 密码 2026' })],
    '讲座将在腾讯会议举行，会议号：000 000 000，密码：2026。'],
  // One talk, three accounts: shown once, 「3 篇推文」.
  ['talks', '远川讲座第12讲 | 机器如何读小说', 4, [ev({ kind: '讲座', name: '机器如何读小说', date: ahead(7), place: '松溪大学图书馆报告厅', organizer: '松溪人文讲坛',
    speakers: ['周未', '林远'], summary: '从计算批评的实践谈机器阅读能看见什么、看不见什么。', online: '线上线下', live: '远川B站、松溪人文B站' })],
    '同步直播：远川B站直播间，松溪人文B站。'],
  ['essay', '转发 | 远川讲座：机器如何读小说', 3, [ev({ kind: '讲座', name: '机器如何读小说（远川讲座第12讲）', date: ahead(7), place: '松溪大学图书馆报告厅',
    organizer: '松溪人文讲坛', speakers: ['周未', '林远'], summary: '计算批评与机器阅读。', online: '线上线下', live: 'B站 远川' })]],
  ['press', '下周三的讲座，欢迎来听：机器如何读小说', 2, [ev({ kind: '讲座', name: '机器如何读小说', date: ahead(7), place: '松溪大学图书馆',
    organizer: '松溪人文讲坛', speakers: ['周未', '林远'], summary: '计算批评的讲座。' })]],
  // On now: started yesterday, ends tomorrow.
  ['jmc', '会议议程 | 数字人文与文学研究国际研讨会', 5, [ev({ kind: '会议', name: '数字人文与文学研究国际研讨会', date: ahead(-1), end: ahead(1), place: '松溪大学国际会议中心',
    organizer: '松溪大学数字人文中心', summary: '三天十二场分组讨论，主题为文本挖掘、数字档案与文学史重写。', online: '线上线下', live: '松溪数字人文B站' })],
    '开幕式与主旨发言同步直播。'],
  // A conference's first and second notices, shown as one.
  ['jmc', '第五届媒介考古学论坛（一号通知）', 30, [ev({ kind: '会议', name: '第五届媒介考古学论坛', date: ahead(52), end: ahead(53), deadline: ahead(14),
    place: '东江大学', organizer: '东江大学新闻学院', contact: 'mediaarch@demo.lumen.invalid', summary: '征集媒介考古、技术史与视觉文化方向的论文。' })]],
  ['jmc', '第五届媒介考古学论坛（二号通知）', 3, [ev({ kind: '会议', name: '第五届媒介考古学论坛', date: ahead(52), end: ahead(53), deadline: ahead(14),
    place: '东江大学逸夫楼', organizer: '东江大学新闻学院', contact: 'mediaarch@demo.lumen.invalid', summary: '公布议程与住宿安排，摘要截止日期不变。' })]],
  ['talks', '招聘 | 松溪大学文学院2027年博士后招聘', 8, [ev({ kind: '招聘', name: '松溪大学文学院2027年博士后招聘', deadline: ahead(20), organizer: '松溪大学文学院',
    contact: 'hr@demo.lumen.invalid', summary: '招收文艺学、比较文学与媒介研究方向博士后各一至二名。' })]],
  ['news', '关于开展2027年度青年社科项目申报的通知', 6, [ev({ kind: '申报', name: '2027年度青年社科项目', deadline: ahead(12), organizer: '北城社科联',
    summary: '面向四十岁以下青年学者，重点支持城市文化与数字社会研究。' })]],
  ['photo', '征集 | 城市口述史影像', 9, [ev({ kind: '征集', name: '城市口述史影像征集', deadline: ahead(30), organizer: '城市影像',
    summary: '征集老居民讲述街区变迁的影像，入选作品将在社区书房展出。' })]],
  ['press', '新书分享会 | 《河流的档案》：沿着一条河读城市', 2, [ev({ kind: '活动', name: '《河流的档案》新书分享会', date: ahead(4), place: '半山书房（河口店）',
    organizer: '鹿鸣书局', speakers: ['江枫', '许岚'], summary: '作者与口述史研究者对谈，谈地图、档案与岸边的芦苇。' })]],
  ['jcl', '征稿 | 集刊《城市与记忆》第三辑', 15, [ev({ kind: '征稿', name: '《城市与记忆》', deadline: ahead(60), organizer: '松溪大学城市文化研究中心',
    contact: 'memory@demo.lumen.invalid', summary: '第三辑主题为「河流与城市」，接收论文、田野札记与书评。' })]],
  ['talks', '讲座预告 | 后人类叙事的三个问题', 1, [ev({ kind: '讲座', name: '后人类叙事的三个问题', date: ahead(10), place: '松溪大学人文楼 204', organizer: '松溪人文讲坛',
    speakers: ['许青'], summary: '谁在叙述，向谁叙述，叙述在哪里结束。' })]],
  // Over: one with its recording found on B站 days later, one without.
  ['talks', '讲座预告 | 城市声音的考古', 12, [ev({ kind: '讲座', name: '城市声音的考古', date: ahead(-6), place: '松溪大学图书馆报告厅', organizer: '松溪人文讲坛',
    speakers: ['罗川'], summary: '从老唱片与街头录音谈一座城市的声音史。' })]],
  ['essay', '讲座预告 | 译名的历史', 10, [ev({ kind: '讲座', name: '译名的历史', date: ahead(-3), place: '线上', organizer: '思想札记',
    speakers: ['韩素'], summary: '一个理论概念在中文世界的旅行。', online: '线上', live: '腾讯会议' })]],
];

// Recordings found on B站 after a talk, by its name: [bvid, video title, uploader, days after the talk, minutes].
export const DEMO_REPLAYS: Record<string, [bvid: string, title: string, author: string, after: number, minutes: number][]> = {
  城市声音的考古: [['BV1demo00001', '【讲座录像】罗川：城市声音的考古｜松溪人文讲坛', '松溪人文', 2, 108]],
};
