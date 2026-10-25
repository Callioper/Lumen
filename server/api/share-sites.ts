// What a share card should say for pages whose own metadata says it badly: titles carrying the
// site name, video pages whose blurb runs on into view counts, encyclopedias without a blurb.
import { parseHTML } from 'linkedom';
import { plainText } from '../content/sanitize.ts';

export interface CardFields { title: string; source: string; author?: string; published?: number; summary?: string }

const SEPARATORS = /\s+[|｜\-–—·]\s+|_|｜|\s*\|\s*/;
const MAX_SITE_PART = 24;           // a longer part is the title itself, not the site's name
const MIN_TITLE = 2;                // 「控制论」 is a whole title
const MIN_PARAGRAPH = 30;
const norm = (s: string): string => s.toLowerCase().replace(/[\s.,，。:：()（）]/g, '');

// 「…未映先遇舆论考验 | 联合早报网」→「…未映先遇舆论考验」: drop leading and trailing parts that
// name the site, judged against the site's name, the host and a few well-known suffixes.
export function stripSite(title: string, names: string[]): string {
  const keys = names.map(norm).filter((k) => k.length >= 2);
  const isSite = (part: string): boolean => {
    const p = norm(part);
    return !!p && part.length <= MAX_SITE_PART && keys.some((k) => p.includes(k) || k.includes(p));
  };
  const parts = title.split(SEPARATORS).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return title.trim();
  let a = 0, b = parts.length;
  while (b - a > 1 && isSite(parts[b - 1])) b--;
  while (b - a > 1 && isSite(parts[a])) a++;
  if (a === 0 && b === parts.length) return title.trim();
  // Rebuild from the original text so separators that belong to the title survive.
  const first = title.indexOf(parts[a]);
  const last = title.lastIndexOf(parts[b - 1]) + parts[b - 1].length;
  const out = title.slice(first, last).trim();
  return out.length >= MIN_TITLE ? out : title.trim();
}

// Site words that appear in titles though not in og:site_name.
const HOST_WORDS: Record<string, string[]> = {
  'bilibili.com': ['哔哩哔哩', 'bilibili'],
  'wikipedia.org': ['维基百科', '維基百科', 'wikipedia', '自由的百科全书'],
  'zaobao.com': ['联合早报', '聯合早報'],
  'github.com': ['github'],
  'douban.com': ['豆瓣'],
  'zhihu.com': ['知乎'],
};

const hostIs = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
const date = (s: string | undefined): number | undefined => {
  const m = s && /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] ?? 0)) / 1000) : undefined;
};

// Per-site fixes; `summaryIsMeta` says the summary came from the page's own blurb and may be replaced.
export function refineCard(card: CardFields, html: string, url: string, summaryIsMeta: boolean): CardFields {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  const extra = Object.entries(HOST_WORDS).flatMap(([d, w]) => (hostIs(host, d) ? w : []));
  const out: CardFields = { ...card, title: stripSite(card.title, [card.source, host.split('.').at(-2) ?? '', ...extra]) };
  if (out.author) out.author = out.author.replace(/\s*(作者|著|编著|主编)$/, '').trim() || undefined;
  const { document } = parseHTML(html);
  const meta = (sel: string): string => document.querySelector(sel)?.getAttribute('content')?.trim() ?? '';

  if (hostIs(host, 'bilibili.com') && /^\/video\//.test(u.pathname)) {
    // The UP主 is who the card is from; the blurb stops where the view counts begin.
    const up = meta('meta[name="author"]') || out.author;
    if (up) { out.source = up; out.author = undefined; }
    out.published ??= date(document.querySelector('.pubdate-ip-text, .pubdate-text')?.textContent ?? undefined);
    if (out.summary && summaryIsMeta) out.summary = out.summary.replace(/^视频简介[:：]\s*/, '').replace(/[,，]\s*视频播放量[\s\S]*$/, '').trim() || undefined;
  } else if (hostIs(host, 'wikipedia.org')) {
    out.source = /^zh\./.test(host) ? '维基百科' : 'Wikipedia';
    out.author = undefined;
    // The lead paragraph, without hatnotes, captions or reference marks.
    const lead = [...document.querySelectorAll('#mw-content-text .mw-parser-output > p')]
      .map((p) => plainText(p.innerHTML.replace(/<sup[^>]*class="[^"]*reference[\s\S]*?<\/sup>/gi, '')))
      .find((t) => t.length >= MIN_PARAGRAPH);
    if (lead && (summaryIsMeta || !out.summary || out.summary.length < lead.length)) out.summary = lead;
  } else if (hostIs(host, 'douban.com')) {
    out.author = meta('meta[property="book:author"]') || out.author;
    out.title = out.title.replace(/\s*[（(]豆瓣[)）]$/, '');
  } else if (host === 'github.com') {
    // 「GitHub - owner/repo: description」: the repository is the title, the description the blurb.
    const m = /^(?:GitHub\s*-\s*)?([\w.-]+\/[\w.-]+)(?::\s*(.+))?$/.exec(card.title.trim());
    if (m) { out.title = m[1]; if (m[2] && (summaryIsMeta || !out.summary)) out.summary = m[2]; }
  }
  return out;
}
