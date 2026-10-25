// Note metadata for an archived article: a cleaned title, who wrote and translated it (in
// the Chinese form the name library uses), where a repost came from, its kind, keywords and
// tags from the tag library. The model proposes; everything it names is checked against the
// article text, so a guess that is not in the text does not reach the note.
import type { Settings } from '../config.ts';
import { chat } from '../ai/llm.ts';
import type { CleanFacts } from './clean.ts';
import { findPerson, isChinese, nameKey, type Person } from './library.ts';

export const ARTICLE_TYPES = ['学术论文', '书籍章节', '评论', '访谈', '书评', '讲座', '会议综述', '译文', '随笔', '新闻资讯', '书讯', '活动', '其他'] as const;
export type ArticleType = typeof ARTICLE_TYPES[number];

export interface Name { zh: string; original: string }

export interface ArticleMeta {
  title: string;               // without author or column prefix
  authors: Name[];
  translators: Name[];
  original: { title: string; authors: string[]; date: string } | null;  // for translations
  origin: string;              // where a repost first appeared
  type: ArticleType;
  keywords: string[];
  tags: string[];
  newTags: string[];           // tags the library does not have yet
  source: 'ai' | 'rules';
}

const HEAD_CHARS = 3500;
const TAIL_CHARS = 1500;
const MAX_KEYWORDS = 6;
const MAX_TAGS = 4;
const MAX_NEW_TAGS = 1;
const MAX_TAG_CHARS = 20;
const MAX_KEYWORD_CHARS = 16;
const MIN_TITLE_CHARS = 4;
const TITLE_ZONE_CHARS = 3000;
const METADATA_MAX_TOKENS = 1500;
const METADATA_TIMEOUT_MS = 90_000;

export interface MetaInput {
  title: string;
  feed: string;
  author: string;              // the feed's author field, often empty
  facts: CleanFacts;
  markdown: string;            // cleaned article
}

const squash = (s: string): string => s.toLowerCase().replace(/[\s|｜丨:：·•\-—_*【】[\]（）()“”"'‘’《》〈〉,，.。!！?？]/g, '');
const inText = (needle: string, hay: string): boolean => !!needle.trim() && squash(hay).includes(squash(needle));

export function excerpt(markdown: string): string {
  const text = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\]\([^)]*\)/g, ']');
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n\n……（中略）……\n\n${text.slice(-TAIL_CHARS)}`;
}

export function buildMessages(input: MetaInput, tagLibrary: string[]): { role: 'system' | 'user'; content: string }[] {
  const system = `你为一个人文学者的 Obsidian 文献库整理网页文章的著录信息。只根据给出的文字判断，不要凭记忆补充文中没有的信息。只输出一个 JSON 对象，不要解释。

