// Tidy the Markdown of an archived article: undo proxy links, drop WeChat furniture at the
// head and tail, fix escaping and broken emphasis. Facts found on the way (byline, where a
// repost came from, citation line) are returned so they can go into the note's metadata.

export interface CleanFacts {
  byline: string;          // "崔久成" from "崔久成 2026-10-19 19:59 上海"
  sourceAccount: string;   // "社会科学杂志" from "以下文章来源于：社会科学杂志"
  origin: string;          // "《电影研究》第4期，2025年." / "转载自《南方周末》2026.10.16"
  citation: string;        // "引用格式：…" line, without the label
}

export interface CleanResult {
  markdown: string;
  facts: CleanFacts;
  stats: { charsBefore: number; charsAfter: number; tailCut: boolean; imagesDropped: number };
}

// The tail is cut at the first end marker found in the last part of the text, but never if
// that would throw away more than this share of the prose (a marker inside the body).
const TAIL_ZONE = 0.6;
const MAX_TAIL_CUT = 0.35;
const HEAD_BLOCKS = 12;

const PROXY = /https?:\/\/[^\s)]*\/(?:img|link)-proxy\/\?[^\s)]*/g;

// wechat2rss rewrites images and links through a tunnel whose address changes; keep the target.
export function unproxy(url: string): string {
  try {
    const u = new URL(url).searchParams.get('u');
    return u ? decodeURIComponent(u) : url;
  } catch {
    return url;
  }
}

// Short sign-offs left below a "related articles" list.
const TAIL_JUNK = /^(欢迎|敬请)?关注|^(点击|戳)|^(长按|扫码|扫描)|^[-—_=*·\s]+$|^(期刊|往期)(查询|链接)|^(在看|点赞|分享)|回顾$|^购书|^(相关|延伸)(信息|链接)/;
const TAIL_JUNK_CHARS = 30;

const LINK_LIST =/^(?:\s*(?:[-*■•▶►▪◆●]\s*)?\[[^\]]+\]\([^)]+\)\s*)+$/;

const isDecorativeImage =(url: string): boolean => /mmbiz_gif|wx_fmt=gif/.test(url);

