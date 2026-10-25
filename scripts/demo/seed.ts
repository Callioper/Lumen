// Builds the demo library: an invented reading history in its own data folder, so the real one is
// never touched. Usage: node scripts/demo/seed.ts [dataDir]   (default demo/data)
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, type DB } from '../../server/db.ts';
import { normalize } from '../../server/rec/embed.ts';
import { weeklyHot } from '../../server/report/hot.ts';
import { DatabaseSync } from 'node:sqlite';
import { TOPIC_TAGS, TOPIC_TEXT, CATEGORIES, FEEDS, POSTS, OPEN_POSTS, JP_POSTS, PAPER_META, BOOK_LISTS, MARKS, HOT_LISTS, EDITIONS, type Topic, type Book } from './content.ts';
import { MORE_BOOK_LISTS, BOOK_SORT, OWNED_ISBNS } from './newbooks.ts';
import { DEMO_TOCS, DEMO_NOTICES, DEMO_REPRINTS, DEMO_CNKI, DEMO_REPLAYS } from './academic.ts';
import { book as bookPage, film as filmPage } from './pages.ts';
import * as art from './art.ts';
import type { Look } from './art.ts';
import { TOC_VERSION } from '../../server/content/tocs.ts';
import { NOTICE_VERSION, replayKey, type Notice } from '../../server/content/notices.ts';
import { REPRINT_VERSION } from '../../server/content/reprints.ts';
import { PAGE_VERSION } from '../../server/content/douban.ts';
import { MOVIE_VERSION } from '../../server/content/doubanmovie.ts';
import { segment, blockText, weave, TR } from '../../server/ai/translate.ts';

const DIR = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', 'demo', 'data'));
const MODEL = 'BAAI/bge-m3';
const DIM = 256;
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

// Deterministic, so two runs give the same library.
let seed = 20261022;
const rand = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
const unit = (): Float32Array => normalize(Array.from({ length: DIM }, gauss));

