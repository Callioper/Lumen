// Deep reading analysis written into the "# AI" section of an archived note.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Settings } from '../config.ts';
import { chat } from '../ai/llm.ts';
import { fixEmphasisSpacing } from './clean.ts';

export const ANALYSIS_MAX_CHARS = 30_000;
export const ANALYSIS_MAX_TOKENS = 16_000;
export const ANALYSIS_TIMEOUT_MS = 300_000;
// Below this the six-step framework has nothing to work on; the prompt switches to a short form.
export const SHORT_TEXT_CHARS = 3_000;

export const ANALYSIS_SYSTEM = `你是人文社科方向的学术阅读助手。你将收到一篇网页存档文本（论文、书籍章节、评论、随笔、技术文档或资讯，可能是节选），任务是依据所给材料做学术性分析与信息提取。只依据文本，不补写、不臆测缺失信息，不输出任何应答性或寒暄语句，直接给出分析。

【输入】
【已知元数据】题目、作者、来源、发布日期、链接，可能不全。
【待分析文本】正文，图片与链接已移除，保留原有小标题。
【范围】若注明“正文已截断”或“节选”，分析开头须说明范围仅限所给部分，不代表全文立场或完整结构。
元数据与正文不一致时，以正文可直接验证的信息为准，必要时简要指出。

【处理原则】
1. 以文本为依据。出版时间、出处、章节位置、作者译名等无法从材料确认的，写“材料未注明”，不得臆造。
2. 不复述元数据中已给出的基础信息；建立分析对象时最简要引入一次即可。
3. 分析以论点、概念、证据与论证关系为中心，不机械复述内容。
4. 材料不足以支持某项判断时，明确说明依据不足，不以常识补全。

【文本类型】先判断类型并据此调整重点：
A 学术论文：研究问题、理论框架、方法论与学术贡献。
B 随笔/评论/散文：核心议题、论证策略、作者立场与潜在受众。
C 书籍章节（含译文节选）：核心论点，及其在全书中的可能位置与功能；无法判断时不强行推断。
D 技术文档/报告：文档目标、方法或数据基础、关键结论与实践指向，弱化纯理论评述。
E 新闻/资讯/短动态：不论篇幅，一律使用下文“精简模式”，不套用完整框架。
类型混合时说明判断依据，选最贴近的框架。

【完整模式】（A–D 且正文较长时）按以下框架输出：

## 文本类型与结构
### 类型判断
一段话说明类型及判断依据。
### 标题体系或内容单元划分
用 \`\`\`text 代码块以缩进树状文本展示全部可见标题层级；无明确标题时，按论述主题或论证转折划分内容单元并自拟小标题。树中不用项目符号或编号。
### 开篇定位分析
一个连贯段落，按类型选用句式开头：
学术论文：“在题为《译文题目》（*原文题目*, 年份）的学术论文中，作者译名（原文名）……”
随笔/评论：“在题为《译文题目》（*原文题目*, 发表时间/地点）的随笔或评论中，作者译名（原文名）……”
书籍章节：“在《译文书名》（*原文书名*, 出版年份）的相关章节中，作者译名（原文名）……”
技术文档：“在题为《译文标题》（*原文标题*, 发布年份/机构）的技术文档或报告中，文本……”
中文原作直接用中文题目和姓名，不加原文括注；未知信息省略，不补造。

## 分章节分析
### （按结构顺序，每个章节或内容单元一个三级标题，写其标题；这些三级标题都放在本节之下，不要接在“开篇定位分析”后面）
每部分一段连贯行文，自然融入三点，不拆成小标签：该部分的核心主张或概念；至少 1 处、至多 2 处关键原文引句；该部分如何推进、补充、修正或支撑全文论点。
引文格式固定为星号斜体包住中文弯引号，例如 *“原文句子”*，引句须逐字照抄原文，短引为主，每个分析段都必须有。不要用英文直引号 "" 或单引号 '' 引原文；概念术语用中文弯引号“”，不加斜体。网页文本没有页码，不写出处页码，也不要写“未提供页码”之类的说明。

## 综合评述
### 核心贡献
文本提出了什么新概念、新论证或新视角，须是评价与定位，不能是内容摘要。
### 理论意义
与既有研究、理论传统或主流观点形成怎样的对话、验证、修正或偏离；文本未提供足够线索时如实说明。
### 学术局限
逻辑跳跃、证据不足、概念边界模糊、方法局限或未回应的潜在反驳。

【精简模式】（E 类，或正文过短不足以支撑完整框架时）只输出：
## 文本类型与要点
### 类型判断
### 内容要点
一到两段，提炼主要信息与立场，可嵌 1 处关键引句。
### 简评
一段，说明其信息价值、立场倾向或值得追问之处。

【翻译与引用】
首次出现的外国人名写“译名（原文名）”，机构写“中文名（原文名）”，作品写“《译文标题》（*原文标题*, 年份）”；无通行译名时用工作性译名并全文一致；之后只用译名。引文保留原文语言，用斜体。

【格式】
全文 Markdown，最高标题为“##”，不使用“#”；不要加总标题，第一行就是“## ”开头的标题；不要把整篇包在代码块里。除结构树外正文一律用连贯段落，不用项目符号、编号列表或问答短句。不出现“步骤”“自查”等执行性字样。

【风格】准确、克制、学术化，避免空泛褒贬和套话；简洁但不牺牲论证完整性。覆盖全部主要章节或内容单元，不遗漏后半部分。直接成文，一次写完。`;

