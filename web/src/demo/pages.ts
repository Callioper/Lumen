// Which page the demo is showing, and the two-sentence note for it: what the page is, then what can
// be done there and with which buttons. The note card (PageNote.tsx) shows the one for the page on screen.
import { computed } from '@preact/signals';
import { selection, detail, query, layout, settingsOpen, jobsOpen, isMarks, subjectTrail } from '../store.ts';
import { reportKind } from '../reports.ts';

export interface PageNote { name: string; text: string }

const NOTES = {
  'layout:list': { name: '列表', text: '一行一篇，左边标题和开头几行，右边小图；点开在右边读。顶上可以切「未读 / 全部」「最新 / 推荐」，右边的图标换显示方式，对勾把这里的未读全部标为已读（Shift+A）。' },
  'layout:cards': { name: '大卡片', text: '适合图多的文章：封面放大，标题和摘要在下面。点卡片在右边读，按 Esc 回到满屏卡片。' },
  'layout:masonry': { name: '瀑布流', text: '图片源按原图比例排成几列，像翻相册。点一张看原帖，Esc 回来。' },
  'layout:compact': { name: '标题流', text: '只有标题，一屏能扫过几十条，适合资讯源。j / k 上下走，Shift+K 把读过的上面全部标为已读。' },
  'layout:digest': { name: '简报', text: '同一个源一天的文章合成一块，标题折叠起来，长一点的块由 AI 写一句概括。点块的标题展开，点某一篇在右边读。' },
  'layout:social': { name: '时间线', text: '以人为主的源（豆瓣、微博）排成时间线，图文一起显示。点一条看全文，空格打开原帖。' },
  starred: { name: '收藏', text: '加了星标的文章都在这里，不会被定期清理。在阅读器里按 f 或点星标收藏、取消。' },
  tag: { name: 'AI 标签', text: 'AI 给文章打的主题标签：标签只从你在设置里列的候选词里挑。点侧栏的标签，就只看这一类。' },
  search: { name: '搜索', text: '空格分开的词都要出现，引号括起的算一个词组；结果可以按相关、最新排，也可以换成「意思相近」：按语义找没出现这个词、但在说同一件事的文章。下面一行再按时间、收藏、已存档筛。' },
  reader: { name: '阅读器', text: '顶上一排是对这篇的操作：喜欢、少推、收藏、已读、抓全文、存档到 Obsidian、分享图。正文下面依次是 AI 摘要、友邻标记、评论区和相关文章；外文文章能在双语、译文、原文之间切换（t 键）。' },
  social: { name: '动态', text: '豆瓣、微博这类以人为主的源，排成一条时间线。友邻的书影音标记另外归在「标记」里。' },
  marks: { name: '标记', text: '友邻在豆瓣的想读、在读、看过，同一本书的几条标记并成一张卡；按书、影、音分开，带未读数。单击卡片展开，双击进书页，h 回这一页的总览。' },
  'subject-book': { name: '书页', text: '一本书的豆瓣信息：友邻怎么说、内容简介、目录、短评、喜欢读的人也喜欢、其他版本。「想读」在公开版里记在 Lumen 里；Esc 返回上一层。' },
  'subject-movie': { name: '影片页', text: '一部影片的豆瓣信息：导演和演员、友邻怎么说、剧情简介、短评，和「喜欢看的人也喜欢」。点相近的片子可以一路看下去，Esc 一层层退回。' },
  hot: { name: '书影榜', text: '左边是豆瓣友邻近 30 天的书影音标记，按人数和时间排；右边是豆瓣的公共榜单，友邻也标过的会标出来。卡片上的「想读」能直接记下。' },
  books: { name: '新书', text: '书都是从书单推文里拆出来的：几份书单都推荐的书会标出来，每个月的书再按主题分组。顶上可以按书单或按出版时间排、只看近三个月、只看 Zotero 里还没有的。' },
  tocs: { name: '期刊目录', text: '公众号的目录推文各有各的格式，这里统一成一份目录；知网 RSS 一篇一篇推，这里按期拼好；被人大复印全文转载的文章，在原刊目录里标出来。点刊名只看这一种刊，篇名旁的按钮去知网检索。' },
  notices: { name: '学术动态', text: '会议、征稿、讲座、招聘、申报，都是 AI 从推文里读出来的，同一场活动几个号都发了只出现一次。左边是倒计时；点一条展开详情，散场的讲座会去 B 站找录像。' },
  'report:daily': { name: '日报', text: 'AI 每天从进来的文章里挑出值得看的，分组写导语；最后的「破茧」放一篇你平常不点、但值得一看的。左边是目录，点一篇在右边读。' },
  'report:weekly': { name: '周报', text: '一周的日报汇成几条主线，附本周的阅读统计和书影榜新上榜的书。「重新生成」会再调用一次 AI（演示版里不调用）。' },
  'report:papers': { name: '论文周报', text: '一周进来的新论文，按议题分组，挑出值得精读的几篇；每篇标出 Zotero 是否已在库、是否被人大复印转载，旁边一键去知网检索。' },
  'settings:feeds': { name: '设置 · 订阅源', text: '所有源的列表：改名、换分类、换显示方式、开关 AI 摘要、暂停。出错的源单独筛得出来。' },
  'settings:add': { name: '设置 · 添加订阅', text: '粘贴 RSS 地址、网站首页，或公众号文章、豆瓣主页、B 站空间、知网期刊页的链接，Lumen 会认出是哪类源并换成订阅地址。演示版能查找，但不会真的订阅。' },
  'settings:ai': { name: '设置 · AI', text: '用哪家模型（任何 OpenAI 兼容的接口）、摘要和标签怎么做、外文是否自动翻译、语义检索用哪个向量模型。密钥只存在本机。' },
  'settings:clip': { name: '设置 · 存档', text: '按 c 把文章存进 Obsidian：库的位置、文件路径和笔记模板（与 Recall for Obsidian 同一套语法），以及要不要让 AI 填著录信息、下载图片。' },
  'settings:fetch': { name: '设置 · 抓取', text: '多久抓一次、同时抓几个、代理和 RSSHub 地址；还有本机 Zotero 数据库和 OCR 引擎的位置，「新书」和只有海报的推文要用到。' },
  'settings:data': { name: '设置 · 数据与接口', text: '导入导出 OPML；Google Reader 接口，手机上的 RSS 客户端可以连过来同步已读；还有人大复印收哪些刊、侧栏分类默认收起还是展开。' },
  'settings:look': { name: '设置 · 外观', text: '明暗跟随系统或手动选；七套配色（默认是纸墨 Flexoki，另有素白、Solarized、Nord、Catppuccin、Rosé Pine、Everforest），各有浅色深色两面，点一下全站就换。演示版里也能试。' },
  'settings:profile': { name: '阅读画像', text: '推荐靠的是你的明确信号：喜欢、少推、收藏、存档、读完。兴趣簇是 AI 按相近程度归的类，可以改名或隐藏；下面是哪些源你常读、哪些常跳过。' },
  jobs: { name: '任务进度', text: '存档到 Obsidian、AI 摘要这类要等一会儿的事，进度都在这里。演示里是两条做完的示例。' },
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
