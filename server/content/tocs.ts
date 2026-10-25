// 期刊目录: the table of contents a journal's account posts for each issue, read by the AI (extract.ts)
// into sections and articles. What the AI gets wrong the same way each time is mended here, and the
// abstracts a post prints after its contents are hung on their articles by rule.
import type { DB } from '../db.ts';
import type { ChatMessage } from '../ai/llm.ts';
import { extracted, str, strs, type Extractor, type Post } from './extract.ts';
import { cnkiIssues, cnkiLinker } from './cnki.ts';
import { reprintIndex, reprintIssues } from './reprints.ts';

// link: the article on CNKI, or a CNKI search for it; lead: the abstract is the opening of the text.
// abstractFrom: the abstract is the CNKI feed's, the post printing none. reprint: the 人大复印 issue that
// took it up whole; reprintOf: in a 复印 issue, where it first came out.
export interface TocArticle { title: string; subtitle: string; authors: string[]; translators: string[]; page: string; abstract: string; keywords: string[]; link?: string; lead?: boolean; abstractFrom?: 'cnki'; reprint?: string; reprintOf?: string }
export interface TocSection { name: string; articles: TocArticle[] }
export interface Toc { journal: string; issue: string; sections: TocSection[] }

export const TOC_VERSION = 2;
const MIN_ARTICLES = 3;
const ABSTRACT_CHARS = 800;

const SYSTEM = '你从学术期刊公众号推文里抽取本期目录，只输出 JSON，不加说明。';
const prompt = (title: string, text: string): string => `推文标题：${title}

把推文里的期刊目录抽成 JSON：
{"journal":"刊名，不带书名号","issue":"如 2026年第2期 或 第15辑","sections":[{"name":"栏目名，没有栏目用空字符串","articles":[{"title":"主标题","subtitle":"副标题，去掉开头的破折号，没有则空","authors":["作者"],"translators":["译者"],"page":"起始页码，没有则空","abstract":"推文里印的这篇的摘要或内容提要，照抄原文，不超过400字；没印就空","keywords":["关键词"]}]}]}
规则：
- 只收本期刊登的文章；卷首语、编者按、版权信息、排版审核署名、往期链接、广告不收。
- 作者名去掉中间的空格（「赖   锐」→「赖锐」），国籍标注如〔新加坡〕保留在作者名前；「某某作」「某某译」里的「作」「译」不是名字的一部分。
- 一篇文章在目录和摘要部分各出现一次时只收一次，摘要和关键词归到这一篇上；摘要不要自己写或概括。
- 推文里不是某一刊某一期的目录（比如书目、软件目录、个人作品目录、多刊转载文章汇总）时输出 {"journal":"","issue":"","sections":[]}。

推文正文：
${text}`;

// Posts titled as a table of contents; 豆瓣 broadcasts and the like are not.
function candidates(db: DB, since: number): Post[] {
  return db.prepare(`SELECT e.id, e.title, e.published FROM entry e JOIN feed f ON f.id = e.feed_id
    WHERE e.published > ? AND f.view = 'article' AND (e.title LIKE '%目录%' OR e.title LIKE '%要目%')
    AND e.title NOT LIKE '%复印报刊资料%' AND e.title NOT LIKE '%全文转载%' ORDER BY e.published DESC`).all(since) as unknown as Post[];
}

const DASH = /^[\s—–-]+/;
const BY_LINE = /(?<=\S)[作著]$/;
const bare = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, '');

function article(raw: unknown): TocArticle | null {
  const a = (raw ?? {}) as Record<string, unknown>;
  let title = str(a.title);
  const subtitle = str(a.subtitle).replace(DASH, '');
  // 「守卫马克思主义——论……」 with the 论…… given again as the subtitle.
  if (subtitle) {
    const at = title.lastIndexOf(subtitle);
    if (at > 0 && at + subtitle.length === title.length) title = title.slice(0, at).replace(/[\s—–-]+$/, '');
  }
  if (!title) return null;
  const tidy = (names: string[]): string[] => names.map((n) => (n.startsWith('〔') ? n.replace(BY_LINE, '') : n).replace(/(?<=[一-鿿])\s+(?=[一-鿿])/g, ''));
  return { title, subtitle, authors: tidy(strs(a.authors)), translators: tidy(strs(a.translators)), page: str(a.page), abstract: str(a.abstract).slice(0, ABSTRACT_CHARS), keywords: strs(a.keywords) };
}

