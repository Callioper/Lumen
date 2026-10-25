// Invented content for the demo library (scripts/demo/seed.ts). Every feed, person, article and book
// here is made up; nothing is copied from a real source.

import type { Look } from './art.ts';

export type Topic = 'media' | 'posthuman' | 'labor' | 'city' | 'translation' | 'scifi' | 'platform' | 'eco';

export const TOPIC_TAGS: Record<Topic, string> = {
  media: '媒介考古', posthuman: '后人文', labor: '数字劳动', city: '城市记忆',
  translation: '翻译研究', scifi: '科幻文学', platform: '平台治理', eco: '生态批评',
};

// Two or three paragraphs per topic; an article's text is its own lead followed by these.
export const TOPIC_TEXT: Record<Topic, string[]> = {
  media: [
    '媒介考古学不急于把技术排成一条进步的直线，而是回到那些被淘汰、被遗忘的装置旁边，问它们曾经让什么成为可能。',
    '幻灯机、电报键、早期的录音蜡筒，在今天看来笨拙，却各自规定了一种感知的节奏。把它们重新摆上桌面，当下的屏幕也就不再显得理所当然。',
    '这种方法的难处在于材料：档案往往只记录了成功的机器，失败的原型散落在私人收藏和专利文件里，需要一件一件去找。',
  ],
  posthuman: [
    '后人文主义的出发点不是取消人，而是追问「人」这个范畴是怎样被划出来的，又把谁排除在外。',
    '当认知被理解为分布在身体、工具与环境之间的过程，主体的边界就从皮肤移到了更难描述的地方。',
    '讨论最容易滑向两个方向：一边是对技术的乐观想象，一边是对人性失落的哀叹。更有意思的工作发生在两者之间。',
  ],
  labor: [
    '平台上的劳动常常被叫作「灵活」，可是灵活的一方往往是平台，而不是在路上奔跑的人。',
    '算法派单把时间切成越来越细的碎片，劳动者的经验也随之被拆散，难以形成共同的语言。',
    '近年的田野研究开始记录骑手、标注员与内容审核员自己的说法，这些说法比任何模型都更清楚地描述了系统的运行方式。',
  ],
  city: [
    '城市记忆并不储存在纪念碑里，而是附着在街角、菜市场和一条已经改名的巷子上。',
    '拆迁与更新改变的不只是建筑，还有人们讲述自己从哪里来的方式。口述史因此成为城市研究里不可替代的材料。',
    '当旧照片被上传到社交平台，地方记忆获得了新的流通渠道，也被新的算法重新排序。',
  ],
  translation: [
    '翻译从来不是两种语言之间的透明通道，每一个译名背后都有一段选择的历史。',
    '同一个概念在不同年代的译本里换了三四种说法，读者接受的其实是一串不断改写的理解。',
    '比较不同译本，最有收获的往往不是找错，而是看清楚译者在什么地方犹豫过。',
  ],
  scifi: [
    '科幻文学的价值不在于预言准不准，而在于它为尚未发生的事情提供了可以讨论的词汇。',
    '近年的中文科幻越来越多地把目光从星际帝国移到日常生活：一台家用机器人、一次失败的系统升级、一座被数据重新规划的小城。',
    '这些作品让技术问题重新回到了伦理和情感的层面，读者在故事里练习如何与陌生的存在相处。',
  ],
  platform: [
    '平台治理的核心难题在于规模：一条规则落到几亿用户身上，任何例外都会变成新的规则。',
    '内容审核既需要机器的速度，也需要人的判断，两者之间的分工本身就是一种政治安排。',
    '透明度报告提供了一些数字，但数字背后的分类标准往往才是真正需要讨论的地方。',
  ],
  eco: [
    '生态批评提醒我们，文学里的风景从来不是布景，而是与人物一起行动的存在。',
    '从山水诗到气候小说，自然书写的方式一直在变，变化本身记录了人与环境关系的历史。',
    '在气候危机的语境下，阅读也成为一种练习：练习注意那些缓慢、不起眼、却持续发生的变化。',
  ],
};

export interface Feed {
  key: string; title: string; url: string; site: string; category: string; view: 'article' | 'social' | 'picture' | 'video' | 'audio';
  layout?: 'list' | 'social' | 'cards' | 'masonry' | 'compact' | 'digest';
}

