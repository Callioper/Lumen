// 人大复印报刊资料: which articles its journals took up whole (全文转载), read by the AI (extract.ts)
// from the 书报资料中心's own posts. Two kinds: 「抢鲜看 | 最新目录与文章摘要」 sets several 复印 journals'
// contents out as text, each article with its abstract and 【原文出处】; 「关注 | 全文转载文章目录」 sets
// each journal's contents page down as a picture, read by OCR (ocr.ts) — 22 pictures in 22 s, the
// 基础教育 series (中学化学教与学, 初中语文教与学 …) in October 2026. What was taken up marks its
// article where it shows elsewhere: 期刊目录 and 论文周报, matched by title.
import type { DB } from '../db.ts';
import type { Settings } from '../config.ts';
import type { ChatMessage } from '../ai/llm.ts';
import { extracted, postLines, str, strs, type Extractor, type Post } from './extract.ts';
import { canOcr, ocrImages, postImages } from './ocr.ts';
import { log } from '../log.ts';

export interface ReprintArticle { title: string; subtitle: string; authors: string[]; page: string; source: string; abstract: string }
export interface ReprintSection { name: string; articles: ReprintArticle[] }
export interface ReprintIssue { name: string; code: string; issue: string; sections: ReprintSection[] }

export const REPRINT_VERSION = 1;
const ABSTRACT_CHARS = 400;
// A post whose text is shorter than this (bar the subscription table) prints its contents in pictures.
const THIN_TEXT = 1500;
const TEXT_CHARS = 40_000;
const MATCH_CHARS = 12;
const MIN_KEY = 6;

const SYSTEM = '你从人大复印报刊资料的推文里抽取各刊全文转载的文章目录，只输出 JSON，不加说明。';
const prompt = (title: string, text: string): string => `推文标题：${title}

推文列出复印报刊资料若干刊某一期全文转载的文章。正文可能是推文文字，也可能是图片识别出的文字（按【图N】分开，同一刊的目录可能接着占两张图；识别文字里混着主管主办、编委会、电话、邮发代号等版权页信息，一律不收）。
输出 JSON：
{"journals":[{"name":"复印刊名，如 出版业、文艺理论、中学化学教与学，不带书名号","code":"刊的代码如 J1，没有则空","issue":"如 2026年第10期","sections":[{"name":"栏目名，没有则空","articles":[{"title":"主标题","subtitle":"副标题，去掉开头的破折号，没有则空","authors":["作者"],"page":"页码，没有则空","source":"原文出处，如 《中国出版》2026年第4期，没有则空","abstract":"推文印的摘要，照抄，不超过300字；没有则空"}]}]}]}
规则：
- 标题跨行时接起来；以 —— 或 - 开头的那行是副标题。
- 作者名去掉空格；「张瑾等」照写。
- 观点摘编、相关题录、索引、卷首语、启事不是文章，不收。
- 推文不是复印报刊资料的转载目录时输出 {"journals":[]}。

推文正文：
${text}`;

// The 书报资料中心's contents posts; its other posts (立项名单, 征订, 喜报) are not.
function candidates(db: DB, since: number): Post[] {
  return db.prepare(`SELECT e.id, e.title, e.published FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.published > ? AND f.view = 'article' AND (e.title LIKE '%全文转载%目录%' OR e.title LIKE '%复印报刊资料最新目录%')
    ORDER BY e.published DESC`).all(since) as unknown as Post[];
}

// What a contents page prints besides the contents: the imprint, set beside them.
const IMPRINT = /^(?:主\s*管|主\s*办|编辑出版|中心主任|副总编辑|编委会|责任编辑|出版单位|大街|电\s*话|电子信箱|刊\s*号|ISSN|CN\s*\d|出版日期|印\s*刷|发行|国内发行|国外发行|邮发|订\s*购|订购电话|开户|户\s*名|账\s*号|广告|京海|扫一扫|刊物如有|请联系|敬请|与书报|\(010\)|有限公司)/;

// The post's text, or, where that is a line or two and a subscription table, what its pictures read.
async function text(html: string, settings: Settings): Promise<string> {
  const own = postLines(html).join('\n');
  const images = postImages(html);
  if (own.replace(/\s/g, '').length >= THIN_TEXT || !images.length || !canOcr()) return own;
  try {
    const read = await ocrImages(images, settings);
    const pages = read.map((lines, i) => ({ i, lines: lines.filter((l) => !IMPRINT.test(l)) })).filter((p) => p.lines.length >= 5);
    return pages.map((p) => `【图${p.i + 1}】\n${p.lines.join('\n')}`).join('\n') || own;
  } catch (e) {
    log.warn(`[复印] OCR 没跑成，只读推文文字：${(e as Error).message}`);
    return own;
  }
}

const DASH = /^[\s—–-]+/;
function article(raw: unknown): ReprintArticle | null {
  const a = (raw ?? {}) as Record<string, unknown>;
  const title = str(a.title);
  if (!title) return null;
  return { title, subtitle: str(a.subtitle).replace(DASH, ''), authors: strs(a.authors).map((n) => n.replace(/\s+/g, '')),
    page: str(a.page), source: str(a.source), abstract: str(a.abstract).slice(0, ABSTRACT_CHARS) };
}

export function readReprints(raw: unknown): ReprintIssue[] | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const issues = (Array.isArray(r.journals) ? r.journals : []).map((j) => {
    const x = (j ?? {}) as Record<string, unknown>;
    const sections = (Array.isArray(x.sections) ? x.sections : []).map((s) => {
      const sec = (s ?? {}) as Record<string, unknown>;
      return { name: str(sec.name), articles: (Array.isArray(sec.articles) ? sec.articles : []).map(article).filter((a): a is ReprintArticle => !!a) };
    }).filter((s) => s.articles.length);
    return { name: str(x.name).replace(/^《|》$/g, ''), code: str(x.code), issue: str(x.issue), sections };
  }).filter((j) => j.name && j.sections.length);
  return issues.length ? issues : null;
}

