// 分章导览: seven chapters, each a few steps. A step goes to its page, waits for the thing it is about
// and frames it (tour.tsx draws the frame). Targets are the app's own classes and hover texts, so a
// step that no longer finds its target shows its text without a frame rather than pointing elsewhere.
import { batch } from '@preact/signals';
import { app, tab, items, open, select, setTab, setSortMode, settingsOpen, jobsOpen, query, subjectTrail, reloadList, markGroups, openMark } from '../store.ts';
import type { ListItem } from '../api.ts';
import { loadReports } from '../reports.ts';
import { labelsOn } from './labels.tsx';

export type Target = string | (() => Element | null);
export interface Step { title: string; text: string; go: () => Promise<void>; target: Target }
export interface Chapter { key: string; title: string; blurb: string; steps: Step[] }

const wait = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

// Whatever an earlier step left open is closed first.
function reset(): void {
  batch(() => { settingsOpen.value = null; jobsOpen.value = false; labelsOn.value = false; subjectTrail.value = []; });
  if (query.value) query.value = '';
  if (tab.value !== 'all') setTab('all');   // a 读文章 step may have left one layout picked
}

const go = (f: () => unknown) => async (): Promise<void> => { reset(); await f(); };
const page = (kind: 'books' | 'hot' | 'tocs' | 'notices' | 'marks' | 'social' | 'starred' | 'all') => go(() => select({ kind }));
// The reports page keeps the kind on screen when it is opened again: the kind is loaded by name.
const report = (k: 'daily' | 'weekly' | 'papers') => go(async () => { await select({ kind: 'reports' }); await loadReports(k); });
const settings = (tab: NonNullable<typeof settingsOpen.value>) => go(() => { settingsOpen.value = tab; });

// An entry by part of its title, opened beside its own feed's list.
const openTitled = (feed: string, title: string) => go(async () => {
  const f = app.value?.feeds.find((x) => x.title === feed);
  if (f) await select({ kind: 'feed', id: f.id });
  for (let i = 0; i < 20 && !items.value.length; i++) await wait(100);
  let it: ListItem | undefined = items.value.find((x) => x.title.includes(title));
  if (!it) {
    const r = await fetch(`/api/entries?q=${encodeURIComponent(title)}&sort=relevance&offset=0&limit=5`);
    it = ((await r.json()) as { items: ListItem[] }).items[0];
  }
  if (it) await open(it);
});

// A book's or a film's page: its card in 标记, opened.
const subjectPage = (subject: string) => go(async () => {
  await select({ kind: 'marks' });
  for (let i = 0; i < 30 && !markGroups.value.length; i++) await wait(100);
  const g = markGroups.value.find((x) => x.subject === subject);
  if (g) await openMark(g.key);
});

// The comments are fetched only when asked for: the step asks.
const openComments = async (): Promise<void> => {
  await openTitled('林间的豆瓣广播', '旧机器的回声')();
  for (let i = 0; i < 30; i++) {
    const b = document.querySelector<HTMLButtonElement>('.comments .btn');
    if (b) { b.click(); return; }
    await wait(100);
  }
};

const FEATURES: Chapter = {
  key: 'features', title: '三分钟看特色', blurb: 'Lumen 和别的 RSS 阅读器不一样的五处，加上外文翻译。',
  steps: [
    { title: '学术动态', go: page('notices'), target: '.notices-page .notice-when',
      text: '左边这一栏是倒计时：几天后截止、几天后举办、正在进行。所有条目都是 AI 从推文里读出来的，同一场讲座三个号都发了，这里只出现一次。' },
    { title: '新书按主题分组', go: page('books'), target: '.book-shelf-head',
      text: '每个月的书再按主题分组。分得不会太碎：一组至少 4 本，小主题并进所属的大类。右上角可以只看 Zotero 里还没有的书。' },
    { title: '人大复印的标记', go: page('tocs'), target: '.toc-reprint',
      text: '这篇被《复印报刊资料》全文转载了。复印的目录是图片，Lumen 先 OCR 再交给 AI 读，然后标回原刊的目录里。' },
    { title: '友邻的书影榜', go: page('hot'), target: '.hot-friends .hot-card',
      text: '豆瓣友邻近 30 天标记最多的书和电影，按人数和时间排；右边是豆瓣的公共榜单。' },
    { title: '日报里的「破茧」', go: report('daily'), target: '#rs-explore',
      text: '日报的最后一块，放的是你平常不点、但和你关心的东西有关的一篇，免得只看自己爱看的。' },
    { title: '外文默认翻译', go: openTitled('Open Science Notes', 'open peer review'), target: '.reader h1.title',
      text: '外文标题直接显示中文，原文放在旁边；正文可以在中英对照、只看译文、只看原文之间切换（电脑上按 t 键）。' },
  ],
};

