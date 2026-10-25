import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDate, safeFilename, render, resolveClipPath, writeClip, htmlToMarkdown, DEFAULT_CLIP, type ClipPage } from '../server/clip/obsidian.ts';
import type { Settings } from '../server/config.ts';
import { bylineAuthor } from '../server/clip/service.ts';
import { buildAnalysisInput, tidyAnalysis, fillAiSection, normalizeQuotes, unitsWithoutQuote, analysisRequest, ANALYSIS_MAX_CHARS, THINKING_MAX_TOKENS } from '../server/clip/analysis.ts';

const PAGE: ClipPage = {
  title: 'A/B: 测试?标题', titleZh: '', url: 'https://example.com/a', content: '正文第一段。\n\n## 小节\n\n第二段。',
  selectedText: '', author: '张三', feed: '某公众号', published: Date.UTC(2026, 0, 5, 12) / 1000,
  summary: '一句话概括。\n\n- 要点', summaryLead: '一句话概括。', tags: ['哲学'],
  displayTitle: '张三｜A/B: 测试?标题（20260105）', headline: '', alias: '', authorLinks: '[[张三]]', translatorLinks: '', origin: '',
  type: '评论', keywords: '测试、标题', tagLine: '#哲学', words: 10, citation: '',
};

test('date tokens follow Luxon: LL/MM month, mm minutes', () => {
  const d = new Date(2026, 9, 7, 8, 5, 9);
  assert.equal(formatDate(d, 'yyyy-LL-dd'), '2026-10-07');
  assert.equal(formatDate(d, 'yyyy-MM-dd HH:mm:ss'), '2026-10-07 08:05:09');
  assert.equal(formatDate(d, 'yy L d'), '26 10 7');
});

test('filenames drop characters Windows or Obsidian links reject', () => {
  assert.equal(safeFilename('A/B: 测试?标题'), 'A B 测试 标题');
  assert.equal(safeFilename('[[x]] #tag ^id |pipe'), 'x tag id pipe');
  assert.equal(safeFilename('...'), '未命名');
  assert.equal([...safeFilename('长'.repeat(300))].length, 120);
});

test('default path template puts the clip under the current year and month', () => {
  const now = new Date();
  const p = render(DEFAULT_CLIP.pathTemplate, PAGE);
  const ym = formatDate(now, 'yyyy-LL');
  assert.equal(p, `WebClips/${now.getFullYear()}/${ym}/张三｜A B 测试 标题（20260105）.md`);
});

