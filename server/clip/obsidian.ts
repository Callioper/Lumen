// Save an entry into the Obsidian vault as Markdown, using Recall-for-Obsidian style
// Handlebars templates for both the file path and the note body.
import Handlebars from 'handlebars';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export interface ClipSettings {
  vaultPath: string;       // absolute path of the vault root
  pathTemplate: string;    // relative to the vault; "/vault/" prefix accepted for Recall compatibility
  bodyTemplate: string;
}

export interface ClipPage {
  title: string;
  titleZh: string;
  url: string;
  content: string;          // Markdown
  selectedText: string;
  author: string;
  feed: string;
  published: number;        // unix seconds
  summary: string;          // AI summary as Markdown
  summaryLead: string;      // its first paragraph, one line
  tags: string[];           // AI tags without prefix
  // Filled by the archive step (clip/metadata.ts); plain strings so templates stay simple.
  displayTitle: string;     // 作者｜题目（20261021）
  headline: string;         // the push headline, when the article's own title differs from it
  alias: string;            // original of a translation, same shape
  authorLinks: string;      // [[艾琳·霍索恩|Irene Hawthorne]], [[林舟]]
  translatorLinks: string;
  origin: string;           // where a repost first appeared
  type: string;
  keywords: string;         // 关键词、关键词
  tagLine: string;          // #媒介研究 #文学理论/叙事学
  words: number;
  citation: string;
}

// The body template Lumen shipped before metadata was filled in; settings still holding it
// unchanged are moved to the current default (config.ts).
export const LEGACY_BODY_TEMPLATE = `---
UID: {{uuid}}
status: unfinished
aliases:
---
# Metadata
- title:: [{{page.title}}]({{page.url}})
- created:: [[{{date "yyyy-LL-dd"}}]]
- published:: {{date "yyyy-LL-dd" page.published}}
- source:: {{page.feed}}
- author:: {{#if page.author}}[[{{page.author}}]]{{/if}}
- translator::
- tags:: #

>[!summary]
>summary:: {{page.summaryLead}}

---
# {{page.title}}

{{page.content}}
{{#if page.selectedText}}

---
# 摘录

{{quote page.selectedText}}
{{/if}}

---
# AI
`;

// No vault until the reader names one (设置 → 存档): archiving is off till then.
export const DEFAULT_CLIP: ClipSettings = {
  vaultPath: '',
  pathTemplate: 'WebClips/{{date "yyyy"}}/{{date "yyyy-LL"}}/{{filename page.displayTitle}}.md',
  bodyTemplate: `---
UID: {{uuid}}
status: unfinished
aliases:{{#if page.alias}}
  - {{yaml page.alias}}{{/if}}
---
# Metadata
- title:: [{{page.displayTitle}}]({{page.url}}){{#if page.headline}}
- headline:: {{page.headline}}{{/if}}
- created:: [[{{date "yyyy-LL-dd"}}]]
- published:: {{date "yyyy-LL-dd" page.published}}
- source:: {{page.feed}}
- origin:: {{page.origin}}
- type:: {{page.type}}
- author:: {{page.authorLinks}}
- translator:: {{page.translatorLinks}}
- keywords:: {{page.keywords}}
- tags:: {{#if page.tagLine}}{{page.tagLine}}{{else}}#{{/if}}
- words:: {{page.words}}
- cite:: {{page.citation}}

>[!summary]
>summary:: {{page.summaryLead}}

---
# {{page.displayTitle}}
{{#if page.origin}}

> [!quote] 出处
> {{page.origin}}
{{/if}}

{{page.content}}
{{#if page.selectedText}}

---
# 摘录

{{quote page.selectedText}}
{{/if}}

---
# AI
`,
};

// Luxon-style tokens, longest first so "MM" (month) is not read as two "M"s and "mm" stays minutes.
const DATE_TOKENS = /yyyy|yy|LL|MM|dd|HH|mm|ss|L|M|d|H/g;
const pad = (n: number): string => String(n).padStart(2, '0');