const READING: Chapter = {
  key: 'reading', title: '读文章', blurb: '显示方式、排序与推荐、阅读器上的每一排按钮、搜索和快捷键。',
  steps: [
    { title: '五种显示方式', go: go(() => { setTab('all'); return select({ kind: 'all' }); }), target: '.views',
      text: '列表、大卡片、瀑布流、标题流、简报。每个源有自己默认的方式（图片源是瀑布流，资讯源是标题流），点这里只看用某种方式的源；单个源也能在列表右上角改。' },
    { title: '简报', go: go(() => setTab('digest')), target: '.list-scroll',
      text: '同一个源一天的文章合成一块，标题折叠；长一点的块由 AI 写一句概括。适合一天几十条的资讯源。' },
    { title: '未读、推荐与理由', go: go(async () => { setTab('list'); await wait(300); setSortMode('rec'); }), target: '.list-tools',
      text: '「未读 / 全部」决定列表里有没有读过的；「推荐」按你的阅读偏好排，兼顾新鲜和多样，每篇旁边写着为什么推它。对勾把未读全部标为已读（Shift+A）。' },
    { title: '阅读器的工具栏', go: openTitled('慢读播客', '和骑手一起跑'), target: '.reader-bar',
      text: '从左到右：喜欢（l）、少推这类或这个源（x / X）、收藏（f）、已读（r）、把上面的都标为已读（Shift+K）、抓取全文（v）、存档到 Obsidian（c）、分享图（p）、衬线字体、打开原文。' },
    { title: 'AI 摘要', go: openTitled('慢读播客', '和骑手一起跑'), target: '.ai-card',
      text: '有 AI 密钥时，新文章入库就写好摘要；这篇还没有，点「生成摘要」会现写一份（演示里给的是示例）。' },
    { title: '相关文章', go: openTitled('慢读播客', '和骑手一起跑'), target: '.related',
      text: '按语义找出的相近文章，不靠关键词：同一件事的不同报道、不同源讲同一个话题的，都会排在这里。' },
    { title: '友邻标记', go: openTitled('书讯周刊', '本周新书书单'), target: '.friends',
      text: '文章里提到的书，你的豆瓣友邻标过的话，这里列出谁想读、谁读过、说了什么。上面是从书单里拆出来的书，标着 Zotero 里有没有。' },
    { title: '评论区', go: openComments, target: '.comments',
      text: '豆瓣、少数派的文章，原页面下的评论点「展开评论」就在这里看；取过的一天内不再请求，「刷新」再取一次。' },
    { title: '搜索与「意思相近」', go: go(async () => { await select({ kind: 'all' }); query.value = '骑手'; await reloadList(); }), target: '[aria-label="搜索结果排序"]',
      text: '按 / 开始搜索。结果能按相关或最新排，也能换成「意思相近」：按语义找，词不必出现在文中。' },
    { title: '按钮说明和快捷键', go: go(async () => { await select({ kind: 'all' }); labelsOn.value = true; }), target: '.demo-keys',
      text: '任何一页按 ?，每个按钮旁边会浮出它的作用，这张快捷键表也一起打开。常用的是 j / k 上下篇、空格打开原文、t 翻译。' },
  ],
};

const SUMMARIES: Chapter = {
  key: 'summaries', title: '总结与画像', blurb: '日报、周报、论文周报，AI 标签，以及推荐是根据什么来的。',
  steps: [
    { title: '日报', go: report('daily'), target: '.report-toc',
      text: 'AI 每天从进来的文章里挑出值得看的，分组写导语。左边是目录，点一篇在右边读，j / k 按目录往下走。' },
    { title: '破茧', go: report('daily'), target: '#rs-explore',
      text: '最后一块放你平常不点、但和你关心的东西有关的一篇。' },
    { title: '周报', go: report('weekly'), target: '.week-stats',
      text: '一周的日报汇成几条主线；底下是这一周读完、略读、收藏的数目，和书影榜新上榜的书。' },
    { title: '论文周报', go: report('papers'), target: '.paper-cnki',
      text: '新论文按议题分组，挑出值得精读的；每篇标出 Zotero 是否已在库、是否被人大复印转载，这个按钮去知网按篇名检索。' },
    { title: 'AI 标签', go: page('all'), target: '.tag-cloud',
      text: 'AI 只从你给的候选词里挑标签，每篇零到两个。点一个就只看这一类。' },
    { title: '阅读画像', go: settings('profile'), target: '.cluster-list',
      text: '推荐靠的是明确信号：喜欢、少推、收藏、存档、读完。兴趣簇由 AI 起名，可以改名，也可以隐藏，隐藏后不再拿它加分。' },
  ],
};

