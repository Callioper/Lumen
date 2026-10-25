// The text of a post that prints it in pictures: 人大复印报刊资料's 全文转载 posts set each journal's
// contents down as a picture and carry no text but a subscription table. An OCR engine
// (scripts/ocr_images.py runs it; the settings name its Python and folder) reads them, about 1.6 s a picture (22 in 22 s, tried 2026-10-24), and its
// boxes are laid back into lines here, column by column. What a picture read is kept by its URL in
// data/ocr, so a post read again (a new prompt) is not looked at again.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, type Settings } from '../config.ts';
import { proxyImage, unwrapRelay } from '../api/media.ts';
import { log } from '../log.ts';

// Off until the settings name both (main.ts hands them over).
let engine = { python: '', folder: '' };
export function useOcr(python: string, folder: string): void { engine = { python, folder }; }
const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'ocr_images.py');
const OCR_DIR = join(DATA_DIR, 'ocr');
const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const PER_IMAGE_MS = 15_000;
// A badge, a QR code, a divider: too small to carry a contents page.
const MIN_IMAGE_BYTES = 30_000;
const MIN_SCORE = 0.6;

export interface OcrBox { box: [number, number][]; score: number; text: string }
interface Placed { x0: number; x1: number; y0: number; y1: number; text: string }

const place = (b: OcrBox): Placed => {
  const xs = b.box.map((p) => p[0]);
  const ys = b.box.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), text: b.text.trim() };
};

// Where a page splits into columns: an upright band few boxes cross (a running head across the top
// may), at least MIN_GAP wide, with a fifth of the boxes or more on either side, so that the gap
// between a title and its authors is not taken for one. The widest such band, or none. 人大复印's
// contents pages leave 17–21 px between the contents and the imprint.
const MIN_GAP = 8;
const CROSSING = 0.04;
const SIDE = 0.2;
function columnGap(boxes: readonly Placed[]): number | null {
  const left = Math.floor(Math.min(...boxes.map((b) => b.x0)));
  const right = Math.ceil(Math.max(...boxes.map((b) => b.x1)));
  const cover = new Array<number>(right - left + 1).fill(0);
  for (const b of boxes) for (let x = Math.ceil(b.x0); x <= Math.floor(b.x1); x++) cover[x - left]++;
  const allowed = Math.max(1, Math.floor(boxes.length * CROSSING));
  let best: { at: number; gap: number } | null = null;
  for (let x = 0; x < cover.length;) {
    if (cover[x] > allowed) { x++; continue; }
    let end = x;
    while (end < cover.length && cover[end] <= allowed) end++;
    const at = left + (x + end) / 2;
    const leftSide = boxes.filter((b) => (b.x0 + b.x1) / 2 < at).length;
    const balanced = Math.min(leftSide, boxes.length - leftSide) >= boxes.length * SIDE;
    if (x > 0 && end < cover.length && end - x >= MIN_GAP && balanced && (!best || end - x > best.gap)) best = { at, gap: end - x };
    x = end;
  }
  return best?.at ?? null;
}

// One column's boxes into lines, top to bottom: boxes whose middles sit within half a character of
// each other make a line, left to right, a space where the gap between them is wider than a character.
function columnLines(boxes: readonly Placed[]): string[] {
  const rows: Placed[][] = [];
  for (const b of [...boxes].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const mid = (b.y0 + b.y1) / 2;
    const row = rows.at(-1);
    const h = b.y1 - b.y0;
    if (row && Math.abs(mid - row.reduce((n, r) => n + (r.y0 + r.y1) / 2, 0) / row.length) < h / 2) row.push(b);
    else rows.push([b]);
  }
  return rows.map((row) => {
    const xs = [...row].sort((a, b) => a.x0 - b.x0);
    return xs.reduce((s, b, i) => {
      if (!i) return b.text;
      const gap = b.x0 - xs[i - 1].x1;
      return s + (gap > (b.y1 - b.y0) ? ' ' : '') + b.text;
    }, '');
  }).filter(Boolean);
}

// A picture's boxes as lines of text: the left column through, then the right.
export function boxesToLines(raw: readonly OcrBox[]): string[] {
  const boxes = raw.filter((b) => b.score >= MIN_SCORE && b.text.trim()).map(place);
  if (!boxes.length) return [];
  const at = columnGap(boxes);
  if (at === null) return columnLines(boxes);
  // A box across the gap heads both columns.
  const across = (b: Placed): boolean => b.x0 < at && b.x1 > at;
  const rest = boxes.filter((b) => !across(b));
  const onLeft = (b: Placed): boolean => (b.x0 + b.x1) / 2 < at;
  return [...columnLines(boxes.filter(across)), ...columnLines(rest.filter(onLeft)), ...columnLines(rest.filter((b) => !onLeft(b)))];
}

