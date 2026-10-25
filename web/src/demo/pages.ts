// Which page the demo is showing, and the two-sentence note for it: what the page is, then what can
// be done there and with which buttons. The note card (PageNote.tsx) shows the one for the page on screen.
import { computed } from '@preact/signals';
import { selection, detail, query, layout, settingsOpen, jobsOpen, isMarks, subjectTrail } from '../store.ts';
import { reportKind } from '../reports.ts';

export interface PageNote { name: string; text: string }

const NOTES = {
  home: { name: '首页', text: '先列快到期的：30 天内截止的征稿和申报，两周内要开的会和讲座，都从学术动态里取。右边是还没读的篇数和推荐先读。点左上角的 Lumen 或房子图标回到这里。' },
  'layout:list': { name: '列表', text: '一行一篇，左边是标题和开头几行，右边是小图，点开就在右边读。顶上能切未读和全部、最新和推荐。' },
  'layout:cards': { name: '大卡片', text: '封面图放大，标题和摘要在下面，适合图多的源。点卡片在右边读，Esc 回到满屏。' },
  'layout:masonry': { name: '瀑布流', text: '图按原来的比例排成几列，像翻相册。点一张看原帖，Esc 回来。' },
  'layout:compact': { name: '标题流', text: '只显示标题，一屏能扫几十条。j / k 上下移，Shift+K 把上面读过的都标为已读。' },
  'layout:digest': { name: '简报', text: '同一个源一天的文章收成一块。点块的标题展开，点某一篇在右边读。' },
  'layout:social': { name: '时间线', text: '豆瓣、微博这类以人为主的源，按时间排，图和字一起看。空格打开原帖。' },
  starred: { name: '收藏', text: '星标过的文章都在这里，定期清理不会删掉它们。阅读时按 f 收藏或取消。' },
  tag: { name: 'AI 标签', text: 'AI 打的主题标签，候选词由你在设置里列。点侧栏的一个标签，列表就只剩这一类。' },
  search: { name: '搜索', text: '空格隔开的词都得出现，加引号算一个词组。换成「意思相近」，没写这个词的文章也能搜到。下面一行还能按时间、收藏、存档筛。' },
  reader: { name: '阅读器', text: '顶上一排是对这篇的操作。正文下面依次是摘要、友邻标记、评论和相关文章。外文文章按 t 在双语、译文、原文之间切。' },
  social: { name: '动态', text: '以人为主的源都在这条时间线上。友邻在豆瓣标的书影音，单独放在「标记」里。' },
  marks: { name: '标记', text: '友邻在豆瓣的想读、在读、看过，书、电影、音乐分开。几个人标了同一本书会并成一张卡。单击展开，双击进书页，h 回总览。' },
  'subject-book': { name: '书页', text: '一本书在豆瓣上的信息，加上友邻的评价。公开版里点「想读」，记在 Lumen 自己这里。Esc 返回。' },
  'subject-movie': { name: '影片页', text: '一部电影在豆瓣上的信息和友邻的评价。点相近的片子能一路看下去，Esc 一层层退回。' },
  hot: { name: '书影榜', text: '左边是友邻近 30 天标得最多的，右边是豆瓣公共榜，两边都有的会标出来。卡片上的「想读」能直接点。' },
  books: { name: '新书', text: '这些书都是从书单推文里拆出来的，按月份、再按主题分组。顶上能换排法，也能只看近三个月、只看 Zotero 里没有的。' },
  tocs: { name: '期刊目录', text: '各个公众号推的目录格式五花八门，这里都整理成同一种样子；知网 RSS 一篇篇推来的，在这里拼成整期。点刊名只看这本刊。' },
  notices: { name: '学术动态', text: '会议、征稿、讲座、招聘、申报，都是从推文里读出来的，几个号发的同一场只算一条。左边是倒计时，讲座结束后会去 B 站找录像。' },
  'report:daily': { name: '日报', text: '每天挑出来值得看的文章，分组配导语。最后的「破茧」是一篇你平时不会点开的。左边是目录，点一篇在右边读。' },
  'report:weekly': { name: '周报', text: '一周的日报收成几条主线，附这一周的阅读数和书影榜新上榜的书。演示版里「重新生成」不会真的调用 AI。' },
  'report:papers': { name: '论文周报', text: '一周进来的新论文，按议题分组，挑了几篇值得细读的。每篇标着 Zotero 里有没有、人大复印转载没有。' },
  'settings:feeds': { name: '设置 · 订阅源', text: '所有订阅源都在这张表里，改名、换分类、换显示方式、暂停都在这里。出错的源能单独筛出来。' },
  'settings:add': { name: '设置 · 添加订阅', text: '粘贴 RSS 地址、网站首页，或公众号文章、豆瓣主页、B 站空间、知网期刊页的链接，Lumen 会找出能订阅的地址。演示版能找，但不会真的订上。' },
  'settings:ai': { name: '设置 · AI', text: '用哪家模型（兼容 OpenAI 格式就行），摘要和标签怎么写，外文要不要自动翻译，语义检索用哪个向量模型。密钥只存在本机。' },
  'settings:clip': { name: '设置 · 存档', text: '按 c 存进 Obsidian 时用的设置：库在哪、文件怎么命名、笔记模板（语法同 Recall for Obsidian），以及要不要让 AI 填著录信息、把图片也存下来。' },
  'settings:fetch': { name: '设置 · 抓取', text: '多久抓一次、同时抓几个、走不走代理、RSSHub 地址。新书页和只有海报的推文还要用到本机的 Zotero 数据库和 OCR 引擎，位置也在这里填。' },
  'settings:data': { name: '设置 · 数据与接口', text: 'OPML 导入导出，和给手机客户端用的 Google Reader 接口。人大复印收哪些刊、侧栏分类默认展开还是收起，也在这一页。' },
  'settings:look': { name: '设置 · 外观', text: '七套配色：默认的纸墨 Flexoki，还有素白、Solarized、Nord、Catppuccin、Rosé Pine、Everforest，每套都分浅色和深色。演示版里也能换着试。' },
  'settings:profile': { name: '阅读画像', text: '推荐根据的是你做过的事：喜欢、少推、收藏、存档、读完。兴趣簇是 AI 归的类，可以改名或隐藏。下面能看到哪些源你常读，哪些常跳过。' },
  jobs: { name: '任务进度', text: '存档、写摘要这类要等一会儿的事都在这里排着。演示里放了两条已经做完的。' },
} satisfies Record<string, PageNote>;

export type PageKey = keyof typeof NOTES;

export const pageKey = computed<PageKey | null>(() => {
  if (settingsOpen.value) return `settings:${settingsOpen.value}`;
  if (jobsOpen.value) return 'jobs';
  const sel = selection.value;
  if (isMarks.value) {
    const sub = subjectTrail.value.at(-1);
    return sub ? (sub.kind === 'book' ? 'subject-book' : 'subject-movie') : 'marks';
  }
  if (sel.kind === 'reports') return `report:${reportKind.value}`;
  if (sel.kind === 'home' && !detail.value) return 'home';
  if (sel.kind === 'books' || sel.kind === 'hot' || sel.kind === 'tocs' || sel.kind === 'notices') return sel.kind;
  if (detail.value) return 'reader';
  if (query.value) return 'search';
  if (sel.kind === 'social') return 'social';
  if (sel.kind === 'starred') return 'starred';
  if (sel.kind === 'tag') return 'tag';
  if (sel.kind === 'all' && !detail.value) return null;   // the welcome pane says it all
  return `layout:${layout.value}`;
});

export const noteOf = (k: PageKey): PageNote => NOTES[k];