export const CATEGORIES: { name: string; layout: string | null }[] = [
  { name: '学术期刊', layout: 'list' },
  { name: '人文社科', layout: 'cards' },
  { name: '科技', layout: 'compact' },
  { name: '资讯', layout: 'digest' },
  { name: '视听', layout: null },
  { name: '动态', layout: null },
];

export const FEEDS: Feed[] = [
  { key: 'jmc', title: '媒介与文明', url: 'https://demo.lumen.invalid/journal-mc.xml', site: 'https://demo.lumen.invalid/mc', category: '学术期刊', view: 'article' },
  { key: 'jlt', title: '文艺理论动态', url: 'https://demo.lumen.invalid/journal-lt.xml', site: 'https://demo.lumen.invalid/lt', category: '学术期刊', view: 'article' },
  { key: 'essay', title: '思想札记', url: 'https://demo.lumen.invalid/essay.xml', site: 'https://demo.lumen.invalid/essay', category: '人文社科', view: 'article' },
  { key: 'books', title: '书讯周刊', url: 'https://demo.lumen.invalid/books.xml', site: 'https://demo.lumen.invalid/books', category: '人文社科', view: 'article' },
  { key: 'tech', title: '技术与社会观察', url: 'https://demo.lumen.invalid/tech.xml', site: 'https://demo.lumen.invalid/tech', category: '科技', view: 'article' },
  { key: 'open', title: 'Open Science Notes', url: 'https://demo.lumen.invalid/open.xml', site: 'https://demo.lumen.invalid/open', category: '科技', view: 'article' },
  { key: 'news', title: '每日文化速览', url: 'https://demo.lumen.invalid/news.xml', site: 'https://demo.lumen.invalid/news', category: '资讯', view: 'article' },
  { key: 'pod', title: '慢读播客', url: 'https://demo.lumen.invalid/podcast.xml', site: 'https://demo.lumen.invalid/podcast', category: '视听', view: 'audio' },
  { key: 'video', title: '公开讲座录像', url: 'https://demo.lumen.invalid/lectures.xml', site: 'https://demo.lumen.invalid/lectures', category: '视听', view: 'video' },
  { key: 'photo', title: '城市影像', url: 'https://demo.lumen.invalid/photo.xml', site: 'https://demo.lumen.invalid/photo', category: '视听', view: 'picture' },
  { key: 'press', title: '出版观察', url: 'https://demo.lumen.invalid/press.xml', site: 'https://demo.lumen.invalid/press', category: '动态', view: 'social' },
  { key: 'lin', title: '林间的豆瓣广播', url: 'rsshub://douban/people/demo-lin/status', site: 'https://demo.lumen.invalid/people/lin', category: '动态', view: 'social' },
  { key: 'jcl', title: '比较文学通讯', url: 'https://demo.lumen.invalid/journal-cl.xml', site: 'https://demo.lumen.invalid/cl', category: '学术期刊', view: 'article' },
  { key: 'rdfy', title: '复印报刊资料', url: 'https://demo.lumen.invalid/rdfy.xml', site: 'https://demo.lumen.invalid/rdfy', category: '学术期刊', view: 'article' },
  // A journal subscribed through CNKI's RSS (server/content/cnki.ts puts its articles together into issues).
  { key: 'cnki', title: '叙事学刊-CNKI', url: 'https://rss.cnki.net/knavi/rss/XSXK?pcode=CJFD', site: 'https://demo.lumen.invalid/cnki', category: '学术期刊', view: 'article' },
  { key: 'talks', title: '松溪人文讲坛', url: 'https://demo.lumen.invalid/talks.xml', site: 'https://demo.lumen.invalid/talks', category: '人文社科', view: 'article' },
  { key: 'jp', title: '文芸時評ノート', url: 'https://demo.lumen.invalid/jp.xml', site: 'https://demo.lumen.invalid/jp', category: '人文社科', view: 'article' },
  { key: 'qing', title: '阿青的豆瓣广播', url: 'rsshub://douban/people/demo-qing/status', site: 'https://demo.lumen.invalid/people/qing', category: '动态', view: 'social' },
];

// [feed, title, topic, story, lead]. Entries sharing a story are near each other in the fake vectors,
// so 相关文章 and the 推荐 profile have something to find.
export type Post = [feed: string, title: string, topic: Topic, story: string | null, lead: string];