// The pictures of a post, in order, as their originals (not wechat2rss's relay).
export function postImages(html: string): string[] {
  const urls = [...html.matchAll(/<img\b[^>]*?\b(?:data-src|src)="([^"]+)"/g)].map((m) => unwrapRelay(m[1].replace(/&amp;/g, '&')));
  return [...new Set(urls.filter((u) => /^https?:\/\//.test(u)))].slice(0, MAX_IMAGES);
}

const keyOf = (url: string): string => createHash('sha1').update(url).digest('hex').slice(0, 20);

const cached = (u: string): string => join(OCR_DIR, `${keyOf(u)}.json`);

// What a picture read before reads as, without reading it: null when it has not been.
export function ocrCached(url: string): string[] | null {
  try { return boxesToLines(JSON.parse(readFileSync(cached(url), 'utf8')) as OcrBox[]); } catch { return null; }
}

// One engine at a time: 学术动态's reading and 首页's pictures (pictures.ts) each start one, and each
// loads its model; together they would share the machine for nothing.
let lane: Promise<unknown> = Promise.resolve();

// The lines each picture reads as, in the post's order; a picture that could not be had reads as none.
// The pictures not read before are fetched and read at one go, the engine started once.
export function ocrImages(urls: readonly string[], settings: Settings): Promise<string[][]> {
  const run = lane.then(() => readImages(urls, settings));
  lane = run.catch(() => undefined);
  return run;
}

async function readImages(urls: readonly string[], settings: Settings): Promise<string[][]> {
  mkdirSync(OCR_DIR, { recursive: true });
  const todo = urls.filter((u) => !existsSync(cached(u)));
  if (todo.length) {
    const dir = join(OCR_DIR, `tmp-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const files = new Map<string, string>();
      for (const u of todo) {
        try {
          // Through the image proxy: it sends what each site wants to be asked with (豆瓣 answers a bare
          // request with 418, which, cached as no text, left posters unread), and the page has often
          // fetched the picture already.
          const res = await proxyImage(u, settings);
          const type = res.headers.get('content-type') ?? '';
          // Only a picture that is gone reads as none for good; a refusal or a bad moment is tried again.
          if (res.status === 404 || res.status === 410) { writeFileSync(cached(u), '[]'); continue; }
          if (!res.ok) { log.warn(`[ocr] 图片暂时取不到（HTTP ${res.status}），下次再试`); continue; }
          const body = Buffer.from(await res.arrayBuffer());
          if (!/^image\/(png|jpeg|webp|bmp)/.test(type) || body.length < MIN_IMAGE_BYTES || body.length > MAX_IMAGE_BYTES) {
            writeFileSync(cached(u), '[]');
            continue;
          }
          const file = join(dir, `${keyOf(u)}.${type.split('/')[1].split(';')[0]}`);
          writeFileSync(file, body);
          files.set(file, u);
        } catch (e) {
          log.warn(`[ocr] 图片取不到：${(e as Error).message}`);       // not cached: tried again next time
        }
      }
      if (files.size) {
        for (const r of await runOcr([...files.keys()])) {
          const u = files.get(r.path);
          if (u && r.boxes) writeFileSync(cached(u), JSON.stringify(r.boxes));
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return urls.map((u) => ocrCached(u) ?? []);
}

interface OcrResult { path: string; boxes?: OcrBox[]; error?: string }

function runOcr(paths: readonly string[]): Promise<OcrResult[]> {
  return new Promise((ok, fail) => {
    execFile(engine.python, [SCRIPT, ...paths], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 + PER_IMAGE_MS * paths.length, windowsHide: true,
      env: { ...process.env, LUMEN_OCR_ENGINE: engine.folder } },
      (err, stdout) => {
        const out = stdout.split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as OcrResult] : []; } catch { return []; } });
        if (err && !out.length) { fail(new Error(`OCR 没跑起来：${err.message.split('\n')[0]}`)); return; }
        for (const r of out) if (r.error) log.warn(`[ocr] 读不了一张图：${r.error}`);
        ok(out);
      });
  });
}

export const canOcr = (): boolean => !!engine.python && !!engine.folder && existsSync(engine.python) && existsSync(engine.folder) && existsSync(SCRIPT);