export interface AnalysisMeta { title: string; author: string; source: string; published: string; url: string }

// Images and link targets only cost tokens; keep link text and headings.
export function analysisText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildAnalysisInput(meta: AnalysisMeta, markdown: string): string {
  const text = analysisText(markdown);
  const truncated = text.length > ANALYSIS_MAX_CHARS;
  const body = truncated ? text.slice(0, ANALYSIS_MAX_CHARS) : text;
  const lines = [
    '【已知元数据】',
    `题目：${meta.title || '材料未注明'}`,
    `作者：${meta.author || '材料未注明'}`,
    `来源：${meta.source || '材料未注明'}`,
    `发布日期：${meta.published || '材料未注明'}`,
    `链接：${meta.url || '材料未注明'}`,
    '',
    `【范围】${truncated ? `正文已截断，只提供前 ${ANALYSIS_MAX_CHARS} 字` : '完整网页正文'}${body.length < SHORT_TEXT_CHARS ? '；正文很短，请使用精简模式' : ''}`,
    '',
    '【待分析文本】',
    body,
  ];
  return lines.join('\n');
}

// A quoted span this long that occurs verbatim in the source is an original quotation, not a term.
const QUOTE_MIN_CHARS = 10;
const squash = (t: string): string => t.replace(/\s+/g, '');

// MiniMax often ignores the *“…”* rule and quotes with straight "…" instead. Quotes are checked
// against the source text, so only real verbatim sentences are italicised; terms just get “”.
export function normalizeQuotes(out: string, source: string): string {
  const src = squash(source);
  return out.split(/(```[\s\S]*?```)/).map((part, i) => (i % 2 ? part : part.replace(
    /(\*?)["“]([^"“”\n]{1,300})["”](\*?)/g,
    (_m: string, pre: string, q: string, post: string) => {
      if (pre && post) return `*“${q}”*`;
      const verbatim = [...q].length >= QUOTE_MIN_CHARS && src.includes(squash(q));
      return verbatim ? `*“${q}”*` : `${pre}“${q}”${post}`;
    },
  ))).join('');
}

const FIXED_H3 = /^(类型判断|标题体系|开篇定位|核心贡献|理论意义|学术局限|内容要点|简评)/;