const proseLength = (s: string): number =>
  s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\]\([^)]*\)/g, ']').replace(/[\s*#>|_\-[\]]/g, '').length;

const plain = (block: string): string => block.replace(/\*\*|__|[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

const squash = (s: string): string => s.replace(/[\s|｜丨:：·•\-—_*【】[\]（）()“”"'《》]/g, '');

const BYLINE = /^(?:原创\s+)?(\S[^\n]{0,40}?)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?:\s+\S{1,10})?$/;
const SOURCE_ACCOUNT = /^以下文章来源于[：:\s]*(.+)$/;
const REPOST = /^(?:本文)?(?:转载自|转自|原载于?|原文刊?载于|原文出处|文章来源|来源)[：:\s]*(.*)$/;
const CITATION = /^引用格式[：:\s]*(.+)$/;
const ORIGIN_HEADING = /^(原文出处|原文信息|文章出处|出处)[：:]?$/;
const END_MARKER = new RegExp([
  '^[-—–\\s]*END[-—–\\s]*$', '^往期', '^相关(文章|阅读|推荐)', '^(推荐|延伸|拓展)阅读', '^更多(精彩|内容)',
  '^(点击|戳).{0,8}阅读原文', '^长按.{0,12}(二维码|关注|识别)', '^扫(码|描).{0,12}(关注|二维码)', '^(欢迎)?关注我们',
  '^(本期|新媒体|责任|执行|文字|图文)?(编辑|责编|美编|排版|审核|校对|审校|初审|复审|终审)\\s*[|｜:：/丨]',
  '^(图源|图片来源|配图)\\s*[|｜:：/丨]', '^跳转微信打开$', '^预览时标签不可点',
].join('|'));

function unescapeMarkdown(s: string): string {
  return s
    .replace(/\\\[/g, '[')
    .replace(/\\\](?!\()/g, ']')
    .replace(/(\S)\\-/g, '$1-')
    .replace(/\\([~+!#>|])/g, (m, c: string) => (c === '|' ? m : c));
}

function tidyEmphasis(s: string): string {
  return s
    .replace(/\*\*\*\*/g, '')                       // **a****b** → **ab**
    .replace(/\*\*(\s*)\*\*/g, '$1')                // empty bold
    .replace(/\*\*([\s：:，,。.、；;！!？?]+)\*\*/g, '$1')  // bold around punctuation only
    .replace(/^(#{1,6})\s+\*\*(.+?)\*\*\s*$/gm, '$1 $2');  // ## **标题** → ## 标题
}

// Numbered section titles that WeChat editors only set in bold become real headings.
const SECTION_TITLE = /^\*\*((?:[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|[0-9]{1,2}[.、．]\s*|第[一二三四五六七八九十0-9]+[章节部分])[^*\n]{1,40})\*\*$/;

// WeChat section titles set as a number on its own line above a short line of text
// ("1" / "你需要的可能不是「理解」，只是「距离」"); the styling that made them titles is gone.
const SECTION_NUMBER = /^(?:\d{1,2}|0\d|[一二三四五六七八九十]{1,3}|Part\s*\d{1,2})$/i;
const SECTION_TITLE_CHARS = 40;
// A title set wholly in bold is a title even when long: interviews number their questions this way.
const BOLD_TITLE_CHARS = 80;

const titleLine = (block: string | undefined): string => {
  if (block === undefined || /^[!#>|\-]/.test(block)) return '';
  const t = plain(block);
  const max = /^\*\*[^*]+\*\*$/.test(block.replace(/\s+/g, ' ').trim()) ? BOLD_TITLE_CHARS : SECTION_TITLE_CHARS;
  return t && t.length <= max && !/[。；;]$/.test(t) ? t : '';
};

export function joinNumberedTitles(blocks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const num = plain(blocks[i]);
    let title = SECTION_NUMBER.test(num) ? titleLine(blocks[i + 1]) : '';
    if (!title) { out.push(blocks[i]); continue; }
    i++;
    // 「误解从何而来：」 / 「马克思的黑格尔式“叙述”」: a title ending on a colon or dash goes on.
    const rest = /[：:—]$/.test(title) ? titleLine(blocks[i + 1]) : '';
    if (rest && rest.length <= SECTION_TITLE_CHARS) { title += rest; i++; }
    out.push(`## ${num} ${title}`);
  }
  return out;
}

// CommonMark only closes **…** when the closing run is not "punctuation then a letter", and only
// opens it when it is not "a letter then punctuation": 「**摘要：**新…」 and 「形成*“从…”*的」
// stay literal in Obsidian. A space on the failing side makes them render.
const PUNCT = /[\p{P}\p{S}]/u;
const isLetter = (c: string | undefined): boolean => c !== undefined && !/\s/.test(c) && !PUNCT.test(c);

function spaceRuns(line: string, re: RegExp): string {
  return line.replace(re, (m: string, inner: string, at: number, all: string) => {
    const before = isLetter(all[at - 1]) && PUNCT.test(inner[0]) ? ' ' : '';
    const after = isLetter(all[at + m.length]) && PUNCT.test(inner.at(-1)!) ? ' ' : '';
    return `${before}${m}${after}`;
  });
}

const STRONG = /\*\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*\*/g;
const EM = /(?<![*\\])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g;

export function fixEmphasisSpacing(md: string): string {
  return md.split(/(```[\s\S]*?```)/).map((part, i) => (i % 2 ? part : part.split('\n').map((line) => {
    if (line.includes('***')) return line;               // combined bold-italic: leave as written
    return line.split(/(`[^`\n]*`)/).map((seg, j) => (j % 2 ? seg : spaceRuns(spaceRuns(seg, STRONG), EM))).join('');
  }).join('\n'))).join('');
}

function splitBlocks(md: string): string[] {
  return md.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

// WeChat sets bold across paragraph breaks ("**【作者简介】" … "林舟，**"); a block with an odd
// number of markers would render the rest of the note bold, so its markers go.
const balanceBold = (block: string): string =>
  ((block.match(/\*\*/g)?.length ?? 0) % 2 ? block.replace(/\*\*/g, '') : block);

function dropHead(blocks: string[], title: string, feed: string, facts: CleanFacts): string[] {
  const t = squash(title);
  const feedName = squash(feed);
  const out: string[] = [];
  let skipAccountBlurb = 0;
  blocks.forEach((b, i) => {
    if (i >= HEAD_BLOCKS) { out.push(b); return; }
    const p = plain(b);
    const byline = BYLINE.exec(p);
    if (byline && !facts.byline) { facts.byline = byline[1].trim(); return; }
    const source = SOURCE_ACCOUNT.exec(p);
    if (source) { facts.sourceAccount = source[1].trim(); skipAccountBlurb = 2; return; }
    if (skipAccountBlurb > 0) { skipAccountBlurb--; if (!/^!\[/.test(b)) return; }
    if (feedName && squash(p) === feedName) return;      // the account's name under the cover image
    // The title repeated in bold (with or without an "author |" prefix) under the cover image.
    if (t && p.length < title.length + 30 && (squash(p) === t || (squash(p).endsWith(t) && squash(p).length - t.length < 16))) return;
    const repost = REPOST.exec(p);
    if (repost && p.length < 80 && repost[1]) { facts.origin ||= p; }
    out.push(b);
  });
  return out;
}

function takeFacts(blocks: string[], facts: CleanFacts): string[] {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const p = plain(blocks[i]);
    const cite = CITATION.exec(p);
    if (cite) { facts.citation ||= cite[1].trim(); continue; }
    if (ORIGIN_HEADING.test(p) && blocks[i + 1] && !/^!\[/.test(blocks[i + 1])) {
      facts.origin ||= plain(blocks[i + 1]);
      i++;
      continue;
    }
    out.push(blocks[i]);
  }
  return out;
}

function cutTail(blocks: string[]): { blocks: string[]; cut: boolean } {
  const total = proseLength(blocks.join('\n'));
  let seen = 0;
  for (let i = 0; i < blocks.length; i++) {
    const before = seen;
    seen += proseLength(blocks[i]);
    if (before < total * (1 - TAIL_ZONE) || !END_MARKER.test(plain(blocks[i]))) continue;
    if (total - before > total * MAX_TAIL_CUT) continue;
    return { blocks: blocks.slice(0, i), cut: true };
  }
  return { blocks, cut: false };
}

function dropImages(blocks: string[]): { blocks: string[]; dropped: number } {
  let dropped = 0;
  const kept = blocks.map((b) => b.replace(/!\[[^\]]*\]\(([^)\s]*)[^)]*\)/g, (m, url: string) => {
    if (!isDecorativeImage(url)) return m;
    dropped++;
    return '';
  }).trim()).filter(Boolean);
  // At the very end, a lone image is a follow banner or QR code and a block of bare links is a
  // "related articles" list.
  for (;;) {
    const last = kept.at(-1);
    if (!last) break;
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(last)) { kept.pop(); dropped++; continue; }
    if (LINK_LIST.test(last)) { kept.pop(); continue; }
    const p = plain(last);
    if (p.length <= TAIL_JUNK_CHARS && (TAIL_JUNK.test(p) || END_MARKER.test(p))) { kept.pop(); continue; }
    break;
  }
  return { blocks: kept, dropped };
}

export function cleanMarkdown(markdown: string, title: string, feed = ''): CleanResult {
  const facts: CleanFacts = { byline: '', sourceAccount: '', origin: '', citation: '' };
  const charsBefore = proseLength(markdown);
  let md = markdown
    .replace(/\r/g, '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(PROXY, (u) => unproxy(u))
    .replace(/\[(?:跳转微信打开|阅读原文)\]\([^)]*\)/g, '')
    .replace(/(?<!!)\[\s*\]\([^)]*\)/g, '');
  md = tidyEmphasis(unescapeMarkdown(md))
    .replace(/(!\[[^\]]*\]\([^)]*\))[ \t]*(?=[^\s!])/g, '$1\n\n')   // an image glued to the text after it
    .replace(/([^\s\n])[ \t]*(!\[[^\]]*\]\([^)]*\))/g, '$1\n\n$2');
  let blocks = splitBlocks(md).map((b) => balanceBold(b.replace(/[ \t]+$/gm, '')));
  blocks = dropHead(blocks, title, feed, facts);
  blocks = takeFacts(blocks, facts);
  const tail = cutTail(blocks);
  const imgs = dropImages(tail.blocks);
  const out = fixEmphasisSpacing(joinNumberedTitles(imgs.blocks).map((b) => {
    const m = SECTION_TITLE.exec(b);
    return m ? `## ${m[1].trim()}` : b;
  }).join('\n\n'));
  return {
    markdown: out,
    facts,
    stats: { charsBefore, charsAfter: proseLength(out), tailCut: tail.cut, imagesDropped: imgs.dropped },
  };
}