export const reprintExtractor: Extractor<ReprintIssue[]> = {
  kind: 'reprint', label: '人大复印', version: REPRINT_VERSION, maxTokens: 16_000, textChars: TEXT_CHARS,
  candidates,
  ask: (post, t): ChatMessage[] => [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(post.title, t) }],
  read: (raw) => readReprints(raw),
  text,
};

export interface Reprinted { issue: ReprintIssue; post: { id: number; title: string; feedId: number; feed: string; published: number; link: string | null } }

// The 复印 journals of the humanities: 文学、哲学、史学、艺术、语言, and 新闻、出版、档案 beside them.
// Of the 94 read by 2026-10-24 that leaves 35; the 基础教育 series (中学化学教与学 …), law, economics
// and management go. 「中学历史、地理教与学」 is a school one and stays out; 「法理学、法史学」 too.
const HUMANITIES = /哲学|美学|逻辑|宗教|文艺理论|文学|语言文字|文化研究|艺术|新闻与传播|出版业|档案学|考古|(?:古代|近代|现代|世界|明清|宋辽金元|魏晋南北朝隋唐|先秦、秦汉|经济)史/;
export const isHumanities = (name: string): boolean => HUMANITIES.test(name);

// Each 复印 issue once, from its newest post (the account posts each month's contents twice);
// humanities: only the humanities' journals.
export function reprintIssues(db: DB, humanities = false): Reprinted[] {
  const seen = new Set<string>();
  const out: Reprinted[] = [];
  for (const { data, post } of extracted<ReprintIssue[]>(db, 'reprint', REPRINT_VERSION)) {
    for (const issue of data) {
      const k = `${bare(issue.name)}|${bare(issue.issue)}`;
      if (seen.has(k) || humanities && !isHumanities(issue.name)) continue;
      seen.add(k);
      out.push({ issue, post });
    }
  }
  return out;
}

const bare = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, '');
const keyOf = (title: string): string => { const k = bare(title).slice(0, MATCH_CHARS); return k.length >= MIN_KEY ? k : ''; };

// 人大复印《出版业》2026年第8期, the badge a reprinted article carries elsewhere.
export const reprintLabel = (i: Pick<ReprintIssue, 'name' | 'issue'>): string => `人大复印《${i.name}》${i.issue}`;

// Titles reprinted, by the opening of the title; the first (newest) issue that took it up.
export function reprintIndex(db: DB): (title: string) => string | undefined {
  const by = new Map<string, string>();
  for (const { issue } of reprintIssues(db)) {
    for (const a of issue.sections.flatMap((s) => s.articles)) {
      const k = keyOf(a.title);
      if (k && !by.has(k)) by.set(k, reprintLabel(issue));
    }
  }
  return (title) => { const k = keyOf(title); return k ? by.get(k) : undefined; };
}

// ── 新书 ──────────────────────────────────────────────────────────────────────────────────────────
// 人大复印 takes up articles, not books; a book shows what it took up about the book or by its author.
// review: an article whose title names the book in 《》 (a 书评, or a study of it); author: an article
// by one of the book's Chinese authors, matched by name, so two people of one name are one here: the
// badge says which article, to be judged.
export interface BookReprint { review?: { title: string; label: string }; author?: { name: string; title: string; label: string } }

const ROLES = new Set(['编著', '主编', '选编', '编选', '校注', '整理', '编译', '等著', '合著']);
const ROLE_END = /(?:等)?(?:编著|主编|选编|编选|校注|整理|编译|著|编|译|撰)$/;
// The Chinese names a book prints: 「张三、李四 主编」 → 张三, 李四. Foreign names (尤金·罗根) are not
// matched: 人大复印 reprints Chinese journals, and a foreign author's name there is a translator's work.
export function bookAuthorNames(authors: string): string[] {
  return authors.replace(/[[［【(（〔][^\]］】)）〕]*[\]］】)）〕]/g, ' ').split(/[、，,；;／/\s]+/)
    .map((n) => (ROLES.has(n) ? '' : n.replace(ROLE_END, '')))
    .filter((n) => /^\p{Script=Han}{2,4}$/u.test(n));
}
const MIN_BOOK_KEY = 3;
const bookKey = (title: string): string => bare(title.replace(/^《(.*)》$/, '$1').split(/[：:（(]/)[0]);

export function reprintBookIndex(db: DB, humanities = false): (b: { title: string; authors: string }) => BookReprint | undefined {
  const reviews = new Map<string, { title: string; label: string }>();
  const byName = new Map<string, { name: string; title: string; label: string }>();
  for (const { issue } of reprintIssues(db, humanities)) {
    const label = reprintLabel(issue);
    for (const a of issue.sections.flatMap((s) => s.articles)) {
      const title = a.subtitle ? `${a.title}——${a.subtitle}` : a.title;
      for (const m of title.matchAll(/《([^》]+)》/g)) {
        const k = bookKey(m[1]);
        if (k.length >= MIN_BOOK_KEY && !reviews.has(k)) reviews.set(k, { title, label });
      }
      for (const n of a.authors.map((x) => x.replace(/等$/, ''))) if (!byName.has(n)) byName.set(n, { name: n, title, label });
    }
  }
  return (b) => {
    const k = bookKey(b.title);
    const review = k.length >= MIN_BOOK_KEY ? reviews.get(k) : undefined;
    const author = bookAuthorNames(b.authors).map((n) => byName.get(n)).find(Boolean);
    return review || author ? { ...(review && { review }), ...(author && { author }) } : undefined;
  };
}
