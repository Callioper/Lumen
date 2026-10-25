// Decorative cut-outs in WeChat posts: a big question mark, a pair of quote marks, a pencil, a
// triangle, drawn in one or two flat colours on a transparent ground. Their size passes for a
// picture, so they are told by their pixels: much of the canvas see-through and the rest a few
// colours. Screenshots and photos are opaque; a diagram on a transparent ground keeps its many
// shades of anti-aliased text. Only 8-bit, non-interlaced PNGs are read; anything else is kept.
import { inflateSync } from 'node:zlib';

const MIN_CLEAR = 0.4;        // share of the canvas that is (nearly) fully transparent
const MAX_COLOURS = 100;      // distinct colours, 5 bits a channel, among the visible pixels
const SAMPLE_STEP = 7;        // every seventh pixel is plenty to count colours
const CLEAR_ALPHA = 16;
const MAX_PIXELS = 40_000_000;

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface Png { width: number; height: number; type: number; data: Buffer; palette?: Buffer; trns?: Buffer }

function readPng(b: Buffer): Png | null {
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20), depth = b[24], type = b[25], interlace = b[28];
  if (depth !== 8 || interlace !== 0 || !(type in CHANNELS) || width * height > MAX_PIXELS) return null;
  const idat: Buffer[] = [];
  let palette: Buffer | undefined, trns: Buffer | undefined;
  for (let i = 8; i + 8 <= b.length;) {
    const len = b.readUInt32BE(i), kind = b.toString('ascii', i + 4, i + 8), body = b.subarray(i + 8, i + 8 + len);
    if (kind === 'IDAT') idat.push(body);
    else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IEND') break;
    i += 12 + len;
  }
  // A crafted file can inflate far past its pixels; stop at the size the header promises.
  const expected = height * (width * CHANNELS[type] + 1);
  try { return { width, height, type, data: inflateSync(Buffer.concat(idat), { maxOutputLength: expected }), palette, trns }; } catch { return null; }
}

// The filtered scanlines back to raw bytes (PNG spec, section 9).
function unfilter(p: Png): Buffer | null {
  const bpp = CHANNELS[p.type], stride = p.width * bpp;
  if (p.data.length < p.height * (stride + 1)) return null;
  const out = Buffer.alloc(p.height * stride);
  for (let y = 0; y < p.height; y++) {
    const f = p.data[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0, up = y ? out[prev + x] : 0, c = x >= bpp && y ? out[prev + x - bpp] : 0;
      const v = p.data[src + x];
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (a + up) >> 1;
      else if (f === 4) { const s = a + up - c, pa = Math.abs(s - a), pb = Math.abs(s - up), pc = Math.abs(s - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      out[row + x] = (v + pred) & 0xff;
    }
  }
  return out;
}

// RGBA of pixel i.
function pixel(p: Png, raw: Buffer, i: number): [number, number, number, number] {
  switch (p.type) {
    case 6: return [raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3]];
    case 4: return [raw[i * 2], raw[i * 2], raw[i * 2], raw[i * 2 + 1]];
    case 3: { const k = raw[i]; const pal = p.palette!; return [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], p.trns && k < p.trns.length ? p.trns[k] : 255]; }
    case 2: return [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2], 255];
    default: return [raw[i], raw[i], raw[i], 255];
  }
}

export function isFlatCutout(b: Buffer): boolean {
  const p = readPng(b);
  // Without an alpha channel nothing can be see-through (a tRNS colour key is too rare to bother with).
  if (!p || (p.type !== 6 && p.type !== 4 && !(p.type === 3 && p.trns && p.palette))) return false;
  const raw = unfilter(p);
  if (!raw) return false;
  const n = p.width * p.height;
  let clear = 0;
  const colours = new Set<number>();
  for (let i = 0; i < n; i++) {
    const [r, g, bl, a] = pixel(p, raw, i);
    if (a < CLEAR_ALPHA) { clear++; continue; }
    if (i % SAMPLE_STEP === 0) colours.add(((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3));
  }
  return clear / n >= MIN_CLEAR && colours.size <= MAX_COLOURS;
}