const ACADEMIC: Chapter = {
  key: 'academic', title: '学术', blurb: '期刊目录和学术动态的每个开关。',
  steps: [
    { title: '目录从哪里来', go: page('tocs'), target: '.tocs-head .seg',
      text: '公众号推的目录、知网 RSS 拼成的整期、人大复印的目录图，分三路，可以只看一路。' },
    { title: '按类别、按刊名', go: page('tocs'), target: '.toc-groups',
      text: '刊物按你分的类排；点类别只看这一类，点刊名只看这一种刊。' },
    { title: '知网检索', go: page('tocs'), target: '.toc-cnki',
      text: '篇名旁这个按钮去知网按篇名检索，刊名旁的按刊名检索；带摘要的篇目可以就地展开摘要。' },
    { title: '按类型看动态', go: page('notices'), target: '.notices-page .book-topics',
      text: '会议、征稿、讲座、招聘、申报、征集，点一类只看这一类。' },
    { title: '能线上看的、已经过去的', go: page('notices'), target: '.notices-page .tocs-head',
      text: '「可线上看」只留有直播或线上举办、还没开始的；「含已过」把散场的也列出来，有录像的会标出来。' },
    { title: '展开一条', go: page('notices'), target: '.notice',
      text: '点一条展开时间、地点、主办方和报名方式；回到原推文的链接也在里面。' },
  ],
};

const BOOKS: Chapter = {
  key: 'books', title: '书与影', blurb: '新书页的排法和筛选，书页和影片页。',
  steps: [
    { title: '按书单还是按出版时间', go: page('books'), target: '.list-tools .seg',
      text: '「按书单」按推文先后排，「按出版时间」把所有书按出版月份排；右边能换成卡片，看得到简介。' },
    { title: '类型和主题', go: page('books'), target: '.book-kinds',
      text: '虚构、非虚构、学术三类，下面一行是主题；点一个只看这一类。' },
    { title: '几份书单都推荐的', go: page('books'), target: '.book-cover-posts',
      text: '同一本书出现在几份书单里，封面上标出份数，越多越值得留意。' },
    { title: 'Zotero 里已经有的', go: page('books'), target: '.book-owned',
      text: '已在库的书标出来；右上角「只看未在库」只留还没收的。' },
    { title: '书页', go: subjectPage('9000000'), target: '.bookpage',
      text: '友邻怎么说、内容简介、目录、豆瓣短评、喜欢读的人也喜欢、其他版本。点相近的书可以一路看下去，Esc 一层层退回。' },
    { title: '影片页', go: subjectPage('9000039'), target: '.moviepage',
      text: '导演和演员、剧情简介、短评、喜欢看的人也喜欢。「想看」在公开版里记在 Lumen 里。' },
  ],
};

const FRIENDS: Chapter = {
  key: 'friends', title: '友邻', blurb: '动态、标记和书影榜。',
  steps: [
    { title: '动态', go: page('social'), target: '.post',
      text: '豆瓣、微博这类以人为主的源排成时间线，图文一起显示。' },
    { title: '标记按书、影、音分开', go: page('marks'), target: '.mark-kinds',
      text: '友邻的想读、在读、看过，按书、影、音分开，带未读数；同一本书的几条并成一张卡。' },
    { title: '标记总览', go: page('marks'), target: '.overview',
      text: '右边是近 30 天的总览：正在读的、好几个人想要的。单击卡片展开，双击进书页，h 回到这里。' },
    { title: '书影榜对照公共榜', go: page('hot'), target: '.hot-lists',
      text: '右边是豆瓣的公共榜单；友邻也在看的书标着「友邻也在看」。' },
  ],
};

const MANAGE: Chapter = {
  key: 'manage', title: '管理订阅', blurb: '添加订阅、源的设置、AI、存档、数据接口、外观配色和任务进度。',
  steps: [
    { title: '添加订阅', go: settings('add'), target: '.add-form',
      text: '粘贴 RSS 地址、网站首页，或公众号文章、豆瓣主页、B 站空间、知网期刊页的链接，Lumen 认出是哪类源并换成订阅地址。' },
    { title: '订阅源', go: settings('feeds'), target: '.modal .tab-body',
      text: '每个源的分类、显示方式、要不要 AI 摘要、暂停，都在这里改；出错的源可以单独筛出来。' },
    { title: 'AI', go: settings('ai'), target: '.modal .tab-body',
      text: '任何 OpenAI 兼容的接口都能用；摘要、标签、外文翻译、语义检索各自开关。密钥只存在本机。' },
    { title: '存档到 Obsidian', go: settings('clip'), target: '.modal .tab-body',
      text: '库的位置、文件路径和笔记模板（与 Recall for Obsidian 同一套语法）；AI 可以顺手填好著录信息。' },
    { title: '数据与接口', go: settings('data'), target: '.modal .tab-body',
      text: 'OPML 导入导出；Google Reader 接口让手机上的 RSS 客户端连过来同步已读。' },
    { title: '外观', go: settings('look'), target: '.palettes',
      text: '七套配色，各有浅色和深色两面，点一下全站就换，这里也能试。明暗可以跟随系统，侧栏底下的按钮也能切。' },
    { title: '任务进度', go: go(() => { jobsOpen.value = true; }), target: '.tasks-panel',
      text: '存档、AI 摘要这类要等一会儿的事，进度在这里。' },
  ],
};

export const CHAPTERS: Chapter[] = [FEATURES, READING, SUMMARIES, ACADEMIC, BOOKS, FRIENDS, MANAGE];

export function findTarget(t: Target): Element | null {
  return typeof t === 'string' ? document.querySelector(t) : t();
}