export const POSTS: Post[] = [
  ['essay', '在旧幻灯机前重新学习观看', 'media', 'lantern', '一台民国时期的幻灯机在旧货市场被找到，它让人重新想起「观看」曾经需要多少人的配合。'],
  ['essay', '电报键与指尖的节奏', 'media', null, '电报员的手速曾经是一种职业能力，也是一种被训练出来的身体记忆。'],
  ['essay', '被分布的心智：读一部认知科学史', 'posthuman', 'mind', '这部认知科学史最有意思的地方，是它把「心智在哪里」当成一个历史问题来写。'],
  ['essay', '骑手的时间：一份田野笔记', 'labor', 'rider', '跟着三位骑手跑了一周之后，我才明白他们说的「时间不是自己的」是什么意思。'],
  ['essay', '菜市场里的城市史', 'city', 'market', '一座城市的变化，在菜市场里比在规划图上看得更清楚。'],
  ['essay', '一个概念的五种译法', 'translation', 'concept', '同一个德文词在四十年里被译成了五个不同的中文词，每一次改动都有它的理由。'],
  ['essay', '家用机器人与它的主人们', 'scifi', 'robot', '最近读到的几篇短篇小说，不约而同地写到了一台出了故障的家用机器人。'],
  ['essay', '河流也有档案吗', 'eco', 'river', '沿着一条城市河道走完全程，档案馆里的地图和眼前的河岸几乎对不上。'],
  ['essay', '注意力的考古学', 'media', 'lantern', '从幻灯放映到短视频，注意力被组织的方式一直在变，但「被组织」这件事本身没有变。'],
  ['essay', '后人文主义不是反人文主义', 'posthuman', 'mind', '把后人文主义读成对人的否定，是这几年最常见的误解。'],
  ['jmc', '早期幻灯放映与公共观看的形成', 'media', 'lantern', '本文以二十世纪初的幻灯放映活动为材料，讨论公共观看如何在放映现场被组织起来。'],
  ['jmc', '算法派单中的时间治理：基于骑手访谈的研究', 'labor', 'rider', '本文基于对外卖骑手的深度访谈，分析算法派单如何重组劳动时间。'],
  ['jmc', '平台内容审核的分类学：一项透明度报告研究', 'platform', 'review', '本文梳理多家平台的透明度报告，比较其违规内容分类标准的异同。'],
  ['jmc', '城市影像档案的数字化与再中介', 'city', 'photo', '本文讨论城市老照片在数字化与社交平台传播中的再中介过程。'],
  ['jmc', '技术物的寿命：一种媒介考古学的方法', 'media', null, '本文提出以技术物的「寿命」为单位考察媒介变迁的方法。'],
  ['jlt', '分布式认知与文学阅读', 'posthuman', 'mind', '本文借助分布式认知理论重新描述文学阅读中的注意与理解过程。'],
  ['jlt', '译名的历史：一个理论概念的中文旅行', 'translation', 'concept', '本文追踪一个西方理论概念在中文学界的译名演变。'],
  ['jlt', '日常科幻：近年中文短篇小说中的技术想象', 'scifi', 'robot', '本文分析近五年中文科幻短篇中以家庭与日常为场景的技术想象。'],
  ['jlt', '气候小说的时间形式', 'eco', 'river', '本文讨论气候小说如何处理缓慢变化与叙事节奏之间的张力。'],
  ['jlt', '风景作为行动者：生态批评的一个转向', 'eco', null, '本文梳理生态批评中「风景作为行动者」这一思路的来源与问题。'],
  ['tech', '标注员的一天', 'labor', 'annot', '数据标注的工作量按条计算，一个熟练的标注员每天要看几千张图片。'],
  ['tech', '透明度报告该怎么读', 'platform', 'review', '透明度报告里最重要的不是总数，而是分类方式。'],
  ['tech', '当推荐系统学会「破茧」', 'platform', null, '推荐系统开始有意识地推送用户平时不看的内容，效果如何还很难说。'],
  ['tech', '小模型在本地跑起来了', 'posthuman', null, '在一台普通笔记本上运行的语言模型，已经可以完成不少日常整理工作。'],
  ['tech', '内容审核外包的链条', 'platform', 'review', '一条被删除的帖子背后，可能经过了三家公司的审核流程。'],
  ['tech', '众包平台上的隐形劳动', 'labor', 'annot', '众包平台把大任务拆成小任务，也把劳动拆得几乎看不见。'],
  ['news', '多地图书馆延长夜间开放时间', 'city', null, '多座城市的公共图书馆宣布延长夜间开放，以回应读者的自习需求。'],
  ['news', '一部科幻选集获年度图书推荐', 'scifi', 'robot', '一部收录十二位青年作者的科幻选集入选年度推荐书目。'],
  ['news', '老城区口述史项目启动征集', 'city', 'market', '一个社区口述史项目开始征集居民关于老城区生活的讲述。'],
  ['news', '翻译奖公布短名单', 'translation', null, '今年的翻译奖短名单包括五部人文社科译著。'],
  ['news', '城市河道生态修复工程完工', 'eco', 'river', '一段城市河道完成生态修复，沿岸新增步道与观鸟点。'],
  ['news', '博物馆推出早期媒介装置特展', 'media', 'lantern', '一家博物馆推出早期媒介装置特展，展出幻灯机、留声机等藏品。'],
  ['pod', '第 41 期｜我们为什么需要慢读', 'translation', null, '这一期聊了三本难读的书，以及怎样给自己留出读完它们的时间。'],
  ['pod', '第 42 期｜和骑手一起跑了一周', 'labor', 'rider', '嘉宾讲述了做骑手田野调查时遇到的困难和意外收获。'],
  ['pod', '第 43 期｜科幻里的家务劳动', 'scifi', 'robot', '为什么越来越多的科幻小说写到了洗碗和扫地？'],
  ['video', '公开课｜媒介考古学导论（上）', 'media', 'lantern', '这一讲从「旧媒介为什么值得研究」讲起。'],
  ['video', '公开课｜媒介考古学导论（下）', 'media', null, '这一讲讨论档案、专利与失败的原型。'],
  ['video', '讲座｜后人文时代的阅读', 'posthuman', 'mind', '主讲人讨论了在人机协作的环境里，阅读意味着什么。'],
  ['video', '圆桌｜平台、劳动与算法', 'labor', null, '三位研究者围绕平台劳动的田野经验展开对话。'],
  ['photo', '雨后的老街', 'city', 'photo', '雨停之后，老街的石板路反着光。'],
  ['photo', '河岸新长出的芦苇', 'eco', 'river', '修复后的河岸第一次长出成片的芦苇。'],
  ['photo', '拆迁前的最后一个下午', 'city', 'photo', '这排房子下个月就要拆了。'],
  ['photo', '城市边缘的菜地', 'eco', null, '高架桥下的空地被附近居民开成了菜地。'],
  ['press', '这个月我们会出三本新书：一本关于媒介史，一本关于城市，一本是科幻小说集。', 'media', null, '这个月我们会出三本新书。'],
  ['press', '编辑手记：为什么一本译著要改三遍译名', 'translation', 'concept', '编辑手记：为什么一本译著要改三遍译名。'],
  ['press', '书店活动预告：周六下午和作者聊城市口述史', 'city', 'market', '书店活动预告。'],
  ['lin', '读完了一本讲骑手的书，最打动我的是那些具体的数字。', 'labor', 'rider', '读完了一本讲骑手的书。'],
  ['lin', '在旧货市场看到一台幻灯机，没舍得买，回来一直惦记。', 'media', 'lantern', '在旧货市场看到一台幻灯机。'],
  ['qing', '今天沿着河走了一圈，芦苇长得很好。', 'eco', 'river', '今天沿着河走了一圈。'],
  ['qing', '给家里的扫地机器人起了个名字，它好像更听话了。', 'scifi', 'robot', '给扫地机器人起了个名字。'],
];

