// 少数派 articles through the site's own article API rather than its page. The page is a Nuxt app whose
// text Readability reads well enough, but a post made mostly of pictures (一图流) has under MIN_TEXT
// characters and came back as no article at all; the API gives the body as the editor wrote it, pictures
// and all (measured 2026-11-05: post 118404, 47 pictures from the API against fewer from the page).
import type { Settings } from '../config.ts';
import { httpGet, decodeBody } from '../fetch/http.ts';
import { sanitize } from './sanitize.ts';

const API = 'https://sspai.com/api/v1/article/info/get';

// The post id of a 少数派 article link (https://sspai.com/post/118404), else null. 「Prime」 stories
// (/prime/story/<slug>) have no numeric id and go on to the page as before.
export function sspaiPostId(link: string): string | null {
  try {
    const u = new URL(link);
    if (u.hostname !== 'sspai.com' && u.hostname !== 'www.sspai.com') return null;
    return /^\/post\/(\d+)\/?$/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

interface ApiReply { error?: number; msg?: string; data?: { body?: unknown } }

// The article body out of the API's reply, or null when it has none (an unknown id answers error 2007).
export function bodyOfReply(reply: unknown): string | null {
  const r = reply as ApiReply | null;
  if (!r || typeof r !== 'object' || r.error !== 0) return null;
  const body = r.data?.body;
  return typeof body === 'string' && body.trim() ? body : null;
}

// The sanitized body, or null when the API has nothing for this link (the page is tried then).
export async function sspaiFullText(link: string, settings: Settings): Promise<string | null> {
  const id = sspaiPostId(link);
  if (!id) return null;
  const res = await httpGet(`${API}?id=${id}&view=second`, settings, { headers: { accept: 'application/json' } });
  if (res.status >= 400) throw new Error(`少数派接口 HTTP ${res.status}`);
  let reply: unknown;
  try {
    reply = JSON.parse(decodeBody(res.body, res.headers.get('content-type')));
  } catch {
    throw new Error('少数派接口返回的不是 JSON');
  }
  const body = bodyOfReply(reply);
  return body ? sanitize(body, link) : null;
}
