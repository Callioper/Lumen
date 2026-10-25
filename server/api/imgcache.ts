// Covers kept on disk so a list opens without waiting on slow CDNs again. The browser has its
// own cache, but it is per profile and evicted early; this one survives and can be warmed
// right after a fetch, before anyone opens the list.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';

export const IMG_CACHE_DIR = join(DATA_DIR, 'img-cache');
// Covers and, since 10-23, the images of unread articles (about 100 MB a day): two weeks or so.
export const IMG_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const IMG_CACHE_MAX_ENTRY = 8 * 1024 * 1024;   // an article's GIFs run to a few MB
const PRUNE_EVERY_WRITES = 200;
const TOUCH_AFTER_MS = 86_400_000;   // refresh the age of entries still in use at most daily

export interface CachedImage { body: Buffer; type: string }

export class ImageCache {
  private writes = 0;
  private dir: string;
  private maxBytes: number;

  constructor(dir = IMG_CACHE_DIR, maxBytes = IMG_CACHE_MAX_BYTES) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  private path(url: string): string {
    const h = createHash('sha1').update(url).digest('hex');
    return join(this.dir, h.slice(0, 2), h);
  }

  get(url: string): CachedImage | null {
    const p = this.path(url);
    try {
      const st = statSync(p);
      const type = readFileSync(p + '.type', 'utf8');
      const body = readFileSync(p);
      // Pruning drops the least recently used, so a hit counts as a use.
      if (Date.now() - st.mtimeMs > TOUCH_AFTER_MS) { const now = new Date(); utimesSync(p, now, now); }
      return { body, type };
    } catch {
      return null;
    }
  }

  has(url: string): boolean {
    return existsSync(this.path(url));
  }

  put(url: string, body: Buffer, type: string): void {
    if (body.length === 0 || body.length > IMG_CACHE_MAX_ENTRY) return;
    const p = this.path(url);
    mkdirSync(join(p, '..'), { recursive: true });
    // Type first: a body without its type is never read back, the reverse would be.
    writeFileSync(p + '.type', type);
    writeFileSync(p, body);
    if (++this.writes % PRUNE_EVERY_WRITES === 0) this.prune();
  }

  // Deletes the oldest images until the cache is under its cap; returns how many went.
  prune(): number {
    if (!existsSync(this.dir)) return 0;
    const files: { p: string; size: number; mtime: number }[] = [];
    for (const sub of readdirSync(this.dir)) {
      const d = join(this.dir, sub);
      for (const name of readdirSync(d)) {
        if (name.endsWith('.type')) continue;
        const p = join(d, name);
        const st = statSync(p);
        files.push({ p, size: st.size, mtime: st.mtimeMs });
      }
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total <= this.maxBytes) return 0;
    files.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const f of files) {
      if (total <= this.maxBytes * 0.9) break;
      rmSync(f.p, { force: true });
      rmSync(f.p + '.type', { force: true });
      total -= f.size;
      removed++;
    }
    return removed;
  }
}