export function formatDate(d: Date, fmt: string): string {
  return fmt.replace(DATE_TOKENS, (t) => {
    switch (t) {
      case 'yyyy': return String(d.getFullYear());
      case 'yy': return String(d.getFullYear()).slice(-2);
      case 'LL': case 'MM': return pad(d.getMonth() + 1);
      case 'L': case 'M': return String(d.getMonth() + 1);
      case 'dd': return pad(d.getDate());
      case 'd': return String(d.getDate());
      case 'HH': return pad(d.getHours());
      case 'H': return String(d.getHours());
      case 'mm': return pad(d.getMinutes());
      default: return pad(d.getSeconds());
    }
  });
}

// Windows-illegal characters plus the ones Obsidian refuses in link targets.
const FILENAME_BAD = /[\\/:*?"<>|#^[\]\u0000-\u001f]/g;
const MAX_FILENAME = 120;

export function safeFilename(s: string): string {
  const clean = String(s ?? '').replace(FILENAME_BAD, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  return [...clean].slice(0, MAX_FILENAME).join('').trim() || '未命名';
}

function makeEngine(): typeof Handlebars {
  const hb = Handlebars.create();
  hb.registerHelper('uuid', () => randomUUID());
  // {{date "fmt"}} is now; {{date "fmt" page.published}} formats a unix-seconds value.
  hb.registerHelper('date', (...args: unknown[]) => {
    const [fmt, when] = args.slice(0, -1) as [unknown, unknown];
    const d = typeof when === 'number' && when > 0 ? new Date(when * 1000) : new Date();
    return formatDate(d, typeof fmt === 'string' ? fmt : 'yyyy-LL-dd');
  });
  hb.registerHelper('filename', (s: unknown) => safeFilename(String(s ?? '')));
  // A YAML scalar that survives colons, quotes and leading symbols.
  hb.registerHelper('yaml', (s: unknown) => JSON.stringify(String(s ?? '')));
  hb.registerHelper('quote', (s: unknown) => String(s ?? '').split(/\r?\n/).map((l) => `> ${l}`).join('\n'));
  return hb;
}

const engine = makeEngine();

export function render(template: string, page: ClipPage): string {
  return engine.compile(template, { noEscape: true, strict: false })({ page });
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
turndown.use(gfm);
turndown.remove(['script', 'style', 'noscript']);

// The GFM plugin only converts tables that have a header row, and paragraphs inside cells
// break the row onto several lines. WeChat tables have neither, so they stayed raw HTML.
function prepareTables(html: string): string {
  return html.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const flat = table.replace(/<\/?(?:p|div|span|section|strong|b)(?:\s[^>]*)?>/gi, ' ').replace(/<br\s*\/?>/gi, ' ');
    if (/<th[\s>]/i.test(flat)) return flat;
    return flat.replace(/<tr[^>]*>[\s\S]*?<\/tr>/i, (row) => row.replace(/<td\b/gi, '<th').replace(/<\/td>/gi, '</th>'));
  });
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(prepareTables(html || '')).replace(/\n{3,}/g, '\n\n').trim();
}

// Resolve the rendered path inside the vault; anything that escapes it is refused.
export function resolveClipPath(vault: string, rendered: string): string {
  if (!isAbsolute(vault) || !existsSync(vault) || !statSync(vault).isDirectory()) throw new Error(`Obsidian 库路径不存在：${vault}`);
  const rel = rendered.trim().replace(/^\/?vault\//, '').replace(/^[/\\]+/, '');
  const withExt = /\.md$/i.test(rel) ? rel : `${rel}.md`;
  const full = resolve(vault, withExt);
  const back = relative(resolve(vault), full);
  if (!back || back.startsWith('..') || isAbsolute(back)) throw new Error('存档路径超出了 Obsidian 库');
  return full;
}

export interface ClipResult { path: string; relPath: string; existed: boolean }

export function writeClip(cfg: ClipSettings, page: ClipPage): ClipResult {
  const full = resolveClipPath(cfg.vaultPath, render(cfg.pathTemplate, page));
  const relPath = relative(cfg.vaultPath, full).replaceAll('\\', '/');
  if (existsSync(full)) return { path: full, relPath, existed: true };
  mkdirSync(dirname(full), { recursive: true });
  // 'wx' refuses to overwrite if the file appeared in the meantime.
  writeFileSync(full, render(cfg.bodyTemplate, page), { encoding: 'utf8', flag: 'wx' });
  return { path: full, relPath, existed: false };
}