function readToc(raw: unknown, text: string): Toc | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const journal = str(r.journal).replace(/^《|》$/g, '');
  const sections = (Array.isArray(r.sections) ? r.sections : []).map((s) => {
    const sec = (s ?? {}) as Record<string, unknown>;
    return { name: str(sec.name), articles: (Array.isArray(sec.articles) ? sec.articles : []).map(article).filter((a): a is TocArticle => !!a) };
  });
  // A 特别企划's theme read as an article of its own: where the others have authors, one without is not one.
  const all = sections.flatMap((s) => s.articles);
  const authored = all.filter((a) => a.authors.length).length;
  const kept = sections.map((s) => ({ ...s, articles: authored * 2 > all.length ? s.articles.filter((a) => a.authors.length) : s.articles }))
    .filter((s) => s.articles.length);
  if (!journal || kept.reduce((n, s) => n + s.articles.length, 0) < MIN_ARTICLES) return null;
  return { journal, issue: str(r.issue), sections: withAbstracts(kept, text.split('\n')) };
}

const ABSTRACT = /^(?:【\s*)?(?:内容)?(?:摘\s*要|提\s*要)(?:\s*】)?\s*[:：]?\s*/;
const KEYWORDS = /^(?:【\s*)?关\s*键\s*[词字](?:\s*】)?\s*[:：]?\s*/;
const TITLE_WINDOW = 6;
const MATCH_CHARS = 10;

// A post that prints abstracts after its contents prints each under its title and authors,
// the title sometimes broken over lines: the lines just above an abstract name its article.
export function withAbstracts(sections: TocSection[], lines: readonly string[]): TocSection[] {
  const keys = sections.flatMap((s) => s.articles).map((a) => bare(a.title).slice(0, MATCH_CHARS)).filter((k) => k.length >= 4);
  const found = new Map<string, { abstract: string; keywords: string[] }>();
  for (let i = 0; i < lines.length; i++) {
    if (!ABSTRACT.test(lines[i])) continue;
    const head = bare(lines.slice(Math.max(0, i - TITLE_WINDOW), i).join(''));
    // The title nearest the abstract: the window may reach back into the contents or the last abstract.
    const key = keys.reduce<string | undefined>((best, k) => (head.lastIndexOf(k) > (best ? head.lastIndexOf(best) : -1) ? k : best), undefined);
    let body = lines[i].replace(ABSTRACT, '');
    let j = i + 1;
    for (; j < lines.length && !KEYWORDS.test(lines[j]) && !ABSTRACT.test(lines[j]) && j - i <= 6; j++) body += lines[j];
    const keywords = j < lines.length && KEYWORDS.test(lines[j]) ? lines[j].replace(KEYWORDS, '').split(/[；;，,、]\s*|\s{2,}/).map((s) => s.trim()).filter(Boolean) : [];
    if (key && body && !found.has(key)) found.set(key, { abstract: body.slice(0, ABSTRACT_CHARS), keywords });
  }
  if (!found.size) return sections;
  return sections.map((s) => ({ ...s, articles: s.articles.map((a) => ({ ...a, ...found.get(bare(a.title).slice(0, MATCH_CHARS)) })) }));
}

export const tocExtractor: Extractor<Toc> = {
  kind: 'toc', label: '期刊目录', version: TOC_VERSION, maxTokens: 8000,
  candidates,
  ask: (post, text): ChatMessage[] => [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(post.title, text) }],
  read: readToc,
};

type PostRef = { id: number; title: string; feedId: number; feed: string; published: number; link: string | null };
// One issue, from a post (post set) or from a CNKI feed (feed set). link: the issue on CNKI, or the
// journal's page there; inferred: the issue number was worked out from the dates of issue; partial:
// the feed may not have carried the whole issue.
export interface TocIssue extends Toc {
  key: string; source: 'post' | 'cnki' | 'reprint'; at: number; post: PostRef | null; feed: { id: number; title: string } | null;
  link: string; inferred: boolean; partial: boolean; articles: number;
}
export interface Count { label: string; n: number; group?: string }

// What kind of journal a name is, for the page's rows of journals: the subject ones first (a 外国语
// 大学学报 is a language journal, not a university's), then the universities' and the general ones.
export const JOURNAL_GROUPS = ['人大复印', '综合·学报', '文学', '外国文学', '外语', '哲学', '社会·青年', '其他'] as const;
const GROUP_RULES: [RegExp, string][] = [
  [/^人大复印·/, '人大复印'],
  [/外国文学|世界文学|比较文学|英语文学|外国语言文学/, '外国文学'],
  [/外语|外国语|语言/, '外语'],
  [/哲学/, '哲学'],
  [/学报|学刊|中国社会科学|文史哲|学术月刊|社会科学战线/, '综合·学报'],
  [/文学|文艺|小说|作家|文坛|诗|评论|文化/, '文学'],
  [/青年|儿童|社会|教育/, '社会·青年'],
];
export const journalGroup = (name: string): string => GROUP_RULES.find(([re]) => re.test(name))?.[1] ?? '其他';
export type TocSource = '' | 'post' | 'cnki' | 'reprint';

