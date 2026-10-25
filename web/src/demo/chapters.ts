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
  key: 'features', title: '三分钟看特色', blurb: '先看五个别处没有的页面，最后看一眼外文翻译。',
  steps: [
    { title: '学术动态', go: page('notices'), target: '.notices-page .notice-when',
      text: '左边一栏是倒计时：还有几天截止，还有几天开始，或者正在进行。同一场讲座三个号都发了，这里只有一条。' },
    { title: '新书按主题分组', go: page('books'), target: '.book-shelf-head',
      text: '每个月的书再分一次主题。一组至少四本，太小的主题并进大类，免得分得太碎。' },
    { title: '人大复印的标记', go: page('tocs'), target: '.toc-reprint',
      text: '这篇被《复印报刊资料》全文转载了。复印资料的目录是图片，Lumen 先认出上面的字，再把转载标回原刊这一期。' },
    { title: '友邻的书影榜', go: page('hot'), target: '.hot-friends .hot-card',
      text: '左边是豆瓣友邻近 30 天标得最多的书和电影，右边是豆瓣的公共榜单，可以对着看。' },
    { title: '日报里的「破茧」', go: report('daily'), target: '#rs-explore',
      text: '日报最后一块叫「破茧」，放一篇和你关心的事有关、但你平时不会点开的文章。' },
    { title: '外文默认翻译', go: openTitled('Open Science Notes', 'open peer review'), target: '.reader h1.title',
      text: '外文文章的标题直接显示中文，原文跟在后面。正文可以看双语、只看译文或只看原文，电脑上按 t 切换。' },
  ],
};

const READING: Chapter = {
  key: 'reading', title: '读文章', blurb: '显示方式、推荐、阅读器上的按钮、搜索和快捷键。',
  steps: [
    { title: '五种显示方式', go: go(() => { setTab('all'); return select({ kind: 'all' }); }), target: '.views',
      text: '列表、大卡片、瀑布流、标题流、简报。图多的源默认用瀑布流，资讯源默认用标题流，单个源也能在列表右上角换。点这里的图标，只看用这种方式的源。' },
    { title: '简报', go: go(() => setTab('digest')), target: '.list-scroll',
      text: '适合一天几十条的资讯源：同一个源一天的文章收成一块，标题先折起来，长一点的块配一句 AI 写的概括。' },
    { title: '未读、推荐与理由', go: go(async () => { setTab('list'); await wait(300); setSortMode('rec'); }), target: '.list-tools',
      text: '「未读」只显示没读过的。切到「推荐」，会按你平时的阅读习惯排，每篇旁边写着推它的理由。对勾是全部标为已读，快捷键 Shift+A。' },
    { title: '阅读器的工具栏', go: openTitled('慢读播客', '和骑手一起跑'), target: '.reader-bar',
      text: '这一排管的是正在读的这篇：喜欢、少推、收藏、标为已读、抓全文、存进 Obsidian、生成分享图。每个都有单键快捷键，按 ? 能看到。' },
    { title: 'AI 摘要', go: openTitled('慢读播客', '和骑手一起跑'), target: '.ai-card',
      text: '配了 AI 接口的话，新文章一进来就有摘要。这篇还没有，点「生成摘要」会现写一份，演示里给的是示例。' },
    { title: '相关文章', go: openTitled('慢读播客', '和骑手一起跑'), target: '.related',
      text: '按意思找出来的相近文章，不看关键词。同一件事的其他报道，别的源讲同一个话题的，都排在这里。' },
    { title: '友邻标记', go: openTitled('书讯周刊', '本周新书书单'), target: '.friends',
      text: '文章里提到的书，豆瓣友邻标过的话，这里会列出谁想读、谁读过、写了什么。上面是从这份书单里拆出来的书。' },
    { title: '评论区', go: openComments, target: '.comments',
      text: '豆瓣和少数派的文章，原网页下的评论点「展开评论」就能在这里看。取过一次，一天内不会再去请求。' },
    { title: '搜索与「意思相近」', go: go(async () => { await select({ kind: 'all' }); query.value = '骑手'; await reloadList(); }), target: '[aria-label="搜索结果排序"]',
      text: '按 / 开始搜索。结果默认按相关程度排；切到「意思相近」，没写这个词、但在说同一件事的文章也会出来。' },
    { title: '按钮说明和快捷键', go: go(async () => { await select({ kind: 'all' }); labelsOn.value = true; }), target: '.demo-keys',
      text: '在任何一页按 ?，每个按钮旁边都会冒出一个小标签，快捷键表也一起打开。最常用的大概是 j / k 上下篇和 t 翻译。' },
  ],
};