export const OPEN_POSTS: [title: string, zh: string, topic: Topic, story: string | null][] = [
  ['Why open peer review is slowly winning', '开放评审为何在慢慢赢得支持', 'platform', null],
  ['A field guide to reading transparency reports', '阅读透明度报告的实用指南', 'platform', 'review'],
  ['Small language models on the desktop', '桌面上的小型语言模型', 'posthuman', null],
  ['Measuring the hidden labour of data annotation', '测量数据标注中的隐形劳动', 'labor', 'annot'],
];

// Japanese titles are shown in Chinese too, the original beside them.
export const JP_POSTS: [title: string, zh: string, topic: Topic][] = [
  ['街の記憶をめぐる三つの試論', '关于城市记忆的三篇试论', 'city'],
  ['翻訳と世界文学のあいだ', '在翻译与世界文学之间', 'translation'],
  ['ロボットのいる日常を描く小説たち', '描写有机器人的日常的小说', 'scifi'],
];

// Paper metadata for the journal feeds' entries, in the same order as their posts above.
export const PAPER_META: Record<string, { authors: string; keywords: string }> = {
  '早期幻灯放映与公共观看的形成': { authors: '沈知远', keywords: '幻灯；公共观看；媒介考古' },
  '算法派单中的时间治理：基于骑手访谈的研究': { authors: '何晴、宋川', keywords: '平台劳动；算法；时间' },
  '平台内容审核的分类学：一项透明度报告研究': { authors: '陆一鸣', keywords: '内容审核；透明度报告；分类' },
  '城市影像档案的数字化与再中介': { authors: '许岚', keywords: '城市记忆；影像档案；再中介' },
  '技术物的寿命：一种媒介考古学的方法': { authors: '沈知远', keywords: '技术物；媒介考古；方法' },
  '分布式认知与文学阅读': { authors: '周以宁', keywords: '分布式认知；阅读；后人文' },
  '译名的历史：一个理论概念的中文旅行': { authors: '韩素', keywords: '译名；概念史；翻译' },
  '日常科幻：近年中文短篇小说中的技术想象': { authors: '林舟', keywords: '科幻；日常；技术想象' },
  '气候小说的时间形式': { authors: '江枫', keywords: '气候小说；时间；叙事' },
  '风景作为行动者：生态批评的一个转向': { authors: '江枫、白露', keywords: '生态批评；风景；行动者' },
};

