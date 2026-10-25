import type { EntryDetail } from '../api.ts';
import { proxiedCover } from '../util.ts';

// What a share card shows; built from a reader entry here, or from a web page by the server (server/api/share.ts).
export interface ShareData {
  title: string;
  titleOrig?: string;          // the original when the title shown is a translation
  source: string;              // feed or site name
  icon?: string;               // same-origin URL, so the image export can read it
  author?: string;
  published?: number;          // unix seconds
  cover?: string;              // same-origin URL
  summary?: string;            // plain text
  quote?: string;              // selected passage: the card becomes a quote card
  url?: string;                // encoded in the QR code
  pending?: boolean;           // from the extension: an AI summary or translation is on its way
  aiNote?: string;             // why it did not come
}

// Query keys that only track the click. WeChat needs just __biz, mid, idx and sn; poc_token is
// the token its anti-bot check adds in the reader's browser.
const TRACKING = /^(utm_\w+|chksm|scene|xtrack|poc_token|sessionid|subscene|clicktime|enterid|ascene|devicetype|version|nettype|lang|exportkey|pass_ticket|wx_header|spm|share_token|from|isappinstalled|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|s_trk)$/i;

// The link the card prints and encodes: tracking stripped, http upgraded, fragments like #rd dropped.
export function shareUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  if (u.protocol === 'http:' && /(^|\.)weixin\.qq\.com$/.test(u.hostname)) u.protocol = 'https:';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = '';
  // URLSearchParams would percent-encode the == of WeChat's __biz; keep the link as people see it.
  return u.toString().replace(/%3D/gi, '=');
}

export const SUMMARY_CHARS = 150;
export const SHARE_COVER_WIDTH = 1080;
export const QUOTE_CHARS = 420;

// An inert document: nothing in the HTML runs or loads while it is read.
const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');
const text = (html: string): string => (parse(html).body.textContent ?? '').replace(/\s+/g, ' ').trim();

export function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  // End on a sentence when one finishes in the last third.
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('. '));
  return stop > max * 0.66 ? cut.slice(0, stop + 1) : `${cut.replace(/[，、；：,;:\s]+$/, '')}…`;
}

// The AI summary's opening paragraph reads best on a card; its bullet list does not.
export function leadOf(html: string | null | undefined): string {
  if (!html) return '';
  const first = [...parse(html).querySelectorAll('p')].map((p) => (p.textContent ?? '').trim()).find((t) => t.length >= 20);
  return first ?? text(html);
}

function firstImage(html: string | null): string | undefined {
  return html?.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
}

// Posts often open with their own title; on the card that reads as a stutter.
export function dropTitle(summary: string, title: string): string {
  const t = title.trim();
  return t && summary.startsWith(t) ? summary.slice(t.length).replace(/^[\s：:，,。.！!？?|｜—-]+/, '') : summary;
}

export function entryShare(d: EntryDetail, selection: string): ShareData {
  const translated = !!d.title_zh && d.title_zh !== d.title;
  const summary = dropTitle(leadOf(d.ai_summary) || text(d.content_full || d.content || ''), d.title);
  const cover = d.thumbnail || firstImage(d.content) || firstImage(d.content_full);
  return {
    title: translated ? d.title_zh! : d.title,
    titleOrig: translated ? d.title : undefined,
    source: d.feed_title,
    icon: `/icon/${d.feed_id}`,
    author: d.author ?? undefined,
    published: d.published,
    // Bilibili resets the connection for some full-size originals; its sized rendition loads.
    cover: cover ? proxiedCover(cover, SHARE_COVER_WIDTH) : undefined,
    summary: summary ? clip(summary, SUMMARY_CHARS) : undefined,
    quote: selection ? clip(selection.replace(/\s*\n\s*/g, '\n'), QUOTE_CHARS) : undefined,
    url: d.link ?? undefined,
  };
}
