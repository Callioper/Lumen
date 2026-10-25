// A cover for a list row, card or tile, at roughly twice the CSS width it is shown at. The
// server shrinks it where the host can and keeps it on disk; widths must be in COVER_WIDTHS
// (server/api/media.ts), which are also what it warms after a fetch.
export function proxiedCover(url: string | null | undefined, width: 160 | 480 | 520 | 1080): string {
  const p = proxied(url);
  return p.startsWith('/img?') ? `${p}&w=${width}` : p;
}

export function proxied(url: string | null | undefined): string {
  if (!url) return '';
  // Protocol-relative URLs also start with '/', so test them first.
  const abs = url.startsWith('//') ? 'https:' + url : url;
  if (abs.startsWith('data:') || abs.startsWith('/')) return abs;
  return '/img?u=' + encodeURIComponent(abs.replace(/&amp;/g, '&'));
}

// Feed-supplied links end up in href and window.open; only web links are allowed there.
export function safeLink(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

// Route every <img> through the hotlink proxy; srcset would bypass it, so drop it.
// An article's images come from Lumen's other loopback name (127.0.0.1 ↔ localhost): the browser
// keeps six connections per name, and an image-heavy article used to fill all six, so opening the
// next one waited behind its images. Covers stay on this origin: the share card draws them
// on a canvas, which a cross-origin image would taint. Any other host (a LAN name) has no twin.
const TWIN_HOST: Record<string, string> = { '127.0.0.1': 'localhost', localhost: '127.0.0.1' };
function imageOrigin(): string {
  if (typeof location === 'undefined') return '';
  const twin = TWIN_HOST[location.hostname];
  return twin ? `${location.protocol}//${twin}${location.port ? ':' + location.port : ''}` : '';
}
const IMAGE_ORIGIN = imageOrigin();
const articleImage = (src: string): string => { const p = proxied(src); return p.startsWith('/img?') ? IMAGE_ORIGIN + p : p; };

export function proxifyHtml(html: string): string {
  return html
    .replace(/\ssrcset="[^"]*"/gi, '')
    .replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/gi, (_m, a: string, src: string, b: string) => a + articleImage(src).replace(/"/g, '&quot;') + b)
    .replace(/(<video\b[^>]*?\sposter=")([^"]+)(")/gi, (_m, a: string, src: string, b: string) => a + proxied(src) + b);
}

const MIN = 60, HOUR = 3600, DAY = 86400;
export function ago(ts: number): string {
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < MIN) return '刚刚';
  if (d < HOUR) return `${Math.floor(d / MIN)} 分钟前`;
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时前`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} 天前`;
  const t = new Date(ts * 1000);
  const sameYear = t.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : t.getFullYear() + '年'}${t.getMonth() + 1}月${t.getDate()}日`;
}

export function fullDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
}

// 2026年10月12日—10月18日 for [from, to); same as the report notes (server/report/render.ts).
// The end repeats only what changed: 10月12日—18日, 10月26日—11月1日, 2026年12月28日—2027年1月3日.
export function rangeLabel(from: number, to: number): string {
  const a = new Date(from * 1000), b = new Date((to - 1) * 1000);
  const y = (d: Date): string => `${d.getFullYear()}年`, m = (d: Date): string => `${d.getMonth() + 1}月`, d = (x: Date): string => `${x.getDate()}日`;
  const head = y(a) + m(a) + d(a);
  if (a.toDateString() === b.toDateString()) return head;
  if (a.getFullYear() !== b.getFullYear()) return `${head}—${y(b)}${m(b)}${d(b)}`;
  return `${head}—${a.getMonth() !== b.getMonth() ? m(b) : ''}${d(b)}`;
}

export function readingMinutes(html: string): number {
  const text = html.replace(/<[^>]+>/g, '');
  const han = text.match(/[㐀-鿿]/g)?.length ?? 0;
  const words = text.replace(/[㐀-鿿]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(han / 400 + words / 220));
}

export function parseEnclosures(raw: string | null): { url: string; type: string }[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as { url: string; type: string }[]; } catch { return []; }
}

// Same test as server/ai/translate.ts isForeign: few Han characters, or kana.
export function isForeignText(text: string): boolean {
  const s = text.slice(0, 3000).replace(/https?:\/\/\S+/g, '').replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (s.length < 40) return false;
  const han = s.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kana = s.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  return han / s.length < 0.2 || kana / s.length > 0.1;
}

export function hostOf(url: string | null): string {
  try { return url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch { return ''; }
}

export const cx = (...c: (string | number | false | null | undefined)[]): string => c.filter((x) => typeof x === 'string' && x).join(' ');

// In the unread view, whatever was read while there (opened, scrolled past, a group or block
// marked read, a Douban mark card opened) stays as a short trail for context: only the few read
// most recently are kept, plus the one open. Rows that were already read when loaded stay.
export const READ_TRAIL = 3;

export function keepReadTrail<T, K>(list: T[], readOrder: readonly K[], keyOf: (x: T) => K, isRead: (x: T) => boolean,
  pinned: K | null = null, keep = READ_TRAIL): T[] {
  if (readOrder.length <= keep) return list;
  const recent = new Set(readOrder.slice(-keep));
  const stale = new Set(readOrder.slice(0, -keep).filter((k) => !recent.has(k) && k !== pinned));
  const out = list.filter((x) => !(isRead(x) && stale.has(keyOf(x))));
  return out.length === list.length ? list : out;
}

// Ids in the order they were read, newest last, each once.
export const noteRead = <K>(order: readonly K[], keys: readonly K[]): K[] =>
  [...order.filter((k) => !keys.includes(k)), ...keys];

// A tag's tone (styles.css .tone-*), by what it says: new things green, popularity amber, acclaim rose,
// calls and deadlines rose, talks and events teal, jobs and funding blue; anything else by its name.
const TONES = ['green', 'amber', 'teal', 'rose', 'blue', 'violet'] as const;
const TONE_RULES: [RegExp, typeof TONES[number]][] = [
  [/新书|新刊|新上|速递|首发|即将/, 'green'],
  [/热门|热榜|畅销|月度|周榜|实时/, 'amber'],
  [/高分|口碑|Top|TOP|年度|经典|佳作/, 'rose'],
  [/征稿|征集|截止/, 'rose'],
  [/会议|论坛|工作坊/, 'violet'],
  [/讲座|活动|沙龙|读书会/, 'teal'],
  [/招聘|申报|基金|项目/, 'blue'],
];
export function toneOf(label: string): string {
  const hit = TONE_RULES.find(([re]) => re.test(label));
  if (hit) return `tone-${hit[1]}`;
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `tone-${TONES[h % TONES.length]}`;
}