// Contents most of whose titles have no Chinese in them.
const HAN = /\p{Script=Han}/u;
const inEnglish = (t: Pick<TocIssue, 'sections'>): boolean => {
  const titles = t.sections.flatMap((s) => s.articles.map((a) => a.title));
  return titles.length > 0 && titles.filter((x) => !HAN.test(x)).length * 2 > titles.length;
};

// An issue the AI could not number is its post's own: two such posts may be two issues.
const issueKey = (t: Toc, postId: number): string => (bare(t.issue) ? `${bare(t.journal)}|${bare(t.issue)}` : `post:${postId}`);

// Every issue once (an account that posts the same contents twice, or two accounts that both post
// them), where its newest post stands: the fullest of the copies, a teaser of three articles giving way
// to the whole contents. Newest first, narrowed to one journal.
export function journalTocs(db: DB, opts: { journal: string; group?: string; source?: TocSource; humanities?: boolean; offset: number; limit: number }): { issues: TocIssue[]; total: number; journals: Count[]; sources: Count[] } {
  const link = cnkiLinker(db);
  const reprinted = reprintIndex(db);
  const at = new Map<string, number>();
  const posted: TocIssue[] = [];
  for (const { data, post } of extracted<Toc>(db, 'toc', TOC_VERSION)) {
    // An article the post printed no abstract for takes the CNKI feed's, when a feed carries it.
    const sections = data.sections.map((s) => ({ ...s, articles: s.articles.map((a) => {
      const cnki = a.abstract ? '' : link.abstract(a.title);
      const reprint = reprinted(a.title);
      return { ...a, link: link.article(a.title), ...(cnki && { abstract: cnki, abstractFrom: 'cnki' as const }), ...(reprint && { reprint }) };
    }) }));
    const issue: TocIssue = {
      ...data, sections, key: `post:${post.id}`, source: 'post', at: post.published, post, feed: null,
      link: link.journal(data.journal), inferred: false, partial: false, articles: data.sections.reduce((n, s) => n + s.articles.length, 0),
    };
    const k = issueKey(data, post.id);
    const i = at.get(k);
    if (i === undefined) { at.set(k, posted.length); posted.push(issue); continue; }
    // The fuller copy wins; of two as full, the Chinese one (a journal posting its 英文目录 after the
    // Chinese, as 中国青年研究 does, must not put the issue into English).
    const fuller = issue.articles > posted[i].articles || (issue.articles === posted[i].articles && inEnglish(posted[i]) && !inEnglish(issue));
    if (fuller) posted[i] = { ...issue, at: posted[i].at };       // linked to the post its contents came from
  }
  const fromCnki: TocIssue[] = cnkiIssues(db).map((c) => ({
    journal: c.journal, issue: c.issue, sections: [{ name: '', articles: c.articles }], key: `cnki:${c.feed.id}:${c.at}`, source: 'cnki' as const,
    at: c.at, post: null, feed: c.feed, link: c.link, inferred: c.inferred, partial: c.partial, articles: c.articles.length,
  })).map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, articles: s.articles.map((a) => { const reprint = reprinted(a.title); return reprint ? { ...a, reprint } : a; }) })) }));
  const fromReprint: TocIssue[] = reprintIssues(db, opts.humanities).map(({ issue, post }) => {
    const sections = issue.sections.map((s) => ({ name: s.name, articles: s.articles.map((a): TocArticle => ({
      title: a.title, subtitle: a.subtitle, authors: a.authors, translators: [], page: a.page, abstract: a.abstract, keywords: [],
      link: link.article(a.title), ...(a.source && { reprintOf: a.source }) })) }));
    return { journal: `人大复印·${issue.name}`, issue: issue.issue, sections, key: `reprint:${post.id}:${bare(issue.name)}`, source: 'reprint' as const,
      at: post.published, post, feed: null, link: link.journal(issue.name), inferred: false, partial: false,
      articles: sections.reduce((n, s) => n + s.articles.length, 0) };
  });
  const sources = [{ label: '公众号', n: posted.length }, { label: '知网', n: fromCnki.length }, { label: '人大复印', n: fromReprint.length }].filter((x) => x.n);
  const pool = opts.source === 'post' ? posted : opts.source === 'cnki' ? fromCnki : opts.source === 'reprint' ? fromReprint : [...posted, ...fromCnki, ...fromReprint];
  const all = pool.sort((a, b) => b.at - a.at);
  const counts = new Map<string, number>();
  for (const t of all) counts.set(t.journal, (counts.get(t.journal) ?? 0) + 1);
  const journals = [...counts].map(([label, n]) => ({ label, n, group: journalGroup(label) })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'zh'));
  const shown = opts.journal ? all.filter((t) => t.journal === opts.journal) : opts.group ? all.filter((t) => journalGroup(t.journal) === opts.group) : all;
  return { issues: shown.slice(opts.offset, opts.offset + opts.limit), total: shown.length, journals, sources };
}
