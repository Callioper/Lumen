// The pictures a post carries (posters, programmes, speakers), told from its furniture by the rules
// the archive uses (clip/clean.ts, clip/images.ts): animated GIFs out by address; dividers, icons,
// "follow us" strips and flat cut-outs out by their bytes; a cover-shaped banner out by its shape; a
// lone picture closing the post (a QR code, a follow banner) out by place; a file met twice kept once.
// Of what is left, a poster or a programme is told by the text the OCR engine (ocr.ts) reads in it;
// without the engine, or before it has read them, by its shape. For 首页's preview.
import { createHash } from 'node:crypto';
import type { Settings } from '../config.ts';
import type { DB } from '../db.ts';
import { proxyImage, unwrapRelay } from '../api/media.ts';
import { isDecorativeImage } from '../clip/clean.ts';
import { imageSize, isDecoration } from '../clip/images.ts';
import { canOcr, ocrCached, ocrImages } from './ocr.ts';
import { academicNotices } from './notices.ts';
import { log } from '../log.ts';

const IMG = /<img\b[^>]*?\bsrc="([^"]+)"/g;
// Words after the last picture below which it closes the post.
const TAIL_TEXT = 30;
// Looked at, at most, to find the wanted number: a post of speaker portraits has dozens.
const MAX_LOOKED = 16;
const CACHED_POSTS = 200;
// What 首页 asks for (NoticePreview.tsx), so that it finds them ready.
const PICTURES_WARM = 8;
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
// Characters the OCR engine reads in a poster or a programme. Measured 10-26 on 61 pictures of ten
// notices' posts: posters and programmes 464–1115, a committee list 1194; QR codes, drawings,
// scenery, mastheads 0–1, an emblem 5, a school gate 21, banners and title pictures 35–47.
export const POSTER_TEXT = 100;
// Lying down, more: the cards a post ends on (「读书会核心权益」, 「来集智谷坐坐」) read 265–296 and a
// speaker's card 93–116; the programmes and calls set out lying down read 659–1018.
export const WIDE_POSTER_TEXT = 400;

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

// A picture left after the furniture: its shape (height / width) and how much text it reads as,
// null while not read.
export interface Found { url: string; shape: number; text: number | null }

// Read through: those reading as a poster, in the post's order, lying down too; none, the square
// ones (speakers; a QR code among them the page tells by its pixels). Not all read: by shape, the
// upright ones, else the square ones.
export function choosePictures(found: readonly Found[], limit: number): string[] {
  const squares = found.filter((f) => f.shape >= SQUARE && f.shape < UPRIGHT);
  const read = found.every((f) => f.text !== null);
  const poster = (f: Found): boolean => f.text! >= (f.shape < SQUARE ? WIDE_POSTER_TEXT : POSTER_TEXT);
  const posters = read ? found.filter(poster) : found.filter((f) => f.shape >= UPRIGHT);
  return (posters.length ? posters : squares).slice(0, limit).map((f) => f.url);
}

const charsOf = (lines: readonly string[]): number => lines.join('').replace(/\s/g, '').length;

// Posts whose pictures wait to be read, one at a time; one asked for on 首页 goes first.
const waiting: string[][] = [];
const queued = new Set<string>();
let reading = false;

function enqueue(urls: readonly string[], settings: Settings, first: boolean): void {
  const todo = urls.filter((u) => !queued.has(u));
  if (!todo.length) return;
  for (const u of todo) queued.add(u);
  if (first) waiting.unshift(todo); else waiting.push(todo);
  if (!reading) void readWaiting(settings);
}

async function readWaiting(settings: Settings): Promise<void> {
  reading = true;
  try {
    for (let urls = waiting.shift(); urls; urls = waiting.shift()) {
      try {
        await ocrImages(urls, settings);
      } catch (e) {
        log.warn(`[ocr] 首页配图：${(e as Error).message}`);
      } finally {
        for (const u of urls) queued.delete(u);
      }
    }
  } finally {
    reading = false;
  }
}

// The pictures to show, and whether some are still being read (asked again, the answer may change).
export async function postPictures(id: number, html: string, settings: Settings, limit: number, first = true): Promise<{ urls: string[]; reading: boolean }> {
  // The length too: a full text fetched after the entry is another post.
  const key = `${id}:${limit}:${html.length}`;
  const hit = cache.get(key);
  if (hit) return { urls: hit, reading: false };
  const urls = candidates(html).slice(0, MAX_LOOKED);
  // Fetched together (they land in the image cache the page then reads from), judged in order.
  const bodies = await Promise.all(urls.map((u) => bytesOf(u, settings)));
  const files = new Set<string>();
  const found: Found[] = [];
  urls.forEach((url, i) => {
    const body = bodies[i];
    const size = body && imageSize(body);
    if (!body || !size || isDecoration(body, size) || coverShaped(size.width, size.height)) return;
    const hash = createHash('sha1').update(body).digest('hex');
    if (files.has(hash)) return;
    files.add(hash);
    // Read, and kept, under the original's address (ocr.ts), the relay's changing.
    const lines = ocrCached(unwrapRelay(url));
    found.push({ url, shape: size.height / size.width, text: lines && charsOf(lines) });
  });
  const kept = choosePictures(found, limit);
  const unread = found.filter((f) => f.text === null).map((f) => unwrapRelay(f.url));
  const pending = unread.length > 0 && canOcr();
  if (pending) enqueue(unread, settings, first);
  // Only what will not change is kept: shown by shape, it is shown again once read.
  if (!unread.length) {
    if (cache.size >= CACHED_POSTS) cache.delete(cache.keys().next().value!);
    cache.set(key, kept);
  }
  return { urls: kept, reading: pending };
}

// The pictures of what 学术动态 still lists, read ahead of 首页 asking for them: after each round of
// reading posts (main.ts). About 430 pictures the first time (10-26), 1.6 s each.
export async function warmNoticePictures(db: DB, settings: Settings): Promise<void> {
  if (!canOcr()) return;
  const { items } = academicNotices(db, { kind: '', past: false });
  const ids = new Set(items.filter((v) => v.status === 'upcoming' || v.status === 'open').flatMap((v) => (v.own ? [v.own.id] : [])));
  const body = db.prepare('SELECT COALESCE(content_full, content) AS html FROM entry WHERE id = ?');
  for (const id of ids) {
    const html = (body.get(id) as { html: string | null } | undefined)?.html;
    if (html) await postPictures(id, html, settings, PICTURES_WARM, false);
  }
}
