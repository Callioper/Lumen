// Which entries are papers, and their bibliographic line, by rule only (论文周报, docs/简报周报检索存储方案.md §2).
// Journal feeds carry papers by definition; WeChat accounts repost them with 摘要/关键词 or a 原刊 line.
import { plainText } from '../content/sanitize.ts';
import { sourceRule } from './sources.ts';

export const JOURNAL_CATEGORIES = ['学术期刊'];
const LEAD_CHARS = 3000;
const TAIL_CHARS = 1500;      // where 本文原载《…》 sits after the references
const ABSTRACT_CHARS = 160;
const MAX_AUTHORS = 5;
const LONG_CHARS = 6000;     // a key account's post this long with notes reads as a paper
// Reposts, announcements and recommendations mention journals too (one account's picks said 发表于《…》).
const NOT_A_PAPER = /推文|书讯|新书|活动|讲座|征稿|招聘|招募|预告|会议通知|直播|目录|速览|一周|周报|合辑|书单|月榜|年榜|目次|^北大学人$/;
// A newspaper is not a journal: 发表于《文艺报》 marks a review or report.
const NEWSPAPER = /报$|日报|晚报|周刊$/;
// Column labels that accounts put where the author would go.
const COLUMN = /^(专题|学术|论文|推荐|新刊|特稿|首发|书评|访谈|网文榜|榜单|编者|导读|译文|文艺批评|科幻名家|学人|好文|荐读|研究|观点|编译|翻译)|(观点|专题|荐读)$/;
// A Chinese name is 2–4 characters; a transliterated one has a middle dot: · (米格尔·西卡特), ・ (格雷厄姆・哈曼), •.
// Initials and Latin names may sit between the dots: 艾琳・P・霍索恩, Judith・N.・Shklar.
const AUTHOR = /^(?:\p{Script=Han}{2,4}|[\p{Script=Han}A-Za-z.·・•]{3,30})$/u;
const isName = (n: string): boolean => AUTHOR.test(n) && (n.length <= 4 || /[·・•]/.test(n));

// summary: the entry's AI summary (HTML), what stands in for an abstract the post does not give.
export interface PaperInput { title: string; feedTitle: string; category: string | null; view: string; html: string; author: string | null; summary?: string | null }
// abstractBy: 'ai' when the abstract is the AI summary's opening, the post having none.
export interface Paper { authors: string; title: string; venue: string; abstract: string; via: 'journal' | 'repost'; abstractBy?: 'ai' }