// bge-m3 puts unrelated texts around 0.45 apart; the same topic sits a little closer and the same story near 0.85.
const GLOBAL = unit();
const bases = new Map<string, Float32Array>();
const base = (k: string): Float32Array => { if (!bases.has(k)) bases.set(k, unit()); return bases.get(k)!; };
function vectorOf(topic: string, story: string | null): Float32Array {
  const g = 0.67, t = 0.5, s = story ? 0.6 : 0, n = 0.42;
  const tv = base(`t:${topic}`), sv = story ? base(`s:${story}`) : null, nv = unit();
  return normalize(GLOBAL.map((x, i) => g * x + t * tv[i] + (sv ? s * sv[i] : 0) + n * nv[i]));
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The pictures run to several KB each, more than a mark's card is read for (server/api/marks.ts reads
// its first 2000 characters): the library holds a short stand-in, and the demo page swaps each for its
// picture from web/src/demo/art.json (web/src/demo/mock.ts).
const ART: Record<string, string> = {};
const held = new Map<string, string>();
function stand(uri: string): string {
  if (!held.has(uri)) { const k = `p${held.size}`; held.set(uri, k); ART[k] = uri; }
  return `data:lumen-art,${held.get(uri)}`;
}
const bookCover = (b: art.CoverOf): string => stand(art.bookCover(b));
const poster = (title: string, topic: Topic, line: string): string => stand(art.poster(title, topic, line));
const sleeve = (title: string, topic: Topic): string => stand(art.sleeve(title, topic));
const scene = (topic: Topic, key: string, w?: number, h?: number): string => stand(art.scene(topic, key, w, h));
const cover = (b: Book): string => bookCover(b);
const ALL_LISTS = [...BOOK_LISTS.map((l, i) => ({ ...l, age: (i * 70 + 20) / 24 })), ...MORE_BOOK_LISTS];
const ALL_BOOKS = [...new Map(ALL_LISTS.flatMap((l) => l.books).map((b) => [b.isbn, b])).values()];
// One invented 豆瓣 id per title, shared by the marks, the public lists, the editions and the 新书 tiles.
const SUBJECTS = [...new Set([...MARKS.map((m) => m[2]), ...HOT_LISTS.flatMap((l) => l.items.map((x) => x[0])), ...ALL_BOOKS.map((b) => b.title)])];
const subjectId = (title: string): string => String(9000000 + SUBJECTS.indexOf(title) * 13);
// A book from the 书单 keeps its own cover everywhere it shows up.
// A title known only from a chart gets a subject, a house style and a press of its own from its name.
const TOPICS = Object.keys(TOPIC_TAGS) as Topic[];
const LOOKS: Look[] = ['band', 'full', 'motif', 'series'];
const PRESSES = ['远川书局', '半山书房', '白鹭文艺', '鹿鸣书局', '澄江出版社'];
const pick = <T,>(xs: readonly T[], title: string, salt: number): T => xs[[...title].reduce((h, c) => (h * 31 + c.charCodeAt(0) + salt) % 9973, 7) % xs.length];
const coverOf = (title: string, kind: 'book' | 'movie' | 'music' = 'book'): string => {
  const topic = pick(TOPICS, title, 0);
  if (kind === 'movie') return poster(title, topic, '2026 · 一部虚构的电影');
  if (kind === 'music') return sleeve(title, topic);
  const b = ALL_BOOKS.find((x) => x.title === title);
  return b ? cover(b) : bookCover({ title, authors: '佚名', publisher: pick(PRESSES, title, 3), topic, look: pick(LOOKS, title, 5) });
};
const PLACES = ['北城', '南湾', '东江', '西岭', '河口', '旧港', '湖滨', '山前', '古镇', '新区'];
const EVENTS = ['举办社区读书周', '公布年度阅读报告', '启动旧书循环计划', '开放一座新的城市书房', '举行青年写作工作坊',
  '发布公共文化服务清单', '推出夜间博物馆活动', '开展街区影像征集', '举办独立出版市集', '上线地方文献数字库', '开设周末公开课', '评选年度社区图书馆'];
// What each piece of news says, in its own words, so the list doesn't open on one sentence repeated.
const EVENT_TEXT: ((place: string) => string)[] = [
  (p) => `${p}图书馆这周每天晚上七点有一场读书会，周六下午换成亲子共读。书目贴在一楼借阅台旁边。`,
  () => '报告里借得最多的是推理小说，其次是育儿书。借阅量比去年少了一些，电子书的下载量涨了。',
  () => '家里不看的书可以送到街道服务中心，换一张兑书券。缺页的书和教辅暂时不收。',
  (p) => `新书房在${p}公交总站旁边，两层，晚上开到十点。刷身份证就能进，书可以和区图书馆通借通还。`,
  () => '工作坊一共四次，每次两小时，先读一篇短篇，再动手写一页。报名要交一篇两千字以内的习作。',
  () => '清单列了全区四十多处能免费用的场馆，写明了开放时间和预约方式。下半年还会再更新一次。',
  (p) => `每月最后一个周五，${p}博物馆开到晚上九点，七点有一场讲解。不用预约，人多时会限流。`,
  (p) => `征集拍${p}老街区的照片和短视频，十年前的旧照也收。入选的作品年底在街道展厅展出。`,
  () => '市集办两天，三十多个摊位，大多是小出版社和个人做的刊物。周日下午有一场关于小印量出版的分享。',
  () => '第一批放上去的是地方志和老报纸，大约两万页，可以全文检索。家谱还在整理，明年上线。',
  () => '公开课每周六上午，这一季讲本地方言和地名的来历。每场限八十人，提前一天在公众号预约。',
  (p) => `评选看借阅量、活动次数和读者留言。${p}有三家社区图书馆进了候选名单。`,
];

// filler: a news item on a subject of its own, so most pairs in the library are unrelated, as in a real one.
interface Made { id: number; key: string; feed: string; title: string; topic: Topic; story: string | null; published: number; filler?: number }

function seedLibrary(db: DB): Made[] {
  const catId = new Map<string, number>();
  CATEGORIES.forEach((c, i) => {
    catId.set(c.name, Number(db.prepare('INSERT INTO category (name, sort, layout) VALUES (?, ?, ?)').run(c.name, i, c.layout).lastInsertRowid));
  });
  const feedId = new Map<string, number>();
  for (const f of FEEDS) {
    const r = db.prepare(`INSERT INTO feed (url, title, site_url, category_id, view, layout, paused, last_ok_at, last_fetch_at, ai_summary)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(f.url, f.title, f.site, catId.get(f.category)!, f.view, f.layout ?? null, NOW - 600, NOW - 600, f.view === 'article' ? 1 : 0);
    feedId.set(f.key, Number(r.lastInsertRowid));
  }

  const made: Made[] = [];
  let micro = (NOW - 8 * 86400) * 1e6;
  const insert = db.prepare(`INSERT INTO entry (id, feed_id, guid, title, title_zh, author, link, content, thumbnail, published,
    is_read, is_starred, read_at, ai_state, ai_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (feed: string, title: string, o: { zh?: string; author?: string; html: string; thumb?: string | null; topic: Topic; story: string | null;
    age: number; summary?: string | null }): Made => {
    const published = NOW - o.age;
    micro += 1000;
    const id = micro;
    const isRead = o.age > 3 * 86400 && rand() < 0.25 ? 1 : 0;   // most left unread: the demo opens on 未读
    insert.run(id, feedId.get(feed)!, `demo-${id}`, title, o.zh ?? null, o.author ?? null, `https://demo.lumen.invalid/${feed}/${made.length + 1}`,
      o.html, o.thumb ?? null, published, isRead, 0, isRead ? published + HOUR : null, o.summary ? 2 : 0, o.summary ?? null);
    const m = { id, key: `${feed}:${made.length}`, feed, title, topic: o.topic, story: o.story, published };
    made.push(m);
    return m;
  };

  // Spread over the last week, newest last in the list so ids rise with time.
  const all = [...POSTS].map((p, i) => ({ p, age: Math.round((POSTS.length - i) * 2.9 * HOUR + rand() * 2 * HOUR) }));
  for (const { p: [feed, title, topic, story, lead], age } of all) {
    const f = FEEDS.find((x) => x.key === feed)!;
    const paras = TOPIC_TEXT[topic];
    const img = (n: number): string => `<p><img src="${scene(topic, `${title}${n}`, 640, 480)}" alt=""></p>`;
    let html: string;
    let thumb: string | null = null;
    let author: string | undefined;
    const meta = PAPER_META[title];
    if (meta) {
      author = meta.authors;
      html = `<p>作者：${meta.authors}</p><p>摘要：${lead}${paras[0]}${paras[1]}</p><p>关键词：${meta.keywords}</p>`;
    } else if (f.view === 'social') {
      html = `<p>${esc(title)}</p>${rand() < 0.7 ? img(1) + (rand() < 0.5 ? img(2) : '') : ''}`;
    } else if (f.view === 'picture') {
      thumb = scene(topic, title, 640, [480, 820, 560, 400][made.length % 4]);   // photos come tall and wide
      html = `<p><img src="${thumb}" alt=""></p><p>${lead}</p>`;
    } else if (f.view === 'video') {
      thumb = scene(topic, title, 640, 360);
      html = `<p><img src="${thumb}" alt=""></p><p>${lead}${paras[0]}</p>`;
    } else {
      html = `<p>${lead}</p>${paras.map((x) => `<p>${x}</p>`).join('')}`;
      if (rand() < 0.5) { thumb = scene(topic, title); html = `<p><img src="${thumb}" alt=""></p>` + html; }
    }
    const summary = f.view === 'article' ? `<p>${lead}</p>` : null;
    add(feed, title, { html, thumb, topic, story, age, author, summary });
  }
  PLACES.forEach((place, i) => EVENTS.forEach((event, j) => {
    if ((i + j) % 4 === 3) return;
    const title = `${place}${event}`;
    const html = `<p>${EVENT_TEXT[j](place)}</p>`;
    const m = add(j % 3 === 0 ? 'tech' : 'news', title, { html, topic: 'city', story: null, age: Math.round(rand() * 7 * 86400) + HOUR });
    m.filler = i * EVENTS.length + j;
  }));
  OPEN_POSTS.forEach(([title, zh, topic, story], i) => {
    const html = `<p>${title}. This short note is invented for the Lumen demo; it stands in for an English-language article.</p>` +
      '<p>Lumen translates titles and, on request, the text, pairing each paragraph with its translation.</p>';
    add('open', title, { zh, html, topic, story, age: Math.round((i * 30 + 5) * HOUR), summary: `<p>${zh}。</p>` });
  });
  JP_POSTS.forEach(([title, zh, topic], i) => {
    const html = `<p>${title}。この短い文章は Lumen のデモ用に作られたものです。</p><p>${TOPIC_TEXT[topic][0]}</p>`;
    add('jp', title, { zh, html, topic, story: null, age: Math.round((i * 26 + 9) * HOUR), summary: `<p>${zh}。</p>` });
  });
  ALL_LISTS.forEach((l) => {
    const html = l.books.map((b) => `<p><a href="https://book.douban.com/subject/${subjectId(b.title)}/">《${b.title}》</a></p><p><img src="${cover(b)}" alt=""></p><p>${b.authors}</p>` +
      (b.translators ? `<p>${b.translators}</p>` : '') + `<p>${b.publisher} ${b.date}</p><p>ISBN：${b.isbn}</p><p>定价：${b.price}</p><p>${b.blurb}</p>`).join('');
    add('books', l.title, { html, thumb: cover(l.books[0]), topic: 'translation', story: null, age: Math.round(l.age * 86400) });
  });
  MARKS.forEach(([who, action, subject, kind], i) => {
    const b = ALL_BOOKS.find((x) => x.title === subject);
    const name = who === 'lin' ? '林间' : '阿青';
    const comment = MARKS[i][4];
    const link = `https://${kind}.douban.com/subject/${subjectId(subject)}/`;
    const info = b ? `${b.authors} / ${b.publisher} / ${b.date}` : kind === 'music' ? '雨季乐队 / 2026 / 专辑' : '纪录片 / 2026';
    const html = `<p><a href="${link}">《${subject}》</a></p><p><img src="${coverOf(subject, kind)}" alt=""></p><p>${info}</p>`;
    const title = `${name} ${action}: 《${subject}》${comment ? ' ' + comment : ''}`;
    const m = add(who, title, { html, topic: 'eco', story: null, age: Math.round((i * 9 + 3) * HOUR) });
    db.prepare('UPDATE entry SET link = ? WHERE id = ?').run(link, m.id);
  });
  return made;
}

function seedSignals(db: DB, made: Made[]): void {
  const byTitle = (t: string): Made => made.find((m) => m.title.startsWith(t))!;
  const set = db.prepare('UPDATE entry SET is_starred = 1 WHERE id = ?');
  for (const t of ['在旧幻灯机前', '注意力的考古学', '早期幻灯放映', '被分布的心智', '分布式认知与文学', '骑手的时间', '算法派单中', '一个概念的五种译法'])
    set.run(byTitle(t).id);
  for (const t of ['公开课｜媒介考古学导论（上）', '后人文主义不是', '第 42 期']) db.prepare("UPDATE entry SET reaction = 'like' WHERE id = ?").run(byTitle(t).id);
  db.prepare("UPDATE entry SET reaction = 'less_topic' WHERE id = ?").run(byTitle('透明度报告该怎么读').id);
  const ev = db.prepare(`INSERT INTO event (entry_id, feed_id, type, weight, progress, active_ms, list_scope, sort_mode, position, created_at)
    SELECT id, feed_id, ?, ?, ?, ?, 'all', 'latest', 0, ? FROM entry WHERE id = ?`);
  for (const t of ['博物馆推出早期媒介', '菜市场里的城市史', '家用机器人与它的主人们', '河流也有档案吗', '标注员的一天'])
    ev.run('read_complete', 4, 1, 90_000, NOW - 20 * HOUR, byTitle(t).id);
  for (const t of ['电报键与指尖', '一部科幻选集'])
    ev.run('skim', 1, 0.5, 30_000, NOW - 30 * HOUR, byTitle(t).id);
  db.prepare('UPDATE entry SET is_read = 1, read_at = ? WHERE id IN (SELECT entry_id FROM event)').run(NOW - 20 * HOUR);
  // 存档 to Obsidian, as the archive filter shows it.
  for (const t of ['在旧幻灯机前', '骑手的时间']) db.prepare("INSERT INTO tag (entry_id, name, source) VALUES (?, '已存档', 'clip')").run(byTitle(t).id);
}

function seedTagsAndVectors(db: DB, made: Made[]): void {
  const tag = db.prepare('INSERT OR IGNORE INTO tag (entry_id, name, source) VALUES (?, ?, ?)');
  const vec = db.prepare('INSERT INTO embedding (entry_id, model, vec, created) VALUES (?, ?, ?, ?)');
  for (const m of made) {
    const isMark = / (想读|读过|在读|看过|想看): 《/.test(m.title);
    if (!isMark && m.filler === undefined) tag.run(m.id, TOPIC_TAGS[m.topic], 'ai');
    if (m.story === 'rider' || m.story === 'mind') tag.run(m.id, '待写', 'user');
    if (isMark) continue;
    const v = vectorOf(m.filler === undefined ? m.topic : `f${m.filler}`, m.story);
    vec.run(m.id, MODEL, new Uint8Array(v.buffer), NOW);
  }
}

// Reports as the AI would have written them; the demo never calls a model.
function seedReports(db: DB, made: Made[]): void {
  const day = (s: number): string => { const d = new Date(s * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const startOfDay = (s: number): number => { const d = new Date(s * 1000); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
  const by = (t: string): Made => made.find((m) => m.title.startsWith(t))!;
  const feedTitle = (m: Made): string => FEEDS.find((f) => f.key === m.feed)!.title;
  const lead = (m: Made): string => POSTS.find((p) => p[1] === m.title)?.[4] ?? '';
  const item = (t: string, interest: number) => { const m = by(t); return { id: m.id, title: m.title, feed: feedTitle(m), link: `https://demo.lumen.invalid/${m.feed}`, lead: lead(m), interest, read: false, kept: false, also: [] as string[] }; };
  const put = (r: { kind: string; period: string }): void => {
    db.prepare('INSERT OR REPLACE INTO report (kind, period, data, path, created) VALUES (?, ?, ?, NULL, ?)').run(r.kind, r.period, JSON.stringify(r), NOW - HOUR);
  };

  const today = startOfDay(NOW);
  const daily = {
    kind: 'daily', period: day(today - 86400), from: today - 86400, to: today, total: 9, arrived: 23,
    overview: '昨天的阅读围绕两条线展开：一条是早期媒介装置重新进入公共视野，博物馆特展、公开课和期刊论文都在谈幻灯与观看；另一条是平台劳动，从骑手的时间到标注员的计件，田野材料比往常更集中。',
    picks: [item('博物馆推出早期媒介', 0.82), item('骑手的时间', 0.77), item('分布式认知与文学', 0.7)],
    groups: [
      { name: '旧媒介与观看', summary: '特展、课程与论文从三个方向回到幻灯机前，讨论公共观看如何被组织。', items: [item('公开课｜媒介考古学导论（上）', 0.66), item('注意力的考古学', 0.63)] },
      { name: '平台上的劳动', summary: '骑手与标注员的经验被记录下来，算法如何切分时间成为共同的问题。', items: [item('标注员的一天', 0.58), item('众包平台上的隐形劳动', 0.52)] },
      { name: '城市与河流', summary: '口述史征集与河道修复，记忆和生态在同一座城市里相遇。', items: [item('老城区口述史项目', 0.41), item('城市河道生态修复', 0.38)] },
    ],
    explore: item('气候小说的时间形式', 0.12),
  };
  put(daily);

  const monday = today - ((new Date(today * 1000).getDay() + 6) % 7) * 86400 - 7 * 86400;
  const week = (s: number): string => {
    const d = new Date(s * 1000); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const jan4 = new Date(d.getFullYear(), 0, 4);
    return `${d.getFullYear()}-W${String(1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
  };
  put({
    kind: 'weekly', period: week(monday), from: monday, to: monday + 7 * 86400, total: 14, dailies: [daily.period],
    overview: '这一周最持续的话题是旧媒介：从一台旧货市场里的幻灯机，到博物馆的特展，再到一篇讨论公共观看的论文。平台劳动的讨论则从个人经验走向了制度分析。',
    threads: [
      { name: '幻灯机前的观看', summary: '随笔、课程、论文与特展先后出现，构成一周里最完整的一条线。', days: [daily.period], items: [item('在旧幻灯机前', 0.8), item('早期幻灯放映', 0.75)], more: 2 },
      { name: '算法与时间', summary: '骑手访谈、播客与圆桌讨论都指向算法如何重组劳动时间。', days: [daily.period], items: [item('算法派单中', 0.7), item('第 42 期', 0.6)], more: 1 },
    ],
    stats: { arrived: 156, completed: 12, skimmed: 31, starred: 8, liked: 3, topFeeds: [{ feed: '思想札记', opened: 9 }, { feed: '媒介与文明', opened: 6 }, { feed: '技术与社会观察', opened: 4 }] },
    hot: weeklyHot(db, NOW),
  });

  const paper = (t: string, interest: number) => {
    const m = by(t), meta = PAPER_META[m.title];
    return { id: m.id, title: m.title, authors: meta.authors, venue: feedTitle(m), abstract: lead(m), via: 'journal', link: `https://demo.lumen.invalid/${m.feed}`, feed: feedTitle(m), also: [], interest };
  };
  const papers = Object.keys(PAPER_META).map((t) => paper(t, 0.3));
  put({
    kind: 'papers', period: week(monday), from: monday, to: monday + 7 * 86400, total: papers.length,
    overview: '本周两份期刊共更新十篇论文。媒介考古与平台研究各占一组，生态批评有两篇从时间与风景两个角度切入。',
    picks: [paper('早期幻灯放映与公共观看的形成', 0.8), paper('分布式认知与文学阅读', 0.72)],
    groups: [
      { name: '媒介与观看', summary: '回到具体装置与放映现场。', items: [paper('早期幻灯放映与公共观看的形成', 0.8), paper('技术物的寿命：一种媒介考古学的方法', 0.6), paper('城市影像档案的数字化与再中介', 0.5)] },
      { name: '平台与劳动', summary: '算法、审核与时间治理。', items: [paper('算法派单中的时间治理：基于骑手访谈的研究', 0.7), paper('平台内容审核的分类学：一项透明度报告研究', 0.3)] },
      { name: '文学理论', summary: '认知、译名、科幻与生态。', items: [paper('分布式认知与文学阅读', 0.72), paper('译名的历史：一个理论概念的中文旅行', 0.5), paper('日常科幻：近年中文短篇小说中的技术想象', 0.45), paper('气候小说的时间形式', 0.3), paper('风景作为行动者：生态批评的一个转向', 0.25)] },
    ],
    journals: ['媒介与文明', '文艺理论动态'].map((f) => ({ feed: f, items: papers.filter((p) => p.feed === f) })),
    zotero: Object.fromEntries(papers.map((p, i) => [p.id, i % 3 === 0])),
  });
}

// 热点: the public lists as RSSHub would have given them, fresh so nothing refetches; and the
// editions 「其他版本」 shows, cached so nothing asks 豆瓣.
function seedHot(db: DB): void {
  const put = db.prepare('INSERT OR REPLACE INTO hot_list (key, fetched, items) VALUES (?, ?, ?)');
  for (const l of HOT_LISTS) {
    put.run(l.key, NOW, JSON.stringify(l.items.map(([title, info, rating]) => ({
      subject: subjectId(title), title, info, rating: rating || null, cover: coverOf(title, l.kind),
    }))));
  }
  const ed = db.prepare('INSERT OR REPLACE INTO douban_subject (subject, works, total, editions, editions_at) VALUES (?, ?, ?, ?, ?)');
  Object.entries(EDITIONS).forEach(([title, list], i) => {
    const editions = list.map(([publisher, year, rating, readers], k) => ({ subject: k ? String(9500000 + i * 10 + k) : subjectId(title), publisher, year, rating, readers }));
    ed.run(subjectId(title), list.length > 1 ? String(800000 + i) : null, list.length, JSON.stringify(editions), NOW);
  });
}

// The foreign posts as translated already, each paragraph paired with its translation (server/ai/translate.ts).
const TRANSLATED: [RegExp, (m: RegExpExecArray, zh: string) => string][] = [
  [/^.+\. This short note is invented for the Lumen demo; it stands in for an English-language article\.$/, (_, zh) => `${zh}。这篇短文是为 Lumen 演示虚构的，代替一篇英文文章。`],
  [/^Lumen translates titles and, on request, the text, pairing each paragraph with its translation\.$/, () => 'Lumen 会翻译标题，也可以按需翻译正文，每段原文配一段译文。'],
  [/^.+。この短い文章は Lumen のデモ用に作られたものです。$/, (_, zh) => `${zh}。这篇短文是为 Lumen 演示虚构的。`],
];
function seedTranslations(db: DB): void {
  const rows = db.prepare(`SELECT e.id, e.title_zh AS zh, e.content FROM entry e JOIN feed f ON f.id = e.feed_id WHERE f.url IN (?, ?)`)
    .all(...['open', 'jp'].map((k) => FEEDS.find((f) => f.key === k)!.url)) as { id: number; zh: string; content: string }[];
  const put = db.prepare('UPDATE entry SET tr_state = ?, content_tr = ?, tr_of = ? WHERE id = ?');
  for (const r of rows) {
    const seg = segment(r.content);
    const done = new Map<number, string>();
    seg.blocks.forEach((el, i) => {
      const t = blockText(el);
      for (const [re, zh] of TRANSLATED) { const m = re.exec(t); if (m) { done.set(i, zh(m, r.zh)); break; } }
    });
    put.run(TR.DONE, weave(seg, done), 'feed', r.id);
  }
}

function seedBookKinds(db: DB): void {
  const put = db.prepare('INSERT OR REPLACE INTO book_kind (key, kind, topic, at) VALUES (?, ?, ?, ?)');
  for (const [isbn, [kind, topic]] of Object.entries(BOOK_SORT)) put.run(isbn, kind, topic, NOW);
}

// 豆瓣 as Lumen keeps it: each listed book's subject, and the subject pages a book's or a film's card
// opens, fresh so nothing is asked of 豆瓣.
function seedDouban(db: DB): void {
  // Answered already, so 新书 never looks a book's date or cover up on 豆瓣.
  const known = db.prepare(`INSERT OR REPLACE INTO douban_book (key, subject, title, looked_at, cover, cover_at, date, authors, publisher)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const b of ALL_BOOKS) known.run(`isbn:${b.isbn}`, subjectId(b.title), b.title, NOW, cover(b), NOW, b.date, b.authors, b.publisher);
  const put = db.prepare(`INSERT INTO douban_subject (subject, works, total, editions, editions_at, page) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET page = excluded.page, editions_at = excluded.editions_at,
      editions = COALESCE(douban_subject.editions, excluded.editions), total = COALESCE(douban_subject.total, excluded.total)`);
  const similar = (title: string, pool: readonly string[], kind: 'book' | 'movie') => pool.filter((t) => t !== title).slice(0, 6)
    .map((t) => ({ subject: subjectId(t), title: t, cover: coverOf(t, kind), rating: 7.5 + (t.length % 5) / 4 }));
  const books = SUBJECTS.filter((t) => !MOVIES.has(t) && !MUSIC.has(t));
  for (const title of books) {
    const b = ALL_BOOKS.find((x) => x.title === title);
    const page = { v: PAGE_VERSION, ...bookPage(title, b, coverOf(title)), similar: similar(title, books.slice((title.length * 3) % 9), 'book') };
    const one = [{ subject: subjectId(title), publisher: b?.publisher ?? '远川书局', year: '2026', rating: page.rating, readers: page.done }];
    put.run(subjectId(title), null, 1, JSON.stringify(one), NOW, JSON.stringify(page));
  }
  const films = [...MOVIES];
  for (const title of films) {
    const page = { v: MOVIE_VERSION, kind: 'movie', ...filmPage(title, coverOf(title, 'movie')), similar: similar(title, films, 'movie') };
    put.run(subjectId(title), null, null, null, NOW, JSON.stringify(page));
  }
}
const MOVIES = new Set([...MARKS.filter((m) => m[3] === 'movie').map((m) => m[2]), ...HOT_LISTS.filter((l) => l.kind === 'movie').flatMap((l) => l.items.map((x) => x[0]))]);
const MUSIC = new Set(MARKS.filter((m) => m[3] === 'music').map((m) => m[2]));

// The reader's Zotero library, as much of it as 「只看未在库」 reads (server/content/library.ts).
function seedZotero(): void {
  const z = new DatabaseSync(join(DIR, 'zotero.sqlite'));
  z.exec(`CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT); CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE itemData (itemID INTEGER, fieldID INTEGER, valueID INTEGER); CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
    INSERT INTO fields VALUES (1, 'title'), (2, 'ISBN');`);
  OWNED_ISBNS.forEach((isbn, i) => {
    const b = ALL_BOOKS.find((x) => x.isbn === isbn)!;
    z.prepare('INSERT INTO itemDataValues VALUES (?, ?), (?, ?)').run(i * 2 + 1, b.title, i * 2 + 2, isbn);
    z.prepare('INSERT INTO itemData VALUES (?, 1, ?), (?, 2, ?)').run(i + 1, i * 2 + 1, i + 1, i * 2 + 2);
  });
  z.close();
}

// 期刊目录 and 学术动态: the posts, and what the AI read out of them, so the demo never asks it.
function seedJournals(db: DB): void {
  const feedId = (key: string): number => (db.prepare('SELECT id FROM feed WHERE url = ?').get(FEEDS.find((f) => f.key === key)!.url) as { id: number }).id;
  const insert = db.prepare(`INSERT INTO entry (id, feed_id, guid, title, author, link, content, published, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const put = db.prepare('INSERT INTO extract (entry_id, kind, version, data, at) VALUES (?, ?, ?, ?, ?)');
  let id = (NOW - 90 * 86400) * 1e6;
  const post = (feed: string, title: string, age: number, html = `<p>${title}</p>`, author: string | null = null, read = 1): number => {
    id += 1000;
    insert.run(id, feedId(feed), `demo-x-${id}`, title, author, `https://demo.lumen.invalid/${feed}/x${id}`, html, NOW - Math.round(age * 86400), read);
    return id;
  };
  for (const [feed, title, age, toc] of DEMO_TOCS) put.run(post(feed, title, age), 'toc', TOC_VERSION, JSON.stringify(toc), NOW);
  for (const [feed, title, age, issues] of DEMO_REPRINTS) put.run(post(feed, title, age), 'reprint', REPRINT_VERSION, JSON.stringify(issues), NOW);
  // CNKI's articles come one by one, a few minutes apart, unread like any feed's.
  DEMO_CNKI.forEach(([title, authors, abstract, age], i) => post('cnki', title, age + i / 1440, `<p>${abstract}</p>`, authors, 0));
  const replay = db.prepare('INSERT OR REPLACE INTO replay (key, checked, found) VALUES (?, ?, ?)');
  for (const [feed, title, age, items, text] of DEMO_NOTICES) {
    put.run(post(feed, title, age, `<p>${title}</p>${text ? `<p>${text}</p>` : ''}`), 'notice', NOTICE_VERSION, JSON.stringify(items), NOW);
    for (const n of items as unknown as Notice[]) {
      const found = DEMO_REPLAYS[n.name];
      if (!found) continue;
      const at = (d: number): number => Math.floor(new Date(`${n.date}T20:00:00`).getTime() / 1000) + d * 86400;
      replay.run(replayKey(n), NOW, JSON.stringify(found.map(([bvid, t, author, after, minutes]) => ({ bvid, title: t, author, at: at(after), minutes }))));
    }
  }
}

// 评论区 as 豆瓣 would have answered for each mark's subject, fetched just now so nothing asks again.
const VOICES = ['松果', '北岸', '一只鹭', '慢半拍', '沙洲', '小满'];
const SAYINGS = ['读到一半就想推荐给朋友。', '结构有点松，但材料很扎实。', '比预想的好读，注释也认真。',
  '第二章最好，后面略重复。', '封面和内文一样克制。', '适合放在通勤路上慢慢看。', '书里的几张老照片很动人。'];
function seedComments(db: DB): void {
  const put = db.prepare('INSERT INTO comment_cache (entry_id, fetched_at, data) VALUES (?, ?, ?)');
  const rows = db.prepare("SELECT id, link FROM entry WHERE link LIKE 'https://%.douban.com/subject/%'").all() as { id: number; link: string }[];
  rows.forEach(({ id, link }, i) => {
    const comments = Array.from({ length: 4 + (i % 3) }, (_, j) => ({
      who: VOICES[(i + j) % VOICES.length], text: SAYINGS[(i * 2 + j) % SAYINGS.length], time: NOW - (j * 30 + i * 7 + 5) * HOUR,
      likes: Math.max(0, 40 - j * 9 - i), rating: 3 + ((i + j) % 3), replies: [],
    }));
    put.run(id, NOW, JSON.stringify({ source: '豆瓣短评', url: link, total: 120 + i * 17, comments, fetchedAt: NOW }));
  });
}

// A few articles whose full text was fetched already, so the reader's 订阅/全文 switch has both to show.
function seedFullText(db: DB): void {
  const rows = db.prepare("SELECT e.id, e.content FROM entry e JOIN feed f ON f.id = e.feed_id WHERE f.view = 'article' AND e.content NOT LIKE '%摘要：%' ORDER BY e.published DESC LIMIT 4").all() as { id: number; content: string }[];
  const more = '<p>（以下是从原网页抓回的全文后半部分。）订阅里只给了开头几段；全文多出的部分在这里接着读，图片也一并缓存到本机。本段为演示用的虚构文字。</p>';
  // Chinese articles only: an English one opened on this made-up Chinese tail, past its bilingual excerpt.
  for (const r of rows.filter((x) => /[\u4e00-\u9fff]/.test(x.content.slice(0, 300)))) db.prepare('UPDATE entry SET content_full = ? WHERE id = ?').run(r.content + more + more.replace('后半部分', '结尾'), r.id);
}

function main(): void {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const db = openDb(join(DIR, 'lumen.db'));
  const made = seedLibrary(db);
  seedSignals(db, made);
  seedTagsAndVectors(db, made);
  seedHot(db);
  seedTranslations(db);
  seedBookKinds(db);
  seedDouban(db);
  seedJournals(db);
  seedComments(db);
  seedFullText(db);
  seedReports(db, made);
  db.close();
  seedZotero();
  writeFileSync(join(DIR, 'settings.json'), JSON.stringify({
    port: 8790,
    ai: { enabled: true, baseUrl: 'https://ai.demo.invalid/v1', model: 'demo-model' },
    embedding: { enabled: true, baseUrl: 'https://embed.demo.invalid/v1', model: MODEL },
    translate: { enabled: true, model: 'demo-model' },
    clip: { vaultPath: '' },
    // Nowhere: the demo's 热点 lists are seeded, and a refresh must not pull the real ones in.
    proxy: '', rsshubBase: 'http://rsshub.demo.invalid',
  }, null, 2));
  writeFileSync(join(import.meta.dirname, '..', '..', 'web', 'src', 'demo', 'art.json'), JSON.stringify(ART));
  console.log(`演示库已生成：${join(DIR, 'lumen.db')}，${made.length} 篇`);
}

main();