test('body template keeps the user layout and fills metadata', () => {
  const out = render(DEFAULT_CLIP.bodyTemplate, { ...PAGE, selectedText: '第一行\n第二行' });
  assert.match(out, /^---\nUID: [0-9a-f-]{36}\nstatus: unfinished\n/);
  assert.match(out, /- title:: \[张三｜A\/B: 测试\?标题（20260105）\]\(https:\/\/example\.com\/a\)/);
  assert.match(out, /- author:: \[\[张三\]\]/);
  assert.match(out, /- published:: 2026-01-05/);
  assert.match(out, /- type:: 评论\n- author:: /);
  assert.match(out, /- tags:: #哲学\n- words:: 10\n/);
  assert.match(out, /\naliases:\n---/);
  assert.match(out, /\n# 张三｜A\/B: 测试\?标题（20260105）\n\n正文第一段/);
  assert.doesNotMatch(out, /\[!quote\] 出处|headline::/);
  assert.match(render(DEFAULT_CLIP.bodyTemplate, { ...PAGE, headline: '读懂乡野心灵的三个关键' }), /\)\n- headline:: 读懂乡野心灵的三个关键\n- created::/);
  assert.match(out, />summary:: 一句话概括。/);
  assert.match(out, /# 摘录\n\n> 第一行\n> 第二行/);
  assert.match(out, /\n# AI\n$/);
});

test('excerpt section disappears without a selection', () => {
  assert.doesNotMatch(render(DEFAULT_CLIP.bodyTemplate, PAGE), /# 摘录/);
});

test('recall-style /vault/ prefix is accepted; escaping the vault is refused', () => {
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  assert.equal(resolveClipPath(vault, '/vault/a/b.md'), join(vault, 'a', 'b.md'));
  assert.equal(resolveClipPath(vault, 'a/b'), join(vault, 'a', 'b.md'));
  assert.throws(() => resolveClipPath(vault, '../outside.md'), /超出/);
  assert.throws(() => resolveClipPath(join(vault, 'missing'), 'a.md'), /不存在/);
});

test('writeClip never overwrites an existing note', () => {
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  const cfg = { ...DEFAULT_CLIP, vaultPath: vault, pathTemplate: 'clips/{{filename page.title}}.md' };
  const first = writeClip(cfg, PAGE);
  assert.equal(first.existed, false);
  writeFileSync(first.path, 'edited by user');
  const second = writeClip(cfg, PAGE);
  assert.equal(second.existed, true);
  assert.equal(readFileSync(second.path, 'utf8'), 'edited by user');
});

test('html converts to markdown with headings, lists and tables', () => {
  const md = htmlToMarkdown('<h2>标题</h2><p>段<b>粗</b></p><ul><li>一</li></ul><table><tr><th>a</th></tr><tr><td>1</td></tr></table><script>x()</script>');
  assert.match(md, /^## 标题/);
  assert.match(md, /段\*\*粗\*\*/);
  assert.match(md, /^- +一$/m);
  assert.match(md, /\| a \|/);
  assert.doesNotMatch(md, /x\(\)/);
});

test('analysis input flags truncation and short texts, and drops images', () => {
  const meta = { title: 't', author: '', source: 's', published: '', url: 'u' };
  const long = buildAnalysisInput(meta, 'x'.repeat(ANALYSIS_MAX_CHARS + 10));
  assert.match(long, /正文已截断/);
  const short = buildAnalysisInput(meta, '![img](http://a/b.png)短文 [链接](http://c)');
  assert.match(short, /精简模式/);
  assert.match(short, /作者：材料未注明/);
  assert.doesNotMatch(short, /http:\/\/a\/b\.png|http:\/\/c/);
  assert.match(short, /短文 链接/);
});

test('model output is unfenced and never uses a level-1 heading', () => {
  assert.equal(tidyAnalysis('```markdown\n# 类型\n正文\n```'), '## 类型\n正文');
  assert.equal(tidyAnalysis('## 已经对\n### 子'), '## 已经对\n### 子');
});

test('AI section is filled only while it is still empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'note-'));
  const f = join(dir, 'n.md');
  writeFileSync(f, '# 标题\n\n正文\n\n---\n# AI\n');
  assert.equal(fillAiSection(f, '## 分析'), 'filled');
  assert.match(readFileSync(f, 'utf8'), /# AI\n\n## 分析\n$/);
  assert.equal(fillAiSection(f, '## 再来'), 'not-empty');
  writeFileSync(f, 'no heading');
  assert.equal(fillAiSection(f, 'x'), 'no-section');
  assert.ok(existsSync(f));
});

test('verbatim straight-quoted sentences become italic quotes; terms only get curly quotes', () => {
  const src = '乡野心灵并非边缘性议题，而是理解虚构故事世界的核心。';
  const out = normalizeQuotes('### 一\n作者认为"乡野心灵并非边缘性议题，而是理解虚构故事世界的核心"，并提出"乡野心灵"。\n```text\n"保留"\n```', src);
  assert.match(out, /\*“乡野心灵并非边缘性议题，而是理解虚构故事世界的核心”\*/);
  assert.match(out, /提出“乡野心灵”。/);
  assert.match(out, /"保留"/);
  assert.equal(normalizeQuotes('"这句话原文里根本没有出现过"', src), '“这句话原文里根本没有出现过”');
});

test('wechat byline gives the author when the feed has none', () => {
  assert.equal(bylineAuthor('原创 陆晚舟 2026-10-20 10:00 北京\n\n正文'), '陆晚舟');
  assert.equal(bylineAuthor('张三 2026-01-02 08:30\n'), '张三');
  assert.equal(bylineAuthor('正文第一段，没有署名。'), '');
});

test('units without an italic quotation are reported, fixed headings are not', () => {
  const md = '## 文本类型与结构\n### 类型判断\n无引文\n## 分章节分析\n### 甲\n有 *“引句”*\n### 乙\n没有\n';
  assert.deepEqual(unitsWithoutQuote(md), ['乙']);
});

test('analysis turns MiniMax thinking off by default and gives it room when switched on', () => {
  const base = { ai: { baseUrl: 'https://api.minimaxi.com/v1' }, clip: { analysisModel: '', thinking: false } } as unknown as Settings;
  assert.deepEqual(analysisRequest(base).extra, { thinking: { type: 'disabled' } });
  const on = analysisRequest({ ...base, clip: { analysisModel: 'MiniMax-M2.7', thinking: true } } as unknown as Settings);
  assert.deepEqual(on.extra, { model: 'MiniMax-M2.7' });
  assert.equal(on.maxTokens, THINKING_MAX_TOKENS);
  const other = analysisRequest({ ...base, ai: { baseUrl: 'https://api.openai.com/v1' } } as unknown as Settings);
  assert.deepEqual(other.extra, {});
});

test('paragraphs that read exactly like a line of the outline become headings', async () => {
  const { promoteOutlineHeadings } = await import('../server/clip/analysis.ts');
  const analysis = '### 标题体系\n\n```text\n从历史化叙事到烟火气叙事\n  摘要\n  开篇：现实性问题的提出（正文无显式标题）\n  “烟火”与“烟火气”\n  烟火气叙事：从群众文艺到新群众文艺\n    （一）活人气\n```\n';
  const body = '# 林望舟｜从历史化叙事到烟火气叙事（20261019）\n\n从历史化叙事到烟火气叙事\n\n**摘要：** 一段摘要。\n\n正文第一段。\n\n “烟火”与“烟火气”\n\n正文第二段。\n\n烟火气叙事：\n\n从群众文艺到新群众文艺\n\n正文。\n\n（一）活人气\n\n更多正文。\n\n';
  const out = promoteOutlineHeadings(body, analysis);
  assert.match(out, /\n\n## “烟火”与“烟火气”\n\n正文第二段/);
  assert.match(out, /\n\n## 烟火气叙事：从群众文艺到新群众文艺\n\n正文。/);
  assert.match(out, /\n\n### （一）活人气\n\n/);
  assert.match(out, /\n\n从历史化叙事到烟火气叙事\n\n/, 'the root line is the article title, not a section');
  assert.match(out, /\n\n\*\*摘要：\*\* 一段摘要。/);
  assert.equal(promoteOutlineHeadings(body, 'no tree'), body);
});
