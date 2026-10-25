// The pictures a post carries (posters, programmes, speakers), told from its furniture by the rules
// the archive uses (clip/clean.ts, clip/images.ts): animated GIFs out by address; dividers, icons,
// "follow us" strips and flat cut-outs out by their bytes; a cover-shaped banner out by its shape; a
// lone picture closing the post (a QR code, a follow banner) out by place; a file met twice kept once.
// For 首页's preview.
import { createHash } from 'node:crypto';
import type { Settings } from '../config.ts';
import { proxyImage, unwrapRelay } from '../api/media.ts';
import { isDecorativeImage } from '../clip/clean.ts';
import { imageSize, isDecoration } from '../clip/images.ts';

const IMG = /<img\b[^>]*?\bsrc="([^"]+)"/g;
// Words after the last picture below which it closes the post.
const TAIL_TEXT = 30;
// Looked at, at most, to find the wanted number: a post of speaker portraits has dozens.
const MAX_LOOKED = 16;
const CACHED_POSTS = 200;
// WeChat's cover shape, 2.35 : 1. In the body it is the cover again (re-cut, so no hash matches it) or
// a masthead: a school gate, a logo, 「征文启事」 (57 of 275 pictures measured 10-26). The preview shows
// the cover above the pictures already.
const COVER_SHAPE = [2.2, 2.5] as const;
const coverShaped = (w: number, h: number): boolean => w / h >= COVER_SHAPE[0] && w / h <= COVER_SHAPE[1];
// Posters and programmes stand upright. Of 242 pictures left in 学术动态 posts (10-26), the 132 lying
// down or square were campuses, gates, scenery, past events and QR codes, with speakers and a
// landscape poster or two among them. Lying down, nothing worth the room was left once the uprights
// were shown; a square one is mostly a speaker, shown for a post with no upright picture.
const UPRIGHT = 1.1;
const SQUARE = 0.85;

const cache = new Map<string, string[]>();

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '');

// The candidates in order, by address alone: web links, no GIFs, each picture once, not the closer.
export function candidates(html: string): string[] {
  const found = [...html.matchAll(IMG)];
  const last = found.at(-1);
  // Closing on a QR code or a follow banner is a WeChat habit; a 豆瓣 or 微博 status is often one
  // photo with a line under it, and that photo is the poster.
  const closes = !!last && found.length > 1 && /mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|qpic\.cn%2F/.test(last[1])
    && textOf(html.slice(last.index + last[0].length)).length < TAIL_TEXT;
  const closer = closes ? last.index : -1;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of found) {
    const url = m[1].replace(/&amp;/g, '&');
    const key = unwrapRelay(url);
    if (m.index === closer || !/^https?:\/\//.test(url) || isDecorativeImage(url) || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

async function bytesOf(url: string, settings: Settings): Promise<Buffer | null> {
  try {
    const res = await proxyImage(url, settings);
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function postPictures(id: number, html: string, settings: Settings, limit: number): Promise<string[]> {
  const key = `${id}:${limit}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const urls = candidates(html).slice(0, MAX_LOOKED);
  // Fetched together (they land in the image cache the page then reads from), judged in order.
  const bodies = await Promise.all(urls.map((u) => bytesOf(u, settings)));
  const files = new Set<string>();
  const found: { url: string; shape: number }[] = [];
  urls.forEach((url, i) => {
    const body = bodies[i];
    const size = body && imageSize(body);
    if (!body || !size || isDecoration(body, size) || coverShaped(size.width, size.height)) return;
    const hash = createHash('sha1').update(body).digest('hex');
    if (files.has(hash)) return;
    files.add(hash);
    found.push({ url, shape: size.height / size.width });
  });
  const posters = found.filter((f) => f.shape >= UPRIGHT);
  const squares = found.filter((f) => f.shape >= SQUARE && f.shape < UPRIGHT);
  const kept = (posters.length ? posters : squares).slice(0, limit).map((f) => f.url);
  if (cache.size >= CACHED_POSTS) cache.delete(cache.keys().next().value!);
  cache.set(key, kept);
  return kept;
}
