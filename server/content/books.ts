// Books listed in a post, by rule. Two layouts are read, each anchored on its ISBN line:
//   a 联合书单 account: 《书名》 / cover / 作者 著 / 译者 译 / 品牌 | 出版社 / ISBN：… / 定价：… / 推荐语
//   豆瓣式书讯 (most publishers' and societies' accounts): 书名：… / 作者：… / 译者：… / 出版社：… / 出版年 / ISBN / 页数…
// A book whose title cannot be found is left out rather than guessed.

export interface ListedBook {
  title: string;
  cover: string | null;
  authors: string;           // as printed: [美] 尤金·罗根 著
  translators: string;       // 李杨 译
  publisher: string;         // 理想国 | 民主与建设出版社
  date: string;              // 2026年4月, or 2026年 when only the year is printed; '' when none
  isbn: string;              // digits only (an X kept); '' when the post prints none
  subject: string | null;    // the 豆瓣 subject id, when the list comes from a 豆列
  price: string;
  blurb: string;
}

const LOOK_BACK = 10;        // lines from a book's ISBN back to its title
const LOOK_AHEAD = 8;        // labelled lines (页数、定价…) that may follow the ISBN
const BARE_TITLE_CHARS = 40;
const BLURB_LINES = 3;
const BLURB_CHARS = 400;
const IMG = /^\[\[img:(.+)\]\]$/;
// A whole line in 《》, perhaps after a note in brackets: （点击书封图，一键购买）《天桥艺人》
// 「01#《…》」「03｜《…》」: a list numbers its title lines (上海三联, 2026-10).
const TITLE = /^(?:#?\d{1,3}\s*#?[.、．|｜丨]?\s*)?(?:[（(][^）)]{1,20}[）)])?《([^《》]{1,80})》(?:[（(][^）)]{1,12}[）)])?$/;
// 「68.00元」「¥68」 on its own line: the price, never a title.
const PRICE = /^(?:定\s*价\s*[:：]?\s*)?[¥￥]?\s*\d{1,4}(?:\.\d{1,2})?\s*元?$/;
// 「1.《邹韬奋研究（第十三辑）》韬奋纪念馆 编上海三联书店 75.00元 9787542692924」: a list's book in one line.
const ROW = /^(?:\d{1,3}\s*[.、．·]\s*)?《([^《》]{1,80})》\s*(.*?)\s*([¥￥]?\d{1,4}(?:\.\d{1,2})?元)?\s*(97[89]\d{10})$/;
const ISBN = /^ISBN\s*[:：]?\s*([0-9Xx-]{10,17})/;
const LABEL = /^(书名|作者|著者|编者|主编|译者|出版社|出版商|出品方|版本|出版年|出版时间|出版日期|定价|页数|装帧|丛书|副标题|原作名|ISBN)\s*[:：]\s*(.*)$/;
const LABEL_ONLY = /^(?:书名|作者|著者|编者|主编|译者|出版社|出版商|出品方|出版年|定价|丛书|副标题|原作名)\s*[:：]$/;
const TRANSLATOR = /(?:译|翻译|编译|译注|审校)$/;
// 「段义孚 著周尚意译」「刘婷 译松溪出版集团」: a role and what follows it run together on one line.
// 译林、译文 are publishers, not a translator's role.
const RUN_ON = /(\s(?:著|编著|主编|编|译(?![林文]))|(?:著|译(?![林文]))(?=\S.*(?:译|审校|出版社|书店|书局|集团|[|｜丨])))(?=[^\s；;，,、）)])/g;
const PUBLISHER = /[|｜丨]|出版社|出版集团|出版公司|出版中心|书局|书店|印书馆|文献/;
// A heading (基本信息、Publishing Information), a person ([德] 帕特尔) or a sentence is not a title.
const BARE_NOT_TITLE = /[。，！？：:]|信息|Information|^[/／\[［【(（]/;
const PERSON = /^\p{Script=Han}{2,4}$/u;
const BLURB_HEAD = /^(?:About the Book\s*)?(?:[【\[]?(?:内容简介|内容提要|图书简介|简介|推荐语|推荐理由|编辑推荐)[】\]]?\s*[:：]?\s*)?/i;

const decode = (s: string): string => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// One line per paragraph, an image on a line of its own; a label left alone on its line takes the next one.
export function postLines(html: string): string[] {
  const lines = decode(html
    .replace(/<img\b[^>]*?\ssrc="([^"]+)"[^>]*>/gi, (_m, src: string) => `\n[[img:${src}]]\n`)
    .replace(/<\/(?:p|div|h\d|li|section|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/(\S)\s*(ISBN\s*[:：])/g, '$1\n$2')                              // 「社会科学文献出版社ISBN：…」
    .replace(/》\s*(?=(?:作者|著者|译者|出版社)\s*[:：])/g, '》\n')               // 「《天桥艺人》作者：岳永逸」
    .split('\n').map((l) => l.replace(/[\s\u200e\u200f]+/g, ' ').trim()).filter(Boolean);
  return lines.flatMap((l, i) => (LABEL_ONLY.test(l) ? [] : i && LABEL_ONLY.test(lines[i - 1]) ? [lines[i - 1] + l] : [l]));
}

const isTitle = (l: string): boolean => TITLE.test(l) || /^书名\s*[:：]/.test(l);
const titleOf = (l: string): string => (TITLE.exec(l)?.[1] ?? l.replace(/^书名\s*[:：]\s*/, '').replace(/^《|》$/g, '')).trim();

// 「松溪出版集团 2026 年 9 月」: the date printed after the publisher goes to its own field.
function setPublisher(book: ListedBook, l: string, append = false): void {
  const m = /^(.*?)[\s,，]*(\d{4}\s*(?:年|[-./]).*)$/.exec(l);
  const date = m && m[1] ? dateOf(m[2]) : null;
  const name = date ? m![1] : l;
  if (date) book.date ||= date;
  if (append && book.publisher) book.publisher = `${book.publisher} | ${name}`;
  else book.publisher ||= name;
}

function readMeta(book: ListedBook, l: string): void {
  const img = IMG.exec(l);
  if (img) { book.cover ??= img[1]; return; }
  const label = LABEL.exec(l);
  if (label) {
    const [, key, printed] = label;
    const value = printed.replace(/[,，;；]\s*$/, '');
    if (/作者|著者|编者|主编/.test(key)) book.authors ||= value;
    else if (key === '译者') book.translators ||= value;
    else if (key === '出版社' || key === '出版商' || key === '出品方' || key === '版本') book.publisher = book.publisher ? `${value} | ${book.publisher}` : value;
    else if (key === '定价') book.price ||= value;
    else if (/^出版(?:年|时间|日期)$/.test(key)) book.date ||= dateOf(value) ?? '';
    return;
  }
  const date = dateOf(l);
  if (date) book.date ||= date;
  else if (PRICE.test(l) && /\d/.test(l)) book.price ||= l;
  else if (TRANSLATOR.test(l)) book.translators ||= l;
  else if (PUBLISHER.test(l) && !/(?:著|编|撰|绘)$/.test(l)) setPublisher(book, l);
  else if (!book.authors) book.authors = l;
}

// postTitle: a book post with no title line of its own (「新书速递｜《娘家与婆家》」) is named by it.
// A post that prints no ISBN can still be a list (《书名》 lines, each followed by who wrote it), but
// only one that says so in its title: essays' notes and podcasts' show notes read the same way.
export const LIST_POST = /书单|好书榜|好书|新书(?!选读)|书讯|荐书|书目|选书|阅读指南/;   // 「新书选读」 is an excerpt with notes

export function extractBooks(html: string, postTitle = ''): ListedBook[] {
  const lines = joinedTitles(postLines(html));
  const byIsbn = [...isbnBooks(lines, postTitle), ...rowBooks(lines)];
  const listed = byIsbn.length || !LIST_POST.test(postTitle) ? byIsbn : listedBooks(lines);
  const books = listed.length || !LIST_POST.test(postTitle) ? listed : namedBook(lines, postTitle);
  // The same book printed twice in one post (a quote, then its card) is listed once.
  const seen = new Set<string>();
  return books.filter((b) => { const k = b.isbn || b.title.replace(/\s+/g, ''); return !seen.has(k) && !!seen.add(k); });
}

// 「05#《国家为什么会成功：政府禀赋」 / 「与经济兴衰》」: a title the layout broke over two lines.
function joinedTitles(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines[i + 1] ?? '';
    const open = l.lastIndexOf('《') > l.lastIndexOf('》');
    if (open && /^[^《]{1,40}》/.test(next) && l.length + next.length <= 90) { out.push(l + next); i++; } else out.push(l);
  }
  return out;
}

function rowBooks(lines: string[]): ListedBook[] {
  return lines.map((l) => ROW.exec(l)).filter((m): m is RegExpExecArray => !!m).map(([, title, who, price, isbn]) => {
    const book = blank(title.trim(), isbn);
    book.price = price ?? '';
    // 「韬奋纪念馆 编上海三联书店」「[荷]约翰·赫伊津哈 著 宋宗澳 译 上海三联书店」: a part ends at its role
    const parts = who.replace(/(编著|主编|著|编|译)(?=\S*(?:出版社|书店|书局|出版集团|印书馆)$)/, '$1\n').replace(/(著|编|译)\s+/g, '$1\n').split('\n')
      .flatMap((x) => x.split(/\s+(?=\S*(?:出版社|书店|书局|出版集团|印书馆)$)/)).map((x) => x.trim()).filter(Boolean);
    for (const part of parts) readMeta(book, part);
    return book;
  });
}

const blank = (title: string, isbn = ''): ListedBook =>
  ({ title, cover: null, authors: '', translators: '', publisher: '', date: '', isbn, subject: null, price: '', blurb: '' });

// 「2026-4」「2025年2月」「2026.04」「2026/1/15」「2025年」: printed every way, shown one way.
const DATE = /^(\d{4})\s*(?:年|[-./])?\s*(?:(\d{1,2})\s*(?:月|[-./]\s*\d{1,2}\s*日?)?)?\s*(?:月|出版)?\s*(?:第\s*\d+\s*版)?\s*(?:第\s*\d+\s*次(?:印刷)?)?$/;
export function dateOf(s: string): string | null {
  const m = DATE.exec(s.trim());
  if (!m || +m[1] < 1900 || +m[1] > 2100 || (m[2] && (+m[2] < 1 || +m[2] > 12))) return null;
  return m[2] ? `${m[1]}年${+m[2]}月` : `${m[1]}年`;
}

// A number (「01」) or a short heading (「书目信息」「新书推介」) may stand between the cover and the title.
const COVER_ABOVE = 4;
const BETWEEN_COVER_AND_TITLE = /^(?:#?\d{1,3}[.、．]?|[^《》：:。，]{1,8})$/;
function coverAbove(lines: string[], title: number, floor: number): string | null {
  for (let j = title - 1; j >= Math.max(floor, title - COVER_ABOVE); j--) {
    const img = IMG.exec(lines[j]);
    if (img) return img[1];
    if (!BETWEEN_COVER_AND_TITLE.test(lines[j])) return null;
  }
  return null;
}

// 「精装 32开 496页」
const SPEC = /^(?:(?:精装|平装|简装|软精装|锁线|裸脊|\d+\s*开|\d+\s*页)[\s/|｜·]*)+$/;
const BY_LINE_CHARS = 40;
const normName = (s: string): string => s.replace(/[\s'’·.]/g, '').toLowerCase();

function isbnBooks(lines: string[], postTitle: string): ListedBook[] {
  const anchors = lines.map((l, i) => (ISBN.test(l) ? i : -1)).filter((i) => i >= 0);
  const named = /《([^《》]{1,80})》/.exec(postTitle)?.[1];
  const blocks = anchors.map((at, n) => {
    const floor = n ? anchors[n - 1] + 1 : 0;
    for (let j = at - 1; j >= Math.max(floor, at - LOOK_BACK); j--) if (isTitle(lines[j])) return { at, start: j, title: titleOf(lines[j]) };
    // No title line: the bare line above the labelled run (豆瓣 prints the title so), else, for a
    // single-book post, the post's own title.
    let j = at;
    let byLine = false;
    for (; j > Math.max(floor, at - LOOK_BACK); j--) {
      const l = lines[j - 1];
      const role = l.length <= BY_LINE_CHARS && ROLE_END.test(l) && !!l.replace(ROLE_END, '').trim();
      if (!(LABEL.test(l) || IMG.test(l) || dateOf(l) || SPEC.test(l) || PRICE.test(l) || role)) break;
      byLine ||= role;
    }
    const above = j > floor ? lines[j - 1] : '';
    const run = lines.slice(j, at);
    // 「Mark O'Neill | The Man Who Made China…」: the author, then the title.
    const author = run.map((l) => /^(?:作者|著者)\s*[:：]\s*(.+)$/.exec(l)?.[1].trim()).find(Boolean);
    const piped = /^(.{1,40}?)\s*[|｜]\s*(.{2,120})$/.exec(above);
    if (piped && author && normName(piped[1]) === normName(author)) return { at, start: j - 1, title: piped[2].trim() };
    // A short name above labels that give no author is the author, printed unlabelled.
    const unnamed = !byLine && !run.some((l) => /^(?:作者|著者|编者|主编)\s*[:：]/.test(l));
    // A subtitle's colon is allowed when the author's line follows: 「心术与治道：荀子思想发微」 / 「洪涛 著」.
    const notTitle = byLine ? /[。，！？]|信息|Information|^[/／\[［【(（]|[：:]$/ : BARE_NOT_TITLE;
    if (above && above.length <= BARE_TITLE_CHARS && !notTitle.test(above) && !(unnamed && PERSON.test(above))) {
      return { at, start: j - 1, title: above };
    }
    if (anchors.length === 1 && named) return { at, start: j - 1, title: named };
    return null;
  }).filter((x): x is { at: number; start: number; title: string } => !!x);
  return blocks.map(({ at, start, title }, n) => {
    const book = blank(title, ISBN.exec(lines[at])![1].replace(/-/g, '').toUpperCase());
    const end = n + 1 < blocks.length ? blocks[n + 1].start : lines.length;
    let after = at + 1;
    const trailing = (l: string): boolean => LABEL.test(l) || /^定\s*价/.test(l) || PRICE.test(l) || !!dateOf(l) || SPEC.test(l)
      || (l.length <= BY_LINE_CHARS && PUBLISHER.test(l) && !/[。！？，]/.test(l));
    while (after < Math.min(end, at + 1 + LOOK_AHEAD) && trailing(lines[after])) after++;
    const meta = [...lines.slice(start + 1, at), ...lines.slice(at + 1, after)];
    for (const l of meta.flatMap((x) => (LABEL.test(x) ? [x] : x.replace(RUN_ON, '$1\n').split('\n')))) readMeta(book, l.replace(/^定\s*价\s*[:：]/, '定价：'));
    book.cover ??= coverAbove(lines, start, n ? blocks[n - 1].at + 1 : 0);
    book.blurb = lines.slice(after, end).filter((l) => !IMG.test(l) && !LABEL.test(l))
      .map((l) => l.replace(BLURB_HEAD, '')).filter(Boolean).slice(0, BLURB_LINES).join('').slice(0, BLURB_CHARS);
    return book;
  });
}

// 「01《美学中的不满》」「#03」 then 「《电影的色彩》」: a title line in a numbered list.
const LIST_TITLE = /^(?:#?\d{1,3}[.、．)）]?\s*)?《([^《》]{1,80})》(?:[（(][^）)]{1,12}[）)])?$/;
const LIST_NUMBER = /^#?\d{1,3}[.、．]?$/;
const META_LINES = 6;
const META_CHARS = 80;
const MIN_LISTED = 3;        // fewer than this is a review naming a book or two, not a list
const YEAR = /^(?:\d{4}(?:[-.年/]\d{1,2}(?:月)?)?(?:[-–]\d{4})?|\d{4}年)$/;
const ROLE_END = /(?:著|编著|主编|编|撰|绘)$/;     // 「刘绍华 / 著」 reads as 「刘绍华 著」

// 「雅克·朗西埃著，蓝江、李三达译，南京大学出版社，2019」: who, translators and publisher on one line.
function readListMeta(book: ListedBook, line: string): void {
  if (LABEL.test(line)) { readMeta(book, line); return; }
  for (const part of line.replace(/\s*\/\s*(?=(?:著|编|主编|编著|译)$)/, ' ').split(/[，,]\s*/).flatMap((x) => x.replace(RUN_ON, '$1\n').split('\n')).map((x) => x.trim()).filter(Boolean)) {
    const date = dateOf(part);
    if (date) { book.date ||= date; continue; }
    if (YEAR.test(part)) continue;
    if (TRANSLATOR.test(part)) book.translators ||= part;
    else if (ROLE_END.test(part) || !book.authors && !PUBLISHER.test(part)) book.authors ||= part;
    else if (!/[：:]$/.test(part)) setPublisher(book, part, true);   // 「推荐理由：」 heads what follows
  }
}

// Without 《》: a short line right under the cover whose next line (or the one after, when the title
// is broken at its colon) names the author — 拜德雅's 「封面 / 心术与治道 / 洪涛 著」.
function bareTitleAt(lines: string[], i: number): string | null {
  if (!IMG.test(lines[i - 1] ?? '')) return null;
  const l = lines[i];
  if (l.length > BARE_TITLE_CHARS || /[。！？，]/.test(l) || /信息|Information|^[/／\[［【(（▲]/.test(l)) return null;
  const broken = /[：:]$/.test(l) && (lines[i + 1] ?? '').length <= BARE_TITLE_CHARS;
  const next = lines[i + (broken ? 2 : 1)] ?? '';
  const by = next.replace(/\s*\/\s*/, ' ').trim();
  if (!ROLE_END.test(by) || !by.replace(ROLE_END, '').trim()) return null;
  return broken ? l + lines[i + 1] : l;
}

// One book a post recommends without an ISBN (「好书推荐 | 杨枫著《知识翻译学》」): the line that
// gives the 《》 name of the post's title, with who wrote it or a publisher's label just under it.
const NAMED_META = 4;
function namedBook(lines: string[], postTitle: string): ListedBook[] {
  const named = /《([^《》]{1,80})》/.exec(postTitle)?.[1]?.trim();
  if (!named) return [];
  const key = named.replace(/\s+/g, '');
  for (let i = 0; i < lines.length; i++) {
    if (titleOf(lines[i]).replace(/\s+/g, '') !== key) continue;
    const meta = lines.slice(i + 1, i + 1 + NAMED_META);
    const n = meta.findIndex((l) => !(LABEL.test(l) || (l.length <= BY_LINE_CHARS && (ROLE_END.test(l) || TRANSLATOR.test(l))) || dateOf(l)));
    const run = n < 0 ? meta : meta.slice(0, n);
    if (!run.some((l) => ROLE_END.test(l) || /^(?:作者|著者|出版社)\s*[:：]/.test(l))) continue;
    const book = blank(named);
    for (const l of run) readMeta(book, l);
    book.cover = coverAbove(lines, i, 0);
    const after = i + 1 + run.length;
    book.blurb = lines.slice(after).filter((l) => !IMG.test(l) && !LABEL.test(l)).map((l) => l.replace(BLURB_HEAD, ''))
      .filter((l) => l.length > META_CHARS / 2).slice(0, BLURB_LINES).join('').slice(0, BLURB_CHARS);
    return [book];
  }
  return [];
}

function listedBooks(lines: string[]): ListedBook[] {
  const titled = lines.map((l, i) => {
    const t = LIST_TITLE.exec(l)?.[1] ?? bareTitleAt(lines, i);
    return t ? { i, title: t.trim(), skip: !LIST_TITLE.test(l) && /[：:]$/.test(l) ? 1 : 0 } : null;
  }).filter((x): x is { i: number; title: string; skip: number } => !!x);
  const at = titled.map((x) => x.i);
  const books = titled.map(({ i: t, title, skip }, n) => {
    const book = blank(title);
    // The cover sits just above the title, perhaps above its number too.
    book.cover = coverAbove(lines, t, n ? at[n - 1] + 1 : 0);
    const end = n + 1 < at.length ? at[n + 1] : lines.length;
    let j = t + 1 + skip;
    for (; j < Math.min(end, t + 1 + skip + META_LINES); j++) {
      const l = lines[j];
      if (IMG.test(l) || LIST_NUMBER.test(l) || l.length > META_CHARS || /[。！？]$/.test(l)) break;
      readListMeta(book, l);
    }
    // One book-review account prints it after who and where, before the blurb; an image right above the next
    // title is that book's.
    const below = IMG.exec(lines[j] ?? '');
    if (!book.cover && below && j < end - 2) book.cover = below[1];
    book.blurb = lines.slice(j, end).filter((l) => !IMG.test(l) && !LIST_NUMBER.test(l)).map((l) => l.replace(BLURB_HEAD, ''))
      .filter((l) => l.length > META_CHARS / 2)
      .slice(0, BLURB_LINES).join('').slice(0, BLURB_CHARS);
    return book;
  }).filter((b) => b.authors || b.publisher);
  return books.length >= MIN_LISTED ? books : [];
}