// look: the house style of its cover (scripts/demo/art.ts); en, original, series: what that style prints besides.
export interface Book { title: string; authors: string; translators?: string; publisher: string; date: string; isbn: string; price: string; blurb: string;
  topic: Topic; look: Look; en?: string; original?: string; series?: string }

export const BOOK_LISTS: { title: string; books: Book[] }[] = [
  { title: '本周新书书单｜媒介、城市与机器', books: [
    { title: '旧机器的回声', authors: '沈知远 著', publisher: '远川书局', date: '2026年9月', isbn: '9787000000011', price: '68.00元', blurb: '从幻灯机到电报键，一部关于被遗忘的媒介装置的小史。', topic: 'media', look: 'full', en: 'Echoes of Old Machines' },
    { title: '街角记忆', authors: '许岚 著', publisher: '半山书房', date: '2026年10月', isbn: '9787000000028', price: '59.00元', blurb: '二十位老居民讲述一座城市的五十年。', topic: 'city', look: 'band' },
    { title: '分布的心', authors: '[英] 埃莉诺·韦斯特 著', translators: '周以宁 译', publisher: '青石出版社', date: '2026年8月', isbn: '9787000000035', price: '78.00元', blurb: '心智不只在头脑里：一部写给普通读者的认知科学史。', topic: 'posthuman', look: 'series', original: 'The Distributed Mind', series: '认知与人文译丛' },
    { title: '扫地机器人之死', authors: '林舟 编', publisher: '白鹭文艺', date: '2026年10月', isbn: '9787000000042', price: '52.00元', blurb: '十二篇关于家庭与机器的中文科幻短篇。', topic: 'scifi', look: 'motif' },
  ] },
  { title: '十月好书｜劳动、翻译与河流', books: [
    { title: '奔跑的时间', authors: '何晴 著', publisher: '澄江出版社', date: '2026年9月', isbn: '9787000000059', price: '62.00元', blurb: '一份关于外卖骑手的田野报告。', topic: 'labor', look: 'full', en: 'Running Against the Clock' },
    { title: '五种译法', authors: '韩素 著', publisher: '青石出版社', date: '2026年7月', isbn: '9787000000066', price: '72.00元', blurb: '一个理论概念在中文世界的四十年旅行。', topic: 'translation', look: 'band' },
    { title: '河流的档案', authors: '江枫 著', publisher: '鹿鸣书局', date: '2026年10月', isbn: '9787000000073', price: '66.00元', blurb: '沿着一条城市河道，重读地图、档案与岸边的芦苇。', topic: 'eco', look: 'motif' },
    // Listed again: 新书 shows it once, as recommended by two lists.
    { title: '旧机器的回声', authors: '沈知远 著', publisher: '远川书局', date: '2026年9月', isbn: '9787000000011', price: '68.00元', blurb: '一部关于被遗忘的媒介装置的小史。', topic: 'media', look: 'full', en: 'Echoes of Old Machines' },
  ] },
];