const SUMMARIES: Chapter = {
  key: 'summaries', title: '总结与画像', blurb: '日报、周报、论文周报、AI 标签，还有推荐看的是什么。',
  steps: [
    { title: '日报', go: report('daily'), target: '.report-toc',
      text: '每天的日报从新进来的文章里挑出值得看的，分组写好导语。左边是目录，j / k 顺着目录往下读。' },
    { title: '破茧', go: report('daily'), target: '#rs-explore',
      text: '第一章看过的「破茧」，就在日报末尾。' },
    { title: '周报', go: report('weekly'), target: '.week-stats',
      text: '一周的日报收成几条主线。下面是这一周读完、略读、收藏了多少篇，还有书影榜上新出现的书。' },
    { title: '论文周报', go: report('papers'), target: '.paper-cnki',
      text: '一周的新论文按议题分组，挑出几篇值得细读的。每篇标着 Zotero 里有没有、人大复印转载没有，旁边这个按钮直接去知网搜篇名。' },
    { title: 'AI 标签', go: page('all'), target: '.tag-cloud',
      text: '标签只从你自己列的候选词里挑，一篇最多两个。点一个标签，列表就只剩这一类。' },
    { title: '阅读画像', go: settings('profile'), target: '.cluster-list',
      text: '推荐只看你明确做过的事：喜欢、少推、收藏、存档、读完。兴趣簇的名字是 AI 起的，不合适可以改，也可以隐藏，隐藏了就不再影响推荐。' },
  ],
};

const ACADEMIC: Chapter = {
  key: 'academic', title: '学术', blurb: '期刊目录和学术动态里的各个开关。',
  steps: [
    { title: '目录从哪里来', go: page('tocs'), target: '.tocs-head .seg',
      text: '目录有三个来源：公众号推的目录、知网 RSS 拼成的整期、人大复印的目录图片。想只看其中一种，点这里。' },
    { title: '按类别、按刊名', go: page('tocs'), target: '.toc-groups',
      text: '刊物按你自己分的类排。点类别看一类，点刊名只看那一本刊。' },
    { title: '知网检索', go: page('tocs'), target: '.toc-cnki',
      text: '篇名旁边这个按钮去知网搜这篇，刊名旁边的搜这本刊。有摘要的文章能直接在这里展开。' },
    { title: '按类型看动态', go: page('notices'), target: '.notices-page .book-topics',
      text: '会议、征稿、讲座、招聘、申报、征集，各自能单独看。' },
    { title: '能线上看的、已经过去的', go: page('notices'), target: '.notices-page .tocs-head',
      text: '「可线上看」只留下有直播或线上举办、还没开始的。「含已过」会把结束了的也列出来，找到录像的会标上。' },
    { title: '展开一条', go: page('notices'), target: '.notice',
      text: '点开一条能看到时间、地点、主办方和报名方式，回原推文的链接也在里面。' },
  ],
};

