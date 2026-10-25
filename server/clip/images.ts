// Save an archived article's images into the vault so the note no longer depends on the
// wechat2rss tunnel or on WeChat's hotlink rules, and drop the ones that are page furniture.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Settings } from '../config.ts';
import { httpGet } from '../fetch/http.ts';
import { refererFor } from '../api/media.ts';
import { log } from '../log.ts';
import { isFlatCutout } from './flatpng.ts';

const MAX_IMAGES = 60;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
// Dividers, icons, avatars and "follow us" strips: tiny, or a thin band across the page.
const MIN_SIDE = 120;
const MIN_AREA = 200 * 200;
const MAX_ASPECT = 5;
// An ornament drawn flat on a plain ground (a dashed arc, a bracket) squeezes to almost nothing: a
// 218×233 arc measured 1 KB (10-26). A screenshot or poster of that size runs to tens of KB.
const ORNAMENT_SIDE = 480;
const ORNAMENT_BYTES_PER_PIXEL = 0.06;

export interface ImageSize { width: number; height: number; ext: 'png' | 'jpg' | 'gif' | 'webp' }

// Width and height from the file header; null when the format is unknown or truncated.
export function imageSize(b: Buffer): ImageSize | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), ext: 'png' };
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), ext: 'gif' };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), ext: 'webp' };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, ext: 'webp' };
    }
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, ext: 'webp' };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      // SOF0–SOF15 carry the frame size; C4/C8/CC are other tables with the same prefix.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), ext: 'jpg' };
      }
      i += 2 + len;
    }
  }
  return null;
}

export function isFurniture(s: ImageSize): boolean {
  const { width: w, height: h } = s;
  return Math.min(w, h) < MIN_SIDE || w * h < MIN_AREA || w / h > MAX_ASPECT || h / w > MAX_ASPECT;
}

// Page furniture by size, or a flat cut-out by its pixels; shared with 首页's preview (content/pictures.ts).
export function isDecoration(body: Buffer, size: ImageSize): boolean {
  if (isFurniture(size)) return true;
  if (size.ext !== 'png') return false;
  const { width: w, height: h } = size;
  const ornament = Math.max(w, h) < ORNAMENT_SIDE && body.length < w * h * ORNAMENT_BYTES_PER_PIXEL;
  return ornament || isFlatCutout(body);
}

export interface LocalizeOptions {
  vaultPath: string;
  folder: string;       // vault-relative, e.g. WebClips/图片/2026-10
  baseName: string;     // file name stem shared by this note's images
  settings: Settings;
}

export interface LocalizeResult { markdown: string; saved: number; dropped: number; failed: number }

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;

async function download(url: string, settings: Settings): Promise<Buffer> {
  const u = new URL(url);
  const ref = refererFor(u);
  const res = await httpGet(url, settings, {
    headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...(ref ? { referer: ref } : {}) },
    maxBytes: MAX_IMAGE_BYTES, timeoutMs: IMAGE_TIMEOUT_MS, publicOnly: true,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return res.body;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

type Outcome = { kind: 'saved'; embed: string } | { kind: 'dropped' } | { kind: 'failed' };
type Fetched = { kind: 'image'; body: Buffer; ext: ImageSize['ext'] } | { kind: 'dropped' } | { kind: 'failed' };

export async function localizeImages(markdown: string, opts: LocalizeOptions): Promise<LocalizeResult> {
  const urls = [...new Set([...markdown.matchAll(IMAGE)].map((m) => m[2]).filter((u) => /^https?:\/\//.test(u)))].slice(0, MAX_IMAGES);
  const fetched = await mapLimit(urls, CONCURRENCY, async (url): Promise<Fetched> => {
    try {
      const body = await download(url, opts.settings);
      const size = imageSize(body);
      if (!size) return { kind: 'failed' };
      if (isDecoration(body, size)) return { kind: 'dropped' };
      return { kind: 'image', body, ext: size.ext };
    } catch (e) {
      log.warn(`[clip] image ${url.slice(0, 80)} not saved: ${(e as Error).message}`);
      return { kind: 'failed' };
    }
  });
  // The same picture under two addresses (a repeated divider, the cover again at the end) is kept once.
  const seen = new Set<string>();
  const outcomes = fetched.map((f, i): Outcome => {
    if (f.kind !== 'image') return f;
    const hash = createHash('sha1').update(f.body).digest('hex');
    if (seen.has(hash)) return { kind: 'dropped' };
    seen.add(hash);
    const rel = `${opts.folder}/${opts.baseName}-${String(i + 1).padStart(2, '0')}.${f.ext}`;
    const abs = join(opts.vaultPath, rel);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      if (!existsSync(abs)) writeFileSync(abs, f.body);
    } catch (e) {
      log.warn(`[clip] image ${rel} not written: ${(e as Error).message}`);
      return { kind: 'failed' };
    }
    return { kind: 'saved', embed: `![[${rel}]]` };
  });
  const byUrl = new Map(urls.map((u, i) => [u, outcomes[i]]));
  const md = markdown.replace(IMAGE, (m, _alt: string, url: string) => {
    const o = byUrl.get(url);
    if (!o || o.kind === 'failed') return m;          // keep the remote link rather than lose the picture
    return o.kind === 'saved' ? o.embed : '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  const count = (k: Outcome['kind']): number => outcomes.filter((o) => o.kind === k).length;
  return { markdown: md, saved: count('saved'), dropped: count('dropped'), failed: count('failed') };
}