// Headings of the per-section units that carry no italic quotation.
export function unitsWithoutQuote(out: string): string[] {
  return out.replace(/```[\s\S]*?```/g, '').split(/^### /m).slice(1)
    .filter((u) => !FIXED_H3.test(u) && !/\*“[^”\n]+”\*/.test(u))
    .map((u) => u.split('\n')[0].trim());
}

// Models sometimes wrap the whole answer in a fence or demote headings to "#".
export function tidyAnalysis(out: string): string {
  let s = out.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
  s = s.replace(/^# (?!#)/gm, '## ');
  return s;
}

// MiniMax-M3 reasons before answering and its reasoning cannot be capped: budget_tokens is ignored
// (Anthropic endpoint) or rejected with 400 (OpenAI endpoint), and reasoning_effort "low" changes
// nothing. Measured 2026-10-21 on an 8k-char article: 15k reasoning tokens, 136s, then a sharper answer.
// So thinking is opt-in and gets room for both parts; otherwise it is switched off, which other
// OpenAI-compatible services may reject, so that field only goes to MiniMax.
export const THINKING_MAX_TOKENS = 48_000;
export const THINKING_TIMEOUT_MS = 600_000;

export function analysisRequest(settings: Settings): { maxTokens: number; timeoutMs: number; extra: Record<string, unknown> } {
  const model = settings.clip.analysisModel.trim();
  const extra: Record<string, unknown> = model ? { model } : {};
  if (settings.clip.thinking) return { maxTokens: THINKING_MAX_TOKENS, timeoutMs: THINKING_TIMEOUT_MS, extra };
  if (/minimax/i.test(settings.ai.baseUrl)) extra.thinking = { type: 'disabled' };
  return { maxTokens: ANALYSIS_MAX_TOKENS, timeoutMs: ANALYSIS_TIMEOUT_MS, extra };
}

export async function runAnalysis(meta: AnalysisMeta, markdown: string, settings: Settings, apiKey: string): Promise<string> {
  const req = analysisRequest(settings);
  const out = await chat([
    { role: 'system', content: ANALYSIS_SYSTEM },
    { role: 'user', content: buildAnalysisInput(meta, markdown) },
  ], settings, apiKey, req.maxTokens, req.timeoutMs, req.extra);
  return fixEmphasisSpacing(normalizeQuotes(tidyAnalysis(out), analysisText(markdown)));
}

// The analysis lists the article's titles in a ```text tree. Titles WeChat only set in bold or a
// larger font arrive as plain paragraphs (sometimes split over two lines); a paragraph run that
// reads exactly like a tree line becomes a heading. Lines the model made up match nothing.
const OUTLINE_SKIP = /^(摘要|关键词|关键字|abstract|keywords)|（正文无显式标题）/i;
const OUTLINE_BLOCKS = 3;
const OUTLINE_BLOCK_CHARS = 50;
const flat = (s: string): string => s.replace(/\*\*|[\s*]/g, '');

interface OutlineTitle { text: string; depth: number }

// The tree's lines with their indent; a first line alone at the top level is the article's own title.
export function outlineTitles(analysis: string): OutlineTitle[] {
  const tree = /```text\n([\s\S]*?)```/.exec(analysis)?.[1] ?? '';
  const lines = tree.split('\n').filter((l) => l.trim()).map((l) => ({
    text: l.trim().replace(/\s+/g, ' '), depth: /^\s*/.exec(l)![0].replace(/\t/g, '    ').length,
  }));
  const top = Math.min(...lines.map((l) => l.depth));
  const rooted = lines.length > 1 && lines.filter((l) => l.depth === top).length === 1 && lines[0].depth === top;
  return (rooted ? lines.slice(1) : lines).filter((t) => !OUTLINE_SKIP.test(t.text));
}

const NOT_PROSE = /^(?:[!#>|`]|[-*+]\s|\d+[.)]\s)/;

// How many blocks from parts[i] on read, joined, exactly as `want`; 0 if none.
function spanMatching(parts: string[], i: number, want: string): number {
  let joined = '';
  for (let k = 0; k < OUTLINE_BLOCKS; k++) {
    const b = parts[i + 2 * k];
    if (b === undefined || NOT_PROSE.test(b) || b.includes('\n') || b.trim().length > OUTLINE_BLOCK_CHARS) return 0;
    joined += flat(b);
    if (joined === want) return k + 1;
    if (!want.startsWith(joined)) return 0;
  }
  return 0;
}

export function promoteOutlineHeadings(body: string, analysis: string): string {
  const titles = outlineTitles(analysis);
  if (!titles.length) return body;
  const parts = body.split(/(\n{2,})/);                  // even: blocks, odd: the breaks between
  const found: { at: number; span: number; t: OutlineTitle }[] = [];
  let from = 0;
  for (const t of titles) {
    const want = flat(t.text);
    for (let i = from; i < parts.length; i += 2) {
      if (parts[i].startsWith('#') && flat(parts[i].replace(/^#+/, '')) === want) { from = i + 2; break; }
      const span = spanMatching(parts, i, want);
      if (span) { found.push({ at: i, span, t }); from = i + 2 * span; break; }
    }
  }
  if (!found.length) return body;
  const depths = [...new Set(found.map((f) => f.t.depth))].sort((a, b) => a - b);
  for (const f of found.reverse()) {
    const level = '#'.repeat(Math.min(2 + depths.indexOf(f.t.depth), 4));
    parts.splice(f.at, 2 * f.span - 1, `${level} ${f.t.text}`);
  }
  return parts.join('');
}

const AI_HEADING = /^# AI[ \t]*$/m;

// Fill the "# AI" section only while it is still empty: the note may have been
// edited in Obsidian during the minute or two the analysis takes.
export function fillAiSection(file: string, analysis: string): 'filled' | 'not-empty' | 'no-section' {
  const text = readFileSync(file, 'utf8');
  const m = [...text.matchAll(new RegExp(AI_HEADING.source, 'gm'))].at(-1);
  if (!m || m.index === undefined) return 'no-section';
  const after = text.slice(m.index + m[0].length);
  if (after.trim()) return 'not-empty';
  writeFileSync(file, `${promoteOutlineHeadings(text.slice(0, m.index), analysis)}${m[0]}\n\n${analysis.trim()}\n`, 'utf8');
  return 'filled';
}