const BOOKS: Chapter = {
  key: 'books', title: '书与影', blurb: '新书页怎么排、怎么筛，还有书页和影片页。',
  steps: [
    { title: '按书单还是按出版时间', go: page('books'), target: '.list-tools .seg',
      text: '「按书单」照推文的先后排，「按出版时间」把所有书按出版月份重新排。右边可以换成卡片，能看到简介。' },
    { title: '类型和主题', go: page('books'), target: '.book-kinds',
      text: '第一行分虚构、非虚构和学术，第二行是更细的主题。' },
    { title: '几份书单都推荐的', go: page('books'), target: '.book-cover-posts',
      text: '一本书在几份书单里出现过，封面上就标几份。' },
    { title: 'Zotero 里已经有的', go: page('books'), target: '.book-owned',
      text: '已经在 Zotero 里的书会标出来。右上角的「只看未在库」把它们藏起来。' },
    { title: '书页', go: subjectPage('9000000'), target: '.bookpage',
      text: '友邻怎么说、简介、目录、豆瓣短评和其他版本都在这一页。点下面相近的书可以一直看下去，按 Esc 一层层退回来。' },
    { title: '影片页', go: subjectPage('9000039'), target: '.moviepage',
      text: '导演、演员、剧情简介和短评。公开版里点「想看」，记录存在 Lumen 自己这里。' },
  ],
};

const FRIENDS: Chapter = {
  key: 'friends', title: '友邻', blurb: '动态、标记和书影榜。',
  steps: [
    { title: '动态', go: page('social'), target: '.post',
      text: '豆瓣、微博这类以人为主的源排成一条时间线，图和字一起显示。' },
    { title: '标记按书、影、音分开', go: page('marks'), target: '.mark-kinds',
      text: '友邻的想读、在读、看过，书、电影、音乐分开放，各带未读数。几个人标了同一本书，会并成一张卡。' },
    { title: '标记总览', go: page('marks'), target: '.overview',
      text: '右边是近 30 天的总览，看得到大家正在读什么、哪本好几个人都想读。单击卡片展开，双击打开书页，按 h 回到这里。' },
    { title: '书影榜对照公共榜', go: page('hot'), target: '.hot-lists',
      text: '右边是豆瓣的公共榜单。友邻也在看的，会标上「友邻也在看」。' },
  ],
};

const MANAGE: Chapter = {
  key: 'manage', title: '管理订阅', blurb: '加订阅、改源的设置、AI、存档、数据接口、配色和任务进度。',
  steps: [
    { title: '添加订阅', go: settings('add'), target: '.add-form',
      text: 'RSS 地址、网站首页都能直接粘贴。公众号文章、豆瓣主页、B 站空间、知网期刊页的链接也行，Lumen 会认出是哪种源，换成能订阅的地址。' },
    { title: '订阅源', go: settings('feeds'), target: '.modal .tab-body',
      text: '每个源归哪类、用什么方式显示、要不要 AI 摘要、是否暂停，都在这里改。抓取出错的源可以单独筛出来。' },
    { title: 'AI', go: settings('ai'), target: '.modal .tab-body',
      text: '填任何兼容 OpenAI 格式的接口就行。摘要、标签、外文翻译和语义检索可以分开开关。密钥只存在你的电脑上。' },
    { title: '存档到 Obsidian', go: settings('clip'), target: '.modal .tab-body',
      text: '选好库的位置、文件路径和笔记模板，模板语法和 Recall for Obsidian 一样。存的时候可以让 AI 顺手填上作者、出处这些著录信息。' },
    { title: '数据与接口', go: settings('data'), target: '.modal .tab-body',
      text: '可以导入导出 OPML。手机上的 RSS 客户端也能通过 Google Reader 接口连过来，已读状态两边同步。' },
    { title: '外观', go: settings('look'), target: '.palettes',
      text: '七套配色，每套都有浅色和深色，点一下就换，演示里也能试。明暗可以跟着系统走，也可以用侧栏底下的按钮切。' },
    { title: '任务进度', go: go(() => { jobsOpen.value = true; }), target: '.tasks-panel',
      text: '存档、写摘要这类要等一会儿的事，进度都在这里。' },
  ],
};

export const CHAPTERS: Chapter[] = [FEATURES, READING, SUMMARIES, ACADEMIC, BOOKS, FRIENDS, MANAGE];

export function findTarget(t: Target): Element | null {
  return typeof t === 'string' ? document.querySelector(t) : t();
}