// The issue as accounts write it: 2026年第5期, 2026年10月刊, 2023年5月号, 2026年秋季刊, 第十辑, 第35卷, 第27期.
const SOURCE_LINE = /(?:(?:原文)?出\s*处\s*[:：]|原(?:刊|载|文刊|文载)(?:于)?|刊(?:载|发)于|(?:全文)?载于|发表于|来源[:：于]|本文(?:原)?(?:刊|载|发表)于)\s*(?:学术期刊|期刊|杂志)?\s*[《〈『]\s*([^》〉』]{2,40}?)\s*[》〉』]\s*(?:[（(][^）)]{1,40}[）)])?\s*[，,]?\s*([0-9]{4}\s*年\s*(?:第?\s*[0-9]{1,2}\s*期|[0-9]{1,2}\s*月\s*[刊号]|[春夏秋冬]季?\s*[刊号])|第\s*[0-9一二三四五六七八九十]{1,3}\s*辑|第\s*[0-9]{1,3}\s*卷(?:\s*第?\s*[0-9]{1,2}\s*[期号])?|第\s*[0-9]{1,3}\s*期)?/;
// A reference in GB/T 7714 after the text (引用格式：沈知远. 题名[J].外国美学,2025,(2):52-66.).
const CITATION = /\[J\]\s*[.．]\s*([^,，.\[\]]{2,30}?)\s*[,，]\s*([0-9]{4})\s*[,，]\s*(?:[0-9]+\s*)?[（(]\s*([0-9]{1,2})\s*[)）]/;
const ISSUE_LINE = /[《〈『]([^》〉』]{2,40})[》〉』]\s*(?:[（(][^）)]{1,40}[）)])?\s*[，,]?\s*([0-9]{4})\s*年\s*第?\s*([0-9]{1,2})\s*期/;
// Labels of an abstract: 摘要, 内容提要, 提要.
const ABSTRACT_LABEL = /(?:摘\s*要|内容提要|提\s*要)\s*[:：\]】]/;
const KEYWORDS = /关\s*键\s*词\s*[:：\]】]/;
// One 学报 writes 摘要 and 关键词 with no colon; both must be there then.
const LOOSE_ABSTRACT = /(?:^|\s)(?:摘\s*要|内容提要)\s+\S[\s\S]{20,}?\s关\s*键\s*词\s+\S/;
// A translation's source given as a reference: 来源：Bauman, Z. (1987). "The Importance of Being a Marxist." …
// A translation naming its original: 原文『The Justification of Civil Disobedience』最初收入…
const ORIGINAL = /原文\s*[『《]\s*([^』》]{4,120}?)\s*[』》]/;
const CITED_SOURCE =/来源\s*[:：]\s*([A-Z][A-Za-z'’-]+,\s*[A-Z][^()]{0,60}\(\d{4}\)\.\s*[^一-鿿]{5,160})/;
// Notes or references: what tells a paper from a magazine piece when the issue has no year (《Aperture》第264期).
const NOTES = /参考文献|注释|\[1\]|①/;

// Journal feeds' content is the abstract itself; reposts label it 摘要 or 内容提要.
function abstractOf(text: string, whole: boolean): string {
  const m = whole ? [text, text] : /(?:摘\s*要|内容提要|提\s*要)\s*[:：\]】\s]\s*([\s\S]{20,}?)(?=关\s*键\s*词|$)/.exec(text)
    // 文学博士。摘要要了解百年来…: the label run into the text, at the start of a sentence.
    ?? /(?:^|[。！？])(?:摘\s*要|内容提要)([\s\S]{20,}?)(?=关\s*键\s*词|$)/.exec(text);
  if (!m) return '';
  return firstSentences(m[1]);
}

function firstSentences(raw: string): string {
  // CNKI starts some abstracts with its <正> (body text) marker.
  const a = raw.replace(/\s+/g, ' ').replace(/^\s*<正>\s*/, '').replace(/[.…]{2,}$/, '').trim();
  // The first one or two sentences: a paper's claim is usually stated up front.
  const sentences = a.match(/[^。！？]+[。！？]/g) ?? [a];
  let out = '';
  for (const s of sentences) { if (out && (out + s).length > ABSTRACT_CHARS) break; out += s; }
  return out.slice(0, ABSTRACT_CHARS * 1.5);
}

// 「作者｜题名」 and 「作者：题名」 are how accounts head a reposted paper. A column label in front
// (学术论文｜周末、沈禾：…) is dropped and the rest tried again.
export function splitHeading(title: string): { authors: string; title: string } {
  const m = /^\s*([^｜|丨：:]{2,30}?)\s*[｜|丨]\s*(.+)$/.exec(title) ?? /^\s*([^｜|丨：:]{2,16}?)\s*[：:]\s*(.+)$/.exec(title)
    // 慕唯仁——全球资本主义与政治的自我否定逻辑: a dash heads with the author only when it is a name.
    ?? ((d) => d && isName(d[1]) ? d : null)(/^\s*([^｜|丨：:—]{2,14}?)\s*——\s*(.+)$/.exec(title));
  if (!m) return { authors: '', title: title.trim() };
  const who = m[1].trim();
  if (COLUMN.test(who)) return splitHeading(m[2]);
  const names = who.split(/[\s、，,&＆]+/).filter(Boolean);
  if (names.length <= MAX_AUTHORS && names.every(isName)) return { authors: names.join('、'), title: m[2].trim() };
  // An occasion in front (鲁迅逝世90周年｜李音：…): keep it only if the rest names the author.
  const rest = splitHeading(m[2]);
  return rest.authors ? rest : { authors: '', title: title.trim() };
}

// Words that follow 本文作者 in prose (本文作者指出，…), not names.
const PROSE_AFTER_AUTHOR = /^(指出|认为|提出|主张|强调|表示|发现|写道|谈到|观点|继而|进一步|还|也|则|是|系|为)/;

// Names as a list: 李阳 / 李 阳 (WeChat spaces out two-character names) / 周末、沈禾. Stops at the
// first part that is not a name; empty if none is.

function nameList(seg: string): string {
  const parts = seg.replace(/(^|[、，,\s])(\p{Script=Han})\s(\p{Script=Han})(?=$|[、，,\s])/gu, '$1$2$3').split(/[、，,\s]+/).filter(Boolean);
  const names: string[] = [];
  for (const p of parts) { if (!isName(p) || PROSE_AFTER_AUTHOR.test(p) || names.length >= MAX_AUTHORS) break; names.push(p); }
  return names.join('、');
}

// When the headline names no author: 本文作者李 阳 / 作者：… in the text (a bare 作者 is prose: 作者指出), else the account's byline
// (原创 李阳 2026-10-16 08:00), unless that byline is the account itself.
export function authorsInText(text: string, feed: string): string {
  for (const m of text.matchAll(/(?:本文作者\s*[:：|｜丨]?|作\s*者\s*[:：|｜丨])\s*/g)) {
    const seg = text.slice(m.index + m[0].length, m.index + m[0].length + 30).split(/摘\s*要|简\s*介|介\s*绍|单\s*位|译\s*者|[。（(|｜丨:：]/)[0];
    const names = nameList(seg);
    if (names) return names;
  }
  const by = /^(?:原创\s+)?(.{2,30}?)\s+\d{4}-\d{2}-\d{2}/.exec(text);
  const names = by ? nameList(by[1]) : '';
  return names && names !== feed ? names : '';
}

// CNKI lists authors as 杨华;余思;
const journalAuthors = (a: string | null): string => (a ?? '').split(/[;；,，]/).map((x) => x.trim()).filter(Boolean).join('、');

export function detectPaper(e: PaperInput): Paper | null {
  // Podcasts and Douban posts quote journals in passing.
  if (e.view !== 'article' || NOT_A_PAPER.test(e.title)) return null;
  const whole = plainText(e.html);
  const text = whole.slice(0, LEAD_CHARS);
  const isJournal = !!e.category && JOURNAL_CATEGORIES.includes(e.category);
  const rule = sourceRule(e.feedTitle);
  const hasAbstract = (ABSTRACT_LABEL.test(text) && KEYWORDS.test(text)) || LOOSE_ABSTRACT.test(text);
  const hasNotes = NOTES.test(whole);
  // Poems and fiction in a literary journal's account carry neither.
  if (rule?.literary && !hasAbstract && !hasNotes) return null;
  const cited = CITED_SOURCE.exec(whole);
  // Accounts put 本文原载《…》某年第几期 at the head or after the references; one with the issue wins.
  // A key account may say where it was published mid-text (right after its preface).
  const places = rule ? [text, whole.slice(-TAIL_CHARS), whole] : [text, whole.slice(-TAIL_CHARS)];
  const quotes = places.map((t) => SOURCE_LINE.exec(t)).filter((m): m is RegExpExecArray => !!m && !NEWSPAPER.test(m[1]));
  const source = quotes.find((m) => m[2]) ?? quotes[0] ?? null;
  const issue = ISSUE_LINE.exec(text);
  const citation = CITATION.exec(whole.slice(-TAIL_CHARS));
  // A source line without an issue is too loose alone (发表于《收获》 in a podcast note); an issue
  // without a year or 辑 (第264期) needs notes too. A 辑 can sit inside the name: 《区域（第二辑）》.
  const numbered = !!source && (source[2] ? /年|辑/.test(source[2]) : /第.{1,3}辑/.test(source[1]));
  // On a key account a volume and issue with no year will do (『Religion Compass』第20卷第3期).
  const dated = numbered || (!!source?.[2] && (hasNotes || !!rule));
  const head = isJournal ? { authors: '', title: e.title.trim() } : splitHeading(e.title);
  const keyLong = !!rule && hasNotes && whole.length > LONG_CHARS && !!head.authors;
  if (!isJournal && !hasAbstract && !dated && !cited && !keyLong && !citation) return null;
  // A journal item without authors is a 目次 or a column page.
  if (isJournal && !journalAuthors(e.author)) return null;
  const venue = isJournal ? e.feedTitle
    : source ? `《${source[1]}》${source[2] ? source[2].replace(/\s+/g, '') : ''}`
    : issue ? `《${issue[1]}》${issue[2]}年第${issue[3]}期`
    : citation ? `《${citation[1].trim()}》${citation[2]}年第${citation[3]}期`
    : cited ? cited[1].trim().replace(/\s+/g, ' ')
    : rule?.journal ? `《${rule.journal}》`
    : ((o) => o ? `原文『${o[1].replace(/\s+/g, ' ')}』` : '')(ORIGINAL.exec(text));
  return {
    authors: head.authors || (isJournal ? journalAuthors(e.author) : authorsInText(text, e.feedTitle)),
    title: head.title.replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, '$1'),
    venue,
    ...abstractWithFallback(abstractOf(text, isJournal), e.summary),
    via: isJournal ? 'journal' : 'repost',
  };
}

// A repost without 摘要 (many give only an 编者按) takes the opening of its AI summary, marked as such.
function abstractWithFallback(own: string, summary: string | null | undefined): Pick<Paper, 'abstract' | 'abstractBy'> {
  if (own) return { abstract: own };
  const ai = summary ? firstSentences(plainText(summary)) : '';
  return ai ? { abstract: ai, abstractBy: 'ai' } : { abstract: '' };
}