字段：
- title：文章本身的正式题目。转载的论文、讲稿、书评常被公众号另起一个推送标题（导语式、问句式、摘一句话做标题），这时以正文里印出的正式题目为准——它通常出现在题头、作者简介前后、"原文出处"或"引用格式"里，原样照抄，含副标题。正文里没有另印题目时，用推送标题，去掉公众号栏目名、期号、"作者｜"之类前缀。
- authors：作者，数组，每项 {"zh": 中文名, "original": 原文名}。外国人写中文通行译名，原文名写文中出现的拼写；中国人 original 留空。署名行里的名字可能只是公众号编辑，以正文的"文/作者/撰文/主讲"等为准。机构或公众号不算作者。找不到就给空数组。
- translators：译者，格式同上；不是译文就给空数组。
- original：若是译文，{"title": 原文题目, "authors": [原文作者名], "date": 原文发表时间，写成 yyyy、yyyymm 或 yyyymmdd}；不是译文给 null。只写文中出现过的原文题目。
- origin：若是转载/搬运，写首发出处，如"原载《文艺研究》2025年第4期"或"转自微信公众号「XX」"；原创给空字符串。
- type：从 ${ARTICLE_TYPES.join('、')} 中选一个。
- keywords：3–6 个中文关键词，概括主题，不要写人名。
- tags：从标签库里选 1–4 个，原样照抄。只选确实对应文章主题的，宁少勿滥；分层标签要看最末一级是否相符（写侦探小说的文章不能选「类型文学/推想小说/科幻小说」）；库里没有贴切的，额外给 1 个新标签（与库里风格一致，可用 / 分层）。`;
  const lines = [
    `订阅源：${input.feed}`,
    `原标题：${input.title}`,
    input.author && `作者字段：${input.author}`,
    input.facts.byline && `署名行：${input.facts.byline}`,
    input.facts.sourceAccount && `"以下文章来源于"：${input.facts.sourceAccount}`,
    input.facts.origin && `文中出处信息：${input.facts.origin}`,
    input.facts.citation && `引用格式：${input.facts.citation}`,
    '',
    `标签库：${tagLibrary.join('、')}`,
    '',
    '正文：',
    excerpt(input.markdown),
  ].filter((l): l is string => typeof l === 'string');
  return [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }];
}

// The first {...} block, with or without a code fence around it.
export function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 没有返回 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function names(v: unknown, text: string, people: Person[]): Name[] {
  if (!Array.isArray(v)) return [];
  const out: Name[] = [];
  for (const item of v) {
    const zh = str((item as Record<string, unknown>)?.zh);
    const original = str((item as Record<string, unknown>)?.original);
    const known = findPerson(people, zh, original);
    const zhSeen = inText(zh, text);
    const originalSeen = inText(original, text) || (!!known && nameKey(known.original) === nameKey(original));
    if (!zhSeen && !originalSeen && !known) continue;     // a name the text never mentions
    const name = { zh: zh || original, original: originalSeen ? original : '' };
    if (!out.some((n) => nameKey(n.zh) === nameKey(name.zh))) out.push(name);
  }
  return out;
}

// The model's title is kept when it is the push headline with something trimmed off, or when it
// is printed in the article itself: a paper reposted under an editor's headline keeps its own title.
export function cleanTitle(proposed: string, original: string, text = ''): string {
  const p = squash(proposed);
  if (p.length < MIN_TITLE_CHARS) return original.trim();
  return squash(original).includes(p) || squash(text).includes(p) ? proposed.trim() : original.trim();
}

const digits = (s: string): string => s.replace(/\D/g, '').slice(0, 8);

const CN_DIGITS: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

// 二十三 → 23, 十 → 10, 一〇二 → 102: enough for issue and volume numbers.
function cnNumber(s: string): string {
  if (!s.includes('十')) return [...s].map((c) => CN_DIGITS[c]).join('');
  const [tens, ones] = s.split('十');
  return String((tens ? CN_DIGITS[tens] : 1) * 10 + (ones ? CN_DIGITS[ones] : 0));
}

export const numbersIn = (s: string): string[] =>
  s.replace(/[〇零一二两三四五六七八九十]+/g, cnNumber).match(/\d+/g)?.map((n) => String(Number(n))) ?? [];

// "原文载于《英语研究》2026第二十三辑，经期刊与作者授权由…推出。" → "原文载于《英语研究》2026第二十三辑"
const shortOrigin = (s: string): string => s.split(/[，,；;。]\s*(?:经|由|并|本文|特此|转载|授权|感谢)/)[0].replace(/[，,。；;\s]+$/, '').trim();

// The model tends to normalise issue numbers ("第二十三辑" → "第1期"); its version is used only
// when every number in it is in the text it came from.
function checkedOrigin(proposed: string, input: MetaInput, text: string): string {
  const fallback = input.facts.origin ? shortOrigin(input.facts.origin)
    : input.facts.sourceAccount ? `转自微信公众号「${input.facts.sourceAccount}」` : '';
  if (!proposed) return fallback;
  const source = new Set(numbersIn(input.facts.origin || text));
  return numbersIn(proposed).every((n) => source.has(n)) ? proposed : fallback;
}

// "周展安 | 人工智能背景下的学术自觉" → "人工智能背景下的学术自觉" once 周展安 is known as the author.
export function stripAuthorPrefix(title: string, authors: Name[]): string {
  const m = /^(.{1,40}?)\s*[|｜丨:：]\s*(.+)$/.exec(title);
  if (!m || !authors.length) return title;
  const prefix = squash(m[1]);
  const named = authors.flatMap((a) => [a.zh, a.original]).filter(Boolean).map(squash);
  const all = squash(authors.map((a) => a.zh).join(''));
  return prefix === all || named.includes(prefix) ? m[2].trim() : title;
}

export function validateMetadata(raw: unknown, input: MetaInput, tagLibrary: string[], people: Person[]): ArticleMeta {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = [input.title, input.author, input.facts.byline, input.facts.origin, input.facts.citation, input.markdown].join('\n');
  const o = r.original && typeof r.original === 'object' ? r.original as Record<string, unknown> : null;
  const originalTitle = o ? str(o.title) : '';
  const original = originalTitle && inText(originalTitle, text)
    ? { title: originalTitle, authors: strings(o?.authors).filter((a) => inText(a, text)), date: digits(str(o?.date)) }
    : null;
  const library = new Set(tagLibrary);
  const tags = strings(r.tags).map((t) => t.replace(/^#/, '').replace(/\s+/g, '')).filter((t) => t && t.length <= MAX_TAG_CHARS);
  const known = [...new Set(tags.filter((t) => library.has(t)))].slice(0, MAX_TAGS);
  const fresh = [...new Set(tags.filter((t) => !library.has(t)))].slice(0, MAX_NEW_TAGS);
  const type = ARTICLE_TYPES.find((t) => t === str(r.type)) ?? '其他';
  const authors = names(r.authors, text, people);
  return {
    // Only the head and the citation lines count, so a section heading further down cannot pass for the title.
    title: stripAuthorPrefix(cleanTitle(str(r.title), input.title,
      [input.markdown.slice(0, TITLE_ZONE_CHARS), input.facts.citation, input.facts.origin].join('\n')), authors),
    authors: authors.length ? authors : fallbackAuthors(input),
    translators: names(r.translators, text, people),
    original,
    origin: checkedOrigin(str(r.origin), input, text),
    type: original && type === '其他' ? '译文' : type,
    keywords: [...new Set(strings(r.keywords).filter((k) => k.length <= MAX_KEYWORD_CHARS))].slice(0, MAX_KEYWORDS),
    tags: [...known, ...fresh].slice(0, MAX_TAGS),
    newTags: fresh,
    source: 'ai',
  };
}

function fallbackAuthors(input: MetaInput): Name[] {
  const who = input.author.trim() || input.facts.byline.trim();
  return who ? who.split(/[、,，/]\s*/).filter(Boolean).map((n) => ({ zh: n, original: '' })) : [];
}

export function ruleMetadata(input: MetaInput): ArticleMeta {
  return {
    title: input.title.trim(),
    authors: fallbackAuthors(input),
    translators: [],
    original: null,
    origin: checkedOrigin('', input, ''),
    type: '其他',
    keywords: [],
    tags: [],
    newTags: [],
    source: 'rules',
  };
}

export async function extractMetadata(input: MetaInput, tagLibrary: string[], people: Person[],
  settings: Settings, apiKey: string): Promise<ArticleMeta> {
  // Bibliographic fields need no reasoning; thinking would only add minutes.
  const extra = /minimax/i.test(settings.ai.baseUrl) ? { thinking: { type: 'disabled' } } : {};
  const out = await chat(buildMessages(input, tagLibrary), settings, apiKey, METADATA_MAX_TOKENS, METADATA_TIMEOUT_MS, extra);
  return validateMetadata(extractJson(out), input, tagLibrary, people);
}

// ---- names as the note writes them ----

export interface ResolvedName { zh: string; original: string; link: string; isNew: boolean }

// The library's Chinese form wins; a page in 350 Authors gets linked under that Chinese name.
export function resolveName(n: Name, people: Person[], pages: Map<string, string>): ResolvedName {
  const known = findPerson(people, n.zh, n.original);
  const zh = known && isChinese(known.zh) ? known.zh : isChinese(n.zh) ? n.zh : known?.zh || n.zh || n.original;
  const original = known?.original || (n.original !== zh ? n.original : '');
  const candidates = [zh, original, ...(known?.aliases ?? [])].filter(Boolean).map(nameKey);
  const page = candidates.map((k) => pages.get(k)).find(Boolean);
  const link = page && page !== zh ? `[[${page}|${zh}]]` : `[[${zh}]]`;
  return { zh, original, link, isNew: !known };
}

export function yyyymmdd(unixSeconds: number): string {
  const d = new Date((unixSeconds > 0 ? unixSeconds : Date.now() / 1000) * 1000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

const TITLE_AUTHORS = 2;   // more than this: 「甲、乙等」, the full list stays in author::

// 作者｜题目（20261021）; the feed stands in when no author is known. A title that already
// begins with its author (公众号's 「吴子枫｜一切母牛都成了黑色的」) does not get the name twice.
export function displayTitle(authorsZh: string[], title: string, fallback: string, published: number): string {
  const names = [...new Set(authorsZh.filter(Boolean))];
  const who = names.length > TITLE_AUTHORS ? `${names.slice(0, TITLE_AUTHORS).join('、')}等` : names.join('、') || fallback;
  const own = [...names, fallback].filter(Boolean).find((n) => new RegExp(`^${escapeRe(n)}\\s*[｜|]\\s*`).test(title));
  const rest = own ? title.replace(new RegExp(`^${escapeRe(own)}\\s*[｜|]\\s*`), '') : title;
  return `${who ? `${who}｜` : ''}${rest}（${yyyymmdd(published)}）`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Translations keep their original under aliases, in the same 作者｜题目（时间） shape.
export function originalAlias(meta: ArticleMeta, published: number): string {
  if (!meta.original) return '';
  const who = meta.original.authors.join(', ') || meta.authors.map((a) => a.original).filter(Boolean).join(', ');
  return displayTitle(who ? [who] : [], meta.original.title, '', 0).replace(/（\d{8}）$/, `（${meta.original.date || yyyymmdd(published)}）`);
}

// Chinese characters count one each, other words one each, as Chinese word counts do.
export function wordCount(markdown: string): number {
  const text = markdown.replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '').replace(/\]\([^)]*\)/g, ']').replace(/[#>*_`|[\]-]/g, ' ');
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const words = text.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9\u00c0-\u024f]+(?:['’][A-Za-z]+)?/g)?.length ?? 0;
  return cjk + words;
}