// 豆瓣式标记: who, action, subject, kind, comment.
export const MARKS: [who: 'lin' | 'qing', action: string, subject: string, kind: 'book' | 'movie' | 'music', comment: string][] = [
  ['lin', '想读', '旧机器的回声', 'book', ''],
  ['qing', '想读', '旧机器的回声', 'book', '封面好看'],
  ['lin', '读过', '奔跑的时间', 'book', '很扎实的田野。'],
  ['qing', '在读', '河流的档案', 'book', ''],
  ['lin', '看过', '河岸', 'movie', '安静的纪录片。'],
  ['qing', '想看', '河岸', 'movie', ''],
  ['qing', '读过', '扫地机器人之死', 'book', '第三篇最好。'],
  ['lin', '收藏到', '河流的档案', 'book', ''],
  ['qing', '想听', '雨季唱片', 'music', ''],
  ['lin', '听过', '雨季唱片', 'music', '适合下雨天。'],
];

// 热点's public lists (豆瓣's own charts), invented. A title that is also in MARKS shows 「友邻也在看」.
export const HOT_LISTS: { key: string; kind: 'book' | 'movie'; items: [title: string, info: string, rating: number][] }[] = [
  { key: 'book_chart', kind: 'book', items: [
    ['旧机器的回声', '历史文化 · 连续上榜2个月', 8.6], ['海边的气象站', '文学', 8.9], ['一座城市的声音', '社会纪实 · 连续上榜3个月', 8.2],
    ['夜班列车', '小说', 7.9], ['纸上的森林', '科学新知', 8.4], ['外婆的菜园', '文学 · 连续上榜2个月', 9.0],
  ] },
  { key: 'book_latest', kind: 'book', items: [['纸上的森林', '远川书局 / 2026', 0], ['灯塔守望者手记', '远川书局 / 2026', 0], ['数字的乡愁', '远川书局 / 2026', 0]] },
  { key: 'movie_real_time_hotest', kind: 'movie', items: [
    ['河岸', '2026 / 中国大陆 / 纪录片', 8.1], ['最后的放映员', '2026 / 中国大陆 / 剧情', 7.6], ['雪线以上', '2026 / 冰岛 / 冒险', 7.2], ['城中村来信', '2025 / 中国大陆 / 剧情', 8.4],
  ] },
  { key: 'movie_weekly_best', kind: 'movie', items: [['最后的放映员', '2026 / 中国大陆 / 剧情', 7.6], ['潮汐研究所', '2026 / 日本 / 科幻', 8.0]] },
  { key: 'tv_chinese_best_weekly', kind: 'movie', items: [['老街修表铺', '2026 / 中国大陆 / 剧情', 8.7], ['山城夜话', '2026 / 中国大陆 / 悬疑', 7.8]] },
  { key: 'tv_real_time_hotest', kind: 'movie', items: [['老街修表铺', '2026 / 中国大陆 / 剧情', 8.7], ['灯下的人', '2026 / 中国大陆 / 家庭', 8.2], ['山城夜话', '2026 / 中国大陆 / 悬疑', 7.8]] },
  { key: 'tv_global_best_weekly', kind: 'movie', items: [['北方的岛', '2026 / 挪威 / 剧情', 8.9], ['潮汐研究所', '2026 / 日本 / 科幻', 8.0]] },
];

// Other editions of the books on the 书影音标记 dossier and the 新书 tiles, as 豆瓣 would list them.
export const EDITIONS: Record<string, [publisher: string, year: string, rating: number, readers: number][]> = {
  旧机器的回声: [['远川书局', '2026', 8.6, 1200], ['白鹭文艺', '2019', 8.3, 5400], ['青石出版社', '2011', 8.0, 3100]],
  奔跑的时间: [['澄江出版社', '2025', 8.8, 860]],
};
